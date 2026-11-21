import type { AttentionFix, AttentionGroupDTO, AttentionGroupKey, AttentionItemDTO, CompletenessItem, StudentAttentionDTO } from '@shared';
import { CURRENT_STUDENT_STATUSES, TC_STATUS_LABELS } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User, type UserDoc } from '../../platform/users/user.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { Person, type PersonDoc } from '../staff/person.model';
import { todayFor } from '../staff/status';
import { fullNameOf, hydrateStudents, type StudentHydration } from './directory';
import { documentCompleteness } from './document.service';
import { toDirectoryDTO } from './mappers';
import { stateOf } from './portal.service';
import { getReadiness } from './promotion.service';
import { StudentDocument, StudentTransferCertificate, type StudentTransferCertificateDoc } from './records.models';
import { isOpenOn, nameKey } from './rules';
import { completenessOf } from './student.service';
import { Student, StudentAdmission, StudentEnrollment, StudentGuardianLink, type StudentDoc, type StudentGuardianLinkDoc } from './student.models';

/**
 * Needs Attention (SPM-33, SPM-36): what an office still has to finish, grouped by what kind of work it is. Part 4 adds parent
 * access, transfers, exit, data quality, and two follow-up groups (documents, promotion review) that are listed but not counted
 * in the badge, so the badge stays about what blocks a student today.
 */

const FIX_FOR: Record<CompletenessItem, AttentionFix> = {
  ADMISSION: 'ADD_ADMISSION',
  ENROLLMENT: 'ADD_CLASS',
  SECTION: 'ADD_SECTION',
  GUARDIAN: 'ADD_GUARDIAN',
  PRIMARY_GUARDIAN: 'CHOOSE_PRIMARY',
  SUBJECT_CHOICE: 'CHOOSE_SUBJECTS',
};

const GROUP_FOR: Record<CompletenessItem, 'SETUP' | 'FAMILY' | 'SUBJECTS'> = {
  ADMISSION: 'SETUP',
  ENROLLMENT: 'SETUP',
  SECTION: 'SETUP',
  GUARDIAN: 'FAMILY',
  PRIMARY_GUARDIAN: 'FAMILY',
  SUBJECT_CHOICE: 'SUBJECTS',
};

const GROUPS: { key: AttentionGroupKey; title: string; followUp: boolean }[] = [
  { key: 'SETUP', title: 'Student setup', followUp: false },
  { key: 'FAMILY', title: 'Family', followUp: false },
  { key: 'SUBJECTS', title: 'Subjects', followUp: false },
  { key: 'PARENT_ACCESS', title: 'Parent access', followUp: false },
  { key: 'TRANSFERS', title: 'Transfers', followUp: false },
  { key: 'EXIT', title: 'Leaving school', followUp: false },
  { key: 'DATA_QUALITY', title: 'Possible duplicates', followUp: false },
  { key: 'DOCUMENTS', title: 'Missing documents', followUp: true },
  { key: 'PROMOTION', title: 'Promotion to next year', followUp: true },
];

/** Transfer Certificates still on their way (not issued, not cancelled). */
const OPEN_TC = ['REQUESTED', 'UNDER_REVIEW', 'PENDING_CLEARANCE', 'APPROVED'] as const;

/** Runs `fn` over `items` a few at a time, so a big school doesn't open hundreds of queries at once. */
async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

const byName = (a: AttentionItemDTO, b: AttentionItemDTO) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' });

function studentItem(student: StudentDoc, h: StudentHydration, problem: string, message: string, fix: AttentionFix): AttentionItemDTO {
  const dto = toDirectoryDTO(student, h);
  return { key: `${student._id}:${problem}`, studentId: student._id, personId: null, fullName: dto.fullName, admissionNumber: dto.admissionNumber, classSection: dto.classSection, message, fix };
}

// ───────────────────────────────────────────────────────────── data quality

