import type { ClientSession } from 'mongoose';
import type { BillingReason } from '@shared';
import { AcademicSession, AcademicTerm } from '../../academic/session.model';
import { AppError } from '../../../core/errors';
import { monthRange, type FinanceCtx } from '../core/context';
import { TaxCode, type TaxCodeDoc } from '../core/models';
import { formatMoney } from '../core/money';
import { priceLine, sumLines, type BuiltLine } from './documents';
import { computeDiscount, type AppliedAward } from './discount';
import { ConcessionAward, ConcessionPolicy, FeeHead, FeePlan, FeePlanItem, FeePlanVersion, type ConcessionAwardDoc, type ConcessionPolicyDoc, type FeeHeadDoc, type FeePlanItemDoc, type FeePlanVersionDoc, type StudentFeeAssignmentDoc } from './models';
import { billingPeriods, dueDateFor, periodSpan, prorate, type SessionDates, type TermDates } from './schedule';

/**
 * The billing engine. It turns "this student, on this plan, for this month" into priced lines. It reads only what it was given
 * (loaded once per run), so a preview, a bill and "expected later" are always the same calculation.
 */
export interface Engine {
  f: FinanceCtx;
  sessionId: string;
  session: SessionDates;
  terms: TermDates[];
  heads: Map<string, FeeHeadDoc>;
  taxCodes: Map<string, TaxCodeDoc>;
  /** Published and superseded versions of each plan, newest start date first. */
  versionsByPlan: Map<string, FeePlanVersionDoc[]>;
  planOfVersion: Map<string, string>;
  itemsByVersion: Map<string, FeePlanItemDoc[]>;
  /** The school is in one state, and student bills are always inside it. */
  intraState: boolean;
}

export async function loadEngine(f: FinanceCtx, sessionId: string, db?: ClientSession): Promise<Engine> {
  const session = await AcademicSession.findOne({ _id: sessionId, tenantId: f.tenantId }).session(db ?? null).select('startDate endDate').lean<SessionDates>();
  if (!session) throw AppError.notFound('Academic session not found.');
  const plans = await FeePlan.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, sessionId }).session(db ?? null).select('_id').lean<{ _id: string }[]>();
  const [terms, heads, taxCodes, versions] = await Promise.all([
    AcademicTerm.find({ tenantId: f.tenantId, sessionId }).session(db ?? null).select('startDate endDate locationId').lean<TermDates[]>(),
    FeeHead.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<FeeHeadDoc[]>(),
    TaxCode.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<TaxCodeDoc[]>(),
    FeePlanVersion.find({ tenantId: f.tenantId, planId: { $in: plans.map((p) => p._id) }, state: { $in: ['PUBLISHED', 'SUPERSEDED'] } }).session(db ?? null).sort({ effectiveFrom: -1, versionNo: -1 }).lean<FeePlanVersionDoc[]>(),
  ]);
  const items = await FeePlanItem.find({ tenantId: f.tenantId, versionId: { $in: versions.map((v) => v._id) } }).session(db ?? null).sort({ sortOrder: 1 }).lean<FeePlanItemDoc[]>();
  const versionsByPlan = new Map<string, FeePlanVersionDoc[]>();
  for (const v of versions) versionsByPlan.set(v.planId, [...(versionsByPlan.get(v.planId) ?? []), v]);
  const itemsByVersion = new Map<string, FeePlanItemDoc[]>();
  for (const i of items) itemsByVersion.set(i.versionId, [...(itemsByVersion.get(i.versionId) ?? []), i]);
  return {
    f, sessionId, session, terms, heads: new Map(heads.map((h) => [h._id, h])), taxCodes: new Map(taxCodes.map((t) => [t._id, t])), versionsByPlan,
    planOfVersion: new Map(versions.map((v) => [v._id, v.planId])), itemsByVersion, intraState: true,
  };
}

/** The version of the student's plan that is in force for a month: the newest one that started on or before the month's last day. */
export function versionForPeriod(engine: Engine, assignedVersionId: string, periodKey: string): FeePlanVersionDoc | null {
  const planId = engine.planOfVersion.get(assignedVersionId);
  if (!planId) return null;
  const end = monthRange(periodKey).end;
  return (engine.versionsByPlan.get(planId) ?? []).find((v) => v.effectiveFrom <= end) ?? null;
}

export interface StudentAward {
  award: ConcessionAwardDoc;
  policy: ConcessionPolicyDoc;
}

/** Approved awards of each student. An award that has ended (`ENDED`) or was never approved is not here. */
export async function loadAwards(f: FinanceCtx, studentIds: string[], db?: ClientSession): Promise<Map<string, StudentAward[]>> {
  const out = new Map<string, StudentAward[]>();
  if (studentIds.length === 0) return out;
  const awards = await ConcessionAward.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentId: { $in: studentIds }, status: 'APPROVED' }).session(db ?? null).lean<ConcessionAwardDoc[]>();
  const policies = new Map((await ConcessionPolicy.find({ tenantId: f.tenantId, _id: { $in: [...new Set(awards.map((a) => a.policyId))] } }).session(db ?? null).lean<ConcessionPolicyDoc[]>()).map((p) => [p._id, p]));
  for (const award of awards) {
    const policy = policies.get(award.policyId);
    if (!policy) continue;
    out.set(award.studentId, [...(out.get(award.studentId) ?? []), { award, policy }]);
  }
  return out;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const monthLabel = (periodKey: string) => `${MONTH_NAMES[Number(periodKey.slice(5, 7)) - 1]} ${periodKey.slice(0, 4)}`;

