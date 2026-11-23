import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import {
  BANK_METHODS, FUNDED_STATUSES, MAX_DOCUMENT_BYTES,
  type AllocateData, type AllocationDTO, type ClaimDTO, type CollectionDTO, type CollectionFlag, type CollectionStatus, type CollectionListDTO, type CollectionResultDTO, type CreateClaimData, type CreateCollectionData, type ReceiptDTO, type ReceiptListDTO, type VerifyCollectionData,
} from '@shared';
import { AppError } from '../../../core/errors';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { sniffDocumentType, scanFile } from '../../../platform/identity/file-checks';
import { privateStorage } from '../../../platform/identity/private-storage';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { todayFor } from '../../staff/status';
import { assertParentCanAccess, assertParentRole, parentLinksFor } from '../../students/parent-access';
import { StudentGuardianLink } from '../../students/student.models';
import { checkApproval, consumeApproval } from '../core/approvals.service';
import { rolesMap } from '../core/chart.service';
import { auditFinance, emitFinance, financeCtx, financeScope, fyCodeFor, nextNumber, scopeFilter, type FinanceCtx } from '../core/context';
import { BankAccount, CashAccount, JournalLine, type BankAccountDoc, type CashAccountDoc } from '../core/models';
import { formatMoney } from '../core/money';
import { studentLabels } from '../core/people';
import { postJournal, reverseJournal, type PostLine } from '../core/posting';
import { loadStudentFor, placementOf, balancesOf } from '../fees/account.service';
import { issueDocument, nextSeq, type BuiltLine } from '../fees/documents';
import { FeeDocument, StudentLedgerEntry, type FeeDocumentDoc } from '../fees/models';
import { advanceOf, allocateInTx, drawFromPool, mergeLines, openBills, planOldestFirst, reverseAllocationInTx, type AllocItem } from './alloc';
import { Collection, CollectionAllocation, PaymentClaim, Receipt, ReceiptCancellation, type CollectionDoc, type PaymentClaimDoc, type ReceiptCancellationDoc, type ReceiptDoc, type CollectionAllocationDoc } from './models';
import { recordCashMovement, requireOpenShift, openShiftOf } from './shift.service';

/**
 * Collections (COL-01 to 09). Three kinds of "payment" live here and they are kept apart on purpose:
 *   claim        what a family says ("I paid by UPI"). It never touches a bill or the books.
 *   collection   money the school received. Cash is counted at the counter; UPI and bank transfers wait until a person has SEEN the money;
 *                a cheque is only a promise until it clears.
 *   receipt      the final paper, made only after the money is verified. Never for a claim.
 * Posting a verified collection is one transaction: Dr Bank or Cash, Cr Student Advance; then the allocation to bills (Dr Advance, Cr Receivable).
 */

/** Upper case, with spaces, dashes and any other mark taken out, so `utr 99-88` and `UTR9988` are the same reference. */
export const normRef = (s: string | null | undefined): string | null => (s ? s.toUpperCase().replace(/[^A-Z0-9]/g, '') || null : null);
const DEAD: CollectionStatus[] = ['REJECTED', 'RETURNED', 'REVERSED'];

// ───────────────────────────────────────────────────────────── a hook for bank statement lines (Part 3B registers it)

export type StatementLineLinker = (f: FinanceCtx, db: ClientSession, input: { lineId: string; collection: CollectionDoc; amountPaise: number }) => Promise<void>;
let linkStatementLine: StatementLineLinker | null = null;
export const registerStatementLineLinker = (fn: StatementLineLinker) => void (linkStatementLine = fn);

// ───────────────────────────────────────────────────────────── DTOs

async function namesOf(f: FinanceCtx, ids: (string | null | undefined)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  return new Map((await User.find({ tenantId: f.tenantId, _id: { $in: unique } }).select('fullName').lean<{ _id: string; fullName: string }[]>()).map((u) => [u._id, u.fullName]));
}

function receiptDTO(r: ReceiptDoc, labels: Map<string, { name: string }>, cancel: ReceiptCancellationDoc | null): ReceiptDTO {
  return {
    receiptId: r._id, number: r.number, collectionId: r.collectionId, status: cancel ? 'CANCELLED' : 'ISSUED', amountPaise: r.amountPaise, advancePaise: r.advancePaise, method: r.method, receivedOn: r.receivedOn, payerName: r.payerName,
    lines: r.lines.map((l) => ({ studentId: l.studentId, studentName: labels.get(l.studentId)?.name ?? 'Student', documentNumber: l.documentNumber, amountPaise: l.amountPaise })), cancelledReason: cancel?.reason ?? null, cancelledAt: cancel ? cancel.cancelledAt.toISOString() : null,
  };
}

export async function receiptDTOs(f: FinanceCtx, rows: ReceiptDoc[]): Promise<ReceiptDTO[]> {
  const [labels, cancels] = await Promise.all([
    studentLabels(f, rows.flatMap((r) => r.studentIds)),
    ReceiptCancellation.find({ tenantId: f.tenantId, receiptId: { $in: rows.map((r) => r._id) } }).lean<ReceiptCancellationDoc[]>(),
  ]);
  const byReceipt = new Map(cancels.map((c) => [c.receiptId, c]));
  return rows.map((r) => receiptDTO(r, labels, byReceipt.get(r._id) ?? null));
}

export async function collectionDTOs(f: FinanceCtx, rows: CollectionDoc[]): Promise<CollectionDTO[]> {
  const ids = rows.map((r) => r._id);
  const [labels, allocs, receipts, names] = await Promise.all([
    studentLabels(f, rows.flatMap((r) => [...r.studentIds, ...r.plan.map((p) => p.studentId)])),
    CollectionAllocation.find({ tenantId: f.tenantId, collectionId: { $in: ids } }).sort({ createdAt: 1 }).lean<CollectionAllocationDoc[]>(),
    Receipt.find({ tenantId: f.tenantId, collectionId: { $in: ids } }).select('number collectionId').lean<{ _id: string; number: string; collectionId: string }[]>(),
    namesOf(f, rows.map((r) => r.createdBy)),
  ]);
  const docs = new Map((await FeeDocument.find({ tenantId: f.tenantId, _id: { $in: allocs.map((a) => a.documentId) } }).select('number').lean<{ _id: string; number: string }[]>()).map((d) => [d._id, d.number]));
  const receiptBy = new Map(receipts.map((r) => [r.collectionId, r]));
  return rows.map((c) => ({
    collectionId: c._id, method: c.method, status: c.status, payerName: c.payerName, amountPaise: c.amountPaise, unallocatedPaise: c.unallocatedPaise, receivedOn: c.receivedOn, reference: c.reference, flags: c.flags, cheque: c.cheque,
    provisionalNumber: c.provisionalNumber, receiptId: receiptBy.get(c._id)?._id ?? null, receiptNumber: receiptBy.get(c._id)?.number ?? null, claimId: c.claimId, shiftId: c.shiftId, bankAccountId: c.bankAccountId, cashAccountId: c.cashAccountId,
    students: c.studentIds.map((id) => ({ studentId: id, studentName: labels.get(id)?.name ?? 'Student' })),
    plannedAllocations: c.plan.map((p) => ({ studentId: p.studentId, studentName: labels.get(p.studentId)?.name ?? 'Student', documentId: p.documentId, amountPaise: p.amountPaise })),
    allocations: allocs.filter((a) => a.collectionId === c._id).map<AllocationDTO>((a) => ({ allocationId: a._id, studentId: a.studentId, studentName: labels.get(a.studentId)?.name ?? 'Student', documentId: a.documentId, documentNumber: docs.get(a.documentId) ?? '', amountPaise: a.amountPaise, status: a.status, reversalOfId: a.reversalOfId })),
    cashierName: c.createdBy ? names.get(c.createdBy) ?? null : null, returnedReason: c.returnedReason, createdAt: c.createdAt.toISOString(),
  }));
}

