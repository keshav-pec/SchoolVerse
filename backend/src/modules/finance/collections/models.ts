import { Schema, model } from 'mongoose';
import {
  CLAIM_STATUSES, COLLECTION_FLAGS, COLLECTION_STATUSES, PAYMENT_METHODS, REFUND_STATES, SHIFT_STATES,
  type ClaimStatus, type CollectionFlag, type CollectionStatus, type PaymentMethod, type RefundState, type ShiftState,
} from '@shared';
import { baseSchemaOptions, uuidPrimaryKey, type BaseDoc } from '../../../db/plugins/base';
import { tenantScopePlugin } from '../../../db/plugins/tenant-scope';
import { immutablePlugin } from '../core/immutable';

/**
 * Module 7, Part 3A. A claim is only what a family says. A collection is money the school really holds (or is waiting to confirm).
 * Receipts never change; a cancelled receipt is a separate linked record. Every row stores tenant, school and legal entity.
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

// ───────────────────────────────────────────────────────────── payment claims (COL-01)

export interface PaymentClaimDoc extends BaseDoc, FinanceCommon {
  students: { studentId: string; amountPaise: number }[];
  method: PaymentMethod;
  amountPaise: number;
  paidOn: string;
  reference: string | null;
  referenceNorm: string | null;
  proofKey: string | null;
  status: ClaimStatus;
  flags: CollectionFlag[];
  locationId: string | null;
  reportedBy: string;
  reportedByParent: boolean;
  rejectReason: string | null;
  decidedBy: string | null;
  decidedAt: Date | null;
  collectionId: string | null;
}
const claimSchema = new Schema<PaymentClaimDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    students: { type: [{ _id: false, studentId: { type: String, required: true }, amountPaise: { type: Number, required: true } }], default: [] },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amountPaise: { type: Number, required: true },
    paidOn: { type: String, required: true },
    reference: { type: String, default: null },
    referenceNorm: { type: String, default: null },
    proofKey: { type: String, default: null },
    status: { type: String, enum: CLAIM_STATUSES, default: 'PENDING_VERIFICATION' },
    flags: { type: [String], enum: COLLECTION_FLAGS, default: [] },
    locationId: { type: String, default: null },
    reportedBy: { type: String, required: true },
    reportedByParent: { type: Boolean, default: false },
    rejectReason: { type: String, default: null },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    collectionId: { type: String, default: null },
  },
  baseSchemaOptions('payment_claims'),
);
claimSchema.index({ tenantId: 1, legalEntityId: 1, status: 1, createdAt: -1 });
claimSchema.index({ tenantId: 1, 'students.studentId': 1 });
claimSchema.plugin(tenantScopePlugin);
export const PaymentClaim = model<PaymentClaimDoc>('PaymentClaim', claimSchema);

// ───────────────────────────────────────────────────────────── collections (COL-02 to 05)

export interface CollectionDoc extends BaseDoc, FinanceCommon {
  method: PaymentMethod;
  status: CollectionStatus;
  payerName: string | null;
  amountPaise: number;
  /** Funded money not yet put against a bill. It is the student's advance, a debt the school owes. */
  unallocatedPaise: number;
  receivedOn: string;
  reference: string | null;
  referenceNorm: string | null;
  bankAccountId: string | null;
  cashAccountId: string | null;
  shiftId: string | null;
  locationId: string;
  studentIds: string[];
  advanceStudentId: string;
  /** What to apply when the money is confirmed. */
  plan: { studentId: string; documentId: string | null; amountPaise: number }[];
  autoAllocate: boolean;
  flags: CollectionFlag[];
  claimId: string | null;
  cheque: { number: string; bankName: string; chequeDate: string; payerName: string | null } | null;
  provisionalNumber: string | null;
  idempotencyKey: string | null;
  version: number;
  journalId: string | null;
  receiptId: string | null;
  depositBatchId: string | null;
  depositedOn: string | null;
  clearedOn: string | null;
  returnedReason: string | null;
  returnedOn: string | null;
  verifiedBy: string | null;
  verifiedAt: Date | null;
  evidence: { statementLineId: string | null; note: string | null; seenOn: string; amountSeenPaise: number } | null;
  createdBy: string | null;
}
const collectionSchema = new Schema<CollectionDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    method: { type: String, enum: PAYMENT_METHODS, required: true, immutable: true },
    status: { type: String, enum: COLLECTION_STATUSES, required: true },
    payerName: { type: String, default: null },
    amountPaise: { type: Number, required: true },
    unallocatedPaise: { type: Number, default: 0, min: 0 },
    receivedOn: { type: String, required: true },
    reference: { type: String, default: null },
    referenceNorm: { type: String, default: null },
    bankAccountId: { type: String, default: null },
    cashAccountId: { type: String, default: null },
    shiftId: { type: String, default: null },
    locationId: { type: String, required: true },
    studentIds: { type: [String], default: [] },
    advanceStudentId: { type: String, required: true },
    plan: { type: [{ _id: false, studentId: { type: String, required: true }, documentId: { type: String, default: null }, amountPaise: { type: Number, required: true } }], default: [] },
    autoAllocate: { type: Boolean, default: false },
    flags: { type: [String], enum: COLLECTION_FLAGS, default: [] },
    claimId: { type: String, default: null },
    cheque: { type: new Schema({ number: String, bankName: String, chequeDate: String, payerName: { type: String, default: null } }, { _id: false }), default: null },
    provisionalNumber: { type: String, default: null },
    idempotencyKey: { type: String, default: null },
    version: { type: Number, default: 0 },
    journalId: { type: String, default: null },
    receiptId: { type: String, default: null },
    depositBatchId: { type: String, default: null },
    depositedOn: { type: String, default: null },
    clearedOn: { type: String, default: null },
    returnedReason: { type: String, default: null },
    returnedOn: { type: String, default: null },
    verifiedBy: { type: String, default: null },
    verifiedAt: { type: Date, default: null },
    evidence: { type: new Schema({ statementLineId: { type: String, default: null }, note: { type: String, default: null }, seenOn: String, amountSeenPaise: Number }, { _id: false }), default: null },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('collections'),
);
collectionSchema.index({ tenantId: 1, legalEntityId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'one_collection_per_key' });
collectionSchema.index({ tenantId: 1, legalEntityId: 1, status: 1, receivedOn: -1 });
collectionSchema.index({ tenantId: 1, referenceNorm: 1 });
collectionSchema.index({ tenantId: 1, studentIds: 1 });
collectionSchema.plugin(tenantScopePlugin);
export const Collection = model<CollectionDoc>('Collection', collectionSchema);

