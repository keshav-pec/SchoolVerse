import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { ClaimDTO, CollectionResultDTO, ReceiptDTO, RefundDTO, ReportDTO, ShiftDTO, StudentAccountDTO, ParentFeeSummaryDTO, AutoMatchResultDTO, VerificationQueueDTO, MatchDTO, ReconExceptionsDTO, ReconSummaryDTO, StatementImportDTO, StatementLineDTO } from '@shared';
import { Collection, CollectionAllocation, PaymentClaim, Receipt, ReceiptCancellation } from '../src/modules/finance/collections/models';
import { FeeDocument, StudentLedgerEntry } from '../src/modules/finance/fees/models';
import { JournalEntry, JournalLine } from '../src/modules/finance/core/models';
import { financeService } from '../src/modules/finance/financeService';
import { DevOutbox } from '../src/platform/identity/notifier';
import { SKIP_TENANT_SCOPE } from '../src/db/plugins/tenant-scope';
import { activatedParent, API, billOf, collect, created, EICAR, enrolled, expectError, getOk, issueMonth, key, money, type MoneySchool, moneySchool, nextPhone, ok, openShift, patch, PNG, post, put, staffWith, today, trial, useTestDatabase, withKey } from './helpers';
import { BankStatementLine, ReconciliationMatch } from '../src/modules/finance/banking/models';

useTestDatabase();

// ───────────────────────────────────────────────────────────── small helpers

const account = (t: MoneySchool, studentId: string) => getOk<StudentAccountDTO>(t, `/students/${studentId}/account`);
const upiBody = (studentId: string, amount: number, reference: string, extra: Record<string, unknown> = {}) => ({ method: 'UPI', amountPaise: money(amount), reference, payerName: 'Priya Sharma', allocations: [{ studentId, amountPaise: money(amount) }], ...extra });
const verifyBody = (amount: number, extra: Record<string, unknown> = {}) => ({ amountSeenPaise: money(amount), evidence: { seenOn: today(), note: 'Seen in the bank app' }, ...extra });

/** One student with the November bill issued (₹4,000). */
async function billedStudent(over: Record<string, unknown> = {}) {
  const t = await moneySchool();
  const kid = await enrolled(t, '2026-04-01', over);
  await issueMonth(t);
  const bill = await billOf(t, kid.studentId);
  return { t, kid, bill };
}


describe('claims: what a family says is not money (COL-01)', () => {
  it('QA COL-01: a claim makes no journal and does not touch the bill; the parent sees it as waiting', async () => {
    const phone = nextPhone();
    const { t, kid, bill } = await billedStudent({ guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, email: 'priya.claim@example.com', relationshipType: 'Mother' } });
    const parent = await activatedParent(t, kid.studentId, 'priya.claim@example.com');
    const journalsBefore = await JournalEntry.countDocuments({ tenantId: t.tenantId });
    const claim = (await parent.agent.post(`${API}/parent/payment-claims`).send({ students: [{ studentId: kid.studentId, amountPaise: money(4000) }], method: 'UPI', amountPaise: money(4000), paidOn: today(), reference: 'utr 4455 6677' }).expect(201)).body.data as ClaimDTO;
    expect(claim).toMatchObject({ status: 'PENDING_VERIFICATION', reportedByParent: true, flags: [] });
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId })).toBe(journalsBefore);
    expect(await Receipt.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect((await billOf(t, kid.studentId)).balancePaise).toBe(money(4000));
    expect(await financeService.getStudentClearance(t.ctx, kid.studentId)).toMatchObject({ status: 'DUES', pendingClaims: 1 });
    const mine = (await parent.agent.get(`${API}/parent/payment-claims`).expect(200)).body.data as ClaimDTO[];
    expect(mine).toHaveLength(1);
    expect(mine[0]!.status).toBe('PENDING_VERIFICATION');
    // a parent cannot report a payment for a child they cannot see
    const other = await enrolled(t);
    expect((await parent.agent.post(`${API}/parent/payment-claims`).send({ students: [{ studentId: other.studentId, amountPaise: money(100) }], method: 'UPI', amountPaise: money(100), paidOn: today(), reference: 'x1' })).status).toBe(404);
    void bill;
  });

  it('QA COL-01: the same reference twice is flagged, and cash cannot be reported', async () => {
    const { t, kid } = await billedStudent();
    const body = { students: [{ studentId: kid.studentId, amountPaise: money(1000) }], method: 'UPI', amountPaise: money(1000), paidOn: today(), reference: 'UTR 99 88' };
    const first = await created<ClaimDTO>(await post(t, '/payment-claims', body));
    const second = await created<ClaimDTO>(await post(t, '/payment-claims', { ...body, reference: 'utr9988' }));
    expect(first.flags).toEqual([]);
    expect(second.flags).toEqual(['DUPLICATE_SUSPECTED']);
    expectError(await post(t, '/payment-claims', { ...body, method: 'CASH' }), 400, 'VALIDATION_FAILED');
    expectError(await post(t, '/payment-claims', { ...body, amountPaise: money(1500) }), 400, 'VALIDATION_FAILED'); // child amounts must add up
    const pending = await getOk<{ items: ClaimDTO[] }>(t, '/payment-claims/pending');
    expect(pending.items).toHaveLength(2);
  });

  it('QA COL-05: verifying a claim posts the money, applies it and issues the receipt; rejecting leaves everything alone', async () => {
    const { t, kid, bill } = await billedStudent();
    const claim = await created<ClaimDTO>(await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(4000) }], method: 'UPI', amountPaise: money(4000), paidOn: today(), reference: 'UTR1001' }));
    const result = await ok<CollectionResultDTO>(await post(t.accountant, `/payment-claims/${claim.claimId}/verify`, verifyBody(4000)));
    expect(result.collection.status).toBe('POSTED');
    expect(result.receipt).toMatchObject({ status: 'ISSUED', amountPaise: money(4000), advancePaise: 0 });
    expect(result.receipt!.number).toMatch(/^RCT\/2026-27\/\d{6}$/);
    const paid = (await getOk<{ items: { balancePaise: number; status: string }[] }>(t, `/fee-documents?studentId=${kid.studentId}&kind=BILL`)).items.find((b) => b.balancePaise === 0)!;
    expect(paid.status).toBe('SETTLED');
    expect((await account(t, kid.studentId)).outstandingPaise).toBe(0);
    const again = await ok<CollectionResultDTO>(await post(t.accountant, `/payment-claims/${claim.claimId}/verify`, verifyBody(4000)));
    expect(again.repeated).toBe(true);
    expect(again.receipt!.receiptId).toBe(result.receipt!.receiptId);
    expect(await Receipt.countDocuments({ tenantId: t.tenantId })).toBe(1);
    const rejected = await created<ClaimDTO>(await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(500) }], method: 'UPI', amountPaise: money(500), paidOn: today(), reference: 'FAKE1' }));
    const out = await ok<ClaimDTO>(await post(t.accountant, `/payment-claims/${rejected.claimId}/reject`, { reason: 'No such credit in the bank' }));
    expect(out).toMatchObject({ status: 'REJECTED', rejectReason: 'No such credit in the bank' });
    expect((await trial(t)).balanced).toBe(true);
    void bill;
  });
});

