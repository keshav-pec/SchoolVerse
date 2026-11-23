import { z } from 'zod';
import { FINANCE_BUNDLES } from '../permissions';
import {
  ACCOUNT_TYPES, AGING_BUCKETS, APPROVAL_ACTIONS, BANK_PURPOSES, BILLING_ROW_STATUSES, CONCESSION_TYPES, CONCESSION_VALUE_TYPES, DOCUMENT_KINDS, FEE_DOCUMENT_STATUSES,
  FEE_CATEGORIES, FEE_FREQUENCIES, LATE_FEE_KINDS, LATE_FEE_PERIODS, LEGAL_FORMS, PLAN_VERSION_STATES, PRICE_MODES, PRORATION_METHODS, STACK_MODES, STUDENT_TYPES, TAX_CATEGORIES,
} from '../finance';
import { paginationQuerySchema, uuidSchema } from './common';
import { optionalDateSchema, optionalText, requiredDateSchema, requiredText } from './fields';

/**
 * Module 7, Part 1 — request bodies and queries. Every body is `.strict()`. Money fields are whole paise: the browser turns
 * rupees into paise before it sends them, and the server never accepts a decimal.
 */

const emptyToNull = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

/** Whole paise. Never a decimal, never negative. */
export const paiseSchema = z.number({ message: 'Enter an amount.' }).int({ message: 'Money is a whole number of paise.' }).min(0, { message: 'The amount cannot be negative.' }).max(100_000_000_000_00, { message: 'That amount is too large.' });
export const positivePaiseSchema = paiseSchema.refine((n) => n > 0, { message: 'The amount must be more than zero.' });
/** Basis points: 1800 = 18%. */
export const bpsSchema = z.number().int().min(0).max(10_000);

export const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
export const IFSC_PATTERN = /^[A-Z]{4}0[A-Z0-9]{6}$/;
export const FY_CODE_PATTERN = /^(\d{4})-(\d{2})$/;
export const PERIOD_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const gstin = z.preprocess(
  (v) => (typeof v === 'string' ? emptyToNull(v.trim().toUpperCase()) : v),
  z.string().regex(GSTIN_PATTERN, { message: 'A GSTIN has 15 letters and numbers, like 03AAAAA0000A1Z5.' }).nullable(),
);
const pan = z.preprocess(
  (v) => (typeof v === 'string' ? emptyToNull(v.trim().toUpperCase()) : v),
  z.string().regex(PAN_PATTERN, { message: 'A PAN has 10 characters, like ABCDE1234F.' }).nullable(),
);
const ifsc = z.string().trim().toUpperCase().regex(IFSC_PATTERN, { message: 'An IFSC has 11 characters, like SBIN0001234.' });
const accountNumber = z.string().trim().regex(/^[0-9]{6,20}$/, { message: 'An account number has 6 to 20 digits.' });

// ───────────────────────────────────────────────────────────── access (FIN-07)

export const setFinanceAccessSchema = z
  .object({ bundles: z.array(z.enum(FINANCE_BUNDLES)).max(FINANCE_BUNDLES.length), locationIds: z.array(uuidSchema).max(50).nullable().optional() })
  .strict();
export type SetFinanceAccessData = z.output<typeof setFinanceAccessSchema>;
export const userIdParamsSchema = z.object({ userId: uuidSchema });

// ───────────────────────────────────────────────────────────── legal entity, years, accounts (FIN-01 to 04)

export const updateLegalEntitySchema = z
  .object({
    name: requiredText('Name', 150).optional(),
    legalForm: z.enum(LEGAL_FORMS).optional(),
    pan: pan.optional(),
    address: optionalText(300),
    stateCode: z.string().trim().regex(/^[0-9]{2}$/, { message: 'A state code has 2 digits, like 03.' }).nullable().optional(),
    fyStartMonth: z.number().int().min(1).max(12).optional(),
  })
  .strict();
export type UpdateLegalEntityData = z.output<typeof updateLegalEntitySchema>;

export const updateTaxProfileSchema = z
  .object({ gstRegistered: z.boolean().optional(), gstin: gstin.optional(), stateCode: z.string().trim().regex(/^[0-9]{2}$/, { message: 'A state code has 2 digits, like 03.' }).nullable().optional() })
  .strict()
  .superRefine((v, ctx) => {
    if (v.gstRegistered === true && v.gstin === null) ctx.addIssue({ code: 'custom', path: ['gstin'], message: 'Enter the GSTIN of a GST-registered school.' });
  });
export type UpdateTaxProfileData = z.output<typeof updateTaxProfileSchema>;