export interface CollectionAllocationDoc extends BaseDoc, FinanceCommon {
  /** `null` when an advance that came from a credit note (not from a collection) is applied. */
  collectionId: string | null;
  studentId: string;
  documentId: string;
  amountPaise: number;
  status: 'ACTIVE' | 'REVERSED';
  reversalOfId: string | null;
  reason: string | null;
  journalId: string | null;
  allocatedOn: string;
  createdBy: string | null;
}
const allocationSchema = new Schema<CollectionAllocationDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    collectionId: { type: String, default: null },
    studentId: { type: String, required: true },
    documentId: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    status: { type: String, enum: ['ACTIVE', 'REVERSED'], default: 'ACTIVE' },
    reversalOfId: { type: String, default: null },
    reason: { type: String, default: null },
    journalId: { type: String, default: null },
    allocatedOn: { type: String, required: true },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('collection_allocations'),
);
allocationSchema.index({ tenantId: 1, collectionId: 1 });
allocationSchema.index({ tenantId: 1, documentId: 1 });
allocationSchema.index({ tenantId: 1, studentId: 1 });
allocationSchema.plugin(tenantScopePlugin);
export const CollectionAllocation = model<CollectionAllocationDoc>('CollectionAllocation', allocationSchema);

// ───────────────────────────────────────────────────────────── receipts (COL-09): never change

export interface ReceiptDoc extends BaseDoc, FinanceCommon {
  number: string;
  collectionId: string;
  studentIds: string[];
  locationId: string;
  amountPaise: number;
  advancePaise: number;
  method: PaymentMethod;
  receivedOn: string;
  payerName: string | null;
  lines: { studentId: string; documentNumber: string; amountPaise: number }[];
  cashierId: string | null;
  createdBy: string | null;
}
const receiptSchema = new Schema<ReceiptDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    number: { type: String, required: true },
    collectionId: { type: String, required: true },
    studentIds: { type: [String], default: [] },
    locationId: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    advancePaise: { type: Number, default: 0 },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    receivedOn: { type: String, required: true },
    payerName: { type: String, default: null },
    lines: { type: [{ _id: false, studentId: String, documentNumber: String, amountPaise: Number }], default: [] },
    cashierId: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('finance_receipts'),
);
receiptSchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
receiptSchema.index({ tenantId: 1, collectionId: 1 }, { unique: true });
receiptSchema.index({ tenantId: 1, studentIds: 1 });
receiptSchema.plugin(immutablePlugin);
receiptSchema.plugin(tenantScopePlugin);
export const Receipt = model<ReceiptDoc>('FinanceReceipt', receiptSchema);

