import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { EXITED_STUDENT_STATUSES, type AwardConcessionData, type ConcessionAwardDTO, type ConcessionPolicyDTO, type ConcessionSuggestionDTO, type CreateConcessionPolicyData } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { Employee, LIVE_EMPLOYEE_STATUSES } from '../../staff/employee.model';
import { todayFor } from '../../staff/status';
import { Student, StudentAdmission, StudentEnrollment, StudentGuardianLink, type StudentGuardianLinkDoc } from '../../students/student.models';
import { AcademicSession } from '../../academic/session.model';
import { ApprovalPolicy, type ApprovalPolicyDoc } from '../core/models';
import { auditFinance, financeCtx, type FinanceCtx } from '../core/context';
import { studentLabels } from '../core/people';
import { calculateTax } from '../tax/tax';
import { applyCreditNote } from './adjustment.service';
import { computeDiscount, type AppliedAward } from './discount';
import { awardActiveOn, loadAwards } from './engine';
import { ConcessionAward, ConcessionPolicy, FeeDocument, FeeDocumentLine, type ConcessionAwardDoc, type ConcessionPolicyDoc, type FeeDocumentDoc, type FeeDocumentLineDoc } from './models';

/**
 * Concessions (FEE-05, 06). A concession is a discount, never a payment. Before billing it lowers the fee on the bill. After billing
 * it becomes a credit note on the bills that were already issued. A policy says what it covers, how awards combine, its cap, its dates
 * and whether evidence or approval is needed.
 */

const policyDTO = (p: ConcessionPolicyDoc): ConcessionPolicyDTO => ({
  policyId: p._id, name: p.name, type: p.type, valueType: p.valueType, value: p.value, feeHeadIds: p.feeHeadIds, stackMode: p.stackMode, capPercentBps: p.capPercentBps, validFrom: p.validFrom, validTo: p.validTo,
  needsEvidence: p.needsEvidence, needsApproval: p.needsApproval, status: p.status,
});

export async function listPolicies(ctx: ServiceContext): Promise<ConcessionPolicyDTO[]> {
  const f = await financeCtx(ctx);
  return (await ConcessionPolicy.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ createdAt: 1 }).lean<ConcessionPolicyDoc[]>()).map(policyDTO);
}

export async function createPolicy(ctx: ServiceContext, data: CreateConcessionPolicyData): Promise<ConcessionPolicyDTO> {
  const f = await financeCtx(ctx);
  const id = randomUUID();
  await withTransaction(async (db) => {
    await ConcessionPolicy.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, ...data, capPercentBps: data.capPercentBps ?? null, validFrom: data.validFrom ?? null, validTo: data.validTo ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'concession_policy.created', entityType: 'concession_policy', entityId: id, after: { name: data.name, type: data.type, valueType: data.valueType, value: data.value } });
  });
  return policyDTO((await ConcessionPolicy.findOne({ _id: id, tenantId: f.tenantId }).lean<ConcessionPolicyDoc>())!);
}

export async function updatePolicy(ctx: ServiceContext, id: string, data: Partial<Omit<CreateConcessionPolicyData, 'type' | 'valueType'>> & { status?: 'ACTIVE' | 'INACTIVE' | undefined }): Promise<ConcessionPolicyDTO> {
  const f = await financeCtx(ctx);
  const before = await ConcessionPolicy.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ConcessionPolicyDoc>();
  if (!before) throw AppError.notFound('Concession policy not found.');
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await withTransaction(async (db) => {
    await ConcessionPolicy.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'concession_policy.updated', entityType: 'concession_policy', entityId: id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])), after: patch });
  });
  return policyDTO((await ConcessionPolicy.findOne({ _id: id, tenantId: f.tenantId }).lean<ConcessionPolicyDoc>())!);
}

// ───────────────────────────────────────────────────────────── suggestions: siblings and staff children

