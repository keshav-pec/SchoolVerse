import { createHash, randomUUID } from 'node:crypto';
import type { CloseCheckDTO, CloseReadinessDTO, ClosedPeriodDTO, JournalDTO, OpeningPreviewDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { parseCsv } from '../../../platform/identity/csv';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { Employee } from '../../staff/employee.model';
import { Location } from '../../locations/location.model';
import { todayFor } from '../../staff/status';
import { StudentAdmission } from '../../students/student.models';
import { BankStatementLine } from '../banking/models';
import { Collection, CashierShift, PaymentClaim, RefundRequest } from '../collections/models';
import { issueOpeningBill } from '../collections/extras.service';
import { checkApproval, consumeApproval } from '../core/approvals.service';
import { rolesMap } from '../core/chart.service';
import { auditFinance, emitFinance, financeCtx, monthRange, type FinanceCtx } from '../core/context';
import { AccountingPeriod, ChartAccount, JournalLine, type AccountingPeriodDoc, type ChartAccountDoc } from '../core/models';
import { formatMoney, toPaise } from '../core/money';
import { postJournal } from '../core/posting';
import { BillingRun, StudentLedgerEntry } from '../fees/models';
import { Advance, PayrollRun } from '../payroll/models';
import { DisbursementItem } from '../payroll/models';
import { Expense, OpeningBatch, TaxLine, Vendor, VendorBill, CloseRun, type OpeningBatchDoc, type VendorDoc } from './models';

/**
 * Opening balances, hand-made journals and closing a month (FIN-15, 18).
 *
 * The close check is the "review" step of closing: it lists everything still open for the month, each with a count, a level (BLOCKER or
 * WARNING) and where to fix it. A month closes only with no blockers and a second person's approval. A closed month rejects new
 * entries dated inside it. Reopening needs approval and a reason, and a locked month can never be reopened.
 */

// ───────────────────────────────────────────────────────────── opening balances (FIN-18)

interface OpeningRow { row: number; kind: 'ACCOUNT' | 'STUDENT' | 'VENDOR' | 'ADVANCE'; ref: string; debit: number; credit: number }

export async function parseOpening(f: FinanceCtx, text: string): Promise<{ rows: OpeningRow[]; problems: { row: number; message: string }[]; accounts: Map<string, ChartAccountDoc>; students: Map<string, string>; vendors: Map<string, VendorDoc>; employees: Map<string, string> }> {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = (n: string) => header.indexOf(n);
  if (col('kind') < 0 || col('reference') < 0 || col('debit') < 0 || col('credit') < 0) throw new AppError('IMPORT_INVALID', 'The file needs these columns: kind, reference, debit, credit.');
  const [accounts, admissions, vendors, employees] = await Promise.all([
    ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ChartAccountDoc[]>(),
    StudentAdmission.find({ tenantId: f.tenantId, isCurrent: true }).select('studentId admissionNumber').lean<{ studentId: string; admissionNumber: string }[]>(),
    Vendor.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<VendorDoc[]>(),
    Employee.find({ tenantId: f.tenantId }).select('_id employeeCode').lean<{ _id: string; employeeCode: string }[]>(),
  ]);
  const acc = new Map(accounts.map((a) => [a.code, a]));
  const stu = new Map(admissions.map((a) => [a.admissionNumber.toLowerCase(), a.studentId]));
  const ven = new Map(vendors.map((v) => [v.name.toLowerCase(), v]));
  const emp = new Map(employees.map((e) => [e.employeeCode.toLowerCase(), e._id]));
  const rows: OpeningRow[] = [];
  const problems: { row: number; message: string }[] = [];
  const seen = new Set<string>();
  table.slice(1).forEach((r, i) => {
    const row = i + 2;
    const kind = (r[col('kind')] ?? '').toUpperCase() as OpeningRow['kind'];
    const ref = (r[col('reference')] ?? '').trim();
    const debit = (r[col('debit')] ?? '').trim() === '' ? 0 : toPaise(r[col('debit')]!);
    const credit = (r[col('credit')] ?? '').trim() === '' ? 0 : toPaise(r[col('credit')]!);
    if (!['ACCOUNT', 'STUDENT', 'VENDOR', 'ADVANCE'].includes(kind)) return void problems.push({ row, message: `The kind "${r[col('kind')] ?? ''}" is not ACCOUNT, STUDENT, VENDOR or ADVANCE.` });
    if (debit === null || credit === null) return void problems.push({ row, message: 'An amount is not a valid amount.' });
    if (debit > 0 && credit > 0) return void problems.push({ row, message: 'A row has either a debit or a credit, not both.' });
    if (debit === 0 && credit === 0) return void problems.push({ row, message: 'A row needs an amount.' });
    const key = `${kind}:${ref.toLowerCase()}`;
    if (seen.has(key)) return void problems.push({ row, message: `"${ref}" appears twice.` });
    seen.add(key);
    if (kind === 'ACCOUNT') {
      const a = acc.get(ref);
      if (!a) return void problems.push({ row, message: `Account code "${ref}" was not found.` });
      if (!a.isPostable || a.status !== 'ACTIVE') return void problems.push({ row, message: `Account ${ref} cannot take entries.` });
      if (a.systemRole === 'STUDENT_RECEIVABLE') return void problems.push({ row, message: 'Student fees owed are imported as STUDENT rows, one per student, so each child has their own account.' });
      if (a.systemRole === 'VENDOR_PAYABLE') return void problems.push({ row, message: 'Vendor payables are imported as VENDOR rows.' });
    } else if (kind === 'STUDENT') {
      if (!stu.has(ref.toLowerCase())) return void problems.push({ row, message: `Admission number "${ref}" was not found.` });
      if (credit > 0) return void problems.push({ row, message: 'A student row is an amount the family owes (a debit).' });
    } else if (kind === 'VENDOR') {
      if (!ven.has(ref.toLowerCase())) return void problems.push({ row, message: `Vendor "${ref}" was not found. Add the vendor first.` });
      if (debit > 0) return void problems.push({ row, message: 'A vendor row is an amount the school owes (a credit).' });
    } else {
      if (!emp.has(ref.toLowerCase())) return void problems.push({ row, message: `Employee code "${ref}" was not found.` });
      if (credit > 0) return void problems.push({ row, message: 'An advance row is an amount the employee owes the school (a debit).' });
    }
    rows.push({ row, kind, ref, debit, credit });
  });
  return { rows, problems, accounts: acc, students: stu, vendors: ven, employees: emp };
}

const openingPreview = (rows: OpeningRow[], problems: { row: number; message: string }[], hash: string, committed: boolean, total: number): OpeningPreviewDTO => {
  const accountDebit = rows.filter((r) => r.kind === 'ACCOUNT').reduce((s, r) => s + r.debit, 0);
  const accountCredit = rows.filter((r) => r.kind === 'ACCOUNT').reduce((s, r) => s + r.credit, 0);
  const problemsAll = [...problems, ...(accountDebit !== accountCredit ? [{ row: 0, message: `The account rows do not balance: debits ${formatMoney(accountDebit)}, credits ${formatMoney(accountCredit)}.` }] : [])];
  return { rows: total, problems: problemsAll, accountDebitPaise: accountDebit, accountCreditPaise: accountCredit, studentPaise: rows.filter((r) => r.kind === 'STUDENT').reduce((s, r) => s + r.debit, 0), vendorPaise: rows.filter((r) => r.kind === 'VENDOR').reduce((s, r) => s + r.credit, 0), advancePaise: rows.filter((r) => r.kind === 'ADVANCE').reduce((s, r) => s + r.debit, 0), balanced: accountDebit === accountCredit, fileHash: hash, committed };
};

export async function previewOpening(ctx: ServiceContext, file: Buffer | undefined): Promise<OpeningPreviewDTO> {
  if (!file) throw AppError.validation({ file: 'Choose a CSV file.' });
  const f = await financeCtx(ctx);
  const text = file.toString('utf8');
  const parsed = await parseOpening(f, text);
  return openingPreview(parsed.rows, parsed.problems, createHash('sha256').update(text).digest('hex'), Boolean(await OpeningBatch.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId })), parsed.rows.length + parsed.problems.length);
}

