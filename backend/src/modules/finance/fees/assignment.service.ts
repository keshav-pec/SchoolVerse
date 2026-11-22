import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { EXITED_STUDENT_STATUSES } from '@shared';
import type { AssignmentExceptionReason, AssignmentRecommendationDTO, AssignmentRowDTO, BulkAssignData, BulkAssignResultDTO, FeeStudentType, StudentAssignmentDTO, UpdateStudentAssignmentData } from '@shared';
import { AppError } from '../../../core/errors';
import { addDays } from '../../../core/dates';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { ClassOffering, type ClassOfferingDoc } from '../../academic/offering.model';
import { AcademicSession } from '../../academic/session.model';
import { Student, StudentEnrollment, type StudentEnrollmentDoc } from '../../students/student.models';
import { auditFinance, assertInScope, assertLocationAccess, emitFinance, financeCtx, financeScope, type FinanceCtx } from '../core/context';
import { LegalEntity } from '../core/models';
import { studentLabels } from '../core/people';
import { yearlyTotal } from './plan.service';
import { FeePlan, FeePlanItem, FeePlanVersion, StudentFeeAssignment, type FeePlanDoc, type FeePlanItemDoc, type FeePlanVersionDoc, type StudentFeeAssignmentDoc } from './models';

/**
 * Smart assignment (FEE-04). The school does not pick a plan for every child: it looks at the exceptions only.
 *   recommend   per class, how many students are eligible, ready, or need a decision (and why)
 *   bulk        assigns every ready student in one request; a retry changes nothing
 * One open assignment per student per session is enforced by a unique index, so two people pressing the button together cannot double up.
 */

export interface PublishedPlan {
  plan: FeePlanDoc;
  version: FeePlanVersionDoc;
}

export async function publishedPlans(f: FinanceCtx, sessionId: string, db?: ClientSession): Promise<PublishedPlan[]> {
  const plans = await FeePlan.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, sessionId, status: 'ACTIVE' }).session(db ?? null).lean<FeePlanDoc[]>();
  const versions = await FeePlanVersion.find({ tenantId: f.tenantId, planId: { $in: plans.map((p) => p._id) }, state: 'PUBLISHED' }).session(db ?? null).lean<FeePlanVersionDoc[]>();
  const byPlan = new Map(versions.map((v) => [v.planId, v]));
  return plans.flatMap((plan) => (byPlan.has(plan._id) ? [{ plan, version: byPlan.get(plan._id)! }] : []));
}

/** NEW means joining the school this session; EXISTING means continuing. */
export const studentTypeOf = (type: StudentEnrollmentDoc['enrollmentType']): Exclude<FeeStudentType, 'ALL'> => (['NEW_ADMISSION', 'TRANSFER_IN', 'READMISSION'].includes(type) ? 'NEW' : 'EXISTING');

export interface Fit {
  status: 'READY' | 'NO_PLAN' | 'PLAN_CONFLICT';
  candidates: PublishedPlan[];
}

/** Which published plans fit one student. A student-only plan wins over the general ones. */
export function planFor(plans: PublishedPlan[], who: { studentId: string; locationId: string; classId: string; type: Exclude<FeeStudentType, 'ALL'> }): Fit {
  const own = plans.filter((p) => p.plan.appliesTo.studentId === who.studentId);
  const general = plans.filter(
    (p) =>
      !p.plan.appliesTo.studentId &&
      (p.plan.appliesTo.locationIds.length === 0 || p.plan.appliesTo.locationIds.includes(who.locationId)) &&
      (p.plan.appliesTo.classIds.length === 0 || p.plan.appliesTo.classIds.includes(who.classId)) &&
      (p.plan.appliesTo.studentType === 'ALL' || p.plan.appliesTo.studentType === who.type),
  );
  const candidates = own.length ? own : general;
  return { status: candidates.length === 1 ? 'READY' : candidates.length === 0 ? 'NO_PLAN' : 'PLAN_CONFLICT', candidates };
}