export const createFinancialYearSchema = z
  .object({
    code: z.string().trim().regex(FY_CODE_PATTERN, { message: 'Use the form 2026-27.' }).refine((c) => {
      const m = FY_CODE_PATTERN.exec(c);
      return !!m && (Number(m[1]) + 1) % 100 === Number(m[2]);
    }, { message: 'The second year must follow the first, like 2026-27.' }),
  })
  .strict();
export type CreateFinancialYearData = z.output<typeof createFinancialYearSchema>;

export const createAccountSchema = z
  .object({
    code: z.string().trim().min(2).max(12).regex(/^[A-Za-z0-9-]+$/, { message: 'Use letters, numbers and hyphens.' }).optional(),
    name: requiredText('Name', 100),
    type: z.enum(ACCOUNT_TYPES),
    parentId: uuidSchema.nullable().optional(),
    isPostable: z.boolean().optional(),
  })
  .strict();
export type CreateAccountData = z.output<typeof createAccountSchema>;

export const updateAccountSchema = z
  .object({
    name: requiredText('Name', 100).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    systemRole: z.string().trim().max(40).nullable().optional(),
    approvalId: uuidSchema.optional(),
  })
  .strict();
export type UpdateAccountData = z.output<typeof updateAccountSchema>;

export const createBankAccountSchema = z
  .object({
    label: requiredText('Label', 80),
    bankName: requiredText('Bank name', 100),
    holderName: optionalText(100),
    accountNumber,
    ifsc,
    purpose: z.enum(BANK_PURPOSES),
    glAccountId: uuidSchema.optional(),
    locationIds: z.array(uuidSchema).max(50).default([]),
  })
  .strict();
export type CreateBankAccountData = z.output<typeof createBankAccountSchema>;

export const updateBankAccountSchema = z
  .object({
    label: requiredText('Label', 80).optional(),
    bankName: requiredText('Bank name', 100).optional(),
    holderName: optionalText(100),
    purpose: z.enum(BANK_PURPOSES).optional(),
    locationIds: z.array(uuidSchema).max(50).optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
    /** Changing either of these needs an approval. */
    accountNumber: accountNumber.optional(),
    ifsc: ifsc.optional(),
  })
  .strict();
export type UpdateBankAccountData = z.output<typeof updateBankAccountSchema>;

export const revealBankSchema = z.object({ reason: requiredText('Reason', 300) }).strict();

export const createCashAccountSchema = z
  .object({ label: requiredText('Label', 80), glAccountId: uuidSchema.optional(), locationIds: z.array(uuidSchema).max(50).default([]) })
  .strict();
export const updateCashAccountSchema = z
  .object({ label: requiredText('Label', 80).optional(), locationIds: z.array(uuidSchema).max(50).optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() })
  .strict();

// ───────────────────────────────────────────────────────────── journals and reports (FIN-05, 16)

export const listJournalsQuerySchema = paginationQuerySchema.extend({
  from: optionalDateSchema,
  to: optionalDateSchema,
  accountId: uuidSchema.optional(),
  studentId: uuidSchema.optional(),
  sourceType: z.string().trim().max(40).optional(),
  sourceId: z.string().trim().max(80).optional(),
  eventType: z.string().trim().max(40).optional(),
});
export type ListJournalsQuery = z.output<typeof listJournalsQuerySchema>;

export const generalLedgerQuerySchema = z.object({ accountId: uuidSchema, from: optionalDateSchema, to: optionalDateSchema });
export const trialBalanceQuerySchema = z.object({ asOf: optionalDateSchema });
export const reverseJournalSchema = z.object({ reason: requiredText('Reason', 300) }).strict();

// ───────────────────────────────────────────────────────────── approvals (FIN-06)

export const updateApprovalPolicySchema = z
  .object({
    thresholdPaise: paiseSchema.nullable().optional(),
    needsDifferentApprover: z.boolean().optional(),
    enabled: z.boolean().optional(),
    reason: optionalText(300),
  })
  .strict();
export type UpdateApprovalPolicyData = z.output<typeof updateApprovalPolicySchema>;

export const createApprovalSchema = z
  .object({
    action: z.enum(APPROVAL_ACTIONS),
    entityType: requiredText('Record type', 40),
    entityId: z.string().trim().max(80).nullable().optional(),
    amountPaise: paiseSchema.default(0),
    summary: requiredText('Summary', 300),
    impact: optionalText(300),
    reason: optionalText(300),
    payload: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type CreateApprovalData = z.output<typeof createApprovalSchema>;

export const decideApprovalSchema = z.object({ decision: z.enum(['APPROVE', 'REJECT']), reason: optionalText(300) }).strict();
export type DecideApprovalData = z.output<typeof decideApprovalSchema>;
export const listApprovalsQuerySchema = paginationQuerySchema.extend({ decision: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'USED', 'CANCELLED']).optional(), action: z.enum(APPROVAL_ACTIONS).optional() });