export interface BillInput {
  studentId: string;
  assignment: Pick<StudentFeeAssignmentDoc, 'planVersionId' | 'optionalItemIds' | 'effectiveFrom' | 'effectiveTo'>;
  locationId: string;
  periodKey: string;
  issueDate: string;
  dueOverride: string | null;
  awards: StudentAward[];
}

export type BillOutcome =
  | { ok: true; lines: BuiltLine[]; dueDate: string; graceDays: number; planVersionId: string; totals: ReturnType<typeof sumLines> }
  | { ok: false; reason: BillingReason; text: string; hint: string };

/** An award counts on `date` when it has started and has not run out. */
export const awardActiveOn = (a: Pick<ConcessionAwardDoc, 'validFrom' | 'validTo'>, date: string) => (!a.validFrom || a.validFrom <= date) && (!a.validTo || a.validTo >= date);

export function buildBill(engine: Engine, input: BillInput): BillOutcome {
  const version = versionForPeriod(engine, input.assignment.planVersionId, input.periodKey);
  if (!version) return { ok: false, reason: 'NO_PLAN', text: 'No fee plan is in force for this month.', hint: 'Choose Plan' };
  const items = engine.itemsByVersion.get(version._id) ?? [];
  // Optional items were ticked on the version the student was assigned to; match them to this version by fee head.
  const assignedItems = engine.itemsByVersion.get(input.assignment.planVersionId) ?? items;
  const optionalHeads = new Set(assignedItems.filter((i) => input.assignment.optionalItemIds.includes(i._id)).map((i) => i.feeHeadId));

  const lines: BuiltLine[] = [];
  const dueDates: { date: string; grace: number }[] = [];
  for (const item of items) {
    if (item.isOptional && !optionalHeads.has(item.feeHeadId)) continue;
    const periods = billingPeriods(item.frequency, engine.session, engine.terms, input.locationId);
    if (!periods.includes(input.periodKey)) continue;
    const head = engine.heads.get(item.feeHeadId);
    if (!head) continue;
    const taxCode = head.taxCodeId ? engine.taxCodes.get(head.taxCodeId) ?? null : null;
    if (!head.isRefundableDeposit && !taxCode) return { ok: false, reason: 'TAX_CODE_MISSING', text: `${head.name} has no tax setting.`, hint: 'Add Tax Code' };
    const span = periodSpan(periods, input.periodKey, engine.session);
    const share = prorate(item.amountPaise, item.prorationMethod, span, { from: input.assignment.effectiveFrom, to: input.assignment.effectiveTo });
    if (share.amountPaise === null || share.amountPaise === 0) continue;
    const base = share.amountPaise;
    const applicable: AppliedAward[] = head.isRefundableDeposit
      ? []
      : input.awards
          .filter((a) => awardActiveOn(a.award, input.issueDate) && (a.policy.feeHeadIds.length === 0 || a.policy.feeHeadIds.includes(head._id)))
          .map((a) => ({ awardId: a.award._id, name: a.policy.name, type: a.policy.type, valueType: a.policy.valueType, value: a.award.value, stackMode: a.policy.stackMode, capPercentBps: a.policy.capPercentBps }));
    const discount = computeDiscount(base, applicable);
    const explain = [share.prorated ? share.explanation : '', discount.discountPaise > 0 ? `${formatMoney(base)} − ${discount.explanation}` : ''].filter(Boolean);
    const recurring = item.frequency !== 'ONE_TIME' && item.frequency !== 'YEARLY';
    lines.push(
      priceLine({
        head, taxCode, basePaise: base, discountPaise: discount.discountPaise, intraState: engine.intraState, periodKey: input.periodKey, feeItemId: item._id,
        description: recurring ? `${head.name} (${monthLabel(input.periodKey)})` : head.name, sourceKey: `bill:${input.studentId}:${item._id}:${input.periodKey}`, explain, awardIds: discount.awardIds,
      }),
    );
    dueDates.push({ date: dueDateFor(input.periodKey, item.dueDay), grace: item.graceDays });
  }
  if (lines.length === 0) return { ok: false, reason: 'NOTHING_DUE', text: 'Nothing falls due for this student this month.', hint: 'Skip' };
  const earliest = dueDates.reduce((a, b) => (b.date < a.date ? b : a));
  return {
    ok: true, lines, dueDate: input.dueOverride ?? earliest.date, graceDays: Math.max(...dueDates.map((d) => d.grace)), planVersionId: version._id, totals: sumLines(lines),
  };
}
