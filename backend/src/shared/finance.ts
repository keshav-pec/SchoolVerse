/**
 * Module 7 — Finance. Enums, constants and the shapes that leave the API.
 *
 * Money is whole paise (a whole number, ₹1 = 100 paise) in every `…Paise` field. Rates are basis points (`1800` = 18%).
 * Dates are `YYYY-MM-DD` text, the same as Modules 2–5. Screens show rupees; the API never does.
 */

// ───────────────────────────────────────────────────────────── enums

export const ACCOUNT_TYPES = ['ASSET', 'LIABILITY', 'INCOME', 'EXPENSE', 'EQUITY'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];
export const NORMAL_BALANCES = ['DEBIT', 'CREDIT'] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

/** Accounts the system itself posts to. A system role is unique, and moving it needs an approval. */
export const SYSTEM_ACCOUNT_ROLES = [
  'CASH', 'BANK_DEFAULT', 'STUDENT_RECEIVABLE', 'EMPLOYEE_ADVANCE', 'INPUT_CGST', 'INPUT_SGST', 'INPUT_IGST',
  'STUDENT_ADVANCE', 'REFUNDABLE_DEPOSIT', 'SALARY_PAYABLE', 'PF_PAYABLE', 'ESI_PAYABLE', 'PT_PAYABLE', 'TDS_PAYABLE', 'REFUND_PAYABLE', 'VENDOR_PAYABLE',
  'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST', 'OPENING_EQUITY', 'LATE_FEE_INCOME', 'SALARY_EXPENSE', 'EMPLOYER_CONTRIBUTION_EXPENSE', 'BANK_CHARGES',
] as const;
export type SystemAccountRole = (typeof SYSTEM_ACCOUNT_ROLES)[number];

export const PERIOD_STATES = ['OPEN', 'CLOSED', 'LOCKED'] as const;
export type PeriodState = (typeof PERIOD_STATES)[number];

export const LEGAL_FORMS = ['TRUST', 'SOCIETY', 'COMPANY', 'PROPRIETORSHIP', 'OTHER'] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

export const BANK_PURPOSES = ['FEES', 'SALARY', 'OPERATING'] as const;
export type BankPurpose = (typeof BANK_PURPOSES)[number];
export const FINANCE_ACCOUNT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type FinanceAccountStatus = (typeof FINANCE_ACCOUNT_STATUSES)[number];

/** What a journal was written for. One small posting rule per event. */
export const JOURNAL_EVENT_TYPES = [
  'bill.issued', 'latefee.issued', 'credit_note.issued', 'debit_note.issued', 'journal.reversed',
  'collection.posted', 'receipt.cancelled', 'refund.paid', 'payroll.finalized', 'salary.paid', 'expense.posted', 'vendor_bill.posted', 'vendor_payment.posted', 'opening.balance', 'manual',
] as const;
export type JournalEventType = (typeof JOURNAL_EVENT_TYPES)[number];

export const APPROVAL_ACTIONS = ['REFUND', 'CREDIT_NOTE', 'WAIVER', 'CONCESSION', 'PAYROLL_FINALIZE', 'PERIOD_CLOSE', 'BANK_DETAIL_CHANGE', 'SYSTEM_ROLE_CHANGE', 'RECON_OVERRIDE'] as const;
export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];
export const APPROVAL_DECISIONS = ['PENDING', 'APPROVED', 'REJECTED', 'USED', 'CANCELLED'] as const;
export type ApprovalDecision = (typeof APPROVAL_DECISIONS)[number];

export const TAX_CATEGORIES = ['EXEMPT', 'NIL_RATED', 'OUT_OF_SCOPE', 'TAXABLE'] as const;
export type TaxCategory = (typeof TAX_CATEGORIES)[number];
export const PRICE_MODES = ['EXCLUSIVE', 'INCLUSIVE'] as const;
export type PriceMode = (typeof PRICE_MODES)[number];

export const FEE_CATEGORIES = ['TUITION', 'ADMISSION', 'ANNUAL', 'TRANSPORT', 'EXAM', 'ACTIVITY', 'DEPOSIT', 'LATE_FEE', 'OTHER'] as const;
export type FeeCategory = (typeof FEE_CATEGORIES)[number];
export const FEE_HEAD_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type FeeHeadStatus = (typeof FEE_HEAD_STATUSES)[number];