describe('cash and cashier shifts (COL-02, FIN-12)', () => {
  it('QA COL-02: cash needs an open shift, then posts, allocates, receipts and updates the shift in one go', async () => {
    const { t, kid, bill } = await billedStudent();
    const body = { method: 'CASH', amountPaise: money(4000), payerName: 'Priya Sharma', allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] };
    expectError(await withKey(t.cashier.agent, '/collections', key(), body), 409, 'NO_OPEN_SHIFT');
    const shift = await openShift(t.cashier, money(500));
    expectError(await t.cashier.agent.post(`${API}/finance/cashier-shifts/open`).send({ openingFloatPaise: 0 }), 409, 'SHIFT_ALREADY_OPEN');
    const k = key('cash');
    const res = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', k, body).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    expect(res.collection).toMatchObject({ method: 'CASH', status: 'POSTED', unallocatedPaise: 0, shiftId: shift.shiftId });
    expect(res.receipt!.lines).toEqual([{ studentId: kid.studentId, studentName: expect.any(String), documentNumber: bill.number, amountPaise: money(4000) }]);
    const doc = (await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())!;
    expect(doc).toMatchObject({ paidPaise: money(4000), balancePaise: 0, status: 'SETTLED' });
    // both journals exist, balance, and carry the student
    const funding = (await JournalEntry.findOne({ tenantId: t.tenantId, sourceKey: `collection:${res.collection.collectionId}` }).lean())!;
    const lines = await JournalLine.find({ tenantId: t.tenantId, journalId: funding._id }).lean();
    expect(lines.reduce((s, l) => s + l.debitPaise, 0)).toBe(lines.reduce((s, l) => s + l.creditPaise, 0));
    expect(lines.some((l) => l.studentId === kid.studentId)).toBe(true);
    expect((await trial(t)).balanced).toBe(true);
    // the shift counts it
    const mine = (await getOk<ShiftDTO | null>(t.cashier, '/cashier-shifts/mine'))!;
    expect(mine).toMatchObject({ openingPaise: money(500), collectedPaise: money(4000), expectedPaise: money(4500) });
    // a retry with the same key gives the same receipt and posts nothing new
    const entries = await JournalEntry.countDocuments({ tenantId: t.tenantId });
    const retry = (await withKey(t.cashier.agent, '/collections', k, body)).body.data as CollectionResultDTO;
    expect(retry.repeated).toBe(true);
    expect(retry.receipt!.receiptId).toBe(res.receipt!.receiptId);
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId })).toBe(entries);
    expect(await Receipt.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expectError(await t.cashier.agent.post(`${API}/finance/collections`).send(body), 400, 'IDEMPOTENCY_KEY_REQUIRED');
  });

  it('QA COL-06: paying more than the bill allows is refused; paying more than the bill needs keeps the rest as an advance (a liability)', async () => {
    const { t, kid, bill } = await billedStudent();
    await openShift(t.cashier);
    expectError(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(9000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4500) }] }), 422, 'ALLOCATION_INVALID');
    const res = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(6000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    expect(res.collection.unallocatedPaise).toBe(money(2000));
    expect(res.receipt).toMatchObject({ amountPaise: money(6000), advancePaise: money(2000) });
    const a = await account(t, kid.studentId);
    expect(a).toMatchObject({ outstandingPaise: 0, advancePaise: money(2000) });
    // the advance is held in the liability account, never as income
    const advanceAccount = (await getOk<{ accountId: string; systemRole: string }[]>(t, '/chart-of-accounts')).find((x) => x.systemRole === 'STUDENT_ADVANCE')!;
    const rows = (await getOk<{ rows: { debitPaise: number; creditPaise: number }[]; closingPaise: number }>(t, `/general-ledger?accountId=${advanceAccount.accountId}`));
    expect(rows.closingPaise).toBe(money(2000));
    // when the next bill arrives the advance pays it
    await issueMonth(t, '2026-12', '2026-12-05');
    const applied = await ok<{ appliedPaise: number; bills: number }>(await post(t.cashier, `/students/${kid.studentId}/apply-advance`, {}));
    expect(applied).toMatchObject({ appliedPaise: money(2000), bills: 1 });
    const after = await account(t, kid.studentId);
    expect(after).toMatchObject({ advancePaise: 0, outstandingPaise: money(2000) });
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA COL-06: two cashiers paying the same bill at once: one wins, the bill is never over-settled', async () => {
    const { t, kid, bill } = await billedStudent();
    await openShift(t.cashier);
    await openShift(t.cashier2);
    const body = { method: 'CASH', amountPaise: money(4000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] };
    const [a, b] = await Promise.all([withKey(t.cashier.agent, '/collections', key(), body), withKey(t.cashier2.agent, '/collections', key(), body)]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(409);
    const doc = (await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())!;
    expect(doc.paidPaise).toBe(money(4000));
    expect(doc.balancePaise).toBe(0);
    expect(await CollectionAllocation.countDocuments({ tenantId: t.tenantId, documentId: bill.documentId, status: 'ACTIVE' })).toBe(1);
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA FIN-12: a shift that does not match needs a note and a supervisor, never an edited receipt', async () => {
    const { t, kid, bill } = await billedStudent();
    const shift = await openShift(t.cashier, money(1000));
    await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(4000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    expectError(await post(t.cashier, `/cashier-shifts/${shift.shiftId}/close`, { countedPaise: money(4800) }), 422, 'VARIANCE_NOTE_REQUIRED');
    const closed = await ok<ShiftDTO>(await post(t.cashier, `/cashier-shifts/${shift.shiftId}/close`, { countedPaise: money(4800), note: 'Two notes of 100 stuck together' }));
    expect(closed).toMatchObject({ state: 'CLOSED', expectedPaise: money(5000), countedPaise: money(4800), variancePaise: -money(200) });
    expect(closed.sentence).toBe('Expected ₹5,000, counted ₹4,800, short ₹200.');
    expectError(await post(t.cashier, `/cashier-shifts/${shift.shiftId}/sign-off`, {}), 403, 'FORBIDDEN'); // a cashier cannot sign off
    expectError(await post(t.accountant, '/cash-deposits', { shiftIds: [shift.shiftId], bankAccountId: t.bank.bankAccountId, amountPaise: money(100) }), 409, 'COLLECTION_STATE_INVALID');
    const signed = await ok<ShiftDTO>(await post(t.accountant, `/cashier-shifts/${shift.shiftId}/sign-off`, { note: 'Counted again' }));
    expect(signed.state).toBe('SIGNED_OFF');
    // the receipt is exactly as it was issued
    expect((await Receipt.findOne({ tenantId: t.tenantId }).lean())!.amountPaise).toBe(money(4000));
    // the cash goes to the bank: no more than the shift holds, and the books balance
    expectError(await post(t.accountant, '/cash-deposits', { shiftIds: [shift.shiftId], bankAccountId: t.bank.bankAccountId, amountPaise: money(4000) }), 422, 'ALLOCATION_INVALID');
    const deposit = await created<{ amountPaise: number; journalId: string }>(await post(t.accountant, '/cash-deposits', { shiftIds: [shift.shiftId], bankAccountId: t.bank.bankAccountId, amountPaise: money(3800) }));
    expect(deposit.amountPaise).toBe(money(3800));
    const book = await getOk<{ rows: { kind: string }[]; closingPaise: number }>(t.accountant, `/cashbook?date=${today()}`);
    expect(book.rows.map((r) => r.kind)).toEqual(['COLLECTION', 'DEPOSIT']);
    expect((await trial(t)).balanced).toBe(true);
  });
});