async function claimDTOs(f: FinanceCtx, rows: PaymentClaimDoc[]): Promise<ClaimDTO[]> {
  const [labels, names] = await Promise.all([studentLabels(f, rows.flatMap((r) => r.students.map((s) => s.studentId))), namesOf(f, rows.map((r) => r.reportedBy))]);
  return rows.map((c) => ({
    claimId: c._id, status: c.status, method: c.method, amountPaise: c.amountPaise, paidOn: c.paidOn, reference: c.reference, students: c.students.map((s) => ({ studentId: s.studentId, studentName: labels.get(s.studentId)?.name ?? 'Student', amountPaise: s.amountPaise })),
    flags: c.flags, hasProof: Boolean(c.proofKey), reportedByName: names.get(c.reportedBy) ?? null, reportedByParent: c.reportedByParent, rejectReason: c.rejectReason, collectionId: c.collectionId, createdAt: c.createdAt.toISOString(),
  }));
}

// ───────────────────────────────────────────────────────────── helpers

async function loadCollection(f: FinanceCtx, id: string, db?: ClientSession): Promise<CollectionDoc> {
  const c = await Collection.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<CollectionDoc>();
  if (!c) throw AppError.notFound('Payment not found.');
  return c;
}

async function scopedCollection(ctx: ServiceContext, f: FinanceCtx, id: string, db?: ClientSession): Promise<CollectionDoc> {
  const c = await loadCollection(f, id, db);
  const scope = await financeScope(ctx, db);
  if (!scope.all && !scope.locationIds.includes(c.locationId)) throw AppError.notFound('Payment not found.');
  return c;
}

/** Two children may share one payment only when they have a guardian in common. */
async function assertSameFamily(f: FinanceCtx, studentIds: string[]) {
  if (studentIds.length < 2) return;
  const links = await StudentGuardianLink.find({ tenantId: f.tenantId, studentId: { $in: studentIds }, cancelledAt: null }).select('studentId guardianPersonId').lean<{ studentId: string; guardianPersonId: string }[]>();
  const sets = studentIds.map((id) => new Set(links.filter((l) => l.studentId === id).map((l) => l.guardianPersonId)));
  const common = [...sets[0]!].filter((g) => sets.every((s) => s.has(g)));
  if (common.length === 0) throw new AppError('ALLOCATION_INVALID', 'One payment can only cover children of the same family.');
}

async function bankFor(f: FinanceCtx, locationId: string, requested: string | null | undefined, db?: ClientSession): Promise<BankAccountDoc> {
  const serves = (b: BankAccountDoc) => b.locationIds.length === 0 || b.locationIds.includes(locationId);
  if (requested) {
    const b = await BankAccount.findOne({ _id: requested, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).session(db ?? null).lean<BankAccountDoc>();
    if (!b) throw AppError.notFound('Bank account not found.');
    if (!serves(b)) throw new AppError('ALLOCATION_INVALID', 'This bank account does not serve the student\'s campus.');
    return b;
  }
  const all = (await BankAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).sort({ createdAt: 1 }).session(db ?? null).lean<BankAccountDoc[]>()).filter(serves);
  const fees = all.filter((b) => b.purpose === 'FEES');
  const pick = fees.length === 1 ? fees[0] : fees.length === 0 && all.length === 1 ? all[0] : undefined;
  if (!pick) throw AppError.validation({ bankAccountId: all.length === 0 ? 'Add a bank account in Finance Settings first.' : 'Choose which bank account received this money.' });
  return pick;
}

// ───────────────────────────────────────────────────────────── funding: the one place money is posted

/** Works out what to pay, now, from this payment's plan: named bills first, then the oldest bills. Never more than the money. */
async function resolvePlan(f: FinanceCtx, db: ClientSession, c: CollectionDoc, available: number): Promise<AllocItem[]> {
  if (c.autoAllocate) return planOldestFirst(f, c.studentIds, available, db);
  const items: AllocItem[] = [];
  let left = available;
  for (const p of c.plan) {
    if (left <= 0) break;
    const want = Math.min(p.amountPaise, left);
    if (p.documentId) {
      const doc = await FeeDocument.findOne({ _id: p.documentId, tenantId: f.tenantId, studentId: p.studentId }).session(db).select('balancePaise status').lean<{ balancePaise: number; status: string }>();
      const take = Math.min(want, doc && doc.status !== 'CANCELLED' ? doc.balancePaise : 0);
      if (take > 0) {
        const already = items.filter((i) => i.documentId === p.documentId).reduce((s, i) => s + i.amountPaise, 0);
        const room = Math.max(0, (doc?.balancePaise ?? 0) - already);
        if (Math.min(take, room) > 0) items.push({ studentId: p.studentId, documentId: p.documentId, amountPaise: Math.min(take, room) });
      }
    } else items.push(...(await planOldestFirst(f, [p.studentId], want, db)));
    left = available - items.reduce((s, i) => s + i.amountPaise, 0);
  }
  return items;
}

interface FundResult {
  receipt: ReceiptDoc;
  items: AllocItem[];
}

/**
 * Money is confirmed: post it, put it against bills and issue the receipt. Everything in the caller's transaction.
 * `expect` guards the state change, so two people confirming the same payment at once cannot both succeed.
 */