const REASON_TEXT: Record<AssignmentExceptionReason, string> = {
  NO_PLAN: 'No plan for this class',
  PLAN_CONFLICT: 'Two plans match',
  ALREADY_ASSIGNED: 'Already has a plan',
  NOT_ENROLLED: 'Not enrolled in this class this session',
};

interface Candidate {
  enrollment: StudentEnrollmentDoc;
  offering: ClassOfferingDoc;
}

async function loadCandidates(f: FinanceCtx, query: { sessionId: string; locationId: string; classId?: string | undefined; studentIds?: string[] | undefined }): Promise<Candidate[]> {
  const offerings = await ClassOffering.find({ tenantId: f.tenantId, sessionId: query.sessionId, locationId: query.locationId, ...(query.classId ? { classId: query.classId } : {}) }).sort({ sequenceOrder: 1 }).lean<ClassOfferingDoc[]>();
  const enrollments = await StudentEnrollment.find({ tenantId: f.tenantId, academicSessionId: query.sessionId, state: 'OPEN', classOfferingId: { $in: offerings.map((o) => o._id) }, ...(query.studentIds ? { studentId: { $in: query.studentIds } } : {}) }).lean<StudentEnrollmentDoc[]>();
  const live = new Set((await Student.find({ tenantId: f.tenantId, _id: { $in: enrollments.map((e) => e.studentId) }, status: { $nin: EXITED_STUDENT_STATUSES } }).select('_id').lean<{ _id: string }[]>()).map((s) => s._id));
  const byOffering = new Map(offerings.map((o) => [o._id, o]));
  return enrollments.filter((e) => live.has(e.studentId)).map((enrollment) => ({ enrollment, offering: byOffering.get(enrollment.classOfferingId)! }));
}

export async function recommendAssignments(ctx: ServiceContext, query: { sessionId: string; locationId: string; classId?: string | undefined }): Promise<AssignmentRecommendationDTO> {
  const f = await financeCtx(ctx);
  await assertLocationAccess(ctx, query.locationId);
  return buildRecommendation(f, query);
}

async function buildRecommendation(f: FinanceCtx, query: { sessionId: string; locationId: string; classId?: string | undefined; studentIds?: string[] | undefined }): Promise<AssignmentRecommendationDTO> {
  const [candidates, plans] = await Promise.all([loadCandidates(f, query), publishedPlans(f, query.sessionId)]);
  const open = new Set((await StudentFeeAssignment.find({ tenantId: f.tenantId, sessionId: query.sessionId, state: 'OPEN', studentId: { $in: candidates.map((c) => c.enrollment.studentId) } }).select('studentId').lean<{ studentId: string }[]>()).map((a) => a.studentId));
  const labels = await studentLabels(f, candidates.map((c) => c.enrollment.studentId));
  const yearlyByVersion = new Map<string, number>();
  const yearly = async (version: FeePlanVersionDoc, locationId: string) => {
    if (!yearlyByVersion.has(version._id)) yearlyByVersion.set(version._id, await yearlyTotal(f, await FeePlanItem.find({ tenantId: f.tenantId, versionId: version._id }).lean<FeePlanItemDoc[]>(), query.sessionId, locationId));
    return yearlyByVersion.get(version._id)!;
  };

  const rows: AssignmentRowDTO[] = [];
  let expectedPaise = 0;
  for (const { enrollment, offering } of candidates.sort((a, b) => a.offering.sequenceOrder - b.offering.sequenceOrder)) {
    const fit = planFor(plans, { studentId: enrollment.studentId, locationId: enrollment.locationId, classId: offering.classId, type: studentTypeOf(enrollment.enrollmentType) });
    const assigned = open.has(enrollment.studentId);
    const status: AssignmentRowDTO['status'] = assigned ? 'ALREADY_ASSIGNED' : fit.status;
    const chosen = fit.status === 'READY' ? fit.candidates[0]! : null;
    if (status === 'READY' && chosen) expectedPaise += await yearly(chosen.version, enrollment.locationId);
    rows.push({
      studentId: enrollment.studentId, studentName: labels.get(enrollment.studentId)?.name ?? 'Student', admissionNumber: labels.get(enrollment.studentId)?.admissionNumber ?? null, classOfferingId: offering._id, className: offering.displayName,
      status, planVersionId: status === 'READY' && chosen ? chosen.version._id : null, planName: status === 'READY' && chosen ? chosen.plan.name : null,
      candidatePlans: fit.candidates.map((c) => ({ versionId: c.version._id, planName: c.plan.name })), reason: status === 'READY' ? null : REASON_TEXT[status],
    });
  }
  const classes = [...new Map(candidates.map((c) => [c.offering._id, c.offering])).values()].map((o) => {
    const mine = rows.filter((r) => r.classOfferingId === o._id);
    return { classOfferingId: o._id, className: o.displayName, eligible: mine.length, ready: mine.filter((r) => r.status === 'READY').length, needReview: mine.filter((r) => r.status === 'NO_PLAN' || r.status === 'PLAN_CONFLICT').length, alreadyAssigned: mine.filter((r) => r.status === 'ALREADY_ASSIGNED').length };
  });
  const sum = (k: 'eligible' | 'ready' | 'needReview' | 'alreadyAssigned') => classes.reduce((s, c) => s + c[k], 0);
  return { sessionId: query.sessionId, locationId: query.locationId, classes, totals: { eligible: sum('eligible'), ready: sum('ready'), needReview: sum('needReview'), alreadyAssigned: sum('alreadyAssigned') }, expectedPaise, rows };
}