async function duplicateParents(ctx: ServiceContext, today: string): Promise<AttentionItemDTO[]> {
  const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] })
    .select('guardianPersonId')
    .lean<Pick<StudentGuardianLinkDoc, 'guardianPersonId'>[]>();
  const ids = [...new Set(links.map((l) => l.guardianPersonId))];
  if (ids.length < 2) return [];
  const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).lean<PersonDoc[]>();
  const byPhone = new Map<string, PersonDoc[]>();
  for (const p of people) if (p.primaryPhone) byPhone.set(p.primaryPhone, [...(byPhone.get(p.primaryPhone) ?? []), p]);
  const items: AttentionItemDTO[] = [];
  for (const group of byPhone.values()) {
    if (group.length < 2) continue;
    for (const p of group) {
      const others = group.filter((o) => o._id !== p._id).map((o) => fullNameOf(o));
      items.push({
        key: `parent:${p._id}`,
        studentId: null,
        personId: p._id,
        fullName: fullNameOf(p),
        admissionNumber: null,
        classSection: null,
        message: `Has the same phone number as ${others.join(', ')}. They may be the same parent.`,
        fix: 'OPEN_FAMILY',
      });
    }
  }
  return items.sort(byName);
}

/** Two students in scope with the same name and the same date of birth may be one child entered twice. */
function duplicateStudents(students: StudentDoc[], h: StudentHydration): AttentionItemDTO[] {
  const groups = new Map<string, StudentDoc[]>();
  for (const s of students) {
    const p = h.people.get(s.personId);
    if (!p?.dateOfBirth) continue;
    const key = `${nameKey(p.legalFirstName, p.legalMiddleName, p.legalLastName)}|${p.dateOfBirth}`;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const items: AttentionItemDTO[] = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const s of group) {
      const others = group.filter((o) => o._id !== s._id).map((o) => toDirectoryDTO(o, h).admissionNumber ?? 'a draft');
      items.push(studentItem(s, h, 'duplicate', `Same name and date of birth as ${others.join(', ')}. Check they are not the same child.`, 'OPEN_STUDENT'));
    }
  }
  return items.sort(byName);
}

// ───────────────────────────────────────────────────────────── parent access

interface PortalFacts {
  items: AttentionItemDTO[];
  /** Active students with at least one parent who signed in. */
  withActiveLogin: number;
}

async function parentAccess(ctx: ServiceContext, students: StudentDoc[], h: StudentHydration, today: string): Promise<PortalFacts> {
  const ids = students.map((s) => s._id);
  const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, studentId: { $in: ids }, cancelledAt: null, $or: [{ portalEnabled: true }, { portalRevokedAt: { $ne: null } }] }).lean<StudentGuardianLinkDoc[]>();
  const live = links.filter((l) => isOpenOn(l, today));
  const personIds = [...new Set(live.map((l) => l.guardianPersonId))];
  const [users, people] = await Promise.all([
    User.find({ tenantId: ctx.tenantId, personId: { $in: personIds }, role: 'PARENT' }).select('personId status').lean<Pick<UserDoc, 'personId' | 'status'>[]>(),
    Person.find({ tenantId: ctx.tenantId, _id: { $in: personIds } }).lean<PersonDoc[]>(),
  ]);
  const userOf = new Map(users.map((u) => [u.personId!, u]));
  const nameOf = new Map(people.map((p) => [p._id, fullNameOf(p)]));
  const linksOf = new Map<string, StudentGuardianLinkDoc[]>();
  for (const l of live) linksOf.set(l.studentId, [...(linksOf.get(l.studentId) ?? []), l]);

  const items: AttentionItemDTO[] = [];
  let withActiveLogin = 0;
  for (const s of students) {
    const states = (linksOf.get(s._id) ?? []).map((l) => ({ link: l, state: stateOf(l, userOf.get(l.guardianPersonId) ?? null) }));
    if (states.some((x) => x.state === 'ACTIVE')) {
      if (s.status === 'ACTIVE') withActiveLogin += 1;
      continue;
    }
    if (s.status !== 'ACTIVE') continue;
    const invited = states.find((x) => x.state === 'INVITED');
    const revoked = states.find((x) => x.state === 'REVOKED');
    if (invited) items.push(studentItem(s, h, 'portal-invited', `${nameOf.get(invited.link.guardianPersonId) ?? 'The parent'} was invited but has not signed in yet. You can send the invitation again.`, 'INVITE_PARENT'));
    else if (revoked) items.push(studentItem(s, h, 'portal-revoked', `Access was removed for ${nameOf.get(revoked.link.guardianPersonId) ?? 'the parent'}. No parent can sign in for this child now.`, 'INVITE_PARENT'));
  }
  return { items: items.sort(byName), withActiveLogin };
}

