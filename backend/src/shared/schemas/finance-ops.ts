import { z } from 'zod';
import { BANK_METHODS, PAYMENT_METHODS } from '../finance-ops';
import { paginationQuerySchema, uuidSchema } from './common';
import { optionalDateSchema, optionalText, requiredDateSchema, requiredText } from './fields';
import { paiseSchema, positivePaiseSchema } from './finance';

/**
 * Module 7, Part 3 — request bodies and queries. Every body is `.strict()`. Money is whole paise. A supplied employee or user id that
 * the server decides for itself (the caller's own, for example) is not accepted at all.
 */

const methodSchema = z.enum(PAYMENT_METHODS);
const allocation = z.object({ studentId: uuidSchema, documentId: uuidSchema.optional(), amountPaise: positivePaiseSchema }).strict();
const bankMethods = BANK_METHODS as readonly string[];

// ───────────────────────────────────────────────────────────── 3A collections

const claimFields = {
  students: z.array(z.object({ studentId: uuidSchema, amountPaise: positivePaiseSchema }).strict()).min(1, { message: 'Choose at least one child.' }).max(10),
  method: methodSchema.refine((m) => m !== 'CASH', { message: 'A cash payment is recorded at the school office, not reported.' }),
  amountPaise: positivePaiseSchema,
  paidOn: requiredDateSchema,
  reference: optionalText(60),
};
const claimRefine = (v: { students: { amountPaise: number }[]; amountPaise: number }) => v.students.reduce((s, x) => s + x.amountPaise, 0) === v.amountPaise;
const claimMessage = { message: 'The amounts for each child must add up to the total paid.', path: ['amountPaise'] };

export const createParentClaimSchema = z.object(claimFields).strict().refine(claimRefine, claimMessage);
export const createStaffClaimSchema = z.object(claimFields).strict().refine(claimRefine, claimMessage);
export type CreateClaimData = z.output<typeof createStaffClaimSchema>;

export const rejectSchema = z.object({ reason: requiredText('Reason', 300) }).strict();

const evidenceSchema = z.object({ statementLineId: uuidSchema.optional(), note: optionalText(300), seenOn: requiredDateSchema }).strict();
export const verifyCollectionSchema = z
  .object({
    amountSeenPaise: positivePaiseSchema,
    evidence: evidenceSchema,
    bankAccountId: uuidSchema.optional(),
    /** When the amount seen differs from the amount reported: take the amount seen. */
    useSeenAmount: z.boolean().optional(),
  })
  .strict();
export type VerifyCollectionData = z.output<typeof verifyCollectionSchema>;

const chequeSchema = z.object({ number: requiredText('Cheque number', 20), bankName: requiredText('Bank', 80), chequeDate: requiredDateSchema, payerName: optionalText(100) }).strict();

export const createCollectionSchema = z
  .object({
    method: methodSchema,
    amountPaise: positivePaiseSchema,
    payerName: optionalText(100),
    receivedOn: optionalDateSchema,
    reference: optionalText(60),
    bankAccountId: uuidSchema.optional(),
    cheque: chequeSchema.optional(),
    allocations: z.array(allocation).max(60).optional(),
    /** Pay the oldest bills first. Anything left stays as an advance. */
    autoAllocate: z.object({ studentIds: z.array(uuidSchema).min(1).max(10) }).strict().optional(),
    /** Who keeps the advance when the payment is more than the bills. Defaults to the first child. */
    advanceStudentId: uuidSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.method === 'CHEQUE' && !v.cheque) ctx.addIssue({ code: 'custom', path: ['cheque'], message: 'Enter the cheque number, bank and date.' });
    if (v.method !== 'CHEQUE' && v.cheque) ctx.addIssue({ code: 'custom', path: ['cheque'], message: 'Cheque details are only for a cheque.' });
    if (bankMethods.includes(v.method) && !v.reference) ctx.addIssue({ code: 'custom', path: ['reference'], message: 'Enter the payment reference (UTR or transaction number).' });
    if (!v.allocations?.length && !v.autoAllocate && !v.advanceStudentId) ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'Choose which child this payment is for.' });
    const planned = (v.allocations ?? []).reduce((s, a) => s + a.amountPaise, 0);
    if (planned > v.amountPaise) ctx.addIssue({ code: 'custom', path: ['allocations'], message: 'The amounts add up to more than the payment.' });
  });
