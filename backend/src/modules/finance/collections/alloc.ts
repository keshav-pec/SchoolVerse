import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { FUNDED_STATUSES, type FeeDocumentStatus } from '@shared';
import { AppError } from '../../../core/errors';
import { rolesMap } from '../core/chart.service';
import { auditFinance, emitFinance, type FinanceCtx } from '../core/context';
import { formatMoney } from '../core/money';
import { postJournal, type PostLine } from '../core/posting';
import { nextSeq } from '../fees/documents';
import { FeeDocument, StudentLedgerEntry, type FeeDocumentDoc } from '../fees/models';
import { Collection, CollectionAllocation, type CollectionDoc } from './models';

/**
 * The allocation engine (COL-06). Money received first sits with the student as an ADVANCE (a debt the school owes). Allocating it
 * to a bill moves it from the advance to the bill:  Dr Student Advance, Cr Student Receivable.
 *
 * Two people paying the same bill at once is safe: each side is changed by a guarded update (`balancePaise >= x`, `unallocatedPaise >= x`)
 * inside the transaction, so the second one fails with ALLOCATION_CONFLICT and rolls back whole. A bill is never over-settled.
 */

/** Bill kinds that a payment can settle. A credit note never has a balance. */
export const PAYABLE_KINDS = ['BILL', 'LATE_FEE', 'DEBIT_NOTE', 'OPENING'] as const;

export interface AllocItem {
  studentId: string;
  documentId: string;
  amountPaise: number;
}

export const settleStatus = (d: Pick<FeeDocumentDoc, 'balancePaise' | 'totalPaise'>): FeeDocumentStatus => (d.balancePaise === 0 ? 'SETTLED' : d.balancePaise < d.totalPaise ? 'PARTIALLY_SETTLED' : 'ISSUED');

/** Open bills of a student, oldest due date first. */
export async function openBills(f: FinanceCtx, studentId: string, db: ClientSession, documentIds?: string[]): Promise<FeeDocumentDoc[]> {
  return FeeDocument.find({
    tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentId, kind: { $in: PAYABLE_KINDS }, status: { $in: ['ISSUED', 'PARTIALLY_SETTLED'] }, balancePaise: { $gt: 0 }, ...(documentIds ? { _id: { $in: documentIds } } : {}),
  })
    .sort({ dueDate: 1, issueDate: 1, number: 1 })
    .session(db)
    .lean<FeeDocumentDoc[]>();
}

/** Pays the oldest bills first, up to `amountPaise`, across the given students (in the order given). */
export async function planOldestFirst(f: FinanceCtx, studentIds: string[], amountPaise: number, db: ClientSession): Promise<AllocItem[]> {
  const items: AllocItem[] = [];
  let left = amountPaise;
  const docs = (await Promise.all(studentIds.map((id) => openBills(f, id, db)))).flat().sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.issueDate.localeCompare(b.issueDate) || a.number.localeCompare(b.number));
  for (const d of docs) {
    if (left <= 0) break;
    const take = Math.min(left, d.balancePaise);
    items.push({ studentId: d.studentId, documentId: d._id, amountPaise: take });
    left -= take;
  }
  return items;
}

/** What the student holds as an advance right now: advance rows of the ledger. */
export async function advanceOf(f: FinanceCtx, studentId: string, db: ClientSession): Promise<number> {
  const rows = await StudentLedgerEntry.find({ tenantId: f.tenantId, studentId, kind: { $in: ['ADVANCE_IN', 'ADVANCE_USED', 'REFUND'] } }).session(db).select('amountPaise').lean<{ amountPaise: number }[]>();
  return 0 - rows.reduce((s, r) => s + r.amountPaise, 0);
}

/**
 * Pays `items` from one collection's unallocated money, in the caller's transaction. Every guard fails the whole thing.
 * `collectionId: null` pays from an advance that has no collection behind it (a credit note's extra).
 */