// ───────────────────────────────────────────────────────────── exit

async function exitItems(ctx: ServiceContext, students: StudentDoc[], h: StudentHydration, today: string, scope: { sessionId: string | null; locationId?: string }): Promise<AttentionItemDTO[]> {
  const items: AttentionItemDTO[] = [];
  for (const s of students) {
    if (s.status !== 'WITHDRAWAL_INITIATED' || !s.withdrawal) continue;
    if (s.withdrawal.leavingDate <= today) items.push(studentItem(s, h, 'withdrawal-due', `The leaving date (${s.withdrawal.leavingDate}) has come. Finish the exit to close the class and section.`, 'FINISH_EXIT'));
  }
  // Certificates on their way, also for students who already left (they are not in the current list).
  const open = await StudentTransferCertificate.find({ tenantId: ctx.tenantId, status: { $in: [...OPEN_TC] } }).lean<StudentTransferCertificateDoc[]>();
  if (open.length === 0) return items.sort(byName);
  const enrollments = await StudentEnrollment.find({ tenantId: ctx.tenantId, _id: { $in: open.map((c) => c.enrollmentId).filter((id): id is string => Boolean(id)) } })
    .select('academicSessionId locationId')
    .lean<{ _id: string; academicSessionId: string; locationId: string }[]>();
  const enrollmentOf = new Map(enrollments.map((e) => [e._id, e]));
  const inScope = open.filter((c) => {
    const e = c.enrollmentId ? enrollmentOf.get(c.enrollmentId) : undefined;
    if (!e) return !scope.locationId;
    return (!scope.sessionId || e.academicSessionId === scope.sessionId) && (!scope.locationId || e.locationId === scope.locationId);
  });
  const known = new Map(students.map((s) => [s._id, s]));
  const missing = inScope.map((c) => c.studentId).filter((id) => !known.has(id));
  let hh = h;
  if (missing.length) {
    const left = await Student.find({ tenantId: ctx.tenantId, _id: { $in: missing } }).lean<StudentDoc[]>();
    for (const s of left) known.set(s._id, s);
    hh = await hydrateStudents(ctx, left, { today, academicSessionId: scope.sessionId });
  }
  for (const c of inScope) {
    const s = known.get(c.studentId);
    if (!s) continue;
    const owner = h.people.has(s.personId) ? h : hh;
    const message =
      c.status === 'PENDING_CLEARANCE'
        ? 'Transfer certificate is waiting for dues to be cleared.'
        : c.status === 'APPROVED'
          ? 'Transfer certificate is approved. Issue it to finish.'
          : `Transfer certificate is ${TC_STATUS_LABELS[c.status].toLowerCase()}. Approve it when the dues are cleared.`;
    items.push(studentItem(s, owner, `tc:${c._id}`, message, 'FINISH_EXIT'));
  }
  return items.sort(byName);
}

// ───────────────────────────────────────────────────────────── documents and promotion (follow-up)