/** Posts the go-live balances once. A second, different file is refused; the same file again changes nothing. */
export async function commitOpening(ctx: ServiceContext, data: { asOf: string }, file: Buffer | undefined): Promise<OpeningPreviewDTO> {
  if (!file) throw AppError.validation({ file: 'Choose a CSV file.' });
  const f = await financeCtx(ctx);
  const text = file.toString('utf8');
  const hash = createHash('sha256').update(text).digest('hex');
  const existing = await OpeningBatch.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<OpeningBatchDoc>();
  const parsed = await parseOpening(f, text);
  if (existing) {
    if (existing.fileHash === hash) return openingPreview(parsed.rows, [], hash, true, parsed.rows.length);
    throw new AppError('OPENING_ALREADY_POSTED');
  }
  const preview = openingPreview(parsed.rows, parsed.problems, hash, false, parsed.rows.length + parsed.problems.length);
  if (preview.problems.length > 0) throw new AppError('IMPORT_INVALID', `${preview.problems.length} problem${preview.problems.length === 1 ? '' : 's'} found. Nothing was posted.`, { problems: preview.problems.slice(0, 20) });
  try {
    await withTransaction(async (db) => {
      const roles = await rolesMap(f, db);
      const equity = roles.get('OPENING_EQUITY');
      const primary = (await Location.findOne({ tenantId: f.tenantId, isPrimary: true }).session(db).select('_id').lean<{ _id: string }>()) ?? { _id: '' };
      if (!equity) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts has no opening balance account. Use the standard chart in Finance Settings.');
      await OpeningBatch.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, fileHash: hash, asOf: data.asOf, accountLines: parsed.rows.filter((r) => r.kind === 'ACCOUNT').length, students: parsed.rows.filter((r) => r.kind === 'STUDENT').length, vendors: parsed.rows.filter((r) => r.kind === 'VENDOR').length, advances: parsed.rows.filter((r) => r.kind === 'ADVANCE').length, postedBy: ctx.userId }], { session: db });
      const accountRows = parsed.rows.filter((r) => r.kind === 'ACCOUNT');
      if (accountRows.length) await postJournal(f, db, { eventType: 'opening.balance', sourceKey: 'opening:accounts', accountingDate: data.asOf, memo: 'Opening balances brought forward', sourceType: 'opening', sourceId: 'accounts', lines: accountRows.map((r) => ({ accountId: parsed.accounts.get(r.ref)!._id, debitPaise: r.debit, creditPaise: r.credit })) });
      for (const r of parsed.rows.filter((x) => x.kind === 'STUDENT')) await issueOpeningBill(f, db, { studentId: parsed.students.get(r.ref.toLowerCase())!, amountPaise: r.debit, asOf: data.asOf });
      for (const r of parsed.rows.filter((x) => x.kind === 'VENDOR')) {
        const vendor = parsed.vendors.get(r.ref.toLowerCase())!;
        const id = randomUUID();
        const { journal } = await postJournal(f, db, { eventType: 'opening.balance', sourceKey: `opening:vendor:${vendor._id}`, accountingDate: data.asOf, memo: `Opening balance owed to ${vendor.name}`, sourceType: 'vendor_bill', sourceId: id, lines: [{ accountId: equity._id, debitPaise: r.credit }, { accountId: roles.get('VENDOR_PAYABLE')!._id, creditPaise: r.credit, vendorId: vendor._id }] });
        await VendorBill.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, number: `OPENING-${vendor._id.slice(0, 8)}`, vendorId: vendor._id, vendorBillNumber: 'OPENING', state: 'POSTED', date: data.asOf, dueDate: data.asOf, locationId: primary._id, lines: [], taxableValuePaise: r.credit, totalPaise: r.credit, balancePaise: r.credit, journalId: journal._id, createdBy: ctx.userId }], { session: db });
      }
      for (const r of parsed.rows.filter((x) => x.kind === 'ADVANCE')) {
        const employeeId = parsed.employees.get(r.ref.toLowerCase())!;
        const id = randomUUID();
        const { journal } = await postJournal(f, db, { eventType: 'opening.balance', sourceKey: `opening:advance:${employeeId}`, accountingDate: data.asOf, memo: 'Opening balance of a salary advance', sourceType: 'employee_advance', sourceId: id, lines: [{ accountId: roles.get('EMPLOYEE_ADVANCE')!._id, debitPaise: r.debit, employeeId }, { accountId: equity._id, creditPaise: r.debit }] });
        await Advance.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, employeeId, principalPaise: r.debit, installments: 1, installmentPaise: r.debit, remainingPaise: r.debit, startMonth: data.asOf.slice(0, 7), state: 'PAID_OUT', reason: 'Opening balance', requestedBy: ctx.userId, approvedBy: ctx.userId, paidOn: data.asOf, paidJournalId: journal._id }], { session: db });
      }
      await auditFinance(f, db, { action: 'opening_balances.posted', entityType: 'opening_balance', entityId: hash.slice(0, 16), after: { asOf: data.asOf, rows: parsed.rows.length } });
    });
  } catch (err) {
    if (duplicateKeyFields(err)) throw new AppError('OPENING_ALREADY_POSTED');
    throw err;
  }
  return openingPreview(parsed.rows, [], hash, true, parsed.rows.length);
}