/** A cancelled receipt. The receipt itself stays exactly as issued; this record points at it. */
export interface ReceiptCancellationDoc extends BaseDoc, FinanceCommon {
  receiptId: string;
  reason: string;
  approvalId: string | null;
  cancelledBy: string;
  cancelledAt: Date;
}
const receiptCancelSchema = new Schema<ReceiptCancellationDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    receiptId: { type: String, required: true },
    reason: { type: String, required: true },
    approvalId: { type: String, default: null },
    cancelledBy: { type: String, required: true },
    cancelledAt: { type: Date, default: () => new Date() },
  },
  baseSchemaOptions('finance_receipt_cancellations'),
);
receiptCancelSchema.index({ tenantId: 1, receiptId: 1 }, { unique: true });
receiptCancelSchema.plugin(immutablePlugin);
receiptCancelSchema.plugin(tenantScopePlugin);
export const ReceiptCancellation = model<ReceiptCancellationDoc>('FinanceReceiptCancellation', receiptCancelSchema);

// ───────────────────────────────────────────────────────────── refunds (COL-10)

export interface RefundRequestDoc extends BaseDoc, FinanceCommon {
  number: string;
  studentId: string;
  locationId: string;
  reason: string;
  amountPaise: number;
  fromAdvancePaise: number;
  fromDepositPaise: number;
  recipientPersonId: string | null;
  recipientName: string | null;
  state: RefundState;
  requestedBy: string;
  approvedBy: string | null;
  approvedAt: Date | null;
  rejectReason: string | null;
  approveJournalId: string | null;
  paidOn: string | null;
  paidReference: string | null;
  disbursementId: string | null;
}
const refundSchema = new Schema<RefundRequestDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    number: { type: String, required: true },
    studentId: { type: String, required: true },
    locationId: { type: String, required: true },
    reason: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    fromAdvancePaise: { type: Number, default: 0 },
    fromDepositPaise: { type: Number, default: 0 },
    recipientPersonId: { type: String, default: null },
    recipientName: { type: String, default: null },
    state: { type: String, enum: REFUND_STATES, default: 'ELIGIBLE' },
    requestedBy: { type: String, required: true },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    approveJournalId: { type: String, default: null },
    paidOn: { type: String, default: null },
    paidReference: { type: String, default: null },
    disbursementId: { type: String, default: null },
  },
  baseSchemaOptions('refund_requests'),
);
refundSchema.index({ tenantId: 1, legalEntityId: 1, number: 1 }, { unique: true });
refundSchema.index({ tenantId: 1, studentId: 1, state: 1 });
refundSchema.plugin(tenantScopePlugin);
export const RefundRequest = model<RefundRequestDoc>('RefundRequest', refundSchema);

export interface RefundDisbursementDoc extends BaseDoc, FinanceCommon {
  refundId: string;
  bankAccountId: string | null;
  cashAccountId: string | null;
  shiftId: string | null;
  amountPaise: number;
  reference: string | null;
  referenceNorm: string | null;
  paidOn: string;
  evidenceNote: string | null;
  recordedBy: string;
  journalId: string;
}
const disbursementSchema = new Schema<RefundDisbursementDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    refundId: { type: String, required: true },
    bankAccountId: { type: String, default: null },
    cashAccountId: { type: String, default: null },
    shiftId: { type: String, default: null },
    amountPaise: { type: Number, required: true },
    reference: { type: String, default: null },
    referenceNorm: { type: String, default: null },
    paidOn: { type: String, required: true },
    evidenceNote: { type: String, default: null },
    recordedBy: { type: String, required: true },
    journalId: { type: String, required: true },
  },
  baseSchemaOptions('refund_disbursements'),
);
disbursementSchema.index({ tenantId: 1, refundId: 1 }, { unique: true });
disbursementSchema.plugin(immutablePlugin);
disbursementSchema.plugin(tenantScopePlugin);
export const RefundDisbursement = model<RefundDisbursementDoc>('RefundDisbursement', disbursementSchema);