export const FEE_FREQUENCIES = ['ONE_TIME', 'MONTHLY', 'QUARTERLY', 'TERM', 'HALF_YEARLY', 'YEARLY'] as const;
export type FeeFrequency = (typeof FEE_FREQUENCIES)[number];
export const PRORATION_METHODS = ['FULL_PERIOD', 'CALENDAR_DAYS', 'NONE'] as const;
export type ProrationMethod = (typeof PRORATION_METHODS)[number];
export const PLAN_VERSION_STATES = ['DRAFT', 'APPROVED', 'PUBLISHED', 'SUPERSEDED', 'ARCHIVED'] as const;
export type PlanVersionState = (typeof PLAN_VERSION_STATES)[number];
export const STUDENT_TYPES = ['ALL', 'NEW', 'EXISTING'] as const;
export type FeeStudentType = (typeof STUDENT_TYPES)[number];

export const ASSIGNMENT_SOURCES_FEE = ['AUTO', 'MANUAL', 'IMPORT'] as const;
export type FeeAssignmentSource = (typeof ASSIGNMENT_SOURCES_FEE)[number];
export const ASSIGNMENT_EXCEPTION_REASONS = ['NO_PLAN', 'PLAN_CONFLICT', 'ALREADY_ASSIGNED', 'NOT_ENROLLED'] as const;
export type AssignmentExceptionReason = (typeof ASSIGNMENT_EXCEPTION_REASONS)[number];

export const CONCESSION_TYPES = ['SIBLING', 'STAFF_CHILD', 'MERIT', 'NEED', 'SPORTS', 'MANAGEMENT', 'SPONSOR'] as const;
export type ConcessionType = (typeof CONCESSION_TYPES)[number];
/** PERCENT values are basis points (1000 = 10%). FIXED values are paise per period for each covered fee. */
export const CONCESSION_VALUE_TYPES = ['PERCENT', 'FIXED'] as const;
export type ConcessionValueType = (typeof CONCESSION_VALUE_TYPES)[number];
export const STACK_MODES = ['STACK', 'HIGHEST_WINS'] as const;
export type StackMode = (typeof STACK_MODES)[number];
export const AWARD_STATUSES = ['DRAFT', 'PENDING', 'APPROVED', 'REJECTED', 'ENDED'] as const;
export type AwardStatus = (typeof AWARD_STATUSES)[number];

export const LATE_FEE_KINDS = ['FIXED', 'PERCENT'] as const;
export type LateFeeKind = (typeof LATE_FEE_KINDS)[number];
export const LATE_FEE_PERIODS = ['ONCE', 'PER_DAY', 'PER_MONTH'] as const;
export type LateFeePeriod = (typeof LATE_FEE_PERIODS)[number];

export const BILLING_RUN_STATES = ['DRAFT', 'VALIDATED', 'APPROVED', 'ISSUED', 'CANCELLED'] as const;
export type BillingRunState = (typeof BILLING_RUN_STATES)[number];
export const BILLING_ROW_STATUSES = ['READY', 'NEEDS_ATTENTION', 'ISSUED', 'SKIPPED'] as const;
export type BillingRowStatus = (typeof BILLING_ROW_STATUSES)[number];
export const BILLING_REASONS = ['NO_PLAN', 'PLAN_CONFLICT', 'TAX_CODE_MISSING', 'STUDENT_NOT_ENROLLED', 'ALREADY_BILLED', 'PERIOD_CLOSED', 'AWARD_EXPIRED', 'NOTHING_DUE'] as const;
export type BillingReason = (typeof BILLING_REASONS)[number];

export const DOCUMENT_KINDS = ['BILL', 'LATE_FEE', 'CREDIT_NOTE', 'DEBIT_NOTE', 'OPENING'] as const;
export type FeeDocumentKind = (typeof DOCUMENT_KINDS)[number];
export const FEE_DOCUMENT_STATUSES = ['ISSUED', 'PARTIALLY_SETTLED', 'SETTLED', 'CANCELLED'] as const;
export type FeeDocumentStatus = (typeof FEE_DOCUMENT_STATUSES)[number];

