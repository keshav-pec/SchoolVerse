import { describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import type { TrialBalanceDTO, ClaimDTO, CollectionResultDTO, DisbursementBatchDTO, FamilyDTO, PayrollRunDTO, RefundDTO, StudentAccountDTO, AdvanceDTO } from '@shared';
import { postJournal } from '../src/modules/finance/core/posting';
import { financeCtx } from '../src/modules/finance/core/context';
import { withTransaction } from '../src/db/transaction';
import { JournalEntry, JournalLine } from '../src/modules/finance/core/models';
import { Collection, CollectionAllocation, Receipt } from '../src/modules/finance/collections/models';
import { BankStatementLine, ReconciliationMatch } from '../src/modules/finance/banking/models';
import { PayrollRun, PayrollRunLine, Payslip, DisbursementItem } from '../src/modules/finance/payroll/models';
import { FeeDocument, FeeDocumentLine, StudentLedgerEntry } from '../src/modules/finance/fees/models';
import { API, addActiveEmployee, expectError, nextPhone, today, useTestDatabase } from './helpers';
import { MONTH, finalise, lineAmount, linesOf, newRun, pay, payGet, payOk, payPut, payrollSchool, trial, worker } from './finance-payroll-helpers';
import { billOf, created, enrolled, getOk, issueMonth, key, money, moneySchool, ok, openShift, post, withKey, type MoneySchool } from './finance-helpers';

useTestDatabase();

/**
 * The accounting invariants (item 55): the promises the books make, whatever anyone clicks. One test each, named by its number. A failure here
 * means money could be lost, counted twice or hidden, so these never get skipped.
 */

const collect = async (t: MoneySchool, body: Record<string, unknown>, agent = t.cashier) => ok<CollectionResultDTO>(await withKey(agent.agent, '/collections', key(), body).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
async function billed() {
  const t = await moneySchool();
  const kid = await enrolled(t);
  await issueMonth(t);
  await openShift(t.cashier);
  return { t, kid, bill: await billOf(t, kid.studentId) };
}

describe('the accounting invariants (item 55)', () => {
  it('INV-01: every journal balances, after a busy mix of bills, payments, refunds, expenses and payroll', async () => {
    const { t, kid, bill } = await billed();
    await collect(t, { method: 'CASH', amountPaise: money(6000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    const r = await created<RefundDTO>(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Test', amountPaise: money(2000) }));
    await ok(await post(t.approver, `/refunds/${r.refundId}/approve`, {}));
    const cat = (await getOk<{ code: string; categoryId: string }[]>(t, '/expense-categories')).find((c) => c.code === 'SUPPLIES')!;
    await created(await post(t.accountant, '/expenses', { categoryId: cat.categoryId, taxableValuePaise: money(250), date: today(), description: 'x', locationId: t.moh.locationId, paymentMode: 'CASH', gstRateBps: 0 }));
    const sums = await JournalLine.aggregate<{ _id: string; d: number; c: number }>([{ $match: { tenantId: t.tenantId } }, { $group: { _id: '$journalId', d: { $sum: '$debitPaise' }, c: { $sum: '$creditPaise' } } }]);
    expect(sums.length).toBeGreaterThanOrEqual(4);
    expect(sums.filter((s) => s.d !== s.c)).toEqual([]);
    expect((await trial(t)).balanced).toBe(true);
  });

  it('INV-02: one source event gives one posting: verifying twice, or retrying a posting with the same key, never doubles', async () => {
    const { t, kid } = await billed();
    const claim = await created<ClaimDTO>(await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(1000) }], method: 'UPI', amountPaise: money(1000), paidOn: today(), reference: 'INV2' }));
    const body = { amountSeenPaise: money(1000), evidence: { seenOn: today() } };
    const [a, b] = await Promise.all([post(t.accountant, `/payment-claims/${claim.claimId}/verify`, body), post(t.accountant, `/payment-claims/${claim.claimId}/verify`, body)]);
    expect([a.status, b.status].every((s) => s === 200 || s === 409)).toBe(true);
    expect(await Collection.countDocuments({ tenantId: t.tenantId, claimId: claim.claimId })).toBe(1);
    expect(await Receipt.countDocuments({ tenantId: t.tenantId })).toBe(1);
    const f = await financeCtx(t.ctx);
    const accounts = await getOk<{ accountId: string; code: string }[]>(t, '/chart-of-accounts');
    const id = (c: string) => accounts.find((x) => x.code === c)!.accountId;
    const lines = [{ accountId: id('5300'), debitPaise: 100 }, { accountId: id('1020'), creditPaise: 100 }];
    const first = await withTransaction((db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'inv2:retry', accountingDate: today(), lines, memo: 'a' }));
    const second = await withTransaction((db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'inv2:retry', accountingDate: today(), lines, memo: 'a' }));
    expect(second.created).toBe(false);
    expect(second.journal._id).toBe(first.journal._id);
  });

  it('INV-03: never apply more than the verified funds: a waiting payment cannot be allocated and an allocation cannot exceed what is unallocated', async () => {
    const { t, kid, bill } = await billed();
    const waiting = await collect(t, { method: 'UPI', amountPaise: money(1000), reference: 'INV3', allocations: [{ studentId: kid.studentId, amountPaise: money(1000) }] });
    expectError(await post(t, `/collections/${waiting.collection.collectionId}/allocate`, { items: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(1000) }] }), 422, 'ALLOCATION_INVALID');
    const cash = await collect(t, { method: 'CASH', amountPaise: money(1000), allocations: [{ studentId: kid.studentId, amountPaise: money(100) }] });
    expect(cash.collection.unallocatedPaise).toBe(money(900));
    expectError(await post(t, `/collections/${cash.collection.collectionId}/allocate`, { items: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(1000) }] }), 409, 'ALLOCATION_CONFLICT');
  });

  it('INV-04: a bill is never over-settled, even when two people pay it at the same moment', async () => {
    const { t, kid, bill } = await billed();
    await openShift(t.cashier2);
    const body = { method: 'CASH', amountPaise: money(4000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] };
    await Promise.all([withKey(t.cashier.agent, '/collections', key(), body), withKey(t.cashier2.agent, '/collections', key(), body)]);
    const doc = (await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())!;
    expect(doc.paidPaise).toBeLessThanOrEqual(doc.totalPaise);
    expect(doc.balancePaise).toBeGreaterThanOrEqual(0);
    const active = await CollectionAllocation.find({ tenantId: t.tenantId, documentId: bill.documentId, status: 'ACTIVE' }).lean();
    expect(active.reduce((s, a) => s + a.amountPaise, 0)).toBe(doc.paidPaise);
  });

  it('INV-05: a refund can never be more than the money owed back', async () => {
    const { t, kid, bill } = await billed();
    await collect(t, { method: 'CASH', amountPaise: money(5000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    expectError(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'x', amountPaise: money(1001) }), 422, 'REFUND_EXCEEDS_CREDIT');
    await created(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'x', amountPaise: money(1000) }));
  });

  it('INV-06: advances and deposits stay liabilities until they are used or returned; they are never income', async () => {
    const t = await moneySchool();
    const kid = await enrolled(t);
    await issueMonth(t, '2026-04', '2026-04-05'); // April includes the ₹5,000 refundable deposit
    await openShift(t.cashier);
    await collect(t, { method: 'CASH', amountPaise: money(20000), allocations: [{ studentId: kid.studentId, amountPaise: money(1) }] });
    const tb = await getOk<TrialBalanceDTO>(t, '/trial-balance?asOf=2027-03-31');
    const row = (n: string) => tb.rows.find((r) => r.name === n);
    expect(row('Refundable Deposits')!.creditPaise).toBe(money(5000));
    expect(row('Student Advances')!.creditPaise).toBeGreaterThan(0);
    expect(tb.rows.filter((r) => r.type === 'INCOME').every((r) => r.name !== 'Refundable Deposits' && r.name !== 'Student Advances')).toBe(true);
    const income = tb.rows.filter((r) => r.type === 'INCOME').reduce((s, r) => s + r.creditPaise, 0);
    expect(income).toBe(money(12000)); // tuition ₹4,000 + annual ₹8,000: the deposit and the advance are not in it
  });

  it('INV-07: an issued document keeps its number and content after anything that happens to it', async () => {
    const { t, kid, bill } = await billed();
    const before = (await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())!;
    await created(await post(t, `/fee-documents/${bill.documentId}/adjustments`, { type: 'CREDIT_NOTE', reason: 'Test', lines: [{ lineId: (await getOk<{ lines: { lineId: string }[] }>(t, `/fee-documents/${bill.documentId}`)).lines[0]!.lineId, amountPaise: money(100) }] }));
    const paid = await collect(t, { method: 'CASH', amountPaise: money(100), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(100) }] });
    await ok(await post(t, `/receipts/${paid.receipt!.receiptId}/cancel`, { reason: 'Test' }));
    const after = (await FeeDocument.findOne({ _id: bill.documentId, tenantId: t.tenantId }).lean())!;
    expect(after.number).toBe(before.number);
    expect(after.totalPaise).toBe(before.totalPaise);
    expect((await Receipt.findOne({ tenantId: t.tenantId }).lean())!.number).toBe(paid.receipt!.number);
    await expect(FeeDocumentLine.updateOne({ tenantId: t.tenantId, documentId: bill.documentId }, { $set: { totalPaise: 1 } })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
  });

  it('INV-08: running billing again never duplicates a bill', async () => {
    const t = await moneySchool();
    const kid = await enrolled(t);
    await issueMonth(t);
    const second = await post(t, '/billing-runs', { sessionId: t.sessionId, locationId: t.moh.locationId, periodKey: '2026-11', issueDate: '2026-11-05' });
    const run = (await ok<{ runId: string }>(second.status === 201 ? { status: 200, body: second.body } : second));
    const checked = await ok<{ run: { counts: { ready: number }; totalPaise: number } }>(await post(t, `/billing-runs/${run.runId}/validate`));
    expect(checked.run.counts.ready).toBe(0);
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, studentId: kid.studentId, kind: 'BILL', periodKey: '2026-11' })).toBe(1);
  });

  it('INV-09: a finalised payroll changes only through a linked correction or supplementary run', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const run = await newRun(t, [a.employeeId]);
    await finalise(t, run.runId);
    const slip = (await Payslip.findOne({ tenantId: t.tenantId, runId: run.runId }).lean())!;
    await expect(Payslip.updateOne({ tenantId: t.tenantId, _id: slip._id }, { $set: { month: '2020-01' } })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    expectError((await pay(t.officer, `/runs/${run.runId}/calculate`)) as never, 409, 'PAYROLL_STATE_INVALID');
    const supp = await payOk<PayrollRunDTO>(await pay(t.officer, '/runs', { month: MONTH, type: 'SUPPLEMENTARY', parentRunId: run.runId, employeeIds: [a.employeeId] }), 201);
    expect(supp.parentRunId).toBe(run.runId);
    await t.officer.agent.patch(`${API}/payroll/runs/${supp.runId}/employees/${a.employeeId}`).send({ addLine: { label: 'Arrears', type: 'EARNING', amountPaise: money(1000) }, reason: 'Late increment' }).expect(200);
    expect((await Payslip.findOne({ tenantId: t.tenantId, _id: slip._id }).lean())!.snapshot.netPaise).toBe(slip.snapshot.netPaise);
    expect(await PayrollRun.countDocuments({ tenantId: t.tenantId, parentRunId: run.runId })).toBe(1);
  });

  it('INV-10: net pay is earnings minus deductions minus recoveries, line by line', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 2 }, tdsYearlyRupees: 6250 });
    const adv = await payOk<AdvanceDTO>(await pay(t.officer, '/advances', { employeeId: a.employeeId, principalPaise: money(3000), installments: 3, startMonth: MONTH, reason: 'x' }), 201);
    await payOk(await pay(t.approver, `/advances/${adv.advanceId}/approve`));
    await payOk(await pay(t.officer, `/advances/${adv.advanceId}/record-payment`, { bankAccountId: t.bank.bankAccountId, reference: 'N' }));
    const run = await newRun(t, [a.employeeId]);
    await finalise(t, run.runId);
    const lines = await linesOf(t, run.runId, a.employeeId);
    const sum = (kinds: string[]) => lines.filter((l) => kinds.includes(l.kind)).reduce((s, l) => s + l.amountPaise, 0);
    const row = (await payGet<{ items: { grossPaise: number; deductionsPaise: number; netPaise: number }[] }>(t, `/runs/${run.runId}/employees`)).items[0]!;
    expect(row.grossPaise).toBe(sum(['EARNING', 'ARREAR']));
    expect(row.deductionsPaise).toBe(sum(['DEDUCTION', 'RECOVERY']));
    expect(row.netPaise).toBe(sum(['EARNING', 'ARREAR']) - sum(['DEDUCTION', 'RECOVERY']));
    expect(lines.some((l) => l.kind === 'RECOVERY')).toBe(true);
  });

  it('INV-11: employer contributions are posted separately and never reduce the employee\'s net', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const run = await newRun(t, [a.employeeId]);
    await finalise(t, run.runId);
    const lines = await linesOf(t, run.runId, a.employeeId);
    const employer = lineAmount(lines, 'EMP_PF')!;
    expect(employer).toBe(money(1800));
    const row = (await payGet<{ items: { grossPaise: number; deductionsPaise: number; netPaise: number; employerCostPaise: number }[] }>(t, `/runs/${run.runId}/employees`)).items[0]!;
    expect(row.netPaise).toBe(row.grossPaise - row.deductionsPaise);
    expect(row.employerCostPaise).toBe(employer);
    const tb = await trial(t);
    expect(tb.rows.find((r) => r.name === 'Employer Contributions')!.debitPaise).toBe(employer);
  });

  it('INV-12: a salary payout can never be more than what is payable', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const run = await newRun(t, [a.employeeId]);
    await finalise(t, run.runId);
    const batch = await payOk<DisbursementBatchDTO>(await pay(t.officer, `/runs/${run.runId}/disbursement-batch`, { bankAccountId: t.bank.bankAccountId }), 201);
    const net = batch.items[0]!.amountPaise;
    expectError((await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID', reference: 'X', amountPaise: net + 1 }] })) as never, 422, 'PAYOUT_EXCEEDS_PAYABLE');
    await payOk(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID', reference: 'X' }] }));
    expect((await DisbursementItem.find({ tenantId: t.tenantId, status: 'PAID' }).lean()).reduce((s, i) => s + i.amountPaise, 0)).toBeLessThanOrEqual(net);
    void payPut;
  });

  it('INV-13: a reconciled match has evidence behind it and belongs to this school only', async () => {
    const { t, kid } = await billed();
    const p = await collect(t, { method: 'UPI', amountPaise: money(1000), reference: 'INV13', allocations: [{ studentId: kid.studentId, amountPaise: money(1000) }] });
    await ok(await post(t.accountant, `/collections/${p.collection.collectionId}/verify`, { amountSeenPaise: money(1000), evidence: { seenOn: today() } }));
    const d = today();
    await t.accountant.agent.post(`${API}/finance/bank-accounts/${t.bank.bankAccountId}/statements`).attach('file', Buffer.from(`Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt\r\n${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)},UPI,INV13,,1000`), 's.csv').expect(201);
    await post(t.accountant, '/reconciliation/auto-match', { bankAccountId: t.bank.bankAccountId });
    const m = (await ReconciliationMatch.findOne({ tenantId: t.tenantId, state: 'CONFIRMED' }).lean())!;
    expect(m.lineIds.length).toBeGreaterThan(0);
    expect(m.targets.length).toBeGreaterThan(0);
    expect(m.confirmedBy).toBeTruthy();
    expect(m.linesPaise).toBe(m.targetsPaise);
    const other = await moneySchool();
    const line = (await BankStatementLine.findOne({ tenantId: t.tenantId }).lean())!;
    expect((await other.accountant.agent.get(`${API}/finance/reconciliation/exceptions?bankAccountId=${t.bank.bankAccountId}`)).status).toBe(404);
    expectError(await post(other.accountant, '/reconciliation/manual-match', { bankAccountId: other.bank.bankAccountId, lineIds: [line._id], targets: [{ type: 'collection', id: p.collection.collectionId }] }), 404, 'NOT_FOUND');
  });

  it('INV-14: a closed period enforces its rules: nothing new is posted into it', async () => {
    const t = await moneySchool();
    const accounts = await getOk<{ accountId: string; code: string }[]>(t, '/chart-of-accounts');
    const id = (c: string) => accounts.find((x) => x.code === c)!.accountId;
    const periods = await getOk<{ periodId: string; startDate: string }[]>(t, '/accounting-periods');
    const april = periods.find((p) => p.startDate === '2026-04-01')!;
    await mongoose.connection.db!.collection('accounting_periods').updateOne({ _id: april.periodId as never }, { $set: { state: 'CLOSED' } });
    const f = await financeCtx(t.ctx);
    await expect(withTransaction((db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'inv14', accountingDate: '2026-04-10', memo: 'late', lines: [{ accountId: id('5300'), debitPaise: 10 }, { accountId: id('1020'), creditPaise: 10 }] }))).rejects.toMatchObject({ code: 'PERIOD_CLOSED' });
  });

  it('INV-15: family totals are only added up on screen: a child\'s own ledger never carries a sibling\'s money', async () => {
    const t = await moneySchool();
    const phone = nextPhone();
    const a = await enrolled(t, '2026-04-01', { legalFirstName: 'Aarav', guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, relationshipType: 'Mother' } });
    const [match] = (await t.agent.post(`${API}/guardians/match`).send({ phone }).expect(200)).body.data as { personId: string }[];
    const b = await enrolled(t, '2026-04-01', { legalFirstName: 'Riya', guardian: { guardianPersonId: match!.personId, relationshipType: 'Mother' } });
    await issueMonth(t);
    await openShift(t.cashier);
    const billA = await billOf(t, a.studentId);
    const billB = await billOf(t, b.studentId);
    await collect(t, { method: 'CASH', amountPaise: money(5000), allocations: [{ studentId: a.studentId, documentId: billA.documentId, amountPaise: money(4000) }, { studentId: b.studentId, documentId: billB.documentId, amountPaise: money(1000) }] });
    const sumOf = async (studentId: string) => (await StudentLedgerEntry.find({ tenantId: t.tenantId, studentId, kind: 'PAYMENT' }).lean()).reduce((s, e) => s + e.amountPaise, 0);
    expect(await sumOf(a.studentId)).toBe(-money(4000));
    expect(await sumOf(b.studentId)).toBe(-money(1000));
    const accountA = await getOk<StudentAccountDTO>(t, `/students/${a.studentId}/account`);
    const accountB = await getOk<StudentAccountDTO>(t, `/students/${b.studentId}/account`);
    const family = await getOk<FamilyDTO>(t, `/families/${(await (await import('../src/modules/students/student.models')).StudentGuardianLink.findOne({ tenantId: t.tenantId, studentId: a.studentId }).lean())!.guardianPersonId}`);
    expect(family.totals.outstandingPaise).toBe(accountA.outstandingPaise + accountB.outstandingPaise);
    expect((await getOk<StudentAccountDTO>(t, `/students/${a.studentId}/account`)).outstandingPaise).toBe(accountA.outstandingPaise);
  });

  it('INV-16: a claim is not a receipt: no receipt, journal or ledger row exists until the money is verified', async () => {
    const { t, kid } = await billed();
    const before = { journals: await JournalEntry.countDocuments({ tenantId: t.tenantId }), ledger: await StudentLedgerEntry.countDocuments({ tenantId: t.tenantId }) };
    await created(await post(t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(4000) }], method: 'UPI', amountPaise: money(4000), paidOn: today(), reference: 'INV16' }));
    expect(await Receipt.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId })).toBe(before.journals);
    expect(await StudentLedgerEntry.countDocuments({ tenantId: t.tenantId })).toBe(before.ledger);
  });

  it('INV-17: a bank file is not a payment: downloading it posts nothing and the run stays Unpaid', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const run = await newRun(t, [a.employeeId]);
    await finalise(t, run.runId);
    const batch = await payOk<DisbursementBatchDTO>(await pay(t.officer, `/runs/${run.runId}/disbursement-batch`, { bankAccountId: t.bank.bankAccountId }), 201);
    const journals = await JournalEntry.countDocuments({ tenantId: t.tenantId });
    await t.officer.agent.get(`${API}/payroll/disbursements/${batch.batchId}/bank-file`).expect(200);
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId })).toBe(journals);
    expect((await payGet<PayrollRunDTO>(t, `/runs/${run.runId}`)).payoutStatus).toBe('UNPAID');
    expect(await DisbursementItem.countDocuments({ tenantId: t.tenantId, status: 'PAID' })).toBe(0);
  });

  it('INV-18: nothing moves silently across legal entities: every row carries the one entity, and another school\'s ids are unreachable', async () => {
    const { t, kid, bill } = await billed();
    const p = await collect(t, { method: 'CASH', amountPaise: money(4000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    const entity = (await mongoose.connection.db!.collection('finance_legal_entities').findOne({ tenantId: t.tenantId }))!;
    for (const name of ['journal_entries', 'journal_lines', 'collections', 'collection_allocations', 'finance_receipts', 'fee_documents', 'student_ledger_entries']) {
      expect(await mongoose.connection.db!.collection(name).countDocuments({ tenantId: t.tenantId, legalEntityId: { $ne: entity._id as never } }), name).toBe(0);
    }
    const f = await financeCtx(t.ctx);
    const other = await moneySchool();
    const foreign = (await getOk<{ accountId: string; code: string }[]>(other, '/chart-of-accounts')).find((a) => a.code === '5300')!.accountId;
    const mine = (await getOk<{ accountId: string; code: string }[]>(t, '/chart-of-accounts')).find((a) => a.code === '1020')!.accountId;
    await expect(withTransaction((db) => postJournal(f, db, { eventType: 'manual', sourceKey: 'inv18', accountingDate: today(), memo: 'x', lines: [{ accountId: foreign, debitPaise: 10 }, { accountId: mine, creditPaise: 10 }] }))).rejects.toMatchObject({ code: 'ACCOUNT_NOT_POSTABLE' });
    expect((await other.agent.get(`${API}/finance/collections/${p.collection.collectionId}`)).status).toBe(404);
    void PayrollRunLine; void addActiveEmployee;
  });
});

// ───────────────────────────────────────────────────────────── item 57: classification, isolation, bundles

import { FINANCE_OPS_DATA_CLASSIFICATION, SYSTEM_FIELDS } from '@shared';
import * as collectionModels from '../src/modules/finance/collections/models';
import * as bankingModels from '../src/modules/finance/banking/models';
import * as payrollModels from '../src/modules/finance/payroll/models';
import * as accountingModels from '../src/modules/finance/accounting/models';
import { staffWith, put } from './finance-helpers';

describe('classification, isolation and bundles (item 57)', () => {
  const businessPaths = (schema: { paths: Record<string, unknown> }) => [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]!))].filter((p) => !(SYSTEM_FIELDS as readonly string[]).includes(p));

  it('SEC-FIN-04: every stored field of every Part 3 collection has a class, nothing in the map is stale, and salary and files are never plain internal data', () => {
    const c = collectionModels;
    const b = bankingModels;
    const p = payrollModels;
    const a = accountingModels;
    const cases: Record<string, { schema: { paths: Record<string, unknown> } }> = {
      payment_claim: c.PaymentClaim, collection: c.Collection, collection_allocation: c.CollectionAllocation, finance_receipt: c.Receipt, finance_receipt_cancellation: c.ReceiptCancellation, refund_request: c.RefundRequest, refund_disbursement: c.RefundDisbursement,
      cashier_shift: c.CashierShift, cash_movement: c.CashMovement, cash_deposit_batch: c.CashDepositBatch, bank_statement_mapping: b.BankStatementMapping, bank_statement_import: b.BankStatementImport, bank_statement_line: b.BankStatementLine, reconciliation_match: b.ReconciliationMatch,
      payroll_policy: p.PayrollPolicy, salary_component: p.SalaryComponent, salary_structure: p.SalaryStructure, salary_structure_version: p.SalaryStructureVersion, employee_compensation: p.Compensation, salary_revision: p.SalaryRevision, payroll_input: p.PayrollInput,
      statutory_rule: p.StatutoryRule, tax_declaration: p.TaxDeclaration, employee_advance: p.Advance, payroll_run: p.PayrollRun, payroll_run_employee: p.PayrollRunEmployee, payroll_run_line: p.PayrollRunLine, employee_payslip: p.Payslip, payslip_publication: p.PayslipPublication,
      payroll_disbursement_batch: p.DisbursementBatch, payroll_disbursement_item: p.DisbursementItem, expense_category: a.ExpenseCategory, finance_vendor: a.Vendor, tax_line: a.TaxLine, expense_record: a.Expense, vendor_bill: a.VendorBill, vendor_payment: a.VendorPayment,
      gst_payment_record: a.GstPayment, opening_balance_batch: a.OpeningBatch, finance_close_run: a.CloseRun,
    };
    for (const [entity, model] of Object.entries(cases)) expect(businessPaths(model.schema).sort(), entity).toEqual(Object.keys((FINANCE_OPS_DATA_CLASSIFICATION as Record<string, Record<string, string>>)[entity]!).sort());
    expect(Object.keys(cases)).toHaveLength(Object.keys(FINANCE_OPS_DATA_CLASSIFICATION).length);
    const map = FINANCE_OPS_DATA_CLASSIFICATION as unknown as Record<string, Record<string, string>>;
    for (const field of ['grossPaise', 'deductionsPaise', 'netPaise']) expect(map.payroll_run_employee![field]).toBe('RESTRICTED');
    expect(map.employee_payslip!.snapshot).toBe('RESTRICTED');
    expect(map.employee_compensation!.basicPaise).toBe('RESTRICTED');
    expect(map.finance_vendor!.bankAccountEnc).toBe('RESTRICTED');
    expect(map.payment_claim!.proofKey).toBe('SECRET');
    expect(map.bank_statement_import!.fileKey).toBe('SECRET');
    expect(map.collection!.amountPaise).toBe('PERSONAL');
  });

  it('SEC-FIN-05: another school\'s ids answer 404 on every Part 3 area, and a campus outside the scope answers 403', async () => {
    const { t, kid, bill } = await billed();
    const paid = await collect(t, { method: 'CASH', amountPaise: money(1000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(1000) }] });
    const other = await moneySchool();
    const checks = [
      `/finance/collections/${paid.collection.collectionId}`, `/finance/receipts/${paid.receipt!.receiptId}`, `/finance/students/${kid.studentId}/clearance`, `/finance/cashier-shifts/mine`,
    ];
    for (const path of checks.slice(0, 3)) expect((await other.agent.get(`${API}${path}`)).status, path).toBe(404);
    expect((await other.agent.get(`${API}/finance/payment-claims`).expect(200)).body.data.total).toBe(0);
    expect((await other.agent.get(`${API}/finance/collections`).expect(200)).body.data.total).toBe(0);
    expect((await other.agent.get(`${API}/payroll/runs`).expect(200)).body.data.total).toBe(0);
    expect((await other.agent.get(`${API}/finance/vendors`).expect(200)).body.data).toEqual([]);
    // a Chandigarh-only accountant cannot reach a Mohali student's money (403), and gets none of it in lists
    const chd = await staffWith(t, ['ACCOUNTANT', 'COLLECTOR'], { primaryLocationId: t.chd.locationId });
    expect((await chd.agent.get(`${API}/finance/students/${kid.studentId}/clearance`)).status).toBe(403);
    expect((await chd.agent.post(`${API}/finance/collections`).set('Idempotency-Key', key()).send({ method: 'UPI', amountPaise: 100, reference: 'X1', allocations: [{ studentId: kid.studentId, amountPaise: 100 }] })).status).toBe(403);
    expect((await chd.agent.get(`${API}/finance/collections`).expect(200)).body.data.total).toBe(0);
  });

  it('SEC-FIN-06: taking a finance bundle away works on the very next request', async () => {
    const { t, kid } = await billed();
    const login = await staffWith(t, ['COLLECTOR', 'ACCOUNTANT']);
    expect((await login.agent.get(`${API}/finance/collections`)).status).toBe(200);
    expect((await login.agent.post(`${API}/finance/expenses`).send({})).status).toBe(400); // allowed in: only the body is wrong
    await put(t, `/access/users/${login.userId}`, { bundles: ['COLLECTOR'] }).expect(200);
    expect((await login.agent.post(`${API}/finance/expenses`).send({})).status).toBe(403);
    expect((await login.agent.get(`${API}/finance/reconciliation/exceptions?bankAccountId=${t.bank.bankAccountId}`)).status).toBe(403);
    await put(t, `/access/users/${login.userId}`, { bundles: [] }).expect(200);
    expect((await login.agent.get(`${API}/finance/collections`)).status).toBe(403);
    expect((await login.agent.get(`${API}/finance/students/${kid.studentId}/clearance`)).status).toBe(403);
  });
});