export async function openingPosted(f: FinanceCtx): Promise<boolean> {
  return Boolean(await OpeningBatch.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }));
}

// ───────────────────────────────────────────────────────────── a hand-made journal (always needs approval)

export async function postManualJournal(ctx: ServiceContext, data: { accountingDate: string; memo: string; reason: string; lines: { accountId: string; debitPaise: number; creditPaise: number; locationId?: string | undefined }[]; approvalId?: string | undefined }): Promise<JournalDTO> {
  const f = await financeCtx(ctx);
  const debit = data.lines.reduce((s, l) => s + l.debitPaise, 0);
  const credit = data.lines.reduce((s, l) => s + l.creditPaise, 0);
  if (data.lines.some((l) => l.debitPaise > 0 && l.creditPaise > 0)) throw AppError.validation({ lines: 'A line is either money in or money out, not both.' });
  if (debit !== credit) throw new AppError('JOURNAL_UNBALANCED', undefined, { debitPaise: debit, creditPaise: credit });
  // The approval is for these exact lines: the hash is the "entity" it was given for, so changing a line after approval needs a new approval.
  const hash = createHash('sha256').update(JSON.stringify([data.accountingDate, data.lines.map((l) => [l.accountId, l.debitPaise, l.creditPaise, l.locationId ?? null]).sort()])).digest('hex');
  const approval = await checkApproval(f, { action: 'MANUAL_JOURNAL', entityType: 'manual_journal', entityId: hash, amountPaise: debit, reason: data.reason, approvalId: data.approvalId, summary: `Manual entry of ${formatMoney(debit)}: ${data.memo}`, impact: 'This puts money straight into the accounts. It is marked "Manual" in every report.' });
  const result = await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    const { journal } = await postJournal(f, db, { eventType: 'manual', sourceKey: `manual:${randomUUID()}`, accountingDate: data.accountingDate, memo: `Manual: ${data.memo}`, sourceType: 'manual', sourceId: hash.slice(0, 16), lines: data.lines.map((l) => ({ accountId: l.accountId, debitPaise: l.debitPaise, creditPaise: l.creditPaise, locationId: l.locationId ?? null })) });
    await auditFinance(f, db, { action: 'journal.manual_posted', entityType: 'journal', entityId: journal._id, after: { number: journal.number, totalPaise: debit, reason: data.reason }, metadata: { approvalId: approval?._id ?? null } });
    return journal;
  });
  const { getJournal } = await import('../core/journal.service');
  return getJournal(ctx, result._id);
}

