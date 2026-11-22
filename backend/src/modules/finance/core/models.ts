import { Schema, model } from 'mongoose';
import {
  ACCOUNT_TYPES, APPROVAL_ACTIONS, APPROVAL_DECISIONS, BANK_PURPOSES, FINANCE_ACCOUNT_STATUSES, JOURNAL_EVENT_TYPES, LEGAL_FORMS, NORMAL_BALANCES, PERIOD_STATES, TAX_CATEGORIES,
  FINANCE_BUNDLES,
  type AccountType, type ApprovalAction, type ApprovalDecision, type BankPurpose, type FinanceAccountStatus, type FinanceBundle, type JournalEventType, type LegalForm, type NormalBalance, type PeriodState, type TaxCategory,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../../db/plugins/base';
import { tenantScopePlugin } from '../../../db/plugins/tenant-scope';
import { immutablePlugin } from './immutable';

/**
 * Module 7 foundation collections. Every row stores `tenantId`, `schoolId` and `legalEntityId` (one legal entity per school for now,
 * but the id is on every row so more can be added later). Money is whole paise in `…Paise` fields.
 */

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

// ───────────────────────────────────────────────────────────── legal entity

export interface LegalEntityDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  name: string;
  legalForm: LegalForm;
  pan: string | null;
  gstin: string | null;
  gstRegistered: boolean;
  stateCode: string | null;
  address: string | null;
  currency: 'INR';
  fyStartMonth: number;
  status: 'ACTIVE' | 'INACTIVE';
}
const legalEntitySchema = new Schema<LegalEntityDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true },
    legalForm: { type: String, enum: LEGAL_FORMS, default: 'TRUST' },
    pan: { type: String, default: null },
    gstin: { type: String, default: null },
    gstRegistered: { type: Boolean, default: false },
    stateCode: { type: String, default: null },
    address: { type: String, default: null },
    currency: { type: String, enum: ['INR'], default: 'INR' },
    fyStartMonth: { type: Number, default: 4, min: 1, max: 12 },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('finance_legal_entities'),
);
legalEntitySchema.index({ tenantId: 1, schoolId: 1 }, { unique: true });
legalEntitySchema.plugin(tenantScopePlugin);
export const LegalEntity = model<LegalEntityDoc>('FinanceLegalEntity', legalEntitySchema);

// ───────────────────────────────────────────────────────────── access bundles (FIN-07)

export interface AccessGrantDoc extends BaseDoc, FinanceCommon {
  userId: string;
  bundles: FinanceBundle[];
  locationIds: string[] | null;
  grantedBy: string;
}
const accessGrantSchema = new Schema<AccessGrantDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    userId: { type: String, required: true },
    bundles: { type: [String], enum: FINANCE_BUNDLES, default: [] },
    locationIds: { type: [String], default: null },
    grantedBy: { type: String, required: true },
  },
  baseSchemaOptions('finance_access_grants'),
);
accessGrantSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
accessGrantSchema.plugin(tenantScopePlugin);
export const AccessGrant = model<AccessGrantDoc>('FinanceAccessGrant', accessGrantSchema);

// ───────────────────────────────────────────────────────────── years and periods (FIN-02)

export interface FinancialYearDoc extends BaseDoc, FinanceCommon {
  code: string;
  startDate: string;
  endDate: string;
}
const financialYearSchema = new Schema<FinancialYearDoc>(
  { ...uuidPrimaryKey, ...common, code: { type: String, required: true, immutable: true }, startDate: { type: String, required: true }, endDate: { type: String, required: true } },
  baseSchemaOptions('financial_years'),
);
financialYearSchema.index({ tenantId: 1, legalEntityId: 1, code: 1 }, { unique: true });
financialYearSchema.plugin(tenantScopePlugin);
export const FinancialYear = model<FinancialYearDoc>('FinancialYear', financialYearSchema);