export type CreateCollectionData = z.output<typeof createCollectionSchema>;

export const allocateSchema = z
  .object({ items: z.array(allocation).max(60).optional(), autoAllocate: z.object({ studentIds: z.array(uuidSchema).min(1).max(10) }).strict().optional() })
  .strict()
  .refine((v) => (v.items?.length ?? 0) > 0 || v.autoAllocate, { message: 'Choose what to pay, or let the system pay the oldest bills first.' });
export type AllocateData = z.output<typeof allocateSchema>;

export const depositChequeSchema = z.object({ depositBatchId: uuidSchema.optional(), depositedOn: optionalDateSchema, bankAccountId: uuidSchema.optional() }).strict();
export const clearChequeSchema = z.object({ clearedOn: requiredDateSchema, bankAccountId: uuidSchema.optional() }).strict();
export const returnChequeSchema = z.object({ reason: requiredText('Reason', 200), chargePaise: paiseSchema.optional(), returnedOn: optionalDateSchema }).strict();
export const reverseAllocationSchema = z.object({ reason: requiredText('Reason', 300) }).strict();
export const applyAdvanceSchema = z.object({ documentIds: z.array(uuidSchema).max(30).optional() }).strict();
export const transferAdvanceSchema = z.object({ toStudentId: uuidSchema, amountPaise: positivePaiseSchema, reason: requiredText('Reason', 300), approvalId: uuidSchema.optional() }).strict();
export const cancelReceiptSchema = z.object({ reason: requiredText('Reason', 300), approvalId: uuidSchema.optional() }).strict();