async function documentItems(ctx: ServiceContext, students: StudentDoc[], h: StudentHydration): Promise<AttentionItemDTO[]> {
  const admitted = students.filter((s) => s.status === 'ACTIVE' || s.status === 'ADMISSION_PENDING' || s.status === 'INACTIVE');
  if (admitted.length === 0) return [];
  const ids = admitted.map((s) => s._id);
  const [docs, admissions] = await Promise.all([
    StudentDocument.find({ tenantId: ctx.tenantId, studentId: { $in: ids }, status: 'ACTIVE' }).select('studentId documentType generatedForCertificateId').lean<{ studentId: string; documentType: string; generatedForCertificateId: string | null }[]>(),
    StudentAdmission.find({ tenantId: ctx.tenantId, studentId: { $in: ids }, isCurrent: true }).select('studentId previousSchool').lean<{ studentId: string; previousSchool: { name: string } | null }[]>(),
  ]);
  const docsOf = new Map<string, typeof docs>();
  for (const d of docs) docsOf.set(d.studentId, [...(docsOf.get(d.studentId) ?? []), d]);
  const fromOtherSchool = new Set(admissions.filter((a) => a.previousSchool).map((a) => a.studentId));
  const items: AttentionItemDTO[] = [];
  for (const s of admitted) {
    const c = documentCompleteness(fromOtherSchool.has(s._id), (docsOf.get(s._id) ?? []) as Parameters<typeof documentCompleteness>[1]);
    if (c.missing.length > 0) items.push(studentItem(s, h, 'documents', c.message, 'UPLOAD_DOCUMENT'));
  }
  return items.sort(byName);
}

/** The next year that promotion can go to: the first PUBLISHED or ACTIVE session that starts after this one ends. */
async function nextSessionOf(ctx: ServiceContext, session: Pick<AcademicSessionDoc, '_id' | 'endDate'>) {
  return AcademicSession.findOne({ tenantId: ctx.tenantId, startDate: { $gt: session.endDate }, status: { $in: ['PUBLISHED', 'ACTIVE'] } })
    .sort({ startDate: 1 })
    .lean<Pick<AcademicSessionDoc, '_id' | 'locations'>>();
}

async function promotionItems(ctx: ServiceContext, session: AcademicSessionDoc | null, locationId: string | undefined): Promise<AttentionItemDTO[]> {
  if (!session) return [];
  const next = await nextSessionOf(ctx, session);
  if (!next) return [];
  const locations = locationId ? [locationId] : session.locations.map((l) => l.locationId);
  const items: AttentionItemDTO[] = [];
  for (const loc of locations) {
    // A campus that is not part of next year (or any other reason the check can't run) just adds nothing here.
    const readiness = await getReadiness(ctx, { fromSessionId: session._id, toSessionId: next._id, locationId: loc }).catch(() => null);
    if (!readiness) continue;
    for (const row of readiness.reviewRows) {
      const reasons = row.reasons.filter((r) => r.code !== 'ALREADY_PROMOTED');
      if (reasons.length === 0) continue;
      items.push({
        key: `${row.studentId}:promotion`,
        studentId: row.studentId,
        personId: null,
        fullName: row.fullName,
        admissionNumber: row.admissionNumber,
        classSection: null,
        message: `${row.fromClass}${row.fromSection ? `-${row.fromSection}` : ''}: ${reasons.map((r) => r.message).join(' ')}`,
        fix: 'REVIEW_PROMOTION',
      });
    }
  }
  return items.sort(byName);
}

// ───────────────────────────────────────────────────────────── the page