// ───────────────────────────────────────────────────────────── is this month ready to close? (FIN-15, FUX-13)

async function loadPeriod(f: FinanceCtx, id: string): Promise<AccountingPeriodDoc> {
  const p = await AccountingPeriod.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<AccountingPeriodDoc>();
  if (!p) throw AppError.notFound('Accounting period not found.');
  return p;
}

export async function closeReadiness(ctx: ServiceContext, periodId: string): Promise<CloseReadinessDTO> {
  const f = await financeCtx(ctx);
  const p = await loadPeriod(f, periodId);
  const t = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  const key = p.startDate.slice(0, 7);
  const next = new Date(new Date(`${p.endDate}T00:00:00Z`).getTime() + 86_400_000);
  const within = { $gte: p.startDate, $lte: p.endDate };
  const [unbalanced, billing, collections, claims, bank, shifts, payrollOpen, unverified, refunds, expenses, bills, itc, advances, unpaidRuns] = await Promise.all([
    JournalLine.aggregate<{ _id: string; d: number; c: number }>([{ $match: { ...t, accountingDate: within } }, { $group: { _id: '$journalId', d: { $sum: '$debitPaise' }, c: { $sum: '$creditPaise' } } }, { $match: { $expr: { $ne: ['$d', '$c'] } } }]),
    BillingRun.countDocuments({ ...t, periodKey: key, state: { $in: ['DRAFT', 'VALIDATED', 'APPROVED'] } }),
    Collection.countDocuments({ ...t, receivedOn: within, status: { $in: ['PENDING_VERIFICATION', 'RECEIVED', 'DEPOSITED'] } }),
    PaymentClaim.countDocuments({ ...t, paidOn: within, status: { $in: ['PENDING_VERIFICATION', 'REPORTED'] }, collectionId: null }),
    BankStatementLine.countDocuments({ ...t, date: within, status: { $in: ['UNMATCHED', 'SUGGESTED', 'DUPLICATE_SUSPECTED', 'PARTIAL', 'VARIANCE'] } }),
    CashierShift.countDocuments({ ...t, openedAt: { $gte: new Date(`${p.startDate}T00:00:00Z`), $lt: next }, $or: [{ state: 'OPEN' }, { state: 'CLOSED', variancePaise: { $ne: 0 } }] }),
    PayrollRun.countDocuments({ ...t, month: key, type: 'MONTHLY', state: { $in: ['DRAFT', 'CALCULATED', 'APPROVED'] } }),
    DisbursementItem.countDocuments({ ...t, status: 'PAID', verified: false, paidOn: within }),
    RefundRequest.countDocuments({ ...t, state: 'APPROVED', approvedAt: { $gte: new Date(`${p.startDate}T00:00:00Z`), $lt: next } }),
    Expense.countDocuments({ ...t, date: within, state: 'PENDING' }),
    VendorBill.countDocuments({ ...t, date: within, state: 'PENDING' }),
    TaxLine.countDocuments({ ...t, month: key, voided: false, itcStatus: 'NEEDS_REVIEW' }),
    StudentLedgerEntry.aggregate<{ _id: string; sum: number }>([{ $match: { ...t, kind: { $in: ['ADVANCE_IN', 'ADVANCE_USED', 'REFUND'] }, date: { $lte: p.endDate } } }, { $group: { _id: '$studentId', sum: { $sum: '$amountPaise' } } }, { $match: { sum: { $lt: 0 } } }]),
    PayrollRun.countDocuments({ ...t, month: key, type: 'MONTHLY', state: 'FINALIZED', payoutStatus: { $ne: 'PAID' } }),
  ]);
  const check = (k: string, title: string, level: CloseCheckDTO['level'], count: number, one: string, many: string, fix: CloseCheckDTO['fix']): CloseCheckDTO => ({ key: k, title, level, count, sentence: count === 0 ? 'All clear.' : count === 1 ? one : many.replace('{n}', String(count)), fix: count === 0 ? null : fix });
  const checks: CloseCheckDTO[] = [
    check('UNBALANCED_JOURNALS', 'Entries that do not balance', 'BLOCKER', unbalanced.length, '1 entry does not balance. This must never happen: contact support.', '{n} entries do not balance. This must never happen: contact support.', { label: 'Open Journals', path: '/finance/accounting' }),
    check('BILLING_NOT_ISSUED', 'Billing not issued', 'BLOCKER', billing, '1 billing run for this month was not issued.', '{n} billing runs for this month were not issued.', { label: 'Open Billing', path: '/finance/fees?tab=billing' }),
    check('PAYMENTS_WAITING', 'Payments waiting to be checked', 'BLOCKER', collections + claims, '1 payment is still waiting to be verified.', '{n} payments are still waiting to be verified.', { label: 'Verify Payments', path: '/finance/collect' }),
    check('BANK_ITEMS', 'Bank lines not matched', 'BLOCKER', bank, '1 bank line is not matched.', '{n} bank lines are not matched.', { label: 'Open Bank Matching', path: '/finance/banking' }),
    check('CASH_SHIFTS', 'Cash shifts', 'BLOCKER', shifts, '1 cash shift is open or has a cash difference nobody signed off.', '{n} cash shifts are open or have a cash difference nobody signed off.', { label: 'Open Cash Shifts', path: '/finance/collect?tab=shifts' }),
    check('PAYROLL_NOT_FINAL', 'Payroll not finalised', 'BLOCKER', payrollOpen, '1 payroll run for this month is not finalised.', '{n} payroll runs for this month are not finalised.', { label: 'Open Payroll', path: '/finance/payroll' }),
    check('SALARY_PAYOUTS', 'Salary payments not verified', 'BLOCKER', unverified, '1 salary payment is recorded but not verified.', '{n} salary payments are recorded but not verified.', { label: 'Verify Payments', path: '/finance/payroll?tab=payments' }),
    check('REFUNDS_UNPAID', 'Refunds approved but not paid', 'BLOCKER', refunds, '1 refund is approved but not paid.', '{n} refunds are approved but not paid.', { label: 'Open Refunds', path: '/finance/collect?tab=refunds' }),
    check('EXPENSES_WAITING', 'Expenses and bills waiting', 'BLOCKER', expenses + bills, '1 expense or vendor bill is waiting for approval.', '{n} expenses or vendor bills are waiting for approval.', { label: 'Open Expenses', path: '/finance/expenses' }),
    check('ITC_REVIEW', 'Input tax waiting for a decision', 'BLOCKER', itc, '1 input tax line needs a decision.', '{n} input tax lines need a decision.', { label: 'Open Tax', path: '/finance/tax' }),
    check('SALARY_NOT_PAID', 'Salary not fully paid yet', 'WARNING', unpaidRuns, 'This month\'s salary is not fully paid yet.', '{n} salary runs are not fully paid yet.', { label: 'Open Payroll', path: '/finance/payroll?tab=payments' }),
    check('ADVANCES_UNAPPLIED', 'Advances not yet applied', 'INFO', advances.length, '1 student has an advance that is not applied to a bill.', '{n} students have an advance that is not applied to a bill.', { label: 'Open Student Accounts', path: '/finance/fees?tab=accounts' }),
  ];
  const blockers = checks.filter((c) => c.level === 'BLOCKER').reduce((s, c) => s + c.count, 0);
  const warnings = checks.filter((c) => c.level === 'WARNING').reduce((s, c) => s + c.count, 0);
  const noun: Record<string, [string, string]> = { BANK_ITEMS: ['bank item', 'bank items'], SALARY_PAYOUTS: ['salary payout', 'salary payouts'], REFUNDS_UNPAID: ['refund', 'refunds'], CASH_SHIFTS: ['cash variance', 'cash variances'], PAYMENTS_WAITING: ['payment to verify', 'payments to verify'], EXPENSES_WAITING: ['expense to approve', 'expenses to approve'], BILLING_NOT_ISSUED: ['billing run', 'billing runs'], PAYROLL_NOT_FINAL: ['payroll run', 'payroll runs'], ITC_REVIEW: ['tax decision', 'tax decisions'], UNBALANCED_JOURNALS: ['unbalanced entry', 'unbalanced entries'] };
  const order = ['BANK_ITEMS', 'SALARY_PAYOUTS', 'REFUNDS_UNPAID', 'CASH_SHIFTS'];
  const rank = (k: string) => (order.includes(k) ? order.indexOf(k) : order.length);
  const parts = checks.filter((c) => c.level === 'BLOCKER' && c.count > 0).sort((a, b) => rank(a.key) - rank(b.key)).map((c) => `${c.count} ${noun[c.key]![c.count === 1 ? 0 : 1]}`);
  const monthLabel = new Date(`${p.startDate}T00:00:00Z`).toLocaleString('en-IN', { month: 'long', timeZone: 'UTC' });
  return {
    periodId: p._id, periodCode: p.code, state: p.state, checks, blockers, warnings,
    headline: parts.length ? `${monthLabel} close: ${parts.join(' + ')} = ${blockers} need attention.` : `${monthLabel} close: nothing needs attention.${warnings ? ` ${warnings} warning${warnings === 1 ? '' : 's'} can be accepted with a reason.` : ''}`,
    canClose: p.state === 'OPEN' && blockers === 0,
    ...(p.state === 'OPEN' ? { closedByName: null, closedAt: null } : await periodDTO(f, p).then((d) => ({ closedByName: d.closedByName, closedAt: d.closedAt }))),
  };
}