export interface AccountingPeriodDoc extends BaseDoc, FinanceCommon {
  financialYearId: string;
  fyCode: string;
  code: string;
  month: number;
  startDate: string;
  endDate: string;
  state: PeriodState;
  stateChangedAt: Date | null;
  stateChangedBy: string | null;
}
const periodSchema = new Schema<AccountingPeriodDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    financialYearId: { type: String, required: true, immutable: true },
    fyCode: { type: String, required: true, immutable: true },
    code: { type: String, required: true, immutable: true },
    month: { type: Number, required: true, immutable: true },
    startDate: { type: String, required: true, immutable: true },
    endDate: { type: String, required: true, immutable: true },
    state: { type: String, enum: PERIOD_STATES, default: 'OPEN', required: true },
    stateChangedAt: { type: Date, default: null },
    stateChangedBy: { type: String, default: null },
  },
  baseSchemaOptions('accounting_periods'),
);
periodSchema.index({ tenantId: 1, legalEntityId: 1, startDate: 1 }, { unique: true });
periodSchema.index({ tenantId: 1, legalEntityId: 1, financialYearId: 1, month: 1 });
periodSchema.plugin(tenantScopePlugin);
export const AccountingPeriod = model<AccountingPeriodDoc>('AccountingPeriod', periodSchema);

// ───────────────────────────────────────────────────────────── chart of accounts (FIN-03)

export interface ChartAccountDoc extends BaseDoc, FinanceCommon, AuditFields {
  code: string;
  name: string;
  type: AccountType;
  parentId: string | null;
  normalBalance: NormalBalance;
  systemRole: string | null;
  isPostable: boolean;
  status: FinanceAccountStatus;
}
const chartAccountSchema = new Schema<ChartAccountDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    code: { type: String, required: true, immutable: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ACCOUNT_TYPES, required: true, immutable: true },
    parentId: { type: String, default: null },
    normalBalance: { type: String, enum: NORMAL_BALANCES, required: true, immutable: true },
    systemRole: { type: String, default: null },
    isPostable: { type: Boolean, default: true },
    status: { type: String, enum: FINANCE_ACCOUNT_STATUSES, default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('chart_of_accounts'),
);
chartAccountSchema.index({ tenantId: 1, legalEntityId: 1, code: 1 }, { unique: true });
chartAccountSchema.index({ tenantId: 1, legalEntityId: 1, systemRole: 1 }, { unique: true, partialFilterExpression: { systemRole: { $type: 'string' } }, name: 'one_account_per_system_role' });
chartAccountSchema.plugin(tenantScopePlugin);
export const ChartAccount = model<ChartAccountDoc>('ChartAccount', chartAccountSchema);

// ───────────────────────────────────────────────────────────── bank and cash (FIN-04)

export interface BankAccountDoc extends BaseDoc, FinanceCommon, AuditFields {
  label: string;
  bankName: string;
  holderName: string | null;
  accountNumberEnc: string;
  last4: string;
  ifsc: string;
  purpose: BankPurpose;
  glAccountId: string;
  locationIds: string[];
  status: FinanceAccountStatus;
}
const bankAccountSchema = new Schema<BankAccountDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    label: { type: String, required: true, trim: true },
    bankName: { type: String, required: true, trim: true },
    holderName: { type: String, default: null },
    accountNumberEnc: { type: String, required: true, select: false },
    last4: { type: String, required: true },
    ifsc: { type: String, required: true },
    purpose: { type: String, enum: BANK_PURPOSES, required: true },
    glAccountId: { type: String, required: true },
    locationIds: { type: [String], default: [] },
    status: { type: String, enum: FINANCE_ACCOUNT_STATUSES, default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('finance_bank_accounts'),
);
bankAccountSchema.index({ tenantId: 1, legalEntityId: 1, status: 1 });
bankAccountSchema.plugin(tenantScopePlugin);
export const BankAccount = model<BankAccountDoc>('FinanceBankAccount', bankAccountSchema);

export interface CashAccountDoc extends BaseDoc, FinanceCommon, AuditFields {
  label: string;
  glAccountId: string;
  locationIds: string[];
  status: FinanceAccountStatus;
}
const cashAccountSchema = new Schema<CashAccountDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    label: { type: String, required: true, trim: true },
    glAccountId: { type: String, required: true },
    locationIds: { type: [String], default: [] },
    status: { type: String, enum: FINANCE_ACCOUNT_STATUSES, default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('cash_accounts'),
);
cashAccountSchema.index({ tenantId: 1, legalEntityId: 1, status: 1 });
cashAccountSchema.plugin(tenantScopePlugin);
export const CashAccount = model<CashAccountDoc>('CashAccount', cashAccountSchema);

// ───────────────────────────────────────────────────────────── journals (FIN-05): immutable

