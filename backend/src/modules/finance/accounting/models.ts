import { Schema, model } from 'mongoose';
import { EXPENSE_PAYMENT_MODES, EXPENSE_STATES, GST_HEADS, GST_PAYMENT_KINDS, ITC_STATUSES, VENDOR_BILL_STATES, type ExpensePaymentMode, type ExpenseState, type GstHead, type GstPaymentKind, type ItcStatus, type VendorBillState } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../../db/plugins/base';
import { tenantScopePlugin } from '../../../db/plugins/tenant-scope';
import { immutablePlugin } from '../core/immutable';

/** Module 7, Part 3D. Expenses, vendors and their bills, GST records. A posted expense or vendor bill is only undone by a reversal and a new entry. */

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

export interface ExpenseCategoryDoc extends BaseDoc, FinanceCommon, AuditFields {
  code: string;
  name: string;
  accountId: string;
  defaultItcStatus: ItcStatus;
  status: 'ACTIVE' | 'INACTIVE';
}
const categorySchema = new Schema<ExpenseCategoryDoc>(
  { ...uuidPrimaryKey, ...common, code: { type: String, required: true, immutable: true }, name: { type: String, required: true }, accountId: { type: String, required: true }, defaultItcStatus: { type: String, enum: ITC_STATUSES, default: 'NEEDS_REVIEW' }, status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' }, ...auditFields },
  baseSchemaOptions('expense_categories'),
);
categorySchema.index({ tenantId: 1, legalEntityId: 1, code: 1 }, { unique: true });
categorySchema.plugin(tenantScopePlugin);
export const ExpenseCategory = model<ExpenseCategoryDoc>('ExpenseCategory', categorySchema);

export interface VendorDoc extends BaseDoc, FinanceCommon, AuditFields {
  name: string;
  gstin: string | null;
  stateCode: string | null;
  pan: string | null;
  contactName: string | null;
  phone: string | null;
  bankAccountEnc: string | null;
  bankLast4: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  status: 'ACTIVE' | 'INACTIVE';
}
const vendorSchema = new Schema<VendorDoc>(
  {
    ...uuidPrimaryKey, ...common,
    name: { type: String, required: true, trim: true },
    gstin: { type: String, default: null },
    stateCode: { type: String, default: null },
    pan: { type: String, default: null },
    contactName: { type: String, default: null },
    phone: { type: String, default: null },
    bankAccountEnc: { type: String, default: null, select: false },
    bankLast4: { type: String, default: null },
    bankIfsc: { type: String, default: null },
    bankName: { type: String, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('finance_vendors'),
);
vendorSchema.index({ tenantId: 1, legalEntityId: 1, name: 1 });
vendorSchema.plugin(tenantScopePlugin);
export const Vendor = model<VendorDoc>('FinanceVendor', vendorSchema);

/** GST on an expense or a vendor bill. Whether the input tax may be claimed back is decided by a person (or defaults to "needs review"). */
export interface TaxLineDoc extends BaseDoc, FinanceCommon {
  sourceType: 'expense' | 'vendor_bill';
  sourceId: string;
  sourceNumber: string;
  vendorId: string | null;
  locationId: string;
  date: string;
  month: string;
  taxableValuePaise: number;
  rateBps: number;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  itcStatus: ItcStatus;
  decidedBy: string | null;
  decisionReason: string | null;
  /** True once the expense or bill it belongs to was reversed. The line stays, for the history, but no report counts it. */
  voided: boolean;
}
const taxLineSchema = new Schema<TaxLineDoc>(
  {
    ...uuidPrimaryKey, ...common,
    sourceType: { type: String, enum: ['expense', 'vendor_bill'], required: true, immutable: true },
    sourceId: { type: String, required: true, immutable: true },
    sourceNumber: { type: String, required: true },
    vendorId: { type: String, default: null },
    locationId: { type: String, required: true },
    date: { type: String, required: true },
    month: { type: String, required: true },
    taxableValuePaise: { type: Number, required: true },
    rateBps: { type: Number, required: true },
    cgstPaise: { type: Number, default: 0 },
    sgstPaise: { type: Number, default: 0 },
    igstPaise: { type: Number, default: 0 },
    taxPaise: { type: Number, default: 0 },
    itcStatus: { type: String, enum: ITC_STATUSES, required: true },
    decidedBy: { type: String, default: null },
    decisionReason: { type: String, default: null },
    voided: { type: Boolean, default: false },
  },
  baseSchemaOptions('tax_lines'),
);
taxLineSchema.index({ tenantId: 1, sourceType: 1, sourceId: 1 });
taxLineSchema.index({ tenantId: 1, legalEntityId: 1, itcStatus: 1, month: 1 });
taxLineSchema.plugin(tenantScopePlugin);
export const TaxLine = model<TaxLineDoc>('TaxLine', taxLineSchema);

export interface ExpenseDoc extends BaseDoc, FinanceCommon {
  number: string;
  state: ExpenseState;
  categoryId: string;
  vendorId: string | null;
  locationId: string;
  date: string;
  description: string;
  taxableValuePaise: number;
  taxPaise: number;
  totalPaise: number;
  paymentMode: ExpensePaymentMode;
  bankAccountId: string | null;
  cashAccountId: string | null;
  needsApproval: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectReason: string | null;
  evidenceKey: string | null;
  journalId: string | null;
  reversalReason: string | null;
  createdBy: string;
}
const expenseSchema = new Schema<ExpenseDoc>(
  {
    ...uuidPrimaryKey, ...common,
    number: { type: String, required: true },
    state: { type: String, enum: EXPENSE_STATES, default: 'PENDING' },
    categoryId: { type: String, required: true, immutable: true },
    vendorId: { type: String, default: null, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    date: { type: String, required: true, immutable: true },
    description: { type: String, required: true },
    taxableValuePaise: { type: Number, required: true, immutable: true },
    taxPaise: { type: Number, default: 0, immutable: true },
    totalPaise: { type: Number, required: true, immutable: true },
    paymentMode: { type: String, enum: EXPENSE_PAYMENT_MODES, required: true, immutable: true },
    bankAccountId: { type: String, default: null },
    cashAccountId: { type: String, default: null },
    needsApproval: { type: Boolean, default: false },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    evidenceKey: { type: String, default: null },
    journalId: { type: String, default: null },
    reversalReason: { type: String, default: null },
    createdBy: { type: String, required: true, immutable: true },
  },
  baseSchemaOptions('expense_records'),
);
expenseSchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
expenseSchema.index({ tenantId: 1, legalEntityId: 1, state: 1, date: -1 });
expenseSchema.plugin(tenantScopePlugin);
export const Expense = model<ExpenseDoc>('ExpenseRecord', expenseSchema);

export interface VendorBillDoc extends BaseDoc, FinanceCommon {
  number: string;
  vendorId: string;
  vendorBillNumber: string;
  state: VendorBillState;
  date: string;
  dueDate: string;
  locationId: string;
  lines: { description: string; categoryId: string; taxableValuePaise: number; rateBps: number; taxPaise: number }[];
  taxableValuePaise: number;
  taxPaise: number;
  totalPaise: number;
  paidPaise: number;
  balancePaise: number;
  needsApproval: boolean;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectReason: string | null;
  journalId: string | null;
  createdBy: string;
}
const vendorBillSchema = new Schema<VendorBillDoc>(
  {
    ...uuidPrimaryKey, ...common,
    number: { type: String, required: true },
    vendorId: { type: String, required: true, immutable: true },
    vendorBillNumber: { type: String, required: true },
    state: { type: String, enum: VENDOR_BILL_STATES, default: 'PENDING' },
    date: { type: String, required: true },
    dueDate: { type: String, required: true },
    locationId: { type: String, required: true },
    lines: { type: [new Schema({ description: String, categoryId: String, taxableValuePaise: Number, rateBps: Number, taxPaise: Number }, { _id: false })], default: [] },
    taxableValuePaise: { type: Number, required: true },
    taxPaise: { type: Number, default: 0 },
    totalPaise: { type: Number, required: true },
    paidPaise: { type: Number, default: 0 },
    balancePaise: { type: Number, required: true, min: 0 },
    needsApproval: { type: Boolean, default: false },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    journalId: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  baseSchemaOptions('vendor_bills'),
);
vendorBillSchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
vendorBillSchema.index({ tenantId: 1, legalEntityId: 1, vendorId: 1, vendorBillNumber: 1 }, { unique: true });
vendorBillSchema.plugin(tenantScopePlugin);
export const VendorBill = model<VendorBillDoc>('VendorBill', vendorBillSchema);

export interface VendorPaymentDoc extends BaseDoc, FinanceCommon {
  number: string;
  vendorId: string;
  bankAccountId: string;
  amountPaise: number;
  paidOn: string;
  reference: string | null;
  referenceNorm: string | null;
  allocations: { billId: string; amountPaise: number }[];
  journalId: string | null;
  createdBy: string;
}
const vendorPaymentSchema = new Schema<VendorPaymentDoc>(
  {
    ...uuidPrimaryKey, ...common,
    number: { type: String, required: true },
    vendorId: { type: String, required: true },
    bankAccountId: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    paidOn: { type: String, required: true },
    reference: { type: String, default: null },
    referenceNorm: { type: String, default: null },
    allocations: { type: [new Schema({ billId: String, amountPaise: Number }, { _id: false })], default: [] },
    journalId: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  baseSchemaOptions('vendor_payments'),
);
vendorPaymentSchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
vendorPaymentSchema.plugin(immutablePlugin);
vendorPaymentSchema.plugin(tenantScopePlugin);
export const VendorPayment = model<VendorPaymentDoc>('VendorPayment', vendorPaymentSchema);

export interface GstPaymentDoc extends BaseDoc, FinanceCommon {
  month: string;
  kind: GstPaymentKind;
  head: GstHead;
  amountPaise: number;
  challanRef: string | null;
  bankAccountId: string | null;
  paidOn: string;
  journalId: string | null;
  createdBy: string;
}
const gstPaymentSchema = new Schema<GstPaymentDoc>(
  {
    ...uuidPrimaryKey, ...common,
    month: { type: String, required: true },
    kind: { type: String, enum: GST_PAYMENT_KINDS, required: true },
    head: { type: String, enum: GST_HEADS, required: true },
    amountPaise: { type: Number, required: true },
    challanRef: { type: String, default: null },
    bankAccountId: { type: String, default: null },
    paidOn: { type: String, required: true },
    journalId: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  baseSchemaOptions('gst_payment_records'),
);
gstPaymentSchema.index({ tenantId: 1, legalEntityId: 1, month: 1 });
gstPaymentSchema.plugin(immutablePlugin);
gstPaymentSchema.plugin(tenantScopePlugin);
export const GstPayment = model<GstPaymentDoc>('GstPaymentRecord', gstPaymentSchema);

/** The one-time go-live import (FIN-18). One per legal entity: a second, different file is refused. */
export interface OpeningBatchDoc extends BaseDoc, FinanceCommon {
  fileHash: string;
  asOf: string;
  accountLines: number;
  students: number;
  vendors: number;
  advances: number;
  postedBy: string;
}
const openingSchema = new Schema<OpeningBatchDoc>(
  { ...uuidPrimaryKey, ...common, fileHash: { type: String, required: true }, asOf: { type: String, required: true }, accountLines: { type: Number, default: 0 }, students: { type: Number, default: 0 }, vendors: { type: Number, default: 0 }, advances: { type: Number, default: 0 }, postedBy: { type: String, required: true } },
  baseSchemaOptions('opening_balance_batches'),
);
openingSchema.index({ tenantId: 1, legalEntityId: 1 }, { unique: true });
openingSchema.plugin(immutablePlugin);
openingSchema.plugin(tenantScopePlugin);
export const OpeningBatch = model<OpeningBatchDoc>('OpeningBalanceBatch', openingSchema);

/** What was checked when a month was closed, who closed it, and the reason for any warning that was accepted. */
export interface CloseRunDoc extends BaseDoc, FinanceCommon {
  periodId: string;
  periodCode: string;
  action: 'CLOSE' | 'REOPEN' | 'LOCK';
  checks: { key: string; level: string; count: number }[];
  warningReason: string | null;
  reason: string | null;
  approvalId: string | null;
  doneBy: string;
}
const closeRunSchema = new Schema<CloseRunDoc>(
  {
    ...uuidPrimaryKey, ...common,
    periodId: { type: String, required: true },
    periodCode: { type: String, required: true },
    action: { type: String, enum: ['CLOSE', 'REOPEN', 'LOCK'], required: true },
    checks: { type: [new Schema({ key: String, level: String, count: Number }, { _id: false })], default: [] },
    warningReason: { type: String, default: null },
    reason: { type: String, default: null },
    approvalId: { type: String, default: null },
    doneBy: { type: String, required: true },
  },
  baseSchemaOptions('finance_close_runs'),
);
closeRunSchema.index({ tenantId: 1, legalEntityId: 1, periodId: 1, createdAt: -1 });
closeRunSchema.plugin(immutablePlugin);
closeRunSchema.plugin(tenantScopePlugin);
export const CloseRun = model<CloseRunDoc>('FinanceCloseRun', closeRunSchema);
