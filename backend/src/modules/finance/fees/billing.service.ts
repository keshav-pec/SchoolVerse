import { randomUUID } from 'node:crypto';
import { EXITED_STUDENT_STATUSES, type BillingCommitDTO, type BillingReason, type BillingRowDTO, type BillingRunDTO, type BillingValidationDTO, type CommitBillingRunData, type CreateBillingRunData } from '@shared';
import { AppError } from '../../../core/errors';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { ClassOffering, type ClassOfferingDoc } from '../../academic/offering.model';
import { AcademicSession } from '../../academic/session.model';
import { Student, StudentEnrollment, type StudentEnrollmentDoc } from '../../students/student.models';
import { rolesMap } from '../core/chart.service';
import { assertLocationAccess, auditFinance, financeCtx, periodFor, type FinanceCtx } from '../core/context';
import { formatMoney } from '../core/money';
import { studentLabels } from '../core/people';
import { issueDocument } from './documents';
import { awardActiveOn, buildBill, loadAwards, loadEngine, type Engine, type StudentAward } from './engine';
import { planFor, publishedPlans, studentTypeOf } from './assignment.service';
import { BillingRun, BillingRunRow, FeeDocument, StudentFeeAssignment, type BillingRunDoc, type BillingRunRowDoc, type FeeDocumentDoc, type StudentFeeAssignmentDoc } from './models';
import { sessionMonths } from './schedule';

/**
 * Billing runs (FEE-09, 10). The school never fills in a bill. It presses Check, reads "2,796 ready · 54 need attention", fixes or
 * skips the exceptions, and presses Issue. Each student's bill is made in its OWN transaction, and the run keeps a checkpoint, so a
 * crash half-way is continued by running it again. The line key (student + fee item + period) stops any bill being made twice.
 */

const FIX: Record<BillingReason, string> = {
  NO_PLAN: 'Choose Plan', PLAN_CONFLICT: 'Choose Plan', TAX_CODE_MISSING: 'Add Tax Code', STUDENT_NOT_ENROLLED: 'Check Enrollment', ALREADY_BILLED: 'Nothing to do', PERIOD_CLOSED: 'Open The Period', AWARD_EXPIRED: 'End Concession', NOTHING_DUE: 'Skip',
};
const TEXT: Partial<Record<BillingReason, string>> = {
  NO_PLAN: 'No fee plan for this class.', PLAN_CONFLICT: 'Two fee plans match this student.', STUDENT_NOT_ENROLLED: 'Not enrolled in this class any more.', ALREADY_BILLED: 'Already billed for this month.',
  PERIOD_CLOSED: 'The accounting period for the bill date is closed.', AWARD_EXPIRED: 'A concession has run out. End it or renew it.',
};

function runDTO(r: BillingRunDoc): BillingRunDTO {
  return { runId: r._id, periodKey: r.periodKey, sessionId: r.sessionId, locationId: r.locationId, classIds: r.classIds, issueDate: r.issueDate, dueDate: r.dueDate, state: r.state, counts: r.counts, totalPaise: r.totalPaise, createdAt: new Date(r.createdAt).toISOString() };
}

async function loadRun(f: FinanceCtx, id: string): Promise<BillingRunDoc> {
  const run = await BillingRun.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<BillingRunDoc>();
  if (!run) throw AppError.notFound('Billing run not found.');
  return run;
}

export async function createRun(ctx: ServiceContext, data: CreateBillingRunData): Promise<BillingRunDTO> {
  const f = await financeCtx(ctx);
  await assertLocationAccess(ctx, data.locationId);
  const session = await AcademicSession.findOne({ _id: data.sessionId, tenantId: f.tenantId }).select('startDate endDate').lean<{ startDate: string; endDate: string }>();
  if (!session) throw AppError.notFound('Academic session not found.');
  if (!sessionMonths(session).includes(data.periodKey)) throw AppError.validation({ periodKey: 'This month is outside the academic session.' });
  const id = randomUUID();
  await BillingRun.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, sessionId: data.sessionId, locationId: data.locationId, classIds: data.classIds ?? [], periodKey: data.periodKey, issueDate: data.issueDate, dueDate: data.dueDate ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }]);
  await auditFinance(f, undefined, { action: 'billing_run.created', entityType: 'billing_run', entityId: id, after: { periodKey: data.periodKey, locationId: data.locationId } });
  return runDTO(await loadRun(f, id));
}

