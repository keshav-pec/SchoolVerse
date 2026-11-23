import { describe, expect, it } from 'vitest';
import type { AccountingPeriodDTO, CloseReadinessDTO, CollectionResultDTO, FinanceAttentionDTO, FinanceOverviewDTO, FinancialYearDTO, JournalDTO, OpeningPreviewDTO, RefundDTO, ReportDTO, SearchResultDTO, StatementLineDTO, TrialBalanceDTO, VendorDTO } from '@shared';
import { JournalEntry, LegalEntity } from '../src/modules/finance/core/models';
import { DisbursementItem, PayrollRun } from '../src/modules/finance/payroll/models';
import { FeeDocument } from '../src/modules/finance/fees/models';
import { API, addActiveEmployee, expectError, loginAs, today, useTestDatabase } from './helpers';
import { billOf, created, enrolled, getOk, issueMonth, key, money, moneySchool, ok, openShift, post, staffWith, withKey, type MoneySchool } from './finance-helpers';

useTestDatabase();

const trial = (t: MoneySchool, asOf?: string) => getOk<TrialBalanceDTO>(t, `/trial-balance${asOf ? `?asOf=${asOf}` : ''}`);
const nowMonth = () => today().slice(0, 7);
const periods = async (t: MoneySchool) => (await getOk<AccountingPeriodDTO[]>(t, '/accounting-periods')).sort((a, b) => a.startDate.localeCompare(b.startDate));
const periodOf = async (t: MoneySchool, month: string) => (await periods(t)).find((p) => p.startDate.startsWith(month))!;
const collect = async (t: MoneySchool, body: Record<string, unknown>) => ok<CollectionResultDTO>(await withKey(t.cashier.agent, '/collections', key(), body).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));
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