export const listAuditQuerySchema = paginationQuerySchema.extend({ entityType: z.string().trim().max(60).optional(), entityId: z.string().trim().max(80).optional(), action: z.string().trim().max(80).optional(), from: optionalDateSchema, to: optionalDateSchema });

// ───────────────────────────────────────────────────────────── tax (TAX-01 to 03)

export const createTaxCodeSchema = z
  .object({
    code: z.string().trim().toUpperCase().min(2).max(24).regex(/^[A-Z0-9_]+$/, { message: 'Use capital letters, numbers and underscores.' }),
    name: requiredText('Name', 100),
    category: z.enum(TAX_CATEGORIES),
    rateBps: bpsSchema.default(0),
    hsnSac: optionalText(12),
    note: optionalText(200),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.category === 'TAXABLE' && v.rateBps <= 0) ctx.addIssue({ code: 'custom', path: ['rateBps'], message: 'A taxable code needs a rate above zero.' });
    if (v.category !== 'TAXABLE' && v.rateBps !== 0) ctx.addIssue({ code: 'custom', path: ['rateBps'], message: 'Only a taxable code has a rate.' });
  });
export type CreateTaxCodeData = z.output<typeof createTaxCodeSchema>;
export const updateTaxCodeSchema = z.object({ name: requiredText('Name', 100).optional(), hsnSac: optionalText(12), note: optionalText(200), status: z.enum(['ACTIVE', 'ENDED']).optional() }).strict();

// ───────────────────────────────────────────────────────────── fee heads and plans (FEE-01 to 04)

export const createFeeHeadSchema = z
  .object({
    code: z.string().trim().toUpperCase().min(2).max(20).regex(/^[A-Z0-9_]+$/, { message: 'Use capital letters, numbers and underscores.' }),
    name: requiredText('Name', 80),
    category: z.enum(FEE_CATEGORIES).default('OTHER'),
    incomeAccountId: uuidSchema,
    taxCodeId: uuidSchema.nullable().optional(),
    priceMode: z.enum(PRICE_MODES).default('EXCLUSIVE'),
    isRecurring: z.boolean().default(false),
    isOptional: z.boolean().default(false),
    isRefundableDeposit: z.boolean().default(false),
  })
  .strict();
export type CreateFeeHeadData = z.output<typeof createFeeHeadSchema>;
export const updateFeeHeadSchema = z
  .object({
    name: requiredText('Name', 80).optional(),
    category: z.enum(FEE_CATEGORIES).optional(),
    incomeAccountId: uuidSchema.optional(),
    taxCodeId: uuidSchema.nullable().optional(),
    priceMode: z.enum(PRICE_MODES).optional(),
    isRecurring: z.boolean().optional(),
    isOptional: z.boolean().optional(),
    status: z.enum(['ACTIVE', 'INACTIVE']).optional(),
  })
  .strict();
export type UpdateFeeHeadData = z.output<typeof updateFeeHeadSchema>;

export const feePlanItemSchema = z
  .object({
    feeHeadId: uuidSchema,
    amountPaise: positivePaiseSchema,
    frequency: z.enum(FEE_FREQUENCIES),
    dueDay: z.number().int().min(1).max(28).default(10),
    graceDays: z.number().int().min(0).max(90).default(0),
    prorationMethod: z.enum(PRORATION_METHODS).default('FULL_PERIOD'),
    isOptional: z.boolean().default(false),
  })
  .strict();
export type FeePlanItemData = z.output<typeof feePlanItemSchema>;

export const appliesToSchema = z
  .object({
    locationIds: z.array(uuidSchema).max(50).default([]),
    classIds: z.array(uuidSchema).max(50).default([]),
    studentType: z.enum(STUDENT_TYPES).default('ALL'),
    studentId: uuidSchema.nullable().optional(),
  })
  .strict();

export const createFeePlanSchema = z
  .object({
    name: requiredText('Name', 120),
    sessionId: uuidSchema,
    appliesTo: appliesToSchema,
    autoAssign: z.boolean().default(false),
    effectiveFrom: optionalDateSchema,
    items: z.array(feePlanItemSchema).max(30).default([]),
  })
  .strict();
export type CreateFeePlanData = z.output<typeof createFeePlanSchema>;