export async function listRuns(ctx: ServiceContext, query: { page: number; pageSize: number; sessionId?: string | undefined; state?: string | undefined }) {
  const f = await financeCtx(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.sessionId ? { sessionId: query.sessionId } : {}), ...(query.state ? { state: query.state } : {}) };
  const [rows, total] = await Promise.all([BillingRun.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<BillingRunDoc[]>(), BillingRun.countDocuments(filter)]);
  return { items: rows.map(runDTO), total, page: query.page, pageSize: query.pageSize };
}

export async function getRun(ctx: ServiceContext, id: string): Promise<BillingRunDTO> {
  const f = await financeCtx(ctx);
  const run = await loadRun(f, id);
  await assertLocationAccess(ctx, run.locationId);
  return runDTO(run);
}

const headline = (run: Pick<BillingRunDoc, 'counts' | 'totalPaise'>) =>
  `${run.counts.ready.toLocaleString('en-IN')} ready · ${run.counts.needsAttention.toLocaleString('en-IN')} need attention · ${formatMoney(run.totalPaise)}`;

interface Row {
  studentId: string;
  enrollmentId: string | null;
  classOfferingId: string | null;
  status: BillingRunRowDoc['status'];
  reasonCode: BillingReason | null;
  reasonText: string | null;
  totalPaise: number;
}