const periodDTO = async (f: FinanceCtx, p: AccountingPeriodDoc): Promise<ClosedPeriodDTO> => {
  const last = await CloseRun.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, periodId: p._id }).sort({ createdAt: -1 }).lean<{ doneBy: string; warningReason: string | null; createdAt: Date }>();
  const user = last ? await User.findOne({ _id: last.doneBy, tenantId: f.tenantId }).select('fullName').lean<{ fullName: string }>() : null;
  return { periodId: p._id, periodCode: p.code, state: p.state, closedByName: user?.fullName ?? null, closedAt: p.stateChangedAt ? p.stateChangedAt.toISOString() : null, warningReason: last?.warningReason ?? null };
};

export async function closePeriod(ctx: ServiceContext, periodId: string, data: { warningReason?: string | null | undefined; approvalId?: string | undefined }): Promise<ClosedPeriodDTO> {
  const f = await financeCtx(ctx);
  const p = await loadPeriod(f, periodId);
  if (p.state !== 'OPEN') throw new AppError('CONFLICT', p.state === 'LOCKED' ? 'This month is locked.' : 'This month is already closed.');
  const readiness = await closeReadiness(ctx, periodId);
  if (readiness.blockers > 0) throw new AppError('CLOSE_BLOCKED', readiness.headline, { blockers: readiness.blockers, checks: readiness.checks.filter((c) => c.level === 'BLOCKER' && c.count > 0) });
  if (readiness.warnings > 0 && !data.warningReason) throw AppError.validation({ warningReason: 'Write why you are closing with open warnings.' });
  const approval = await checkApproval(f, { action: 'PERIOD_CLOSE', entityType: 'accounting_period', entityId: periodId, amountPaise: 0, reason: data.warningReason ?? null, approvalId: data.approvalId, summary: `Close ${p.code}`, impact: 'No new entries can be dated in this month. A mistake is fixed in the next open month.' });
  await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    const res = await AccountingPeriod.updateOne({ _id: periodId, tenantId: f.tenantId, state: 'OPEN' }, { $set: { state: 'CLOSED', stateChangedAt: new Date(), stateChangedBy: ctx.userId } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This month was just closed by someone else.');
    await CloseRun.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, periodId, periodCode: p.code, action: 'CLOSE', checks: readiness.checks.map((c) => ({ key: c.key, level: c.level, count: c.count })), warningReason: data.warningReason ?? null, approvalId: approval?._id ?? null, doneBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'accounting_period.closed', entityType: 'accounting_period', entityId: periodId, after: { code: p.code, warnings: readiness.warnings, warningReason: data.warningReason ?? null } });
    await emitFinance(f, db, 'accounting.period.closed', { periodId, code: p.code });
  });
  return periodDTO(f, await loadPeriod(f, periodId));
}