export const listClaimsQuerySchema = paginationQuerySchema.extend({ status: z.enum(['REPORTED', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED']).optional(), studentId: uuidSchema.optional(), flagged: z.coerce.boolean().optional() });
export const listCollectionsQuerySchema = paginationQuerySchema.extend({
  status: z.string().trim().max(200).optional(),
  method: methodSchema.optional(),
  studentId: uuidSchema.optional(),
  from: optionalDateSchema,
  to: optionalDateSchema,
  q: z.string().trim().max(60).optional(),
});
export const listReceiptsQuerySchema = paginationQuerySchema.extend({ studentId: uuidSchema.optional(), from: optionalDateSchema, to: optionalDateSchema, q: z.string().trim().max(60).optional() });

// refunds
export const createRefundSchema = z.object({ studentId: uuidSchema, reason: requiredText('Reason', 300), amountPaise: positivePaiseSchema, recipientPersonId: uuidSchema.optional() }).strict();
export const refundableQuerySchema = z.object({ studentId: uuidSchema });
export const approveRefundSchema = z.object({ note: optionalText(300) }).strict();
export const disburseRefundSchema = z
  .object({
    bankAccountId: uuidSchema.optional(),
    cashAccountId: uuidSchema.optional(),
    reference: optionalText(60),
    paidOn: optionalDateSchema,
    evidenceNote: optionalText(300),
  })
  .strict()
  .refine((v) => Boolean(v.bankAccountId) !== Boolean(v.cashAccountId), { message: 'Choose the bank account or the cash account the money left from.', path: ['bankAccountId'] })
  .refine((v) => !v.bankAccountId || Boolean(v.reference), { message: 'Enter the bank reference for this payment.', path: ['reference'] });
export const listRefundsQuerySchema = paginationQuerySchema.extend({ state: z.enum(['REQUESTED', 'ELIGIBLE', 'APPROVED', 'PAID', 'REJECTED']).optional(), studentId: uuidSchema.optional() });

// cash shifts
export const openShiftSchema = z.object({ openingFloatPaise: paiseSchema.default(0), cashAccountId: uuidSchema.optional(), locationId: uuidSchema.optional() }).strict();
export const closeShiftSchema = z.object({ countedPaise: paiseSchema, note: optionalText(300) }).strict();
export const signOffShiftSchema = z.object({ note: optionalText(300) }).strict();
export const createDepositSchema = z.object({ shiftIds: z.array(uuidSchema).min(1).max(20), bankAccountId: uuidSchema, amountPaise: positivePaiseSchema, depositedOn: optionalDateSchema, reference: optionalText(60) }).strict();
export const cashbookQuerySchema = z.object({ date: optionalDateSchema, locationId: uuidSchema.optional() });
export const listShiftsQuerySchema = paginationQuerySchema.extend({ state: z.enum(['OPEN', 'CLOSED', 'SIGNED_OFF']).optional(), mine: z.coerce.boolean().optional() });

// reports
export const COLLECTION_REPORT_TYPES = ['by-day', 'by-method', 'by-class', 'by-fee-head', 'by-cashier', 'pending-verification', 'cheque-register', 'advances', 'refund-register'] as const;
export const collectionReportParamsSchema = z.object({ type: z.enum(COLLECTION_REPORT_TYPES) });
export const collectionReportQuerySchema = z.object({ from: optionalDateSchema, to: optionalDateSchema, locationId: uuidSchema.optional(), format: z.enum(['json', 'csv']).default('json') });

// fee extras
export const feeImportSchema = z.object({ kind: z.enum(['OPENING_BALANCES', 'ASSIGNMENTS']), sessionId: uuidSchema.optional(), asOf: optionalDateSchema }).strict();
export const reminderSchema = z.object({ minDaysOverdue: z.number().int().min(0).max(365).default(7), locationId: uuidSchema.optional(), classOfferingId: uuidSchema.optional() }).strict();

// ───────────────────────────────────────────────────────────── 3B banking and reconciliation

export const importStatementSchema = z
  .object({
    openingBalance: z.string().trim().max(20).optional(),
    closingBalance: z.string().trim().max(20).optional(),
    /** Optional column names, as JSON: {"date":"Txn Date","credit":"Deposit"}. Remembered for this bank account. */
    mapping: z.string().trim().max(600).optional(),
  })
  .strict();
export const bankAccountParamsSchema = z.object({ id: uuidSchema });
export const listLinesQuerySchema = paginationQuerySchema.extend({ bankAccountId: uuidSchema, status: z.string().trim().max(120).optional(), from: optionalDateSchema, to: optionalDateSchema, q: z.string().trim().max(60).optional() });
export const autoMatchSchema = z.object({ bankAccountId: uuidSchema, from: optionalDateSchema, to: optionalDateSchema }).strict();
export const exceptionsQuerySchema = z.object({ bankAccountId: uuidSchema });
export const confirmMatchSchema = z.object({ verify: z.boolean().optional(), seenOn: optionalDateSchema }).strict();
export const reverseMatchSchema = z.object({ reason: requiredText('Reason', 300) }).strict();
export const manualMatchSchema = z
  .object({
    bankAccountId: uuidSchema,
    lineIds: z.array(uuidSchema).min(1).max(30),
    targets: z.array(z.object({ type: z.enum(['collection', 'cash_deposit', 'refund', 'payroll_batch', 'vendor_payment', 'expense']), id: uuidSchema }).strict()).min(1).max(30),
    reason: optionalText(300),
    approvalId: uuidSchema.optional(),
  })
  .strict();
export const ignoreLineSchema = z.object({ reason: requiredText('Reason', 300), approvalId: uuidSchema.optional() }).strict();
export const bankPostingSchema = z.object({ memo: optionalText(150) }).strict();
export const reconSummaryQuerySchema = z.object({ bankAccountId: uuidSchema, asOf: optionalDateSchema });

// ───────────────────────────────────────────────────────────── 3C payroll

import { COMPONENT_CALCS, COMPONENT_TYPES, PAY_DAY_BASES, PAY_MODES, PAYROLL_ROUNDINGS } from '../finance-ops';
import { bpsSchema } from './finance';

const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'Use a month like 2026-11.' });
export const payrollMonthQuerySchema = z.object({ month: monthSchema });

export const updatePayrollPolicySchema = z.object({ payDayBasis: z.enum(PAY_DAY_BASES).optional(), rounding: z.enum(PAYROLL_ROUNDINGS).optional(), approvalRequired: z.boolean().optional(), defaultBankAccountId: uuidSchema.nullable().optional() }).strict();

export const createComponentSchema = z
  .object({
    code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/, { message: 'Use 2 to 20 letters, numbers or underscores.' }),
    name: requiredText('Name', 60),
    type: z.enum(COMPONENT_TYPES),
    calc: z.enum(COMPONENT_CALCS),
    pfWage: z.boolean().default(false),
    esiWage: z.boolean().default(false),
    prorate: z.boolean().default(true),
    glAccountId: uuidSchema.nullable().optional(),
  })
  .strict();
export const updateComponentSchema = z.object({ name: requiredText('Name', 60).optional(), pfWage: z.boolean().optional(), esiWage: z.boolean().optional(), prorate: z.boolean().optional(), glAccountId: uuidSchema.nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).strict();

const structureItem = z.object({ componentId: uuidSchema, amountPaise: paiseSchema.optional(), rateBps: bpsSchema.optional() }).strict();
export const createStructureSchema = z.object({ name: requiredText('Name', 80), effectiveFrom: requiredDateSchema, items: z.array(structureItem).min(1).max(30) }).strict();
export const createStructureVersionSchema = z.object({ effectiveFrom: requiredDateSchema, items: z.array(structureItem).min(1).max(30) }).strict();
export const updateStructureVersionSchema = z.object({ items: z.array(structureItem).min(1).max(30) }).strict();

export const createCompensationSchema = z
  .object({ employeeId: uuidSchema, structureVersionId: uuidSchema, mode: z.enum(PAY_MODES).default('MONTHLY'), basicPaise: positivePaiseSchema, overrides: z.array(z.object({ componentId: uuidSchema, amountPaise: paiseSchema }).strict()).max(20).default([]), effectiveFrom: requiredDateSchema })
  .strict();
export const recommendCompensationSchema = z.object({ locationId: uuidSchema.optional() }).strict();
export const createRevisionSchema = z.object({ employeeId: uuidSchema, newBasicPaise: positivePaiseSchema, effectiveDate: requiredDateSchema, arrearPolicy: z.enum(['PAY_DIFFERENCE', 'NONE']).default('PAY_DIFFERENCE'), reason: requiredText('Reason', 300), approvalId: uuidSchema.optional() }).strict();

const extraLine = z.object({ label: requiredText('Label', 60), type: z.enum(['EARNING', 'DEDUCTION']), amountPaise: positivePaiseSchema }).strict();
export const putInputSchema = z
  .object({ employeeId: uuidSchema, month: monthSchema, workingDays: z.number().min(0).max(31).nullable().optional(), paidLeaveDays: z.number().min(0).max(31).default(0), lopDays: z.number().min(0).max(31).default(0), unitsWorked: z.number().min(0).max(744).nullable().optional(), extras: z.array(extraLine).max(10).default([]) })
  .strict();
export const fillInputsSchema = z.object({ month: monthSchema, workingDays: z.number().min(1).max(31).optional(), locationId: uuidSchema.optional() }).strict();
export const importInputsSchema = z.object({ month: monthSchema }).strict();

export const createRuleSchema = z.object({ kind: z.enum(['PF', 'ESI', 'PT']), effectiveFrom: requiredDateSchema, params: z.record(z.string(), z.unknown()), note: optionalText(200) }).strict();
export const taxDeclarationSchema = z.object({ regime: z.enum(['NEW', 'OLD']), estimatedYearlyTaxPaise: paiseSchema, alreadyDeductedPaise: paiseSchema.default(0), note: optionalText(200) }).strict();
export const employeeTaxDeclarationSchema = taxDeclarationSchema.extend({ employeeId: uuidSchema });

export const createAdvanceSchema = z.object({ employeeId: uuidSchema, principalPaise: positivePaiseSchema, installments: z.number().int().min(1).max(60), startMonth: monthSchema, reason: requiredText('Reason', 200) }).strict();
export const changeAdvancePlanSchema = z.object({ installments: z.number().int().min(1).max(60), approvalId: uuidSchema.optional() }).strict();
export const advancePaymentSchema = z.object({ bankAccountId: uuidSchema, reference: requiredText('Reference', 60), paidOn: optionalDateSchema }).strict();
export const earlyRepaymentSchema = z.object({ amountPaise: positivePaiseSchema, bankAccountId: uuidSchema, reference: optionalText(60), paidOn: optionalDateSchema }).strict();

export const createRunSchema = z
  .object({ month: monthSchema, type: z.enum(['MONTHLY', 'SUPPLEMENTARY', 'CORRECTION']).default('MONTHLY'), locationId: uuidSchema.optional(), parentRunId: uuidSchema.optional(), employeeIds: z.array(uuidSchema).max(500).optional() })
  .strict()
  .refine((v) => v.type === 'MONTHLY' || v.employeeIds?.length, { message: 'Choose the employees this run is for.', path: ['employeeIds'] });
export const listRunsPayQuerySchema = paginationQuerySchema.extend({ month: monthSchema.optional(), state: z.string().trim().max(60).optional() });
export const runRowsQuerySchema = paginationQuerySchema.extend({ status: z.enum(['READY', 'NEEDS_ACTION', 'HELD']).optional(), q: z.string().trim().max(60).optional() });
export const runEmployeeParamsSchema = z.object({ id: uuidSchema, eid: uuidSchema });
export const patchRunEmployeeSchema = z.object({ hold: z.boolean().optional(), reason: requiredText('Reason', 200), addLine: extraLine.optional(), removeLineLabel: z.string().trim().max(60).optional() }).strict();
export const finalizeRunSchema = z.object({ version: z.number().int().min(0), acknowledgeDemoRules: z.boolean().optional() }).strict();
export const buildBatchSchema = z.object({ bankAccountId: uuidSchema }).strict();
export const recordPaymentsSchema = z
  .object({
    items: z.array(z.object({ employeeId: uuidSchema, status: z.enum(['PAID', 'FAILED', 'RETURNED']), amountPaise: positivePaiseSchema.optional(), reference: optionalText(60), paidOn: optionalDateSchema, mode: z.enum(['BANK', 'CASH', 'CHEQUE']).default('BANK'), reason: optionalText(200) }).strict()).min(1).max(500),
    evidenceNote: optionalText(300),
  })
  .strict();
export const verifyPaymentsSchema = z.object({ employeeIds: z.array(uuidSchema).max(500).optional() }).strict();
export const fullFinalSchema = z.object({ lastWorkingDay: optionalDateSchema, leaveEncashmentDays: z.number().min(0).max(365).default(0), leaveEncashmentRatePaise: paiseSchema.default(0), noticeAdjustmentPaise: z.number().int().min(-100_000_000).max(100_000_000).default(0), bonusPaise: paiseSchema.default(0), gratuityPaise: paiseSchema.default(0) }).strict();
export const employeeParamsSchema = z.object({ id: uuidSchema });
export const payslipListQuerySchema = z.object({ employeeId: uuidSchema.optional(), month: monthSchema.optional() });

export const PAYROLL_REPORT_TYPES = ['register', 'bank-advice', 'statutory-summary', 'liability-aging', 'cost-by-location-department'] as const;
export const payrollReportParamsSchema = z.object({ type: z.enum(PAYROLL_REPORT_TYPES) });
export const payrollReportQuerySchema = z.object({ month: monthSchema.optional(), format: z.enum(['json', 'csv']).default('json') });

// ───────────────────────────────────────────────────────────── 3D expenses, vendors and GST

import { EXPENSE_PAYMENT_MODES, GST_HEADS, GST_PAYMENT_KINDS, ITC_STATUSES } from '../finance-ops';
import { GSTIN_PATTERN, PAN_PATTERN, IFSC_PATTERN } from './finance';

const gstinOpt = z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v), z.string().regex(GSTIN_PATTERN, { message: 'A GSTIN has 15 letters and numbers, like 03AAAAA0000A1Z5.' }).nullable()).optional();
const panOpt = z.preprocess((v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v), z.string().regex(PAN_PATTERN, { message: 'A PAN has 10 characters, like ABCDE1234F.' }).nullable()).optional();
const stateCodeOpt = z.string().trim().regex(/^[0-9]{2}$/, { message: 'A state code has 2 digits, like 03.' }).nullable().optional();