describe('UPI, bank transfer and cheques (COL-03, 04, 05)', () => {
  it('QA COL-03: a UPI payment waits until someone has seen the money; no receipt, no journal, no change to the bill', async () => {
    const { t, kid, bill } = await billedStudent();
    const journals = await JournalEntry.countDocuments({ tenantId: t.tenantId });
    const pending = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), upiBody(kid.studentId, 4000, 'UTR 1234 5678')).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    expect(pending.collection).toMatchObject({ status: 'PENDING_VERIFICATION', unallocatedPaise: 0 });
    expect(pending.receipt).toBeNull();
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId })).toBe(journals);
    expect((await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())!.balancePaise).toBe(money(4000));
    expectError(await post(t, `/collections/${pending.collection.collectionId}/allocate`, { autoAllocate: { studentIds: [kid.studentId] } }), 422, 'ALLOCATION_INVALID');
    expectError(await post(t.cashier, `/collections/${pending.collection.collectionId}/verify`, verifyBody(4000)), 403, 'FORBIDDEN'); // a cashier cannot verify
    const done = await ok<CollectionResultDTO>(await post(t.accountant, `/collections/${pending.collection.collectionId}/verify`, verifyBody(4000)));
    expect(done.collection.status).toBe('POSTED');
    expect(done.receipt!.amountPaise).toBe(money(4000));
    expect((await account(t, kid.studentId)).outstandingPaise).toBe(0);
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA COL-05: a different amount, or a reference already used, is stopped; "use what I saw" is a clear choice', async () => {
    const { t, kid } = await billedStudent();
    const first = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), upiBody(kid.studentId, 1000, 'UTR-AAA-1')).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    const err = await post(t.accountant, `/collections/${first.collection.collectionId}/verify`, verifyBody(900));
    expectError(err, 409, 'AMOUNT_MISMATCH');
    expect((await Collection.findOne({ _id: first.collection.collectionId, tenantId: t.tenantId }).lean())!.flags).toContain('AMOUNT_MISMATCH');
    const used = await ok<CollectionResultDTO>(await post(t.accountant, `/collections/${first.collection.collectionId}/verify`, verifyBody(900, { useSeenAmount: true })));
    expect(used.collection.amountPaise).toBe(money(900));
    expect(used.receipt!.amountPaise).toBe(money(900));
    // the same UTR typed again is a probable double count
    const second = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), upiBody(kid.studentId, 900, 'utr aaa 1')).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    expect(second.collection.flags).toContain('DUPLICATE_SUSPECTED');
    expectError(await post(t.accountant, `/collections/${second.collection.collectionId}/verify`, verifyBody(900)), 409, 'DUPLICATE_REFERENCE');
    const rejected = await ok<{ status: string }>(await post(t.accountant, `/collections/${second.collection.collectionId}/reject`, { reason: 'Same UTR as the first one' }));
    expect(rejected.status).toBe('REJECTED');
  });

  it('QA COL-04: a cheque is a promise until it clears: the acknowledgement is not a receipt, clearing posts it, a bounce takes it back', async () => {
    const { t, kid, bill } = await billedStudent();
    const cheque = { number: '004512', bankName: 'HDFC Bank', chequeDate: today() };
    const res = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), { method: 'CHEQUE', amountPaise: money(4000), cheque, allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    expect(res.collection.status).toBe('RECEIVED');
    expect(res.collection.provisionalNumber).toMatch(/^ACK\/2026-27\/\d{6}$/);
    expect(res.receipt).toBeNull();
    expect(await Receipt.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect((await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())!.balancePaise).toBe(money(4000));
    const id = res.collection.collectionId;
    const deposited = await ok<{ status: string }>(await post(t.accountant, `/collections/${id}/deposit`, {}));
    expect(deposited.status).toBe('DEPOSITED');
    const cleared = await ok<CollectionResultDTO>(await post(t.accountant, `/collections/${id}/clear`, { clearedOn: today() }));
    expect(cleared.collection.status).toBe('CLEARED');
    expect(cleared.receipt!.number).toMatch(/^RCT\//);
    expect((await account(t, kid.studentId)).outstandingPaise).toBe(0);
    // it bounces after clearing: the bill owes again, the books are mirrored, nothing is erased
    const returned = await ok<{ status: string }>(await post(t.accountant, `/collections/${id}/return`, { reason: 'Insufficient funds' }));
    expect(returned.status).toBe('RETURNED');
    const back = await account(t, kid.studentId);
    expect(back).toMatchObject({ outstandingPaise: money(4000), advancePaise: 0 });
    expect((await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())).toMatchObject({ balancePaise: money(4000), paidPaise: 0, status: 'ISSUED' });
    expect(await CollectionAllocation.countDocuments({ tenantId: t.tenantId, collectionId: id })).toBe(2); // the allocation and its reversal are both kept
    expect((await trial(t)).balanced).toBe(true);
    expectError(await post(t.accountant, `/collections/${id}/clear`, { clearedOn: today() }), 409, 'COLLECTION_STATE_INVALID');
  });

  it('QA COL-04: a bounced cheque can carry a bank charge, which a second person must approve', async () => {
    const { t, kid, bill } = await billedStudent();
    const res = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), { method: 'CHEQUE', amountPaise: money(4000), cheque: { number: '77', bankName: 'PNB', chequeDate: today() }, allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    const id = res.collection.collectionId;
    await post(t.accountant, `/collections/${id}/clear`, { clearedOn: today() }).expect(200);
    const blocked = await post(t.accountant, `/collections/${id}/return`, { reason: 'Bounced', chargePaise: money(300) });
    expectError(blocked, 409, 'APPROVAL_REQUIRED');
    const approvalId = blocked.body.error.details.approvalId as string;
    await post(t.approver, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }).expect(200);
    await post(t.accountant, `/collections/${id}/return`, { reason: 'Bounced', chargePaise: money(300), approvalId }).expect(200);
    const a = await account(t, kid.studentId);
    expect(a.outstandingPaise).toBe(money(4300)); // the bill again, plus the bank charge as a debit note
    expect((await trial(t)).balanced).toBe(true);
  });
});

describe('families, receipts and cancelling (COL-08, 09)', () => {
  it('QA COL-08: one payment can cover two children of the same family; each child keeps their own ledger', async () => {
    const t = await moneySchool();
    const phone = nextPhone();
    const aarav = await enrolled(t, '2026-04-01', { legalFirstName: 'Aarav', guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, relationshipType: 'Mother' } });
    const [match] = (await t.agent.post(`${API}/guardians/match`).send({ phone }).expect(200)).body.data as { personId: string }[];
    const riya = await enrolled(t, '2026-04-01', { legalFirstName: 'Riya', guardian: { guardianPersonId: match!.personId, relationshipType: 'Mother' } });
    await issueMonth(t);
    const stranger = await enrolled(t);
    await issueMonth(t, '2026-12', '2026-12-05');
    const billA = await billOf(t, aarav.studentId);
    const billR = await billOf(t, riya.studentId);
    await openShift(t.cashier);
    const body = { method: 'CASH', amountPaise: money(5000), payerName: 'Priya Sharma', allocations: [{ studentId: aarav.studentId, documentId: billA.documentId, amountPaise: money(4000) }, { studentId: riya.studentId, documentId: billR.documentId, amountPaise: money(1000) }] };
    const res = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), body).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    expect(res.receipt!.lines.map((l) => [l.studentName.startsWith('Aarav') ? 'Aarav' : 'Riya', l.amountPaise])).toEqual([['Aarav', money(4000)], ['Riya', money(1000)]]);
    expect((await FeeDocument.findOne({ _id: billA.documentId, tenantId: t.tenantId }).lean())!.balancePaise).toBe(0);
    expect((await FeeDocument.findOne({ _id: billR.documentId, tenantId: t.tenantId }).lean())!.balancePaise).toBe(money(3000));
    // each child's own ledger shows only their own part
    const ledgerA = await StudentLedgerEntry.find({ tenantId: t.tenantId, studentId: aarav.studentId, kind: 'PAYMENT' }).lean();
    const ledgerR = await StudentLedgerEntry.find({ tenantId: t.tenantId, studentId: riya.studentId, kind: 'PAYMENT' }).lean();
    expect(ledgerA.reduce((s, e) => s + e.amountPaise, 0)).toBe(-money(4000));
    expect(ledgerR.reduce((s, e) => s + e.amountPaise, 0)).toBe(-money(1000));
    // children of different families cannot share one payment
    expectError(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(100), allocations: [{ studentId: aarav.studentId, amountPaise: money(50) }, { studentId: stranger.studentId, amountPaise: money(50) }] }), 422, 'ALLOCATION_INVALID');
  });

  it('QA COL-09: cancelling a receipt takes the payment back and keeps a linked record; a number is never reused', async () => {
    const { t, kid, bill } = await billedStudent();
    await openShift(t.cashier);
    const pay = async (rupees: number) => ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(rupees), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(rupees) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    const first = await pay(1000);
    const cancelled = await ok<ReceiptDTO>(await post(t.agent === t.agent ? t : t, `/receipts/${first.receipt!.receiptId}/cancel`, { reason: 'Entered by mistake' }));
    expect(cancelled).toMatchObject({ status: 'CANCELLED', cancelledReason: 'Entered by mistake', number: first.receipt!.number });
    expect((await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())).toMatchObject({ balancePaise: money(4000), paidPaise: 0 });
    expect(await ReceiptCancellation.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expect((await Receipt.findOne({ _id: first.receipt!.receiptId, tenantId: t.tenantId }).lean())!.amountPaise).toBe(money(1000)); // the receipt itself is exactly as issued
    expectError(await post(t, `/receipts/${first.receipt!.receiptId}/cancel`, { reason: 'again' }), 409, 'RECEIPT_ALREADY_CANCELLED');
    const second = await pay(1000);
    expect(second.receipt!.number).not.toBe(first.receipt!.number);
    const numbers = (await Receipt.find({ tenantId: t.tenantId }).lean()).map((r) => r.number).sort();
    expect(new Set(numbers).size).toBe(2);
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA COL-09: a big receipt needs a second person to approve its cancellation; the parent sees only their own children\'s receipts', async () => {
    const phone = nextPhone();
    const { t, kid, bill } = await billedStudent({ guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, email: 'priya.rcpt@example.com', relationshipType: 'Mother' } });
    await openShift(t.cashier);
    const big = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(15000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    const blocked = await post(t, `/receipts/${big.receipt!.receiptId}/cancel`, { reason: 'Wrong payer' });
    expectError(blocked, 409, 'APPROVAL_REQUIRED');
    const approvalId = blocked.body.error.details.approvalId as string;
    await post(t.approver, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }).expect(200);
    await ok(await post(t, `/receipts/${big.receipt!.receiptId}/cancel`, { reason: 'Wrong payer', approvalId }));
    // a parent sees receipts for their own child only, as a PDF too
    const own = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(1000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(1000) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    const stranger = await enrolled(t);
    const strangerBill = (await getOk<{ items: { documentId: string }[] }>(t, `/fee-documents?studentId=${stranger.studentId}&kind=BILL`)).items[0];
    void strangerBill;
    const parent = await activatedParent(t, kid.studentId, 'priya.rcpt@example.com');
    const receipts = (await parent.agent.get(`${API}/parent/fees/receipts`).expect(200)).body.data as ReceiptDTO[];
    expect(receipts.map((r) => r.number)).toContain(own.receipt!.number);
    expect(receipts.every((r) => r.lines.every((l) => l.studentId === kid.studentId))).toBe(true);
    const pdf = await parent.agent.get(`${API}/parent/fees/receipts/${own.receipt!.receiptId}/pdf`).expect(200);
    expect(pdf.headers['content-type']).toMatch(/pdf/);
    expect((await parent.agent.get(`${API}/finance/receipts/${own.receipt!.receiptId}`)).status).toBe(403);
  });
});

