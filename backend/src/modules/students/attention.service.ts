import type { AttentionFix, AttentionGroupDTO, AttentionItemDTO, CompletenessItem, StudentAttentionDTO } from '@shared';
import { CURRENT_STUDENT_STATUSES } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AcademicSession } from '../academic/session.model';
import { Person, type PersonDoc } from '../staff/person.model';
import { todayFor } from '../staff/status';
import { fullNameOf, hydrateStudents } from './directory';
import { completenessOf } from './student.service';
import { toDirectoryDTO } from './mappers';
import { Student, StudentAdmission, StudentEnrollment, StudentGuardianLink, type StudentDoc, type StudentGuardianLinkDoc } from './student.models';

/** Needs Attention (SPM-33, SPM-36): what an office still has to finish, grouped by what kind of work it is. */

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

/** Runs `fn` over `items` a few at a time, so a big school doesn't open hundreds of queries at once. */
async function inBatches<T, R>(items: readonly T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

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
  return items.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function getAttention(ctx: ServiceContext, query: { academicSessionId?: string; locationId?: string }): Promise<StudentAttentionDTO> {
  const tenantId = ctx.tenantId;
  const today = await todayFor(ctx);
  const session = query.academicSessionId
    ? await AcademicSession.findOne({ _id: query.academicSessionId, tenantId }).lean<{ _id: string; startDate: string }>()
    : await AcademicSession.findOne({ tenantId, status: 'ACTIVE' }).lean<{ _id: string; startDate: string }>();

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

  const newThisYear = session
    ? await StudentAdmission.countDocuments({ tenantId, isCurrent: true, mode: { $ne: 'MIGRATION' }, admissionDate: { $gte: session.startDate }, studentId: { $in: inScope.map((s) => s._id) } })
    : 0;

  const problems = await inBatches(inScope, 20, async (s) => ({ student: s, missing: await completenessOf(ctx, s, h) }));

  const buckets: Record<'SETUP' | 'FAMILY' | 'SUBJECTS', AttentionItemDTO[]> = { SETUP: [], FAMILY: [], SUBJECTS: [] };
  const flagged = new Set<string>();
  for (const { student, missing } of problems) {
    if (missing.length === 0) continue;
    flagged.add(student._id);
    const dto = toDirectoryDTO(student, h);
    for (const m of missing) {
      buckets[GROUP_FOR[m.item]].push({
        key: `${student._id}:${m.item}`,
        studentId: student._id,
        personId: null,
        fullName: dto.fullName,
        admissionNumber: dto.admissionNumber,
        classSection: dto.classSection,
        message: m.message,
        fix: FIX_FOR[m.item],
      });
    }
  }
  const byName = (a: AttentionItemDTO, b: AttentionItemDTO) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' });
  const family = [...buckets.FAMILY.sort(byName), ...(await duplicateParents(ctx, today))];

  const groups: AttentionGroupDTO[] = [
    { key: 'SETUP', title: 'Student setup', items: buckets.SETUP.sort(byName) },
    { key: 'FAMILY', title: 'Family', items: family },
    { key: 'SUBJECTS', title: 'Subjects', items: buckets.SUBJECTS.sort(byName) },
  ];

  return {
    counts: {
      activeStudents: inScope.filter((s) => s.status === 'ACTIVE').length,
      newThisYear,
      needsAttention: flagged.size + (family.length - buckets.FAMILY.length),
    },
    groups,
  };
}