/** Builds one row per student. Nothing is written to a bill here: it is a preview. */
export async function validateRun(ctx: ServiceContext, id: string): Promise<BillingValidationDTO> {
  const f = await financeCtx(ctx);
  const run = await loadRun(f, id);
  await assertLocationAccess(ctx, run.locationId);
  if (run.state === 'ISSUED' || run.state === 'CANCELLED') throw new AppError('BILL_ALREADY_ISSUED', run.state === 'CANCELLED' ? 'This run was cancelled.' : undefined);
  const engine = await loadEngine(f, run.sessionId);
  const offerings = await ClassOffering.find({ tenantId: f.tenantId, sessionId: run.sessionId, locationId: run.locationId }).sort({ sequenceOrder: 1 }).lean<ClassOfferingDoc[]>();
  const wanted = run.classIds.length ? offerings.filter((o) => run.classIds.includes(o.classId)) : offerings;
  const offering = new Map(wanted.map((o) => [o._id, o]));
  const enrollments = await StudentEnrollment.find({ tenantId: f.tenantId, academicSessionId: run.sessionId, locationId: run.locationId, state: 'OPEN', classOfferingId: { $in: [...offering.keys()] } }).lean<StudentEnrollmentDoc[]>();
  const live = new Set((await Student.find({ tenantId: f.tenantId, _id: { $in: enrollments.map((e) => e.studentId) }, status: { $nin: EXITED_STUDENT_STATUSES } }).select('_id').lean<{ _id: string }[]>()).map((s) => s._id));
  const people = enrollments.filter((e) => live.has(e.studentId));
  const ids = people.map((e) => e.studentId);
  const [assignments, billed, awards, plans, period] = await Promise.all([
    StudentFeeAssignment.find({ tenantId: f.tenantId, sessionId: run.sessionId, locationId: run.locationId, state: 'OPEN' }).lean<StudentFeeAssignmentDoc[]>(),
    FeeDocument.find({ tenantId: f.tenantId, kind: 'BILL', periodKey: run.periodKey, sessionId: run.sessionId }).select('studentId').lean<{ studentId: string }[]>(),
    loadAwards(f, ids),
    publishedPlans(f, run.sessionId),
    periodFor(f, run.issueDate),
  ]);
  const assignment = new Map(assignments.map((a) => [a.studentId, a]));
  const alreadyBilled = new Set(billed.map((b) => b.studentId));
  const enrolled = new Set(ids);

  const rows: Row[] = people.map((e) => {
    const base = { studentId: e.studentId, enrollmentId: e._id, classOfferingId: e.classOfferingId, totalPaise: 0 };
    if (alreadyBilled.has(e.studentId)) return { ...base, status: 'SKIPPED', reasonCode: 'ALREADY_BILLED', reasonText: TEXT.ALREADY_BILLED! };
    if (!period || period.state !== 'OPEN') return { ...base, status: 'NEEDS_ATTENTION', reasonCode: 'PERIOD_CLOSED', reasonText: TEXT.PERIOD_CLOSED! };
    const a = assignment.get(e.studentId);
    if (!a) {
      const fit = planFor(plans, { studentId: e.studentId, locationId: e.locationId, classId: offering.get(e.classOfferingId)!.classId, type: studentTypeOf(e.enrollmentType) });
      const reason: BillingReason = fit.status === 'PLAN_CONFLICT' ? 'PLAN_CONFLICT' : 'NO_PLAN';
      return { ...base, status: 'NEEDS_ATTENTION', reasonCode: reason, reasonText: fit.status === 'READY' ? 'Not on a fee plan yet. Assign the plan first.' : TEXT[reason]! };
    }
    return judge(engine, run, e, a, awards.get(e.studentId) ?? []);
  });
  // A student who has a plan here but is no longer enrolled is shown too, so nobody is billed or forgotten silently.
  for (const a of assignments.filter((x) => !enrolled.has(x.studentId))) {
    rows.push({ studentId: a.studentId, enrollmentId: null, classOfferingId: a.classOfferingId, status: 'NEEDS_ATTENTION', reasonCode: 'STUDENT_NOT_ENROLLED', reasonText: TEXT.STUDENT_NOT_ENROLLED!, totalPaise: 0 });
  }
  const labels = await studentLabels(f, rows.map((r) => r.studentId));
  rows.sort((a, b) => (offering.get(a.classOfferingId ?? '')?.sequenceOrder ?? 99) - (offering.get(b.classOfferingId ?? '')?.sequenceOrder ?? 99) || (labels.get(a.studentId)?.name ?? '').localeCompare(labels.get(b.studentId)?.name ?? ''));

  const counts = {
    ready: rows.filter((r) => r.status === 'READY').length, needsAttention: rows.filter((r) => r.status === 'NEEDS_ATTENTION').length, issued: 0, skipped: rows.filter((r) => r.status === 'SKIPPED').length,
  };
  const totalPaise = rows.filter((r) => r.status === 'READY').reduce((s, r) => s + r.totalPaise, 0);
  await withTransaction(async (db) => {
    await BillingRunRow.deleteMany({ tenantId: f.tenantId, runId: id }, { session: db });
    if (rows.length) await BillingRunRow.insertMany(rows.map((r, i) => ({ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, runId: id, rowNo: i + 1, ...r })), { session: db, ordered: true });
    await BillingRun.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { state: 'VALIDATED', counts, totalPaise, validatedAt: new Date(), checkpoint: null, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'billing_run.validated', entityType: 'billing_run', entityId: id, after: { ready: counts.ready, needsAttention: counts.needsAttention, totalPaise } });
  });
  const fresh = await loadRun(f, id);
  const byReason = [...rows.filter((r) => r.reasonCode && r.status === 'NEEDS_ATTENTION').reduce((m, r) => m.set(r.reasonCode!, (m.get(r.reasonCode!) ?? 0) + 1), new Map<BillingReason, number>())].map(([reasonCode, count]) => ({ reasonCode, count }));
  return { run: runDTO(fresh), headline: headline(fresh), byReason };
}