export function toAssignmentDTO(a: StudentFeeAssignmentDoc, planName: string): StudentAssignmentDTO {
  return { assignmentId: a._id, studentId: a.studentId, sessionId: a.sessionId, planVersionId: a.planVersionId, planName, optionalItemIds: a.optionalItemIds, effectiveFrom: a.effectiveFrom, effectiveTo: a.effectiveTo, source: a.source };
}

async function createAssignmentInTx(f: FinanceCtx, db: ClientSession, c: Candidate, versionId: string, source: StudentFeeAssignmentDoc['source']) {
  const id = randomUUID();
  await StudentFeeAssignment.create(
    [{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, studentId: c.enrollment.studentId, enrollmentId: c.enrollment._id, sessionId: c.enrollment.academicSessionId, locationId: c.enrollment.locationId, classOfferingId: c.enrollment.classOfferingId, planVersionId: versionId, effectiveFrom: c.enrollment.effectiveFrom, source, createdBy: f.system ? null : f.userId }],
    { session: db },
  );
  await auditFinance(f, db, { action: 'fee_assignment.created', entityType: 'fee_assignment', entityId: id, after: { studentId: c.enrollment.studentId, planVersionId: versionId, source } });
  await emitFinance(f, db, 'fee_assignment.created', { assignmentId: id, studentId: c.enrollment.studentId, planVersionId: versionId, source });
  return id;
}

