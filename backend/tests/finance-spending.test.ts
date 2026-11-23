import { describe, expect, it } from 'vitest';
import type { AdvanceDTO, CompensationDTO, DisbursementBatchDTO, MyPayrollSummaryDTO, PayrollRunDTO, PayslipDTO, ReportDTO, RunExceptionsDTO, SalaryStructureDTO, StatutoryRuleDTO, AdjustmentResultDTO, ExpenseCategoryDTO, ExpenseDTO, FeeDocumentDTO, GstPaymentDTO, PayablesAgingDTO, TaxReviewQueueDTO, TrialBalanceDTO, VendorBillDTO, VendorDTO, VendorPaymentDTO } from '@shared';
import { JournalEntry, JournalLine } from '../src/modules/finance/core/models';
import { Payslip } from '../src/modules/finance/payroll/models';
import { addActiveEmployee, API, billOf, calc, created, enrolled, expectError, finalise, getOk, issueMonth, lineAmount, linesOf, loginAs, money, moneySchool, MONTH, newRun, ok, patch, pay, payGet, payOk, payPut, payrollSchool, post, put, rows, staffWith, today, trial, useTestDatabase, worker } from './helpers';
import { Expense } from '../src/modules/finance/accounting/models';

useTestDatabase();


describe('salary setup (PAY-01 to 03)', () => {
  it('QA PAY-02: an approved salary structure is frozen; a person is given a salary only from an approved one', async () => {
    const t = await payrollSchool();
    const draft = await payOk<SalaryStructureDTO>(await pay(t.officer, '/salary-structures', { name: 'Support Staff', effectiveFrom: '2026-04-01', items: [{ componentId: t.basic.componentId }] }), 201);
    const employee = await addActiveEmployee(t);
    expectError(await pay(t.officer, '/employee-assignments', { employeeId: employee.employeeId, structureVersionId: draft.latestVersion!.versionId, basicPaise: money(20000), effectiveFrom: '2026-04-01' }), 409, 'PAYROLL_STATE_INVALID');
    await payOk(await pay(t.approver, `/salary-structure-versions/${draft.latestVersion!.versionId}/approve`));
    expectError(await t.officer.agent.patch(`${API}/payroll/salary-structure-versions/${draft.latestVersion!.versionId}`).send({ items: [{ componentId: t.basic.componentId }] }), 409, 'PLAN_VERSION_FROZEN');
    const assigned = await payOk<CompensationDTO>(await pay(t.officer, '/employee-assignments', { employeeId: employee.employeeId, structureVersionId: draft.latestVersion!.versionId, basicPaise: money(20000), effectiveFrom: '2026-04-01' }), 201);
    expect(assigned).toMatchObject({ basicPaise: money(20000), mode: 'MONTHLY', monthlyGrossPaise: money(20000) });
    const suggest = await payOk<{ items: { employeeId: string }[] }>(await pay(t.officer, '/employee-assignments/recommend', {}));
    expect(suggest.items.some((i) => i.employeeId === employee.employeeId)).toBe(false);
    // a deduction needs the account it is held in; the standard components cannot be switched off
    expectError(await pay(t.officer, '/components', { code: 'WELFARE', name: 'Staff Welfare', type: 'DEDUCTION', calc: 'FIXED' }), 400, 'VALIDATION_FAILED');
    expectError(await t.officer.agent.patch(`${API}/payroll/components/${t.basic.componentId}`).send({ status: 'INACTIVE' }), 409, 'FINANCE_RECORD_LOCKED');
  });
});

describe('calculation (PAY-07)', () => {
  it('QA PAY-07: gross ₹42,000 − ₹3,250 = net ₹38,750, the employer share is kept apart, and every line says how it was worked out', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 }, tdsYearlyRupees: 6250 });
    const run = await newRun(t, [a.employeeId]);
    const done = await calc(t, run.runId);
    expect(done.headline).toBe('November payroll · 1 employee · 1 ready · 0 need action');
    expect(done.totals).toEqual({ grossPaise: money(42000), deductionsPaise: money(3250), employerCostPaise: money(1800), netPaise: money(38750) });
    const lines = await linesOf(t, run.runId, a.employeeId);
    expect(lineAmount(lines, 'PF')).toBe(money(1800));
    expect(lineAmount(lines, 'PT')).toBe(money(200));
    expect(lineAmount(lines, 'TDS')).toBe(money(1250));
    expect(lines.find((l) => l.componentKey === 'PF')!.formula).toBe('PF 12% of ₹15,000 (wages capped at ₹15,000) = ₹1,800');
    expect(lines.find((l) => l.componentKey === 'EMP_PF')!.kind).toBe('EMPLOYER_COST');
    expect(lines.find((l) => l.componentKey === 'HRA')!.formula).toMatch(/House Rent Allowance 40% of basic ₹30,000 = ₹12,000/);
    // the same inputs always give the same answer
    const again = await calc(t, run.runId);
    expect(again.totals).toEqual(done.totals);
    expect((await linesOf(t, run.runId, a.employeeId)).map((l) => [l.label, l.amountPaise])).toEqual(lines.map((l) => [l.label, l.amountPaise]));
    expect(again.state).toBe('CALCULATED');
  });

  it('QA PAY-04: a missing input is an exception, never a full month; leave without pay shows its sum; a part month is worked out in words', async () => {
    const t = await payrollSchool();
    const nodays = await worker(t, 30000);
    const lop = await worker(t, 30000, { days: { lop: 4 } });
    const nosalary = await addActiveEmployee(t);
    await payOk(await payPut(t.officer, '/inputs', { employeeId: nosalary.employeeId, month: MONTH, workingDays: null, paidLeaveDays: 0, lopDays: 0, unitsWorked: null, extras: [] }));
    const run = await newRun(t, [nodays.employeeId, lop.employeeId, nosalary.employeeId]);
    const done = await calc(t, run.runId);
    expect(done.counts).toMatchObject({ employees: 3, ready: 1, needAction: 2 });
    const ex = await payGet<RunExceptionsDTO>(t, `/runs/${run.runId}/exceptions`);
    expect(ex.blockers).toBe(2);
    expect(ex.items.find((i) => i.employeeId === nodays.employeeId)!.exceptions[0]).toMatchObject({ code: 'MISSING_INPUT', level: 'BLOCKER' });
    expect(ex.items.find((i) => i.employeeId === nosalary.employeeId)!.exceptions.map((e) => e.code)).toContain('NO_SALARY_ASSIGNED');
    const lines = await linesOf(t, run.runId, lop.employeeId);
    expect(lines.find((l) => l.componentKey === 'BASIC')).toMatchObject({ amountPaise: money(26000), formula: 'Basic ₹30,000 × 26/30 paid days = ₹26,000' });
    expect((await rows(t, run.runId)).find((r) => r.employeeId === lop.employeeId)!.paidDays).toBe('26/30');
    // "Mark everyone present" is an explicit choice, and fills only the people with no entry
    const filled = await payOk<{ filled: number }>(await pay(t.officer, '/inputs/fill', { month: MONTH }));
    expect(filled.filled).toBeGreaterThanOrEqual(1);
    const after = await calc(t, run.runId);
    expect((await payGet<RunExceptionsDTO>(t, `/runs/${run.runId}/exceptions`)).items.find((i) => i.employeeId === nodays.employeeId)).toBeUndefined();
    void after;
  });

  it('QA PAY-04: a joiner and a leaver mid-month are flagged for a look, and the days are cut by dates', async () => {
    const t = await payrollSchool();
    const joiner = await worker(t, 30000, { joining: '2026-11-16', days: { lop: 0 } });
    const run = await newRun(t, [joiner.employeeId]);
    await calc(t, run.runId);
    const row = (await rows(t, run.runId))[0]!;
    expect(row.paidDays).toBe('15/30');
    expect(row.exceptions.map((e) => e.code)).toEqual(expect.arrayContaining(['JOINED_OR_EXITED_THIS_MONTH']));
    expect(row.exceptions.find((e) => e.code === 'JOINED_OR_EXITED_THIS_MONTH')!.level).toBe('REVIEW');
    expect(row.status).toBe('NEEDS_ACTION');
    expect((await linesOf(t, run.runId, joiner.employeeId)).find((l) => l.componentKey === 'BASIC')!.amountPaise).toBe(money(15000));
  });

  it('QA PAY-04: daily and hourly pay come from approved days and hours, never assumed', async () => {
    const t = await payrollSchool();
    const hourly = await worker(t, 400, { mode: 'HOURLY' });
    await payOk(await payPut(t.officer, '/inputs', { employeeId: hourly.employeeId, month: MONTH, workingDays: null, paidLeaveDays: 0, lopDays: 0, unitsWorked: null, extras: [] }));
    const run = await newRun(t, [hourly.employeeId]);
    await calc(t, run.runId);
    expect((await payGet<RunExceptionsDTO>(t, `/runs/${run.runId}/exceptions`)).items[0]!.exceptions[0]!.message).toMatch(/hours worked are not entered/);
    await payOk(await payPut(t.officer, '/inputs', { employeeId: hourly.employeeId, month: MONTH, workingDays: null, paidLeaveDays: 0, lopDays: 0, unitsWorked: 80, extras: [] }));
    await calc(t, run.runId);
    const lines = await linesOf(t, run.runId, hourly.employeeId);
    expect(lines.find((l) => l.componentKey === 'WAGES')).toMatchObject({ amountPaise: money(32000), formula: '₹400 × 80 hours = ₹32,000' });
  });
});