async function activeLinks(f: FinanceCtx, today: string, filter: Record<string, unknown>, db?: ClientSession) {
  return StudentGuardianLink.find({ tenantId: f.tenantId, cancelledAt: null, effectiveFrom: { $lte: today }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }], ...filter }).session(db ?? null).lean<StudentGuardianLinkDoc[]>();
}

/**
 * Siblings are other active students who share a guardian (Module 4 links). The earliest admitted child keeps the full fee and every
 * younger sibling is suggested. A staff child is a student whose guardian is also a current employee (the same person record in Module 3).
 */
export async function recommendConcessions(ctx: ServiceContext, query: { studentId?: string | undefined; classOfferingId?: string | undefined; sessionId?: string | undefined }): Promise<ConcessionSuggestionDTO[]> {
  const f = await financeCtx(ctx);
  const today = await todayFor(ctx);
  let scopeIds: string[];
  if (query.studentId) scopeIds = [query.studentId];
  else {
    const sessionId = query.sessionId ?? (await AcademicSession.findOne({ tenantId: f.tenantId, status: 'ACTIVE' }).select('_id').lean<{ _id: string }>())?._id;
    if (!sessionId) return [];
    scopeIds = (await StudentEnrollment.find({ tenantId: f.tenantId, academicSessionId: sessionId, state: 'OPEN', ...(query.classOfferingId ? { classOfferingId: query.classOfferingId } : {}) }).select('studentId').lean<{ studentId: string }[]>()).map((e) => e.studentId);
  }
  const policies = await ConcessionPolicy.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE', type: { $in: ['SIBLING', 'STAFF_CHILD'] } }).lean<ConcessionPolicyDoc[]>();
  const siblingPolicy = policies.find((p) => p.type === 'SIBLING');
  const staffPolicy = policies.find((p) => p.type === 'STAFF_CHILD');
  const live = new Set((await Student.find({ tenantId: f.tenantId, status: { $nin: EXITED_STUDENT_STATUSES } }).select('_id').lean<{ _id: string }[]>()).map((s) => s._id));
  const myLinks = await activeLinks(f, today, { studentId: { $in: scopeIds } });
  const guardians = [...new Set(myLinks.map((l) => l.guardianPersonId))];
  const familyLinks = (await activeLinks(f, today, { guardianPersonId: { $in: guardians } })).filter((l) => live.has(l.studentId));

  const familyIds = [...new Set(familyLinks.map((l) => l.studentId))];
  const added = new Map((await Student.find({ tenantId: f.tenantId, _id: { $in: familyIds } }).select('createdAt').lean<{ _id: string; createdAt: Date }[]>()).map((s) => [s._id, new Date(s.createdAt).toISOString()]));
  // The earliest admission date comes first; the day the record was made breaks a tie between two children admitted on one day.
  const admitted = new Map((await StudentAdmission.find({ tenantId: f.tenantId, studentId: { $in: familyIds }, isCurrent: true }).select('studentId admissionDate').lean<{ studentId: string; admissionDate: string }[]>()).map((a) => [a.studentId, `${a.admissionDate}|${added.get(a.studentId) ?? ''}`]));
  const labels = await studentLabels(f, [...new Set(familyLinks.map((l) => l.studentId))]);
  const staffPersons = new Set((await Employee.find({ tenantId: f.tenantId, personId: { $in: guardians }, status: { $in: LIVE_EMPLOYEE_STATUSES } }).select('personId').lean<{ personId: string }[]>()).map((e) => e.personId));
  const existing = await ConcessionAward.find({ tenantId: f.tenantId, studentId: { $in: scopeIds }, status: { $in: ['DRAFT', 'PENDING', 'APPROVED'] } }).select('studentId policyId').lean<{ studentId: string; policyId: string }[]>();
  const has = (studentId: string, policyId: string) => existing.some((e) => e.studentId === studentId && e.policyId === policyId);

  const out: ConcessionSuggestionDTO[] = [];
  if (siblingPolicy) {
    const byGuardian = new Map<string, Set<string>>();
    for (const l of familyLinks) byGuardian.set(l.guardianPersonId, (byGuardian.get(l.guardianPersonId) ?? new Set()).add(l.studentId));
    const flagged = new Map<string, string>();
    for (const kids of byGuardian.values()) {
      if (kids.size < 2) continue;
      const ordered = [...kids].sort((a, b) => (admitted.get(a) ?? '9999').localeCompare(admitted.get(b) ?? '9999') || a.localeCompare(b));
      for (const younger of ordered.slice(1)) flagged.set(younger, labels.get(ordered[0]!)?.name ?? 'a brother or sister');
    }
    for (const studentId of scopeIds) {
      if (!flagged.has(studentId)) continue;
      out.push({ studentId, studentName: labels.get(studentId)?.name ?? 'Student', type: 'SIBLING', policyId: siblingPolicy._id, policyName: siblingPolicy.name, reason: `Brother or sister of ${flagged.get(studentId)}.`, alreadyAwarded: has(studentId, siblingPolicy._id) });
    }
  }
  if (staffPolicy) {
    for (const l of myLinks) {
      if (!staffPersons.has(l.guardianPersonId) || out.some((o) => o.type === 'STAFF_CHILD' && o.studentId === l.studentId)) continue;
      out.push({ studentId: l.studentId, studentName: labels.get(l.studentId)?.name ?? 'Student', type: 'STAFF_CHILD', policyId: staffPolicy._id, policyName: staffPolicy.name, reason: 'A parent works at the school.', alreadyAwarded: has(l.studentId, staffPolicy._id) });
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────── awards

async function toAwardDTOs(f: FinanceCtx, rows: ConcessionAwardDoc[]): Promise<ConcessionAwardDTO[]> {
  const labels = await studentLabels(f, rows.map((r) => r.studentId));
  const policies = new Map((await ConcessionPolicy.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.policyId) } }).lean<ConcessionPolicyDoc[]>()).map((p) => [p._id, p]));
  return rows.map((a) => {
    const p = policies.get(a.policyId)!;
    return { awardId: a._id, studentId: a.studentId, studentName: labels.get(a.studentId)?.name ?? 'Student', policyId: a.policyId, policyName: p.name, type: p.type, valueType: p.valueType, value: a.value, status: a.status, reason: a.reason, validFrom: a.validFrom, validTo: a.validTo, evidenceFileId: a.evidenceFileId, decidedBy: a.decidedBy };
  });
}