export async function allocateInTx(
  f: FinanceCtx,
  db: ClientSession,
  input: { collectionId: string | null; items: AllocItem[]; date: string; batchKey: string; note?: string },
): Promise<{ allocationIds: string[]; journalId: string | null }> {
  const items = input.items.filter((i) => i.amountPaise > 0);
  if (items.length === 0) return { allocationIds: [], journalId: null };
  const total = items.reduce((s, i) => s + i.amountPaise, 0);

  if (input.collectionId) {
    const collection = await Collection.findOne({ _id: input.collectionId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<CollectionDoc>();
    if (!collection) throw AppError.notFound('Payment not found.');
    if (!(FUNDED_STATUSES as readonly string[]).includes(collection.status)) throw new AppError('ALLOCATION_INVALID', 'Only money that has been confirmed can be applied to bills.');
    const guard = await Collection.updateOne({ _id: collection._id, tenantId: f.tenantId, unallocatedPaise: { $gte: total } }, { $inc: { unallocatedPaise: -total, version: 1 } }, { session: db });
    if (guard.modifiedCount !== 1) throw new AppError('ALLOCATION_CONFLICT', `Only ${formatMoney(collection.unallocatedPaise)} of this payment is left to apply.`, { unallocatedPaise: collection.unallocatedPaise });
  } else {
    for (const studentId of new Set(items.map((i) => i.studentId))) {
      const need = items.filter((i) => i.studentId === studentId).reduce((s, i) => s + i.amountPaise, 0);
      if ((await advanceOf(f, studentId, db)) < need) throw new AppError('ALLOCATION_INVALID', 'This student does not have that much advance.');
    }
  }

  const roles = await rolesMap(f, db);
  const advance = roles.get('STUDENT_ADVANCE');
  const receivable = roles.get('STUDENT_RECEIVABLE');
  if (!advance || !receivable) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing the student advance or receivable account. Use the standard chart in Finance Settings.');

  const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
  const lines: PostLine[] = [];
  const ledger: Record<string, unknown>[] = [];
  const rows: { _id: string; documentId: string; studentId: string; amountPaise: number }[] = [];
  for (const item of items) {
    const doc = await FeeDocument.findOne({ _id: item.documentId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<FeeDocumentDoc>();
    if (!doc || doc.studentId !== item.studentId) throw new AppError('ALLOCATION_INVALID', 'That bill does not belong to this student.');
    if (!(PAYABLE_KINDS as readonly string[]).includes(doc.kind) || doc.status === 'CANCELLED' || doc.status === 'SETTLED') throw new AppError('ALLOCATION_INVALID', `Bill ${doc.number} has nothing left to pay.`);
    if (item.amountPaise > doc.balancePaise) throw new AppError('ALLOCATION_INVALID', `Bill ${doc.number} has only ${formatMoney(doc.balancePaise)} left to pay.`, { documentId: doc._id, balancePaise: doc.balancePaise });
    const moved = await FeeDocument.updateOne({ _id: doc._id, tenantId: f.tenantId, balancePaise: { $gte: item.amountPaise } }, { $inc: { balancePaise: -item.amountPaise, paidPaise: item.amountPaise } }, { session: db });
    if (moved.modifiedCount !== 1) throw new AppError('ALLOCATION_CONFLICT', `Bill ${doc.number} was just changed by someone else.`, { documentId: doc._id });
    const after = { balancePaise: doc.balancePaise - item.amountPaise, totalPaise: doc.totalPaise };
    const status = settleStatus(after);
    if (status !== doc.status) await FeeDocument.updateOne({ _id: doc._id, tenantId: f.tenantId }, { $set: { status } }, { session: db });
    lines.push({ accountId: advance._id, debitPaise: item.amountPaise, locationId: doc.locationId, studentId: doc.studentId }, { accountId: receivable._id, creditPaise: item.amountPaise, locationId: doc.locationId, studentId: doc.studentId });
    rows.push({ _id: randomUUID(), documentId: doc._id, studentId: doc.studentId, amountPaise: item.amountPaise });
  }

  const { journal } = await postJournal(f, db, {
    eventType: 'allocation.applied', sourceKey: `alloc:${input.batchKey}`, accountingDate: input.date, lines: mergeLines(lines), memo: input.note ?? `Payment applied to ${items.length} bill${items.length === 1 ? '' : 's'}`,
    sourceType: 'collection', sourceId: input.collectionId ?? input.batchKey,
  });
  for (const r of rows) {
    ledger.push(
      { ...base, studentId: r.studentId, date: input.date, kind: 'ADVANCE_USED', amountPaise: r.amountPaise, documentId: r.documentId, collectionId: input.collectionId, journalId: journal._id, description: 'Advance applied to a bill', seq: nextSeq() },
      { ...base, studentId: r.studentId, date: input.date, kind: 'PAYMENT', amountPaise: -r.amountPaise, documentId: r.documentId, collectionId: input.collectionId, journalId: journal._id, description: 'Payment received', seq: nextSeq() },
    );
  }
  await StudentLedgerEntry.create(ledger as never[], { session: db, ordered: true });
  await CollectionAllocation.create(
    rows.map((r) => ({ _id: r._id, ...base, collectionId: input.collectionId, studentId: r.studentId, documentId: r.documentId, amountPaise: r.amountPaise, status: 'ACTIVE' as const, journalId: journal._id, allocatedOn: input.date, createdBy: f.system ? null : f.userId })),
    { session: db, ordered: true },
  );
  await auditFinance(f, db, { action: 'collection.allocated', entityType: 'collection', entityId: input.collectionId ?? input.batchKey, after: { totalPaise: total, bills: rows.length } });
  await emitFinance(f, db, 'collection.allocated', { collectionId: input.collectionId, totalPaise: total, allocations: rows.map((r) => r._id) });
  return { allocationIds: rows.map((r) => r._id), journalId: journal._id };
}

/** Lines of the same account, student and side are added together so a journal stays short. */
export function mergeLines(lines: PostLine[]): PostLine[] {
  const merged = new Map<string, PostLine>();
  for (const l of lines) {
    const key = [l.accountId, l.locationId ?? '', l.studentId ?? '', l.employeeId ?? '', l.vendorId ?? '', l.debitPaise ? 'D' : 'C'].join('|');
    const have = merged.get(key);
    if (have) {
      have.debitPaise = (have.debitPaise ?? 0) + (l.debitPaise ?? 0);
      have.creditPaise = (have.creditPaise ?? 0) + (l.creditPaise ?? 0);
    } else merged.set(key, { ...l });
  }
  return [...merged.values()];
}

/**
 * Takes `amountPaise` out of the student's advance pool: the unallocated money of their collections, oldest first. Used when the
 * advance moves somewhere else (a refund, a transfer to a sibling). Each collection is changed by a guarded update.
 */
export async function drawFromPool(f: FinanceCtx, db: ClientSession, studentId: string, amountPaise: number): Promise<number> {
  let left = amountPaise;
  const pool = await Collection.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, advanceStudentId: studentId, status: { $in: [...FUNDED_STATUSES] }, unallocatedPaise: { $gt: 0 } }).sort({ receivedOn: 1, createdAt: 1 }).session(db).lean<CollectionDoc[]>();
  for (const c of pool) {
    if (left <= 0) break;
    const take = Math.min(left, c.unallocatedPaise);
    const res = await Collection.updateOne({ _id: c._id, tenantId: f.tenantId, unallocatedPaise: { $gte: take } }, { $inc: { unallocatedPaise: -take, version: 1 } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('ALLOCATION_CONFLICT');
    left -= take;
  }
  return amountPaise - left;
}

/** Undoes one allocation: the bill owes again and the money goes back to the student's advance. History is kept (a reversal row). */
export async function reverseAllocationInTx(f: FinanceCtx, db: ClientSession, allocationId: string, reason: string, date: string): Promise<void> {
  const alloc = await CollectionAllocation.findOne({ _id: allocationId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<{ _id: string; collectionId: string | null; studentId: string; documentId: string; amountPaise: number; status: string }>();
  if (!alloc) throw AppError.notFound('Allocation not found.');
  if (alloc.status !== 'ACTIVE') throw new AppError('CONFLICT', 'This allocation was already reversed.');
  const flip = await CollectionAllocation.updateOne({ _id: alloc._id, tenantId: f.tenantId, status: 'ACTIVE' }, { $set: { status: 'REVERSED', reason } }, { session: db });
  if (flip.modifiedCount !== 1) throw new AppError('CONFLICT', 'This allocation was already reversed.');
  const doc = await FeeDocument.findOne({ _id: alloc.documentId, tenantId: f.tenantId }).session(db).lean<FeeDocumentDoc>();
  if (!doc) throw AppError.notFound('Bill not found.');
  const back = await FeeDocument.updateOne({ _id: doc._id, tenantId: f.tenantId, paidPaise: { $gte: alloc.amountPaise } }, { $inc: { balancePaise: alloc.amountPaise, paidPaise: -alloc.amountPaise } }, { session: db });
  if (back.modifiedCount !== 1) throw new AppError('ALLOCATION_CONFLICT');
  const status = settleStatus({ balancePaise: doc.balancePaise + alloc.amountPaise, totalPaise: doc.totalPaise });
  if (status !== doc.status) await FeeDocument.updateOne({ _id: doc._id, tenantId: f.tenantId }, { $set: { status } }, { session: db });
  if (alloc.collectionId) {
    const c = await Collection.findOne({ _id: alloc.collectionId, tenantId: f.tenantId }).session(db).lean<CollectionDoc>();
    const give = await Collection.updateOne({ _id: alloc.collectionId, tenantId: f.tenantId, unallocatedPaise: { $lte: (c?.amountPaise ?? 0) - alloc.amountPaise } }, { $inc: { unallocatedPaise: alloc.amountPaise, version: 1 } }, { session: db });
    if (give.modifiedCount !== 1) throw new AppError('ALLOCATION_CONFLICT');
  }
  const roles = await rolesMap(f, db);
  const { journal } = await postJournal(f, db, {
    eventType: 'allocation.reversed', sourceKey: `alloc_rev:${alloc._id}`, accountingDate: date, memo: `Payment taken off bill ${doc.number}: ${reason}`, sourceType: 'collection', sourceId: alloc.collectionId ?? alloc._id,
    lines: [
      { accountId: roles.get('STUDENT_RECEIVABLE')!._id, debitPaise: alloc.amountPaise, locationId: doc.locationId, studentId: doc.studentId },
      { accountId: roles.get('STUDENT_ADVANCE')!._id, creditPaise: alloc.amountPaise, locationId: doc.locationId, studentId: doc.studentId },
    ],
  });
  const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
  await StudentLedgerEntry.create(
    [
      { ...base, studentId: doc.studentId, date, kind: 'REVERSAL', amountPaise: alloc.amountPaise, documentId: doc._id, collectionId: alloc.collectionId, journalId: journal._id, description: `Payment reversed on ${doc.number}: ${reason}`, seq: nextSeq() },
      { ...base, studentId: doc.studentId, date, kind: 'ADVANCE_IN', amountPaise: -alloc.amountPaise, documentId: doc._id, collectionId: alloc.collectionId, journalId: journal._id, description: 'Reversed payment returned to advance', seq: nextSeq() },
    ],
    { session: db, ordered: true },
  );
  await CollectionAllocation.create([{ ...base, collectionId: alloc.collectionId, studentId: alloc.studentId, documentId: alloc.documentId, amountPaise: alloc.amountPaise, status: 'REVERSED' as const, reversalOfId: alloc._id, reason, journalId: journal._id, allocatedOn: date, createdBy: f.system ? null : f.userId }], { session: db });
  await auditFinance(f, db, { action: 'collection_allocation.reversed', entityType: 'collection_allocation', entityId: alloc._id, after: { amountPaise: alloc.amountPaise, reason } });
  await emitFinance(f, db, 'collection.reversed', { allocationId: alloc._id, collectionId: alloc.collectionId, amountPaise: alloc.amountPaise });
}