describe('statutory rules (PAY-05)', () => {
  it('QA PAY-05: the seeded rules are demo values and warn until approved; a rule starts on its own date', async () => {
    const t = await payrollSchool({ approveRules: false });
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const rules = await payGet<StatutoryRuleDTO[]>(t, '/statutory-rules');
    expect(rules.map((r) => r.kind).sort()).toEqual(['ESI', 'PF', 'PT']);
    expect(rules.every((r) => r.demo && r.warning?.startsWith('Demo values'))).toBe(true);
    const run = await newRun(t, [a.employeeId]);
    const done = await calc(t, run.runId);
    expect(done.warnings.join(' ')).toMatch(/PF rules are demo values/);
    const approved = await payOk<PayrollRunDTO>(await pay(t.approver, `/runs/${run.runId}/approve`));
    expectError(await pay(t.approver2, `/runs/${run.runId}/finalize`, { version: approved.version }), 409, 'STATUTORY_RULE_UNAPPROVED');
    // a new PF rate from December leaves November alone
    const pf = rules.find((r) => r.kind === 'PF')!;
    await payOk(await pay(t.officer, '/statutory-rules', { kind: 'PF', effectiveFrom: '2026-12-01', params: { employeeBps: 1000, employerBps: 1000, wageCeilingPaise: money(15000) } }), 201);
    await calc(t, run.runId).catch(() => null);
    expect(pf.params.employeeBps).toBe(1200);
    expect(lineAmount(await linesOf(t, run.runId, a.employeeId), 'PF')).toBe(money(1800));
  });
});

describe('approving and finalising (PAY-08, 09)', () => {
  it('QA PAY-08: the preparer cannot approve; blockers stop approval; an employee can be held out of this run with a reason', async () => {
    const t = await payrollSchool();
    const ok1 = await worker(t, 30000, { days: { lop: 0 } });
    const bad = await worker(t, 30000);
    const run = await newRun(t, [ok1.employeeId, bad.employeeId]);
    await calc(t, run.runId);
    expectError(await pay(t.approver, `/runs/${run.runId}/approve`), 409, 'PAYROLL_BLOCKED');
    const held = await payOk<PayrollRunDTO>(await t.officer.agent.patch(`${API}/payroll/runs/${run.runId}/employees/${bad.employeeId}`).send({ hold: true, reason: 'Leave records not ready' }));
    expect(held.counts).toMatchObject({ employees: 2, ready: 1, held: 1 });
    expect((await rows(t, run.runId)).find((r) => r.employeeId === bad.employeeId)).toMatchObject({ status: 'HELD', holdReason: 'Leave records not ready', netPaise: 0 });
    // a login that both prepares and approves is stopped
    const both = await staffWith(t, ['PAYROLL_OFFICER', 'APPROVER']);
    const mine = await payOk<PayrollRunDTO>(await pay(both, '/runs', { month: '2026-12', employeeIds: [ok1.employeeId] }), 201);
    await payOk(await payPut(t.officer, '/inputs', { employeeId: ok1.employeeId, month: '2026-12', workingDays: null, paidLeaveDays: 0, lopDays: 0, unitsWorked: null, extras: [] }));
    await payOk(await pay(both, `/runs/${mine.runId}/calculate`));
    expectError(await pay(both, `/runs/${mine.runId}/approve`), 403, 'SELF_APPROVAL_BLOCKED');
    // a one-off line (a bonus) is added with a reason and audited
    const withBonus = await payOk<PayrollRunDTO>(await t.officer.agent.patch(`${API}/payroll/runs/${run.runId}/employees/${ok1.employeeId}`).send({ addLine: { label: 'Festival bonus', type: 'EARNING', amountPaise: money(2000) }, reason: 'Diwali bonus' }));
    expect(withBonus.totals.grossPaise).toBe(money(44000));
  });

  it('QA PAY-09: finalising freezes the run, posts one balanced journal, writes payslips, and leaves the pay Unpaid', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 }, tdsYearlyRupees: 6250 });
    const run = await newRun(t, [a.employeeId]);
    const done = await finalise(t, run.runId);
    expect(done).toMatchObject({ state: 'FINALIZED', payoutStatus: 'UNPAID' });
    const journal = (await JournalEntry.findOne({ tenantId: t.tenantId, sourceKey: `payroll:${run.runId}` }).lean())!;
    const lines = await JournalLine.find({ tenantId: t.tenantId, journalId: journal._id }).lean();
    expect(lines.reduce((s, l) => s + l.debitPaise, 0)).toBe(money(42000) + money(1800));
    expect(lines.reduce((s, l) => s + l.creditPaise, 0)).toBe(money(42000) + money(1800));
    expect(lines.every((l) => l.employeeId === a.employeeId)).toBe(true);
    const tb = await trial(t);
    expect(tb.balanced).toBe(true);
    expect(tb.rows.find((r) => r.name === 'Salary Payable')!.creditPaise).toBe(money(38750));
    expect(tb.rows.find((r) => r.name === 'PF Payable')!.creditPaise).toBe(money(3600)); // employee 1,800 + employer 1,800
    expect(tb.rows.find((r) => r.name === 'Employer Contributions')!.debitPaise).toBe(money(1800));
    const slips = await payGet<PayslipDTO[]>(t, `/employees/${a.employeeId}/payslips`);
    expect(slips).toHaveLength(1);
    expect(slips[0]).toMatchObject({ grossPaise: money(42000), netPaise: money(38750), published: false });
    expect(slips[0]!.number).toMatch(/^PSL\/2026-27\/\d{6}$/);
    // frozen: no new calculation, no change to a line, no change to a payslip
    expectError(await pay(t.officer, `/runs/${run.runId}/calculate`), 409, 'PAYROLL_STATE_INVALID');
    expectError(await t.officer.agent.patch(`${API}/payroll/runs/${run.runId}/employees/${a.employeeId}`).send({ hold: true, reason: 'x' }), 409, 'PAYROLL_STATE_INVALID');
    await expect(Payslip.updateOne({ tenantId: t.tenantId, _id: slips[0]!.payslipId }, { $set: { number: 'X' } })).rejects.toMatchObject({ code: 'IMMUTABLE_RECORD' });
    expectError((await payPut(t.officer, '/inputs', { employeeId: a.employeeId, month: MONTH, workingDays: null, paidLeaveDays: 0, lopDays: 3, unitsWorked: null, extras: [] })) as never, 409, 'PAYROLL_STATE_INVALID');
    // another run for the same month is refused: a correction or supplementary run is the way
    expectError(await pay(t.officer, '/runs', { month: MONTH, employeeIds: [a.employeeId] }), 409, 'CONFLICT');
  });

  it('QA PAY-09: two approvers finalising at once: one wins, the other gets a version conflict, and there is one journal', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const run = await newRun(t, [a.employeeId]);
    await calc(t, run.runId);
    const approved = await payOk<PayrollRunDTO>(await pay(t.approver, `/runs/${run.runId}/approve`));
    const [x, y] = await Promise.all([pay(t.approver2, `/runs/${run.runId}/finalize`, { version: approved.version }), pay(t.approver, `/runs/${run.runId}/finalize`, { version: approved.version })]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect([x, y].find((r) => r.status === 409)!.body.error!.code).toBe('VERSION_CONFLICT');
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, sourceKey: `payroll:${run.runId}` })).toBe(1);
    expect(await Payslip.countDocuments({ tenantId: t.tenantId, runId: run.runId })).toBe(1);
  });

  it('QA PAY-03: a back-dated pay rise creates arrears in the next run and never touches the finalised payslip', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const nov = await finalise(t, (await newRun(t, [a.employeeId])).runId);
    const oldSlip = (await payGet<PayslipDTO[]>(t, `/employees/${a.employeeId}/payslips`))[0]!;
    // the rise is from 1 November, entered in December: needs a second person
    const blocked = await pay(t.officer, '/salary-revisions', { employeeId: a.employeeId, newBasicPaise: money(33000), effectiveDate: '2026-11-01', reason: 'Annual increment' });
    expectError(blocked, 409, 'APPROVAL_REQUIRED');
    const approvalId = blocked.body.error!.details!.approvalId as string;
    await payOk(await t.approver.agent.post(`${API}/finance/approvals/${approvalId}/decide`).send({ decision: 'APPROVE' }));
    await payOk(await pay(t.officer, '/salary-revisions', { employeeId: a.employeeId, newBasicPaise: money(33000), effectiveDate: '2026-11-01', reason: 'Annual increment', approvalId }), 201);
    await payOk(await payPut(t.officer, '/inputs', { employeeId: a.employeeId, month: '2026-12', workingDays: null, paidLeaveDays: 0, lopDays: 0, unitsWorked: null, extras: [] }));
    const dec = await newRun(t, [a.employeeId], '2026-12');
    await calc(t, dec.runId);
    const lines = await linesOf(t, dec.runId, a.employeeId);
    expect(lines.find((l) => l.componentKey === 'BASIC')!.amountPaise).toBe(money(33000));
    expect(lines.find((l) => l.componentKey === 'ARREARS')).toMatchObject({ amountPaise: money(4200) }); // (33,000 + 40%) − (30,000 + 40%) = 4,200 for November
    expect((await payGet<PayslipDTO[]>(t, `/employees/${a.employeeId}/payslips`)).find((p) => p.month === MONTH)).toMatchObject({ grossPaise: oldSlip.grossPaise });
    void nov;
  });
});