export const createCategorySchema = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_]{2,20}$/), name: requiredText('Name', 60), accountId: uuidSchema, defaultItcStatus: z.enum(ITC_STATUSES).default('NEEDS_REVIEW') }).strict();
export const updateCategorySchema = z.object({ name: requiredText('Name', 60).optional(), accountId: uuidSchema.optional(), defaultItcStatus: z.enum(ITC_STATUSES).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).strict();

export const createVendorSchema = z
  .object({ name: requiredText('Name', 100), gstin: gstinOpt, stateCode: stateCodeOpt, pan: panOpt, contactName: optionalText(80), phone: optionalText(20), bankAccountNumber: z.string().trim().regex(/^[0-9]{6,20}$/, { message: 'An account number has 6 to 20 digits.' }).optional(), bankIfsc: z.string().trim().toUpperCase().regex(IFSC_PATTERN, { message: 'An IFSC has 11 characters, like SBIN0001234.' }).optional(), bankName: optionalText(60) })
  .strict();
export const updateVendorSchema = createVendorSchema.partial().extend({ status: z.enum(['ACTIVE', 'INACTIVE']).optional(), approvalId: uuidSchema.optional() }).strict();

const expenseTax = { gstRateBps: bpsSchema.default(0), itcStatus: z.enum(ITC_STATUSES).optional() };
export const createExpenseSchema = z
  .object({
    categoryId: uuidSchema,
    taxableValuePaise: positivePaiseSchema,
    date: requiredDateSchema,
    description: requiredText('Description', 150),
    vendorId: uuidSchema.optional(),
    locationId: uuidSchema,
    paymentMode: z.enum(EXPENSE_PAYMENT_MODES),
    bankAccountId: uuidSchema.optional(),
    cashAccountId: uuidSchema.optional(),
    ...expenseTax,
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.paymentMode === 'BANK' && !v.bankAccountId) ctx.addIssue({ code: 'custom', path: ['bankAccountId'], message: 'Choose the bank account that paid this.' });
    if (v.paymentMode === 'UNPAID' && !v.vendorId) ctx.addIssue({ code: 'custom', path: ['vendorId'], message: 'Choose the vendor this is owed to.' });
  });