export async function listAwards(ctx: ServiceContext, query: { page: number; pageSize: number; status?: string | undefined; studentId?: string | undefined }) {
  const f = await financeCtx(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.status ? { status: query.status } : {}), ...(query.studentId ? { studentId: query.studentId } : {}) };
  const [rows, total] = await Promise.all([ConcessionAward.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<ConcessionAwardDoc[]>(), ConcessionAward.countDocuments(filter)]);
  return { items: await toAwardDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

const needsApproval = (policy: ConcessionPolicyDoc, value: number) => policy.needsApproval || value > policy.value || (policy.valueType === 'PERCENT' && policy.capPercentBps !== null && value > policy.capPercentBps);

async function createAward(f: FinanceCtx, ctx: ServiceContext, data: AwardConcessionData): Promise<string> {
  const [policy, student] = await Promise.all([
    ConcessionPolicy.findOne({ _id: data.policyId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ConcessionPolicyDoc>(),
    Student.exists({ _id: data.studentId, tenantId: f.tenantId }),
  ]);
  if (!policy || policy.status !== 'ACTIVE') throw AppError.notFound('Concession policy not found.');
  if (!student) throw AppError.notFound('Student not found.');
  if (policy.needsEvidence && !data.evidenceFileId) throw AppError.validation({ evidenceFileId: 'This concession needs a document as proof. Upload one first.' });
  if (await ConcessionAward.exists({ tenantId: f.tenantId, studentId: data.studentId, policyId: data.policyId, status: { $in: ['DRAFT', 'PENDING', 'APPROVED'] } })) throw new AppError('CONFLICT', 'This student already has this concession.');
  const value = data.value ?? policy.value;
  const pending = needsApproval(policy, value);
  const id = randomUUID();
  await withTransaction(async (db) => {
    await ConcessionAward.create(
      [{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, studentId: data.studentId, policyId: data.policyId, value, status: pending ? 'PENDING' : 'APPROVED', reason: data.reason ?? null, validFrom: data.validFrom ?? policy.validFrom, validTo: data.validTo ?? policy.validTo, evidenceFileId: data.evidenceFileId ?? null, requestedBy: ctx.userId, decidedBy: pending ? null : ctx.userId, decidedAt: pending ? null : new Date(), createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    await auditFinance(f, db, { action: pending ? 'concession.requested' : 'concession.awarded', entityType: 'concession_award', entityId: id, after: { studentId: data.studentId, policyId: data.policyId, value, status: pending ? 'PENDING' : 'APPROVED' } });
    if (!pending) await creditExistingBills(f, db, (await ConcessionAward.findOne({ _id: id, tenantId: f.tenantId }).session(db).lean<ConcessionAwardDoc>())!, policy, await todayFor(ctx, db));
  });
  return id;
}

export async function awardConcession(ctx: ServiceContext, data: AwardConcessionData): Promise<ConcessionAwardDTO> {
  const f = await financeCtx(ctx);
  const id = await createAward(f, ctx, data);
  return (await toAwardDTOs(f, [(await ConcessionAward.findOne({ _id: id, tenantId: f.tenantId }).lean<ConcessionAwardDoc>())!]))[0]!;
}

/** "Award All Suggested": each one is its own award, so one that cannot be made never stops the rest. */
export async function awardMany(ctx: ServiceContext, awards: { studentId: string; policyId: string }[]) {
  const f = await financeCtx(ctx);
  const done: ConcessionAwardDTO[] = [];
  const skipped: { studentId: string; message: string }[] = [];
  for (const a of awards) {
    try {
      const id = await createAward(f, ctx, a);
      done.push((await toAwardDTOs(f, [(await ConcessionAward.findOne({ _id: id, tenantId: f.tenantId }).lean<ConcessionAwardDoc>())!]))[0]!);
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push({ studentId: a.studentId, message: err.message });
    }
  }
  return { done, skipped };
}

export async function decideAward(ctx: ServiceContext, awardId: string, action: 'approve' | 'reject' | 'end', reason: string | null | undefined): Promise<ConcessionAwardDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const award = await ConcessionAward.findOne({ _id: awardId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<ConcessionAwardDoc>();
    if (!award) throw AppError.notFound('Concession not found.');
    const policy = (await ConcessionPolicy.findOne({ _id: award.policyId, tenantId: f.tenantId }).session(db).lean<ConcessionPolicyDoc>())!;
    const today = await todayFor(ctx, db);
    if (action === 'end') {
      if (award.status !== 'APPROVED') throw new AppError('CONFLICT', 'Only a running concession can be ended.');
      await ConcessionAward.updateOne({ _id: awardId, tenantId: f.tenantId, status: 'APPROVED' }, { $set: { status: 'ENDED', validTo: award.validTo && award.validTo < today ? award.validTo : today, decisionReason: reason ?? null, updatedBy: ctx.userId } }, { session: db });
      await auditFinance(f, db, { action: 'concession.ended', entityType: 'concession_award', entityId: awardId, before: { status: 'APPROVED' }, after: { status: 'ENDED' }, metadata: { reason: reason ?? null } });
      return;
    }
    if (award.status !== 'PENDING') throw new AppError('CONFLICT', 'This concession was already decided.');
    if (!can(ctx, 'finance:concession:approve')) throw new AppError('FORBIDDEN', undefined, { required: ['finance:concession:approve'] });
    const rule = await ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'CONCESSION' }).session(db).lean<ApprovalPolicyDoc>();
    if (action === 'approve' && award.requestedBy === ctx.userId && (rule?.needsDifferentApprover ?? true)) throw new AppError('SELF_APPROVAL_BLOCKED');
    const status = action === 'approve' ? 'APPROVED' : 'REJECTED';
    const res = await ConcessionAward.updateOne({ _id: awardId, tenantId: f.tenantId, status: 'PENDING' }, { $set: { status, decidedBy: ctx.userId, decidedAt: new Date(), decisionReason: reason ?? null, updatedBy: ctx.userId } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This concession was already decided.');
    await auditFinance(f, db, { action: `concession.${action}d`, entityType: 'concession_award', entityId: awardId, before: { status: 'PENDING' }, after: { status }, metadata: { reason: reason ?? null } });
    if (status === 'APPROVED') await creditExistingBills(f, db, { ...award, status: 'APPROVED' }, policy, today);
  });
  return (await toAwardDTOs(f, [(await ConcessionAward.findOne({ _id: awardId, tenantId: f.tenantId }).lean<ConcessionAwardDoc>())!]))[0]!;
}

/**
 * A concession approved after bills went out never edits a bill. For each running bill whose date is inside the concession's dates,
 * it works out the discount the line would have had, and issues one credit note for the difference (with the tax taken back too).
 */
async function creditExistingBills(f: FinanceCtx, db: ClientSession, award: ConcessionAwardDoc, policy: ConcessionPolicyDoc, today: string) {
  const bills = await FeeDocument.find({ tenantId: f.tenantId, studentId: award.studentId, kind: 'BILL', status: { $in: ['ISSUED', 'PARTIALLY_SETTLED'] } }).session(db).lean<FeeDocumentDoc[]>();
  const all = (await loadAwards(f, [award.studentId], db)).get(award.studentId) ?? [];
  const awards = all.some((a) => a.award._id === award._id) ? all : [...all, { award, policy }];
  for (const bill of bills.filter((b) => awardActiveOn(award, b.issueDate))) {
    const lines = await FeeDocumentLine.find({ tenantId: f.tenantId, documentId: bill._id }).session(db).lean<FeeDocumentLineDoc[]>();
    const earlier = await FeeDocumentLine.find({ tenantId: f.tenantId, originalLineId: { $in: lines.map((l) => l._id) } }).session(db).select('originalLineId totalPaise').lean<{ originalLineId: string; totalPaise: number }[]>();
    const alreadyCredited = (lineId: string) => earlier.filter((e) => e.originalLineId === lineId).reduce((sum, e) => sum + e.totalPaise, 0);
    const credits: { lineId: string; amountPaise: number }[] = [];
    for (const line of lines) {
      if (line.isDeposit) continue;
      const covered = awards.filter((a) => awardActiveOn(a.award, bill.issueDate) && (a.policy.feeHeadIds.length === 0 || a.policy.feeHeadIds.includes(line.feeHeadId)));
      if (!covered.some((a) => a.award._id === award._id)) continue;
      const applied: AppliedAward[] = covered.map((a) => ({ awardId: a.award._id, name: a.policy.name, type: a.policy.type, valueType: a.policy.valueType, value: a.award.value, stackMode: a.policy.stackMode, capPercentBps: a.policy.capPercentBps }));
      const next = computeDiscount(line.basePaise, applied);
      if (next.discountPaise <= line.discountPaise) continue;
      const priced = calculateTax({ amountPaise: line.basePaise - next.discountPaise, priceMode: line.priceMode, rateBps: line.rateBps, intraState: line.igstPaise === 0 });
      const credit = line.totalPaise - priced.totalPaise - alreadyCredited(line._id);
      if (credit > 0) credits.push({ lineId: line._id, amountPaise: credit });
    }
    if (credits.length > 0) await applyCreditNote(f, db, { doc: bill, type: 'CREDIT_NOTE', lines: credits, reason: `Concession "${policy.name}" approved after billing`, issueDate: today });
  }
}
