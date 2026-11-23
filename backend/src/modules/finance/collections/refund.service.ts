import type { RefundableDTO, RefundDTO, RefundState } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { Person } from '../../staff/person.model';
import { todayFor } from '../../staff/status';
import { StudentGuardianLink } from '../../students/student.models';
import { rolesMap } from '../core/chart.service';
import { auditFinance, emitFinance, financeCtx, financeScope, fyCodeFor, nextNumber, scopeFilter, type FinanceCtx } from '../core/context';
import { ApprovalPolicy, BankAccount, CashAccount, type ApprovalPolicyDoc, type BankAccountDoc, type CashAccountDoc } from '../core/models';
import { formatMoney } from '../core/money';
import { studentLabels } from '../core/people';
import { postJournal } from '../core/posting';
import { balancesOf, loadStudentFor } from '../fees/account.service';
import { nextSeq } from '../fees/documents';
import { FeeDocument, FeeDocumentLine, StudentLedgerEntry } from '../fees/models';
import { drawFromPool } from './alloc';
import { normRef } from './collection.service';
import { RefundDisbursement, RefundRequest, type RefundRequestDoc } from './models';
import { recordCashMovement, requireOpenShift } from './shift.service';

/**
 * Refunds (COL-10). A refund is money the school hands back, so it goes through three separate steps that different people can own:
 *   request   checks how much can really be refunded (advance + a settled deposit, less open bills and refunds already in progress)
 *   approve   a second person agrees. Books the school's promise to pay:  Dr Student Advance (or Deposit), Cr Refunds Payable
 *   disburse  the money really left the bank or the cash drawer:        Dr Refunds Payable, Cr Bank (or Cash)
 * "Approved" never means "paid".
 */

const IN_PROGRESS: RefundState[] = ['REQUESTED', 'ELIGIBLE', 'APPROVED'];

async function openRefundsPaise(f: FinanceCtx, studentId: string): Promise<number> {
  const rows = await RefundRequest.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentId, state: { $in: IN_PROGRESS } }).select('amountPaise state').lean<{ amountPaise: number; state: string }[]>();
  return rows.reduce((s, r) => s + r.amountPaise, 0);
}

/** Deposit money that was paid in full and has not been refunded yet. */
async function depositsHeld(f: FinanceCtx, studentId: string): Promise<number> {
  const lines = await FeeDocumentLine.find({ tenantId: f.tenantId, studentId, isDeposit: true }).select('documentId totalPaise originalLineId').lean<{ documentId: string; totalPaise: number; originalLineId: string | null }[]>();
  const docs = await FeeDocument.find({ tenantId: f.tenantId, _id: { $in: lines.map((l) => l.documentId) } }).select('status kind').lean<{ _id: string; status: string; kind: string }[]>();
  const settled = new Set(docs.filter((d) => d.status === 'SETTLED' && d.kind !== 'CREDIT_NOTE').map((d) => d._id));
  const gross = lines.filter((l) => settled.has(l.documentId)).reduce((s, l) => s + l.totalPaise, 0);
  const refunded = (await RefundRequest.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentId, state: { $in: ['APPROVED', 'PAID'] } }).select('fromDepositPaise').lean<{ fromDepositPaise: number }[]>()).reduce((s, r) => s + r.fromDepositPaise, 0);
  return Math.max(0, gross - refunded);
}

export async function refundable(ctx: ServiceContext, studentId: string): Promise<RefundableDTO> {
  const f = await financeCtx(ctx);
  await loadStudentFor(ctx, f, studentId);
  return refundableOf(ctx, f, studentId);
}

async function refundableOf(ctx: ServiceContext, f: FinanceCtx, studentId: string): Promise<RefundableDTO> {
  const [b, deposit, open] = await Promise.all([balancesOf(f, studentId, await todayFor(ctx)), depositsHeld(f, studentId), openRefundsPaise(f, studentId)]);
  // Money owed back is the advance plus a paid deposit, but open bills come out of it first, and so do refunds already in progress.
  const gross = b.advancePaise + deposit;
  const refundablePaise = Math.max(0, gross - b.outstandingPaise - open);
  const sentence = refundablePaise > 0
    ? `${formatMoney(refundablePaise)} can be refunded (${formatMoney(b.advancePaise)} advance + ${formatMoney(deposit)} deposit${b.outstandingPaise ? ` − ${formatMoney(b.outstandingPaise)} still owed` : ''}${open ? ` − ${formatMoney(open)} already being refunded` : ''}).`
    : 'Nothing can be refunded for this student right now.';
  return { studentId, advancePaise: b.advancePaise, depositPaise: deposit, outstandingPaise: b.outstandingPaise, openRefundsPaise: open, refundablePaise, sentence };
}