export const expenseDecisionSchema = z.object({ reason: optionalText(300) }).strict();
export const rejectExpenseSchema = z.object({ reason: requiredText('Reason', 300) }).strict();
export const listExpensesQuerySchema = paginationQuerySchema.extend({ state: z.string().trim().max(60).optional(), categoryId: uuidSchema.optional(), vendorId: uuidSchema.optional(), from: optionalDateSchema, to: optionalDateSchema, locationId: uuidSchema.optional() });

export const createVendorBillSchema = z
  .object({
    vendorId: uuidSchema,
    vendorBillNumber: requiredText('Bill number', 40),
    date: requiredDateSchema,
    dueDate: requiredDateSchema,
    locationId: uuidSchema,
    lines: z.array(z.object({ description: requiredText('Description', 120), categoryId: uuidSchema, taxableValuePaise: positivePaiseSchema, gstRateBps: bpsSchema.default(0), itcStatus: z.enum(ITC_STATUSES).optional() }).strict()).min(1).max(30),
  })
  .strict();
export const listVendorBillsQuerySchema = paginationQuerySchema.extend({ state: z.string().trim().max(60).optional(), vendorId: uuidSchema.optional(), open: z.coerce.boolean().optional() });
export const createVendorPaymentSchema = z.object({ vendorId: uuidSchema, bankAccountId: uuidSchema, paidOn: optionalDateSchema, reference: requiredText('Reference', 60), allocations: z.array(z.object({ billId: uuidSchema, amountPaise: positivePaiseSchema }).strict()).min(1).max(30) }).strict();
export const agingQuerySchema = z.object({ asOf: optionalDateSchema });