export async function reopenPeriod(ctx: ServiceContext, periodId: string, data: { reason: string; approvalId?: string | undefined }): Promise<ClosedPeriodDTO> {
  const f = await financeCtx(ctx);
  const p = await loadPeriod(f, periodId);
  if (p.state === 'LOCKED') throw new AppError('PERIOD_LOCKED');
  if (p.state !== 'CLOSED') throw new AppError('PERIOD_NOT_CLOSED');
  const approval = await checkApproval(f, { action: 'PERIOD_REOPEN', entityType: 'accounting_period', entityId: periodId, amountPaise: 0, reason: data.reason, approvalId: data.approvalId, summary: `Reopen ${p.code}`, impact: 'New entries can be dated in this month again. The reopening is written in the audit trail.' });
  await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    const res = await AccountingPeriod.updateOne({ _id: periodId, tenantId: f.tenantId, state: 'CLOSED' }, { $set: { state: 'OPEN', stateChangedAt: new Date(), stateChangedBy: ctx.userId } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This month changed just now.');
    await CloseRun.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, periodId, periodCode: p.code, action: 'REOPEN', reason: data.reason, approvalId: approval?._id ?? null, doneBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'accounting_period.reopened', entityType: 'accounting_period', entityId: periodId, after: { code: p.code, reason: data.reason } });
    await emitFinance(f, db, 'accounting.period.reopened', { periodId, code: p.code });
  });
  return periodDTO(f, await loadPeriod(f, periodId));
}

export async function lockPeriod(ctx: ServiceContext, periodId: string): Promise<ClosedPeriodDTO> {
  const f = await financeCtx(ctx);
  const p = await loadPeriod(f, periodId);
  if (p.state === 'LOCKED') throw new AppError('PERIOD_LOCKED');
  if (p.state !== 'CLOSED') throw new AppError('PERIOD_NOT_CLOSED', 'Close the month first. Only a closed month can be locked.');
  await withTransaction(async (db) => {
    const res = await AccountingPeriod.updateOne({ _id: periodId, tenantId: f.tenantId, state: 'CLOSED' }, { $set: { state: 'LOCKED', stateChangedAt: new Date(), stateChangedBy: ctx.userId } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This month changed just now.');
    await CloseRun.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, periodId, periodCode: p.code, action: 'LOCK', doneBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'accounting_period.locked', entityType: 'accounting_period', entityId: periodId, after: { code: p.code } });
  });
  return periodDTO(f, await loadPeriod(f, periodId));
}

export async function firstCloseDone(f: FinanceCtx): Promise<boolean> {
  return Boolean(await CloseRun.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'CLOSE' }));
}

export { monthRange, todayFor };