async function dtos(f: FinanceCtx, rows: RefundRequestDoc[]): Promise<RefundDTO[]> {
  const [labels, users] = await Promise.all([
    studentLabels(f, rows.map((r) => r.studentId)),
    User.find({ tenantId: f.tenantId, _id: { $in: [...new Set(rows.flatMap((r) => [r.requestedBy, r.approvedBy]).filter((x): x is string => !!x))] } }).select('fullName').lean<{ _id: string; fullName: string }[]>(),
  ]);
  const name = new Map(users.map((u) => [u._id, u.fullName]));
  return rows.map((r) => ({
    refundId: r._id, number: r.number, studentId: r.studentId, studentName: labels.get(r.studentId)?.name ?? 'Student', state: r.state, reason: r.reason, amountPaise: r.amountPaise, fromAdvancePaise: r.fromAdvancePaise, fromDepositPaise: r.fromDepositPaise,
    recipientName: r.recipientName, requestedByName: name.get(r.requestedBy) ?? null, approvedByName: r.approvedBy ? name.get(r.approvedBy) ?? null : null, paidOn: r.paidOn, paidReference: r.paidReference, createdAt: r.createdAt.toISOString(),
  }));
}

export async function createRefund(ctx: ServiceContext, data: { studentId: string; reason: string; amountPaise: number; recipientPersonId?: string | undefined }): Promise<RefundDTO> {
  const f = await financeCtx(ctx);
  const placement = await loadStudentFor(ctx, f, data.studentId);
  if (!placement.locationId) throw new AppError('ALLOCATION_INVALID', 'This student has no campus yet.');
  const today = await todayFor(ctx);
  // The money goes to someone who is allowed to receive it: a guardian linked to this child.
  const guardians = await StudentGuardianLink.find({ tenantId: f.tenantId, studentId: data.studentId, cancelledAt: null }).select('guardianPersonId isPrimary').lean<{ guardianPersonId: string; isPrimary: boolean }[]>();
  const recipientId = data.recipientPersonId ?? guardians.find((g) => g.isPrimary)?.guardianPersonId ?? guardians[0]?.guardianPersonId ?? null;
  if (!recipientId) throw new AppError('ALLOCATION_INVALID', 'Add a parent or guardian for this child before refunding.');
  if (!guardians.some((g) => g.guardianPersonId === recipientId)) throw AppError.validation({ recipientPersonId: 'The refund must go to a parent or guardian of this child.' });
  const person = await Person.findOne({ _id: recipientId, tenantId: f.tenantId }).select('legalFirstName legalLastName preferredName').lean<{ legalFirstName: string; legalLastName: string; preferredName: string | null }>();
  const recipientName = person ? person.preferredName || `${person.legalFirstName} ${person.legalLastName}`.trim() : null;

  const created = await withTransaction(async (db) => {
    const r = await refundableOf(ctx, f, data.studentId);
    if (data.amountPaise > r.refundablePaise) throw new AppError('REFUND_EXCEEDS_CREDIT', `Only ${formatMoney(r.refundablePaise)} can be refunded.`, { refundablePaise: r.refundablePaise });
    // Advance goes first. A deposit is only touched for what the advance cannot cover.
    const fromAdvance = Math.min(data.amountPaise, Math.max(0, r.advancePaise - r.outstandingPaise - r.openRefundsPaise));
    const fromDeposit = data.amountPaise - fromAdvance;
    const number = await nextNumber(f, db, 'REF', fyCodeFor(today, f.entity.fyStartMonth));
    const [row] = await RefundRequest.create(
      [{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, number, studentId: data.studentId, locationId: placement.locationId!, reason: data.reason, amountPaise: data.amountPaise, fromAdvancePaise: fromAdvance, fromDepositPaise: fromDeposit, recipientPersonId: recipientId, recipientName, state: 'ELIGIBLE', requestedBy: ctx.userId }],
      { session: db },
    );
    await auditFinance(f, db, { action: 'refund.requested', entityType: 'refund', entityId: row!._id, after: { number, amountPaise: data.amountPaise, fromAdvancePaise: fromAdvance, fromDepositPaise: fromDeposit } });
    return row!.toObject() as RefundRequestDoc;
  });
  return (await dtos(f, [created]))[0]!;
}

