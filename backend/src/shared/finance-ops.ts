/**
 * Module 7, Part 3 — collections, banking, payroll, expenses, tax, close and reports. Enums and the shapes that leave the API.
 * Money is whole paise in every `…Paise` field. Dates are `YYYY-MM-DD`. Screens show rupees; the API never does.
 */

import type { AgingBucket } from './finance';

// ───────────────────────────────────────────────────────────── 3A collections

export const PAYMENT_METHODS = ['CASH', 'CHEQUE', 'UPI', 'NEFT', 'RTGS', 'IMPS', 'BANK_DEPOSIT', 'OTHER'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
/** Money that reaches the school's bank. These wait for a person to confirm they really arrived. */
export const BANK_METHODS: readonly PaymentMethod[] = ['UPI', 'NEFT', 'RTGS', 'IMPS', 'BANK_DEPOSIT', 'OTHER'];

export const CLAIM_STATUSES = ['REPORTED', 'PENDING_VERIFICATION', 'VERIFIED', 'REJECTED'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];

export const COLLECTION_STATUSES = ['RECEIVED', 'DEPOSITED', 'PENDING_VERIFICATION', 'VERIFIED', 'POSTED', 'CLEARED', 'RETURNED', 'REVERSED', 'REJECTED'] as const;
export type CollectionStatus = (typeof COLLECTION_STATUSES)[number];
/** Money that counts as received: verified, posted or cleared. */
export const FUNDED_STATUSES: readonly CollectionStatus[] = ['VERIFIED', 'POSTED', 'CLEARED'];

export const COLLECTION_FLAGS = ['DUPLICATE_SUSPECTED', 'AMOUNT_MISMATCH', 'BANK_CREDIT_NOT_FOUND'] as const;
export type CollectionFlag = (typeof COLLECTION_FLAGS)[number];

export const REFUND_STATES = ['REQUESTED', 'ELIGIBLE', 'APPROVED', 'PAID', 'REJECTED'] as const;
export type RefundState = (typeof REFUND_STATES)[number];

export const SHIFT_STATES = ['OPEN', 'CLOSED', 'SIGNED_OFF'] as const;
export type ShiftState = (typeof SHIFT_STATES)[number];

export interface AllocationInput {
  studentId: string;
  /** The bill to pay. Leave out to let the system pay the oldest bills first. */
  documentId?: string | undefined;
  amountPaise: number;
}

export interface ChequeInfoDTO {
  number: string;
  bankName: string;
  chequeDate: string;
  payerName: string | null;
}

export interface ClaimDTO {
  claimId: string;
  status: ClaimStatus;
  method: PaymentMethod;
  amountPaise: number;
  paidOn: string;
  reference: string | null;
  students: { studentId: string; studentName: string; amountPaise: number }[];
  flags: CollectionFlag[];
  hasProof: boolean;
  reportedByName: string | null;
  reportedByParent: boolean;
  rejectReason: string | null;
  collectionId: string | null;
  createdAt: string;
}

export interface AllocationDTO {
  allocationId: string;
  studentId: string;
  studentName: string;
  documentId: string;
  documentNumber: string;
  amountPaise: number;
  status: 'ACTIVE' | 'REVERSED';
  reversalOfId: string | null;
}

export interface CollectionDTO {
  collectionId: string;
  method: PaymentMethod;
  status: CollectionStatus;
  payerName: string | null;
  amountPaise: number;
  unallocatedPaise: number;
  receivedOn: string;
  reference: string | null;
  flags: CollectionFlag[];
  cheque: ChequeInfoDTO | null;
  provisionalNumber: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
  claimId: string | null;
  shiftId: string | null;
  bankAccountId: string | null;
  cashAccountId: string | null;
  students: { studentId: string; studentName: string }[];
  /** What will be applied when a waiting payment is verified or a cheque clears. */
  plannedAllocations: { studentId: string; studentName: string; documentId: string | null; amountPaise: number }[];
  allocations: AllocationDTO[];
  cashierName: string | null;
  returnedReason: string | null;
  createdAt: string;
}

export interface CollectionListDTO {
  items: CollectionDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ReceiptDTO {
  receiptId: string;
  number: string;
  collectionId: string;
  status: 'ISSUED' | 'CANCELLED';
  amountPaise: number;
  advancePaise: number;
  method: PaymentMethod;
  receivedOn: string;
  payerName: string | null;
  lines: { studentId: string; studentName: string; documentNumber: string; amountPaise: number }[];
  cancelledReason: string | null;
  cancelledAt: string | null;
}

export interface ReceiptListDTO {
  items: ReceiptDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface CollectionResultDTO {
  collection: CollectionDTO;
  receipt: ReceiptDTO | null;
  /** True when this was a retry of a payment that was already recorded. */
  repeated: boolean;
}

export interface RefundDTO {
  refundId: string;
  number: string;
  studentId: string;
  studentName: string;
  state: RefundState;
  reason: string;
  amountPaise: number;
  fromAdvancePaise: number;
  fromDepositPaise: number;
  recipientName: string | null;
  requestedByName: string | null;
  approvedByName: string | null;
  paidOn: string | null;
  paidReference: string | null;
  createdAt: string;
}

export interface RefundableDTO {
  studentId: string;
  advancePaise: number;
  depositPaise: number;
  outstandingPaise: number;
  openRefundsPaise: number;
  refundablePaise: number;
  sentence: string;
}

export interface ShiftDTO {
  shiftId: string;
  cashierId: string;
  cashierName: string | null;
  locationId: string;
  cashAccountId: string;
  state: ShiftState;
  openingPaise: number;
  collectedPaise: number;
  refundedPaise: number;
  expectedPaise: number;
  countedPaise: number | null;
  variancePaise: number | null;
  varianceNote: string | null;
  depositedPaise: number;
  signedOffByName: string | null;
  openedAt: string;
  closedAt: string | null;
  sentence: string | null;
}

export interface CashDepositDTO {
  depositId: string;
  shiftIds: string[];
  bankAccountId: string;
  amountPaise: number;
  depositedOn: string;
  reference: string | null;
  journalId: string | null;
  matched: boolean;
}

export interface CashbookDTO {
  date: string;
  openingPaise: number;
  rows: { time: string; kind: string; description: string; inPaise: number; outPaise: number; shiftId: string | null }[];
  closingPaise: number;
  shifts: ShiftDTO[];
}

/** A report that screens render as a table and export as CSV. The basis line says exactly what the numbers are. */
export interface ReportColumn {
  key: string;
  label: string;
  kind: 'text' | 'money' | 'date' | 'number';
}
export interface ReportDTO {
  type: string;
  title: string;
  /** "Based on posted journals (accrual)" or "Operational view: money received". Always shown with the numbers. */
  basis: string;
  from: string | null;
  to: string | null;
  columns: ReportColumn[];
  rows: Record<string, string | number | null>[];
  totals: Record<string, number> | null;
  notes: string[];
}

export interface ClearanceSummaryDTO {
  studentId: string;
  status: 'CLEAR' | 'DUES' | 'PENDING_CLAIMS';
  billedPaise: number;
  paidPaise: number;
  outstandingPaise: number;
  pendingClaims: number;
  pendingClaimsPaise: number;
  refundableAdvancePaise: number;
  refundableDepositPaise: number;
  openRefunds: number;
  sentence: string;
}

export interface ImportPreviewDTO {
  kind: 'OPENING_BALANCES' | 'ASSIGNMENTS';
  rows: number;
  ready: number;
  problems: { row: number; message: string }[];
  totalPaise: number;
  fileHash: string;
  /** Present after a commit. */
  committed: boolean;
}

export interface ReminderPreviewDTO {
  minDaysOverdue: number;
  count: number;
  totalPaise: number;
  items: { studentId: string; studentName: string; guardianName: string | null; guardianEmail: string | null; billNumbers: string[]; overduePaise: number; oldestDaysLate: number }[];
}

export interface ReminderResultDTO {
  sent: number;
  skipped: number;
}

// ───────────────────────────────────────────────────────────── shared small shapes

export interface PagedDTO<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export type { AgingBucket };

// ───────────────────────────────────────────────────────────── 3B banking and reconciliation

export const LINE_STATUS_VALUES = ['UNMATCHED', 'SUGGESTED', 'AUTO_MATCHED', 'VERIFIED_MATCHED', 'PARTIAL', 'DUPLICATE_SUSPECTED', 'VARIANCE', 'IGNORED'] as const;
export type StatementLineStatus = (typeof LINE_STATUS_VALUES)[number];

export interface StatementImportDTO {
  importId: string;
  bankAccountId: string;
  fileName: string;
  rowCount: number;
  keptCount: number;
  skippedCount: number;
  creditsPaise: number;
  debitsPaise: number;
  openingPaise: number | null;
  closingPaise: number | null;
  fromDate: string;
  toDate: string;
  suspectedDuplicates: number;
  createdAt: string;
}

export interface StatementLineDTO {
  lineId: string;
  importId: string;
  bankAccountId: string;
  date: string;
  description: string;
  reference: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
  status: StatementLineStatus;
  matchId: string | null;
  ignoredReason: string | null;
}

export interface MatchCandidateDTO {
  type: string;
  id: string;
  label: string;
  amountPaise: number;
  date: string;
  reference: string | null;
  /** True when the money behind this item has already been checked by a person. */
  verified: boolean;
}

export interface MatchDTO {
  matchId: string;
  bankAccountId: string;
  state: 'SUGGESTED' | 'CONFIRMED' | 'REVERSED' | 'REJECTED';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'MANUAL';
  reasons: string[];
  auto: boolean;
  needsVerification: boolean;
  lines: StatementLineDTO[];
  targets: (MatchCandidateDTO & { amountPaise: number })[];
  linesPaise: number;
  targetsPaise: number;
}

export interface AutoMatchResultDTO {
  confirmed: number;
  suggested: number;
  unmatched: number;
  duplicates: number;
}

export interface ReconExceptionsDTO {
  bankAccountId: string;
  headline: string;
  counts: { imported: number; matched: number; waitingForVerification: number; amountMismatches: number; possibleDuplicates: number; unmatched: number; ignored: number };
  groups: { key: 'WAITING_FOR_VERIFICATION' | 'AMOUNT_MISMATCH' | 'POSSIBLE_DUPLICATE' | 'UNMATCHED'; title: string; items: { line: StatementLineDTO; matches: MatchDTO[]; candidates: MatchCandidateDTO[]; hint: string }[] }[];
  /** Items the school has recorded that the bank has not shown yet, like a cheque that has not cleared. They fade by themselves. */
  timingDifferences: MatchCandidateDTO[];
}

export interface ReconSummaryDTO {
  bankAccountId: string;
  asOf: string;
  balancePerBooksPaise: number;
  balancePerBankPaise: number | null;
  inBooksNotInBank: { label: string; amountPaise: number }[];
  inBankNotInBooks: { label: string; amountPaise: number }[];
  differencePaise: number;
  explained: boolean;
  sentence: string;
}

// ───────────────────────────────────────────────────────────── 3C payroll

export const PAY_DAY_BASES = ['CALENDAR_DAYS', 'FIXED_30', 'WORKING_DAYS'] as const;
export type PayDayBasis = (typeof PAY_DAY_BASES)[number];
export const PAYROLL_ROUNDINGS = ['NEAREST_RUPEE', 'PAISE'] as const;
export type PayrollRounding = (typeof PAYROLL_ROUNDINGS)[number];
export const COMPONENT_TYPES = ['EARNING', 'DEDUCTION', 'EMPLOYER_COST'] as const;
export type ComponentType = (typeof COMPONENT_TYPES)[number];
export const COMPONENT_CALCS = ['FIXED', 'PERCENT_OF_BASIC', 'PERCENT_OF_GROSS'] as const;
export type ComponentCalc = (typeof COMPONENT_CALCS)[number];
export const PAY_MODES = ['MONTHLY', 'DAILY', 'HOURLY'] as const;
export type PayMode = (typeof PAY_MODES)[number];
export const RUN_TYPES = ['MONTHLY', 'SUPPLEMENTARY', 'CORRECTION', 'FULL_FINAL'] as const;
export type RunType = (typeof RUN_TYPES)[number];
export const RUN_STATES = ['DRAFT', 'CALCULATED', 'APPROVED', 'FINALIZED', 'CANCELLED'] as const;
export type RunState = (typeof RUN_STATES)[number];
export const PAYOUT_STATUSES = ['UNPAID', 'PARTIALLY_PAID', 'PAID'] as const;
export type PayoutStatus = (typeof PAYOUT_STATUSES)[number];
export const STATUTORY_KINDS = ['PF', 'ESI', 'PT'] as const;
export type StatutoryKind = (typeof STATUTORY_KINDS)[number];
export const PAYROLL_EXCEPTIONS = ['MISSING_INPUT', 'NO_SALARY_ASSIGNED', 'PENDING_REVISION', 'BANK_UNVERIFIED', 'NEGATIVE_NET', 'ADVANCE_EXCEEDS_NET', 'JOINED_OR_EXITED_THIS_MONTH', 'RULE_UNAPPROVED'] as const;
export type PayrollExceptionCode = (typeof PAYROLL_EXCEPTIONS)[number];
export const DISBURSEMENT_ITEM_STATUSES = ['PENDING', 'PAID', 'FAILED', 'RETURNED'] as const;
export type DisbursementItemStatus = (typeof DISBURSEMENT_ITEM_STATUSES)[number];
export const ADVANCE_STATES = ['REQUESTED', 'APPROVED', 'PAID_OUT', 'CLOSED', 'CANCELLED'] as const;
export type AdvanceState = (typeof ADVANCE_STATES)[number];

export interface PayrollPolicyDTO {
  payDayBasis: PayDayBasis;
  rounding: PayrollRounding;
  approvalRequired: boolean;
  defaultBankAccountId: string | null;
  note: string;
}

export interface SalaryComponentDTO {
  componentId: string;
  code: string;
  name: string;
  type: ComponentType;
  calc: ComponentCalc;
  pfWage: boolean;
  esiWage: boolean;
  prorate: boolean;
  glAccountId: string | null;
  isSystem: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface StructureItemDTO {
  componentId: string;
  componentName: string;
  type: ComponentType;
  calc: ComponentCalc;
  /** Paise, when the component is a fixed amount. */
  amountPaise: number | null;
  /** Basis points, when the component is a percentage. */
  rateBps: number | null;
}

export interface StructureVersionDTO {
  versionId: string;
  structureId: string;
  versionNo: number;
  effectiveFrom: string;
  state: 'DRAFT' | 'APPROVED';
  items: StructureItemDTO[];
  approvedByName: string | null;
}

export interface SalaryStructureDTO {
  structureId: string;
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
  latestVersion: StructureVersionDTO | null;
  versions: { versionId: string; versionNo: number; state: 'DRAFT' | 'APPROVED'; effectiveFrom: string }[];
}

export interface CompensationDTO {
  assignmentId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  structureVersionId: string;
  structureName: string;
  mode: PayMode;
  /** Monthly basic for MONTHLY, the day rate for DAILY, the hour rate for HOURLY. */
  basicPaise: number;
  overrides: { componentId: string; amountPaise: number }[];
  effectiveFrom: string;
  effectiveTo: string | null;
  monthlyGrossPaise: number;
}

export interface SalaryRevisionDTO {
  revisionId: string;
  employeeId: string;
  employeeName: string;
  fromBasicPaise: number;
  toBasicPaise: number;
  effectiveDate: string;
  arrearPolicy: 'PAY_DIFFERENCE' | 'NONE';
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  reason: string;
  approvalId: string | null;
}

export interface PayrollInputDTO {
  inputId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  month: string;
  workingDays: number | null;
  paidLeaveDays: number;
  lopDays: number;
  unitsWorked: number | null;
  extras: { label: string; type: 'EARNING' | 'DEDUCTION'; amountPaise: number }[];
  source: 'MANUAL' | 'CSV';
}

export interface StatutoryRuleDTO {
  ruleId: string;
  kind: StatutoryKind;
  effectiveFrom: string;
  params: Record<string, unknown>;
  state: 'DRAFT' | 'APPROVED';
  demo: boolean;
  warning: string | null;
  approvedByName: string | null;
}

export interface TaxDeclarationDTO {
  declarationId: string;
  employeeId: string;
  fyCode: string;
  regime: 'NEW' | 'OLD';
  estimatedYearlyTaxPaise: number;
  alreadyDeductedPaise: number;
  monthlyPaise: number;
  note: string | null;
}

export interface AdvanceDTO {
  advanceId: string;
  employeeId: string;
  employeeName: string;
  principalPaise: number;
  installments: number;
  installmentPaise: number;
  remainingPaise: number;
  startMonth: string;
  state: AdvanceState;
  reason: string;
  paidOn: string | null;
}

export interface RunExceptionDTO {
  code: PayrollExceptionCode;
  level: 'BLOCKER' | 'REVIEW';
  message: string;
  fixHint: string;
}

export interface RunEmployeeDTO {
  rowId: string;
  runId: string;
  employeeId: string;
  employeeName: string;
  employeeCode: string;
  departmentName: string | null;
  designationName: string | null;
  locationId: string | null;
  status: 'READY' | 'NEEDS_ACTION' | 'HELD';
  held: boolean;
  holdReason: string | null;
  grossPaise: number;
  deductionsPaise: number;
  employerCostPaise: number;
  netPaise: number;
  paidDays: string | null;
  exceptions: RunExceptionDTO[];
  paidOutPaise: number;
  payslipId: string | null;
}

export interface RunLineDTO {
  lineId: string;
  employeeId: string;
  kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_COST' | 'RECOVERY' | 'ARREAR';
  componentKey: string;
  label: string;
  amountPaise: number;
  formula: string;
}

export interface PayrollRunDTO {
  runId: string;
  number: string;
  month: string;
  type: RunType;
  state: RunState;
  payoutStatus: PayoutStatus;
  headline: string;
  counts: { employees: number; ready: number; needAction: number; held: number };
  totals: { grossPaise: number; deductionsPaise: number; employerCostPaise: number; netPaise: number };
  previousNetPaise: number | null;
  changeSentence: string | null;
  warnings: string[];
  locationId: string | null;
  parentRunId: string | null;
  preparedByName: string | null;
  approvedByName: string | null;
  finalizedAt: string | null;
  version: number;
  createdAt: string;
}

export interface RunExceptionsDTO {
  runId: string;
  blockers: number;
  items: (RunEmployeeDTO & { exceptions: RunExceptionDTO[] })[];
}

export interface PayslipDTO {
  payslipId: string;
  number: string;
  runId: string;
  month: string;
  employeeId: string;
  employeeName: string;
  published: boolean;
  grossPaise: number;
  deductionsPaise: number;
  netPaise: number;
  paidDays: string | null;
  lines: { kind: string; label: string; amountPaise: number; formula: string }[];
  school: string;
  department: string | null;
  designation: string | null;
}

export interface DisbursementItemDTO {
  itemId: string;
  employeeId: string;
  employeeName: string;
  amountPaise: number;
  status: DisbursementItemStatus;
  mode: 'BANK' | 'CASH' | 'CHEQUE';
  reference: string | null;
  paidOn: string | null;
  reason: string | null;
  verified: boolean;
  retryOfId: string | null;
}

export interface DisbursementBatchDTO {
  batchId: string;
  runId: string;
  month: string;
  bankAccountId: string;
  fileHash: string | null;
  state: 'BUILT' | 'RECORDED' | 'VERIFIED';
  totalPaise: number;
  paidPaise: number;
  verifiedPaise: number;
  items: DisbursementItemDTO[];
  skipped: { employeeId: string; employeeName: string; reason: string }[];
  createdAt: string;
}

export interface LiabilityDTO {
  unpaidSalaryPaise: number;
  unpaidByRun: { runId: string; month: string; number: string; unpaidPaise: number; ageDays: number }[];
  statutory: { role: string; label: string; payablePaise: number }[];
}

export interface MyPayrollSummaryDTO {
  employeeId: string;
  latestPayslip: { payslipId: string; month: string; netPaise: number } | null;
  openAdvancePaise: number;
  taxDeclaration: TaxDeclarationDTO | null;
}

// ───────────────────────────────────────────────────────────── 3D expenses, vendors and GST

export const ITC_STATUSES = ['ELIGIBLE', 'NOT_ELIGIBLE', 'NEEDS_REVIEW'] as const;
export type ItcStatus = (typeof ITC_STATUSES)[number];
export const EXPENSE_PAYMENT_MODES = ['BANK', 'CASH', 'UNPAID'] as const;
export type ExpensePaymentMode = (typeof EXPENSE_PAYMENT_MODES)[number];
export const EXPENSE_STATES = ['PENDING', 'POSTED', 'REJECTED', 'REVERSED'] as const;
export type ExpenseState = (typeof EXPENSE_STATES)[number];
export const VENDOR_BILL_STATES = ['PENDING', 'POSTED', 'PARTIALLY_PAID', 'PAID', 'REJECTED', 'REVERSED'] as const;
export type VendorBillState = (typeof VENDOR_BILL_STATES)[number];
export const GST_HEADS = ['CGST', 'SGST', 'IGST'] as const;
export type GstHead = (typeof GST_HEADS)[number];
export const GST_PAYMENT_KINDS = ['PAY_LIABILITY', 'USE_ITC'] as const;
export type GstPaymentKind = (typeof GST_PAYMENT_KINDS)[number];

export interface ExpenseCategoryDTO {
  categoryId: string;
  code: string;
  name: string;
  accountId: string;
  accountName: string | null;
  defaultItcStatus: ItcStatus;
  status: 'ACTIVE' | 'INACTIVE';
}

export interface VendorDTO {
  vendorId: string;
  name: string;
  gstin: string | null;
  stateCode: string | null;
  pan: string | null;
  contactName: string | null;
  phone: string | null;
  bankAccountMasked: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  status: 'ACTIVE' | 'INACTIVE';
  pendingApprovalId: string | null;
  payablePaise: number;
}

export interface TaxLineDTO {
  lineId: string;
  sourceType: 'expense' | 'vendor_bill';
  sourceId: string;
  sourceNumber: string;
  date: string;
  vendorName: string | null;
  taxableValuePaise: number;
  rateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  itcStatus: ItcStatus;
  decisionReason: string | null;
}

export interface ExpenseDTO {
  expenseId: string;
  number: string;
  state: ExpenseState;
  categoryId: string;
  categoryName: string;
  vendorId: string | null;
  vendorName: string | null;
  locationId: string;
  date: string;
  description: string;
  taxableValuePaise: number;
  taxPaise: number;
  totalPaise: number;
  paymentMode: ExpensePaymentMode;
  needsApproval: boolean;
  approved: boolean;
  waitingForItc: boolean;
  hasEvidence: boolean;
  journalId: string | null;
  createdByName: string | null;
  taxLines: TaxLineDTO[];
  createdAt: string;
}

export interface VendorBillDTO {
  billId: string;
  number: string;
  vendorId: string;
  vendorName: string;
  vendorBillNumber: string;
  state: VendorBillState;
  date: string;
  dueDate: string;
  lines: { description: string; categoryId: string; taxableValuePaise: number; rateBps: number; taxPaise: number }[];
  taxableValuePaise: number;
  taxPaise: number;
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
  needsApproval: boolean;
  approved: boolean;
  waitingForItc: boolean;
  locationId: string;
  journalId: string | null;
  taxLines: TaxLineDTO[];
}

export interface VendorPaymentDTO {
  paymentId: string;
  number: string;
  vendorId: string;
  vendorName: string;
  bankAccountId: string;
  amountPaise: number;
  paidOn: string;
  reference: string | null;
  allocations: { billId: string; billNumber: string; amountPaise: number }[];
  journalId: string | null;
}

export interface PayablesAgingDTO {
  asOf: string;
  buckets: { bucket: AgingBucket; count: number; totalPaise: number }[];
  totalPaise: number;
  rows: { billId: string; number: string; vendorName: string; dueDate: string; balancePaise: number; bucket: AgingBucket }[];
}

export interface GstPaymentDTO {
  paymentId: string;
  month: string;
  kind: GstPaymentKind;
  head: GstHead;
  amountPaise: number;
  challanRef: string | null;
  bankAccountId: string | null;
  paidOn: string;
  journalId: string | null;
}

export interface TaxReviewQueueDTO {
  total: number;
  groups: { key: 'FEE_HEADS_WITHOUT_TAX_CODE' | 'ITC_NEEDS_REVIEW' | 'TAXABLE_WITHOUT_GSTIN' | 'GST_DOES_NOT_MATCH_LEDGER'; title: string; count: number; items: { id: string; label: string; fix: { label: string; path: string } | null }[] }[];
}

// ───────────────────────────────────────────────────────────── 3E close, reports, attention

export interface CloseCheckDTO {
  key: string;
  title: string;
  level: 'BLOCKER' | 'WARNING' | 'INFO';
  count: number;
  sentence: string;
  fix: { label: string; path: string } | null;
}

export interface CloseReadinessDTO {
  periodId: string;
  periodCode: string;
  state: 'OPEN' | 'CLOSED' | 'LOCKED';
  checks: CloseCheckDTO[];
  blockers: number;
  warnings: number;
  /** "September close: 3 bank items + 2 salary payouts + 1 refund + 1 cash variance = 7 need attention." */
  headline: string;
  canClose: boolean;
}

export interface ClosedPeriodDTO {
  periodId: string;
  periodCode: string;
  state: 'OPEN' | 'CLOSED' | 'LOCKED';
  closedByName: string | null;
  closedAt: string | null;
  warningReason: string | null;
}

export interface FinanceAttentionItemDTO {
  id: string;
  label: string;
  fix: { action: string; label: string; path: string } | null;
}

export interface FinanceAttentionGroupDTO {
  key: 'FEE_SETUP' | 'BILLING' | 'COLLECTIONS' | 'BANKING' | 'PAYROLL' | 'PAYOUTS' | 'APPROVALS' | 'TAX' | 'CLOSE';
  title: string;
  count: number;
  items: FinanceAttentionItemDTO[];
}

export interface FinanceAttentionDTO {
  total: number;
  groups: FinanceAttentionGroupDTO[];
}

/** Finance Pulse. A tile the caller may not see is `null`, never zero. */
export interface FinanceOverviewDTO {
  asOf: string;
  collectionsTodayPaise: number | null;
  outstandingPaise: number | null;
  overduePaise: number | null;
  payrollPayablePaise: number | null;
  monthlyExpensesPaise: number | null;
  unreconciledBankLines: number | null;
  cashInHandPaise: number | null;
  attentionTotal: number;
}

export interface SearchResultDTO {
  type: 'student' | 'receipt' | 'bill' | 'payment' | 'cheque' | 'bank_line' | 'journal' | 'payroll_run' | 'payslip' | 'expense' | 'vendor';
  id: string;
  label: string;
  sub: string | null;
  path: string;
}

export interface OpeningPreviewDTO {
  rows: number;
  problems: { row: number; message: string }[];
  accountDebitPaise: number;
  accountCreditPaise: number;
  studentPaise: number;
  vendorPaise: number;
  advancePaise: number;
  balanced: boolean;
  fileHash: string;
  committed: boolean;
}

export const FINANCIAL_REPORT_TYPES = ['general-ledger', 'trial-balance', 'income-and-expenditure', 'balance-sheet', 'cashbook', 'bankbook', 'ar-aging', 'ap-aging', 'income-by-fee-head-and-location', 'payroll-expense-and-liability', 'collections-summary', 'outstanding'] as const;
export type FinancialReportType = (typeof FINANCIAL_REPORT_TYPES)[number];