describe('refunds (COL-10)', () => {
  async function withAdvance() {
    const { t, kid, bill } = await billedStudent();
    await openShift(t.cashier);
    const res = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(6000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    return { t, kid, bill, res };
  }

  it('QA COL-10: a refund can never be more than the money owed back; approval is not payment; the books move at each step', async () => {
    const { t, kid } = await withAdvance();
    const r = await getOk<{ refundablePaise: number; sentence: string }>(t.accountant, `/refundable?studentId=${kid.studentId}`);
    expect(r.refundablePaise).toBe(money(2000));
    expectError(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Leaving', amountPaise: money(2500) }), 422, 'REFUND_EXCEEDS_CREDIT');
    const refund = await created<RefundDTO>(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Child is leaving the school', amountPaise: money(2000) }));
    expect(refund).toMatchObject({ state: 'ELIGIBLE', amountPaise: money(2000), fromAdvancePaise: money(2000) });
    // a refund already in progress counts against what is left
    expectError(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Again', amountPaise: money(100) }), 422, 'REFUND_EXCEEDS_CREDIT');
    expectError(await post(t.accountant, `/refunds/${refund.refundId}/approve`, {}), 403, 'FORBIDDEN'); // not an approver
    const approved = await ok<RefundDTO>(await post(t.approver, `/refunds/${refund.refundId}/approve`, {}));
    expect(approved).toMatchObject({ state: 'APPROVED', approvedByName: expect.any(String) });
    expect((await account(t, kid.studentId)).advancePaise).toBe(0);
    // approved is not paid: Refunds Payable holds the promise
    const accounts = await getOk<{ accountId: string; systemRole: string }[]>(t, '/chart-of-accounts');
    const payable = accounts.find((a) => a.systemRole === 'REFUND_PAYABLE')!;
    expect((await getOk<{ closingPaise: number }>(t, `/general-ledger?accountId=${payable.accountId}`)).closingPaise).toBe(money(2000));
    expectError(await post(t.accountant, `/refunds/${refund.refundId}/record-disbursement`, { bankAccountId: t.bank.bankAccountId }), 400, 'VALIDATION_FAILED'); // a bank payment needs its reference
    const paid = await ok<RefundDTO>(await post(t.accountant, `/refunds/${refund.refundId}/record-disbursement`, { bankAccountId: t.bank.bankAccountId, reference: 'NEFT778899' }));
    expect(paid).toMatchObject({ state: 'PAID', paidReference: 'NEFT778899' });
    expect((await getOk<{ closingPaise: number }>(t, `/general-ledger?accountId=${payable.accountId}`)).closingPaise).toBe(0);
    expectError(await post(t.accountant, `/refunds/${refund.refundId}/record-disbursement`, { bankAccountId: t.bank.bankAccountId, reference: 'NEFT1' }), 409, 'COLLECTION_STATE_INVALID');
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA COL-10: the person who asked for a refund cannot approve it, and open bills come out of what can be refunded', async () => {
    const { t, kid } = await withAdvance();
    await issueMonth(t, '2026-12', '2026-12-05'); // ₹4,000 is owed again, so the ₹2,000 advance is not refundable now
    expect((await getOk<{ refundablePaise: number }>(t.accountant, `/refundable?studentId=${kid.studentId}`)).refundablePaise).toBe(0);
    await post(t.cashier, `/students/${kid.studentId}/apply-advance`, {}).expect(200);
    const own = await staffWith(t, ['ACCOUNTANT', 'APPROVER']); // one login that can both ask and approve
    await openShift(t.cashier2);
    await withKey(t.cashier2.agent, '/collections', key(), { method: 'CASH', amountPaise: money(7000), allocations: [{ studentId: kid.studentId, amountPaise: money(6000) }] }).then((r) => expect(r.status).toBe(201));
    const refund = await created<RefundDTO>(await post(own, '/refunds', { studentId: kid.studentId, reason: 'Test', amountPaise: money(1000) }));
    expectError(await post(own, `/refunds/${refund.refundId}/approve`, {}), 403, 'SELF_APPROVAL_BLOCKED');
    const other = await ok<RefundDTO>(await post(t.approver, `/refunds/${refund.refundId}/approve`, {}));
    expect(other.state).toBe('APPROVED');
  });

  it('QA COL-10: a receipt whose money was already refunded cannot be cancelled', async () => {
    const { t, kid, res } = await withAdvance();
    const refund = await created<RefundDTO>(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Leaving', amountPaise: money(2000) }));
    await post(t.approver, `/refunds/${refund.refundId}/approve`, {}).expect(200);
    expectError(await post(t, `/receipts/${res.receipt!.receiptId}/cancel`, { reason: 'Mistake' }), 409, 'COLLECTION_STATE_INVALID');
  });
});

describe('who can see and change what (COL-11, SEC)', () => {
  it('QA COL-11: collection reports state their basis, split money by method, and the CSV needs its own permission and is safe', async () => {
    const { t, kid, bill } = await billedStudent();
    await openShift(t.cashier);
    await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(1000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(1000) }] });
    const upi = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), upiBody(kid.studentId, 500, 'UTR-REPORT-1')).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    const byMethod = await getOk<ReportDTO>(t.accountant, '/collection-reports/by-method');
    expect(byMethod.basis).toMatch(/money received/i);
    expect(byMethod.rows).toEqual([{ method: 'CASH', count: 1, totalPaise: money(1000) }]); // the waiting UPI payment is not counted as received
    const pending = await getOk<ReportDTO>(t.accountant, '/collection-reports/pending-verification');
    expect(pending.rows).toHaveLength(1);
    expect(pending.basis).toMatch(/not yet received/i);
    const byFee = await getOk<ReportDTO>(t.accountant, '/collection-reports/by-fee-head');
    expect(byFee.totals).toEqual({ totalPaise: money(1000) });
    // csv: the cashier has no report permission; the accountant has export; a formula-looking cell is escaped
    expect((await t.cashier.agent.get(`${API}/finance/collection-reports/by-method`)).status).toBe(403);
    const csv = await t.accountant.agent.get(`${API}/finance/collection-reports/by-method?format=csv`).expect(200);
    expect(csv.headers['content-type']).toMatch(/csv/);
    expect(csv.text).toContain('Collections by payment method');
    expect(csv.text).toContain('CASH,1,1000.00');
    await Collection.updateOne({ _id: upi.collection.collectionId, tenantId: t.tenantId }, { $set: { reference: '=HYPERLINK("x")', referenceNorm: 'X', status: 'RECEIVED' } });
    const cheques = await t.accountant.agent.get(`${API}/finance/collection-reports/pending-verification?format=csv`).expect(200);
    expect(cheques.text).toContain("'=HYPERLINK");
    expect(cheques.text).not.toMatch(/,=HYPERLINK/);
    expectError(await t.accountant.agent.get(`${API}/finance/collection-reports/nonsense`), 400, 'VALIDATION_FAILED');
  });

  it('QA SEC-COL-01: another school gets 404, and a login without finance permission gets 403', async () => {
    const { t, kid, bill } = await billedStudent();
    await openShift(t.cashier);
    const res = await ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(1000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(1000) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    const other = await moneySchool();
    expect((await other.agent.get(`${API}/finance/collections/${res.collection.collectionId}`)).status).toBe(404);
    expect((await other.agent.get(`${API}/finance/receipts/${res.receipt!.receiptId}`)).status).toBe(404);
    const nobody = await staffWith(t, []);
    expect((await nobody.agent.get(`${API}/finance/collections`)).status).toBe(403);
    expect((await nobody.agent.post(`${API}/finance/collections`).set('Idempotency-Key', 'x').send({})).status).toBe(403);
    // a collector at another campus cannot see Mohali money
    const chd = await staffWith(t, ['COLLECTOR', 'ACCOUNTANT'], { primaryLocationId: t.chd.locationId });
    expect((await chd.agent.get(`${API}/finance/collections/${res.collection.collectionId}`)).status).toBe(404);
    expect(((await chd.agent.get(`${API}/finance/collections`).expect(200)).body.data as { total: number }).total).toBe(0);
    void patch; void put;
  });
});

describe('fee extras (FEE-15 to 17)', () => {
  it('QA FEE-15: the Transfer Certificate waits for dues, clears itself when fees are settled, and a manual clear needs a reason', async () => {
    const { t, kid, bill } = await billedStudent();
    const tc = (await t.agent.post(`${API}/students/${kid.studentId}/transfer-certificates`).send({}).expect(201)).body.data as { certificateId: string };
    const manual = await t.agent.patch(`${API}/transfer-certificates/${tc.certificateId}`).send({ duesStatus: 'CLEARED' });
    expectError(manual, 409, 'DUES_NOT_CLEAR');
    const approvedEarly = (await t.agent.post(`${API}/transfer-certificates/${tc.certificateId}/approve`).expect(200)).body.data as { status: string };
    expect(approvedEarly.status).toBe('PENDING_CLEARANCE');
    await openShift(t.cashier);
    await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(4000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    const approved = (await t.agent.post(`${API}/transfer-certificates/${tc.certificateId}/approve`).expect(200)).body.data as { status: string; duesStatus: string };
    expect(approved).toMatchObject({ status: 'APPROVED', duesStatus: 'CLEARED' });
    const summary = await getOk<{ status: string; sentence: string }>(t, `/students/${kid.studentId}/clearance`);
    expect(summary.status).toBe('CLEAR');
  });

  it('QA FEE-15: the clearance summary lists what is owed, waiting and refundable', async () => {
    const { t, kid } = await billedStudent();
    await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(1000) }], method: 'UPI', amountPaise: money(1000), paidOn: today(), reference: 'CLR-1' }).expect(201);
    const summary = await getOk<{ status: string; outstandingPaise: number; pendingClaims: number; sentence: string }>(t, `/students/${kid.studentId}/clearance`);
    expect(summary).toMatchObject({ status: 'DUES', outstandingPaise: money(4000), pendingClaims: 1 });
    expect(summary.sentence).toMatch(/₹4,000 is still owed/);
    expect(summary.sentence).toMatch(/1 payment is waiting/);
  });

  it('QA FEE-16: opening balances import with a preview, a safe retry, and no income', async () => {
    const t = await moneySchool();
    const a = await enrolled(t, '2026-04-01', {  });
    const b = await enrolled(t, '2026-04-01', {});
    const csv = `admissionNumber,amount\r\n${a.student.admissionNumber},2500.50\r\n${b.student.admissionNumber},1000\r\nNOPE-1,50\r\n`;
    const preview = (await t.agent.post(`${API}/finance/fee-imports/preview`).field('kind', 'OPENING_BALANCES').attach('file', Buffer.from(csv), 'balances.csv').expect(200)).body.data as { ready: number; rows: number; problems: { row: number; message: string }[]; totalPaise: number };
    expect(preview).toMatchObject({ rows: 3, ready: 2, totalPaise: 350050 });
    expect(preview.problems[0]).toMatchObject({ row: 4 });
    const commit = async () => (await t.agent.post(`${API}/finance/fee-imports/commit`).field('kind', 'OPENING_BALANCES').field('asOf', '2026-04-01').attach('file', Buffer.from(csv), 'balances.csv').expect(200)).body.data as { committed: boolean };
    expect((await commit()).committed).toBe(true);
    await commit(); // a retry changes nothing
    expect((await account(t, a.studentId)).outstandingPaise).toBe(250050);
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'OPENING' })).toBe(2);
    const tb = await trial(t);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.name === 'Opening Balance Equity')!.creditPaise).toBe(350050); // brought-forward debt is equity, not income
  });

  it('QA FEE-17: a reminder lists who is overdue and writes a plain message with amounts and bill numbers only', async () => {
    const { t, kid } = await billedStudent({ guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone: nextPhone(), email: 'priya.reminder@example.com', relationshipType: 'Mother' } });
    const preview = (await post(t, '/reminders/preview', { minDaysOverdue: 7 }).expect(200)).body.data as { count: number; totalPaise: number; items: { studentId: string; guardianEmail: string | null; billNumbers: string[] }[] };
    expect(preview.count).toBe(1);
    expect(preview.items[0]).toMatchObject({ studentId: kid.studentId, guardianEmail: 'priya.reminder@example.com' });
    expect((await post(t, '/reminders/preview', { minDaysOverdue: 365 }).expect(200)).body.data.count).toBe(0);
    const sent = (await post(t, '/reminders/send', { minDaysOverdue: 7 }).expect(200)).body.data as { sent: number };
    expect(sent.sent).toBe(1);
    const mail = (await DevOutbox.findOne({ to: 'priya.reminder@example.com', template: 'FEE_REMINDER' }).setOptions(SKIP_TENANT_SCOPE).lean())!;
    expect(mail.body).toMatch(/₹4,000 is overdue/);
    expect(mail.body).toContain('BILL/2026-27/');
    expect(mail.body).not.toMatch(/account|ifsc|journal/i);
  });
});

