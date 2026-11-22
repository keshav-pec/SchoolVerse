import { randomUUID } from 'node:crypto';
import type { CreateLateFeePolicyData, LateFeePolicyDTO, LateFeePreviewDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { addDays, daysBetween } from '../../../core/dates';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { rolesMap } from '../core/chart.service';
import { auditFinance, financeCtx, financeScope, scopeFilter, type FinanceCtx } from '../core/context';
import { TaxCode, type TaxCodeDoc } from '../core/models';
import { formatMoney, percentOf } from '../core/money';
import { studentLabels } from '../core/people';
import { issueDocument, isOverdue, priceLine } from './documents';
import { FeeDocument, FeeDocumentLine, FeeHead, LateFeePolicy, type FeeDocumentDoc, type FeeHeadDoc, type LateFeePolicyDoc } from './models';

/**
 * Late fees (FEE-07). Not a nightly job: the school presses "Late Fee Preview", reads what each overdue bill would get (with the sum
 * in words), and presses Apply. The key `latefee:<billId>:<period>` is unique, so the same late fee can never be made twice.
 * A late fee is waived with a credit note (a late-fee reversal), never by deleting it.
 */

const dto = (p: LateFeePolicyDoc): LateFeePolicyDTO => ({ policyId: p._id, feeHeadId: p.feeHeadId, kind: p.kind, period: p.period, value: p.value, graceDays: p.graceDays, capPaise: p.capPaise, status: p.status });

export async function listLateFeePolicies(ctx: ServiceContext): Promise<LateFeePolicyDTO[]> {
  const f = await financeCtx(ctx);
  return (await LateFeePolicy.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ createdAt: 1 }).lean<LateFeePolicyDoc[]>()).map(dto);
}

export async function createLateFeePolicy(ctx: ServiceContext, data: CreateLateFeePolicyData): Promise<LateFeePolicyDTO> {
  const f = await financeCtx(ctx);
  const head = await FeeHead.findOne({ _id: data.feeHeadId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<FeeHeadDoc>();
  if (!head) throw AppError.notFound('Fee head not found.');
  if (head.isRefundableDeposit) throw AppError.validation({ feeHeadId: 'A late fee cannot go to a refundable deposit head.' });
  if (data.kind === 'PERCENT' && data.value > 10_000) throw AppError.validation({ value: 'A percentage cannot be more than 100%.' });
  const id = randomUUID();
  await withTransaction(async (db) => {
    await LateFeePolicy.updateMany({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }, { $set: { status: 'INACTIVE' } }, { session: db });
    await LateFeePolicy.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, ...data, capPaise: data.capPaise ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'late_fee_policy.created', entityType: 'late_fee_policy', entityId: id, after: { kind: data.kind, period: data.period, value: data.value, graceDays: data.graceDays } });
  });
  return dto((await LateFeePolicy.findOne({ _id: id, tenantId: f.tenantId }).lean<LateFeePolicyDoc>())!);
}

export async function updateLateFeePolicy(ctx: ServiceContext, id: string, data: { value?: number | undefined; period?: 'ONCE' | 'PER_DAY' | 'PER_MONTH' | undefined; graceDays?: number | undefined; capPaise?: number | null | undefined; status?: 'ACTIVE' | 'INACTIVE' | undefined }): Promise<LateFeePolicyDTO> {
  const f = await financeCtx(ctx);
  const before = await LateFeePolicy.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<LateFeePolicyDoc>();
  if (!before) throw AppError.notFound('Late fee policy not found.');
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await withTransaction(async (db) => {
    if (data.status === 'ACTIVE') await LateFeePolicy.updateMany({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE', _id: { $ne: id } }, { $set: { status: 'INACTIVE' } }, { session: db });
    await LateFeePolicy.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'late_fee_policy.updated', entityType: 'late_fee_policy', entityId: id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])), after: patch });
  });
  return dto((await LateFeePolicy.findOne({ _id: id, tenantId: f.tenantId }).lean<LateFeePolicyDoc>())!);
}

interface Item {
  bill: FeeDocumentDoc;
  daysLate: number;
  feePaise: number;
  formula: string;
  periodKey: string;
  alreadyCharged: boolean;
}

/** How much late fee a bill owes today, and the sum written out. Charged earlier by this policy is taken off, so a fee is never counted twice. */
function lateFeeFor(policy: LateFeePolicyDoc, bill: FeeDocumentDoc, asOf: string, chargedBefore: number): Omit<Item, 'bill' | 'alreadyCharged'> | null {
  const due = new Date(`${bill.dueDate}T00:00:00Z`);
  due.setUTCDate(due.getUTCDate() + Math.max(bill.graceDays, policy.graceDays));
  const daysLate = daysBetween(due.toISOString().slice(0, 10), asOf);
  if (daysLate <= 0 || bill.balancePaise <= 0) return null;
  const unit = policy.period === 'ONCE' ? 1 : policy.period === 'PER_DAY' ? daysLate : Math.ceil(daysLate / 30);
  const each = policy.kind === 'FIXED' ? policy.value : percentOf(bill.balancePaise, policy.value);
  let total = each * unit;
  const parts = [policy.kind === 'FIXED' ? formatMoney(each) : `${Number((policy.value / 100).toFixed(2))}% of ${formatMoney(bill.balancePaise)} = ${formatMoney(each)}`];
  if (policy.period !== 'ONCE') parts.push(`× ${unit} ${policy.period === 'PER_DAY' ? 'day' : 'month'}${unit === 1 ? '' : 's'}`);
  if (policy.capPaise !== null && total > policy.capPaise) {
    total = policy.capPaise;
    parts.push(`(limited to ${formatMoney(policy.capPaise)})`);
  }
  const fee = Math.max(0, total - chargedBefore);
  const formula = `${parts.join(' ')} = ${formatMoney(total)}${chargedBefore > 0 ? ` − ${formatMoney(chargedBefore)} already charged = ${formatMoney(fee)}` : ''}`;
  return { daysLate, feePaise: fee, formula, periodKey: policy.period === 'ONCE' ? 'ONCE' : asOf.slice(0, 7) };
}

