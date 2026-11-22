import { randomUUID } from 'node:crypto';
import type { AccountDTO, FeeHeadDTO, FeePlanDTO } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassMaster } from '../academic/reference.model';
import { ClassOffering } from '../academic/offering.model';
import { AcademicSession } from '../academic/session.model';
import { StudentEnrollment } from '../students/student.models';
import { createBankAccount } from './core/bank.service';
import { listAccounts } from './core/chart.service';
import { financeCtx } from './core/context';
import { setAccess, createFinancialYear, updateTaxProfile } from './core/setup.service';
import { useStandardSetup } from './core/standard-setup.service';
import { AccessGrant, AccountingPeriod, ApprovalPolicy, ApprovalRequest, BankAccount, CashAccount, ChartAccount, FinanceAudit, FinanceCounter, FinancialYear, JournalEntry, JournalLine, LegalEntity, TaxCode } from './core/models';
import { listTaxCodes } from './tax/tax.service';
import { bulkAssign } from './fees/assignment.service';
import { commitRun, createRun, validateRun } from './fees/billing.service';
import { awardMany, createPolicy, recommendConcessions } from './fees/concession.service';
import { createLateFeePolicy } from './fees/latefee.service';
import { createFeeHead, createPlan, publishVersion } from './fees/plan.service';
import { BillingRun, BillingRunRow, ConcessionAward, ConcessionPolicy, FeeDocument, FeeDocumentLine, FeeHead, FeePlan, FeePlanItem, FeePlanVersion, FinancialAdjustment, LateFeePolicy, StudentFeeAssignment, StudentLedgerEntry } from './fees/models';

/** Every finance collection, so the demo reset can clear a tenant. Immutable ones go through the raw collection (the model refuses deletes). */
const FINANCE_MODELS = [
  LegalEntity, AccessGrant, FinancialYear, AccountingPeriod, ChartAccount, BankAccount, CashAccount, JournalEntry, JournalLine, ApprovalPolicy, ApprovalRequest, FinanceAudit, FinanceCounter, TaxCode,
  FeeHead, FeePlan, FeePlanVersion, FeePlanItem, StudentFeeAssignment, ConcessionPolicy, ConcessionAward, LateFeePolicy, BillingRun, BillingRunRow, FeeDocument, FeeDocumentLine, StudentLedgerEntry, FinancialAdjustment,
];
export async function wipeFinanceTenant(tenantId: string) {
  await Promise.all(FINANCE_MODELS.map((m) => m.collection.deleteMany({ tenantId })));
}

/**
 * Demo finance for Greenfield: the standard setup, the GST profile, FY 2026-27, a State Bank account (••••1234), the fee types and the
 * Class VIII plan (Tuition ₹4,000 a month, Annual ₹8,000 a year, Computer ₹1,500 a quarter, Exam ₹2,000 a term), a sibling concession,
 * a late-fee rule, an Accountant and an Approver. Deliberate exceptions for the demo: students in other classes have no plan, one
 * student matches two plans, and one student's plan uses a fee head that has no tax code. Tax values are EXAMPLES.
 */