async function scopedRefund(ctx: ServiceContext, f: FinanceCtx, id: string): Promise<RefundRequestDoc> {
  const r = await RefundRequest.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<RefundRequestDoc>();
  const scope = await financeScope(ctx);
  if (!r || (!scope.all && !scope.locationIds.includes(r.locationId))) throw AppError.notFound('Refund not found.');
  return r;
}

export async function approveRefund(ctx: ServiceContext, refundId: string): Promise<RefundDTO> {
  const f = await financeCtx(ctx);
  const first = await scopedRefund(ctx, f, refundId);
  const policy = await ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'REFUND' }).lean<ApprovalPolicyDoc>();
  if (first.requestedBy === ctx.userId && (policy?.needsDifferentApprover ?? true)) throw new AppError('SELF_APPROVAL_BLOCKED');
  const date = await todayFor(ctx);
  await withTransaction(async (db) => {
    const r = await RefundRequest.findOne({ _id: refundId, tenantId: f.tenantId }).session(db).lean<RefundRequestDoc>();
    if (!r || !['ELIGIBLE', 'REQUESTED'].includes(r.state)) throw new AppError('COLLECTION_STATE_INVALID', 'This refund was already decided.');
    const roles = await rolesMap(f, db);
    const payable = roles.get('REFUND_PAYABLE');
    const advance = roles.get('STUDENT_ADVANCE');
    const deposit = roles.get('REFUNDABLE_DEPOSIT');
    if (!payable || !advance || (r.fromDepositPaise > 0 && !deposit)) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing the refund, advance or deposit account. Use the standard chart in Finance Settings.');
    // The money is still there, so the check is repeated now: the student may have been billed, or part of the advance used, since the request.
    const b = await balancesOf(f, r.studentId, date);
    if (r.fromAdvancePaise > b.advancePaise) throw new AppError('REFUND_EXCEEDS_CREDIT', 'The advance is no longer enough for this refund.');
    if (r.fromAdvancePaise > 0) await drawFromPool(f, db, r.studentId, r.fromAdvancePaise);
    const { journal } = await postJournal(f, db, {
      eventType: 'refund.approved', sourceKey: `refund_approved:${r._id}`, accountingDate: date, memo: `Refund ${r.number} approved: ${r.reason}`, sourceType: 'refund', sourceId: r._id,
      lines: [
        ...(r.fromAdvancePaise > 0 ? [{ accountId: advance._id, debitPaise: r.fromAdvancePaise, locationId: r.locationId, studentId: r.studentId }] : []),
        ...(r.fromDepositPaise > 0 ? [{ accountId: deposit!._id, debitPaise: r.fromDepositPaise, locationId: r.locationId, studentId: r.studentId }] : []),
        { accountId: payable._id, creditPaise: r.amountPaise, locationId: r.locationId, studentId: r.studentId },
      ],
    });
    if (r.fromAdvancePaise > 0) await StudentLedgerEntry.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, studentId: r.studentId, date, kind: 'REFUND', amountPaise: r.fromAdvancePaise, journalId: journal._id, description: `Refund ${r.number} approved`, seq: nextSeq() }], { session: db });
    const res = await RefundRequest.updateOne({ _id: r._id, tenantId: f.tenantId, state: { $in: ['ELIGIBLE', 'REQUESTED'] } }, { $set: { state: 'APPROVED', approvedBy: ctx.userId, approvedAt: new Date(), approveJournalId: journal._id } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This refund was already decided.');
    await auditFinance(f, db, { action: 'refund.approved', entityType: 'refund', entityId: r._id, after: { amountPaise: r.amountPaise } });
    await emitFinance(f, db, 'refund.approved', { refundId: r._id, amountPaise: r.amountPaise });
  });
  return (await dtos(f, [await scopedRefund(ctx, f, refundId)]))[0]!;
}