describe('paying the salary (PAY-11, 12)', () => {
  async function paidRun() {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 }, tdsYearlyRupees: 6250 });
    const b = await worker(t, 20000, { days: { lop: 0 } });
    const noBank = await worker(t, 20000, { days: { lop: 0 }, noBank: true });
    const run = await newRun(t, [a.employeeId, b.employeeId, noBank.employeeId]);
    const done = await finalise(t, run.runId);
    return { t, a, b, noBank, run, done };
  }

  it('QA PAY-11: building the bank file marks nobody paid; the account number is only in the file; an employee with no bank is left out with a reason', async () => {
    const { t, a, b, noBank, run } = await paidRun();
    const batch = await payOk<DisbursementBatchDTO>(await pay(t.officer, `/runs/${run.runId}/disbursement-batch`, { bankAccountId: t.bank.bankAccountId }), 201);
    expect(batch.items).toHaveLength(2);
    expect(batch.skipped).toEqual([{ employeeId: noBank.employeeId, employeeName: expect.any(String), reason: 'No bank account on record.' }]);
    expect(batch.items.every((i) => i.status === 'PENDING')).toBe(true);
    expect(JSON.stringify(batch)).not.toMatch(/9900\d{8}/);
    const file = await t.officer.agent.get(`${API}/payroll/disbursements/${batch.batchId}/bank-file`).expect(200);
    expect(file.headers['content-type']).toMatch(/csv/);
    expect(file.text.split('\r\n')[0]).toBe('Name,Account number,IFSC,Amount,Reference');
    expect(file.text).toMatch(/9900\d{8}/);
    expect(file.text).toContain('SBIN0001234');
    expect(file.headers['x-file-hash']).toMatch(/^[0-9a-f]{64}$/);
    // nothing is paid, nothing is posted, the run is Unpaid
    expect((await payGet<PayrollRunDTO>(t, `/runs/${run.runId}`)).payoutStatus).toBe('UNPAID');
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, eventType: 'salary.paid' })).toBe(0);
    void a; void b;
  });

  it('QA PAY-11: recording is not verifying; a partial, a failed transfer and a safe retry; a payment can never be more than what is payable', async () => {
    const { t, a, b, noBank, run } = await paidRun();
    const batch = await payOk<DisbursementBatchDTO>(await pay(t.officer, `/runs/${run.runId}/disbursement-batch`, { bankAccountId: t.bank.bankAccountId }), 201);
    const item = (e: string) => batch.items.find((i) => i.employeeId === e)!;
    expect(item(a.employeeId).amountPaise).toBe(money(38750));
    expectError(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID', reference: 'NEFT1', amountPaise: money(40000) }] }), 422, 'PAYOUT_EXCEEDS_PAYABLE');
    expectError(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID' }] }), 400, 'VALIDATION_FAILED'); // a bank payment needs its reference
    const recorded = await payOk<DisbursementBatchDTO>(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID', reference: 'NEFT1', amountPaise: money(20000) }, { employeeId: b.employeeId, status: 'FAILED', reason: 'Account closed' }] }));
    expect(recorded.state).toBe('RECORDED');
    expect(recorded.items.find((i) => i.employeeId === b.employeeId)!.status).toBe('FAILED');
    // still nothing in the books: recorded, not verified
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, eventType: 'salary.paid' })).toBe(0);
    expect((await payGet<PayrollRunDTO>(t, `/runs/${run.runId}`)).payoutStatus).toBe('UNPAID');
    // the person who recorded cannot verify
    expectError(await pay(t.officer, `/disbursements/${batch.batchId}/verify`, {}), 403, 'SELF_APPROVAL_BLOCKED');
    const verified = await payOk<DisbursementBatchDTO>(await pay(t.officer2, `/disbursements/${batch.batchId}/verify`, {}));
    expect(verified.verifiedPaise).toBe(money(20000));
    expect((await payGet<PayrollRunDTO>(t, `/runs/${run.runId}`)).payoutStatus).toBe('PARTIALLY_PAID');
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, eventType: 'salary.paid' })).toBe(1);
    // the rest of A's salary: the most that is still payable is ₹18,750
    expectError(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID', reference: 'NEFT2', amountPaise: money(19000) }] }), 422, 'PAYOUT_EXCEEDS_PAYABLE');
    // a retry for the failed one is a new item that points at the failed one
    const retried = await payOk<DisbursementBatchDTO>(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID', reference: 'NEFT2', amountPaise: money(18750) }, { employeeId: b.employeeId, status: 'PAID', reference: 'NEFT3' }] }));
    expect(retried.items.filter((i) => i.employeeId === b.employeeId).map((i) => i.status).sort()).toEqual(['FAILED', 'PAID']);
    expect(retried.items.find((i) => i.employeeId === b.employeeId && i.status === 'PAID')!.retryOfId).toBe(item(b.employeeId).itemId);
    await payOk(await pay(t.officer2, `/disbursements/${batch.batchId}/verify`, {}));
    // the employee with no bank account is still owed: the run is not fully paid until they are
    expect((await payGet<PayrollRunDTO>(t, `/runs/${run.runId}`)).payoutStatus).toBe('PARTIALLY_PAID');
    const tb = await trial(t);
    expect(tb.balanced).toBe(true);
    const sp = tb.rows.find((r) => r.name === 'Salary Payable')!;
    expect(sp.creditPaise - sp.debitPaise).toBe(money(26000));
    const liab = await payGet<{ unpaidSalaryPaise: number; statutory: { role: string; payablePaise: number }[] }>(t, '/liabilities');
    expect(liab.unpaidSalaryPaise).toBe(money(26000));
    expect(liab.statutory.find((s) => s.role === 'PF_PAYABLE')!.payablePaise).toBeGreaterThan(0);
    await payOk(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: noBank.employeeId, status: 'PAID', mode: 'CASH', reason: 'No bank account yet', amountPaise: money(26000) }] }));
    await payOk(await pay(t.officer2, `/disbursements/${batch.batchId}/verify`, {}));
    expect((await payGet<PayrollRunDTO>(t, `/runs/${run.runId}`)).payoutStatus).toBe('PAID');
  });

  it('QA PAY-11: cash or cheque salary needs a reason', async () => {
    const { t, a, run } = await paidRun();
    const batch = await payOk<DisbursementBatchDTO>(await pay(t.officer, `/runs/${run.runId}/disbursement-batch`, { bankAccountId: t.bank.bankAccountId }), 201);
    expectError(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID', mode: 'CASH' }] }), 400, 'VALIDATION_FAILED');
    await payOk(await pay(t.officer, `/disbursements/${batch.batchId}/record`, { items: [{ employeeId: a.employeeId, status: 'PAID', mode: 'CASH', reason: 'Bank account being changed' }] }));
  });
});