async function fundCollection(f: FinanceCtx, db: ClientSession, c: CollectionDoc, o: { date: string; glAccountId: string; status: 'POSTED' | 'CLEARED'; expect: CollectionStatus[]; patch?: Record<string, unknown>; amountPaise?: number }): Promise<FundResult> {
  const amount = o.amountPaise ?? c.amountPaise;
  const roles = await rolesMap(f, db);
  const advance = roles.get('STUDENT_ADVANCE');
  if (!advance) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing the student advance account. Use the standard chart in Finance Settings.');
  const items = await resolvePlan(f, db, c, amount);
  const share = new Map<string, number>();
  for (const i of items) share.set(i.studentId, (share.get(i.studentId) ?? 0) + i.amountPaise);
  const paid = items.reduce((s, i) => s + i.amountPaise, 0);
  if (amount - paid > 0) share.set(c.advanceStudentId, (share.get(c.advanceStudentId) ?? 0) + (amount - paid));

  const flip = await Collection.updateOne(
    { _id: c._id, tenantId: f.tenantId, status: { $in: o.expect } },
    { $set: { status: o.status, amountPaise: amount, unallocatedPaise: amount, ...(o.patch ?? {}) }, $inc: { version: 1 } },
    { session: db },
  );
  if (flip.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This payment was just changed by someone else.');

  const { journal } = await postJournal(f, db, {
    eventType: 'collection.posted', sourceKey: `collection:${c._id}`, accountingDate: o.date, memo: `${c.method === 'CASH' ? 'Cash' : c.method} received${c.reference ? ` (${c.reference})` : ''}`, sourceType: 'collection', sourceId: c._id,
    lines: [
      { accountId: o.glAccountId, debitPaise: amount, locationId: c.locationId },
      ...[...share.entries()].map(([studentId, paise]) => ({ accountId: advance._id, creditPaise: paise, locationId: c.locationId, studentId })),
    ],
  });
  const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
  await StudentLedgerEntry.create(
    [...share.entries()].map(([studentId, paise]) => ({ ...base, studentId, date: o.date, kind: 'ADVANCE_IN' as const, amountPaise: -paise, collectionId: c._id, journalId: journal._id, description: `${c.method === 'CASH' ? 'Cash' : c.method} payment received`, seq: nextSeq() })),
    { session: db, ordered: true },
  );
  await Collection.updateOne({ _id: c._id, tenantId: f.tenantId }, { $set: { journalId: journal._id } }, { session: db });
  await allocateInTx(f, db, { collectionId: c._id, items, date: o.date, batchKey: `fund:${c._id}`, note: `Payment applied to bills` });

  const docs = new Map((await FeeDocument.find({ tenantId: f.tenantId, _id: { $in: items.map((i) => i.documentId) } }).select('number').session(db).lean<{ _id: string; number: string }[]>()).map((d) => [d._id, d.number]));
  const number = await nextNumber(f, db, 'RCT', fyCodeFor(o.date, f.entity.fyStartMonth));
  const receiptId = randomUUID();
  const [receipt] = await Receipt.create(
    [
      {
        _id: receiptId, ...base, number, collectionId: c._id, studentIds: [...share.keys()], locationId: c.locationId, amountPaise: amount, advancePaise: amount - paid, method: c.method, receivedOn: c.receivedOn, payerName: c.payerName,
        lines: items.map((i) => ({ studentId: i.studentId, documentNumber: docs.get(i.documentId) ?? '', amountPaise: i.amountPaise })), cashierId: f.system ? null : f.userId, createdBy: f.system ? null : f.userId,
      },
    ],
    { session: db },
  );
  await Collection.updateOne({ _id: c._id, tenantId: f.tenantId }, { $set: { receiptId } }, { session: db });
  await auditFinance(f, db, { action: 'receipt.issued', entityType: 'receipt', entityId: receiptId, after: { number, amountPaise: amount, collectionId: c._id, bills: items.length } });
  await emitFinance(f, db, 'receipt.issued', { receiptId, number, collectionId: c._id, amountPaise: amount });
  return { receipt: receipt!.toObject() as ReceiptDoc, items };
}

// ───────────────────────────────────────────────────────────── claims (COL-01)

async function flagsFor(f: FinanceCtx, input: { referenceNorm: string | null; amountPaise: number; paidOn: string; studentIds: string[]; excludeClaimId?: string; method: string }): Promise<CollectionFlag[]> {
  const flags: CollectionFlag[] = [];
  if (input.referenceNorm) {
    const [c, p] = await Promise.all([
      Collection.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, referenceNorm: input.referenceNorm, status: { $nin: DEAD } }),
      PaymentClaim.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, referenceNorm: input.referenceNorm, status: { $in: ['REPORTED', 'PENDING_VERIFICATION', 'VERIFIED'] }, ...(input.excludeClaimId ? { _id: { $ne: input.excludeClaimId } } : {}) }),
    ]);
    if (c || p) flags.push('DUPLICATE_SUSPECTED');
  }
  if (!flags.length && input.method !== 'CASH') {
    const [c, p] = await Promise.all([
      Collection.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, amountPaise: input.amountPaise, receivedOn: input.paidOn, studentIds: { $in: input.studentIds }, method: { $ne: 'CASH' }, status: { $nin: DEAD } }),
      PaymentClaim.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, amountPaise: input.amountPaise, paidOn: input.paidOn, 'students.studentId': { $in: input.studentIds }, status: { $in: ['REPORTED', 'PENDING_VERIFICATION', 'VERIFIED'] }, ...(input.excludeClaimId ? { _id: { $ne: input.excludeClaimId } } : {}) }),
    ]);
    if (c || p) flags.push('DUPLICATE_SUSPECTED');
  }
  return flags;
}

export async function createClaim(ctx: ServiceContext, data: CreateClaimData, mode: 'PARENT' | 'STAFF'): Promise<ClaimDTO> {
  const f = await financeCtx(ctx);
  const studentIds = data.students.map((s) => s.studentId);
  if (new Set(studentIds).size !== studentIds.length) throw AppError.validation({ students: 'Each child can be listed only once.' });
  let locationId: string | null = null;
  if (mode === 'PARENT') {
    assertParentRole(ctx);
    for (const id of studentIds) await assertParentCanAccess(ctx, id, 'FEES');
    locationId = (await placementOf(f, studentIds[0]!)).locationId;
  } else {
    locationId = (await loadStudentFor(ctx, f, studentIds[0]!)).locationId;
    for (const id of studentIds.slice(1)) await loadStudentFor(ctx, f, id);
  }
  await assertSameFamily(f, studentIds);
  const paidOn = data.paidOn;
  if (paidOn > (await todayFor(ctx))) throw AppError.validation({ paidOn: 'The payment date cannot be in the future.' });
  const referenceNorm = normRef(data.reference);
  const flags = await flagsFor(f, { referenceNorm, amountPaise: data.amountPaise, paidOn, studentIds, method: data.method });
  const claim = await withTransaction(async (db) => {
    const [created] = await PaymentClaim.create(
      [{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, students: data.students, method: data.method, amountPaise: data.amountPaise, paidOn, reference: data.reference ?? null, referenceNorm, status: 'PENDING_VERIFICATION', flags, locationId, reportedBy: ctx.userId, reportedByParent: mode === 'PARENT' }],
      { session: db },
    );
    await auditFinance(f, db, { action: 'payment_claim.reported', entityType: 'payment_claim', entityId: created!._id, after: { amountPaise: data.amountPaise, method: data.method, flags } });
    return created!.toObject() as PaymentClaimDoc;
  });
  return (await claimDTOs(f, [claim]))[0]!;
}

export async function listClaims(ctx: ServiceContext, query: { page: number; pageSize: number; status?: string | undefined; studentId?: string | undefined; flagged?: boolean | undefined }) {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter: Record<string, unknown> = {
    tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(scope.all ? {} : { locationId: { $in: scope.locationIds } }), ...(query.status ? { status: query.status } : {}), ...(query.studentId ? { 'students.studentId': query.studentId } : {}), ...(query.flagged ? { flags: { $ne: [] } } : {}),
  };
  const [rows, total] = await Promise.all([PaymentClaim.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<PaymentClaimDoc[]>(), PaymentClaim.countDocuments(filter)]);
  return { items: await claimDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function listParentClaims(ctx: ServiceContext): Promise<ClaimDTO[]> {
  assertParentRole(ctx);
  const f = await financeCtx(ctx);
  const found = await parentLinksFor(ctx, 'FEES');
  const ids = [...new Set((found?.links ?? []).map((l) => l.studentId))];
  const rows = await PaymentClaim.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, 'students.studentId': { $in: ids } }).sort({ createdAt: -1 }).limit(50).lean<PaymentClaimDoc[]>();
  // A claim that also lists a child this parent cannot see is shown with only the children they can see.
  const visible = rows.map((r) => ({ ...r, students: r.students.filter((s) => ids.includes(s.studentId)) }));
  return (await claimDTOs(f, visible)).map((d, i) => ({ ...d, amountPaise: visible[i]!.students.reduce((s, x) => s + x.amountPaise, 0), reference: d.reference, flags: [] }));
}