export const itcReviewSchema = z.object({ lineIds: z.array(uuidSchema).min(1).max(100), decision: z.enum(['ELIGIBLE', 'NOT_ELIGIBLE']), reason: requiredText('Reason', 300) }).strict();
export const listTaxLinesQuerySchema = paginationQuerySchema.extend({ itcStatus: z.enum(ITC_STATUSES).optional(), month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional() });
export const createGstPaymentSchema = z
  .object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), kind: z.enum(GST_PAYMENT_KINDS), head: z.enum(GST_HEADS), amountPaise: positivePaiseSchema, bankAccountId: uuidSchema.optional(), challanRef: optionalText(60), paidOn: optionalDateSchema })
  .strict()
  .refine((v) => v.kind === 'USE_ITC' || Boolean(v.bankAccountId), { message: 'Choose the bank account the tax was paid from.', path: ['bankAccountId'] });
export const GST_REPORT_TYPES = ['outward-summary', 'exempt-and-nil-summary', 'itc-register', 'liability-summary', 'hsn-summary'] as const;
export const gstReportParamsSchema = z.object({ type: z.enum(GST_REPORT_TYPES) });
export const gstReportQuerySchema = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).optional(), format: z.enum(['json', 'csv']).default('json') });

// ───────────────────────────────────────────────────────────── 3E close, reports, attention