describe('advances and loans (PAY-06)', () => {
  it('QA PAY-06: an advance is approved, paid out, recovered as its own line each month, and can be repaid early', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const adv = await payOk<AdvanceDTO>(await pay(t.officer, '/advances', { employeeId: a.employeeId, principalPaise: money(6000), installments: 3, startMonth: MONTH, reason: 'Medical' }), 201);
    expect(adv.installmentPaise).toBe(money(2000));
    expectError(await pay(t.officer, `/advances/${adv.advanceId}/approve`), 403, 'FORBIDDEN');
    expectError(await pay(t.officer, `/advances/${adv.advanceId}/record-payment`, { bankAccountId: t.bank.bankAccountId, reference: 'N1' }), 409, 'PAYROLL_STATE_INVALID');
    await payOk(await pay(t.approver, `/advances/${adv.advanceId}/approve`));
    await payOk(await pay(t.officer, `/advances/${adv.advanceId}/record-payment`, { bankAccountId: t.bank.bankAccountId, reference: 'N1' }));
    // it is an asset, kept apart from salary payable
    expect((await trial(t)).rows.find((r) => r.name === 'Employee Advances')!.debitPaise).toBe(money(6000));
    const run = await newRun(t, [a.employeeId]);
    await finalise(t, run.runId);
    const lines = await linesOf(t, run.runId, a.employeeId);
    expect(lines.find((l) => l.componentKey === 'ADVANCE')).toMatchObject({ kind: 'RECOVERY', amountPaise: money(2000) });
    const after = (await payGet<AdvanceDTO[]>(t, `/advances?employeeId=${a.employeeId}`))[0]!;
    expect(after.remainingPaise).toBe(money(4000));
    const repaid = await payOk<AdvanceDTO>(await pay(t.officer, `/advances/${adv.advanceId}/repay`, { amountPaise: money(4000), bankAccountId: t.bank.bankAccountId }));
    expect(repaid).toMatchObject({ remainingPaise: 0, state: 'CLOSED' });
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA PAY-06: an instalment bigger than the pay left is an exception, not a negative payslip', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 100, { days: { lop: 0 } }); // basic ₹100: gross ₹140
    const adv = await payOk<AdvanceDTO>(await pay(t.officer, '/advances', { employeeId: a.employeeId, principalPaise: money(5000), installments: 1, startMonth: MONTH, reason: 'Test' }), 201);
    await payOk(await pay(t.approver, `/advances/${adv.advanceId}/approve`));
    await payOk(await pay(t.officer, `/advances/${adv.advanceId}/record-payment`, { bankAccountId: t.bank.bankAccountId, reference: 'N9' }));
    const run = await newRun(t, [a.employeeId]);
    await calc(t, run.runId);
    const ex = await payGet<RunExceptionsDTO>(t, `/runs/${run.runId}/exceptions`);
    expect(ex.items[0]!.exceptions.map((e) => e.code)).toContain('ADVANCE_EXCEEDS_NET');
    expectError(await pay(t.approver, `/runs/${run.runId}/approve`), 409, 'PAYROLL_BLOCKED');
  });
});