export async function attachClaimProof(ctx: ServiceContext, claimId: string, file: { buffer: Buffer } | undefined): Promise<ClaimDTO> {
  if (!file) throw AppError.validation({ file: 'Choose a file to upload.' });
  const f = await financeCtx(ctx);
  const claim = await PaymentClaim.findOne({ _id: claimId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<PaymentClaimDoc>();
  if (!claim || claim.reportedBy !== ctx.userId) throw AppError.notFound('Payment report not found.');
  if (claim.status !== 'PENDING_VERIFICATION') throw new AppError('COLLECTION_STATE_INVALID', 'This report has already been checked.');
  if (file.buffer.length > MAX_DOCUMENT_BYTES) throw new AppError('DOCUMENT_TOO_LARGE');
  if (!sniffDocumentType(file.buffer)) throw new AppError('UNSUPPORTED_DOCUMENT_TYPE');
  const scan = await scanFile(file.buffer);
  if (!scan.clean) throw new AppError('FILE_REJECTED');
  const key = await privateStorage.put(file.buffer, { folder: 'finance' });
  if (claim.proofKey) await privateStorage.remove(claim.proofKey);
  await PaymentClaim.updateOne({ _id: claim._id, tenantId: f.tenantId }, { $set: { proofKey: key } });
  return (await claimDTOs(f, [{ ...claim, proofKey: key }]))[0]!;
}

export async function claimProof(ctx: ServiceContext, claimId: string): Promise<{ buffer: Buffer; mime: string }> {
  const f = await financeCtx(ctx);
  const claim = await PaymentClaim.findOne({ _id: claimId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<PaymentClaimDoc>();
  if (!claim?.proofKey) throw AppError.notFound('No proof was uploaded.');
  const scope = await financeScope(ctx);
  if (!scope.all && claim.locationId && !scope.locationIds.includes(claim.locationId)) throw AppError.notFound('Payment report not found.');
  const buffer = await privateStorage.read(claim.proofKey);
  if (!buffer) throw AppError.notFound('No proof was uploaded.');
  await auditFinance(f, undefined, { action: 'payment_claim.proof_viewed', entityType: 'payment_claim', entityId: claim._id });
  return { buffer, mime: sniffDocumentType(buffer) ?? 'application/octet-stream' };
}

export async function rejectClaim(ctx: ServiceContext, claimId: string, reason: string): Promise<ClaimDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const claim = await PaymentClaim.findOne({ _id: claimId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<PaymentClaimDoc>();
    if (!claim) throw AppError.notFound('Payment report not found.');
    const scope = await financeScope(ctx, db);
    if (!scope.all && claim.locationId && !scope.locationIds.includes(claim.locationId)) throw AppError.notFound('Payment report not found.');
    const res = await PaymentClaim.updateOne({ _id: claimId, tenantId: f.tenantId, status: 'PENDING_VERIFICATION' }, { $set: { status: 'REJECTED', rejectReason: reason, decidedBy: ctx.userId, decidedAt: new Date() } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This report was already checked.');
    await auditFinance(f, db, { action: 'payment_claim.rejected', entityType: 'payment_claim', entityId: claimId, after: { reason } });
  });
  return (await claimDTOs(f, [(await PaymentClaim.findOne({ _id: claimId, tenantId: f.tenantId }).lean<PaymentClaimDoc>())!]))[0]!;
}

/** Staff have seen the money. The claim becomes a real, posted collection with its receipt, in one step. */
export async function verifyClaim(ctx: ServiceContext, claimId: string, data: VerifyCollectionData): Promise<CollectionResultDTO> {
  const f = await financeCtx(ctx);
  const claim = await PaymentClaim.findOne({ _id: claimId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<PaymentClaimDoc>();
  if (!claim) throw AppError.notFound('Payment report not found.');
  const scope = await financeScope(ctx);
  if (!scope.all && claim.locationId && !scope.locationIds.includes(claim.locationId)) throw AppError.notFound('Payment report not found.');
  if (claim.status === 'VERIFIED' && claim.collectionId) return resultFor(f, await loadCollection(f, claim.collectionId), true);
  if (claim.status !== 'PENDING_VERIFICATION') throw new AppError('COLLECTION_STATE_INVALID', 'This report was already checked.');
  const key = `claim:${claim._id}`;
  const existing = await Collection.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, idempotencyKey: key }).lean<CollectionDoc>();
  let collection = existing;
  if (!collection) {
    const locationId = claim.locationId ?? (await placementOf(f, claim.students[0]!.studentId)).locationId;
    if (!locationId) throw new AppError('ALLOCATION_INVALID', 'This student has no campus yet.');
    try {
      collection = await withTransaction(async (db) => {
        const [created] = await Collection.create(
          [
            {
              tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, method: claim.method, status: 'PENDING_VERIFICATION', payerName: null, amountPaise: claim.amountPaise, receivedOn: claim.paidOn, reference: claim.reference, referenceNorm: claim.referenceNorm,
              locationId, studentIds: claim.students.map((s) => s.studentId), advanceStudentId: claim.students[0]!.studentId, plan: claim.students.map((s) => ({ studentId: s.studentId, documentId: null, amountPaise: s.amountPaise })), flags: claim.flags, claimId: claim._id, idempotencyKey: key, createdBy: ctx.userId,
            },
          ],
          { session: db },
        );
        return created!.toObject() as CollectionDoc;
      });
    } catch (err) {
      if (!duplicateKeyFields(err)) throw err;
      collection = await Collection.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, idempotencyKey: key }).lean<CollectionDoc>();
    }
  }
  return verifyCollection(ctx, collection!._id, data);
}

// ───────────────────────────────────────────────────────────── collections (COL-02 to 05)

async function resultFor(f: FinanceCtx, c: CollectionDoc, repeated: boolean): Promise<CollectionResultDTO> {
  const [collection] = await collectionDTOs(f, [c]);
  const receipt = c.receiptId ? await Receipt.findOne({ _id: c.receiptId, tenantId: f.tenantId }).lean<ReceiptDoc>() : null;
  return { collection: collection!, receipt: receipt ? (await receiptDTOs(f, [receipt]))[0]! : null, repeated };
}

export async function createCollection(ctx: ServiceContext, data: CreateCollectionData, idempotencyKey: string | undefined): Promise<CollectionResultDTO> {
  if (!idempotencyKey) throw new AppError('IDEMPOTENCY_KEY_REQUIRED');
  const f = await financeCtx(ctx);
  const existing = await Collection.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, idempotencyKey }).lean<CollectionDoc>();
  if (existing) return resultFor(f, existing, true);

  const planInput = data.allocations ?? [];
  const studentIds = [...new Set([...planInput.map((a) => a.studentId), ...(data.autoAllocate?.studentIds ?? []), ...(data.advanceStudentId ? [data.advanceStudentId] : [])])];
  const placements = new Map<string, Awaited<ReturnType<typeof loadStudentFor>>>();
  for (const id of studentIds) placements.set(id, await loadStudentFor(ctx, f, id));
  await assertSameFamily(f, studentIds);
  const advanceStudentId = data.advanceStudentId ?? studentIds[0]!;
  const locationId = placements.get(advanceStudentId)?.locationId;
  if (!locationId) throw new AppError('ALLOCATION_INVALID', 'This student has no campus yet.');
  const today = await todayFor(ctx);
  const receivedOn = data.receivedOn ?? today;
  if (receivedOn > today) throw AppError.validation({ receivedOn: 'The date cannot be in the future.' });
  const reference = data.method === 'CHEQUE' ? `${data.cheque!.number} · ${data.cheque!.bankName}` : data.reference ?? null;
  const referenceNorm = normRef(data.method === 'CHEQUE' ? `${data.cheque!.bankName}-${data.cheque!.number}` : data.reference);
  const flags = await flagsFor(f, { referenceNorm, amountPaise: data.amountPaise, paidOn: receivedOn, studentIds, method: data.method });

  try {
    const outcome = await withTransaction(async (db) => {
      // Named bills must exist, belong to the child and have the money still owing.
      for (const a of planInput) {
        if (!a.documentId) continue;
        const doc = await FeeDocument.findOne({ _id: a.documentId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentId: a.studentId }).session(db).lean<FeeDocumentDoc>();
        if (!doc) throw AppError.notFound('Bill not found.');
        const sameBill = planInput.filter((x) => x.documentId === a.documentId).reduce((s, x) => s + x.amountPaise, 0);
        if (doc.status === 'CANCELLED' || doc.status === 'SETTLED' || sameBill > doc.balancePaise) throw new AppError('ALLOCATION_INVALID', `Bill ${doc.number} has only ${formatMoney(doc.status === 'SETTLED' || doc.status === 'CANCELLED' ? 0 : doc.balancePaise)} left to pay.`, { documentId: doc._id });
      }
      let shiftId: string | null = null;
      let cashAccount: CashAccountDoc | null = null;
      if (data.method === 'CASH') {
        const shift = await requireOpenShift(f, ctx.userId, db);
        shiftId = shift._id;
        cashAccount = await CashAccount.findOne({ _id: shift.cashAccountId, tenantId: f.tenantId }).session(db).lean<CashAccountDoc>();
      }
      let provisionalNumber: string | null = null;
      if (data.method === 'CHEQUE') provisionalNumber = await nextNumber(f, db, 'ACK', fyCodeFor(receivedOn, f.entity.fyStartMonth));
      const bank = data.bankAccountId ? await bankFor(f, locationId, data.bankAccountId, db) : null;
      const [created] = await Collection.create(
        [
          {
            tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, method: data.method, status: data.method === 'CHEQUE' ? 'RECEIVED' : 'PENDING_VERIFICATION', payerName: data.payerName ?? data.cheque?.payerName ?? null, amountPaise: data.amountPaise,
            unallocatedPaise: 0, receivedOn, reference, referenceNorm, bankAccountId: bank?._id ?? null, cashAccountId: cashAccount?._id ?? null, shiftId, locationId, studentIds, advanceStudentId, plan: planInput.map((a) => ({ studentId: a.studentId, documentId: a.documentId ?? null, amountPaise: a.amountPaise })),
            autoAllocate: Boolean(data.autoAllocate), flags, cheque: data.cheque ? { ...data.cheque, payerName: data.cheque.payerName ?? null } : null, provisionalNumber, idempotencyKey, createdBy: ctx.userId,
          },
        ],
        { session: db },
      );
      await auditFinance(f, db, { action: 'collection.recorded', entityType: 'collection', entityId: created!._id, after: { method: data.method, amountPaise: data.amountPaise, status: created!.status, flags } });
      await emitFinance(f, db, 'collection.recorded', { collectionId: created!._id, method: data.method, amountPaise: data.amountPaise });
      if (data.method !== 'CASH') return created!.toObject() as CollectionDoc;
      const gl = cashAccount?.glAccountId ?? (await rolesMap(f, db)).get('CASH')?._id;
      if (!gl) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts has no cash account. Use the standard chart in Finance Settings.');
      const { receipt } = await fundCollection(f, db, created!.toObject() as CollectionDoc, { date: receivedOn, glAccountId: gl, status: 'POSTED', expect: ['PENDING_VERIFICATION'], patch: { verifiedBy: ctx.userId, verifiedAt: new Date() } });
      await recordCashMovement(f, db, { shiftId, cashAccountId: cashAccount?._id ?? '', locationId, kind: 'COLLECTION', amountPaise: data.amountPaise, date: receivedOn, collectionId: created!._id, description: `Cash received, receipt ${receipt.number}` });
      return (await Collection.findOne({ _id: created!._id, tenantId: f.tenantId }).session(db).lean<CollectionDoc>())!;
    });
    return resultFor(f, outcome, false);
  } catch (err) {
    if (duplicateKeyFields(err)) {
      const again = await Collection.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, idempotencyKey }).lean<CollectionDoc>();
      if (again) return resultFor(f, again, true);
    }
    throw err;
  }
}