void mongoose;
void PaymentClaim;
void ({} as ParentFeeSummaryDTO);

const upi = (studentId: string, amount: number, reference: string) => ({ method: 'UPI', amountPaise: money(amount), reference, payerName: 'Priya Sharma', allocations: [{ studentId, amountPaise: money(amount) }] });
const seen = (amount: number, extra: Record<string, unknown> = {}) => ({ amountSeenPaise: money(amount), evidence: { seenOn: today(), note: 'seen' }, ...extra });

/** A bank statement as the bank gives it: dd/mm/yyyy dates and separate withdrawal and deposit columns. */
function statement(rows: { date?: string; narration: string; ref?: string; debit?: number; credit?: number; balance?: number }[]) {
  const d = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
  return ['Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt,Closing Balance', ...rows.map((r) => [d(r.date ?? today()), r.narration, r.ref ?? '', r.debit ?? '', r.credit ?? '', r.balance ?? ''].join(','))].join('\r\n');
}

async function upload(t: MoneySchool, text: string, fields: Record<string, string> = {}, as = t.accountant, name = 'stmt.csv') {
  let req = as.agent.post(`${API}/finance/bank-accounts/${t.bank.bankAccountId}/statements`);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', Buffer.from(text), name);
}
const imported = async (t: MoneySchool, text: string, fields: Record<string, string> = {}) => {
  const res = await upload(t, text, fields);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as StatementImportDTO;
};
const autoMatch = async (t: MoneySchool) => ok<AutoMatchResultDTO>(await post(t.accountant, '/reconciliation/auto-match', { bankAccountId: t.bank.bankAccountId }));
const lines = async (t: MoneySchool, status?: string) => (await getOk<{ items: StatementLineDTO[] }>(t.accountant, `/reconciliation/lines?bankAccountId=${t.bank.bankAccountId}&pageSize=100${status ? `&status=${status}` : ''}`)).items;
const exceptions = (t: MoneySchool) => getOk<ReconExceptionsDTO>(t.accountant, `/reconciliation/exceptions?bankAccountId=${t.bank.bankAccountId}`);