export async function seedFinanceDemo(ctx: ServiceContext, input: { mohaliId: string; userIdsByEmail: Record<string, string> }) {
  await useStandardSetup(ctx);
  await updateTaxProfile(ctx, { gstRegistered: true, gstin: '03AAAAA0000A1Z5' });
  await createFinancialYear(ctx, { code: '2026-27' });
  await createBankAccount(ctx, { label: 'Fees account (State Bank)', bankName: 'State Bank of India', holderName: 'Greenfield Public School Trust', accountNumber: '300012341234', ifsc: 'SBIN0001234', purpose: 'FEES', locationIds: [input.mohaliId] });

  const f = await financeCtx(ctx);
  const accounts = Object.fromEntries((await listAccounts(ctx)).map((a: AccountDTO) => [a.code, a.accountId]));
  const tax = Object.fromEntries((await listTaxCodes(ctx)).map((c) => [c.code, c.taxCodeId]));
  const head = (body: Parameters<typeof createFeeHead>[1]) => createFeeHead(ctx, body);
  const base = { isRecurring: false, isOptional: false, isRefundableDeposit: false, priceMode: 'EXCLUSIVE' as const, category: 'OTHER' as const };
  const heads: Record<string, FeeHeadDTO> = {
    tuition: await head({ ...base, code: 'TUITION', name: 'Tuition Fee', category: 'TUITION', incomeAccountId: accounts['4100']!, taxCodeId: tax.EXEMPT_EDU!, isRecurring: true }),
    annual: await head({ ...base, code: 'ANNUAL', name: 'Annual Charges', category: 'ANNUAL', incomeAccountId: accounts['4300']!, taxCodeId: tax.EXEMPT_EDU! }),
    computer: await head({ ...base, code: 'COMPUTER', name: 'Computer Fee', incomeAccountId: accounts['4600']!, taxCodeId: tax.EXEMPT_EDU!, isRecurring: true }),
    exam: await head({ ...base, code: 'EXAM', name: 'Examination Fee', category: 'EXAM', incomeAccountId: accounts['4500']!, taxCodeId: tax.EXEMPT_EDU!, isRecurring: true }),
    transport: await head({ ...base, code: 'TRANSPORT', name: 'Transport Fee', category: 'TRANSPORT', incomeAccountId: accounts['4400']!, taxCodeId: tax.EXEMPT_EDU!, isRecurring: true, isOptional: true }),
    deposit: await head({ ...base, code: 'DEPOSIT', name: 'Security Deposit', category: 'DEPOSIT', incomeAccountId: accounts['2200']!, taxCodeId: null, isRefundableDeposit: true }),
    uniform: await head({ ...base, code: 'UNIFORM', name: 'Uniform', incomeAccountId: accounts['4600']!, taxCodeId: tax.GST_12!, isOptional: true }),
    lateFee: await head({ ...base, code: 'LATEFEE', name: 'Late Fee', category: 'LATE_FEE', incomeAccountId: accounts['4700']!, taxCodeId: tax.EXEMPT_EDU! }),
    sports: await head({ ...base, code: 'SPORTS', name: 'Sports Fee', incomeAccountId: accounts['4600']!, taxCodeId: tax.EXEMPT_EDU! }),
  };

  const session = await AcademicSession.findOne({ tenantId: ctx.tenantId, code: '2026-27' }).lean<{ _id: string }>();
  const class8 = await ClassMaster.findOne({ canonicalCode: 'G08' }).lean<{ _id: string }>();
  if (!session || !class8) return { students: 0 };
  const item = (h: FeeHeadDTO, rupees: number, frequency: 'ONE_TIME' | 'MONTHLY' | 'QUARTERLY' | 'TERM' | 'YEARLY', extra: Record<string, unknown> = {}) => ({ feeHeadId: h.feeHeadId, amountPaise: rupees * 100, frequency, dueDay: 10, graceDays: 0, prorationMethod: 'FULL_PERIOD' as const, isOptional: false, ...extra });
  const plan: FeePlanDTO = await createPlan(ctx, {
    name: 'Class VIII 2026-27', sessionId: session._id, appliesTo: { locationIds: [input.mohaliId], classIds: [class8._id], studentType: 'ALL', studentId: null }, autoAssign: true,
    items: [
      item(heads.tuition!, 4000, 'MONTHLY', { prorationMethod: 'CALENDAR_DAYS' }), item(heads.annual!, 8000, 'YEARLY'), item(heads.computer!, 1500, 'QUARTERLY'), item(heads.exam!, 2000, 'TERM'),
      item(heads.deposit!, 5000, 'ONE_TIME'), item(heads.transport!, 1200, 'MONTHLY', { isOptional: true }), item(heads.uniform!, 1500, 'ONE_TIME', { isOptional: true }),
    ],
  });
  await publishVersion(ctx, plan.latestVersion!.versionId);
  await bulkAssign(ctx, { sessionId: session._id, locationId: input.mohaliId });

  // ── the deliberate exceptions, written straight to the collections the way a half-finished setup would leave them
  const classIds = (await ClassOffering.find({ tenantId: ctx.tenantId, sessionId: session._id, locationId: input.mohaliId, classId: class8._id }).select('_id').lean<{ _id: string }[]>()).map((c) => c._id);
  const open = await StudentEnrollment.find({ tenantId: ctx.tenantId, academicSessionId: session._id, classOfferingId: { $in: classIds }, state: 'OPEN' }).sort({ _id: 1 }).lean<{ studentId: string }[]>();
  const clashing = open[2];
  const noTax = open[3];
  const noPlan = open[4];
  const ids = { schoolId: f.schoolId, legalEntityId: f.legalEntityId, tenantId: ctx.tenantId };
  const forcePlan = async (name: string, studentId: string, feeHeadId: string) => {
    const planId = randomUUID();
    const versionId = randomUUID();
    await FeePlan.create([{ _id: planId, ...ids, name, sessionId: session._id, appliesTo: { locationIds: [], classIds: [], studentType: 'ALL', studentId }, autoAssign: false }]);
    await FeePlanVersion.create([{ _id: versionId, ...ids, planId, versionNo: 1, effectiveFrom: '2026-04-01', state: 'PUBLISHED', publishedAt: new Date() }]);
    await FeePlanItem.create([{ ...ids, planId, versionId, feeHeadId, amountPaise: 100000, frequency: 'MONTHLY', dueDay: 10, graceDays: 0, prorationMethod: 'FULL_PERIOD', isOptional: false, sortOrder: 0 }]);
    return versionId;
  };
  if (clashing) {
    await StudentFeeAssignment.deleteOne({ tenantId: ctx.tenantId, studentId: clashing.studentId });
    await forcePlan('Scholar plan A', clashing.studentId, heads.tuition!.feeHeadId);
    await forcePlan('Scholar plan B', clashing.studentId, heads.tuition!.feeHeadId);
  }
  if (noPlan) await StudentFeeAssignment.deleteOne({ tenantId: ctx.tenantId, studentId: noPlan.studentId });
  if (noTax) {
    await StudentFeeAssignment.updateOne({ tenantId: ctx.tenantId, studentId: noTax.studentId }, { $set: { planVersionId: await forcePlan('Sports scholar', noTax.studentId, heads.sports!.feeHeadId) } });
    await FeeHead.updateOne({ _id: heads.sports!.feeHeadId, tenantId: ctx.tenantId }, { $set: { taxCodeId: null } });
  }

  // ── concessions and late fees
  const sibling = await createPolicy(ctx, { name: 'Sibling concession', type: 'SIBLING', valueType: 'PERCENT', value: 1000, feeHeadIds: [heads.tuition!.feeHeadId], stackMode: 'HIGHEST_WINS', capPercentBps: 5000, needsEvidence: false, needsApproval: false });
  await createPolicy(ctx, { name: 'Staff child concession', type: 'STAFF_CHILD', valueType: 'PERCENT', value: 5000, feeHeadIds: [heads.tuition!.feeHeadId], stackMode: 'HIGHEST_WINS', needsEvidence: false, needsApproval: true });
  await createLateFeePolicy(ctx, { feeHeadId: heads.lateFee!.feeHeadId, kind: 'FIXED', period: 'ONCE', value: 10000, graceDays: 5 });
  const found = await recommendConcessions(ctx, { sessionId: session._id });
  await awardMany(ctx, found.filter((s) => s.policyId === sibling.policyId).map((s) => ({ studentId: s.studentId, policyId: s.policyId })));

  // ── October is billed (so some bills are overdue); November is checked but not issued, so the exceptions show
  const october = await createRun(ctx, { sessionId: session._id, locationId: input.mohaliId, classIds: [class8._id], periodKey: '2026-10', issueDate: '2026-10-05' });
  const checked = await validateRun(ctx, october.runId);
  await commitRun(ctx, october.runId, { confirmedReadyCount: checked.run.counts.ready, confirmedTotalPaise: checked.run.totalPaise }, 'seed-2026-10');
  const november = await createRun(ctx, { sessionId: session._id, locationId: input.mohaliId, classIds: [class8._id], periodKey: '2026-11', issueDate: '2026-11-05' });
  await validateRun(ctx, november.runId);

  // ── an Accountant and an Approver (Staff logins with job bundles, not new roles)
  await setAccess(ctx, input.userIdsByEmail['accounts@greenfield.demo']!, { bundles: ['ACCOUNTANT', 'FEE_MANAGER', 'COLLECTOR'] });
  await setAccess(ctx, input.userIdsByEmail['approver@greenfield.demo']!, { bundles: ['APPROVER'] });
  return { students: open.length };
}