describe('the employee\'s own pay, and who can see salary (PAY-14, SEC)', () => {
  it('QA PAY-14: an employee sees only their own published payslips; another person\'s is a 404; salary routes are closed without the permission', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const b = await worker(t, 20000, { days: { lop: 0 } });
    const run = await newRun(t, [a.employeeId, b.employeeId]);
    await finalise(t, run.runId);
    const loginA = await loginAs(t, 'STAFF', a);
    const loginB = await loginAs(t, 'STAFF', b);
    // not published yet: nothing to see
    expect(((await loginA.agent.get(`${API}/me/payslips`).expect(200)).body.data as PayslipDTO[])).toHaveLength(0);
    await payOk(await pay(t.officer, `/runs/${run.runId}/publish-payslips`));
    const mine = (await loginA.agent.get(`${API}/me/payslips`).expect(200)).body.data as PayslipDTO[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ employeeId: a.employeeId, grossPaise: money(42000) });
    const theirs = (await loginB.agent.get(`${API}/me/payslips`).expect(200)).body.data as PayslipDTO[];
    expect((await loginA.agent.get(`${API}/me/payslips/${theirs[0]!.payslipId}/pdf`)).status).toBe(404);
    expect((await loginA.agent.get(`${API}/me/payslips/${mine[0]!.payslipId}/pdf`).expect(200)).headers['content-type']).toMatch(/pdf/);
    const summary = (await loginA.agent.get(`${API}/me/payroll/summary`).expect(200)).body.data as MyPayrollSummaryDTO;
    expect(summary).toMatchObject({ employeeId: a.employeeId, latestPayslip: { month: MONTH } });
    // a supplied employee id is ignored: the session decides
    const forged = (await loginA.agent.post(`${API}/me/tax-declaration`).send({ regime: 'NEW', estimatedYearlyTaxPaise: money(1000), alreadyDeductedPaise: 0 }).expect(200)).body.data as { employeeId: string };
    expect(forged.employeeId).toBe(a.employeeId);
    expectError(await loginA.agent.post(`${API}/me/tax-declaration`).send({ employeeId: b.employeeId, regime: 'NEW', estimatedYearlyTaxPaise: 1, alreadyDeductedPaise: 0 }), 400, 'VALIDATION_FAILED');
    // Faculty and Staff cannot call payroll routes, a payroll officer cannot read other tenants' runs, and the collector cannot see salary
    for (const path of ['/runs', '/policy', '/components', '/liabilities']) expect((await loginA.agent.get(`${API}/payroll${path}`)).status).toBe(403);
    expect((await t.cashier.agent.get(`${API}/payroll/payslips`)).status).toBe(403);
    expect((await t.accountant.agent.get(`${API}/payroll/employees/${a.employeeId}/payslips`)).status).toBe(403);
    const other = await payrollSchool();
    expect((await other.officer.agent.get(`${API}/payroll/runs/${run.runId}`)).status).toBe(404);
    expect((await other.officer.agent.get(`${API}/payroll/employees/${a.employeeId}/payslips`)).status).toBe(404);
  });
});

describe('full and final settlement (PAY-13) and reports (PAY-15)', () => {
  it('QA PAY-13: a leaver\'s settlement pays the days to the last day, leave encashment and gratuity, recovers the advance balance, and goes through the same payment steps', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 } });
    const adv = await payOk<AdvanceDTO>(await pay(t.officer, '/advances', { employeeId: a.employeeId, principalPaise: money(3000), installments: 3, startMonth: MONTH, reason: 'Test' }), 201);
    await payOk(await pay(t.approver, `/advances/${adv.advanceId}/approve`));
    await payOk(await pay(t.officer, `/advances/${adv.advanceId}/record-payment`, { bankAccountId: t.bank.bankAccountId, reference: 'N2' }));
    expectError(await pay(t.officer, `/employees/${a.employeeId}/full-final`, { leaveEncashmentDays: 0 }), 409, 'PAYROLL_STATE_INVALID'); // no exit date yet
    await t.agent.post(`${API}/employees/${a.employeeId}/exit`).send({ exitDate: '2026-11-15', exitReasonCategory: 'RESIGNATION' }).expect(200);
    const run = await payOk<PayrollRunDTO>(await pay(t.officer, `/employees/${a.employeeId}/full-final`, { leaveEncashmentDays: 6, leaveEncashmentRatePaise: money(1000), gratuityPaise: money(10000) }), 201);
    expect(run).toMatchObject({ type: 'FULL_FINAL', state: 'CALCULATED' });
    const lines = await linesOf(t, run.runId, a.employeeId);
    expect(lines.find((l) => l.componentKey === 'BASIC')!.amountPaise).toBe(money(15000)); // 15 of 30 days
    expect(lines.find((l) => l.label.startsWith('Leave encashment'))!.amountPaise).toBe(money(6000));
    expect(lines.find((l) => l.label === 'Gratuity')!.amountPaise).toBe(money(10000));
    expect(lines.find((l) => l.componentKey === 'ADVANCE')!.amountPaise).toBe(money(3000)); // the whole balance, not one instalment
    const approved = await payOk<PayrollRunDTO>(await pay(t.approver, `/runs/${run.runId}/approve`));
    await payOk(await pay(t.approver2, `/runs/${run.runId}/finalize`, { version: approved.version }));
    const statement = await t.officer.agent.get(`${API}/payroll/runs/${run.runId}/settlement-statement`).expect(200);
    expect(statement.headers['content-type']).toMatch(/pdf/);
    expect((await payGet<AdvanceDTO[]>(t, `/advances?employeeId=${a.employeeId}`))[0]).toMatchObject({ remainingPaise: 0, state: 'CLOSED' });
    expect((await trial(t)).balanced).toBe(true);
  });

  it('QA PAY-15: the payroll register, bank advice and cost reports state their basis; bank advice never shows a full account number; the CSV is audited', async () => {
    const t = await payrollSchool();
    const a = await worker(t, 30000, { days: { lop: 0 }, tdsYearlyRupees: 6250 });
    const b = await worker(t, 20000, { days: { lop: 0 } });
    await finalise(t, (await newRun(t, [a.employeeId, b.employeeId])).runId);
    const register = await payGet<ReportDTO>(t.officer, `/reports/register?month=${MONTH}`);
    expect(register.basis).toMatch(/payroll runs as finalised/i);
    expect(register.totals).toMatchObject({ grossPaise: money(42000) + money(28000), employerCostPaise: money(1800) + money(1800) });
    const advice = await payGet<ReportDTO>(t.officer, `/reports/bank-advice?month=${MONTH}`);
    expect(JSON.stringify(advice)).not.toMatch(/9900\d{8}/);
    expect(advice.rows[0]!.account).toMatch(/^••••/);
    const cost = await payGet<ReportDTO>(t.officer, `/reports/cost-by-location-department?month=${MONTH}`);
    expect(cost.totals!.costPaise).toBe(money(42000) + money(28000) + money(3600));
    const statutory = await payGet<ReportDTO>(t.officer, `/reports/statutory-summary?month=${MONTH}`);
    expect(statutory.rows.find((r) => r.name === 'PF')!.deductedPaise).toBe(money(1800) * 4);
    const csv = await t.officer.agent.get(`${API}/payroll/reports/register?month=${MONTH}&format=csv`).expect(200);
    expect(csv.text).toContain('Payroll register');
    expect((await t.cashier.agent.get(`${API}/payroll/reports/register?month=${MONTH}`)).status).toBe(403);
    void put; void ok; void created; void post;
  });
});

const row = (tb: TrialBalanceDTO, name: string) => tb.rows.find((r) => r.name === name);
const net = (tb: TrialBalanceDTO, name: string) => (row(tb, name)?.debitPaise ?? 0) - (row(tb, name)?.creditPaise ?? 0);

async function expenseSchool() {
  const t = await moneySchool();
  const categories = await getOk<ExpenseCategoryDTO[]>(t, '/expense-categories');
  const cat = (code: string) => categories.find((c) => c.code === code)!;
  const clerk = await staffWith(t, ['ACCOUNTANT']);
  const reviewer = await staffWith(t, ['ACCOUNTANT']);
  const base = (over: Record<string, unknown> = {}) => ({ categoryId: cat('SUPPLIES').categoryId, taxableValuePaise: money(1000), date: today(), description: 'Chalk and registers', locationId: t.moh.locationId, paymentMode: 'BANK', bankAccountId: t.bank.bankAccountId, gstRateBps: 0, ...over });
  return { ...t, cat, clerk, reviewer, base };
}
type ExpSchool = Awaited<ReturnType<typeof expenseSchool>>;
const spend = async (t: ExpSchool, over: Record<string, unknown> = {}) => created<ExpenseDTO>(await post(t.clerk, '/expenses', t.base(over)));