async function billed() {
  const t = await moneySchool();
  const kid = await enrolled(t);
  await issueMonth(t);
  await openShift(t.cashier);
  return { t, kid, bill: await billOf(t, kid.studentId) };
}

describe('bank statement import (FIN-09)', () => {
  it('QA FIN-09: columns are found by name and remembered; the file is kept; nothing is half imported', async () => {
    const { t } = await billed();
    const text = statement([{ narration: 'UPI CR PRIYA', ref: 'UTR1', credit: 4000 }, { narration: 'CHEQUE DEP', ref: '000123', credit: 2500.5 }, { narration: 'SMS CHARGES', debit: 11.8 }]);
    const first = await imported(t, text, { openingBalance: '10000', closingBalance: '16488.70' });
    expect(first).toMatchObject({ rowCount: 3, keptCount: 3, skippedCount: 0, creditsPaise: money(6500) + 50, debitsPaise: 1180, openingPaise: money(10000), closingPaise: 1648870 });
    const rows = await lines(t);
    expect(rows).toHaveLength(3);
    expect(rows.find((r) => r.reference === 'UTR1')).toMatchObject({ creditPaise: money(4000), debitPaise: 0, status: 'UNMATCHED' });
    // a bad row refuses the whole file and says which row
    const bad = await upload(t, statement([{ narration: 'OK', credit: 100 }]).replace(/\d{2}\/\d{2}\/\d{4}/, '31/02/2026'));
    expectError(bad, 422, 'STATEMENT_INVALID');
    expect(bad.body.error.details.problems[0].row).toBe(2);
    expect(await lines(t)).toHaveLength(3);
    // a file that does not add up is refused
    expectError(await upload(t, statement([{ narration: 'X', ref: 'UTR9', credit: 100 }]), { openingBalance: '1000', closingBalance: '1200' }), 422, 'STATEMENT_INVALID');
    // other column names work after the first import (remembered) and with a different bank format
    const other = 'Txn Date,Particulars,UTR,Amount\r\n2026-11-01,NEFT IN,UTRX1,500.00\r\n2026-11-02,ATM,,-200.00\r\n';
    const second = await imported(t, other);
    expect(second.creditsPaise).toBe(money(500));
    expect(second.debitsPaise).toBe(money(200));
  });

  it('QA FIN-09: the same file again is refused with a link to the first import; an overlapping file adds only what is new', async () => {
    const { t } = await billed();
    const text = statement([{ narration: 'UPI A', ref: 'UTR-A', credit: 1000 }, { narration: 'UPI B', ref: 'UTR-B', credit: 2000 }]);
    const first = await imported(t, text);
    const again = await upload(t, text);
    const err = expectError(again, 409, 'STATEMENT_ALREADY_IMPORTED');
    expect(err.details).toMatchObject({ importId: first.importId });
    const overlap = await imported(t, statement([{ narration: 'UPI B', ref: 'UTR-B', credit: 2000 }, { narration: 'UPI C', ref: 'UTR-C', credit: 3000 }]));
    expect(overlap).toMatchObject({ rowCount: 2, keptCount: 1, skippedCount: 1 });
    expect(await lines(t)).toHaveLength(3);
  });

  it('QA FIN-09: two real payments of the same amount on the same day are both kept; the same reference twice is flagged, not dropped', async () => {
    const { t } = await billed();
    await imported(t, statement([{ narration: 'UPI X', ref: 'UTR-1', credit: 1000 }, { narration: 'UPI Y', ref: 'UTR-2', credit: 1000 }, { narration: 'UPI Z', ref: 'UTR-3', credit: 500 }, { narration: 'UPI Z', ref: 'UTR-3', credit: 500 }]));
    const all = await lines(t);
    expect(all).toHaveLength(4);
    expect(all.filter((l) => l.creditPaise === money(1000))).toHaveLength(2);
    expect(all.filter((l) => l.status === 'DUPLICATE_SUSPECTED')).toHaveLength(1);
    expect((await exceptions(t)).counts.possibleDuplicates).toBe(1);
  });

  it('QA FIN-09: only a user with the reconciliation permission can import, and another school never sees the lines', async () => {
    const { t } = await billed();
    const text = statement([{ narration: 'UPI A', ref: 'UTR-A', credit: 1000 }]);
    expect((await upload(t, text, {}, t.cashier)).status).toBe(403);
    await imported(t, text);
    const other = await moneySchool();
    expect((await other.accountant.agent.get(`${API}/finance/reconciliation/lines?bankAccountId=${t.bank.bankAccountId}`)).status).toBe(404);
  });
});

