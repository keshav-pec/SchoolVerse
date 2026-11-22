import { Schema, model } from 'mongoose';
import {
  ADJUSTMENT_STATUSES, ADJUSTMENT_TYPES, ASSIGNMENT_SOURCES_FEE, AWARD_STATUSES, BILLING_REASONS, BILLING_ROW_STATUSES, BILLING_RUN_STATES, CONCESSION_TYPES, CONCESSION_VALUE_TYPES, DOCUMENT_KINDS,
  FEE_CATEGORIES, FEE_DOCUMENT_STATUSES, FEE_FREQUENCIES, FEE_HEAD_STATUSES, LATE_FEE_KINDS, LATE_FEE_PERIODS, LEDGER_KINDS, PLAN_VERSION_STATES, PRICE_MODES, PRORATION_METHODS, STACK_MODES, STUDENT_TYPES,
  type AdjustmentStatus, type AdjustmentType, type AwardStatus, type BillingReason, type BillingRowStatus, type BillingRunState, type ConcessionType, type ConcessionValueType, type FeeAssignmentSource,
  type FeeCategory, type FeeDocumentKind, type FeeDocumentStatus, type FeeFrequency, type FeeHeadStatus, type FeeStudentType, type LateFeeKind, type LateFeePeriod, type LedgerKind, type PlanVersionState, type PriceMode, type ProrationMethod, type StackMode,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../../db/plugins/base';
import { tenantScopePlugin } from '../../../db/plugins/tenant-scope';
import { immutablePlugin } from '../core/immutable';

/** Module 7 fee collections. Every row stores `tenantId`, `schoolId` and `legalEntityId`. Money is whole paise; rates are basis points. */

const common = {
  tenantId: { type: String, required: true, immutable: true },
  schoolId: { type: String, required: true, immutable: true },
  legalEntityId: { type: String, required: true, immutable: true },
} as const;
interface FinanceCommon {
  tenantId: string;
  schoolId: string;
  legalEntityId: string;
}

// ───────────────────────────────────────────────────────────── fee heads (FEE-01)

export interface FeeHeadDoc extends BaseDoc, FinanceCommon, AuditFields {
  code: string;
  name: string;
  category: FeeCategory;
  incomeAccountId: string;
  taxCodeId: string | null;
  priceMode: PriceMode;
  isRecurring: boolean;
  isOptional: boolean;
  isRefundableDeposit: boolean;
  status: FeeHeadStatus;
}
const feeHeadSchema = new Schema<FeeHeadDoc>(
  {
    ...uuidPrimaryKey, ...common,
    code: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: FEE_CATEGORIES, default: 'OTHER' },
    incomeAccountId: { type: String, required: true },
    taxCodeId: { type: String, default: null },
    priceMode: { type: String, enum: PRICE_MODES, default: 'EXCLUSIVE' },
    isRecurring: { type: Boolean, default: false },
    isOptional: { type: Boolean, default: false },
    isRefundableDeposit: { type: Boolean, default: false, immutable: true },
    status: { type: String, enum: FEE_HEAD_STATUSES, default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('fee_heads'),
);
feeHeadSchema.index({ tenantId: 1, legalEntityId: 1, code: 1 }, { unique: true });
feeHeadSchema.plugin(tenantScopePlugin);
export const FeeHead = model<FeeHeadDoc>('FeeHead', feeHeadSchema);

// ───────────────────────────────────────────────────────────── fee plans, versions and items (FEE-02, 03)

export interface FeePlanDoc extends BaseDoc, FinanceCommon, AuditFields {
  name: string;
  sessionId: string;
  appliesTo: { locationIds: string[]; classIds: string[]; studentType: FeeStudentType; studentId: string | null };
  autoAssign: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
}
const appliesToSchema = new Schema(
  { locationIds: { type: [String], default: [] }, classIds: { type: [String], default: [] }, studentType: { type: String, enum: STUDENT_TYPES, default: 'ALL' }, studentId: { type: String, default: null } },
  { _id: false },
);
const feePlanSchema = new Schema<FeePlanDoc>(
  { ...uuidPrimaryKey, ...common, name: { type: String, required: true, trim: true }, sessionId: { type: String, required: true, immutable: true }, appliesTo: { type: appliesToSchema, required: true }, autoAssign: { type: Boolean, default: false }, status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' }, ...auditFields },
  baseSchemaOptions('fee_plans'),
);
feePlanSchema.index({ tenantId: 1, legalEntityId: 1, sessionId: 1, status: 1 });
feePlanSchema.plugin(tenantScopePlugin);
export const FeePlan = model<FeePlanDoc>('FeePlan', feePlanSchema);

export interface FeePlanVersionDoc extends BaseDoc, FinanceCommon, AuditFields {
  planId: string;
  versionNo: number;
  effectiveFrom: string;
  state: PlanVersionState;
  approvedBy: string | null;
  approvedAt: Date | null;
  publishedBy: string | null;
  publishedAt: Date | null;
}
const feePlanVersionSchema = new Schema<FeePlanVersionDoc>(
  {
    ...uuidPrimaryKey, ...common,
    planId: { type: String, required: true, immutable: true },
    versionNo: { type: Number, required: true, immutable: true },
    effectiveFrom: { type: String, required: true },
    state: { type: String, enum: PLAN_VERSION_STATES, default: 'DRAFT' },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    publishedBy: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    ...auditFields,
  },
  baseSchemaOptions('fee_plan_versions'),
);
feePlanVersionSchema.index({ tenantId: 1, planId: 1, versionNo: 1 }, { unique: true });
feePlanVersionSchema.plugin(tenantScopePlugin);
export const FeePlanVersion = model<FeePlanVersionDoc>('FeePlanVersion', feePlanVersionSchema);

export interface FeePlanItemDoc extends BaseDoc, FinanceCommon {
  planId: string;
  versionId: string;
  feeHeadId: string;
  amountPaise: number;
  frequency: FeeFrequency;
  dueDay: number;
  graceDays: number;
  prorationMethod: ProrationMethod;
  isOptional: boolean;
  sortOrder: number;
}
const feePlanItemSchema = new Schema<FeePlanItemDoc>(
  {
    ...uuidPrimaryKey, ...common,
    planId: { type: String, required: true, immutable: true },
    versionId: { type: String, required: true, immutable: true },
    feeHeadId: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    frequency: { type: String, enum: FEE_FREQUENCIES, required: true },
    dueDay: { type: Number, default: 10 },
    graceDays: { type: Number, default: 0 },
    prorationMethod: { type: String, enum: PRORATION_METHODS, default: 'FULL_PERIOD' },
    isOptional: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },
  },
  baseSchemaOptions('fee_plan_items'),
);
feePlanItemSchema.index({ tenantId: 1, versionId: 1, sortOrder: 1 });
feePlanItemSchema.plugin(tenantScopePlugin);
export const FeePlanItem = model<FeePlanItemDoc>('FeePlanItem', feePlanItemSchema);

// ───────────────────────────────────────────────────────────── student assignments (FEE-04)

export interface StudentFeeAssignmentDoc extends BaseDoc, FinanceCommon, AuditFields {
  studentId: string;
  enrollmentId: string;
  sessionId: string;
  locationId: string;
  classOfferingId: string;
  planVersionId: string;
  optionalItemIds: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  source: FeeAssignmentSource;
  /** OPEN until it is ended. An ended assignment is history and is kept. */
  state: 'OPEN' | 'ENDED';
}
const assignmentSchema = new Schema<StudentFeeAssignmentDoc>(
  {
    ...uuidPrimaryKey, ...common,
    studentId: { type: String, required: true, immutable: true },
    enrollmentId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    classOfferingId: { type: String, required: true, immutable: true },
    planVersionId: { type: String, required: true },
    optionalItemIds: { type: [String], default: [] },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    source: { type: String, enum: ASSIGNMENT_SOURCES_FEE, default: 'MANUAL' },
    state: { type: String, enum: ['OPEN', 'ENDED'], default: 'OPEN' },
    ...auditFields,
  },
  baseSchemaOptions('student_fee_assignments'),
);
// One open assignment per student per session, enforced by the database even when two requests race.
assignmentSchema.index({ tenantId: 1, studentId: 1, sessionId: 1 }, { unique: true, partialFilterExpression: { state: 'OPEN' }, name: 'one_open_fee_assignment_per_session' });
assignmentSchema.index({ tenantId: 1, sessionId: 1, locationId: 1, state: 1 });
assignmentSchema.plugin(tenantScopePlugin);
export const StudentFeeAssignment = model<StudentFeeAssignmentDoc>('StudentFeeAssignment', assignmentSchema);

// ───────────────────────────────────────────────────────────── concessions (FEE-05, 06)

export interface ConcessionPolicyDoc extends BaseDoc, FinanceCommon, AuditFields {
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
const concessionPolicySchema = new Schema<ConcessionPolicyDoc>(
  {
    ...uuidPrimaryKey, ...common,
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: CONCESSION_TYPES, required: true, immutable: true },
    valueType: { type: String, enum: CONCESSION_VALUE_TYPES, required: true, immutable: true },
    value: { type: Number, required: true },
    feeHeadIds: { type: [String], default: [] },
    stackMode: { type: String, enum: STACK_MODES, default: 'HIGHEST_WINS' },
    capPercentBps: { type: Number, default: null },
    validFrom: { type: String, default: null },
    validTo: { type: String, default: null },
    needsEvidence: { type: Boolean, default: false },
    needsApproval: { type: Boolean, default: false },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('concession_policies'),
);
concessionPolicySchema.index({ tenantId: 1, legalEntityId: 1, status: 1 });
concessionPolicySchema.plugin(tenantScopePlugin);
export const ConcessionPolicy = model<ConcessionPolicyDoc>('ConcessionPolicy', concessionPolicySchema);

export interface ConcessionAwardDoc extends BaseDoc, FinanceCommon, AuditFields {
  studentId: string;
  policyId: string;
  value: number;
  status: AwardStatus;
  reason: string | null;
  validFrom: string | null;
  validTo: string | null;
  evidenceFileId: string | null;
  requestedBy: string;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionReason: string | null;
}
const concessionAwardSchema = new Schema<ConcessionAwardDoc>(
  {
    ...uuidPrimaryKey, ...common,
    studentId: { type: String, required: true, immutable: true },
    policyId: { type: String, required: true, immutable: true },
    value: { type: Number, required: true },
    status: { type: String, enum: AWARD_STATUSES, default: 'DRAFT' },
    reason: { type: String, default: null },
    validFrom: { type: String, default: null },
    validTo: { type: String, default: null },
    evidenceFileId: { type: String, default: null },
    requestedBy: { type: String, required: true, immutable: true },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionReason: { type: String, default: null },
    ...auditFields,
  },
  baseSchemaOptions('student_concession_awards'),
);
concessionAwardSchema.index({ tenantId: 1, studentId: 1, status: 1 });
concessionAwardSchema.index({ tenantId: 1, policyId: 1 });
concessionAwardSchema.plugin(tenantScopePlugin);
export const ConcessionAward = model<ConcessionAwardDoc>('ConcessionAward', concessionAwardSchema);

// ───────────────────────────────────────────────────────────── late fee policies (FEE-07)

export interface LateFeePolicyDoc extends BaseDoc, FinanceCommon, AuditFields {
  feeHeadId: string;
  kind: LateFeeKind;
  period: LateFeePeriod;
  value: number;
  graceDays: number;
  capPaise: number | null;
  status: 'ACTIVE' | 'INACTIVE';
}
const lateFeePolicySchema = new Schema<LateFeePolicyDoc>(
  {
    ...uuidPrimaryKey, ...common,
    feeHeadId: { type: String, required: true, immutable: true },
    kind: { type: String, enum: LATE_FEE_KINDS, required: true, immutable: true },
    period: { type: String, enum: LATE_FEE_PERIODS, required: true },
    value: { type: Number, required: true },
    graceDays: { type: Number, default: 0 },
    capPaise: { type: Number, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('late_fee_policies'),
);
lateFeePolicySchema.index({ tenantId: 1, legalEntityId: 1, status: 1 });
lateFeePolicySchema.plugin(tenantScopePlugin);
export const LateFeePolicy = model<LateFeePolicyDoc>('LateFeePolicy', lateFeePolicySchema);

// ───────────────────────────────────────────────────────────── billing runs (FEE-09)

export interface BillingRunDoc extends BaseDoc, FinanceCommon, AuditFields {
  sessionId: string;
  locationId: string;
  classIds: string[];
  periodKey: string;
  issueDate: string;
  dueDate: string | null;
  state: BillingRunState;
  counts: { ready: number; needsAttention: number; issued: number; skipped: number };
  totalPaise: number;
  /** The row the run reached, so a retry after a crash continues instead of starting again. */
  checkpoint: { lastRowNo: number; at: Date } | null;
  commitKey: string | null;
  validatedAt: Date | null;
  issuedAt: Date | null;
}
const billingRunSchema = new Schema<BillingRunDoc>(
  {
    ...uuidPrimaryKey, ...common,
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    classIds: { type: [String], default: [] },
    periodKey: { type: String, required: true, immutable: true },
    issueDate: { type: String, required: true },
    dueDate: { type: String, default: null },
    state: { type: String, enum: BILLING_RUN_STATES, default: 'DRAFT' },
    counts: { ready: { type: Number, default: 0 }, needsAttention: { type: Number, default: 0 }, issued: { type: Number, default: 0 }, skipped: { type: Number, default: 0 } },
    totalPaise: { type: Number, default: 0 },
    checkpoint: { type: new Schema({ lastRowNo: Number, at: Date }, { _id: false }), default: null },
    commitKey: { type: String, default: null },
    validatedAt: { type: Date, default: null },
    issuedAt: { type: Date, default: null },
    ...auditFields,
  },
  baseSchemaOptions('billing_runs'),
);
billingRunSchema.index({ tenantId: 1, legalEntityId: 1, createdAt: -1 });
billingRunSchema.plugin(tenantScopePlugin);
export const BillingRun = model<BillingRunDoc>('BillingRun', billingRunSchema);

export interface BillingRunRowDoc extends BaseDoc, FinanceCommon {
  runId: string;
  rowNo: number;
  studentId: string;
  enrollmentId: string | null;
  classOfferingId: string | null;
  status: BillingRowStatus;
  reasonCode: BillingReason | null;
  reasonText: string | null;
  totalPaise: number;
  documentId: string | null;
  skipReason: string | null;
}
const billingRowSchema = new Schema<BillingRunRowDoc>(
  {
    ...uuidPrimaryKey, ...common,
    runId: { type: String, required: true, immutable: true },
    rowNo: { type: Number, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    enrollmentId: { type: String, default: null },
    classOfferingId: { type: String, default: null },
    status: { type: String, enum: BILLING_ROW_STATUSES, required: true },
    reasonCode: { type: String, enum: [...BILLING_REASONS, null], default: null },
    reasonText: { type: String, default: null },
    totalPaise: { type: Number, default: 0 },
    documentId: { type: String, default: null },
    skipReason: { type: String, default: null },
  },
  baseSchemaOptions('billing_run_rows'),
);
billingRowSchema.index({ tenantId: 1, runId: 1, rowNo: 1 }, { unique: true });
billingRowSchema.index({ tenantId: 1, runId: 1, status: 1 });
billingRowSchema.plugin(tenantScopePlugin);
export const BillingRunRow = model<BillingRunRowDoc>('BillingRunRow', billingRowSchema);

// ───────────────────────────────────────────────────────────── bills and their lines (FEE-10)

export interface FeeDocumentDoc extends BaseDoc, FinanceCommon {
  number: string;
  studentId: string;
  enrollmentId: string | null;
  locationId: string;
  sessionId: string;
  classOfferingId: string | null;
  kind: FeeDocumentKind;
  periodKey: string | null;
  issueDate: string;
  dueDate: string;
  graceDays: number;
  /** Due date plus grace days. A bill is overdue when this date has passed and something is still owed. */
  overdueAfter: string;
  basePaise: number;
  discountPaise: number;
  taxableValuePaise: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  totalPaise: number;
  paidPaise: number;
  creditedPaise: number;
  /** Kept in step with the ledger inside the same transaction, with a guarded `$inc`. It is never typed in. */
  balancePaise: number;
  status: FeeDocumentStatus;
  planVersionId: string | null;
  runId: string | null;
  parentDocumentId: string | null;
  journalId: string | null;
  createdBy: string | null;
}
const feeDocumentSchema = new Schema<FeeDocumentDoc>(
  {
    ...uuidPrimaryKey, ...common,
    number: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    enrollmentId: { type: String, default: null },
    locationId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    classOfferingId: { type: String, default: null },
    kind: { type: String, enum: DOCUMENT_KINDS, required: true, immutable: true },
    periodKey: { type: String, default: null, immutable: true },
    issueDate: { type: String, required: true, immutable: true },
    dueDate: { type: String, required: true, immutable: true },
    graceDays: { type: Number, default: 0 },
    overdueAfter: { type: String, required: true, immutable: true },
    basePaise: { type: Number, default: 0 },
    discountPaise: { type: Number, default: 0 },
    taxableValuePaise: { type: Number, default: 0 },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true, immutable: true },
    paidPaise: { type: Number, default: 0 },
    creditedPaise: { type: Number, default: 0 },
    balancePaise: { type: Number, required: true },
    status: { type: String, enum: FEE_DOCUMENT_STATUSES, default: 'ISSUED' },
    planVersionId: { type: String, default: null },
    runId: { type: String, default: null },
    parentDocumentId: { type: String, default: null },
    journalId: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('fee_documents'),
);
feeDocumentSchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
// One bill per student per period: a second run for the same month finds it and says ALREADY_BILLED.
feeDocumentSchema.index({ tenantId: 1, studentId: 1, kind: 1, periodKey: 1 }, { unique: true, partialFilterExpression: { kind: 'BILL' }, name: 'one_bill_per_student_per_period' });
feeDocumentSchema.index({ tenantId: 1, studentId: 1, issueDate: 1 });
feeDocumentSchema.index({ tenantId: 1, locationId: 1, status: 1, overdueAfter: 1 });
feeDocumentSchema.index({ tenantId: 1, parentDocumentId: 1 });
feeDocumentSchema.plugin(tenantScopePlugin);
export const FeeDocument = model<FeeDocumentDoc>('FeeDocument', feeDocumentSchema);

export interface FeeDocumentLineDoc extends BaseDoc, FinanceCommon {
  documentId: string;
  studentId: string;
  lineNo: number;
  feeHeadId: string;
  feeItemId: string | null;
  description: string;
  periodKey: string | null;
  qty: number;
  basePaise: number;
  discountPaise: number;
  taxableValuePaise: number;
  taxCodeId: string | null;
  rateBps: number;
  priceMode: PriceMode;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  incomeAccountId: string;
  isDeposit: boolean;
  explanation: string;
  concessionAwardIds: string[];
  /** On a credit note: the bill line it takes back. */
  originalLineId: string | null;
  /** Student + fee item + period. The database refuses a second line for the same thing. */
  sourceKey: string;
}
const feeDocumentLineSchema = new Schema<FeeDocumentLineDoc>(
  {
    ...uuidPrimaryKey, ...common,
    documentId: { type: String, required: true },
    studentId: { type: String, required: true },
    lineNo: { type: Number, required: true },
    feeHeadId: { type: String, required: true },
    feeItemId: { type: String, default: null },
    description: { type: String, required: true },
    periodKey: { type: String, default: null },
    qty: { type: Number, default: 1 },
    basePaise: { type: Number, required: true },
    discountPaise: { type: Number, default: 0 },
    taxableValuePaise: { type: Number, required: true },
    taxCodeId: { type: String, default: null },
    rateBps: { type: Number, default: 0 },
    priceMode: { type: String, enum: PRICE_MODES, default: 'EXCLUSIVE' },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    taxPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true },
    incomeAccountId: { type: String, required: true },
    isDeposit: { type: Boolean, default: false },
    explanation: { type: String, default: '' },
    concessionAwardIds: { type: [String], default: [] },
    originalLineId: { type: String, default: null },
    sourceKey: { type: String, required: true },
  },
  baseSchemaOptions('fee_document_lines'),
);
feeDocumentLineSchema.index({ tenantId: 1, legalEntityId: 1, sourceKey: 1 }, { unique: true });
feeDocumentLineSchema.index({ tenantId: 1, documentId: 1, lineNo: 1 });
feeDocumentLineSchema.plugin(immutablePlugin);
feeDocumentLineSchema.plugin(tenantScopePlugin);
export const FeeDocumentLine = model<FeeDocumentLineDoc>('FeeDocumentLine', feeDocumentLineSchema);

// ───────────────────────────────────────────────────────────── student ledger and adjustments (FEE-11, 12)

export interface StudentLedgerEntryDoc extends BaseDoc, FinanceCommon {
  studentId: string;
  date: string;
  kind: LedgerKind;
  /** Signed. Positive: the student owes more. Negative: they owe less (a payment, a credit note, an advance). */
  amountPaise: number;
  documentId: string | null;
  collectionId: string | null;
  journalId: string | null;
  description: string;
  seq: number;
}
const ledgerEntrySchema = new Schema<StudentLedgerEntryDoc>(
  {
    ...uuidPrimaryKey, ...common,
    studentId: { type: String, required: true },
    date: { type: String, required: true },
    kind: { type: String, enum: LEDGER_KINDS, required: true },
    amountPaise: { type: Number, required: true },
    documentId: { type: String, default: null },
    collectionId: { type: String, default: null },
    journalId: { type: String, default: null },
    description: { type: String, default: '' },
    seq: { type: Number, default: 0 },
  },
  baseSchemaOptions('student_ledger_entries'),
);
ledgerEntrySchema.index({ tenantId: 1, studentId: 1, date: 1, seq: 1 });
ledgerEntrySchema.index({ tenantId: 1, documentId: 1 });
ledgerEntrySchema.plugin(immutablePlugin);
ledgerEntrySchema.plugin(tenantScopePlugin);
export const StudentLedgerEntry = model<StudentLedgerEntryDoc>('StudentLedgerEntry', ledgerEntrySchema);

export interface FinancialAdjustmentDoc extends BaseDoc, FinanceCommon {
  documentId: string;
  newDocumentId: string;
  studentId: string;
  type: AdjustmentType;
  amountPaise: number;
  reason: string;
  status: AdjustmentStatus;
  approvalId: string | null;
  createdBy: string;
}
const adjustmentSchema = new Schema<FinancialAdjustmentDoc>(
  {
    ...uuidPrimaryKey, ...common,
    documentId: { type: String, required: true, immutable: true },
    newDocumentId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    type: { type: String, enum: ADJUSTMENT_TYPES, required: true, immutable: true },
    amountPaise: { type: Number, required: true, immutable: true },
    reason: { type: String, required: true },
    status: { type: String, enum: ADJUSTMENT_STATUSES, default: 'APPLIED' },
    approvalId: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  baseSchemaOptions('financial_adjustments'),
);
adjustmentSchema.index({ tenantId: 1, documentId: 1 });
adjustmentSchema.index({ tenantId: 1, studentId: 1 });
adjustmentSchema.plugin(tenantScopePlugin);
export const FinancialAdjustment = model<FinancialAdjustmentDoc>('FinancialAdjustment', adjustmentSchema);