async function plan(f: FinanceCtx, ctx: ServiceContext, asOf: string, locationId: string | undefined) {
  const policy = await LateFeePolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).lean<LateFeePolicyDoc>();
  if (!policy) throw new AppError('FINANCE_NOT_READY', 'Set up a late fee rule first.');
  const scope = await financeScope(ctx);
  const bills = await FeeDocument.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: 'BILL', status: { $in: ['ISSUED', 'PARTIALLY_SETTLED'] }, balancePaise: { $gt: 0 }, ...scopeFilter(scope), ...(locationId ? { locationId } : {}) }).lean<FeeDocumentDoc[]>();
  const earlier = await FeeDocument.find({ tenantId: f.tenantId, kind: 'LATE_FEE', parentDocumentId: { $in: bills.map((b) => b._id) } }).select('parentDocumentId periodKey totalPaise status').lean<{ parentDocumentId: string; periodKey: string; totalPaise: number; status: string }[]>();
  const items: Item[] = [];
  for (const bill of bills) {
    if (!isOverdue({ ...bill, overdueAfter: addDays(bill.dueDate, Math.max(bill.graceDays, policy.graceDays)) }, asOf)) continue;
    const mine = earlier.filter((e) => e.parentDocumentId === bill._id);
    const charged = mine.reduce((s, e) => s + e.totalPaise, 0);
    const calc = lateFeeFor(policy, bill, asOf, charged);
    if (!calc || calc.feePaise <= 0) continue;
    items.push({ bill, ...calc, alreadyCharged: mine.some((e) => e.periodKey === calc.periodKey) });
  }
  return { policy, items };
}

export async function previewLateFees(ctx: ServiceContext, query: { asOf?: string | null | undefined; locationId?: string | undefined }): Promise<LateFeePreviewDTO> {
  const f = await financeCtx(ctx);
  const asOf = query.asOf ?? (await todayFor(ctx));
  const { items } = await plan(f, ctx, asOf, query.locationId);
  const labels = await studentLabels(f, items.map((i) => i.bill.studentId));
  return {
    asOf, count: items.filter((i) => !i.alreadyCharged).length, totalPaise: items.filter((i) => !i.alreadyCharged).reduce((s, i) => s + i.feePaise, 0),
    items: items.map((i) => ({ billId: i.bill._id, billNumber: i.bill.number, studentId: i.bill.studentId, studentName: labels.get(i.bill.studentId)?.name ?? 'Student', overduePaise: i.bill.balancePaise, daysLate: i.daysLate, feePaise: i.feePaise, formula: i.formula, alreadyCharged: i.alreadyCharged })),
  };
}

/** Makes a late-fee bill for each overdue bill. A bill that already got its fee for the period is skipped, so pressing Apply twice is safe. */
export async function commitLateFees(ctx: ServiceContext, query: { asOf?: string | null | undefined; locationId?: string | undefined }) {
  const f = await financeCtx(ctx);
  const asOf = query.asOf ?? (await todayFor(ctx));
  const { policy, items } = await plan(f, ctx, asOf, query.locationId);
  const head = (await FeeHead.findOne({ _id: policy.feeHeadId, tenantId: f.tenantId }).lean<FeeHeadDoc>())!;
  const taxCode = head.taxCodeId ? await TaxCode.findOne({ _id: head.taxCodeId, tenantId: f.tenantId }).lean<TaxCodeDoc>() : null;
  if (!taxCode) throw new AppError('TAX_CODE_MISSING', `${head.name} has no tax setting. Add a tax code to this fee head first.`);
  const roles = await rolesMap(f);
  let created = 0;
  let skipped = 0;
  for (const item of items) {
    if (item.alreadyCharged) {
      skipped += 1;
      continue;
    }
    const key = `latefee:${item.bill._id}:${item.periodKey}`;
    try {
      await withTransaction(async (db) => {
        if (await FeeDocumentLine.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, sourceKey: key }).session(db)) {
          skipped += 1;
          return;
        }
        const line = priceLine({ head, taxCode, basePaise: item.feePaise, discountPaise: 0, intraState: true, description: `Late fee on ${item.bill.number}`, periodKey: item.periodKey, feeItemId: null, sourceKey: key, explain: [item.formula], awardIds: [] });
        await issueDocument(f, db, { kind: 'LATE_FEE', student: { studentId: item.bill.studentId, enrollmentId: item.bill.enrollmentId, locationId: item.bill.locationId, sessionId: item.bill.sessionId, classOfferingId: item.bill.classOfferingId }, periodKey: item.periodKey, issueDate: asOf, dueDate: asOf, graceDays: 0, lines: [line], planVersionId: item.bill.planVersionId, runId: null, parentDocumentId: item.bill._id, journalKey: key, memo: `Late fee on ${item.bill.number}`, correlationId: ctx.requestId }, roles);
        created += 1;
      });
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'PERIOD_CLOSED') throw err;
      skipped += 1;
    }
  }
  return { created, skipped };
}