describe('matching and exceptions (FIN-10, 11)', () => {
  it('QA FIN-10: a HIGH match with one candidate and a verified payment is confirmed by the system; nothing else is', async () => {
    const { t, kid } = await billed();
    const posted = await collect(t, upi(kid.studentId, 4000, 'UTR556677'));
    await ok(await post(t.accountant, `/collections/${posted.collection.collectionId}/verify`, seen(4000)));
    await imported(t, statement([{ narration: 'UPI CR PRIYA SHARMA', ref: 'UTR556677', credit: 4000 }, { narration: 'MISC CREDIT', ref: 'ZZ1', credit: 777 }]));
    const result = await autoMatch(t);
    expect(result).toMatchObject({ confirmed: 1, unmatched: 1 });
    const all = await lines(t);
    expect(all.find((l) => l.reference === 'UTR556677')!.status).toBe('AUTO_MATCHED');
    expect(all.find((l) => l.reference === 'ZZ1')!.status).toBe('UNMATCHED');
    expect(await autoMatch(t)).toMatchObject({ confirmed: 0 }); // running it again changes nothing
    expect(await ReconciliationMatch.countDocuments({ tenantId: t.tenantId, state: 'CONFIRMED' })).toBe(1);
  });

  it('QA FIN-10: a payment nobody has checked is only suggested; "Verify and Match" checks it and matches it in one click', async () => {
    const { t, kid } = await billed();
    const pending = await collect(t, upi(kid.studentId, 4000, 'UTR888111'));
    await imported(t, statement([{ narration: 'UPI CR', ref: 'UTR888111', credit: 4000 }]));
    expect(await autoMatch(t)).toMatchObject({ confirmed: 0, suggested: 1 });
    const ex = await exceptions(t);
    expect(ex.headline).toBe('1 imported · 0 matched · 1 waiting for verification · 0 amount mismatches · 0 possible duplicates');
    const item = ex.groups.find((g) => g.key === 'WAITING_FOR_VERIFICATION')!.items[0]!;
    expect(item.matches[0]).toMatchObject({ confidence: 'HIGH', needsVerification: true });
    const matchId = item.matches[0]!.matchId;
    expectError(await post(t.accountant, `/reconciliation/matches/${matchId}/confirm`, {}), 422, 'MATCH_INVALID'); // not checked yet
    const done = await ok<MatchDTO>(await post(t.accountant, `/reconciliation/matches/${matchId}/confirm`, { verify: true }));
    expect(done.state).toBe('CONFIRMED');
    expect((await lines(t))[0]!.status).toBe('VERIFIED_MATCHED');
    const row = (await getOk<{ items: { status: string; receiptNumber: string | null }[] }>(t.accountant, '/collections?status=POSTED')).items[0]!;
    expect(row.receiptNumber).toMatch(/^RCT\//); // the receipt exists only after the money was checked
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, sourceKey: `collection:${pending.collection.collectionId}` })).toBe(1);
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA FIN-10: two payments that look the same make two suggestions, never an automatic match', async () => {
    const { t, kid } = await billed();
    const a = await collect(t, upi(kid.studentId, 1000, 'UTR-SAME-1'));
    const b = await collect(t, upi(kid.studentId, 1000, 'UTR-SAME-1'));
    expect(b.collection.flags).toContain('DUPLICATE_SUSPECTED');
    await ok(await post(t.accountant, `/collections/${a.collection.collectionId}/verify`, seen(1000)));
    await imported(t, statement([{ narration: 'UPI', ref: 'UTR-SAME-1', credit: 1000 }]));
    const res = await autoMatch(t);
    expect(res.confirmed).toBe(0);
    expect(res.suggested).toBe(1);
    const line = (await lines(t))[0]!;
    expect(line.status).toBe('SUGGESTED');
  });

  it('QA FIN-10: a different amount with the same reference is an amount mismatch, listed with a plain reason', async () => {
    const { t, kid } = await billed();
    await collect(t, upi(kid.studentId, 4000, 'UTR-MISMATCH'));
    await imported(t, statement([{ narration: 'UPI CR', ref: 'UTR-MISMATCH', credit: 3900 }]));
    await autoMatch(t);
    const ex = await exceptions(t);
    const group = ex.groups.find((g) => g.key === 'AMOUNT_MISMATCH')!;
    expect(group.items).toHaveLength(1);
    expect(group.items[0]!.hint).toMatch(/bank shows ₹3,900 but ₹4,000 was recorded/);
    expect(ex.counts.amountMismatches).toBe(1);
  });

  it('QA FIN-10: one line against several items, and several lines against one item, both match when the totals agree', async () => {
    const { t, kid } = await billed();
    await collect(t, { method: 'CASH', amountPaise: money(4000), allocations: [{ studentId: kid.studentId, amountPaise: money(4000) }] });
    const shifts = await getOk<{ items: { shiftId: string }[] }>(t.cashier, '/cashier-shifts');
    await ok(await post(t.cashier, `/cashier-shifts/${shifts.items[0]!.shiftId}/close`, { countedPaise: money(4000) }));
    const deposit = await created<{ depositId: string }>(await post(t.accountant, '/cash-deposits', { shiftIds: [shifts.items[0]!.shiftId], bankAccountId: t.bank.bankAccountId, amountPaise: money(4000), reference: 'DEP-1' }));
    // the bank credited the deposit in two parts (many lines, one item)
    await imported(t, statement([{ narration: 'CASH DEP PART 1', ref: 'C1', credit: 1500 }, { narration: 'CASH DEP PART 2', ref: 'C2', credit: 2500 }]));
    const [l1, l2] = await lines(t);
    const many = await created<MatchDTO>(await post(t.accountant, '/reconciliation/manual-match', { bankAccountId: t.bank.bankAccountId, lineIds: [l1!.lineId, l2!.lineId], targets: [{ type: 'cash_deposit', id: deposit.depositId }], reason: 'Bank credited it in two parts' }));
    expect(many).toMatchObject({ state: 'CONFIRMED', confidence: 'MANUAL', linesPaise: money(4000), targetsPaise: money(4000) });
    expect((await lines(t)).every((l) => l.status === 'VERIFIED_MATCHED')).toBe(true);
    // a line cannot be matched twice
    expectError(await post(t.accountant, '/reconciliation/manual-match', { bankAccountId: t.bank.bankAccountId, lineIds: [l1!.lineId], targets: [{ type: 'cash_deposit', id: deposit.depositId }] }), 422, 'MATCH_INVALID');
    // reversing puts the lines back
    await ok(await post(t.accountant, `/reconciliation/matches/${many.matchId}/reverse`, { reason: 'Wrong deposit' }));
    expect((await lines(t)).every((l) => l.status === 'UNMATCHED')).toBe(true);
  });

  it('QA FIN-10: one bank debit against several refunds (one-to-many); money out never matches money in', async () => {
    const { t, kid, bill } = await billed();
    await collect(t, { method: 'CASH', amountPaise: money(9000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    const refund = async (rupees: number, ref: string) => {
      const r = await created<RefundDTO>(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Test', amountPaise: money(rupees) }));
      await ok(await post(t.approver, `/refunds/${r.refundId}/approve`, {}));
      await ok(await post(t.accountant, `/refunds/${r.refundId}/record-disbursement`, { bankAccountId: t.bank.bankAccountId, reference: ref }));
    };
    await refund(1000, 'NEFT-R1');
    await refund(2000, 'NEFT-R2');
    await imported(t, statement([{ narration: 'NEFT OUT REFUNDS', ref: 'BATCH9', debit: 3000 }, { narration: 'UPI IN', ref: 'IN1', credit: 3000 }]));
    const [debit, credit] = [(await lines(t)).find((l) => l.debitPaise > 0)!, (await lines(t)).find((l) => l.creditPaise > 0)!];
    const items = (await exceptions(t)).timingDifferences.filter((i) => i.type === 'refund');
    expect(items).toHaveLength(2);
    const res = await created<MatchDTO>(await post(t.accountant, '/reconciliation/manual-match', { bankAccountId: t.bank.bankAccountId, lineIds: [debit.lineId], targets: items.map((i) => ({ type: 'refund', id: i.id })) }));
    expect(res.state).toBe('CONFIRMED');
    expectError(await post(t.accountant, '/reconciliation/manual-match', { bankAccountId: t.bank.bankAccountId, lineIds: [credit.lineId], targets: items.map((i) => ({ type: 'refund', id: i.id })) }), 422, 'MATCH_INVALID');
  });

  it('QA FIN-11: a match with a different total, and setting a line aside, both need a second person', async () => {
    const { t, kid } = await billed();
    const p = await collect(t, upi(kid.studentId, 4000, 'UTR-OVERRIDE'));
    await ok(await post(t.accountant, `/collections/${p.collection.collectionId}/verify`, seen(4000)));
    await imported(t, statement([{ narration: 'UPI CR', ref: 'ODD', credit: 3990 }, { narration: 'UNKNOWN CREDIT', ref: 'JUNK', credit: 50 }]));
    const [odd, junk] = [(await lines(t)).find((l) => l.reference === 'ODD')!, (await lines(t)).find((l) => l.reference === 'JUNK')!];
    const body = { bankAccountId: t.bank.bankAccountId, lineIds: [odd.lineId], targets: [{ type: 'collection', id: p.collection.collectionId }], reason: 'Bank deducted a ₹10 fee' };
    const blocked = await post(t.accountant, '/reconciliation/manual-match', body);
    expectError(blocked, 409, 'APPROVAL_REQUIRED');
    const approvalId = blocked.body.error.details.approvalId as string;
    await ok(await post(t.approver, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }));
    const done = await created<MatchDTO>(await post(t.accountant, '/reconciliation/manual-match', { ...body, approvalId }));
    expect(done.linesPaise - done.targetsPaise).toBe(-1000);
    expect((await lines(t)).find((l) => l.reference === 'ODD')!.status).toBe('VARIANCE');
    const ignore = await post(t.accountant, `/reconciliation/lines/${junk.lineId}/ignore`, { reason: 'Not ours' });
    expectError(ignore, 409, 'APPROVAL_REQUIRED');
    await ok(await post(t.approver, `/approvals/${ignore.body.error.details.approvalId}/decide`, { decision: 'APPROVE' }));
    const set = await ok<StatementLineDTO>(await post(t.accountant, `/reconciliation/lines/${junk.lineId}/ignore`, { reason: 'Not ours', approvalId: ignore.body.error.details.approvalId }));
    expect(set).toMatchObject({ status: 'IGNORED', ignoredReason: 'Not ours' });
  });

  it('QA FIN-11: a bank charge and bank interest are posted straight from the line, with the right accounts', async () => {
    const { t } = await billed();
    await imported(t, statement([{ narration: 'SMS ALERT CHARGES', debit: 23.6 }, { narration: 'INTEREST CREDITED', credit: 410.25 }]));
    const [charge, interest] = [(await lines(t)).find((l) => l.debitPaise > 0)!, (await lines(t)).find((l) => l.creditPaise > 0)!];
    expectError(await post(t.accountant, `/reconciliation/lines/${charge.lineId}/record-interest`, {}), 422, 'MATCH_INVALID');
    await ok(await post(t.accountant, `/reconciliation/lines/${charge.lineId}/record-bank-charge`, {}));
    await ok(await post(t.accountant, `/reconciliation/lines/${interest.lineId}/record-interest`, {}));
    const tb = await trial(t);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.name === 'Bank Charges')!.debitPaise).toBe(2360);
    expect(tb.rows.find((r) => r.name === 'Bank Interest Income')!.creditPaise).toBe(41025);
    expect((await lines(t)).every((l) => l.status === 'VERIFIED_MATCHED')).toBe(true);
    expectError(await post(t.accountant, `/reconciliation/lines/${charge.lineId}/record-bank-charge`, {}), 422, 'MATCH_INVALID');
  });

  it('QA FIN-11: the reconciliation statement explains the difference between the books and the bank', async () => {
    const { t, kid } = await billed();
    const p = await collect(t, upi(kid.studentId, 4000, 'UTR-RECON-1'));
    await ok(await post(t.accountant, `/collections/${p.collection.collectionId}/verify`, seen(4000)));
    const q = await collect(t, upi(kid.studentId, 500, 'UTR-RECON-2'));
    await ok(await post(t.accountant, `/collections/${q.collection.collectionId}/verify`, seen(500)));
    // the bank shows the first payment and a charge the books do not have yet; the second payment is still "in transit"
    await imported(t, statement([{ narration: 'UPI CR', ref: 'UTR-RECON-1', credit: 4000, balance: 14000 }, { narration: 'SERVICE CHARGE', debit: 100, balance: 13900 }]), { openingBalance: '10000', closingBalance: '13900' });
    await autoMatch(t);
    const s = await getOk<ReconSummaryDTO>(t.accountant, `/reconciliation/summary?bankAccountId=${t.bank.bankAccountId}`);
    expect(s.balancePerBooksPaise).toBe(money(4500));
    expect(s.balancePerBankPaise).toBe(money(13900));
    expect(s.inBooksNotInBank).toEqual([{ label: expect.stringContaining('UPI UTR-RECON-2'), amountPaise: money(500) }]);
    expect(s.inBankNotInBooks).toEqual([{ label: expect.stringContaining('SERVICE CHARGE'), amountPaise: -money(100) }]);
    // the opening balance of the bank (₹10,000) was never in these books, so it shows as the unexplained part
    expect(s.differencePaise).toBe(money(10000));
    expect(s.explained).toBe(false);
  });

  it('QA FIN-11: a payment verified against a bank line links them at once, and a line cannot prove two payments', async () => {
    const { t, kid } = await billed();
    const a = await collect(t, upi(kid.studentId, 1000, 'UTR-LINK-1'));
    const b = await collect(t, upi(kid.studentId, 1000, 'UTR-LINK-2'));
    await imported(t, statement([{ narration: 'UPI CR', ref: 'UTR-LINK-1', credit: 1000 }]));
    const line = (await lines(t))[0]!;
    await ok(await post(t.accountant, `/collections/${a.collection.collectionId}/verify`, seen(1000, { evidence: { seenOn: today(), statementLineId: line.lineId } })));
    expect((await BankStatementLine.findOne({ _id: line.lineId, tenantId: t.tenantId }).lean())!.status).toBe('VERIFIED_MATCHED');
    expectError(await post(t.accountant, `/collections/${b.collection.collectionId}/verify`, seen(1000, { evidence: { seenOn: today(), statementLineId: line.lineId } })), 422, 'MATCH_INVALID');
    const waiting = await getOk<{ items: { status: string }[] }>(t.accountant, '/collections?status=PENDING_VERIFICATION');
    expect(waiting.items).toHaveLength(1);
  });
});