export async function bulkAssign(ctx: ServiceContext, data: BulkAssignData, source: StudentFeeAssignmentDoc['source'] = 'MANUAL'): Promise<BulkAssignResultDTO> {
  const f = await financeCtx(ctx);
  await assertLocationAccess(ctx, data.locationId);
  const rec = await buildRecommendation(f, { sessionId: data.sessionId, locationId: data.locationId, classId: data.classId, studentIds: data.items?.map((i) => i.studentId) });
  const candidates = new Map((await loadCandidates(f, { sessionId: data.sessionId, locationId: data.locationId, classId: data.classId, studentIds: data.items?.map((i) => i.studentId) })).map((c) => [c.enrollment.studentId, c]));
  const choice = new Map((data.items ?? []).map((i) => [i.studentId, i.planVersionId ?? null]));
  const wanted = data.items ? data.items.map((i) => i.studentId) : rec.rows.filter((r) => r.status === 'READY').map((r) => r.studentId);
  const row = new Map(rec.rows.map((r) => [r.studentId, r]));
  const results: BulkAssignResultDTO['results'] = [];
  let expectedPaise = 0;

  for (const studentId of wanted) {
    const r = row.get(studentId);
    const c = candidates.get(studentId);
    if (!r || !c) {
      results.push({ studentId, status: 'SKIPPED', reason: 'NOT_ENROLLED', message: REASON_TEXT.NOT_ENROLLED });
      continue;
    }
    if (r.status === 'ALREADY_ASSIGNED') {
      results.push({ studentId, status: 'SKIPPED', reason: 'ALREADY_ASSIGNED', message: REASON_TEXT.ALREADY_ASSIGNED });
      continue;
    }
    const picked = choice.get(studentId);
    const versionId = picked ?? r.planVersionId;
    if (!versionId || (picked && !r.candidatePlans.some((p) => p.versionId === picked))) {
      results.push({ studentId, status: 'SKIPPED', reason: r.status === 'NO_PLAN' ? 'NO_PLAN' : 'PLAN_CONFLICT', message: picked ? 'This plan does not apply to this student.' : r.reason });
      continue;
    }
    try {
      await withTransaction(async (db) => {
        await createAssignmentInTx(f, db, c, versionId, source);
      });
      results.push({ studentId, status: 'ASSIGNED', reason: null, message: null });
      const items = await FeePlanItem.find({ tenantId: f.tenantId, versionId }).lean<FeePlanItemDoc[]>();
      expectedPaise += await yearlyTotal(f, items, data.sessionId, data.locationId);
    } catch (err) {
      if (!duplicateKeyFields(err)) throw err;
      results.push({ studentId, status: 'SKIPPED', reason: 'ALREADY_ASSIGNED', message: REASON_TEXT.ALREADY_ASSIGNED });
    }
  }
  const done = results.filter((r) => r.status === 'ASSIGNED').length;
  if (done > 0) await auditFinance(f, undefined, { action: 'fee_assignment.bulk', entityType: 'fee_assignment', entityId: data.sessionId, after: { done, skipped: results.length - done, locationId: data.locationId } });
  return { done, skipped: results.length - done, expectedPaise, results };
}

// ───────────────────────────────────────────────────────────── one student (optional items, a different plan)

async function openAssignmentFor(f: FinanceCtx, studentId: string, sessionId?: string, db?: ClientSession): Promise<StudentFeeAssignmentDoc> {
  const filter: Record<string, unknown> = { tenantId: f.tenantId, studentId, state: 'OPEN' };
  if (sessionId) filter.sessionId = sessionId;
  const found = await StudentFeeAssignment.findOne(filter).sort({ effectiveFrom: -1 }).session(db ?? null).lean<StudentFeeAssignmentDoc>();
  if (!found) throw AppError.notFound('This student has no fee plan yet.');
  return found;
}

export async function getStudentAssignment(f: FinanceCtx, studentId: string, sessionId?: string): Promise<StudentFeeAssignmentDoc | null> {
  const filter: Record<string, unknown> = { tenantId: f.tenantId, studentId, state: 'OPEN' };
  if (sessionId) filter.sessionId = sessionId;
  return StudentFeeAssignment.findOne(filter).sort({ effectiveFrom: -1 }).lean<StudentFeeAssignmentDoc>();
}