export async function getAttention(ctx: ServiceContext, query: { academicSessionId?: string; locationId?: string }): Promise<StudentAttentionDTO> {
  const tenantId = ctx.tenantId;
  const today = await todayFor(ctx);
  const session = query.academicSessionId
    ? await AcademicSession.findOne({ _id: query.academicSessionId, tenantId }).lean<AcademicSessionDoc>()
    : await AcademicSession.findOne({ tenantId, status: 'ACTIVE' }).lean<AcademicSessionDoc>();

  const [students, enrolledStudentIds] = await Promise.all([
    Student.find({ tenantId, status: { $in: [...CURRENT_STUDENT_STATUSES] } }).lean<StudentDoc[]>(),
    StudentEnrollment.distinct('studentId', { tenantId, state: { $ne: 'CANCELLED' } }) as Promise<string[]>,
  ]);
  const everEnrolled = new Set(enrolledStudentIds);
  const h = await hydrateStudents(ctx, students, { today, academicSessionId: session?._id ?? null });

  // Students of this session (and location), plus drafts that were never placed anywhere (unless a location is chosen).
  const inScope = students.filter((s) => {
    const enrollment = h.placements.get(s._id)?.enrollment ?? null;
    if (enrollment) return !query.locationId || enrollment.locationId === query.locationId;
    return !query.locationId && !everEnrolled.has(s._id);
  });

  const [newThisYear, withdrawnThisYear] = session
    ? await Promise.all([
        StudentAdmission.countDocuments({ tenantId, isCurrent: true, mode: { $ne: 'MIGRATION' }, admissionDate: { $gte: session.startDate }, studentId: { $in: inScope.map((s) => s._id) } }),
        StudentEnrollment.distinct('studentId', { tenantId, academicSessionId: session._id, state: 'WITHDRAWN', ...(query.locationId ? { locationId: query.locationId } : {}) }).then((ids) => ids.length),
      ])
    : [0, 0];

  const problems = await inBatches(inScope, 20, async (s) => ({ student: s, missing: await completenessOf(ctx, s, h) }));

  const buckets: Record<AttentionGroupKey, AttentionItemDTO[]> = { SETUP: [], FAMILY: [], SUBJECTS: [], PARENT_ACCESS: [], TRANSFERS: [], EXIT: [], DATA_QUALITY: [], DOCUMENTS: [], PROMOTION: [] };
  for (const { student, missing } of problems) {
    const movedCampus = h.placements.get(student._id)?.enrollment?.enrollmentType === 'MID_SESSION_TRANSFER';
    for (const m of missing) {
      // A move to a campus on another board leaves the subjects to choose again: that belongs with the transfer.
      if (m.item === 'SUBJECT_CHOICE' && movedCampus) buckets.TRANSFERS.push(studentItem(student, h, m.item, `Moved campus. ${m.message}`, 'CHOOSE_SUBJECTS'));
      else buckets[GROUP_FOR[m.item]].push(studentItem(student, h, m.item, m.message, FIX_FOR[m.item]));
    }
  }
  const scope = { sessionId: session?._id ?? null, locationId: query.locationId };
  const [portal, exit, parents, documents, promotion] = await Promise.all([
    parentAccess(ctx, inScope, h, today),
    exitItems(ctx, inScope, h, today, scope),
    duplicateParents(ctx, today),
    documentItems(ctx, inScope, h),
    promotionItems(ctx, session, query.locationId),
  ]);
  buckets.PARENT_ACCESS = portal.items;
  buckets.EXIT = exit;
  buckets.DATA_QUALITY = [...duplicateStudents(inScope, h), ...parents];
  buckets.DOCUMENTS = documents;
  buckets.PROMOTION = promotion;

  const groups: AttentionGroupDTO[] = GROUPS.map((g) => ({ ...g, items: g.key === 'SETUP' || g.key === 'FAMILY' || g.key === 'SUBJECTS' || g.key === 'TRANSFERS' ? buckets[g.key].sort(byName) : buckets[g.key] }));

  // The badge counts each student (or parent record) once, however many problems they have.
  const flagged = new Set<string>();
  let followUp = 0;
  for (const g of groups) {
    if (g.followUp) followUp += g.items.length;
    else for (const item of g.items) flagged.add(item.studentId ?? `parent:${item.personId}`);
  }
  const active = inScope.filter((s) => s.status === 'ACTIVE').length;
  const withdrawing = inScope.filter((s) => s.status === 'WITHDRAWAL_INITIATED').length;

  return {
    counts: {
      activeStudents: active,
      newThisYear,
      needsAttention: flagged.size,
      followUp,
      portalActivationPercent: active === 0 ? null : Math.round((portal.withActiveLogin / active) * 100),
      withdrawalsThisYear: withdrawnThisYear + withdrawing,
    },
    groups,
  };
}
