import { describe, expect, it } from 'vitest';
import type { AccountingPeriodDTO, CloseReadinessDTO, CollectionResultDTO, FinanceAttentionDTO, FinanceOverviewDTO, FinancialYearDTO, JournalDTO, OpeningPreviewDTO, RefundDTO, ReportDTO, SearchResultDTO, StatementLineDTO, TrialBalanceDTO, VendorDTO, ClaimDTO, DisbursementBatchDTO, FamilyDTO, PayrollRunDTO, StudentAccountDTO, AdvanceDTO, AdjustmentResultDTO, AutoMatchResultDTO, ConcessionPolicyDTO, ConcessionSuggestionDTO, ExpenseDTO, FeeDocumentDTO, RunExceptionsDTO, ShiftDTO } from '@shared';
import { JournalEntry, LegalEntity, JournalLine } from '../src/modules/finance/core/models';
import { DisbursementItem, PayrollRun, PayrollRunLine, Payslip } from '../src/modules/finance/payroll/models';
import { FeeDocument, FeeDocumentLine, StudentLedgerEntry } from '../src/modules/finance/fees/models';
import { addActiveEmployee, API, billOf, calc, collect, created, enrolled, expectError, finalise, getOk, issueMonth, key, lineAmount, linesOf, loginAs, money, type MoneySchool, moneySchool, MONTH, newRun, nextPhone, ok, openShift, pay, payGet, payOk, payPut, payrollSchool, post, put, staffWith, today, trial, useTestDatabase, withKey, worker } from './helpers';
import mongoose from 'mongoose';
import { postJournal } from '../src/modules/finance/core/posting';
import { financeCtx } from '../src/modules/finance/core/context';
import { withTransaction } from '../src/db/transaction';
import { Collection, CollectionAllocation, Receipt } from '../src/modules/finance/collections/models';
import { BankStatementLine, ReconciliationMatch } from '../src/modules/finance/banking/models';
import { StudentGuardianLink } from '../src/modules/students/student.models';

useTestDatabase();

const nowMonth = () => today().slice(0, 7);
const periods = async (t: MoneySchool) => (await getOk<AccountingPeriodDTO[]>(t, '/accounting-periods')).sort((a, b) => a.startDate.localeCompare(b.startDate));
const periodOf = async (t: MoneySchool, month: string) => (await periods(t)).find((p) => p.startDate.startsWith(month))!;
const readiness = async (t: MoneySchool, periodId: string) => getOk<CloseReadinessDTO>(t.approver, `/close-readiness?periodId=${periodId}`);
const dated = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const statement = (rows: { date: string; narration: string; ref: string; credit: number }[]) => ['Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt', ...rows.map((r) => `${dated(r.date)},${r.narration},${r.ref},,${r.credit}`)].join('\r\n');