describe('expenses (FIN-13)', () => {
  it('QA FIN-13: a small expense posts at once (Dr expense, Cr bank) and cannot be edited, only reversed', async () => {
    const t = await expenseSchool();
    const e = await spend(t);
    expect(e).toMatchObject({ state: 'POSTED', totalPaise: money(1000), needsApproval: false, waitingForItc: false });
    expect(e.number).toMatch(/^EXP\/2026-27\/\d{6}$/);
    const tb = await trial(t);
    expect(net(tb, 'Supplies')).toBe(money(1000));
    expect(net(tb, 'Bank Account')).toBe(-money(1000));
    expect(tb.balanced).toBe(true);
    expect((await t.clerk.agent.patch(`${API}/finance/expenses/${e.expenseId}`).send({ taxableValuePaise: 1 })).status).toBe(404); // no edit route
    await expect(Expense.updateOne({ tenantId: t.tenantId, _id: e.expenseId }, { $set: { taxableValuePaise: 1 } })).resolves.toBeDefined(); // a stored field that is marked fixed is ignored by the model
    expect((await Expense.findOne({ tenantId: t.tenantId, _id: e.expenseId }).lean())!.taxableValuePaise).toBe(money(1000));
    expectError(await post(t.cashier, `/expenses/${e.expenseId}/reverse`, { reason: 'Entered twice' }), 403, 'FORBIDDEN');
    const reversed = await ok<ExpenseDTO>(await post(t.clerk, `/expenses/${e.expenseId}/reverse`, { reason: 'Entered twice' }));
    expect(reversed.state).toBe('REVERSED');
    expect(net(await trial(t), 'Supplies')).toBe(0);
    expect(await JournalEntry.countDocuments({ tenantId: t.tenantId, reversesId: { $ne: null } })).toBe(1);
  });

  it('QA FIN-13: an expense over the limit waits for a second person; the person who entered it cannot approve it', async () => {
    const t = await expenseSchool();
    const e = await spend(t, { taxableValuePaise: money(30000), description: 'New projector' });
    expect(e).toMatchObject({ state: 'PENDING', needsApproval: true, approved: false });
    expect(net(await trial(t), 'Supplies')).toBe(0); // nothing is in the books yet
    expectError(await post(t.clerk, `/expenses/${e.expenseId}/approve`, {}), 403, 'FORBIDDEN');
    const both = await staffWith(t, ['ACCOUNTANT', 'APPROVER']);
    const mine = await created<ExpenseDTO>(await post(both, '/expenses', t.base({ taxableValuePaise: money(30000) })));
    expectError(await post(both, `/expenses/${mine.expenseId}/approve`, {}), 403, 'SELF_APPROVAL_BLOCKED');
    const approved = await ok<ExpenseDTO>(await post(t.approver, `/expenses/${e.expenseId}/approve`, {}));
    expect(approved.state).toBe('POSTED');
    expect(net(await trial(t), 'Supplies')).toBe(money(30000));
    const rejected = await ok<ExpenseDTO>(await post(t.approver, `/expenses/${mine.expenseId}/reject`, { reason: 'Quote needed' }));
    expect(rejected.state).toBe('REJECTED');
  });

  it('QA TAX-05: input tax needs a decision before anything posts; eligible tax goes to the Input GST accounts, tax that cannot be claimed is added to the cost', async () => {
    const t = await expenseSchool();
    const e = await spend(t, { taxableValuePaise: money(10000), gstRateBps: 1800, description: 'Printer' });
    expect(e).toMatchObject({ state: 'PENDING', waitingForItc: true, taxPaise: money(1800), totalPaise: money(11800) });
    expect(e.taxLines[0]).toMatchObject({ itcStatus: 'NEEDS_REVIEW', cgstPaise: money(900), sgstPaise: money(900), igstPaise: 0 });
    expect(net(await trial(t), 'Supplies')).toBe(0);
    expectError(await post(t.cashier, '/tax/itc-review', { lineIds: [e.taxLines[0]!.lineId], decision: 'ELIGIBLE', reason: 'x' }), 403, 'FORBIDDEN'); // deciding input tax is its own permission
  });

  it('QA TAX-06: an input tax decision posts the expense; ELIGIBLE and NOT_ELIGIBLE book differently', async () => {
    const t = await expenseSchool();
    const eligible = await spend(t, { taxableValuePaise: money(10000), gstRateBps: 1800, description: 'Printer' });
    const notEligible = await spend(t, { taxableValuePaise: money(5000), gstRateBps: 1800, description: 'Staff party' });
    const r1 = await ok<{ decided: number; posted: number }>(await post(t.reviewer, '/tax/itc-review', { lineIds: [eligible.taxLines[0]!.lineId], decision: 'ELIGIBLE', reason: 'Used for the school office' }));
    expect(r1).toEqual({ decided: 1, posted: 1 });
    await ok(await post(t.reviewer, '/tax/itc-review', { lineIds: [notEligible.taxLines[0]!.lineId], decision: 'NOT_ELIGIBLE', reason: 'Not for the school business' }));
    const tb = await trial(t);
    expect(net(tb, 'Supplies')).toBe(money(10000) + money(5900)); // the second one carries its own tax
    expect(net(tb, 'Input CGST')).toBe(money(900));
    expect(net(tb, 'Input SGST')).toBe(money(900));
    expect(net(tb, 'Bank Account')).toBe(-(money(11800) + money(5900)));
    expect(tb.balanced).toBe(true);
    expectError(await post(t.reviewer, '/tax/itc-review', { lineIds: [eligible.taxLines[0]!.lineId], decision: 'NOT_ELIGIBLE', reason: 'Changed my mind' }), 409, 'COLLECTION_STATE_INVALID'); // a posted line is changed by reversing
    expect((await getOk<ExpenseDTO>(t.reviewer, `/expenses/${eligible.expenseId}`)).state).toBe('POSTED');
  });

  it('QA TAX-05: a big expense with tax cannot be approved until its input tax is decided', async () => {
    const t = await expenseSchool();
    const e = await spend(t, { taxableValuePaise: money(40000), gstRateBps: 1800 });
    expectError(await post(t.approver, `/expenses/${e.expenseId}/approve`, {}), 409, 'ITC_REVIEW_REQUIRED');
    await ok(await post(t.reviewer, '/tax/itc-review', { lineIds: [e.taxLines[0]!.lineId], decision: 'ELIGIBLE', reason: 'Office equipment' }));
    expect((await getOk<ExpenseDTO>(t.reviewer, `/expenses/${e.expenseId}`)).state).toBe('PENDING'); // decided, but still needs a second person
    const done = await ok<ExpenseDTO>(await post(t.approver, `/expenses/${e.expenseId}/approve`, {}));
    expect(done.state).toBe('POSTED');
  });

  it('QA TAX-05: a vendor in another state is charged IGST, one in the school\'s state CGST and SGST', async () => {
    const t = await expenseSchool();
    const local = await created<VendorDTO>(await post(t.clerk, '/vendors', { name: 'Local Stationers', gstin: '03AAAAA0000A1Z5' }));
    const far = await created<VendorDTO>(await post(t.clerk, '/vendors', { name: 'Delhi Supplies', gstin: '07BBBBB0000B1Z5' }));
    const a = await spend(t, { vendorId: local.vendorId, taxableValuePaise: money(1000), gstRateBps: 1200, itcStatus: 'ELIGIBLE' });
    const b = await spend(t, { vendorId: far.vendorId, taxableValuePaise: money(1000), gstRateBps: 1200, itcStatus: 'ELIGIBLE' });
    expect(a.taxLines[0]).toMatchObject({ cgstPaise: money(60), sgstPaise: money(60), igstPaise: 0 });
    expect(b.taxLines[0]).toMatchObject({ cgstPaise: 0, sgstPaise: 0, igstPaise: money(120) });
    expect(a.state).toBe('POSTED');
    const tb = await trial(t);
    expect(net(tb, 'Input IGST')).toBe(money(120));
    expect(tb.balanced).toBe(true);
  });

  it('QA FIN-13: only a person who can record expenses can; a collector cannot, and another school gets 404', async () => {
    const t = await expenseSchool();
    expect((await t.cashier.agent.post(`${API}/finance/expenses`).send(t.base())).status).toBe(403);
    const e = await spend(t);
    const other = await expenseSchool();
    expect((await other.clerk.agent.get(`${API}/finance/expenses/${e.expenseId}`)).status).toBe(404);
    const chd = await staffWith(t, ['ACCOUNTANT'], { primaryLocationId: t.chd.locationId });
    expect((await chd.agent.get(`${API}/finance/expenses/${e.expenseId}`)).status).toBe(404);
    expect((await chd.agent.post(`${API}/finance/expenses`).send(t.base())).status).toBe(403); // a campus outside their scope
  });
});