function judge(engine: Engine, run: BillingRunDoc, e: StudentEnrollmentDoc, a: StudentFeeAssignmentDoc, awards: StudentAward[]): Row {
  const base = { studentId: e.studentId, enrollmentId: e._id, classOfferingId: e.classOfferingId };
  const expired = awards.find((x) => x.award.validTo && !awardActiveOn(x.award, run.issueDate) && x.award.validTo < run.issueDate);
  if (expired) return { ...base, status: 'NEEDS_ATTENTION', reasonCode: 'AWARD_EXPIRED', reasonText: `${expired.policy.name} ran out on ${expired.award.validTo}. End it or renew it.`, totalPaise: 0 };
  const out = buildBill(engine, { studentId: e.studentId, assignment: a, locationId: e.locationId, periodKey: run.periodKey, issueDate: run.issueDate, dueOverride: run.dueDate, awards });
  if (out.ok) return { ...base, status: 'READY', reasonCode: null, reasonText: null, totalPaise: out.totals.totalPaise };
  if (out.reason === 'NOTHING_DUE') return { ...base, status: 'SKIPPED', reasonCode: 'NOTHING_DUE', reasonText: out.text, totalPaise: 0 };
  return { ...base, status: 'NEEDS_ATTENTION', reasonCode: out.reason, reasonText: out.text, totalPaise: 0 };
}

export async function listRows(ctx: ServiceContext, id: string, query: { page: number; pageSize: number; status?: string | undefined; reasonCode?: string | undefined }) {
  const f = await financeCtx(ctx);
  const run = await loadRun(f, id);
  await assertLocationAccess(ctx, run.locationId);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, runId: id, ...(query.status ? { status: query.status } : {}), ...(query.reasonCode ? { reasonCode: query.reasonCode } : {}) };
  const [rows, total] = await Promise.all([BillingRunRow.find(filter).sort({ rowNo: 1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<BillingRunRowDoc[]>(), BillingRunRow.countDocuments(filter)]);
  const labels = await studentLabels(f, rows.map((r) => r.studentId));
  const classes = new Map((await ClassOffering.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.classOfferingId).filter((x): x is string => !!x) } }).select('displayName').lean<{ _id: string; displayName: string }[]>()).map((c) => [c._id, c.displayName]));
  const items: BillingRowDTO[] = rows.map((r) => ({
    rowId: r._id, studentId: r.studentId, studentName: labels.get(r.studentId)?.name ?? 'Student', className: r.classOfferingId ? classes.get(r.classOfferingId) ?? null : null, status: r.status, reasonCode: r.reasonCode, reasonText: r.skipReason ?? r.reasonText,
    fixHint: r.reasonCode && r.status === 'NEEDS_ATTENTION' ? FIX[r.reasonCode] : null, totalPaise: r.totalPaise, documentId: r.documentId,
  }));
  return { items, total, page: query.page, pageSize: query.pageSize };
}

async function recount(f: FinanceCtx, runId: string) {
  const groups = await BillingRunRow.aggregate<{ _id: string; n: number; total: number }>([{ $match: { tenantId: f.tenantId, runId } }, { $group: { _id: '$status', n: { $sum: 1 }, total: { $sum: '$totalPaise' } } }]);
  const n = (s: string) => groups.find((g) => g._id === s)?.n ?? 0;
  await BillingRun.updateOne({ _id: runId, tenantId: f.tenantId }, { $set: { counts: { ready: n('READY'), needsAttention: n('NEEDS_ATTENTION'), issued: n('ISSUED'), skipped: n('SKIPPED') }, totalPaise: groups.find((g) => g._id === 'READY')?.total ?? 0 } });
}

/** Leaves one student out of this run, with a reason. The student stays on the list so nobody is forgotten. */
export async function skipRow(ctx: ServiceContext, runId: string, rowId: string, reason: string): Promise<BillingRowDTO> {
  const f = await financeCtx(ctx);
  const run = await loadRun(f, runId);
  await assertLocationAccess(ctx, run.locationId);
  if (run.state === 'ISSUED' || run.state === 'CANCELLED') throw new AppError('BILL_ALREADY_ISSUED');
  const row = await BillingRunRow.findOne({ _id: rowId, tenantId: f.tenantId, runId }).lean<BillingRunRowDoc>();
  if (!row) throw AppError.notFound('Row not found.');
  if (row.status === 'ISSUED') throw new AppError('BILL_ALREADY_ISSUED');
  await BillingRunRow.updateOne({ _id: rowId, tenantId: f.tenantId, status: { $ne: 'ISSUED' } }, { $set: { status: 'SKIPPED', skipReason: reason, totalPaise: 0 } });
  await recount(f, runId);
  await auditFinance(f, undefined, { action: 'billing_run.row_skipped', entityType: 'billing_run', entityId: runId, after: { studentId: row.studentId, reason } });
  return (await listRows(ctx, runId, { page: 1, pageSize: 100 })).items.find((r) => r.rowId === rowId)!;
}