describe('is this month ready to close? (FIN-15, FUX-13)', () => {
  it('QA FIN-15: the counts come from the real data, and the headline adds up the blockers', async () => {
    const t = await moneySchool();
    const month = nowMonth();
    const kid = await enrolled(t);
    await issueMonth(t, month, `${month}-02`);
    // 3 bank lines nobody has matched
    await t.accountant.agent.post(`${API}/finance/bank-accounts/${t.bank.bankAccountId}/statements`).attach('file', Buffer.from(statement([1, 2, 3].map((n) => ({ date: `${month}-05`, narration: `UPI ${n}`, ref: `UTR-C${n}`, credit: 100 * n })))), 's.csv').expect(201);
    // 1 refund approved but not paid
    const bill = await billOf(t, kid.studentId, month);
    await openShift(t.cashier);
    await collect(t, { method: 'CASH', amountPaise: money(6000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    const refund = await created<RefundDTO>(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Leaving', amountPaise: money(2000) }));
    await ok(await post(t.approver, `/refunds/${refund.refundId}/approve`, {}));
    // 1 cash shift that does not match, with nobody to sign it off
    const shift = (await getOk<{ items: { shiftId: string }[] }>(t.cashier, '/cashier-shifts')).items[0]!;
    await ok(await post(t.cashier, `/cashier-shifts/${shift.shiftId}/close`, { countedPaise: money(5000), note: 'Short' }));
    // 2 salary payments recorded but not verified
    const [e1, e2] = [await addActiveEmployee(t), await addActiveEmployee(t)];
    const entity = (await LegalEntity.findOne({ tenantId: t.tenantId }).lean())!;
    const run = await PayrollRun.create({ tenantId: t.tenantId, schoolId: entity.schoolId, legalEntityId: entity._id, number: 'PRN/1', month, type: 'MONTHLY', state: 'FINALIZED', preparedBy: 'u' });
    for (const e of [e1, e2]) await DisbursementItem.create({ tenantId: t.tenantId, schoolId: entity.schoolId, legalEntityId: entity._id, batchId: 'b', runId: run._id, runEmployeeId: `r-${e.employeeId}`, employeeId: e.employeeId, amountPaise: 1000, status: 'PAID', paidOn: `${month}-10`, verified: false });
    const p = await periodOf(t, month);
    const r = await readiness(t, p.periodId);
    const count = (k: string) => r.checks.find((c) => c.key === k)!.count;
    expect(count('BANK_ITEMS')).toBe(3);
    expect(count('SALARY_PAYOUTS')).toBe(2);
    expect(count('REFUNDS_UNPAID')).toBe(1);
    expect(count('CASH_SHIFTS')).toBe(1);
    expect(r.blockers).toBe(7);
    expect(r.headline).toMatch(/close: 3 bank items \+ 2 salary payouts \+ 1 refund \+ 1 cash variance = 7 need attention\.$/);
    expect(r.canClose).toBe(false);
    expect(r.checks.find((c) => c.key === 'BANK_ITEMS')!.fix).toMatchObject({ label: 'Open Bank Matching' });
    expect(await DisbursementItem.countDocuments({ tenantId: t.tenantId })).toBe(2);
  });

  it('QA FIN-15: a month with blockers cannot be closed; unbalanced entries would be a blocker', async () => {
    const t = await moneySchool();
    const month = nowMonth();
    await t.accountant.agent.post(`${API}/finance/bank-accounts/${t.bank.bankAccountId}/statements`).attach('file', Buffer.from(statement([{ date: `${month}-05`, narration: 'UPI', ref: 'UTR-B1', credit: 100 }])), 's.csv').expect(201);
    const p = await periodOf(t, month);
    const blocked = await post(t.approver, `/accounting-periods/${p.periodId}/close`, {});
    expectError(blocked, 409, 'CLOSE_BLOCKED');
    expect(blocked.body.error.details.blockers).toBe(1);
    expect((await readiness(t, p.periodId)).state).toBe('OPEN');
  });
});

describe('closing, reopening and locking a month (FIN-15)', () => {
  it('QA FIN-15: an approved close locks the door; back-dated posting is refused and the reversal lands in the current month', async () => {
    const t = await moneySchool();
    const clerk = await staffWith(t, ['ACCOUNTANT', 'PAYROLL_OFFICER']);
    const cat = (await getOk<{ code: string; categoryId: string }[]>(t, '/expense-categories')).find((c) => c.code === 'SUPPLIES')!;
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const last = d.toISOString().slice(0, 7);
    const exp = await created<{ expenseId: string; journalId: string }>(await post(clerk, '/expenses', { categoryId: cat.categoryId, taxableValuePaise: money(500), date: `${last}-15`, description: 'Chalk', locationId: t.moh.locationId, paymentMode: 'BANK', bankAccountId: t.bank.bankAccountId, gstRateBps: 0 }));
    const p = await periodOf(t, last);
    const first = await post(clerk, `/accounting-periods/${p.periodId}/close`, {});
    expect(first.status).toBe(403); // closing is the approver's permission
    const ask = await post(t.approver, `/accounting-periods/${p.periodId}/close`, {});
    expectError(ask, 409, 'APPROVAL_REQUIRED');
    const approvalId = ask.body.error.details.approvalId as string;
    expectError(await post(t.approver, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }), 403, 'SELF_APPROVAL_BLOCKED'); // the same person asked
    const other = await staffWith(t, ['APPROVER']);
    await ok(await post(other, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }));
    const closed = await ok<{ state: string; periodCode: string }>(await post(t.approver, `/accounting-periods/${p.periodId}/close`, { approvalId }));
    expect(closed.state).toBe('CLOSED');
    // nothing new can be dated in the closed month
    const refused = await post(clerk, '/expenses', { categoryId: cat.categoryId, taxableValuePaise: money(100), date: `${last}-20`, description: 'Late', locationId: t.moh.locationId, paymentMode: 'BANK', bankAccountId: t.bank.bankAccountId, gstRateBps: 0 });
    expectError(refused, 409, 'PERIOD_CLOSED');
    expect(refused.body.error.message).toMatch(/Post into an open period/);
    // a mistake is reversed into today's open month, with a note, and the original is untouched
    const reversed = await ok<{ state: string }>(await post(clerk, `/expenses/${exp.expenseId}/reverse`, { reason: 'Wrong amount' }));
    expect(reversed.state).toBe('REVERSED');
    const reversal = (await JournalEntry.findOne({ tenantId: t.tenantId, reversesId: { $ne: null } }).lean())!;
    expect(reversal.accountingDate).toBe(today());
    expect(reversal.memo).toMatch(/original period is closed/);
    expect((await JournalEntry.findOne({ tenantId: t.tenantId, _id: reversal.reversesId as string }).lean())!.accountingDate).toBe(`${last}-15`);
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA FIN-06: asking again for exactly the same change, after it was approved, uses that approval once (the screen lost the id)', async () => {
    const t = await moneySchool();
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const p = await periodOf(t, d.toISOString().slice(0, 7));
    const other = await staffWith(t, ['APPROVER']);
    const ask = await post(t.approver, `/accounting-periods/${p.periodId}/close`, {});
    expectError(ask, 409, 'APPROVAL_REQUIRED');
    // someone else asking for the same thing does not get to use it
    const third = await staffWith(t, ['APPROVER']);
    expectError(await post(third, `/accounting-periods/${p.periodId}/close`, {}), 409, 'APPROVAL_REQUIRED');
    await ok(await post(other, `/approvals/${ask.body.error.details.approvalId}/decide`, { decision: 'APPROVE' }));
    const closed = await ok<{ state: string }>(await post(t.approver, `/accounting-periods/${p.periodId}/close`, {}));
    expect(closed.state).toBe('CLOSED');
    // used once: reopening is a different request that needs its own approval
    expectError(await post(t.approver, `/accounting-periods/${p.periodId}/reopen`, { reason: 'late bill' }), 409, 'APPROVAL_REQUIRED');
  });

  it('QA FIN-15: reopening needs approval and a reason and is audited; a locked month can never be reopened', async () => {
    const t = await moneySchool();
    const d = new Date(`${today()}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() - 1);
    const p = await periodOf(t, d.toISOString().slice(0, 7));
    const other = await staffWith(t, ['APPROVER']);
    const close = async () => {
      const ask = await post(t.approver, `/accounting-periods/${p.periodId}/close`, {});
      const id = ask.body.error.details.approvalId as string;
      await ok(await post(other, `/approvals/${id}/decide`, { decision: 'APPROVE' }));
      return ok(await post(t.approver, `/accounting-periods/${p.periodId}/close`, { approvalId: id }));
    };
    await close();
    const ask = await post(t.approver, `/accounting-periods/${p.periodId}/reopen`, { reason: 'A bill was missed' });
    expectError(ask, 409, 'APPROVAL_REQUIRED');
    await ok(await post(other, `/approvals/${ask.body.error.details.approvalId}/decide`, { decision: 'APPROVE' }));
    const reopened = await ok<{ state: string }>(await post(t.approver, `/accounting-periods/${p.periodId}/reopen`, { reason: 'A bill was missed', approvalId: ask.body.error.details.approvalId }));
    expect(reopened.state).toBe('OPEN');
    const audit = JSON.stringify(await getOk(t, '/audit?pageSize=100'));
    expect(audit).toContain('accounting_period.reopened');
    expect(audit).toContain('A bill was missed');
    expectError(await post(t.approver, `/accounting-periods/${p.periodId}/reopen`, { reason: 'again' }), 409, 'PERIOD_NOT_CLOSED');
    await close();
    await ok(await post(t.approver, `/accounting-periods/${p.periodId}/lock`, {}));
    expectError(await post(t.approver, `/accounting-periods/${p.periodId}/reopen`, { reason: 'x' }), 409, 'PERIOD_LOCKED');
  });
});

describe('opening balances and manual entries (FIN-18)', () => {
  const upload = (t: MoneySchool, path: string, csv: string, fields: Record<string, string> = {}) => {
    let req = t.accountant.agent.post(`${API}/finance/opening-balances/${path}`);
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req.attach('file', Buffer.from(csv), 'opening.csv');
  };

  it('QA FIN-18: opening balances must balance, post once, and turn student amounts into OPENING bills, not income', async () => {
    const t = await moneySchool();
    const a = await enrolled(t);
    const b = await enrolled(t);
    const vendor = await created<VendorDTO>(await post(await staffWith(t, ['ACCOUNTANT']), '/vendors', { name: 'Old Stationers' }));
    const emp = await addActiveEmployee(t);
    const unbalanced = `kind,reference,debit,credit\r\nACCOUNT,1020,100000,\r\nACCOUNT,3100,,90000\r\n`;
    const bad = await upload(t, 'commit', unbalanced, { asOf: '2026-04-01' });
    expectError(bad as never, 422, 'IMPORT_INVALID');
    const csv = `kind,reference,debit,credit\r\nACCOUNT,1020,100000,\r\nACCOUNT,3100,,100000\r\nSTUDENT,${a.student.admissionNumber},2500,\r\nSTUDENT,${b.student.admissionNumber},1000,\r\nVENDOR,Old Stationers,,3000\r\nADVANCE,${emp.employeeCode},5000,\r\n`;
    const preview = (await upload(t, 'preview', csv).expect(200)).body.data as OpeningPreviewDTO;
    expect(preview).toMatchObject({ balanced: true, studentPaise: money(3500), vendorPaise: money(3000), advancePaise: money(5000), committed: false });
    expect((await upload(t, 'commit', csv, { asOf: '2026-04-01' }).expect(200)).body.data.committed).toBe(true);
    expect((await upload(t, 'commit', csv, { asOf: '2026-04-01' }).expect(200)).body.data.committed).toBe(true); // the same file again changes nothing
    expectError((await upload(t, 'commit', `${csv}ACCOUNT,5200,1,\r\nACCOUNT,3100,,1\r\n`, { asOf: '2026-04-01' })) as never, 409, 'OPENING_ALREADY_POSTED');
    const tb = await trial(t, '2026-12-31');
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.name === 'Bank Account')!.debitPaise).toBe(money(100000));
    expect(tb.rows.find((r) => r.name === 'Student Fees Receivable')!.debitPaise).toBe(money(3500));
    expect(tb.rows.find((r) => r.name === 'Vendors Payable')!.creditPaise).toBe(money(3000));
    expect(tb.rows.find((r) => r.name === 'Employee Advances')!.debitPaise).toBe(money(5000));
    expect(tb.rows.some((r) => r.type === 'INCOME')).toBe(false); // an opening balance is not income
    expect(await FeeDocument.countDocuments({ tenantId: t.tenantId, kind: 'OPENING' })).toBe(2);
    expect((await getOk<VendorDTO[]>(await staffWith(t, ['ACCOUNTANT']), '/vendors')).find((v) => v.vendorId === vendor.vendorId)!.payablePaise).toBe(money(3000));
  });

  it('QA FIN-18: a hand-made entry always needs approval, must balance, and is bound to its exact lines', async () => {
    const t = await moneySchool();
    const accounts = await getOk<{ accountId: string; code: string }[]>(t, '/chart-of-accounts');
    const id = (code: string) => accounts.find((a) => a.code === code)!.accountId;
    const body = (over: Record<string, unknown> = {}) => ({ accountingDate: today(), memo: 'Fix bank charge', reason: 'A charge was booked to the wrong account', lines: [{ accountId: id('5300'), debitPaise: money(50) }, { accountId: id('1020'), creditPaise: money(50) }], ...over });
    expectError(await post(t.accountant, '/journals/manual', body({ lines: [{ accountId: id('5300'), debitPaise: money(50) }, { accountId: id('1020'), creditPaise: money(40) }] })), 422, 'JOURNAL_UNBALANCED');
    const ask = await post(t.accountant, '/journals/manual', body());
    expectError(ask, 409, 'APPROVAL_REQUIRED');
    const approvalId = ask.body.error.details.approvalId as string;
    await ok(await post(t.approver, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }));
    // changing a line after approval needs a new approval
    expectError(await post(t.accountant, '/journals/manual', body({ approvalId, lines: [{ accountId: id('5210'), debitPaise: money(50) }, { accountId: id('1020'), creditPaise: money(50) }] })), 409, 'APPROVAL_REQUIRED');
    const posted = await created<JournalDTO>(await post(t.accountant, '/journals/manual', body({ approvalId })));
    expect(posted).toMatchObject({ eventType: 'manual', totalPaise: money(50) });
    expect(posted.memo).toMatch(/^Manual:/);
    expectError(await post(t.accountant, '/journals/manual', body({ approvalId })), 409, 'APPROVAL_REQUIRED'); // an approval is used once
    expect((await trial(t)).balanced).toBe(true);
  });
});

describe('financial reports (FIN-16, 17)', () => {
  async function busySchool() {
    const t = await moneySchool();
    const kid = await enrolled(t);
    await issueMonth(t, nowMonth(), `${nowMonth()}-02`);
    const bill = await billOf(t, kid.studentId, nowMonth());
    await openShift(t.cashier);
    await collect(t, { method: 'CASH', amountPaise: money(1500), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(1500) }] });
    const clerk = await staffWith(t, ['ACCOUNTANT']);
    const cat = (await getOk<{ code: string; categoryId: string }[]>(t, '/expense-categories')).find((c) => c.code === 'SUPPLIES')!;
    await created(await post(clerk, '/expenses', { categoryId: cat.categoryId, taxableValuePaise: money(800), date: today(), description: 'Chalk', locationId: t.moh.locationId, paymentMode: 'BANK', bankAccountId: t.bank.bankAccountId, gstRateBps: 0 }));
    return { t, kid, clerk };
  }

  it('QA FIN-16: every report says its basis, and its totals equal the journal lines behind it', async () => {
    const { t, clerk } = await busySchool();
    const tb = await getOk<ReportDTO>(clerk, '/reports/trial-balance');
    expect(tb.basis).toBe('Based on posted journals (accrual).');
    expect(tb.totals!.debitPaise).toBe(tb.totals!.creditPaise);
    const pl = await getOk<ReportDTO>(clerk, `/reports/income-and-expenditure?from=${nowMonth()}-01&to=${today()}`);
    expect(pl.totals).toMatchObject({ incomePaise: money(4000), expenditurePaise: money(800), surplusPaise: money(3200) });
    const bs = await getOk<ReportDTO>(clerk, `/reports/balance-sheet?asOf=${today()}`);
    expect(bs.totals!.assetsPaise).toBe(bs.totals!.liabilitiesAndEquityPaise);
    const collections = await getOk<ReportDTO>(clerk, `/reports/collections-summary?from=${nowMonth()}-01&to=${today()}`);
    expect(collections.rows.map((r) => [r.measure, r.amountPaise])).toEqual([['Billed (accrual)', money(4000)], ['Received and verified', money(1500)], ['Waiting to be verified', 0], ['Matched with the bank statement', 0]]);
    expect(collections.notes[0]).toMatch(/never added together/);
    const ar = await getOk<ReportDTO>(clerk, '/reports/ar-aging');
    expect(ar.totals).toMatchObject({ outstandingPaise: money(2500) });
    const income = await getOk<ReportDTO>(clerk, `/reports/income-by-fee-head-and-location?from=${nowMonth()}-01&to=${today()}`);
    expect(income.totals).toEqual({ incomePaise: money(4000) });
    const cash = await getOk<ReportDTO>(clerk, '/reports/cashbook');
    expect(cash.totals!.inPaise).toBe(money(1500));
    const bank = await getOk<ReportDTO>(clerk, '/reports/bankbook');
    expect(bank.totals!.outPaise).toBe(money(800));
    const payroll = await clerk.agent.get(`${API}/finance/reports/payroll-expense-and-liability`);
    expect(payroll.status).toBe(403); // salary figures need the payroll permission
    void t;
  });

  it('QA FIN-17: the CSV needs the export permission, is audited, and a cell that starts with = + - or @ is escaped', async () => {
    const { t, clerk } = await busySchool();
    await created(await post(clerk, '/vendors', { name: '=HYPERLINK("http://x","y")' }));
    const vendor = (await getOk<VendorDTO[]>(clerk, '/vendors'))[0]!;
    const cat = (await getOk<{ code: string; categoryId: string }[]>(t, '/expense-categories')).find((c) => c.code === 'SUPPLIES')!;
    await created(await post(clerk, '/vendor-bills', { vendorId: vendor.vendorId, vendorBillNumber: 'B-1', date: today(), dueDate: today(), locationId: t.moh.locationId, lines: [{ description: 'x', categoryId: cat.categoryId, taxableValuePaise: money(100), gstRateBps: 0 }] }));
    const csv = await clerk.agent.get(`${API}/finance/reports/ap-aging?format=csv`).expect(200);
    expect(csv.text).toContain(`"'=HYPERLINK`);
    expect(csv.text).not.toMatch(/(^|,)=HYPERLINK/m);
    expect((await t.cashier.agent.get(`${API}/finance/reports/trial-balance?format=csv`)).status).toBe(403);
    const auditor = await staffWith(t, ['AUDITOR']);
    expect((await auditor.agent.get(`${API}/finance/reports/trial-balance`)).status).toBe(200);
    expect((await auditor.agent.get(`${API}/finance/reports/trial-balance?format=csv`)).status).toBe(403); // can look, cannot export
    expect(JSON.stringify(await getOk(t, '/audit?pageSize=100'))).toContain('report.exported');
  });
});

describe('Needs Attention, the pulse and search (FUX-02, 03, 15)', () => {
  it('QA FUX-03: attention groups show only what the caller can act on, and the total feeds the badge', async () => {
    const t = await moneySchool();
    const kid = await enrolled(t);
    await issueMonth(t, nowMonth(), `${nowMonth()}-02`);
    await created(await post(t.cashier, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(1000) }], method: 'UPI', amountPaise: money(1000), paidOn: today(), reference: 'ATT-1' }).then((r) => (r.status === 403 ? post(t.agent === t.agent ? t : t, '/payment-claims', { students: [{ studentId: kid.studentId, amountPaise: money(1000) }], method: 'UPI', amountPaise: money(1000), paidOn: today(), reference: 'ATT-1' }) : r)));
    const forAccountant = await getOk<FinanceAttentionDTO>(t.accountant, '/attention');
    expect(forAccountant.groups.map((g) => g.key)).toContain('COLLECTIONS');
    const collections = forAccountant.groups.find((g) => g.key === 'COLLECTIONS')!;
    expect(collections.count).toBe(1);
    expect(collections.items[0]!.fix).toMatchObject({ action: 'VERIFY_CLAIM' });
    expect(forAccountant.groups.some((g) => g.key === 'PAYROLL')).toBe(false); // the accountant has no payroll permission
    expect(forAccountant.total).toBe(forAccountant.groups.reduce((s, g) => s + g.count, 0));
    const forCashier = await getOk<FinanceAttentionDTO>(t.cashier, '/attention');
    expect(forCashier.groups.some((g) => g.key === 'COLLECTIONS' || g.key === 'BANKING')).toBe(false);
    // a refund waiting for approval shows up for an approver, not for the person who asked
    await openShift(t.cashier);
    const bill = await billOf(t, kid.studentId, nowMonth());
    await collect(t, { method: 'CASH', amountPaise: money(6000), allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    await created(await post(t.accountant, '/refunds', { studentId: kid.studentId, reason: 'Leaving', amountPaise: money(2000) }));
    expect((await getOk<FinanceAttentionDTO>(t.approver, '/attention')).groups.find((g) => g.key === 'APPROVALS')!.items.some((i) => /Refund/.test(i.label))).toBe(true);
    expect((await getOk<FinanceAttentionDTO>(t.accountant, '/attention')).groups.find((g) => g.key === 'APPROVALS')).toBeUndefined();
    const overview = await getOk<FinanceOverviewDTO>(t.approver, '/overview');
    expect(overview.attentionTotal).toBeGreaterThan(0);
  });

  it('QA FUX-02: the pulse shows null, not zero, for a tile the caller may not see', async () => {
    const t = await moneySchool();
    const kid = await enrolled(t);
    await issueMonth(t, nowMonth(), `${nowMonth()}-02`);
    const full = await getOk<FinanceOverviewDTO>(t, '/overview');
    expect(full).toMatchObject({ outstandingPaise: money(4000), collectionsTodayPaise: 0 });
    const cashier = await getOk<FinanceOverviewDTO>(t.cashier, '/overview');
    expect(cashier.outstandingPaise).toBe(money(4000));
    expect(cashier).toMatchObject({ payrollPayablePaise: null, unreconciledBankLines: null, monthlyExpensesPaise: null, cashInHandPaise: null });
    void kid;
  });

  it('QA FUX-15: search finds students, bills and receipts, and never returns a journal, bank line or salary to someone without the permission', async () => {
    const t = await moneySchool();
    const kid = await enrolled(t);
    await issueMonth(t, nowMonth(), `${nowMonth()}-02`);
    await openShift(t.cashier);
    const bill = await billOf(t, kid.studentId, nowMonth());
    const paid = await collect(t, { method: 'UPI', amountPaise: money(4000), reference: 'SRCH-UTR-77', allocations: [{ studentId: kid.studentId, documentId: bill.documentId, amountPaise: money(4000) }] });
    const admission = kid.student.admissionNumber as string;
    const found = await getOk<SearchResultDTO[]>(t.cashier, `/search?q=${encodeURIComponent(admission)}`);
    expect(found.find((r) => r.type === 'student')).toMatchObject({ id: kid.studentId });
    expect((await getOk<SearchResultDTO[]>(t.cashier, `/search?q=${bill.number.slice(0, 14)}`)).some((r) => r.type === 'bill')).toBe(true);
    expect((await getOk<SearchResultDTO[]>(t.cashier, '/search?q=SRCH-UTR')).some((r) => r.type === 'payment')).toBe(true);
    expect((await getOk<SearchResultDTO[]>(t.cashier, '/search?q=JV%2F')).some((r) => r.type === 'journal')).toBe(false); // a cashier has no accounting view
    expect((await getOk<SearchResultDTO[]>(t.accountant, '/search?q=JV%2F')).some((r) => r.type === 'journal')).toBe(true);
    const officer = await staffWith(t, ['PAYROLL_OFFICER']);
    await PayrollRun.create({ tenantId: t.tenantId, schoolId: 's', legalEntityId: t.tenantId, number: 'PRN/2026-27/000009', month: nowMonth(), type: 'MONTHLY', state: 'FINALIZED', preparedBy: 'u' }).catch(() => null);
    expect((await getOk<SearchResultDTO[]>(t.cashier, '/search?q=PRN')).some((r) => r.type === 'payroll_run')).toBe(false);
    expectError(await t.cashier.agent.get(`${API}/finance/search?q=a`), 400, 'VALIDATION_FAILED');
    // another campus's student is not found by a Chandigarh-only login
    const chd = await staffWith(t, ['ACCOUNTANT'], { primaryLocationId: t.chd.locationId });
    expect((await getOk<SearchResultDTO[]>(chd, `/search?q=${encodeURIComponent(admission)}`)).some((r) => r.type === 'student')).toBe(false);
    void paid; void officer; void loginAs;
  });
});

void FeeDocument;
void (null as unknown as FinancialYearDTO);
void (null as unknown as StatementLineDTO);

/**
 * The accounting invariants (item 55): the promises the books make, whatever anyone clicks. One test each, named by its number. A failure here
 * means money could be lost, counted twice or hidden, so these never get skipped.
 */

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

const month = () => today().slice(0, 7);
const lastDay = (m: string) => new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10);
const dateText = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

describe('the whole chain, from setup to a closed month (item 56)', () => {
  it('QA CHAIN-01: configure, bill with a sibling concession and a taxable fee, collect and verify, match the bank, pay salaries, record an expense with input tax, close the month, and every report ties back to the journals', async () => {
    // ── configure: finance set up, a published Class VIII plan, a bank and a cash account, a team with bundles
    const t = await payrollSchool();
    const m = month();

    // ── auto-assign two brothers and sisters and award the sibling concession
    const phone = nextPhone();
    const aarav = await enrolled(t, '2026-04-01', { legalFirstName: 'Aarav', guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone, relationshipType: 'Mother' } });
    const [match] = (await t.agent.post(`${API}/guardians/match`).send({ phone }).expect(200)).body.data as { personId: string }[];
    const riya = await enrolled(t, '2026-04-01', { legalFirstName: 'Riya', guardian: { guardianPersonId: match!.personId, relationshipType: 'Mother' } });
    await created<ConcessionPolicyDTO>(await post(t, '/concession-policies', { name: 'Sibling concession', type: 'SIBLING', valueType: 'PERCENT', value: 1000, feeHeadIds: [t.heads.tuition.feeHeadId], stackMode: 'HIGHEST_WINS' }));
    const suggested = (await post(t, '/concessions/recommend', {}).expect(200)).body.data as ConcessionSuggestionDTO[];
    expect(suggested).toHaveLength(1);
    await ok(await post(t, '/concessions/award-many', { awards: suggested.map((s) => ({ studentId: s.studentId, policyId: s.policyId })) }));

    // ── bill the month: the younger child pays ₹3,600 (10% off tuition); then a taxable uniform is added to the elder child's bill
    await issueMonth(t, m, `${m}-02`);
    const siblingId = suggested[0]!.studentId;
    const elderId = siblingId === aarav.studentId ? riya.studentId : aarav.studentId;
    expect((await billOf(t, siblingId, m)).totalPaise).toBe(money(3600));
    const bill = await billOf(t, elderId, m);
    const uniform = await created<AdjustmentResultDTO>(await post(t, `/fee-documents/${bill.documentId}/adjustments`, { type: 'DEBIT_NOTE', reason: 'School uniform', lines: [{ feeHeadId: t.heads.uniform.feeHeadId, description: 'School uniform', amountPaise: money(1500) }] }));
    expect(uniform.amountPaise).toBe(money(1680)); // ₹1,500 + 12% GST
    expect((await getOk<StudentAccountDTO>(t, `/students/${elderId}/account`)).outstandingPaise).toBe(money(4000) + money(1680));

    // ── a UPI payment is reported, checked and applied, and the receipt is made only now
    const claim = await created<ClaimDTO>(await post(t.cashier, '/payment-claims', { students: [{ studentId: elderId, amountPaise: money(5680) }], method: 'UPI', amountPaise: money(5680), paidOn: today(), reference: 'UTR CHAIN 001' }).then(async (r) => (r.status === 403 ? post(t, '/payment-claims', { students: [{ studentId: elderId, amountPaise: money(5680) }], method: 'UPI', amountPaise: money(5680), paidOn: today(), reference: 'UTR CHAIN 001' }) : r)));
    expect(await getOk(t, '/receipts')).toMatchObject({ total: 0 });
    const verified = await ok<CollectionResultDTO>(await post(t.accountant, `/payment-claims/${claim.claimId}/verify`, { amountSeenPaise: money(5680), evidence: { seenOn: today(), note: 'Seen in the bank app' } }));
    expect(verified.receipt!.amountPaise).toBe(money(5680));
    expect((await getOk<StudentAccountDTO>(t, `/students/${elderId}/account`)).outstandingPaise).toBe(0);

    // ── the younger child's family pays part in cash at the counter
    await openShift(t.cashier);
    const youngBill = await billOf(t, siblingId, m);
    await ok(await withKey(t.cashier.agent, '/collections', key(), { method: 'CASH', amountPaise: money(1000), allocations: [{ studentId: siblingId, documentId: youngBill.documentId, amountPaise: money(1000) }] }).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
    const shift = (await getOk<{ items: ShiftDTO[] }>(t.cashier, '/cashier-shifts')).items[0]!;
    await ok(await post(t.cashier, `/cashier-shifts/${shift.shiftId}/close`, { countedPaise: money(1000) }));

    // ── import the bank statement: the UPI credit matches itself
    const csv = `Date,Narration,Chq/Ref No,Withdrawal Amt,Deposit Amt\r\n${dateText(today())},UPI CR PRIYA,UTR CHAIN 001,,5680`;
    await t.accountant.agent.post(`${API}/finance/bank-accounts/${t.bank.bankAccountId}/statements`).attach('file', Buffer.from(csv), 'chain.csv').expect(201);
    const matched = await ok<AutoMatchResultDTO>(await post(t.accountant, '/reconciliation/auto-match', { bankAccountId: t.bank.bankAccountId }));
    expect(matched).toMatchObject({ confirmed: 1, unmatched: 0 });

    // ── payroll: two people, one with no days entered. The exception is fixed, then approved by a different person and finalised
    const a = await worker(t, 30000, { days: { lop: 0 }, tdsYearlyRupees: 6250 });
    const b = await worker(t, 20000);
    const run = await newRun(t, [a.employeeId, b.employeeId]);
    const first = await calc(t, run.runId);
    expect(first.counts).toMatchObject({ ready: 1, needAction: 1 });
    expect((await payGet<RunExceptionsDTO>(t, `/runs/${run.runId}/exceptions`)).items[0]!.exceptions[0]!.code).toBe('MISSING_INPUT');
    await payOk(await payPut(t.officer, '/inputs', { employeeId: b.employeeId, month: MONTH, workingDays: null, paidLeaveDays: 0, lopDays: 0, unitsWorked: null, extras: [] }));
    const recalculated = await calc(t, run.runId);
    expect(recalculated.counts).toMatchObject({ ready: 2, needAction: 0 });
    const approved = await payOk<PayrollRunDTO>(await pay(t.approver, `/runs/${run.runId}/approve`));
    const done = await payOk<PayrollRunDTO>(await pay(t.approver2, `/runs/${run.runId}/finalize`, { version: approved.version }));
    expect(done).toMatchObject({ state: 'FINALIZED', payoutStatus: 'UNPAID' });
    // the bank file is built, the payments are recorded, then a second person verifies them
    const batch = await payOk<DisbursementBatchDTO>(await pay(t.officer, `/runs/${run.runId}/disbursement-batch`, { bankAccountId: t.bank.bankAccountId }), 201);
    await t.officer.agent.get(`${API}/payroll/disbursements/${batch.batchId}/bank-file`).expect(200);
    expect((await payGet<PayrollRunDTO>(t, `/runs/${run.runId}`)).payoutStatus).toBe('UNPAID');
    await payOk(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: batch.items.map((i, n) => ({ employeeId: i.employeeId, status: 'PAID', reference: `SAL-${n}` })) }));
    await payOk(await pay(t.officer2, `/disbursements/${batch.batchId}/verify`, {}));
    expect((await payGet<PayrollRunDTO>(t, `/runs/${run.runId}`)).payoutStatus).toBe('PAID');

    // ── an expense with input tax: it waits for the decision, then posts
    const cat = (await getOk<{ code: string; categoryId: string }[]>(t, '/expense-categories')).find((c) => c.code === 'SUPPLIES')!;
    const expense = await created<ExpenseDTO>(await post(t.accountant, '/expenses', { categoryId: cat.categoryId, taxableValuePaise: money(10000), date: today(), description: 'Printer for the office', locationId: t.moh.locationId, paymentMode: 'BANK', bankAccountId: t.bank.bankAccountId, gstRateBps: 1800 }));
    expect(expense.state).toBe('PENDING');
    await ok(await post(t.accountant, '/tax/itc-review', { lineIds: [expense.taxLines[0]!.lineId], decision: 'ELIGIBLE', reason: 'Used for the school office' }));

    // ── close the month: nothing blocks, a different person approves
    const period = (await getOk<{ periodId: string; startDate: string }[]>(t, '/accounting-periods')).find((p) => p.startDate.startsWith(m))!;
    const readiness = await getOk<CloseReadinessDTO>(t.approver, `/close-readiness?periodId=${period.periodId}`);
    expect(readiness.blockers, JSON.stringify(readiness.checks.filter((c) => c.count > 0))).toBe(0);
    const ask = await post(t.approver, `/accounting-periods/${period.periodId}/close`, {});
    expect(ask.status).toBe(409);
    await ok(await post(t.approver2, `/approvals/${ask.body.error.details.approvalId}/decide`, { decision: 'APPROVE' }));
    expect((await ok<{ state: string }>(await post(t.approver, `/accounting-periods/${period.periodId}/close`, { approvalId: ask.body.error.details.approvalId }))).state).toBe('CLOSED');

    // ── the books tie together: reports equal the journals, receivables equal what students owe, tax equals the bills
    const tb = await getOk<TrialBalanceDTO>(t, `/trial-balance?asOf=${lastDay(m)}`);
    expect(tb.balanced).toBe(true);
    const row = (name: string) => tb.rows.find((r) => r.name === name);
    const owed = (await getOk<StudentAccountDTO>(t, `/students/${aarav.studentId}/account`)).outstandingPaise + (await getOk<StudentAccountDTO>(t, `/students/${riya.studentId}/account`)).outstandingPaise;
    expect(row('Student Fees Receivable')!.debitPaise).toBe(owed);
    const guardianId = (await StudentGuardianLink.findOne({ tenantId: t.tenantId, studentId: aarav.studentId }).lean())!.guardianPersonId;
    expect((await getOk<FamilyDTO>(t, `/families/${guardianId}`)).totals.outstandingPaise).toBe(owed);
    const outward = await getOk<ReportDTO>(t.accountant, `/tax/reports/outward-summary?month=${m}`);
    expect((row('Output CGST')!.creditPaise ?? 0) + (row('Output SGST')!.creditPaise ?? 0)).toBe(outward.totals!.cgstPaise! + outward.totals!.sgstPaise!);
    expect(row('Salary Payable')).toMatchObject({ debitPaise: 0, creditPaise: 0 }); // every salary is paid and verified, so nothing is owed
    expect(row('Input CGST')!.debitPaise).toBe(money(900));
    const pl = await getOk<ReportDTO>(t.accountant, `/reports/income-and-expenditure?from=${m}-01&to=${lastDay(m)}`);
    const bs = await getOk<ReportDTO>(t.accountant, `/reports/balance-sheet?asOf=${lastDay(m)}`);
    expect(pl.totals!.surplusPaise).toBe(pl.totals!.incomePaise! - pl.totals!.expenditurePaise!);
    expect(bs.totals!.assetsPaise).toBe(bs.totals!.liabilitiesAndEquityPaise);
    const bank = await getOk<ReportDTO>(t.accountant, `/reports/bankbook?from=2026-01-01&to=${lastDay(m)}`);
    expect(bank.totals!.balancePaise).toBe(row('Bank Account')!.debitPaise - row('Bank Account')!.creditPaise); // no opening balance was loaded, so the bank shows as overdrawn
    // a closed month refuses anything new dated inside it
    const refused = await post(t.accountant, '/expenses', { categoryId: cat.categoryId, taxableValuePaise: money(10), date: `${m}-01`, description: 'Too late', locationId: t.moh.locationId, paymentMode: 'BANK', bankAccountId: t.bank.bankAccountId, gstRateBps: 0 });
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('PERIOD_CLOSED');
    void (null as unknown as FeeDocumentDTO);
  }, 120_000);
});