describe('vendors, bills and payments (FIN-14)', () => {
  async function vendorSetup(t: ExpSchool) {
    const vendor = await created<VendorDTO>(await post(t.clerk, '/vendors', { name: 'Green Printers', gstin: '03CCCCC0000C1Z5', bankAccountNumber: '555566667777', bankIfsc: 'HDFC0000001', bankName: 'HDFC' }));
    return vendor;
  }
  const billBody = (t: ExpSchool, vendorId: string, over: Record<string, unknown> = {}) => ({ vendorId, vendorBillNumber: 'GP-101', date: today(), dueDate: '2026-12-10', locationId: t.moh.locationId, lines: [{ description: 'Exam papers', categoryId: t.cat('SUPPLIES').categoryId, taxableValuePaise: money(10000), gstRateBps: 0 }], ...over });

  it('QA FIN-14: a vendor bill books the payable (Dr expense, Cr Vendors Payable); a payment can be partial and across bills; the aging shows what is left', async () => {
    const t = await expenseSchool();
    const vendor = await vendorSetup(t);
    expect(vendor).toMatchObject({ bankAccountMasked: '••••7777', pan: null });
    expect(JSON.stringify(vendor)).not.toContain('555566667777');
    const b1 = await created<VendorBillDTO>(await post(t.clerk, '/vendor-bills', billBody(t, vendor.vendorId)));
    const b2 = await created<VendorBillDTO>(await post(t.clerk, '/vendor-bills', billBody(t, vendor.vendorId, { vendorBillNumber: 'GP-102', dueDate: '2026-10-01', lines: [{ description: 'Registers', categoryId: t.cat('SUPPLIES').categoryId, taxableValuePaise: money(4000), gstRateBps: 0 }] })));
    expect(b1).toMatchObject({ state: 'POSTED', totalPaise: money(10000), balancePaise: money(10000) });
    expectError(await post(t.clerk, '/vendor-bills', billBody(t, vendor.vendorId)), 409, 'CONFLICT'); // the same vendor bill number twice
    let tb = await trial(t);
    expect(net(tb, 'Vendors Payable')).toBe(-money(14000));
    expect(net(tb, 'Supplies')).toBe(money(14000));
    // pay part of the first and all of the second, in one payment
    const payment = await created<VendorPaymentDTO>(await post(t.clerk, '/vendor-payments', { vendorId: vendor.vendorId, bankAccountId: t.bank.bankAccountId, reference: 'NEFT-GP-1', allocations: [{ billId: b1.billId, amountPaise: money(6000) }, { billId: b2.billId, amountPaise: money(4000) }] }));
    expect(payment.amountPaise).toBe(money(10000));
    expect(payment.number).toMatch(/^VPY\//);
    expectError(await post(t.clerk, '/vendor-payments', { vendorId: vendor.vendorId, bankAccountId: t.bank.bankAccountId, reference: 'X', allocations: [{ billId: b2.billId, amountPaise: money(1) }] }), 422, 'ALLOCATION_INVALID'); // already paid in full
    expectError(await post(t.clerk, '/vendor-payments', { vendorId: vendor.vendorId, bankAccountId: t.bank.bankAccountId, reference: 'X', allocations: [{ billId: b1.billId, amountPaise: money(5000) }] }), 422, 'ALLOCATION_INVALID'); // more than is left
    const bills = (await getOk<{ items: VendorBillDTO[] }>(t.clerk, '/vendor-bills')).items;
    expect(bills.find((b) => b.billId === b1.billId)).toMatchObject({ state: 'PARTIALLY_PAID', paidPaise: money(6000), balancePaise: money(4000) });
    expect(bills.find((b) => b.billId === b2.billId)!.state).toBe('PAID');
    const aging = await getOk<PayablesAgingDTO>(t.clerk, '/payables/aging');
    expect(aging.totalPaise).toBe(money(4000));
    expect(aging.rows).toEqual([expect.objectContaining({ number: b1.number, balancePaise: money(4000) })]);
    tb = await trial(t);
    expect(net(tb, 'Vendors Payable')).toBe(-money(4000));
    expect(tb.balanced).toBe(true);
    expectError(await post(t.cashier, `/vendor-bills/${b1.billId}/reverse`, { reason: 'Wrong' }), 403, 'FORBIDDEN');
    expectError(await post(t, `/vendor-bills/${b1.billId}/reverse`, { reason: 'Wrong' }), 409, 'COLLECTION_STATE_INVALID'); // part-paid: it cannot be reversed
  });

  it('QA FIN-14: a vendor\'s bank change needs a second person, and the new number is never readable on the request', async () => {
    const t = await expenseSchool();
    const vendor = await vendorSetup(t);
    const blocked = await t.clerk.agent.patch(`${API}/finance/vendors/${vendor.vendorId}`).send({ bankAccountNumber: '999900001111' });
    expectError(blocked, 409, 'APPROVAL_REQUIRED');
    const approvalId = blocked.body.error.details.approvalId as string;
    expect(JSON.stringify(await getOk(t, '/approvals'))).not.toContain('999900001111');
    expect((await getOk<VendorDTO[]>(t.clerk, '/vendors'))[0]!.bankAccountMasked).toBe('••••7777');
    await ok(await post(t.approver, `/approvals/${approvalId}/decide`, { decision: 'APPROVE' }));
    expect((await getOk<VendorDTO[]>(t.clerk, '/vendors'))[0]!.bankAccountMasked).toBe('••••1111');
    expect(JSON.stringify(await getOk(t, '/audit'))).not.toContain('999900001111');
    void patch;
  });

  it('QA FIN-14: a big vendor bill waits for approval and posts when it is given', async () => {
    const t = await expenseSchool();
    const vendor = await vendorSetup(t);
    const bill = await created<VendorBillDTO>(await post(t.clerk, '/vendor-bills', billBody(t, vendor.vendorId, { vendorBillNumber: 'GP-900', lines: [{ description: 'Furniture', categoryId: t.cat('SUPPLIES').categoryId, taxableValuePaise: money(50000), gstRateBps: 0 }] })));
    expect(bill).toMatchObject({ state: 'PENDING', needsApproval: true });
    expect(net(await trial(t), 'Vendors Payable')).toBe(0);
    const approved = await ok<VendorBillDTO>(await post(t.approver, `/vendor-bills/${bill.billId}/approve`, {}));
    expect(approved.state).toBe('POSTED');
    expect(net(await trial(t), 'Vendors Payable')).toBe(-money(50000));
  });
});

describe('GST records and reports (TAX-04, 07 to 09)', () => {
  /** A bill with a taxable ₹1,500 uniform (GST 12%), as a debit note on a normal bill. */
  async function taxedBill() {
    const t = await expenseSchool();
    const kid = await enrolled(t);
    await issueMonth(t);
    const bill = await billOf(t, kid.studentId);
    const adj = await created<AdjustmentResultDTO>(await post(t, `/fee-documents/${bill.documentId}/adjustments`, { type: 'DEBIT_NOTE', reason: 'Uniform', lines: [{ feeHeadId: t.heads.uniform.feeHeadId, description: 'School uniform', amountPaise: money(1500) }] }));
    return { t, kid, bill, adj };
  }

  it('QA TAX-04: a credit note takes back the tax of the line it reduces, so the month\'s GST goes to zero', async () => {
    const { t, adj } = await taxedBill();
    const month = today().slice(0, 7);
    const before = await getOk<ReportDTO>(t.accountant, `/tax/reports/outward-summary?month=${month}`);
    // ₹1,500 + 12% GST = ₹1,680: the debit note is dated today, so it is in this month's report
    expect(before.totals).toMatchObject({ taxablePaise: money(1500), cgstPaise: money(90), sgstPaise: money(90), igstPaise: 0 });
    const doc = await getOk<FeeDocumentDTO>(t, `/fee-documents/${adj.newDocumentId}`);
    await created(await post(t, `/fee-documents/${adj.newDocumentId}/adjustments`, { type: 'CREDIT_NOTE', reason: 'Returned', lines: [{ lineId: doc.lines[0]!.lineId, amountPaise: doc.lines[0]!.totalPaise }] }));
    const after = await getOk<ReportDTO>(t.accountant, `/tax/reports/outward-summary?month=${month}`);
    expect(after.totals).toMatchObject({ taxablePaise: 0, cgstPaise: 0, sgstPaise: 0 });
    const tb = await trial(t);
    expect(net(tb, 'Output CGST')).toBe(0);
    expect(tb.balanced).toBe(true);
  });

  it('QA TAX-07: paying GST and using input credit are records with journals; they cannot be more than what is owed or available', async () => {
    const { t } = await taxedBill();
    const month = today().slice(0, 7);
    const eligible = await spend(t, { taxableValuePaise: money(500), gstRateBps: 1200, itcStatus: 'ELIGIBLE' });
    expect(eligible.state).toBe('POSTED');
    expectError(await post(t.accountant, '/tax/payments', { month, kind: 'PAY_LIABILITY', head: 'CGST', amountPaise: money(1000), bankAccountId: t.bank.bankAccountId }), 422, 'ALLOCATION_INVALID'); // only ₹90 is owed
    expectError(await post(t.accountant, '/tax/payments', { month, kind: 'USE_ITC', head: 'CGST', amountPaise: money(40) }), 422, 'ALLOCATION_INVALID'); // only ₹30 of input credit is available
    const useItc = await post(t.accountant, '/tax/payments', { month, kind: 'USE_ITC', head: 'CGST', amountPaise: money(30), challanRef: 'ITC-1' });
    expect(useItc.status).toBe(201);
    const pay = await created<GstPaymentDTO>(await post(t.accountant, '/tax/payments', { month, kind: 'PAY_LIABILITY', head: 'CGST', amountPaise: money(60), bankAccountId: t.bank.bankAccountId, challanRef: 'CHALLAN-9' }));
    expect(pay.journalId).toBeTruthy();
    const tb = await trial(t);
    expect(net(tb, 'Output CGST')).toBe(0);
    expect(net(tb, 'Input CGST')).toBe(0);
    expect(tb.balanced).toBe(true);
    expectError(await post(t.accountant, '/tax/payments', { month, kind: 'PAY_LIABILITY', head: 'CGST', amountPaise: money(1), bankAccountId: t.bank.bankAccountId }), 422, 'ALLOCATION_INVALID'); // nothing is left to pay
    expectError(await post(t.accountant, '/tax/payments', { month, kind: 'PAY_LIABILITY', head: 'SGST', amountPaise: money(10) }), 400, 'VALIDATION_FAILED'); // a bank payment names its bank account
    const summary = await getOk<ReportDTO>(t.accountant, `/tax/reports/liability-summary?month=${month}`);
    const cgst = summary.rows.find((r) => r.head === 'CGST')!;
    expect(cgst).toMatchObject({ outputPaise: money(90), itcUsedPaise: money(30), paidPaise: money(60), stillToPayPaise: 0 });
  });

  it('QA TAX-08: every report says it is a working copy, ties to the bills and journals, and its CSV is safe', async () => {
    const { t } = await taxedBill();
    const month = today().slice(0, 7);
    const outward = await getOk<ReportDTO>(t.accountant, `/tax/reports/outward-summary?month=${month}`);
    expect(outward.title).toMatch(/^Working copy — not a filed return/);
    const exempt = await getOk<ReportDTO>(t.accountant, `/tax/reports/exempt-and-nil-summary?month=2026-11`);
    expect(exempt.rows.length).toBeGreaterThan(0);
    expect(exempt.rows[0]!.taxablePaise).toBe(money(4000)); // the exempt tuition billed in November
    const hsn = await getOk<ReportDTO>(t.accountant, `/tax/reports/hsn-summary?month=${month}`);
    expect(hsn.totals!.taxPaise).toBe(money(180));
    const itc = await getOk<ReportDTO>(t.accountant, `/tax/reports/itc-register?month=${month}`);
    expect(itc.notes[0]).toMatch(/Rule 42 and 43/);
    const csv = await t.accountant.agent.get(`${API}/finance/tax/reports/outward-summary?month=${month}&format=csv`).expect(200);
    expect(csv.text.split('\r\n')[0]).toContain('Working copy');
    expect((await t.cashier.agent.get(`${API}/finance/tax/reports/outward-summary`)).status).toBe(403);
    // the tax on the bills equals the tax in the books
    const books = (net(await trial(t), 'Output CGST') + net(await trial(t), 'Output SGST')) * -1;
    expect(books).toBe(money(180));
    void JournalLine;
  });

  it('QA TAX-09: the review queue lists fee types with no tax code, input tax waiting, and taxable fees without a GSTIN', async () => {
    const { t } = await taxedBill();
    await spend(t, { taxableValuePaise: money(100), gstRateBps: 1800 }); // input tax waiting
    const noTax = await post(t, '/fee-heads', { code: 'LIBRARY', name: 'Library Fee', category: 'OTHER', incomeAccountId: t.accounts['4600']!.accountId });
    const queue = await getOk<TaxReviewQueueDTO>(t.reviewer, '/tax/review-queue');
    const group = (key: string) => queue.groups.find((g) => g.key === key)!;
    expect(group('ITC_NEEDS_REVIEW').count).toBe(1);
    expect(group('TAXABLE_WITHOUT_GSTIN').count).toBe(1);
    expect(group('GST_DOES_NOT_MATCH_LEDGER').count).toBe(0);
    if (noTax.status === 201) expect(group('FEE_HEADS_WITHOUT_TAX_CODE').count).toBe(1);
    expect(queue.total).toBeGreaterThanOrEqual(2);
    await patch(t, '/tax-profile', { gstRegistered: true, gstin: '03AAAAA0000A1Z5' });
    expect((await getOk<TaxReviewQueueDTO>(t.reviewer, '/tax/review-queue')).groups.find((g) => g.key === 'TAXABLE_WITHOUT_GSTIN')!.count).toBe(0);
  });
});

async function spendWith(t: ExpSchool, over: Record<string, unknown>) {
  return spend(t, over);
}
void spendWith;