/** Someone has SEEN the money in the bank. Checks, then posts, allocates and issues the receipt. */
export async function verifyCollection(ctx: ServiceContext, collectionId: string, data: VerifyCollectionData): Promise<CollectionResultDTO> {
  const f = await financeCtx(ctx);
  const first = await scopedCollection(ctx, f, collectionId);
  if (first.status === 'POSTED' || first.status === 'CLEARED') return resultFor(f, first, true);
  if (first.status !== 'PENDING_VERIFICATION') throw new AppError('COLLECTION_STATE_INVALID', first.status === 'RECEIVED' || first.status === 'DEPOSITED' ? 'A cheque is confirmed when it clears, not here.' : 'This payment cannot be verified in its current state.');
  if (first.method === 'CASH') throw new AppError('COLLECTION_STATE_INVALID', 'Cash is counted at the counter and needs no verification.');

  if (data.amountSeenPaise !== first.amountPaise && !data.useSeenAmount) {
    if (!first.flags.includes('AMOUNT_MISMATCH')) await Collection.updateOne({ _id: first._id, tenantId: f.tenantId }, { $addToSet: { flags: 'AMOUNT_MISMATCH' } });
    throw new AppError('AMOUNT_MISMATCH', `The payment was reported as ${formatMoney(first.amountPaise)} but you saw ${formatMoney(data.amountSeenPaise)}.`, { reportedPaise: first.amountPaise, seenPaise: data.amountSeenPaise });
  }
  if (first.referenceNorm) {
    const clash = await Collection.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $ne: first._id }, referenceNorm: first.referenceNorm, status: { $in: ['POSTED', 'CLEARED', 'VERIFIED'] } });
    if (clash) throw new AppError('DUPLICATE_REFERENCE', 'This reference is already on another confirmed payment. It may be the same money counted twice.');
  }
  const bank = await bankFor(f, first.locationId, data.bankAccountId ?? first.bankAccountId);
  const outcome = await withTransaction(async (db) => {
    const c = await loadCollection(f, collectionId, db);
    if (data.evidence.statementLineId) {
      if (!linkStatementLine) throw new AppError('MATCH_INVALID', 'Bank statements are not available.');
      await linkStatementLine(f, db, { lineId: data.evidence.statementLineId, collection: c, amountPaise: data.amountSeenPaise });
    }
    await fundCollection(f, db, c, {
      date: data.evidence.seenOn, glAccountId: bank.glAccountId, status: 'POSTED', expect: ['PENDING_VERIFICATION'], amountPaise: data.amountSeenPaise,
      patch: { bankAccountId: bank._id, verifiedBy: ctx.userId, verifiedAt: new Date(), evidence: { statementLineId: data.evidence.statementLineId ?? null, note: data.evidence.note ?? null, seenOn: data.evidence.seenOn, amountSeenPaise: data.amountSeenPaise }, flags: c.flags.filter((x) => x !== 'AMOUNT_MISMATCH' && x !== 'BANK_CREDIT_NOT_FOUND') },
    });
    if (c.claimId) await PaymentClaim.updateOne({ _id: c.claimId, tenantId: f.tenantId }, { $set: { status: 'VERIFIED', collectionId: c._id, decidedBy: ctx.userId, decidedAt: new Date() } }, { session: db });
    await auditFinance(f, db, { action: 'collection.verified', entityType: 'collection', entityId: c._id, after: { amountSeenPaise: data.amountSeenPaise, seenOn: data.evidence.seenOn, bankAccountId: bank._id } });
    await emitFinance(f, db, 'collection.verified', { collectionId: c._id, amountPaise: data.amountSeenPaise });
    return (await loadCollection(f, c._id, db));
  });
  return resultFor(f, outcome, false);
}

export async function rejectCollection(ctx: ServiceContext, collectionId: string, reason: string): Promise<CollectionDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const c = await scopedCollection(ctx, f, collectionId, db);
    const res = await Collection.updateOne({ _id: c._id, tenantId: f.tenantId, status: { $in: ['PENDING_VERIFICATION', 'RECEIVED', 'DEPOSITED'] } }, { $set: { status: 'REJECTED', returnedReason: reason }, $inc: { version: 1 } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'Only a payment that is still waiting can be rejected.');
    if (c.claimId) await PaymentClaim.updateOne({ _id: c.claimId, tenantId: f.tenantId, status: 'PENDING_VERIFICATION' }, { $set: { status: 'REJECTED', rejectReason: reason, decidedBy: ctx.userId, decidedAt: new Date() } }, { session: db });
    await auditFinance(f, db, { action: 'collection.rejected', entityType: 'collection', entityId: c._id, after: { reason } });
  });
  return (await collectionDTOs(f, [await loadCollection(f, collectionId)]))[0]!;
}

// ───────────────────────────────────────────────────────────── cheques (COL-04)