export interface JournalEntryDoc extends BaseDoc, FinanceCommon {
  number: string;
  accountingDate: string;
  periodId: string;
  eventType: JournalEventType;
  sourceKey: string;
  /** A fingerprint of the lines, so a retry of the same event is told apart from a different event with the same key. */
  linesHash: string;
  sourceType: string | null;
  sourceId: string | null;
  memo: string;
  totalPaise: number;
  /** Which campuses the lines touch, so a scoped user can be shown only their entries. */
  locationIds: string[];
  studentIds: string[];
  accountIds: string[];
  reversesId: string | null;
  postedBy: string | null;
  correlationId: string | null;
}
const journalEntrySchema = new Schema<JournalEntryDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    number: { type: String, required: true },
    accountingDate: { type: String, required: true },
    periodId: { type: String, required: true },
    eventType: { type: String, enum: JOURNAL_EVENT_TYPES, required: true },
    sourceKey: { type: String, required: true },
    linesHash: { type: String, required: true },
    sourceType: { type: String, default: null },
    sourceId: { type: String, default: null },
    memo: { type: String, default: '' },
    totalPaise: { type: Number, required: true },
    locationIds: { type: [String], default: [] },
    studentIds: { type: [String], default: [] },
    accountIds: { type: [String], default: [] },
    reversesId: { type: String, default: null },
    postedBy: { type: String, default: null },
    correlationId: { type: String, default: null },
  },
  baseSchemaOptions('journal_entries'),
);
journalEntrySchema.index({ tenantId: 1, legalEntityId: 1, sourceKey: 1 }, { unique: true });
journalEntrySchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
journalEntrySchema.index({ tenantId: 1, legalEntityId: 1, reversesId: 1 }, { unique: true, partialFilterExpression: { reversesId: { $type: 'string' } }, name: 'one_reversal_per_journal' });
journalEntrySchema.index({ tenantId: 1, accountingDate: -1 });
journalEntrySchema.index({ tenantId: 1, sourceType: 1, sourceId: 1 });
journalEntrySchema.plugin(immutablePlugin);
journalEntrySchema.plugin(tenantScopePlugin);
export const JournalEntry = model<JournalEntryDoc>('JournalEntry', journalEntrySchema);

export interface JournalLineDoc extends BaseDoc, FinanceCommon {
  journalId: string;
  lineNo: number;
  accountId: string;
  accountingDate: string;
  debitPaise: number;
  creditPaise: number;
  locationId: string | null;
  studentId: string | null;
  employeeId: string | null;
  vendorId: string | null;
}
const journalLineSchema = new Schema<JournalLineDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    journalId: { type: String, required: true },
    lineNo: { type: Number, required: true },
    accountId: { type: String, required: true },
    accountingDate: { type: String, required: true },
    debitPaise: { type: Number, default: 0 },
    creditPaise: { type: Number, default: 0 },
    locationId: { type: String, default: null },
    studentId: { type: String, default: null },
    employeeId: { type: String, default: null },
    vendorId: { type: String, default: null },
  },
  baseSchemaOptions('journal_lines'),
);
journalLineSchema.index({ tenantId: 1, journalId: 1, lineNo: 1 }, { unique: true });
journalLineSchema.index({ tenantId: 1, accountId: 1, accountingDate: 1 });
journalLineSchema.index({ tenantId: 1, studentId: 1 });
journalLineSchema.plugin(immutablePlugin);
journalLineSchema.plugin(tenantScopePlugin);
export const JournalLine = model<JournalLineDoc>('JournalLine', journalLineSchema);

// ───────────────────────────────────────────────────────────── approvals (FIN-06)

export interface ApprovalPolicyDoc extends BaseDoc, FinanceCommon, AuditFields {
  action: ApprovalAction;
  thresholdPaise: number | null;
  needsDifferentApprover: boolean;
  enabled: boolean;
  description: string;
}
const approvalPolicySchema = new Schema<ApprovalPolicyDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    action: { type: String, enum: APPROVAL_ACTIONS, required: true, immutable: true },
    thresholdPaise: { type: Number, default: null },
    needsDifferentApprover: { type: Boolean, default: true },
    enabled: { type: Boolean, default: true },
    description: { type: String, default: '' },
    ...auditFields,
  },
  baseSchemaOptions('finance_approval_policies'),
);
approvalPolicySchema.index({ tenantId: 1, legalEntityId: 1, action: 1 }, { unique: true });
approvalPolicySchema.plugin(tenantScopePlugin);
export const ApprovalPolicy = model<ApprovalPolicyDoc>('FinanceApprovalPolicy', approvalPolicySchema);