export const updateFeePlanSchema = z.object({ name: requiredText('Name', 120).optional(), autoAssign: z.boolean().optional(), status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }).strict();

export const createPlanVersionSchema = z.object({ effectiveFrom: requiredDateSchema.optional() }).strict();
export const updatePlanVersionSchema = z.object({ effectiveFrom: requiredDateSchema.optional(), items: z.array(feePlanItemSchema).max(30).optional() }).strict();
export const planVersionActionSchema = z.object({ reason: optionalText(300) }).strict();

export const listPlansQuerySchema = z.object({ sessionId: uuidSchema.optional(), state: z.enum(PLAN_VERSION_STATES).optional() });

export const recommendAssignmentsSchema = z.object({ sessionId: uuidSchema, locationId: uuidSchema, classId: uuidSchema.optional() }).strict();
export const bulkAssignSchema = z
  .object({
    sessionId: uuidSchema,
    locationId: uuidSchema,
    classId: uuidSchema.optional(),
    /** Leave out to assign every ready student. Send a plan version to settle a conflict for one student. */
    items: z.array(z.object({ studentId: uuidSchema, planVersionId: uuidSchema.optional() }).strict()).max(500).optional(),
  })
  .strict();
export type BulkAssignData = z.output<typeof bulkAssignSchema>;

export const updateStudentAssignmentSchema = z
  .object({ optionalItemIds: z.array(uuidSchema).max(30).optional(), planVersionId: uuidSchema.optional(), reason: requiredText('Reason', 300), sessionId: uuidSchema.optional() })
  .strict();
export type UpdateStudentAssignmentData = z.output<typeof updateStudentAssignmentSchema>;

// ───────────────────────────────────────────────────────────── concessions (FEE-05, 06)

const concessionValue = z.number().int().min(1);
export const createConcessionPolicySchema = z
  .object({
    name: requiredText('Name', 100),
    type: z.enum(CONCESSION_TYPES),
    valueType: z.enum(CONCESSION_VALUE_TYPES),
    value: concessionValue,
    feeHeadIds: z.array(uuidSchema).max(30).default([]),
    stackMode: z.enum(STACK_MODES).default('HIGHEST_WINS'),
    capPercentBps: bpsSchema.nullable().optional(),
    validFrom: optionalDateSchema,
    validTo: optionalDateSchema,
    needsEvidence: z.boolean().default(false),
    needsApproval: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.valueType === 'PERCENT' && v.value > 10_000) ctx.addIssue({ code: 'custom', path: ['value'], message: 'A percentage cannot be more than 100%.' });
  });
export type CreateConcessionPolicyData = z.output<typeof createConcessionPolicySchema>;
export const updateConcessionPolicySchema = z
  .object({ name: requiredText('Name', 100).optional(), value: concessionValue.optional(), feeHeadIds: z.array(uuidSchema).max(30).optional(), stackMode: z.enum(STACK_MODES).optional(), capPercentBps: bpsSchema.nullable().optional(), validFrom: optionalDateSchema, validTo: optionalDateSchema, needsEvidence: z.boolean().optional(), needsApproval: z.boolean().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() })
  .strict();

export const recommendConcessionsSchema = z.object({ studentId: uuidSchema.optional(), classOfferingId: uuidSchema.optional(), sessionId: uuidSchema.optional() }).strict();
export const awardConcessionSchema = z
  .object({ studentId: uuidSchema, policyId: uuidSchema, value: concessionValue.optional(), reason: optionalText(300), evidenceFileId: uuidSchema.nullable().optional(), validFrom: optionalDateSchema, validTo: optionalDateSchema })
  .strict();
