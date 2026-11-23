import { Schema, model } from 'mongoose';
import {
  ADVANCE_STATES, COMPONENT_CALCS, COMPONENT_TYPES, DISBURSEMENT_ITEM_STATUSES, PAY_DAY_BASES, PAY_MODES, PAYOUT_STATUSES, PAYROLL_ROUNDINGS, RUN_STATES, RUN_TYPES,
  type AdvanceState, type ComponentCalc, type ComponentType, type DisbursementItemStatus, type PayDayBasis, type PayMode, type PayoutStatus, type PayrollExceptionCode, type PayrollRounding, type RunState, type RunType, type StatutoryKind,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../../db/plugins/base';
import { tenantScopePlugin } from '../../../db/plugins/tenant-scope';
import { immutablePlugin } from '../core/immutable';

/**
 * Module 7, Part 3C. Salary is private: every money field here is restricted data. A finalised run, its lines and its payslips never change;
 * a mistake is fixed by a linked correction or supplementary run.
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

// ───────────────────────────────────────────────────────────── policy and components (PAY-01, 02)

export interface PayrollPolicyDoc extends BaseDoc, FinanceCommon, AuditFields {
  payDayBasis: PayDayBasis;
  rounding: PayrollRounding;
  approvalRequired: boolean;
  defaultBankAccountId: string | null;
}
const policySchema = new Schema<PayrollPolicyDoc>(
  { ...uuidPrimaryKey, ...common, payDayBasis: { type: String, enum: PAY_DAY_BASES, default: 'CALENDAR_DAYS' }, rounding: { type: String, enum: PAYROLL_ROUNDINGS, default: 'NEAREST_RUPEE' }, approvalRequired: { type: Boolean, default: true }, defaultBankAccountId: { type: String, default: null }, ...auditFields },
  baseSchemaOptions('payroll_policies'),
);
policySchema.index({ tenantId: 1, legalEntityId: 1 }, { unique: true });
policySchema.plugin(tenantScopePlugin);
export const PayrollPolicy = model<PayrollPolicyDoc>('PayrollPolicy', policySchema);

export interface SalaryComponentDoc extends BaseDoc, FinanceCommon, AuditFields {
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
const componentSchema = new Schema<SalaryComponentDoc>(
  {
    ...uuidPrimaryKey, ...common,
    code: { type: String, required: true, immutable: true },
    name: { type: String, required: true },
    type: { type: String, enum: COMPONENT_TYPES, required: true, immutable: true },
    calc: { type: String, enum: COMPONENT_CALCS, required: true, immutable: true },
    pfWage: { type: Boolean, default: false },
    esiWage: { type: Boolean, default: false },
    prorate: { type: Boolean, default: true },
    glAccountId: { type: String, default: null },
    isSystem: { type: Boolean, default: false },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('salary_components'),
);
componentSchema.index({ tenantId: 1, legalEntityId: 1, code: 1 }, { unique: true });
componentSchema.plugin(tenantScopePlugin);
export const SalaryComponent = model<SalaryComponentDoc>('SalaryComponent', componentSchema);

export interface SalaryStructureDoc extends BaseDoc, FinanceCommon, AuditFields {
  name: string;
  status: 'ACTIVE' | 'INACTIVE';
}
const structureSchema = new Schema<SalaryStructureDoc>({ ...uuidPrimaryKey, ...common, name: { type: String, required: true }, status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' }, ...auditFields }, baseSchemaOptions('salary_structures'));
structureSchema.index({ tenantId: 1, legalEntityId: 1, name: 1 }, { unique: true });
structureSchema.plugin(tenantScopePlugin);
export const SalaryStructure = model<SalaryStructureDoc>('SalaryStructure', structureSchema);

export interface StructureItem {
  componentId: string;
  amountPaise: number | null;
  rateBps: number | null;
}
export interface SalaryStructureVersionDoc extends BaseDoc, FinanceCommon {
  structureId: string;
  versionNo: number;
  effectiveFrom: string;
  state: 'DRAFT' | 'APPROVED';
  items: StructureItem[];
  approvedBy: string | null;
  approvedAt: Date | null;
}
const structureVersionSchema = new Schema<SalaryStructureVersionDoc>(
  {
    ...uuidPrimaryKey, ...common,
    structureId: { type: String, required: true, immutable: true },
    versionNo: { type: Number, required: true, immutable: true },
    effectiveFrom: { type: String, required: true },
    state: { type: String, enum: ['DRAFT', 'APPROVED'], default: 'DRAFT' },
    items: { type: [new Schema({ componentId: String, amountPaise: { type: Number, default: null }, rateBps: { type: Number, default: null } }, { _id: false })], default: [] },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
  },
  baseSchemaOptions('salary_structure_versions'),
);
structureVersionSchema.index({ tenantId: 1, structureId: 1, versionNo: 1 }, { unique: true });
structureVersionSchema.plugin(tenantScopePlugin);
export const SalaryStructureVersion = model<SalaryStructureVersionDoc>('SalaryStructureVersion', structureVersionSchema);

// ───────────────────────────────────────────────────────────── employee pay (PAY-03, 04)

export interface CompensationDoc extends BaseDoc, FinanceCommon, AuditFields {
  employeeId: string;
  structureVersionId: string;
  mode: PayMode;
  basicPaise: number;
  overrides: { componentId: string; amountPaise: number }[];
  effectiveFrom: string;
  effectiveTo: string | null;
  state: 'OPEN' | 'ENDED';
}
const compensationSchema = new Schema<CompensationDoc>(
  {
    ...uuidPrimaryKey, ...common,
    employeeId: { type: String, required: true, immutable: true },
    structureVersionId: { type: String, required: true },
    mode: { type: String, enum: PAY_MODES, default: 'MONTHLY' },
    basicPaise: { type: Number, required: true },
    overrides: { type: [new Schema({ componentId: String, amountPaise: Number }, { _id: false })], default: [] },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null },
    state: { type: String, enum: ['OPEN', 'ENDED'], default: 'OPEN' },
    ...auditFields,
  },
  baseSchemaOptions('employee_compensation_assignments'),
);
compensationSchema.index({ tenantId: 1, employeeId: 1, effectiveFrom: 1 }, { unique: true });
compensationSchema.plugin(tenantScopePlugin);
export const Compensation = model<CompensationDoc>('EmployeeCompensation', compensationSchema);

export interface SalaryRevisionDoc extends BaseDoc, FinanceCommon {
  employeeId: string;
  fromAssignmentId: string;
  fromBasicPaise: number;
  toBasicPaise: number;
  effectiveDate: string;
  arrearPolicy: 'PAY_DIFFERENCE' | 'NONE';
  status: 'PENDING' | 'APPLIED' | 'REJECTED';
  reason: string;
  approvalId: string | null;
  newAssignmentId: string | null;
  arrearsRunId: string | null;
  createdBy: string | null;
}
const revisionSchema = new Schema<SalaryRevisionDoc>(
  {
    ...uuidPrimaryKey, ...common,
    employeeId: { type: String, required: true },
    fromAssignmentId: { type: String, required: true },
    fromBasicPaise: { type: Number, required: true },
    toBasicPaise: { type: Number, required: true },
    effectiveDate: { type: String, required: true },
    arrearPolicy: { type: String, enum: ['PAY_DIFFERENCE', 'NONE'], default: 'PAY_DIFFERENCE' },
    status: { type: String, enum: ['PENDING', 'APPLIED', 'REJECTED'], default: 'PENDING' },
    reason: { type: String, default: '' },
    approvalId: { type: String, default: null },
    newAssignmentId: { type: String, default: null },
    arrearsRunId: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('salary_revisions'),
);
revisionSchema.index({ tenantId: 1, employeeId: 1, effectiveDate: 1 });
revisionSchema.plugin(tenantScopePlugin);
export const SalaryRevision = model<SalaryRevisionDoc>('SalaryRevision', revisionSchema);

export interface PayrollInputDoc extends BaseDoc, FinanceCommon {
  employeeId: string;
  month: string;
  workingDays: number | null;
  paidLeaveDays: number;
  lopDays: number;
  unitsWorked: number | null;
  extras: { label: string; type: 'EARNING' | 'DEDUCTION'; amountPaise: number }[];
  source: 'MANUAL' | 'CSV';
  approvedBy: string;
}
const inputSchema = new Schema<PayrollInputDoc>(
  {
    ...uuidPrimaryKey, ...common,
    employeeId: { type: String, required: true, immutable: true },
    month: { type: String, required: true, immutable: true },
    workingDays: { type: Number, default: null },
    paidLeaveDays: { type: Number, default: 0 },
    lopDays: { type: Number, default: 0 },
    unitsWorked: { type: Number, default: null },
    extras: { type: [new Schema({ label: String, type: String, amountPaise: Number }, { _id: false })], default: [] },
    source: { type: String, enum: ['MANUAL', 'CSV'], default: 'MANUAL' },
    approvedBy: { type: String, required: true },
  },
  baseSchemaOptions('employee_payroll_inputs'),
);
inputSchema.index({ tenantId: 1, employeeId: 1, month: 1 }, { unique: true });
inputSchema.plugin(tenantScopePlugin);
export const PayrollInput = model<PayrollInputDoc>('EmployeePayrollInput', inputSchema);

// ───────────────────────────────────────────────────────────── statutory rules and declarations (PAY-05)

export interface StatutoryRuleDoc extends BaseDoc, FinanceCommon {
  kind: StatutoryKind;
  effectiveFrom: string;
  params: Record<string, unknown>;
  state: 'DRAFT' | 'APPROVED';
  demo: boolean;
  note: string | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  createdBy: string | null;
}
const ruleSchema = new Schema<StatutoryRuleDoc>(
  {
    ...uuidPrimaryKey, ...common,
    kind: { type: String, enum: ['PF', 'ESI', 'PT'], required: true, immutable: true },
    effectiveFrom: { type: String, required: true, immutable: true },
    params: { type: Schema.Types.Mixed, required: true },
    state: { type: String, enum: ['DRAFT', 'APPROVED'], default: 'DRAFT' },
    demo: { type: Boolean, default: false },
    note: { type: String, default: null },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('payroll_statutory_rule_versions'),
);
ruleSchema.index({ tenantId: 1, legalEntityId: 1, kind: 1, effectiveFrom: 1 }, { unique: true });
ruleSchema.plugin(tenantScopePlugin);
export const StatutoryRule = model<StatutoryRuleDoc>('PayrollStatutoryRule', ruleSchema);

export interface TaxDeclarationDoc extends BaseDoc, FinanceCommon {
  employeeId: string;
  fyCode: string;
  regime: 'NEW' | 'OLD';
  estimatedYearlyTaxPaise: number;
  alreadyDeductedPaise: number;
  note: string | null;
  submittedBy: string;
}
const declarationSchema = new Schema<TaxDeclarationDoc>(
  {
    ...uuidPrimaryKey, ...common,
    employeeId: { type: String, required: true, immutable: true },
    fyCode: { type: String, required: true, immutable: true },
    regime: { type: String, enum: ['NEW', 'OLD'], required: true },
    estimatedYearlyTaxPaise: { type: Number, required: true },
    alreadyDeductedPaise: { type: Number, default: 0 },
    note: { type: String, default: null },
    submittedBy: { type: String, required: true },
  },
  baseSchemaOptions('employee_tax_declarations'),
);
declarationSchema.index({ tenantId: 1, employeeId: 1, fyCode: 1 }, { unique: true });
declarationSchema.plugin(tenantScopePlugin);
export const TaxDeclaration = model<TaxDeclarationDoc>('EmployeeTaxDeclaration', declarationSchema);

// ───────────────────────────────────────────────────────────── advances and loans (PAY-06)

export interface AdvanceDoc extends BaseDoc, FinanceCommon {
  employeeId: string;
  principalPaise: number;
  installments: number;
  installmentPaise: number;
  remainingPaise: number;
  startMonth: string;
  state: AdvanceState;
  reason: string;
  requestedBy: string;
  approvedBy: string | null;
  paidOn: string | null;
  paidJournalId: string | null;
}
const advanceSchema = new Schema<AdvanceDoc>(
  {
    ...uuidPrimaryKey, ...common,
    employeeId: { type: String, required: true, immutable: true },
    principalPaise: { type: Number, required: true },
    installments: { type: Number, required: true },
    installmentPaise: { type: Number, required: true },
    remainingPaise: { type: Number, required: true, min: 0 },
    startMonth: { type: String, required: true },
    state: { type: String, enum: ADVANCE_STATES, default: 'REQUESTED' },
    reason: { type: String, default: '' },
    requestedBy: { type: String, required: true },
    approvedBy: { type: String, default: null },
    paidOn: { type: String, default: null },
    paidJournalId: { type: String, default: null },
  },
  baseSchemaOptions('employee_advances'),
);
advanceSchema.index({ tenantId: 1, employeeId: 1, state: 1 });
advanceSchema.plugin(tenantScopePlugin);
export const Advance = model<AdvanceDoc>('EmployeeAdvance', advanceSchema);

// ───────────────────────────────────────────────────────────── runs (PAY-07 to 10)

export interface PayrollRunDoc extends BaseDoc, FinanceCommon {
  number: string;
  month: string;
  type: RunType;
  state: RunState;
  payoutStatus: PayoutStatus;
  locationId: string | null;
  parentRunId: string | null;
  employeeIds: string[];
  totals: { grossPaise: number; deductionsPaise: number; employerCostPaise: number; netPaise: number };
  counts: { employees: number; ready: number; needAction: number; held: number };
  previousNetPaise: number | null;
  warnings: string[];
  ruleVersionIds: string[];
  inputHash: string | null;
  preparedBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  finalizedBy: string | null;
  finalizedAt: Date | null;
  journalId: string | null;
  version: number;
}
const runSchema = new Schema<PayrollRunDoc>(
  {
    ...uuidPrimaryKey, ...common,
    number: { type: String, required: true },
    month: { type: String, required: true, immutable: true },
    type: { type: String, enum: RUN_TYPES, required: true, immutable: true },
    state: { type: String, enum: RUN_STATES, default: 'DRAFT' },
    payoutStatus: { type: String, enum: PAYOUT_STATUSES, default: 'UNPAID' },
    locationId: { type: String, default: null },
    parentRunId: { type: String, default: null },
    employeeIds: { type: [String], default: [] },
    totals: { type: new Schema({ grossPaise: Number, deductionsPaise: Number, employerCostPaise: Number, netPaise: Number }, { _id: false }), default: () => ({ grossPaise: 0, deductionsPaise: 0, employerCostPaise: 0, netPaise: 0 }) },
    counts: { type: new Schema({ employees: Number, ready: Number, needAction: Number, held: Number }, { _id: false }), default: () => ({ employees: 0, ready: 0, needAction: 0, held: 0 }) },
    previousNetPaise: { type: Number, default: null },
    warnings: { type: [String], default: [] },
    ruleVersionIds: { type: [String], default: [] },
    inputHash: { type: String, default: null },
    preparedBy: { type: String, required: true },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    finalizedBy: { type: String, default: null },
    finalizedAt: { type: Date, default: null },
    journalId: { type: String, default: null },
    version: { type: Number, default: 0 },
  },
  baseSchemaOptions('payroll_runs'),
);
runSchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
runSchema.index({ tenantId: 1, legalEntityId: 1, month: 1, type: 1, state: 1 });
runSchema.plugin(tenantScopePlugin);
export const PayrollRun = model<PayrollRunDoc>('PayrollRun', runSchema);

export interface OneOffLine {
  label: string;
  type: 'EARNING' | 'DEDUCTION';
  amountPaise: number;
  reason: string;
}
export interface RunExceptionRow {
  code: PayrollExceptionCode;
  level: 'BLOCKER' | 'REVIEW';
  message: string;
  fixHint: string;
}
export interface PayrollRunEmployeeDoc extends BaseDoc, FinanceCommon {
  runId: string;
  employeeId: string;
  locationId: string | null;
  departmentId: string | null;
  designationId: string | null;
  status: 'READY' | 'NEEDS_ACTION' | 'HELD';
  held: boolean;
  holdReason: string | null;
  oneOffLines: OneOffLine[];
  grossPaise: number;
  deductionsPaise: number;
  employerCostPaise: number;
  netPaise: number;
  fullMonthGrossPaise: number;
  paidNum: number;
  paidDen: number;
  exceptions: RunExceptionRow[];
  compensationId: string | null;
  advanceRecoveries: { advanceId: string; amountPaise: number }[];
  arrearRevisionIds: string[];
}
const runEmployeeSchema = new Schema<PayrollRunEmployeeDoc>(
  {
    ...uuidPrimaryKey, ...common,
    runId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    locationId: { type: String, default: null },
    departmentId: { type: String, default: null },
    designationId: { type: String, default: null },
    status: { type: String, enum: ['READY', 'NEEDS_ACTION', 'HELD'], default: 'READY' },
    held: { type: Boolean, default: false },
    holdReason: { type: String, default: null },
    oneOffLines: { type: [new Schema({ label: String, type: String, amountPaise: Number, reason: String }, { _id: false })], default: [] },
    grossPaise: { type: Number, default: 0 },
    deductionsPaise: { type: Number, default: 0 },
    employerCostPaise: { type: Number, default: 0 },
    netPaise: { type: Number, default: 0 },
    fullMonthGrossPaise: { type: Number, default: 0 },
    paidNum: { type: Number, default: 0 },
    paidDen: { type: Number, default: 0 },
    exceptions: { type: [new Schema({ code: String, level: String, message: String, fixHint: String }, { _id: false })], default: [] },
    compensationId: { type: String, default: null },
    advanceRecoveries: { type: [new Schema({ advanceId: String, amountPaise: Number }, { _id: false })], default: [] },
    arrearRevisionIds: { type: [String], default: [] },
  },
  baseSchemaOptions('payroll_run_employees'),
);
runEmployeeSchema.index({ tenantId: 1, runId: 1, employeeId: 1 }, { unique: true });
runEmployeeSchema.plugin(tenantScopePlugin);
export const PayrollRunEmployee = model<PayrollRunEmployeeDoc>('PayrollRunEmployee', runEmployeeSchema);

export interface PayrollRunLineDoc extends BaseDoc, FinanceCommon {
  runId: string;
  runEmployeeId: string;
  employeeId: string;
  kind: 'EARNING' | 'DEDUCTION' | 'EMPLOYER_COST' | 'RECOVERY' | 'ARREAR';
  componentKey: string;
  label: string;
  amountPaise: number;
  formula: string;
  glAccountId: string | null;
  ruleVersionId: string | null;
  sortOrder: number;
}
const runLineSchema = new Schema<PayrollRunLineDoc>(
  {
    ...uuidPrimaryKey, ...common,
    runId: { type: String, required: true, immutable: true },
    runEmployeeId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    kind: { type: String, enum: ['EARNING', 'DEDUCTION', 'EMPLOYER_COST', 'RECOVERY', 'ARREAR'], required: true },
    componentKey: { type: String, required: true },
    label: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    formula: { type: String, default: '' },
    glAccountId: { type: String, default: null },
    ruleVersionId: { type: String, default: null },
    sortOrder: { type: Number, default: 0 },
  },
  baseSchemaOptions('payroll_run_lines'),
);
runLineSchema.index({ tenantId: 1, runId: 1, employeeId: 1, sortOrder: 1 });
runLineSchema.plugin(tenantScopePlugin);
export const PayrollRunLine = model<PayrollRunLineDoc>('PayrollRunLine', runLineSchema);

// ───────────────────────────────────────────────────────────── payslips (PAY-10): never change

export interface PayslipDoc extends BaseDoc, FinanceCommon {
  number: string;
  runId: string;
  runEmployeeId: string;
  employeeId: string;
  month: string;
  snapshot: {
    school: string;
    employeeName: string;
    employeeCode: string;
    department: string | null;
    designation: string | null;
    grossPaise: number;
    deductionsPaise: number;
    employerCostPaise: number;
    netPaise: number;
    paidDays: string | null;
    lines: { kind: string; label: string; amountPaise: number; formula: string }[];
  };
}
const payslipSchema = new Schema<PayslipDoc>(
  {
    ...uuidPrimaryKey, ...common,
    number: { type: String, required: true },
    runId: { type: String, required: true },
    runEmployeeId: { type: String, required: true },
    employeeId: { type: String, required: true },
    month: { type: String, required: true },
    snapshot: { type: Schema.Types.Mixed, required: true },
  },
  baseSchemaOptions('employee_payslips'),
);
payslipSchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
payslipSchema.index({ tenantId: 1, runEmployeeId: 1 }, { unique: true });
payslipSchema.index({ tenantId: 1, employeeId: 1, month: 1 });
payslipSchema.plugin(immutablePlugin);
payslipSchema.plugin(tenantScopePlugin);
export const Payslip = model<PayslipDoc>('EmployeePayslip', payslipSchema);

/** Payslips become visible to employees only when this is written: a separate, deliberate step. */
export interface PayslipPublicationDoc extends BaseDoc, FinanceCommon {
  runId: string;
  publishedBy: string;
  publishedAt: Date;
}
const publicationSchema = new Schema<PayslipPublicationDoc>({ ...uuidPrimaryKey, ...common, runId: { type: String, required: true }, publishedBy: { type: String, required: true }, publishedAt: { type: Date, default: () => new Date() } }, baseSchemaOptions('payslip_publications'));
publicationSchema.index({ tenantId: 1, runId: 1 }, { unique: true });
publicationSchema.plugin(immutablePlugin);
publicationSchema.plugin(tenantScopePlugin);
export const PayslipPublication = model<PayslipPublicationDoc>('PayslipPublication', publicationSchema);

// ───────────────────────────────────────────────────────────── paying the salary (PAY-11, 12)

export interface DisbursementBatchDoc extends BaseDoc, FinanceCommon {
  runId: string;
  month: string;
  bankAccountId: string;
  fileHash: string | null;
  state: 'BUILT' | 'RECORDED' | 'VERIFIED';
  totalPaise: number;
  skipped: { employeeId: string; reason: string }[];
  createdBy: string;
}
const batchSchema = new Schema<DisbursementBatchDoc>(
  {
    ...uuidPrimaryKey, ...common,
    runId: { type: String, required: true, immutable: true },
    month: { type: String, required: true },
    bankAccountId: { type: String, required: true },
    fileHash: { type: String, default: null },
    state: { type: String, enum: ['BUILT', 'RECORDED', 'VERIFIED'], default: 'BUILT' },
    totalPaise: { type: Number, default: 0 },
    skipped: { type: [new Schema({ employeeId: String, reason: String }, { _id: false })], default: [] },
    createdBy: { type: String, required: true },
  },
  baseSchemaOptions('payroll_disbursement_batches'),
);
batchSchema.index({ tenantId: 1, runId: 1 });
batchSchema.plugin(tenantScopePlugin);
export const DisbursementBatch = model<DisbursementBatchDoc>('PayrollDisbursementBatch', batchSchema);

export interface DisbursementItemDoc extends BaseDoc, FinanceCommon {
  batchId: string;
  runId: string;
  runEmployeeId: string;
  employeeId: string;
  amountPaise: number;
  status: DisbursementItemStatus;
  mode: 'BANK' | 'CASH' | 'CHEQUE';
  reference: string | null;
  paidOn: string | null;
  reason: string | null;
  evidenceNote: string | null;
  recordedBy: string | null;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  journalId: string | null;
  retryOfId: string | null;
}
const itemSchema = new Schema<DisbursementItemDoc>(
  {
    ...uuidPrimaryKey, ...common,
    batchId: { type: String, required: true, immutable: true },
    runId: { type: String, required: true, immutable: true },
    runEmployeeId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    amountPaise: { type: Number, required: true },
    status: { type: String, enum: DISBURSEMENT_ITEM_STATUSES, default: 'PENDING' },
    mode: { type: String, enum: ['BANK', 'CASH', 'CHEQUE'], default: 'BANK' },
    reference: { type: String, default: null },
    paidOn: { type: String, default: null },
    reason: { type: String, default: null },
    evidenceNote: { type: String, default: null },
    recordedBy: { type: String, default: null },
    verified: { type: Boolean, default: false },
    verifiedBy: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    journalId: { type: String, default: null },
    retryOfId: { type: String, default: null },
  },
  baseSchemaOptions('payroll_disbursement_items'),
);
itemSchema.index({ tenantId: 1, batchId: 1 });
itemSchema.index({ tenantId: 1, runId: 1, employeeId: 1 });
itemSchema.plugin(tenantScopePlugin);
export const DisbursementItem = model<DisbursementItemDoc>('PayrollDisbursementItem', itemSchema);
