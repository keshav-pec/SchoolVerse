import { describe, expect, it } from 'vitest';
import type { AdjustmentResultDTO, AutoMatchResultDTO, ClaimDTO, CloseReadinessDTO, CollectionResultDTO, ConcessionPolicyDTO, ConcessionSuggestionDTO, DisbursementBatchDTO, ExpenseDTO, FamilyDTO, FeeDocumentDTO, PayrollRunDTO, ReportDTO, RunExceptionsDTO, ShiftDTO, StudentAccountDTO, TrialBalanceDTO } from '@shared';
import { StudentGuardianLink } from '../src/modules/students/student.models';
import { API, nextPhone, today, useTestDatabase } from './helpers';
import { MONTH, calc, newRun, pay, payGet, payOk, payPut, payrollSchool, worker } from './finance-payroll-helpers';
import { billOf, created, enrolled, getOk, issueMonth, key, money, ok, openShift, post, withKey } from './finance-helpers';

useTestDatabase();

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