export async function cancelRun(ctx: ServiceContext, runId: string): Promise<BillingRunDTO> {
  const f = await financeCtx(ctx);
  const run = await loadRun(f, runId);
  await assertLocationAccess(ctx, run.locationId);
  if (run.state === 'ISSUED' || run.counts.issued > 0) throw new AppError('BILL_ALREADY_ISSUED', 'Some bills from this run are already issued. Use credit notes to correct them.');
  await BillingRun.updateOne({ _id: runId, tenantId: f.tenantId }, { $set: { state: 'CANCELLED' } });
  await auditFinance(f, undefined, { action: 'billing_run.cancelled', entityType: 'billing_run', entityId: runId });
  return runDTO(await loadRun(f, runId));
}

export interface CommitOptions {
  /** Tests only: called after each bill is saved. Throwing here stands in for a crash. */
  afterRow?: (rowNo: number) => void;
}

/**
 * Issues every READY row. Safe to run again: rows already issued are skipped, a student who already has the month's bill is skipped,
 * and a crash half-way is continued from where the checkpoint stopped.
 */
export async function commitRun(ctx: ServiceContext, runId: string, data: CommitBillingRunData, idempotencyKey: string | undefined, options: CommitOptions = {}): Promise<BillingCommitDTO> {
  if (!idempotencyKey) throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
  const f = await financeCtx(ctx);
  let run = await loadRun(f, runId);
  await assertLocationAccess(ctx, run.locationId);
  if (run.state === 'CANCELLED' || run.state === 'DRAFT') throw new AppError('CONFLICT', run.state === 'DRAFT' ? 'Check the run before issuing it.' : 'This run was cancelled.');
  if (run.state === 'ISSUED') return { run: runDTO(run), issued: 0, failed: 0, alreadyIssued: run.counts.issued, totalPaise: await issuedTotal(f, runId) };

  if (run.state === 'VALIDATED') {
    if (data.confirmedReadyCount !== run.counts.ready || data.confirmedTotalPaise !== run.totalPaise) throw new AppError('PREVIEW_CHANGED', undefined, { ready: run.counts.ready, totalPaise: run.totalPaise });
    const res = await BillingRun.updateOne({ _id: runId, tenantId: f.tenantId, state: 'VALIDATED' }, { $set: { state: 'APPROVED', commitKey: idempotencyKey, updatedBy: ctx.userId } });
    if (res.modifiedCount === 1) await auditFinance(f, undefined, { action: 'billing_run.approved', entityType: 'billing_run', entityId: runId, after: { ready: run.counts.ready, totalPaise: run.totalPaise } });
    run = await loadRun(f, runId);
  }

  const engine = await loadEngine(f, run.sessionId);
  const roles = await rolesMap(f);
  const rows = await BillingRunRow.find({ tenantId: f.tenantId, runId, status: 'READY' }).sort({ rowNo: 1 }).lean<BillingRunRowDoc[]>();
  const assignments = new Map((await StudentFeeAssignment.find({ tenantId: f.tenantId, sessionId: run.sessionId, state: 'OPEN', studentId: { $in: rows.map((r) => r.studentId) } }).lean<StudentFeeAssignmentDoc[]>()).map((a) => [a.studentId, a]));
  const awards = await loadAwards(f, rows.map((r) => r.studentId));
  let issued = 0;
  let failed = 0;

  for (const row of rows) {
    const markFailed = async (status: 'NEEDS_ATTENTION' | 'SKIPPED', reasonCode: BillingReason, reasonText: string) => {
      await BillingRunRow.updateOne({ _id: row._id, tenantId: f.tenantId, status: 'READY' }, { $set: { status, reasonCode, reasonText, totalPaise: 0 } });
      if (status === 'NEEDS_ATTENTION') failed += 1;
    };
    const assignment = assignments.get(row.studentId);
    if (!assignment) {
      await markFailed('NEEDS_ATTENTION', 'NO_PLAN', TEXT.NO_PLAN!);
      continue;
    }
    const out = buildBill(engine, { studentId: row.studentId, assignment, locationId: run.locationId, periodKey: run.periodKey, issueDate: run.issueDate, dueOverride: run.dueDate, awards: awards.get(row.studentId) ?? [] });
    if (!out.ok) {
      await markFailed(out.reason === 'NOTHING_DUE' ? 'SKIPPED' : 'NEEDS_ATTENTION', out.reason, out.text);
      continue;
    }
    try {
      await withTransaction(async (db) => {
        if (await FeeDocument.exists({ tenantId: f.tenantId, studentId: row.studentId, kind: 'BILL', periodKey: run.periodKey }).session(db)) throw new AppError('BILL_ALREADY_ISSUED');
        const doc = await issueDocument(f, db, {
          kind: 'BILL', student: { studentId: row.studentId, enrollmentId: row.enrollmentId, locationId: run.locationId, sessionId: run.sessionId, classOfferingId: row.classOfferingId }, periodKey: run.periodKey, issueDate: run.issueDate,
          dueDate: out.dueDate, graceDays: out.graceDays, lines: out.lines, planVersionId: out.planVersionId, runId, parentDocumentId: null, journalKey: `bill:${row.studentId}:${run.periodKey}`, memo: `Fee bill for ${run.periodKey}`, correlationId: runId,
        }, roles);
        await BillingRunRow.updateOne({ _id: row._id, tenantId: f.tenantId, status: 'READY' }, { $set: { status: 'ISSUED', documentId: doc._id, totalPaise: doc.totalPaise } }, { session: db });
        await BillingRun.updateOne({ _id: runId, tenantId: f.tenantId }, { $inc: { 'counts.ready': -1, 'counts.issued': 1, totalPaise: -row.totalPaise }, $set: { checkpoint: { lastRowNo: row.rowNo, at: new Date() } } }, { session: db });
      });
      issued += 1;
    } catch (err) {
      if (err instanceof AppError && err.code === 'BILL_ALREADY_ISSUED') await markFailed('SKIPPED', 'ALREADY_BILLED', TEXT.ALREADY_BILLED!);
      else if (err instanceof AppError && err.code === 'PERIOD_CLOSED') await markFailed('NEEDS_ATTENTION', 'PERIOD_CLOSED', TEXT.PERIOD_CLOSED!);
      else if (duplicateKeyFields(err)) await markFailed('SKIPPED', 'ALREADY_BILLED', TEXT.ALREADY_BILLED!);
      else throw err;
    }
    options.afterRow?.(row.rowNo);
  }

  await recount(f, runId);
  const left = await BillingRunRow.countDocuments({ tenantId: f.tenantId, runId, status: 'READY' });
  if (left === 0) {
    await BillingRun.updateOne({ _id: runId, tenantId: f.tenantId }, { $set: { state: 'ISSUED', issuedAt: new Date() } });
    await auditFinance(f, undefined, { action: 'billing_run.issued', entityType: 'billing_run', entityId: runId, after: { issued, failed } });
  }
  const fresh = await loadRun(f, runId);
  return { run: runDTO(fresh), issued, failed, alreadyIssued: fresh.counts.issued - issued, totalPaise: await issuedTotal(f, runId) };
}

async function issuedTotal(f: FinanceCtx, runId: string): Promise<number> {
  const totals = await BillingRunRow.aggregate<{ total: number }>([{ $match: { tenantId: f.tenantId, runId, status: 'ISSUED' } }, { $group: { _id: null, total: { $sum: '$totalPaise' } } }]);
  return totals[0]?.total ?? 0;
}

export type { FeeDocumentDoc };
