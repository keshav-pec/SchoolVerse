import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import {
  AUTO_ROLL,
  type BulkPromotionData,
  type BulkPromotionResultDTO,
  type PromotionDecision,
  type PromotionReadinessDTO,
  type PromotionResultRowDTO,
  type PromotionRowDTO,
  type PromotionScopeQuery,
  type RepeatResultDTO,
  type RepeatStudentData,
} from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { ClassMaster } from '../academic/reference.model';
import { AcademicProgramme, type AcademicProgrammeDoc } from '../academic/rules.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { Person, type PersonDoc } from '../staff/person.model';
import { latest, todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { fullNameOf } from './directory';
import { assignSectionInTx, createEnrollmentInTx } from './enrollment.service';
import { assertStudentWritable, loadStudent, requireSchool } from './guards';
import { assertStudentTransition } from './lifecycle';
import { carrySubjectsInTx, closeEnrollmentInTx, endPortalAccessInTx, mapProgramme } from './rollover';
import { isFinalClass, pickSection, PROMOTION_REASON_TEXT, promotionReviewReasons, resolveNextClass, checkSubjectSelection, type ClassLevel, type SectionLoad } from './rules';
import { getEffectiveSettings } from './settings.service';
import { Student, StudentAdmission, StudentEnrollment, StudentSectionAssignment, StudentSubjectEnrollment, type StudentAdmissionDoc, type StudentDoc, type StudentEnrollmentDoc, type StudentSectionAssignmentDoc } from './student.models';
import { liveSubjectRows, loadCheckProgramme, loadClassRules } from './subject.service';

/**
 * SPM-28 to SPM-31 — the yearly rollover. "The system suggests. You decide." Readiness sorts every open enrollment into READY or
 * NEEDS_REVIEW with reasons in plain words. A confirmed run closes each old enrollment (state and outcome only) and starts a new
 * one with a new section, roll number and subjects, one transaction per student, so one failure never breaks the others and a run
 * can be repeated safely. Marks and results are not used: this module does not track them.
 */

// ───────────────────────────────────────────────────────────── the two sessions

async function loadSessions(ctx: ServiceContext, fromSessionId: string, toSessionId: string, db?: ClientSession) {
  const [from, to] = await Promise.all([
    AcademicSession.findOne({ _id: fromSessionId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicSessionDoc>(),
    AcademicSession.findOne({ _id: toSessionId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicSessionDoc>(),
  ]);
  if (!from || !to) throw AppError.notFound('Academic session not found.');
  if (from._id === to._id || to.startDate <= from.startDate) throw new AppError('PROMOTION_SESSIONS_INVALID');
  if (!['PUBLISHED', 'ACTIVE'].includes(to.status)) throw new AppError('PROMOTION_TARGET_NOT_OPEN');
  return { from, to };
}

interface ClassFacts {
  level: ClassLevel;
  offering: ClassOfferingDoc;
}

async function loadLevels(ctx: ServiceContext, sessionId: string, locationId: string, db?: ClientSession): Promise<ClassFacts[]> {
  const offerings = await ClassOffering.find({ tenantId: ctx.tenantId, sessionId, locationId }).session(db ?? null).lean<ClassOfferingDoc[]>();
  const masters = await ClassMaster.find({ _id: { $in: offerings.map((o) => o.classId) } }).lean<{ _id: string; sequenceNumber: number }[]>();
  const sequence = new Map(masters.map((m) => [m._id, m.sequenceNumber]));
  return offerings.map((o) => ({ offering: o, level: { classOfferingId: o._id, classId: o.classId, sequenceNumber: sequence.get(o.classId) ?? -1 } }));
}

/** First day of the new enrollment: the target session's start, or today if it has already begun. */
const startOf = (to: AcademicSessionDoc, today: string) => latest(to.startDate, today);

// ───────────────────────────────────────────────────────────── readiness and recommendation

interface Candidate {
  student: StudentDoc;
  person: PersonDoc;
  enrollment: StudentEnrollmentDoc;
  assignment: StudentSectionAssignmentDoc | null;
  admission: StudentAdmissionDoc | null;
}

async function loadCandidates(ctx: ServiceContext, scope: PromotionScopeQuery): Promise<Candidate[]> {
  const enrollments = await StudentEnrollment.find({ tenantId: ctx.tenantId, academicSessionId: scope.fromSessionId, locationId: scope.locationId, state: 'OPEN', ...(scope.classOfferingId ? { classOfferingId: scope.classOfferingId } : {}) }).lean<StudentEnrollmentDoc[]>();
  if (enrollments.length === 0) return [];
  const studentIds = enrollments.map((e) => e.studentId);
  const [students, assignments, admissions] = await Promise.all([
    Student.find({ tenantId: ctx.tenantId, _id: { $in: studentIds } }).lean<StudentDoc[]>(),
    StudentSectionAssignment.find({ tenantId: ctx.tenantId, enrollmentId: { $in: enrollments.map((e) => e._id) }, cancelledAt: null, effectiveTo: null }).lean<StudentSectionAssignmentDoc[]>(),
    StudentAdmission.find({ tenantId: ctx.tenantId, studentId: { $in: studentIds }, isCurrent: true }).lean<StudentAdmissionDoc[]>(),
  ]);
  const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: students.map((s) => s.personId) } }).lean<PersonDoc[]>();
  const studentOf = new Map(students.map((s) => [s._id, s]));
  const personOf = new Map(people.map((p) => [p._id, p]));
  const assignmentOf = new Map(assignments.map((a) => [a.enrollmentId, a]));
  const admissionOf = new Map(admissions.map((a) => [a.studentId, a]));
  return enrollments
    .filter((e) => studentOf.has(e.studentId))
    .map((enrollment) => {
      const student = studentOf.get(enrollment.studentId)!;
      return { student, person: personOf.get(student.personId)!, enrollment, assignment: assignmentOf.get(enrollment._id) ?? null, admission: admissionOf.get(student._id) ?? null };
    })
    .sort((a, b) => fullNameOf(a.person).localeCompare(fullNameOf(b.person), 'en', { sensitivity: 'base' }) || a.student._id.localeCompare(b.student._id));
}

/** Does the student's current subject choice follow the rules? Rules are loaded once per class, not once per student. */
async function incompleteChoices(ctx: ServiceContext, candidates: Candidate[], today: string): Promise<Set<string>> {
  const rows = await StudentSubjectEnrollment.find({ tenantId: ctx.tenantId, enrollmentId: { $in: candidates.map((c) => c.enrollment._id) }, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] })
    .select('enrollmentId subjectOfferingId')
    .lean<{ enrollmentId: string; subjectOfferingId: string }[]>();
  const byEnrollment = new Map<string, string[]>();
  for (const r of rows) byEnrollment.set(r.enrollmentId, [...(byEnrollment.get(r.enrollmentId) ?? []), r.subjectOfferingId]);
  const rulesOf = new Map<string, Awaited<ReturnType<typeof loadClassRules>>>();
  const programmeOf = new Map<string, Awaited<ReturnType<typeof loadCheckProgramme>>>();
  const bad = new Set<string>();
  for (const c of candidates) {
    const key = c.enrollment.classOfferingId;
    if (!rulesOf.has(key)) rulesOf.set(key, await loadClassRules(ctx, key));
    const pKey = c.enrollment.programmeId ?? '';
    if (!programmeOf.has(pKey)) programmeOf.set(pKey, await loadCheckProgramme(ctx, c.enrollment.programmeId));
    const result = checkSubjectSelection({ ...rulesOf.get(key)!.check, programme: programmeOf.get(pKey) ?? null, selected: byEnrollment.get(c.enrollment._id) ?? [], addMandatory: false });
    if (!result.valid) bad.add(c.student._id);
  }
  return bad;
}

interface PromotionPlan {
  from: AcademicSessionDoc;
  to: AcademicSessionDoc;
  today: string;
  rows: (PromotionRowDTO & { candidate: Candidate; nextClass: ClassFacts | null })[];
}

async function buildPlan(ctx: ServiceContext, scope: PromotionScopeQuery): Promise<PromotionPlan> {
  const { from, to } = await loadSessions(ctx, scope.fromSessionId, scope.toSessionId);
  const today = await todayFor(ctx);
  const [candidates, fromLevels, toLevels] = await Promise.all([loadCandidates(ctx, scope), loadLevels(ctx, from._id, scope.locationId), loadLevels(ctx, to._id, scope.locationId)]);
  const locationInTarget = to.locations.some((l) => l.locationId === scope.locationId);
  const levelOf = new Map(fromLevels.map((f) => [f.offering._id, f]));
  const offeredSequences = fromLevels.map((f) => f.level.sequenceNumber);
  const activeTargets = toLevels.filter((t) => t.offering.status === 'ACTIVE');

  const [incomplete, targetEnrollments, targetSections, targetLoad, programmes] = await Promise.all([
    incompleteChoices(ctx, candidates, today),
    StudentEnrollment.find({ tenantId: ctx.tenantId, academicSessionId: to._id, state: 'OPEN', studentId: { $in: candidates.map((c) => c.student._id) } }).select('studentId').lean<{ studentId: string }[]>(),
    SectionOffering.find({ tenantId: ctx.tenantId, sessionId: to._id, locationId: scope.locationId, status: 'ACTIVE' }).lean<SectionOfferingDoc[]>(),
    StudentSectionAssignment.aggregate<{ _id: string; n: number }>([
      { $match: { tenantId: ctx.tenantId, cancelledAt: null, effectiveTo: null, classOfferingId: { $in: activeTargets.map((t) => t.offering._id) } } },
      { $group: { _id: '$sectionId', n: { $sum: 1 } } },
    ]),
    AcademicProgramme.find({ tenantId: ctx.tenantId, sessionId: { $in: [from._id, to._id] }, locationId: scope.locationId }).lean<AcademicProgrammeDoc[]>(),
  ]);
  const programmeClassSeq = new Map((await ClassMaster.find({ _id: { $in: programmes.flatMap((p) => [p.classFromId, p.classToId]) } }).lean<{ _id: string; sequenceNumber: number }[]>()).map((m) => [m._id, m.sequenceNumber]));
  const fromSections = new Map((await SectionOffering.find({ tenantId: ctx.tenantId, _id: { $in: candidates.map((c) => c.assignment?.sectionId).filter((id): id is string => Boolean(id)) } }).select('sectionCode').lean<{ _id: string; sectionCode: string }[]>()).map((s) => [s._id, s.sectionCode]));
  const hasTarget = new Set(targetEnrollments.map((e) => e.studentId));
  const tally = new Map(targetLoad.map((l) => [l._id, l.n]));
  const sectionsOfClass = (classOfferingId: string) => targetSections.filter((s) => s.classOfferingId === classOfferingId);
  const classLabel = new Map(fromLevels.map((f) => [f.offering._id, f.offering.displayName]));

  const rows: PromotionPlan['rows'] = [];
  for (const c of candidates) {
    const fromLevel = levelOf.get(c.enrollment.classOfferingId);
    const current = fromLevel?.level.sequenceNumber ?? -1;
    const final = isFinalClass(current, offeredSequences);
    const next = final ? null : resolveNextClass(current, activeTargets.map((t) => t.level));
    const nextClass = next ? activeTargets.find((t) => t.level.classOfferingId === next.classOfferingId)! : null;

    // The programme must exist next year and cover the next class (matched by its code).
    let programmeOk = true;
    if (c.enrollment.programmeId && nextClass) {
      const old = programmes.find((p) => p._id === c.enrollment.programmeId);
      const seq = programmeClassSeq;
      const candidate = old ? programmes.find((p) => p.sessionId === to._id && p.code === old.code && p.status === 'ACTIVE') : undefined;
      programmeOk = Boolean(candidate && (seq.get(candidate.classFromId) ?? 0) <= nextClass.level.sequenceNumber && nextClass.level.sequenceNumber <= (seq.get(candidate.classToId) ?? 0));
    }

    const reasons = promotionReviewReasons({
      studentStatus: c.student.status,
      hasSection: Boolean(c.assignment),
      locationInTarget,
      nextClassFound: Boolean(nextClass),
      isFinal: final,
      subjectChoiceIncomplete: incomplete.has(c.student._id),
      programmeOk,
      alreadyHasTargetEnrollment: hasTarget.has(c.student._id),
    });

    let suggested: SectionLoad | null = null;
    if (nextClass && reasons.length === 0) {
      suggested = pickSection(sectionsOfClass(nextClass.offering._id).map((s) => ({ sectionId: s._id, capacity: s.capacity ?? null, enrolled: tally.get(s._id) ?? 0, sequenceOrder: s.sequenceOrder })));
      if (suggested) tally.set(suggested.sectionId, (tally.get(suggested.sectionId) ?? 0) + 1);
    }
    const section = suggested ? targetSections.find((s) => s._id === suggested!.sectionId) : null;
    const fromSection = c.assignment ? fromSections.get(c.assignment.sectionId) ?? null : null;
    rows.push({
      candidate: c,
      nextClass,
      studentId: c.student._id,
      enrollmentId: c.enrollment._id,
      fullName: fullNameOf(c.person),
      admissionNumber: c.admission?.admissionNumber ?? null,
      fromClass: classLabel.get(c.enrollment.classOfferingId) ?? 'Class',
      fromSection,
      nextClassOfferingId: nextClass?.offering._id ?? null,
      nextClassName: nextClass?.offering.displayName ?? null,
      suggestedSectionId: section?._id ?? null,
      suggestedSectionLabel: section && nextClass ? `${nextClass.offering.displayCode}-${section.sectionCode}` : null,
      isFinalClass: final,
      suggestedDecision: reasons.length === 0 ? (final ? 'PASSED_OUT' : 'PROMOTE') : null,
      reasons: reasons.map((code) => ({ code, message: PROMOTION_REASON_TEXT[code] })),
    });
  }
  return { from, to, today, rows };
}

const toRowDTO = ({ candidate: _c, nextClass: _n, ...row }: PromotionPlan['rows'][number]): PromotionRowDTO => row;

export async function getReadiness(ctx: ServiceContext, scope: PromotionScopeQuery): Promise<PromotionReadinessDTO> {
  const plan = await buildPlan(ctx, scope);
  const ready = plan.rows.filter((r) => r.reasons.length === 0).map(toRowDTO);
  const review = plan.rows.filter((r) => r.reasons.length > 0).map(toRowDTO);
  return { fromSessionId: scope.fromSessionId, toSessionId: scope.toSessionId, locationId: scope.locationId, checked: plan.rows.length, ready: ready.length, needsReview: review.length, readyRows: ready, reviewRows: review };
}

/** The suggested next class and section for each student who is ready (the readiness rows already carry them; this is the same list on its own). */
export async function recommend(ctx: ServiceContext, scope: PromotionScopeQuery): Promise<PromotionRowDTO[]> {
  return (await getReadiness(ctx, scope)).readyRows;
}

// ───────────────────────────────────────────────────────────── one student

interface Move {
  studentId: string;
  decision: PromotionDecision;
  nextClassOfferingId?: string | undefined;
  sectionId?: string | undefined;
}

const outcomeFor = { PROMOTE: 'PROMOTED', REPEAT: 'REPEATED', PASSED_OUT: 'PASSED_OUT' } as const;

/**
 * Moves one student into the next session (or finishes school), inside the caller's transaction. Returns the new enrollment id,
 * or `null` for a student who finished school. Throws a plain-language error when the move cannot be made.
 */
async function moveInTx(ctx: ServiceContext, db: ClientSession, from: AcademicSessionDoc, to: AcademicSessionDoc, move: Move): Promise<{ toEnrollmentId: string | null; choicePending: boolean }> {
  const school = await requireSchool(ctx);
  const student = await loadStudent(ctx, move.studentId, db);
  assertStudentWritable(student);
  const today = await todayFor(ctx, db);
  const old = await StudentEnrollment.findOne({ tenantId: ctx.tenantId, studentId: move.studentId, academicSessionId: from._id, state: 'OPEN' }).session(db).lean<StudentEnrollmentDoc>();
  if (!old) throw new AppError('ENROLLMENT_CLOSED', 'This student has no open enrollment in the session being closed.');
  if (student.status === 'WITHDRAWAL_INITIATED') throw AppError.validation({ studentId: 'This student is leaving the school. Finish the exit instead.' });
  if (student.status !== 'ACTIVE') throw AppError.validation({ studentId: 'Only an active student can be promoted.' });
  // Last day of the old enrollment: the end of its session, never before it began.
  const lastDay = latest(from.endDate, old.effectiveFrom);
  const oldClass = (await ClassOffering.findOne({ _id: old.classOfferingId, tenantId: ctx.tenantId }).session(db).lean<ClassOfferingDoc>())!;

  if (move.decision === 'PASSED_OUT') {
    const levels = await loadLevels(ctx, from._id, old.locationId, db);
    const mine = levels.find((l) => l.offering._id === old.classOfferingId)?.level.sequenceNumber ?? -1;
    if (!isFinalClass(mine, levels.map((l) => l.level.sequenceNumber))) throw AppError.validation({ decision: 'This student is not in the last class, so they cannot finish school.' });
    await closeEnrollmentInTx(ctx, db, old, { lastDay, state: 'COMPLETED', outcome: 'PASSED_OUT' });
    const status = assertStudentTransition(student.status, 'complete_schooling');
    await Student.updateOne({ _id: student._id, tenantId: ctx.tenantId }, { $set: { status, statusChangedAt: new Date(), statusChangedBy: ctx.userId, updatedBy: ctx.userId } }, { session: db });
    await endPortalAccessInTx(ctx, db, student._id, 'COMPLETED_SCHOOLING');
    await recordStudentAudit(ctx, db, { entityType: 'student', entityId: student._id, action: 'student.completed_schooling', changes: [{ field: 'status', from: student.status, to: status }], studentId: student._id, metadata: { fromSessionId: from._id } });
    return { toEnrollmentId: null, choicePending: false };
  }

  // The class the student goes into: the repeat is the same class next year; a promotion is the next one (or the one the admin chose).
  let toClass: ClassOfferingDoc | null;
  if (move.decision === 'REPEAT') {
    toClass = await ClassOffering.findOne({ tenantId: ctx.tenantId, sessionId: to._id, locationId: old.locationId, classId: oldClass.classId, status: 'ACTIVE' }).session(db).lean<ClassOfferingDoc>();
    if (!toClass) throw new AppError('CLASS_NOT_OFFERED_AT_LOCATION', `${oldClass.displayName} is not offered next year at this campus.`);
  } else if (move.nextClassOfferingId) {
    toClass = await ClassOffering.findOne({ _id: move.nextClassOfferingId, tenantId: ctx.tenantId }).session(db).lean<ClassOfferingDoc>();
    if (!toClass || toClass.sessionId !== to._id || toClass.locationId !== old.locationId) throw new AppError('CLASS_NOT_OFFERED_AT_LOCATION');
  } else {
    const levels = await loadLevels(ctx, to._id, old.locationId, db);
    const mine = (await loadLevels(ctx, from._id, old.locationId, db)).find((l) => l.offering._id === old.classOfferingId)?.level.sequenceNumber ?? -1;
    const next = resolveNextClass(mine, levels.filter((l) => l.offering.status === 'ACTIVE').map((l) => l.level));
    toClass = next ? levels.find((l) => l.level.classOfferingId === next.classOfferingId)!.offering : null;
    if (!toClass) throw new AppError('CLASS_NOT_OFFERED_AT_LOCATION', 'No class is offered for next year.');
  }

  const settings = await getEffectiveSettings(ctx, school, db);
  const previous = await liveSubjectRows(ctx, old._id, today, db);
  const programmeId = await mapProgramme(ctx, db, old.programmeId, toClass);
  await closeEnrollmentInTx(ctx, db, old, { lastDay, state: 'COMPLETED', outcome: outcomeFor[move.decision as 'PROMOTE' | 'REPEAT'] });

  const next = await createEnrollmentInTx(ctx, db, {
    studentId: student._id,
    schoolId: school._id,
    session: to,
    offering: toClass,
    programmeId,
    enrollmentType: move.decision === 'REPEAT' ? 'REPEATING' : 'PROMOTED',
    effectiveFrom: startOf(to, today),
    previousEnrollmentId: old._id,
  });
  if (move.sectionId) await assignSectionInTx(ctx, db, next, { sectionId: move.sectionId, rollNumber: AUTO_ROLL, effectiveFrom: next.effectiveFrom }, settings);
  const carried = await carrySubjectsInTx(ctx, db, { toEnrollment: next, previousOfferingIds: previous.filter((r) => !r.isMandatory).map((r) => r.subjectOfferingId), copy: true });
  await recordStudentAudit(ctx, db, {
    entityType: 'student',
    entityId: student._id,
    action: move.decision === 'REPEAT' ? 'student.repeated' : 'student.promoted',
    changes: [{ field: 'classOfferingId', from: old.classOfferingId, to: toClass._id }],
    studentId: student._id,
    metadata: { fromEnrollmentId: old._id, toEnrollmentId: next._id, fromSessionId: from._id, toSessionId: to._id, fromClass: oldClass.displayName, toClass: toClass.displayName },
  });
  return { toEnrollmentId: next._id, choicePending: carried.choicePending };
}

// ───────────────────────────────────────────────────────────── bulk

/** A student who was already moved: the old enrollment is complete and there is a new one in the target session. */
async function alreadyMoved(ctx: ServiceContext, studentId: string, from: AcademicSessionDoc, to: AcademicSessionDoc): Promise<boolean> {
  const done = await StudentEnrollment.findOne({ tenantId: ctx.tenantId, studentId, academicSessionId: from._id, state: 'COMPLETED', outcome: { $in: ['PROMOTED', 'REPEATED', 'PASSED_OUT'] } }).select('outcome').lean<{ outcome: string }>();
  if (!done) return false;
  if (done.outcome === 'PASSED_OUT') return true;
  return Boolean(await StudentEnrollment.exists({ tenantId: ctx.tenantId, studentId, academicSessionId: to._id, state: { $in: ['OPEN', 'COMPLETED'] }, previousEnrollmentId: { $ne: null } }));
}

export async function bulkPromote(ctx: ServiceContext, data: BulkPromotionData): Promise<BulkPromotionResultDTO> {
  const { from, to } = await loadSessions(ctx, data.fromSessionId, data.toSessionId);
  let moves: Move[];
  if (data.readyOnly) {
    if (!data.locationId) throw AppError.validation({ locationId: 'Choose the campus to promote.' });
    const readiness = await getReadiness(ctx, { fromSessionId: from._id, toSessionId: to._id, locationId: data.locationId, ...(data.classOfferingId ? { classOfferingId: data.classOfferingId } : {}) });
    const override = new Map((data.overrides ?? []).map((o) => [o.studentId, o]));
    moves = readiness.readyRows.map((r) => ({
      studentId: r.studentId,
      decision: r.suggestedDecision ?? 'PROMOTE',
      nextClassOfferingId: override.get(r.studentId)?.nextClassOfferingId ?? r.nextClassOfferingId ?? undefined,
      sectionId: override.get(r.studentId)?.sectionId ?? r.suggestedSectionId ?? undefined,
    }));
  } else {
    moves = (data.decisions ?? []).map((d) => ({ studentId: d.studentId, decision: d.decision, nextClassOfferingId: d.nextClassOfferingId, sectionId: d.sectionId }));
  }

  const rows: PromotionResultRowDTO[] = [];
  for (const move of moves) {
    const name = await nameOf(ctx, move.studentId);
    const row = (status: PromotionResultRowDTO['status'], message: string | null, toEnrollmentId: string | null = null): PromotionResultRowDTO => ({ studentId: move.studentId, fullName: name, decision: move.decision, status, message, toEnrollmentId });
    if (move.decision === 'LEAVING') {
      rows.push(row('SKIPPED', 'Left for the exit process.'));
      continue;
    }
    if (move.decision === 'HOLD') {
      rows.push(row('SKIPPED', 'On hold. Nothing was created.'));
      continue;
    }
    try {
      if (await alreadyMoved(ctx, move.studentId, from, to)) {
        rows.push(row('SKIPPED', 'Already promoted.'));
        continue;
      }
      const result = await withTransaction((db) => moveInTx(ctx, db, from, to, move));
      rows.push(row('DONE', result.choicePending ? 'Done. Subject choice still has to be made.' : null, result.toEnrollmentId));
    } catch (err) {
      rows.push(row('FAILED', err instanceof AppError ? friendly(err) : 'Something went wrong. Try this student again.'));
    }
  }
  const count = (s: PromotionResultRowDTO['status']) => rows.filter((r) => r.status === s).length;
  const result = { done: count('DONE'), skipped: count('SKIPPED'), failed: count('FAILED'), rows };
  await withTransaction((db) =>
    recordStudentAudit(ctx, db, { entityType: 'promotion', entityId: randomUUID(), action: 'promotion.bulk_run', changes: [], studentId: null, metadata: { fromSessionId: from._id, toSessionId: to._id, done: result.done, skipped: result.skipped, failed: result.failed } }),
  );
  return result;
}

function friendly(err: AppError): string {
  const fields = err.details?.fields;
  return fields ? Object.values(fields).join(' ') : err.message;
}

async function nameOf(ctx: ServiceContext, studentId: string): Promise<string> {
  const student = await Student.findOne({ _id: studentId, tenantId: ctx.tenantId }).select('personId').lean<{ personId: string }>();
  const person = student ? await Person.findOne({ _id: student.personId, tenantId: ctx.tenantId }).lean<PersonDoc>() : null;
  return person ? fullNameOf(person) : 'Unknown student';
}

// ───────────────────────────────────────────────────────────── repeat

/** The student repeats their class in the next session: the old enrollment completes with outcome REPEATED and a same-class enrollment starts. */
export async function repeatStudent(ctx: ServiceContext, studentId: string, data: RepeatStudentData): Promise<RepeatResultDTO> {
  const result = await withTransaction(async (db) => {
    const to = await AcademicSession.findOne({ _id: data.toSessionId, tenantId: ctx.tenantId }).session(db).lean<AcademicSessionDoc>();
    if (!to) throw AppError.notFound('Academic session not found.');
    if (!['PUBLISHED', 'ACTIVE'].includes(to.status)) throw new AppError('PROMOTION_TARGET_NOT_OPEN');
    // The enrollment being repeated: the student's open one in an earlier session.
    const open = await StudentEnrollment.find({ tenantId: ctx.tenantId, studentId, state: 'OPEN' }).session(db).lean<StudentEnrollmentDoc[]>();
    const old = open.filter((e) => e.academicSessionId !== to._id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    if (!old) throw new AppError('ENROLLMENT_CLOSED', 'This student has no open enrollment to repeat.');
    const from = (await AcademicSession.findOne({ _id: old.academicSessionId, tenantId: ctx.tenantId }).session(db).lean<AcademicSessionDoc>())!;
    if (to.startDate <= from.startDate) throw new AppError('PROMOTION_SESSIONS_INVALID');
    const moved = await moveInTx(ctx, db, from, to, { studentId, decision: 'REPEAT', sectionId: data.sectionId });
    return { fromEnrollmentId: old._id, toEnrollmentId: moved.toEnrollmentId!, choicePending: moved.choicePending };
  });
  return result;
}