export async function rejectRefund(ctx: ServiceContext, refundId: string, reason: string): Promise<RefundDTO> {
  const f = await financeCtx(ctx);
  await scopedRefund(ctx, f, refundId);
  const res = await RefundRequest.updateOne({ _id: refundId, tenantId: f.tenantId, state: { $in: ['ELIGIBLE', 'REQUESTED'] } }, { $set: { state: 'REJECTED', rejectReason: reason, approvedBy: ctx.userId, approvedAt: new Date() } });
  if (res.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This refund was already decided.');
  await auditFinance(f, undefined, { action: 'refund.rejected', entityType: 'refund', entityId: refundId, after: { reason } });
  return (await dtos(f, [await scopedRefund(ctx, f, refundId)]))[0]!;
}

/** The money really left. Only now does the school's promise to pay (Refunds Payable) turn into a payment out of the bank or cash drawer. */
export async function recordDisbursement(ctx: ServiceContext, refundId: string, data: { bankAccountId?: string | undefined; cashAccountId?: string | undefined; reference?: string | null | undefined; paidOn?: string | null | undefined; evidenceNote?: string | null | undefined }): Promise<RefundDTO> {
  const f = await financeCtx(ctx);
  await scopedRefund(ctx, f, refundId);
  const date = data.paidOn ?? (await todayFor(ctx));
  await withTransaction(async (db) => {
    const r = await RefundRequest.findOne({ _id: refundId, tenantId: f.tenantId }).session(db).lean<RefundRequestDoc>();
    if (!r || r.state !== 'APPROVED') throw new AppError('COLLECTION_STATE_INVALID', r?.state === 'PAID' ? 'This refund was already paid.' : 'Approve the refund before recording the payment.');
    const payable = (await rolesMap(f, db)).get('REFUND_PAYABLE')!;
    let gl: string;
    let shiftId: string | null = null;
    let cashAccountId: string | null = null;
    if (data.bankAccountId) {
      const bank = await BankAccount.findOne({ _id: data.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).session(db).lean<BankAccountDoc>();
      if (!bank) throw AppError.notFound('Bank account not found.');
      gl = bank.glAccountId;
    } else {
      const cash = await CashAccount.findOne({ _id: data.cashAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).session(db).lean<CashAccountDoc>();
      if (!cash) throw AppError.notFound('Cash account not found.');
      shiftId = (await requireOpenShift(f, ctx.userId, db))._id;
      gl = cash.glAccountId;
      cashAccountId = cash._id;
    }
    const { journal } = await postJournal(f, db, {
      eventType: 'refund.paid', sourceKey: `refund_paid:${r._id}`, accountingDate: date, memo: `Refund ${r.number} paid`, sourceType: 'refund', sourceId: r._id,
      lines: [{ accountId: payable._id, debitPaise: r.amountPaise, locationId: r.locationId, studentId: r.studentId }, { accountId: gl, creditPaise: r.amountPaise, locationId: r.locationId }],
    });
    const [dis] = await RefundDisbursement.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, refundId: r._id, bankAccountId: data.bankAccountId ?? null, cashAccountId, shiftId, amountPaise: r.amountPaise, reference: data.reference ?? null, referenceNorm: normRef(data.reference), paidOn: date, evidenceNote: data.evidenceNote ?? null, recordedBy: ctx.userId, journalId: journal._id }], { session: db });
    if (cashAccountId) await recordCashMovement(f, db, { shiftId, cashAccountId, locationId: r.locationId, kind: 'REFUND', amountPaise: -r.amountPaise, date, refundId: r._id, description: `Refund ${r.number} paid in cash` });
    const res = await RefundRequest.updateOne({ _id: r._id, tenantId: f.tenantId, state: 'APPROVED' }, { $set: { state: 'PAID', paidOn: date, paidReference: data.reference ?? null, disbursementId: dis!._id } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This refund was already paid.');
    await auditFinance(f, db, { action: 'refund.disbursed', entityType: 'refund', entityId: r._id, after: { amountPaise: r.amountPaise, paidOn: date } });
    await emitFinance(f, db, 'refund.disbursed', { refundId: r._id, amountPaise: r.amountPaise });
  });
  return (await dtos(f, [await scopedRefund(ctx, f, refundId)]))[0]!;
}

export async function listRefunds(ctx: ServiceContext, query: { page: number; pageSize: number; state?: string | undefined; studentId?: string | undefined }) {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope), ...(query.state ? { state: query.state } : {}), ...(query.studentId ? { studentId: query.studentId } : {}) };
  const [rows, total] = await Promise.all([RefundRequest.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<RefundRequestDoc[]>(), RefundRequest.countDocuments(filter)]);
  return { items: await dtos(f, rows), total, page: query.page, pageSize: query.pageSize };
}