// ───────────────────────────────────────────────────────────── cashier shifts (FIN-12)

export interface CashierShiftDoc extends BaseDoc, FinanceCommon {
  cashierId: string;
  locationId: string;
  cashAccountId: string;
  state: ShiftState;
  openingPaise: number;
  countedPaise: number | null;
  expectedPaise: number | null;
  variancePaise: number | null;
  varianceNote: string | null;
  depositedPaise: number;
  signedOffBy: string | null;
  signedOffAt: Date | null;
  openedAt: Date;
  closedAt: Date | null;
}
const shiftSchema = new Schema<CashierShiftDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    cashierId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true },
    cashAccountId: { type: String, required: true },
    state: { type: String, enum: SHIFT_STATES, default: 'OPEN' },
    openingPaise: { type: Number, default: 0 },
    countedPaise: { type: Number, default: null },
    expectedPaise: { type: Number, default: null },
    variancePaise: { type: Number, default: null },
    varianceNote: { type: String, default: null },
    depositedPaise: { type: Number, default: 0 },
    signedOffBy: { type: String, default: null },
    signedOffAt: { type: Date, default: null },
    openedAt: { type: Date, default: () => new Date() },
    closedAt: { type: Date, default: null },
  },
  baseSchemaOptions('cashier_shifts'),
);
shiftSchema.index({ tenantId: 1, legalEntityId: 1, cashierId: 1 }, { unique: true, partialFilterExpression: { state: 'OPEN' }, name: 'one_open_shift_per_cashier' });
shiftSchema.index({ tenantId: 1, legalEntityId: 1, state: 1, openedAt: -1 });
shiftSchema.plugin(tenantScopePlugin);
export const CashierShift = model<CashierShiftDoc>('CashierShift', shiftSchema);

export interface CashMovementDoc extends BaseDoc, FinanceCommon {
  shiftId: string | null;
  cashAccountId: string;
  locationId: string;
  kind: 'COLLECTION' | 'REFUND' | 'CANCELLED_RECEIPT' | 'DEPOSIT' | 'RETURNED';
  /** Signed: money in is positive, money out is negative. */
  amountPaise: number;
  date: string;
  collectionId: string | null;
  refundId: string | null;
  description: string;
  createdBy: string | null;
}
const movementSchema = new Schema<CashMovementDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    shiftId: { type: String, default: null },
    cashAccountId: { type: String, required: true },
    locationId: { type: String, required: true },
    kind: { type: String, enum: ['COLLECTION', 'REFUND', 'CANCELLED_RECEIPT', 'DEPOSIT', 'RETURNED'], required: true },
    amountPaise: { type: Number, required: true },
    date: { type: String, required: true },
    collectionId: { type: String, default: null },
    refundId: { type: String, default: null },
    description: { type: String, default: '' },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('cash_movements'),
);
movementSchema.index({ tenantId: 1, shiftId: 1 });
movementSchema.index({ tenantId: 1, legalEntityId: 1, date: 1 });
movementSchema.plugin(immutablePlugin);
movementSchema.plugin(tenantScopePlugin);
export const CashMovement = model<CashMovementDoc>('CashMovement', movementSchema);

export interface CashDepositBatchDoc extends BaseDoc, FinanceCommon {
  shiftIds: string[];
  bankAccountId: string;
  cashAccountId: string;
  locationId: string;
  amountPaise: number;
  depositedOn: string;
  reference: string | null;
  journalId: string | null;
  matchedLineId: string | null;
  createdBy: string | null;
}
const depositSchema = new Schema<CashDepositBatchDoc>(
  {
    ...uuidPrimaryKey,
    ...common,
    shiftIds: { type: [String], default: [] },
    bankAccountId: { type: String, required: true },
    cashAccountId: { type: String, required: true },
    locationId: { type: String, required: true },
    amountPaise: { type: Number, required: true },
    depositedOn: { type: String, required: true },
    reference: { type: String, default: null },
    journalId: { type: String, default: null },
    matchedLineId: { type: String, default: null },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('cash_deposit_batches'),
);
depositSchema.index({ tenantId: 1, legalEntityId: 1, depositedOn: -1 });
depositSchema.plugin(tenantScopePlugin);
export const CashDepositBatch = model<CashDepositBatchDoc>('CashDepositBatch', depositSchema);