export type AwardConcessionData = z.output<typeof awardConcessionSchema>;
export const awardManySchema = z.object({ awards: z.array(z.object({ studentId: uuidSchema, policyId: uuidSchema }).strict()).min(1).max(500) }).strict();
export const decideAwardSchema = z.object({ reason: optionalText(300) }).strict();
export const listAwardsQuerySchema = paginationQuerySchema.extend({ status: z.enum(['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'ENDED']).optional(), studentId: uuidSchema.optional() });

// ───────────────────────────────────────────────────────────── late fees (FEE-07)

export const createLateFeePolicySchema = z
  .object({
    feeHeadId: uuidSchema,
    kind: z.enum(LATE_FEE_KINDS),
    period: z.enum(LATE_FEE_PERIODS),
    value: z.number().int().min(1),
    graceDays: z.number().int().min(0).max(90).default(0),
    capPaise: paiseSchema.nullable().optional(),
  })
  .strict();
export type CreateLateFeePolicyData = z.output<typeof createLateFeePolicySchema>;
export const updateLateFeePolicySchema = z.object({ value: z.number().int().min(1).optional(), period: z.enum(LATE_FEE_PERIODS).optional(), graceDays: z.number().int().min(0).max(90).optional(), capPaise: paiseSchema.nullable().optional(), status: z.enum(['ACTIVE', 'INACTIVE']).optional() }).strict();
export const lateFeeRunSchema = z.object({ asOf: optionalDateSchema, locationId: uuidSchema.optional() }).strict();

// ───────────────────────────────────────────────────────────── billing (FEE-09, 10)

export const createBillingRunSchema = z
  .object({
    sessionId: uuidSchema,
    locationId: uuidSchema,
    classIds: z.array(uuidSchema).max(50).optional(),
    periodKey: z.string().regex(PERIOD_KEY_PATTERN, { message: 'Use the form 2026-11.' }),
    issueDate: requiredDateSchema,
    dueDate: optionalDateSchema,
  })
  .strict();
export type CreateBillingRunData = z.output<typeof createBillingRunSchema>;
export const runParamsSchema = z.object({ id: uuidSchema });
export const runRowParamsSchema = z.object({ id: uuidSchema, rowId: uuidSchema });
export const listRunRowsQuerySchema = paginationQuerySchema.extend({ status: z.enum(BILLING_ROW_STATUSES).optional(), reasonCode: z.string().trim().max(40).optional() });
export const patchRunRowSchema = z.object({ action: z.literal('SKIP'), reason: requiredText('Reason', 300) }).strict();
export const commitBillingRunSchema = z.object({ confirmedReadyCount: z.number().int().min(0), confirmedTotalPaise: paiseSchema }).strict();
export type CommitBillingRunData = z.output<typeof commitBillingRunSchema>;
export const listRunsQuerySchema = paginationQuerySchema.extend({ sessionId: uuidSchema.optional(), state: z.enum(['DRAFT', 'VALIDATED', 'APPROVED', 'ISSUED', 'CANCELLED']).optional() });

// ───────────────────────────────────────────────────────────── bills and adjustments (FEE-10, 11)

export const listDocumentsQuerySchema = paginationQuerySchema.extend({
  studentId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  kind: z.enum(DOCUMENT_KINDS).optional(),
  status: z.enum(FEE_DOCUMENT_STATUSES).optional(),
  periodKey: z.string().regex(PERIOD_KEY_PATTERN).optional(),
  overdue: flag.optional(),
  from: optionalDateSchema,
  to: optionalDateSchema,
});
export type ListDocumentsQuery = z.output<typeof listDocumentsQuerySchema>;
export const idParamsSchema = z.object({ id: uuidSchema });

const creditLine = z.object({ lineId: uuidSchema, amountPaise: positivePaiseSchema }).strict();
const debitLine = z.object({ feeHeadId: uuidSchema, description: requiredText('Description', 150), amountPaise: positivePaiseSchema }).strict();

export const createAdjustmentSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.enum(['CREDIT_NOTE', 'WAIVER', 'LATE_FEE_REVERSAL']), lines: z.array(creditLine).min(1).max(30), reason: requiredText('Reason', 300), approvalId: uuidSchema.optional() }).strict(),
    z.object({ type: z.literal('DEBIT_NOTE'), lines: z.array(debitLine).min(1).max(30), reason: requiredText('Reason', 300), approvalId: uuidSchema.optional() }).strict(),
  ]);
export type CreateAdjustmentData = z.output<typeof createAdjustmentSchema>;

// ───────────────────────────────────────────────────────────── student account, outstanding (FEE-12 to 14)

export const studentRangeQuerySchema = z.object({ from: optionalDateSchema, to: optionalDateSchema });
export const outstandingQuerySchema = paginationQuerySchema.extend({ locationId: uuidSchema.optional(), classOfferingId: uuidSchema.optional(), bucket: z.enum(AGING_BUCKETS).optional(), asOf: optionalDateSchema });
export const guardianParamsSchema = z.object({ guardianId: uuidSchema });
export const parentStudentParamsSchema = z.object({ id: uuidSchema });

/** The Accounts list. A campus is always named, so the finance scope check is simple. */
export const listAccountsQuerySchema = paginationQuerySchema.extend({
  locationId: uuidSchema,
  academicSessionId: uuidSchema.optional(),
  classOfferingId: uuidSchema.optional(),
  q: z.string().trim().max(100).optional(),
});
export type ListAccountsQuery = z.output<typeof listAccountsQuerySchema>;

export const pulseQuerySchema = z.object({ locationId: uuidSchema.optional() });