import { FINANCIAL_REPORT_TYPES } from '../finance-ops';

export const openingBalanceSchema = z.object({ asOf: requiredDateSchema }).strict();
export const manualJournalSchema = z
  .object({
    accountingDate: requiredDateSchema,
    memo: requiredText('Description', 200),
    reason: requiredText('Reason', 300),
    lines: z.array(z.object({ accountId: uuidSchema, debitPaise: paiseSchema.default(0), creditPaise: paiseSchema.default(0), locationId: uuidSchema.optional() }).strict()).min(2).max(40),
    approvalId: uuidSchema.optional(),
  })
  .strict();
export const periodParamsSchema = z.object({ id: uuidSchema });
export const closeReadinessQuerySchema = z.object({ periodId: uuidSchema });
export const closePeriodSchema = z.object({ warningReason: optionalText(300), approvalId: uuidSchema.optional() }).strict();
export const reopenPeriodSchema = z.object({ reason: requiredText('Reason', 300), approvalId: uuidSchema.optional() }).strict();
export const financeAttentionQuerySchema = z.object({ locationId: uuidSchema.optional(), sessionId: uuidSchema.optional() });
export const searchQuerySchema = z.object({ q: z.string().trim().min(2, { message: 'Type at least 2 letters or numbers.' }).max(60) });
export const financialReportParamsSchema = z.object({ type: z.enum(FINANCIAL_REPORT_TYPES) });
export const financialReportQuerySchema = z.object({ from: optionalDateSchema, to: optionalDateSchema, asOf: optionalDateSchema, accountId: uuidSchema.optional(), bankAccountId: uuidSchema.optional(), locationId: uuidSchema.optional(), format: z.enum(['json', 'csv']).default('json') });