describe('the verification queue (COL-04, FUX-06)', () => {
  it('QA COL-04: claims and counter payments wait in one list, oldest first, each with the bank line that looks like it', async () => {
    const { t, kid } = await billed();
    const claim = await created<{ claimId: string }>(await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(4000) }], method: 'UPI', amountPaise: money(4000), paidOn: today(), reference: 'UTR 4821' }));
    const counter = await collect(t, upi(kid.studentId, 1500, 'NEFT77'));
    await imported(t, statement([{ narration: 'UPI CR PRIYA', ref: 'UTR4821', credit: 4000 }, { narration: 'NEFT IN', ref: 'OTHER', credit: 1500 }]));
    const q = await getOk<VerificationQueueDTO>(t.accountant, '/verification-queue');
    expect(q.total).toBe(2);
    expect(q.items.map((i) => i.kind)).toEqual(['CLAIM', 'COLLECTION']);
    expect(q.items[0]).toMatchObject({ id: claim.claimId, suggestion: { exact: true, amountPaise: money(4000) } });
    expect(q.items[0]!.suggestion!.sentence).toMatch(/^Matches ₹4,000 on .*, ref …4821$/);
    // same amount, near the date, different reference: still suggested, but not an exact match
    expect(q.items[1]).toMatchObject({ id: counter.collection.collectionId, suggestion: { exact: false, amountPaise: money(1500) } });
    // a cashier (no verify permission) cannot read it
    expectError(await t.cashier.agent.get(`${API}/finance/verification-queue`), 403, 'FORBIDDEN');
  });
});

describe('malicious files (SEC-FIN-07)', () => {
  it('SEC-FIN-07: a bank statement or payment proof with a virus test string is refused, a proof must be an image or PDF, and nothing is stored', async () => {
    const { t, kid } = await billed();
    const virus = `Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt\r\n01/11/2026,X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*,R1,,100\r\n`;
    expectError(await upload(t, virus), 422, 'FILE_REJECTED');
    expectError(await upload(t, 'Date,Narration\r\n\u0000\u0000binary'), 422, 'STATEMENT_INVALID');
    expect(await lines(t)).toHaveLength(0);
    const claim = await created<{ claimId: string }>(await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(100) }], method: 'UPI', amountPaise: money(100), paidOn: today(), reference: 'UTR-PROOF-1' }));
    const proof = (buffer: Buffer, name: string) => t.agent.post(`${API}/finance/payment-claims/${claim.claimId}/proof`).attach('file', buffer, name);
    expectError(await proof(EICAR, 'proof.pdf'), 422, 'FILE_REJECTED');
    const text = await proof(Buffer.from('just some text, not a picture'), 'proof.png');
    expect([415, 422]).toContain(text.status);
    const listed = await getOk<{ items: { claimId: string; hasProof: boolean }[] }>(t, '/payment-claims');
    expect(listed.items.find((c) => c.claimId === claim.claimId)!.hasProof).toBe(false);
    await ok(await proof(PNG, 'proof.png'));
  });
});