export interface ApprovalRequestDoc extends BaseDoc, FinanceCommon {
  action: ApprovalAction;
  entityType: string;
  entityId: string | null;
  amountPaise: number;
  summary: string;
  impact: string;
  reason: string | null;
  /** What was asked for, kept exactly as sent. Secrets are sealed before they get here. */
  payload: Record<string, unknown>;
  requestedBy: string;
  decision: ApprovalDecision;
  decidedBy: string | null;
  decisionReason: string | null;
  decidedAt: Date | null;
  usedAt: Date | null;
  differentApproverRequired: boolean;
}
const approvalRequestSchema = new Schema<ApprovalRequestDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    action: { type: String, enum: APPROVAL_ACTIONS, required: true, immutable: true },
    entityType: { type: String, required: true, immutable: true },
    entityId: { type: String, default: null },
    amountPaise: { type: Number, default: 0 },
    summary: { type: String, required: true },
    impact: { type: String, default: '' },
    reason: { type: String, default: null },
    payload: { type: Schema.Types.Mixed, default: {} },
    requestedBy: { type: String, required: true, immutable: true },
    decision: { type: String, enum: APPROVAL_DECISIONS, default: 'PENDING' },
    decidedBy: { type: String, default: null },
    decisionReason: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    usedAt: { type: Date, default: null },
    differentApproverRequired: { type: Boolean, default: true },
  },
  baseSchemaOptions('finance_approval_requests'),
);
approvalRequestSchema.index({ tenantId: 1, legalEntityId: 1, decision: 1, createdAt: -1 });
approvalRequestSchema.plugin(tenantScopePlugin);
export const ApprovalRequest = model<ApprovalRequestDoc>('FinanceApprovalRequest', approvalRequestSchema);

// ───────────────────────────────────────────────────────────── audit (FIN-08): append-only

export interface FinanceAuditDoc extends BaseDoc, FinanceCommon {
  actorId: string | null;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  correlationId: string | null;
  metadata: Record<string, unknown>;
  occurredAt: Date;
}
const financeAuditSchema = new Schema<FinanceAuditDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    actorId: { type: String, default: null },
    actorRole: { type: String, required: true },
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    correlationId: { type: String, default: null },
    metadata: { type: Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: () => new Date() },
  },
  baseSchemaOptions('finance_audit_events'),
);
financeAuditSchema.index({ tenantId: 1, occurredAt: -1 });
financeAuditSchema.index({ tenantId: 1, entityType: 1, entityId: 1 });
financeAuditSchema.plugin(immutablePlugin);
financeAuditSchema.plugin(tenantScopePlugin);
export const FinanceAudit = model<FinanceAuditDoc>('FinanceAuditEvent', financeAuditSchema);

// ───────────────────────────────────────────────────────────── counters (gap-free numbers)

export interface FinanceCounterDoc extends BaseDoc, FinanceCommon {
  key: string;
  seq: number;
}
const counterSchema = new Schema<FinanceCounterDoc>(
  { ...uuidPrimaryKey, ...common, key: { type: String, required: true, immutable: true }, seq: { type: Number, default: 0 } },
  baseSchemaOptions('finance_counters'),
);
counterSchema.index({ tenantId: 1, legalEntityId: 1, key: 1 }, { unique: true });
counterSchema.plugin(tenantScopePlugin);
export const FinanceCounter = model<FinanceCounterDoc>('FinanceCounter', counterSchema);

// ───────────────────────────────────────────────────────────── tax codes (TAX-02)

export interface TaxCodeDoc extends BaseDoc, FinanceCommon, AuditFields {
  code: string;
  name: string;
  category: TaxCategory;
  rateBps: number;
  hsnSac: string | null;
  note: string;
  status: 'ACTIVE' | 'ENDED';
}
const taxCodeSchema = new Schema<TaxCodeDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    code: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true },
    category: { type: String, enum: TAX_CATEGORIES, required: true, immutable: true },
    rateBps: { type: Number, default: 0, immutable: true },
    hsnSac: { type: String, default: null },
    note: { type: String, default: '' },
    status: { type: String, enum: ['ACTIVE', 'ENDED'], default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('tax_codes'),
);
taxCodeSchema.index({ tenantId: 1, legalEntityId: 1, code: 1 }, { unique: true });
taxCodeSchema.plugin(tenantScopePlugin);
export const TaxCode = model<TaxCodeDoc>('TaxCode', taxCodeSchema);