export const LEDGER_KINDS = ['BILL', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PAYMENT', 'ADVANCE_IN', 'ADVANCE_USED', 'REFUND', 'REVERSAL'] as const;
export type LedgerKind = (typeof LEDGER_KINDS)[number];
/** Entries that move what the student owes. The others move money the school holds for the student (an advance). */
export const DUES_LEDGER_KINDS: readonly LedgerKind[] = ['BILL', 'CREDIT_NOTE', 'DEBIT_NOTE', 'PAYMENT', 'REVERSAL'];
export const ADVANCE_LEDGER_KINDS: readonly LedgerKind[] = ['ADVANCE_IN', 'ADVANCE_USED', 'REFUND'];

export const ADJUSTMENT_TYPES = ['CREDIT_NOTE', 'DEBIT_NOTE', 'WAIVER', 'LATE_FEE_REVERSAL'] as const;
export type AdjustmentType = (typeof ADJUSTMENT_TYPES)[number];
export const ADJUSTMENT_STATUSES = ['DRAFT', 'APPLIED', 'CANCELLED'] as const;
export type AdjustmentStatus = (typeof ADJUSTMENT_STATUSES)[number];

export const AGING_BUCKETS = ['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as const;
export type AgingBucket = (typeof AGING_BUCKETS)[number];

export const READINESS_STATUSES = ['DONE', 'NEEDS_ATTENTION', 'NOT_NEEDED'] as const;
export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

export const TAX_EXAMPLE_NOTE = 'Example only. Confirm with your accountant.';

/** Domain events written to `outbox_events` in the same transaction as the change. */
export const FINANCE_EVENT_TYPES = [
  'fee_plan.published', 'fee_assignment.created', 'fee_demand.issued', 'fee_demand.adjusted', 'journal.posted', 'journal.reversed', 'approval.decided', 'financial_year.created',
] as const;
export type FinanceEventType = (typeof FINANCE_EVENT_TYPES)[number];

// ───────────────────────────────────────────────────────────── setup shapes

export interface LegalEntityDTO {
  legalEntityId: string;
  name: string;
  legalForm: LegalForm;
  pan: string | null;
  gstin: string | null;
  gstRegistered: boolean;
  stateCode: string | null;
  stateName: string | null;
  address: string | null;
  currency: 'INR';
  fyStartMonth: number;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface FinancialYearDTO {
  financialYearId: string;
  code: string;
  startDate: string;
  endDate: string;
  periods: AccountingPeriodDTO[];
}

export interface AccountingPeriodDTO {
  periodId: string;
  financialYearId: string;
  code: string;
  month: number;
  startDate: string;
  endDate: string;
  state: PeriodState;
}

export interface AccountDTO {
  accountId: string;
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  normalBalance: NormalBalance;
  systemRole: SystemAccountRole | null;
  isPostable: boolean;
  status: FinanceAccountStatus;
  hasEntries: boolean;
}

export interface BankAccountDTO {
  bankAccountId: string;
  label: string;
  bankName: string;
  holderName: string | null;
  accountNumberMasked: string;
  ifsc: string;
  purpose: BankPurpose;
  glAccountId: string;
  locationIds: string[];
  status: FinanceAccountStatus;
  pendingApprovalId: string | null;
}

export interface CashAccountDTO {
  cashAccountId: string;
  label: string;
  glAccountId: string;
  locationIds: string[];
  status: FinanceAccountStatus;
}

export interface RevealedBankNumberDTO {
  bankAccountId: string;
  accountNumber: string;
}

export interface JournalLineDTO {
  accountId: string;
  accountCode: string;
  accountName: string;
  debitPaise: number;
  creditPaise: number;
  locationId: string | null;
  studentId: string | null;
  employeeId: string | null;
  vendorId: string | null;
}

export interface JournalDTO {
  journalId: string;
  number: string;
  accountingDate: string;
  periodId: string;
  eventType: JournalEventType;
  sourceKey: string;
  sourceType: string | null;
  sourceId: string | null;
  memo: string;
  totalPaise: number;
  reversesId: string | null;
  reversedById: string | null;
  postedBy: string | null;
  postedAt: string;
  lines: JournalLineDTO[];
}

export interface JournalDetailDTO extends JournalDTO {
  /** The record this entry came from, with a link target for the screen. */
  source: { type: string; id: string; label: string } | null;
}

export interface GeneralLedgerDTO {
  account: { accountId: string; code: string; name: string; normalBalance: NormalBalance };
  openingPaise: number;
  rows: { date: string; journalId: string; number: string; memo: string; debitPaise: number; creditPaise: number; balancePaise: number }[];
  closingPaise: number;
}

export interface TrialBalanceDTO {
  asOf: string;
  rows: { accountId: string; code: string; name: string; type: AccountType; debitPaise: number; creditPaise: number }[];
  totalDebitPaise: number;
  totalCreditPaise: number;
  balanced: boolean;
}

// ───────────────────────────────────────────────────────────── approvals and audit

export interface ApprovalPolicyDTO {
  policyId: string;
  action: ApprovalAction;
  thresholdPaise: number | null;
  needsDifferentApprover: boolean;
  enabled: boolean;
  description: string;
}

export interface ApprovalRequestDTO {
  approvalId: string;
  action: ApprovalAction;
  entityType: string;
  entityId: string | null;
  amountPaise: number;
  summary: string;
  impact: string;
  reason: string | null;
  requestedBy: string;
  requestedByName: string | null;
  decision: ApprovalDecision;
  decidedBy: string | null;
  decidedByName: string | null;
  decisionReason: string | null;
  decidedAt: string | null;
  createdAt: string;
}

export interface FinanceAuditEventDTO {
  auditId: string;
  actorId: string | null;
  actorName: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  correlationId: string | null;
  occurredAt: string;
}

export interface FinanceAccessDTO {
  userId: string;
  fullName: string;
  email: string;
  role: 'SCHOOL_ADMIN' | 'FACULTY' | 'STAFF' | 'PARENT';
  bundles: import('./permissions').FinanceBundle[];
  locationIds: string[] | null;
}

// ───────────────────────────────────────────────────────────── tax

export interface TaxProfileDTO {
  gstRegistered: boolean;
  gstin: string | null;
  stateCode: string | null;
  stateName: string | null;
  note: string;
}

export interface TaxCodeDTO {
  taxCodeId: string;
  code: string;
  name: string;
  category: TaxCategory;
  rateBps: number;
  hsnSac: string | null;
  note: string;
  status: 'ACTIVE' | 'ENDED';
  inUse: boolean;
}

export interface TaxCalculationDTO {
  amountPaise: number;
  priceMode: PriceMode;
  rateBps: number;
  intraState: boolean;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  /** What the payer pays: taxable + tax when the price was exclusive, the price itself when inclusive. */
  totalPaise: number;
  explanation: string;
}

// ───────────────────────────────────────────────────────────── fees

export interface FeeHeadDTO {
  feeHeadId: string;
  code: string;
  name: string;
  category: FeeCategory;
  incomeAccountId: string;
  incomeAccountName: string | null;
  taxCodeId: string | null;
  taxCodeName: string | null;
  priceMode: PriceMode;
  isRecurring: boolean;
  isOptional: boolean;
  isRefundableDeposit: boolean;
  status: FeeHeadStatus;
  inUse: boolean;
}

export interface FeePlanItemDTO {
  itemId: string;
  feeHeadId: string;
  feeHeadName: string;
  amountPaise: number;
  frequency: FeeFrequency;
  dueDay: number;
  graceDays: number;
  prorationMethod: ProrationMethod;
  isOptional: boolean;
}

export interface FeePlanVersionDTO {
  versionId: string;
  planId: string;
  versionNo: number;
  effectiveFrom: string;
  state: PlanVersionState;
  items: FeePlanItemDTO[];
  /** Total of the items a student pays in one full session, optional items left out. */
  yearlyPaise: number;
  approvedBy: string | null;
  publishedAt: string | null;
}

export interface FeePlanDTO {
  planId: string;
  name: string;
  sessionId: string;
  appliesTo: { locationIds: string[]; classIds: string[]; studentType: FeeStudentType; studentId: string | null };
  autoAssign: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
  latestVersion: FeePlanVersionDTO | null;
  publishedVersion: FeePlanVersionDTO | null;
  versions: { versionId: string; versionNo: number; state: PlanVersionState; effectiveFrom: string }[];
}

export interface PlanValidationDTO {
  versionId: string;
  ok: boolean;
  problems: { code: string; message: string; itemId?: string }[];
}

export interface AssignmentRowDTO {
  studentId: string;
  studentName: string;
  admissionNumber: string | null;
  classOfferingId: string;
  className: string;
  status: 'READY' | AssignmentExceptionReason;
  planVersionId: string | null;
  planName: string | null;
  candidatePlans: { versionId: string; planName: string }[];
  reason: string | null;
}

export interface AssignmentRecommendationDTO {
  sessionId: string;
  locationId: string;
  classes: { classOfferingId: string; className: string; eligible: number; ready: number; needReview: number; alreadyAssigned: number }[];
  totals: { eligible: number; ready: number; needReview: number; alreadyAssigned: number };
  expectedPaise: number;
  rows: AssignmentRowDTO[];
}

export interface BulkAssignResultDTO {
  done: number;
  skipped: number;
  expectedPaise: number;
  results: { studentId: string; status: 'ASSIGNED' | 'SKIPPED'; reason: AssignmentExceptionReason | null; message: string | null }[];
}

export interface StudentAssignmentDTO {
  assignmentId: string;
  studentId: string;
  sessionId: string;
  planVersionId: string;
  planName: string;
  optionalItemIds: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  source: FeeAssignmentSource;
}

export interface ConcessionPolicyDTO {
  policyId: string;
  name: string;
  type: ConcessionType;
  valueType: ConcessionValueType;
  value: number;
  feeHeadIds: string[];
  stackMode: StackMode;
  capPercentBps: number | null;
  validFrom: string | null;
  validTo: string | null;
  needsEvidence: boolean;
  needsApproval: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface ConcessionAwardDTO {
  awardId: string;
  studentId: string;
  studentName: string;
  policyId: string;
  policyName: string;
  type: ConcessionType;
  valueType: ConcessionValueType;
  value: number;
  status: AwardStatus;
  reason: string | null;
  validFrom: string | null;
  validTo: string | null;
  evidenceFileId: string | null;
  decidedBy: string | null;
}

export interface ConcessionSuggestionDTO {
  studentId: string;
  studentName: string;
  type: 'SIBLING' | 'STAFF_CHILD';
  policyId: string;
  policyName: string;
  reason: string;
  alreadyAwarded: boolean;
}

export interface LateFeePolicyDTO {
  policyId: string;
  feeHeadId: string;
  kind: LateFeeKind;
  period: LateFeePeriod;
  /** FIXED: paise. PERCENT: basis points of the overdue balance. */
  value: number;
  graceDays: number;
  capPaise: number | null;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface LateFeePreviewDTO {
  asOf: string;
  count: number;
  totalPaise: number;
  items: { billId: string; billNumber: string; studentId: string; studentName: string; overduePaise: number; daysLate: number; feePaise: number; formula: string; alreadyCharged: boolean }[];
}

export interface BillingRunDTO {
  runId: string;
  periodKey: string;
  sessionId: string;
  locationId: string;
  classIds: string[];
  issueDate: string;
  dueDate: string | null;
  state: BillingRunState;
  counts: { ready: number; needsAttention: number; issued: number; skipped: number };
  totalPaise: number;
  createdAt: string;
}

export interface BillingRowDTO {
  rowId: string;
  studentId: string;
  studentName: string;
  className: string | null;
  status: BillingRowStatus;
  reasonCode: BillingReason | null;
  reasonText: string | null;
  fixHint: string | null;
  totalPaise: number;
  documentId: string | null;
}

export interface BillingValidationDTO {
  run: BillingRunDTO;
  headline: string;
  byReason: { reasonCode: BillingReason; count: number }[];
}

export interface BillingCommitDTO {
  run: BillingRunDTO;
  issued: number;
  failed: number;
  alreadyIssued: number;
  totalPaise: number;
}

export interface FeeDocumentLineDTO {
  lineId: string;
  feeHeadId: string;
  description: string;
  basePaise: number;
  discountPaise: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  explanation: string;
}

export interface FeeDocumentDTO {
  documentId: string;
  number: string;
  kind: FeeDocumentKind;
  studentId: string;
  studentName: string;
  periodKey: string | null;
  issueDate: string;
  dueDate: string;
  status: FeeDocumentStatus;
  totalPaise: number;
  paidPaise: number;
  creditedPaise: number;
  balancePaise: number;
  overdue: boolean;
  parentDocumentId: string | null;
  journalId: string | null;
  isTaxInvoice: boolean;
  lines: FeeDocumentLineDTO[];
}

export interface FeeDocumentListDTO {
  items: Omit<FeeDocumentDTO, 'lines'>[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdjustmentResultDTO {
  adjustmentId: string;
  type: AdjustmentType;
  documentId: string;
  newDocumentId: string;
  newDocumentNumber: string;
  amountPaise: number;
  appliedToBillPaise: number;
  advancePaise: number;
  billBalancePaise: number;
  journalId: string;
}

export interface StudentAccountDTO {
  studentId: string;
  studentName: string;
  admissionNumber: string | null;
  className: string | null;
  locationId: string | null;
  billedPaise: number;
  concessionPaise: number;
  taxPaise: number;
  creditedPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  overduePaise: number;
  advancePaise: number;
  /** Future instalments. Shown apart and never counted as owed. */
  expectedLaterPaise: number;
  assignment: StudentAssignmentDTO | null;
}

export interface LedgerEntryDTO {
  entryId: string;
  date: string;
  kind: LedgerKind;
  amountPaise: number;
  documentId: string | null;
  documentNumber: string | null;
  journalId: string | null;
  description: string;
}

export interface BalanceExplanationDTO {
  studentId: string;
  lines: { label: string; amountPaise: number; sign: '+' | '-'; documentId: string | null; journalId: string | null }[];
  totalPaise: number;
  sentence: string;
}

export interface UpcomingDTO {
  items: { periodKey: string; dueDate: string; totalPaise: number; lines: { description: string; totalPaise: number }[] }[];
  totalPaise: number;
}

export interface StatementDTO {
  studentId: string;
  studentName: string;
  from: string;
  to: string;
  openingPaise: number;
  rows: LedgerEntryDTO[];
  closingPaise: number;
}

export interface OutstandingDTO {
  asOf: string;
  buckets: { bucket: AgingBucket; count: number; totalPaise: number }[];
  byClass: { classOfferingId: string; className: string; totalPaise: number; students: number }[];
  totalPaise: number;
  rows: { studentId: string; studentName: string; className: string | null; locationId: string | null; outstandingPaise: number; overduePaise: number; oldestDueDate: string | null; bucket: AgingBucket }[];
}

export interface FamilyDTO {
  guardianPersonId: string;
  guardianName: string;
  children: StudentAccountDTO[];
  totals: { billedPaise: number; paidPaise: number; outstandingPaise: number; overduePaise: number; advancePaise: number };
}

export interface ParentFeeSummaryDTO {
  children: { studentId: string; studentName: string; className: string | null; outstandingPaise: number; overduePaise: number; advancePaise: number; nextDueDate: string | null; nextDuePaise: number }[];
}

export interface ParentStudentFeesDTO {
  studentId: string;
  studentName: string;
  outstandingPaise: number;
  overduePaise: number;
  advancePaise: number;
  bills: { documentId: string; number: string; kind: FeeDocumentKind; issueDate: string; dueDate: string; status: FeeDocumentStatus; totalPaise: number; balancePaise: number; overdue: boolean; lines: { description: string; discountPaise: number; taxPaise: number; totalPaise: number }[] }[];
  howToPay: { bankName: string; holderName: string | null; accountLast4: string; ifsc: string; instructions: string } | null;
}

export interface StudentClearanceDTO {
  studentId: string;
  status: 'CLEAR' | 'DUES' | 'PENDING_CLAIMS';
  billedPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  pendingClaims: number;
  refundableAdvancePaise: number;
  refundableDepositPaise: number;
}

export interface FinanceReadinessItemDTO {
  key: string;
  title: string;
  status: ReadinessStatus;
  sentence: string;
  fix: { label: string; path: string } | null;
}

export interface FinanceReadinessDTO {
  items: FinanceReadinessItemDTO[];
  ready: number;
  total: number;
  headline: string;
}