export async function depositCheque(ctx: ServiceContext, collectionId: string, data: { depositedOn?: string | null | undefined; bankAccountId?: string | undefined }): Promise<CollectionDTO> {
  const f = await financeCtx(ctx);
  const c = await scopedCollection(ctx, f, collectionId);
  if (c.method !== 'CHEQUE') throw new AppError('COLLECTION_STATE_INVALID', 'Only a cheque is deposited.');
  const bank = await bankFor(f, c.locationId, data.bankAccountId ?? c.bankAccountId);
  const date = data.depositedOn ?? (await todayFor(ctx));
  const res = await Collection.updateOne({ _id: c._id, tenantId: f.tenantId, status: 'RECEIVED' }, { $set: { status: 'DEPOSITED', depositedOn: date, bankAccountId: bank._id }, $inc: { version: 1 } });
  if (res.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This cheque was already deposited.');
  await auditFinance(f, undefined, { action: 'cheque.deposited', entityType: 'collection', entityId: c._id, after: { depositedOn: date, bankAccountId: bank._id } });
  return (await collectionDTOs(f, [await loadCollection(f, collectionId)]))[0]!;
}

/** The cheque cleared: only now is it money. Posts it, applies it and issues the final receipt. */
export async function clearCheque(ctx: ServiceContext, collectionId: string, data: { clearedOn: string; bankAccountId?: string | undefined }): Promise<CollectionResultDTO> {
  const f = await financeCtx(ctx);
  const c = await scopedCollection(ctx, f, collectionId);
  if (c.method !== 'CHEQUE') throw new AppError('COLLECTION_STATE_INVALID', 'Only a cheque clears.');
  if (c.status === 'CLEARED') return resultFor(f, c, true);
  if (c.status !== 'RECEIVED' && c.status !== 'DEPOSITED') throw new AppError('COLLECTION_STATE_INVALID', 'This cheque cannot be cleared in its current state.');
  const bank = await bankFor(f, c.locationId, data.bankAccountId ?? c.bankAccountId);
  const outcome = await withTransaction(async (db) => {
    const fresh = await loadCollection(f, collectionId, db);
    await fundCollection(f, db, fresh, { date: data.clearedOn, glAccountId: bank.glAccountId, status: 'CLEARED', expect: ['RECEIVED', 'DEPOSITED'], patch: { clearedOn: data.clearedOn, bankAccountId: bank._id, verifiedBy: ctx.userId, verifiedAt: new Date() } });
    await auditFinance(f, db, { action: 'cheque.cleared', entityType: 'collection', entityId: collectionId, after: { clearedOn: data.clearedOn } });
    await emitFinance(f, db, 'collection.verified', { collectionId, amountPaise: fresh.amountPaise });
    return loadCollection(f, collectionId, db);
  });
  return resultFor(f, outcome, false);
}

/** Takes everything a collection did back: its allocations, then its posting. History stays; nothing is deleted. */
async function unwindCollection(ctx: ServiceContext, f: FinanceCtx, db: ClientSession, c: CollectionDoc, reason: string, finalStatus: 'RETURNED' | 'REVERSED', date: string) {
  const active = await CollectionAllocation.find({ tenantId: f.tenantId, collectionId: c._id, status: 'ACTIVE' }).session(db).select('_id').lean<{ _id: string }[]>();
  for (const a of active) await reverseAllocationInTx(f, db, a._id, reason, date);
  const fresh = await loadCollection(f, c._id, db);
  if (fresh.unallocatedPaise !== fresh.amountPaise) throw new AppError('COLLECTION_STATE_INVALID', 'Part of this money was already refunded or moved to another child, so it cannot be taken back. Ask for a refund to be reversed first.');
  const guard = await Collection.updateOne({ _id: c._id, tenantId: f.tenantId, status: { $in: ['POSTED', 'CLEARED'] }, unallocatedPaise: fresh.amountPaise }, { $set: { unallocatedPaise: 0, status: finalStatus, returnedReason: reason, returnedOn: date }, $inc: { version: 1 } }, { session: db });
  if (guard.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This payment was just changed by someone else.');
  if (c.journalId) {
    const lines = await JournalLine.find({ tenantId: f.tenantId, journalId: c.journalId, studentId: { $ne: null } }).session(db).lean<{ studentId: string; creditPaise: number }[]>();
    await reverseJournal(f, db, c.journalId, reason, { sourceKey: `unwind:${c._id}` });
    const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
    await StudentLedgerEntry.create(
      lines.filter((l) => l.creditPaise > 0).map((l) => ({ ...base, studentId: l.studentId, date, kind: 'ADVANCE_IN' as const, amountPaise: l.creditPaise, collectionId: c._id, description: `Payment taken back: ${reason}`, seq: nextSeq() })),
      { session: db, ordered: true },
    );
  }
  if (c.method === 'CASH') {
    const shift = await openShiftOf(f, ctx.userId, db);
    await recordCashMovement(f, db, { shiftId: shift?._id ?? null, cashAccountId: c.cashAccountId ?? '', locationId: c.locationId, kind: finalStatus === 'REVERSED' ? 'CANCELLED_RECEIPT' : 'RETURNED', amountPaise: -c.amountPaise, date, collectionId: c._id, description: `Cash given back: ${reason}` });
  }
}

export async function returnCheque(ctx: ServiceContext, collectionId: string, data: { reason: string; chargePaise?: number | undefined; returnedOn?: string | null | undefined; approvalId?: string | undefined }): Promise<CollectionDTO> {
  const f = await financeCtx(ctx);
  const c = await scopedCollection(ctx, f, collectionId);
  if (c.method !== 'CHEQUE') throw new AppError('COLLECTION_STATE_INVALID', 'Only a cheque can bounce.');
  if (!['RECEIVED', 'DEPOSITED', 'CLEARED'].includes(c.status)) throw new AppError('COLLECTION_STATE_INVALID', 'This cheque cannot be marked returned in its current state.');
  const charge = data.chargePaise ?? 0;
  const approval = charge > 0 && c.status === 'CLEARED'
    ? await checkApproval(f, { action: 'BANK_CHARGE_NOTE', entityType: 'collection', entityId: c._id, amountPaise: charge, reason: data.reason, approvalId: data.approvalId, summary: `Charge ${formatMoney(charge)} for the returned cheque ${c.cheque?.number ?? ''}`, impact: 'A debit note will be added to the student\'s account.' })
    : null;
  const date = data.returnedOn ?? (await todayFor(ctx));
  await withTransaction(async (db) => {
    const fresh = await loadCollection(f, collectionId, db);
    if (approval) await consumeApproval(f, db, approval);
    if (fresh.status === 'CLEARED') {
      await unwindCollection(ctx, f, db, fresh, `Cheque returned: ${data.reason}`, 'RETURNED', date);
      if (charge > 0) {
        const placement = await placementOf(f, fresh.advanceStudentId);
        const bankCharges = (await rolesMap(f, db)).get('BANK_CHARGES');
        if (!placement.sessionId || !placement.locationId || !bankCharges) throw new AppError('FINANCE_NOT_READY', 'The bank charge cannot be added to this student\'s account.');
        const line: BuiltLine = {
          feeHeadId: 'CHEQUE_RETURN', feeItemId: null, description: `Returned cheque charge (${fresh.cheque?.number ?? ''})`, periodKey: null, basePaise: charge, discountPaise: 0, taxableValuePaise: charge, taxCodeId: null, rateBps: 0, priceMode: 'EXCLUSIVE',
          cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0, totalPaise: charge, incomeAccountId: bankCharges._id, isDeposit: false, explanation: formatMoney(charge), concessionAwardIds: [], sourceKey: `chequereturn:${fresh._id}`,
        };
        await issueDocument(f, db, { kind: 'DEBIT_NOTE', student: { studentId: fresh.advanceStudentId, enrollmentId: null, locationId: placement.locationId, sessionId: placement.sessionId, classOfferingId: placement.classOfferingId }, periodKey: null, issueDate: date, dueDate: date, graceDays: 0, lines: [line], planVersionId: null, runId: null, parentDocumentId: null, journalKey: `chequereturn:${fresh._id}`, memo: `Charge for returned cheque ${fresh.cheque?.number ?? ''}`, correlationId: ctx.requestId }, await rolesMap(f, db));
      }
    } else {
      const res = await Collection.updateOne({ _id: fresh._id, tenantId: f.tenantId, status: { $in: ['RECEIVED', 'DEPOSITED'] } }, { $set: { status: 'RETURNED', returnedReason: data.reason, returnedOn: date }, $inc: { version: 1 } }, { session: db });
      if (res.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'This cheque was just changed by someone else.');
    }
    await auditFinance(f, db, { action: 'cheque.returned', entityType: 'collection', entityId: collectionId, after: { reason: data.reason, chargePaise: charge } });
  });
  return (await collectionDTOs(f, [await loadCollection(f, collectionId)]))[0]!;
}

// ───────────────────────────────────────────────────────────── allocation (COL-06, 07)

export async function allocateCollection(ctx: ServiceContext, collectionId: string, data: AllocateData): Promise<CollectionResultDTO> {
  const f = await financeCtx(ctx);
  const c = await scopedCollection(ctx, f, collectionId);
  for (const id of new Set([...(data.items ?? []).map((i) => i.studentId), ...(data.autoAllocate?.studentIds ?? [])])) await loadStudentFor(ctx, f, id);
  const date = await todayFor(ctx);
  await withTransaction(async (db) => {
    const fresh = await loadCollection(f, collectionId, db);
    if (!(FUNDED_STATUSES as readonly string[]).includes(fresh.status)) throw new AppError('ALLOCATION_INVALID', 'Only money that has been confirmed can be applied to bills.');
    const allowed = new Set(fresh.studentIds);
    let items: AllocItem[];
    if (data.items?.length) {
      items = [];
      for (const i of data.items) {
        if (!allowed.has(i.studentId)) throw new AppError('ALLOCATION_INVALID', 'This payment cannot be applied to a child outside the payment.');
        if (i.documentId) items.push({ studentId: i.studentId, documentId: i.documentId, amountPaise: i.amountPaise });
        else items.push(...(await planOldestFirst(f, [i.studentId], i.amountPaise, db)));
      }
    } else items = await planOldestFirst(f, data.autoAllocate!.studentIds.filter((s) => allowed.has(s)), fresh.unallocatedPaise, db);
    if (items.length === 0) throw new AppError('ALLOCATION_INVALID', 'There is no open bill to pay.');
    await allocateInTx(f, db, { collectionId, items, date, batchKey: randomUUID(), note: 'Payment applied to bills' });
  });
  return resultFor(f, await loadCollection(f, c._id), false);
}

export async function reverseAllocation(ctx: ServiceContext, allocationId: string, reason: string): Promise<CollectionResultDTO | { ok: true }> {
  const f = await financeCtx(ctx);
  const alloc = await CollectionAllocation.findOne({ _id: allocationId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<CollectionAllocationDoc>();
  if (!alloc) throw AppError.notFound('Allocation not found.');
  await loadStudentFor(ctx, f, alloc.studentId);
  const date = await todayFor(ctx);
  await withTransaction((db) => reverseAllocationInTx(f, db, allocationId, reason, date));
  if (alloc.collectionId) return resultFor(f, await loadCollection(f, alloc.collectionId), false);
  return { ok: true };
}

/** Puts a student's advance against their open bills: first money from their payments, then advance from credit notes. */
export async function applyAdvance(ctx: ServiceContext, studentId: string, data: { documentIds?: string[] | undefined }): Promise<{ appliedPaise: number; bills: number; remainingAdvancePaise: number }> {
  const f = await financeCtx(ctx);
  await loadStudentFor(ctx, f, studentId);
  const date = await todayFor(ctx);
  return withTransaction(async (db) => {
    let advance = await advanceOf(f, studentId, db);
    const bills = await openBills(f, studentId, db, data.documentIds);
    const pool = await Collection.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, advanceStudentId: studentId, status: { $in: [...FUNDED_STATUSES] }, unallocatedPaise: { $gt: 0 } }).sort({ receivedOn: 1, createdAt: 1 }).session(db).lean<CollectionDoc[]>();
    const room = new Map(pool.map((p) => [p._id, p.unallocatedPaise]));
    let applied = 0;
    let touched = 0;
    for (const bill of bills) {
      let need = Math.min(bill.balancePaise, advance);
      if (need <= 0) break;
      touched += 1;
      for (const p of pool) {
        const take = Math.min(need, room.get(p._id) ?? 0);
        if (take <= 0) continue;
        await allocateInTx(f, db, { collectionId: p._id, items: [{ studentId, documentId: bill._id, amountPaise: take }], date, batchKey: randomUUID(), note: 'Advance applied to a bill' });
        room.set(p._id, (room.get(p._id) ?? 0) - take);
        need -= take; advance -= take; applied += take;
      }
      if (need > 0) {
        await allocateInTx(f, db, { collectionId: null, items: [{ studentId, documentId: bill._id, amountPaise: need }], date, batchKey: randomUUID(), note: 'Advance applied to a bill' });
        advance -= need; applied += need;
      }
    }
    if (applied === 0) throw new AppError('ALLOCATION_INVALID', advance <= 0 ? 'This student has no advance to apply.' : 'There is no open bill to pay.');
    await auditFinance(f, db, { action: 'advance.applied', entityType: 'student', entityId: studentId, after: { appliedPaise: applied, bills: touched } });
    return { appliedPaise: applied, bills: touched, remainingAdvancePaise: advance };
  });
}

/** Moves advance from one child to a brother or sister. Same family only, a reason, and a second person's approval. */
export async function transferAdvance(ctx: ServiceContext, fromStudentId: string, data: { toStudentId: string; amountPaise: number; reason: string; approvalId?: string | undefined }): Promise<{ transferredPaise: number }> {
  const f = await financeCtx(ctx);
  if (fromStudentId === data.toStudentId) throw AppError.validation({ toStudentId: 'Choose a different child.' });
  const from = await loadStudentFor(ctx, f, fromStudentId);
  await loadStudentFor(ctx, f, data.toStudentId);
  await assertSameFamily(f, [fromStudentId, data.toStudentId]);
  const approval = await checkApproval(f, { action: 'ADVANCE_TRANSFER', entityType: 'student', entityId: fromStudentId, amountPaise: data.amountPaise, reason: data.reason, approvalId: data.approvalId, payload: { toStudentId: data.toStudentId }, summary: `Move ${formatMoney(data.amountPaise)} of advance to a sibling`, impact: 'The first child\'s advance goes down and the second child\'s goes up.' });
  const date = await todayFor(ctx);
  await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    if ((await advanceOf(f, fromStudentId, db)) < data.amountPaise) throw new AppError('ALLOCATION_INVALID', 'This child does not have that much advance.');
    await drawFromPool(f, db, fromStudentId, data.amountPaise);
    const advance = (await rolesMap(f, db)).get('STUDENT_ADVANCE')!;
    const { journal } = await postJournal(f, db, {
      eventType: 'advance.transferred', sourceKey: `advance_transfer:${randomUUID()}`, accountingDate: date, memo: `Advance moved to a sibling: ${data.reason}`, sourceType: 'student', sourceId: fromStudentId,
      lines: [{ accountId: advance._id, debitPaise: data.amountPaise, locationId: from.locationId, studentId: fromStudentId }, { accountId: advance._id, creditPaise: data.amountPaise, locationId: from.locationId, studentId: data.toStudentId }],
    });
    const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
    await StudentLedgerEntry.create(
      [
        { ...base, studentId: fromStudentId, date, kind: 'ADVANCE_USED', amountPaise: data.amountPaise, journalId: journal._id, description: `Advance moved to a sibling: ${data.reason}`, seq: nextSeq() },
        { ...base, studentId: data.toStudentId, date, kind: 'ADVANCE_IN', amountPaise: -data.amountPaise, journalId: journal._id, description: 'Advance received from a sibling', seq: nextSeq() },
      ],
      { session: db, ordered: true },
    );
    await auditFinance(f, db, { action: 'advance.transferred', entityType: 'student', entityId: fromStudentId, after: { toStudentId: data.toStudentId, amountPaise: data.amountPaise, reason: data.reason } });
  });
  return { transferredPaise: data.amountPaise };
}

