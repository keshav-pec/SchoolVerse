import { describe, expect, it } from 'vitest';
import type { AdjustmentResultDTO, ExpenseCategoryDTO, ExpenseDTO, FeeDocumentDTO, GstPaymentDTO, PayablesAgingDTO, ReportDTO, TaxReviewQueueDTO, TrialBalanceDTO, VendorBillDTO, VendorDTO, VendorPaymentDTO } from '@shared';
import { JournalEntry, JournalLine } from '../src/modules/finance/core/models';
import { Expense } from '../src/modules/finance/accounting/models';
import { API, expectError, today, useTestDatabase } from './helpers';
import { billOf, created, enrolled, getOk, issueMonth, money, moneySchool, ok, post, patch, staffWith, type MoneySchool } from './finance-helpers';

useTestDatabase();

const trial = (t: MoneySchool) => getOk<TrialBalanceDTO>(t, '/trial-balance');
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