/** Ticks or unticks optional fees (Transport) and can move a student to a student-only plan. Bills already issued never change. */
export async function updateStudentAssignment(ctx: ServiceContext, studentId: string, data: UpdateStudentAssignmentData): Promise<StudentAssignmentDTO> {
  const f = await financeCtx(ctx);
  const before = await openAssignmentFor(f, studentId, data.sessionId);
  await assertInScope(ctx, await financeScope(ctx), before.locationId, 'student', studentId);
  let versionId = before.planVersionId;
  if (data.planVersionId && data.planVersionId !== before.planVersionId) {
    const target = (await publishedPlans(f, before.sessionId)).find((p) => p.version._id === data.planVersionId);
    if (!target) throw AppError.validation({ planVersionId: 'This plan is not published for this session.' });
    versionId = target.version._id;
  }
  const items = await FeePlanItem.find({ tenantId: f.tenantId, versionId }).lean<FeePlanItemDoc[]>();
  const optional = new Set(items.filter((i) => i.isOptional).map((i) => i._id));
  const next = data.optionalItemIds ?? (versionId === before.planVersionId ? before.optionalItemIds : []);
  for (const id of next) if (!optional.has(id)) throw AppError.validation({ optionalItemIds: 'Only optional fee lines of this plan can be ticked.' });
  await withTransaction(async (db) => {
    await StudentFeeAssignment.updateOne({ _id: before._id, tenantId: f.tenantId, state: 'OPEN' }, { $set: { planVersionId: versionId, optionalItemIds: next, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'fee_assignment.changed', entityType: 'fee_assignment', entityId: before._id, before: { planVersionId: before.planVersionId, optionalItemIds: before.optionalItemIds }, after: { planVersionId: versionId, optionalItemIds: next }, metadata: { reason: data.reason, studentId } });
  });
  const fresh = (await StudentFeeAssignment.findOne({ _id: before._id, tenantId: f.tenantId }).lean<StudentFeeAssignmentDoc>())!;
  const version = await FeePlanVersion.findOne({ _id: fresh.planVersionId, tenantId: f.tenantId }).lean<FeePlanVersionDoc>();
  const plan = await FeePlan.findOne({ _id: version?.planId, tenantId: f.tenantId }).select('name').lean<{ name: string }>();
  return toAssignmentDTO(fresh, plan?.name ?? '');
}

// ───────────────────────────────────────────────────────────── the Module 4 hook (FEE-04, FEE-15)

/**
 * Runs when Module 4 saves an enrollment (a new admission, a promotion, a transfer, a readmission):
 *   1. an open assignment from an earlier enrollment in the SAME session ends the day before the new one starts (a transfer or a class change)
 *   2. when exactly one published plan with "assign automatically" on fits the student, the student is assigned at once
 * Anything else stays an exception for the school to decide, and shows up in the recommendation list.
 */
export async function onEnrollmentSaved(input: { ctx: ServiceContext; db: ClientSession; enrollment: StudentEnrollmentDoc; offering: ClassOfferingDoc }): Promise<void> {
  const { ctx, db, enrollment, offering } = input;
  if (!(await LegalEntity.exists({ tenantId: ctx.tenantId }).session(db))) return; // Finance is not set up yet
  const f = await financeCtx(ctx, db);
  const old = await StudentFeeAssignment.find({ tenantId: f.tenantId, studentId: enrollment.studentId, sessionId: enrollment.academicSessionId, state: 'OPEN', enrollmentId: { $ne: enrollment._id } }).session(db).lean<StudentFeeAssignmentDoc[]>();
  for (const a of old) {
    const endOn = addDays(enrollment.effectiveFrom, -1);
    await StudentFeeAssignment.updateOne({ _id: a._id, tenantId: f.tenantId }, { $set: { state: 'ENDED', effectiveTo: endOn < a.effectiveFrom ? a.effectiveFrom : endOn } }, { session: db });
    await auditFinance(f, db, { action: 'fee_assignment.ended', entityType: 'fee_assignment', entityId: a._id, after: { reason: 'The student moved to another class or campus.', effectiveTo: endOn } });
  }
  const session = await AcademicSession.exists({ _id: enrollment.academicSessionId, tenantId: f.tenantId }).session(db);
  if (!session) return;
  const fit = planFor(await publishedPlans(f, enrollment.academicSessionId, db), { studentId: enrollment.studentId, locationId: enrollment.locationId, classId: offering.classId, type: studentTypeOf(enrollment.enrollmentType) });
  if (fit.status !== 'READY' || !fit.candidates[0]!.plan.autoAssign) return;
  if (await StudentFeeAssignment.exists({ tenantId: f.tenantId, studentId: enrollment.studentId, sessionId: enrollment.academicSessionId, state: 'OPEN' }).session(db)) return;
  await createAssignmentInTx(f, db, { enrollment, offering }, fit.candidates[0]!.version._id, 'AUTO');
}