// ───────────────────────────────────────────────────────────── reads and receipts (COL-09)

export async function listCollections(ctx: ServiceContext, query: { page: number; pageSize: number; status?: string | undefined; method?: string | undefined; studentId?: string | undefined; from?: string | null | undefined; to?: string | null | undefined; q?: string | undefined }): Promise<CollectionListDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter: Record<string, unknown> = {
    tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope), ...(query.status ? { status: { $in: query.status.split(',') } } : {}), ...(query.method ? { method: query.method } : {}), ...(query.studentId ? { studentIds: query.studentId } : {}),
    ...(query.from || query.to ? { receivedOn: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}), ...(query.q ? { referenceNorm: { $regex: normRef(query.q)!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } } : {}),
  };
  const [rows, total] = await Promise.all([Collection.find(filter).sort({ receivedOn: -1, createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<CollectionDoc[]>(), Collection.countDocuments(filter)]);
  return { items: await collectionDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getCollection(ctx: ServiceContext, id: string): Promise<CollectionDTO> {
  const f = await financeCtx(ctx);
  return (await collectionDTOs(f, [await scopedCollection(ctx, f, id)]))[0]!;
}

async function scopedReceipt(ctx: ServiceContext, f: FinanceCtx, id: string): Promise<ReceiptDoc> {
  const r = await Receipt.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ReceiptDoc>();
  const scope = await financeScope(ctx);
  if (!r || (!scope.all && !scope.locationIds.includes(r.locationId))) throw AppError.notFound('Receipt not found.');
  return r;
}

export async function getReceipt(ctx: ServiceContext, id: string): Promise<ReceiptDTO> {
  const f = await financeCtx(ctx);
  return (await receiptDTOs(f, [await scopedReceipt(ctx, f, id)]))[0]!;
}

export async function listReceipts(ctx: ServiceContext, query: { page: number; pageSize: number; studentId?: string | undefined; from?: string | null | undefined; to?: string | null | undefined; q?: string | undefined }): Promise<ReceiptListDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter: Record<string, unknown> = {
    tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope), ...(query.studentId ? { studentIds: query.studentId } : {}), ...(query.q ? { number: { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } } : {}),
    ...(query.from || query.to ? { receivedOn: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}),
  };
  const [rows, total] = await Promise.all([Receipt.find(filter).sort({ createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<ReceiptDoc[]>(), Receipt.countDocuments(filter)]);
  return { items: await receiptDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

async function receiptPdfFor(f: FinanceCtx, r: ReceiptDoc, visibleStudents: Set<string> | null) {
  const { simplePdf } = await import('../../students/tc.service');
  const [dto] = await receiptDTOs(f, [r]);
  const lines = dto!.lines.filter((l) => !visibleStudents || visibleStudents.has(l.studentId));
  const total = visibleStudents ? lines.reduce((s, l) => s + l.amountPaise, 0) : dto!.amountPaise;
  return simplePdf([
    f.entity.name, '', dto!.status === 'CANCELLED' ? `FEE RECEIPT ${dto!.number} (CANCELLED)` : `FEE RECEIPT ${dto!.number}`, '', `Date: ${dto!.receivedOn}`, `Received from: ${dto!.payerName ?? 'Parent or guardian'}`, `Mode: ${dto!.method}`, '',
    ...lines.map((l) => `${l.studentName}: ${l.documentNumber}  ${formatMoney(l.amountPaise)}`), ...(!visibleStudents && dto!.advancePaise > 0 ? [`Kept as advance: ${formatMoney(dto!.advancePaise)}`] : []), '', `Total received: ${formatMoney(total)}`,
  ]);
}

export async function receiptPdf(ctx: ServiceContext, id: string): Promise<{ buffer: Buffer; fileName: string }> {
  const f = await financeCtx(ctx);
  const r = await scopedReceipt(ctx, f, id);
  return { buffer: await receiptPdfFor(f, r, null), fileName: `receipt-${r.number.replace(/\//g, '-')}.pdf` };
}

/** Receipts of the children a parent may see, with only those children's lines. */
export async function listParentReceipts(ctx: ServiceContext): Promise<ReceiptDTO[]> {
  assertParentRole(ctx);
  const f = await financeCtx(ctx);
  const found = await parentLinksFor(ctx, 'FEES');
  const ids = [...new Set((found?.links ?? []).map((l) => l.studentId))];
  const rows = await Receipt.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentIds: { $in: ids } }).sort({ createdAt: -1 }).limit(100).lean<ReceiptDoc[]>();
  const dtos = await receiptDTOs(f, rows);
  return dtos.map((d) => {
    const lines = d.lines.filter((l) => ids.includes(l.studentId));
    return { ...d, lines, amountPaise: lines.reduce((s, l) => s + l.amountPaise, 0) + (d.advancePaise > 0 && lines.length === d.lines.length ? d.advancePaise : 0), advancePaise: lines.length === d.lines.length ? d.advancePaise : 0, payerName: null };
  });
}

export async function parentReceiptPdf(ctx: ServiceContext, id: string): Promise<{ buffer: Buffer; fileName: string }> {
  assertParentRole(ctx);
  const f = await financeCtx(ctx);
  const found = await parentLinksFor(ctx, 'FEES');
  const ids = new Set((found?.links ?? []).map((l) => l.studentId));
  const r = await Receipt.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentIds: { $in: [...ids] } }).lean<ReceiptDoc>();
  if (!r) throw AppError.notFound('Receipt not found.');
  return { buffer: await receiptPdfFor(f, r, ids), fileName: `receipt-${r.number.replace(/\//g, '-')}.pdf` };
}

/** Cancelling a receipt takes the payment back: its allocations are reversed, the bills owe again, and a linked record is kept. */
export async function cancelReceipt(ctx: ServiceContext, receiptId: string, data: { reason: string; approvalId?: string | undefined }): Promise<ReceiptDTO> {
  const f = await financeCtx(ctx);
  const r = await scopedReceipt(ctx, f, receiptId);
  if (await ReceiptCancellation.exists({ tenantId: f.tenantId, receiptId })) throw new AppError('RECEIPT_ALREADY_CANCELLED');
  const approval = await checkApproval(f, { action: 'RECEIPT_CANCEL', entityType: 'receipt', entityId: r._id, amountPaise: r.amountPaise, reason: data.reason, approvalId: data.approvalId, summary: `Cancel receipt ${r.number} for ${formatMoney(r.amountPaise)}`, impact: 'The bills it paid will owe the money again.' });
  const date = await todayFor(ctx);
  await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    const c = await loadCollection(f, r.collectionId, db);
    if (!['POSTED', 'CLEARED'].includes(c.status)) throw new AppError('COLLECTION_STATE_INVALID', 'This payment is not in a state where its receipt can be cancelled.');
    await unwindCollection(ctx, f, db, c, `Receipt ${r.number} cancelled: ${data.reason}`, 'REVERSED', date);
    await ReceiptCancellation.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, receiptId, reason: data.reason, approvalId: approval?._id ?? null, cancelledBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'receipt.cancelled', entityType: 'receipt', entityId: receiptId, after: { number: r.number, amountPaise: r.amountPaise, reason: data.reason } });
    await emitFinance(f, db, 'receipt.cancelled', { receiptId, number: r.number, amountPaise: r.amountPaise });
  });
  return (await receiptDTOs(f, [r]))[0]!;
}

/** Pending claims for one student, for the clearance check. */
export async function pendingClaimsOf(f: FinanceCtx, studentId: string): Promise<{ count: number; amountPaise: number }> {
  const [claims, collections] = await Promise.all([
    PaymentClaim.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: { $in: ['REPORTED', 'PENDING_VERIFICATION'] }, 'students.studentId': studentId }).lean<PaymentClaimDoc[]>(),
    Collection.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentIds: studentId, status: { $in: ['PENDING_VERIFICATION', 'RECEIVED', 'DEPOSITED'] }, claimId: null }).lean<CollectionDoc[]>(),
  ]);
  return { count: claims.length + collections.length, amountPaise: claims.reduce((s, c) => s + (c.students.find((x) => x.studentId === studentId)?.amountPaise ?? 0), 0) + collections.reduce((s, c) => s + c.amountPaise, 0) };
}

export { balancesOf, mergeLines, BANK_METHODS };
export type { PostLine };
