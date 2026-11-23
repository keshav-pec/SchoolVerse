import type { ReportDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { Location } from '../../locations/location.model';
import { todayFor } from '../../staff/status';
import { Collection, type CollectionDoc } from '../collections/models';
import { ReconciliationMatch } from '../banking/models';
import { assertInScope, auditFinance, financeCtx, financeScope, type FinanceCtx } from '../core/context';
import { BankAccount, CashAccount, ChartAccount, JournalLine, type BankAccountDoc, type CashAccountDoc, type ChartAccountDoc } from '../core/models';
import { generalLedger, trialBalance } from '../core/journal.service';
import { BASIS, makeReport, reportCsv, sumRows } from '../core/report';
import { outstanding } from '../fees/account.service';
import { FeeDocument, FeeDocumentLine, FeeHead, type FeeDocumentDoc, type FeeDocumentLineDoc, type FeeHeadDoc } from '../fees/models';
import { payablesAging } from './expense.service';

/**
 * The financial reports (FIN-16, 17). Each states its basis: "Based on posted journals (accrual)" or "Operational view". What was billed, what was
 * verified as received, what is waiting and what is matched with the bank are different things, so they are never added together. A CSV needs the
 * export permission, is audited, and a cell that starts with `= + - @` is escaped so a spreadsheet never runs it as a formula.
 */

interface Q { from?: string | null | undefined; to?: string | null | undefined; asOf?: string | null | undefined; accountId?: string | undefined; bankAccountId?: string | undefined; locationId?: string | undefined }

const text = (key: string, label: string) => ({ key, label, kind: 'text' as const });
const money = (key: string, label: string) => ({ key, label, kind: 'money' as const });
const date = (key: string, label: string) => ({ key, label, kind: 'date' as const });

async function netByAccount(f: FinanceCtx, scopeLocs: string[] | null, range: { from?: string | null | undefined; to?: string | null | undefined }) {
  const match: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  if (range.from || range.to) match.accountingDate = { ...(range.from ? { $gte: range.from } : {}), ...(range.to ? { $lte: range.to } : {}) };
  if (scopeLocs) match.$or = [{ locationId: null }, { locationId: { $in: scopeLocs } }];
  const totals = await JournalLine.aggregate<{ _id: string; debit: number; credit: number }>([{ $match: match }, { $group: { _id: '$accountId', debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } }]);
  const accounts = new Map((await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: totals.map((t) => t._id) } }).lean<ChartAccountDoc[]>()).map((a) => [a._id, a]));
  return totals.flatMap((t) => { const a = accounts.get(t._id); return a ? [{ account: a, debit: t.debit, credit: t.credit }] : []; }).sort((x, y) => x.account.code.localeCompare(y.account.code));
}

export async function financialReport(ctx: ServiceContext, type: string, query: Q): Promise<ReportDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  if (query.locationId) await assertInScope(ctx, scope, query.locationId, 'report', query.locationId);
  const locs = query.locationId ? [query.locationId] : scope.all ? null : scope.locationIds;
  const today = await todayFor(ctx);
  const asOf = query.asOf ?? query.to ?? today;
  const range = { from: query.from, to: query.to };

  switch (type) {
    case 'trial-balance': {
      const tb = await trialBalance(ctx, { asOf });
      const rows = tb.rows.map((r) => ({ code: r.code, name: r.name, type: r.type, debitPaise: r.debitPaise, creditPaise: r.creditPaise }));
      return makeReport({ type, title: `Trial balance as of ${asOf}`, basis: BASIS.JOURNALS, to: asOf, columns: [text('code', 'Code'), text('name', 'Account'), text('type', 'Type'), money('debitPaise', 'Debit'), money('creditPaise', 'Credit')], rows, totals: { debitPaise: tb.totalDebitPaise, creditPaise: tb.totalCreditPaise }, notes: [tb.balanced ? 'Debits equal credits.' : 'Debits do NOT equal credits. This must never happen: contact support.'] });
    }
    case 'general-ledger': {
      if (!query.accountId) throw AppError.validation({ accountId: 'Choose an account.' });
      const gl = await generalLedger(ctx, { accountId: query.accountId, from: query.from, to: query.to });
      return makeReport({ type, title: `General ledger: ${gl.account.code} ${gl.account.name}`, basis: BASIS.JOURNALS, ...range, columns: [date('date', 'Date'), text('number', 'Entry'), text('memo', 'Description'), money('debitPaise', 'Debit'), money('creditPaise', 'Credit'), money('balancePaise', 'Balance')], rows: gl.rows.map((r) => ({ date: r.date, number: r.number, memo: r.memo, debitPaise: r.debitPaise, creditPaise: r.creditPaise, balancePaise: r.balancePaise })), totals: { balancePaise: gl.closingPaise }, notes: [`Opening balance: ${(gl.openingPaise / 100).toFixed(2)}. Entries marked "Manual" were typed in by hand.`] });
    }
    case 'income-and-expenditure': {
      const rows = (await netByAccount(f, locs, range)).filter((r) => r.account.type === 'INCOME' || r.account.type === 'EXPENSE');
      const out = rows.map((r) => ({ section: r.account.type === 'INCOME' ? 'Income' : 'Expenditure', code: r.account.code, name: r.account.name, amountPaise: r.account.type === 'INCOME' ? r.credit - r.debit : r.debit - r.credit }));
      const income = out.filter((o) => o.section === 'Income').reduce((s, o) => s + o.amountPaise, 0);
      const spend = out.filter((o) => o.section === 'Expenditure').reduce((s, o) => s + o.amountPaise, 0);
      return makeReport({ type, title: 'Income and expenditure', basis: BASIS.JOURNALS, ...range, columns: [text('section', 'Section'), text('code', 'Code'), text('name', 'Account'), money('amountPaise', 'Amount')], rows: out, totals: { incomePaise: income, expenditurePaise: spend, surplusPaise: income - spend }, notes: ['Income is booked when a bill is issued, not when it is paid.'] });
    }
    case 'balance-sheet': {
      const rows = await netByAccount(f, locs, { to: asOf });
      const out = rows.filter((r) => ['ASSET', 'LIABILITY', 'EQUITY'].includes(r.account.type)).map((r) => ({ section: r.account.type === 'ASSET' ? 'Assets' : r.account.type === 'LIABILITY' ? 'Liabilities' : 'Equity', code: r.account.code, name: r.account.name, amountPaise: r.account.type === 'ASSET' ? r.debit - r.credit : r.credit - r.debit }));
      const surplus = rows.filter((r) => r.account.type === 'INCOME').reduce((s, r) => s + r.credit - r.debit, 0) - rows.filter((r) => r.account.type === 'EXPENSE').reduce((s, r) => s + r.debit - r.credit, 0);
      out.push({ section: 'Equity', code: '', name: 'Surplus so far', amountPaise: surplus });
      const assets = out.filter((o) => o.section === 'Assets').reduce((s, o) => s + o.amountPaise, 0);
      const other = out.filter((o) => o.section !== 'Assets').reduce((s, o) => s + o.amountPaise, 0);
      return makeReport({ type, title: `Balance sheet as of ${asOf}`, basis: BASIS.JOURNALS, to: asOf, columns: [text('section', 'Section'), text('code', 'Code'), text('name', 'Account'), money('amountPaise', 'Amount')], rows: out, totals: { assetsPaise: assets, liabilitiesAndEquityPaise: other }, notes: ['Advances and refundable deposits are liabilities: money the school holds for families, not income.'] });
    }
    case 'cashbook':
    case 'bankbook': {
      let ids: string[];
      let name: string;
      if (type === 'cashbook') {
        const cash = await CashAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<CashAccountDoc[]>();
        const role = await ChartAccount.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, systemRole: 'CASH' }).select('_id').lean<{ _id: string }>();
        ids = [...new Set([...cash.map((c) => c.glAccountId), ...(role ? [role._id] : [])])];
        name = 'Cash book';
      } else {
        const banks = await BankAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.bankAccountId ? { _id: query.bankAccountId } : {}) }).lean<BankAccountDoc[]>();
        ids = banks.map((b) => b.glAccountId);
        name = 'Bank book';
      }
      const base: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, accountId: { $in: ids }, ...(locs ? { $or: [{ locationId: null }, { locationId: { $in: locs } }] } : {}) };
      const before = query.from ? await JournalLine.aggregate<{ d: number; c: number }>([{ $match: { ...base, accountingDate: { $lt: query.from } } }, { $group: { _id: null, d: { $sum: '$debitPaise' }, c: { $sum: '$creditPaise' } } }]) : [];
      const lines = await JournalLine.find({ ...base, ...(query.from || query.to ? { accountingDate: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}) }).sort({ accountingDate: 1, createdAt: 1 }).lean<{ journalId: string; accountingDate: string; debitPaise: number; creditPaise: number }[]>();
      const { JournalEntry } = await import('../core/models');
      const entries = new Map((await JournalEntry.find({ tenantId: f.tenantId, _id: { $in: [...new Set(lines.map((l) => l.journalId))] } }).select('number memo').lean<{ _id: string; number: string; memo: string }[]>()).map((e) => [e._id, e]));
      let running = before[0] ? before[0].d - before[0].c : 0;
      const opening = running;
      const out = lines.map((l) => { running += l.debitPaise - l.creditPaise; return { date: l.accountingDate, number: entries.get(l.journalId)?.number ?? '', memo: entries.get(l.journalId)?.memo ?? '', inPaise: l.debitPaise, outPaise: l.creditPaise, balancePaise: running }; });
      return makeReport({ type, title: name, basis: BASIS.JOURNALS, ...range, columns: [date('date', 'Date'), text('number', 'Entry'), text('memo', 'Description'), money('inPaise', 'Money in'), money('outPaise', 'Money out'), money('balancePaise', 'Balance')], rows: out, totals: { inPaise: out.reduce((s, r) => s + r.inPaise, 0), outPaise: out.reduce((s, r) => s + r.outPaise, 0), balancePaise: running }, notes: [`Opening balance: ${(opening / 100).toFixed(2)}.`] });
    }
    case 'ar-aging':
    case 'outstanding': {
      const o = await outstanding(ctx, { asOf: query.asOf ?? undefined, locationId: query.locationId } as never);
      if (type === 'outstanding') {
        return makeReport({ type, title: 'Outstanding fees by class', basis: BASIS.BILLED, to: o.asOf, columns: [text('className', 'Class'), { key: 'students', label: 'Students', kind: 'number' }, money('totalPaise', 'Outstanding')], rows: o.byClass.map((c) => ({ className: c.className, students: c.students, totalPaise: c.totalPaise })), totals: { students: o.byClass.reduce((s, c) => s + c.students, 0), totalPaise: o.totalPaise }, notes: ['Fees that fall due later are not counted as owed.'] });
      }
      const rows = o.rows.map((r) => ({ student: r.studentName, className: r.className, outstandingPaise: r.outstandingPaise, overduePaise: r.overduePaise, oldestDue: r.oldestDueDate, bucket: r.bucket }));
      return makeReport({ type, title: 'Fees receivable aging', basis: BASIS.BILLED, to: o.asOf, columns: [text('student', 'Student'), text('className', 'Class'), money('outstandingPaise', 'Outstanding'), money('overduePaise', 'Overdue'), date('oldestDue', 'Oldest due date'), text('bucket', 'Age')], rows, totals: sumRows(rows, ['outstandingPaise', 'overduePaise']) });
    }
    case 'ap-aging': {
      const a = await payablesAging(ctx, { asOf: query.asOf });
      return makeReport({ type, title: 'Vendor payables aging', basis: BASIS.JOURNALS, to: a.asOf, columns: [text('number', 'Bill'), text('vendorName', 'Vendor'), date('dueDate', 'Due'), money('balancePaise', 'Balance'), text('bucket', 'Age')], rows: a.rows.map((r) => ({ number: r.number, vendorName: r.vendorName, dueDate: r.dueDate, balancePaise: r.balancePaise, bucket: r.bucket })), totals: { balancePaise: a.totalPaise } });
    }
    case 'income-by-fee-head-and-location': {
      const docs = await FeeDocument.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: { $in: ['BILL', 'LATE_FEE', 'DEBIT_NOTE', 'CREDIT_NOTE'] }, ...(query.from || query.to ? { issueDate: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}), ...(locs ? { locationId: { $in: locs } } : {}) }).select('_id kind locationId').lean<Pick<FeeDocumentDoc, '_id' | 'kind' | 'locationId'>[]>();
      const lines = await FeeDocumentLine.find({ tenantId: f.tenantId, documentId: { $in: docs.map((d) => d._id) }, isDeposit: false }).lean<FeeDocumentLineDoc[]>();
      const doc = new Map(docs.map((d) => [d._id, d]));
      const heads = new Map((await FeeHead.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).select('name').lean<Pick<FeeHeadDoc, '_id' | 'name'>[]>()).map((h) => [h._id, h.name]));
      const locations = new Map((await Location.find({ tenantId: f.tenantId }).select('name').lean<{ _id: string; name: string }[]>()).map((l) => [l._id, l.name]));
      const by = new Map<string, { location: string; feeHead: string; incomePaise: number }>();
      for (const l of lines) {
        const d = doc.get(l.documentId)!;
        const key = `${d.locationId}|${l.feeHeadId}`;
        const row = by.get(key) ?? { location: locations.get(d.locationId) ?? 'Campus', feeHead: heads.get(l.feeHeadId) ?? l.description, incomePaise: 0 };
        row.incomePaise += (d.kind === 'CREDIT_NOTE' ? -1 : 1) * l.taxableValuePaise;
        by.set(key, row);
      }
      const out = [...by.values()].sort((a, b) => a.location.localeCompare(b.location) || a.feeHead.localeCompare(b.feeHead));
      return makeReport({ type, title: 'Income by fee type and campus', basis: BASIS.JOURNALS, ...range, columns: [text('location', 'Campus'), text('feeHead', 'Fee type'), money('incomePaise', 'Income (before tax)')], rows: out, totals: sumRows(out, ['incomePaise']), notes: ['Credit notes are taken off. Refundable deposits are not income.'] });
    }
    case 'payroll-expense-and-liability': {
      if (!can(ctx, 'payroll:report:view')) throw new AppError('FORBIDDEN', undefined, { required: ['payroll:report:view'] });
      const roles = ['SALARY_EXPENSE', 'EMPLOYER_CONTRIBUTION_EXPENSE', 'SALARY_PAYABLE', 'PF_PAYABLE', 'ESI_PAYABLE', 'PT_PAYABLE', 'TDS_PAYABLE', 'EMPLOYEE_ADVANCE'];
      const nets = await netByAccount(f, locs, range);
      const out = nets.filter((n) => n.account.systemRole && roles.includes(n.account.systemRole)).map((n) => ({ name: n.account.name, kind: n.account.type === 'EXPENSE' ? 'Expense' : n.account.type === 'ASSET' ? 'Asset' : 'Liability', amountPaise: n.account.type === 'LIABILITY' ? n.credit - n.debit : n.debit - n.credit }));
      return makeReport({ type, title: 'Payroll expense and liability', basis: BASIS.JOURNALS, ...range, columns: [text('name', 'Account'), text('kind', 'Kind'), money('amountPaise', 'Amount')], rows: out, totals: null, notes: ['A salary is a liability (Salary Payable) until a second person verifies the payment.'] });
    }
    case 'collections-summary': {
      const dates = query.from || query.to ? { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } : null;
      const docs = await FeeDocument.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: { $in: ['BILL', 'LATE_FEE', 'DEBIT_NOTE', 'CREDIT_NOTE'] }, ...(dates ? { issueDate: dates } : {}), ...(locs ? { locationId: { $in: locs } } : {}) }).select('kind totalPaise').lean<Pick<FeeDocumentDoc, 'kind' | 'totalPaise'>[]>();
      const cols = await Collection.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(dates ? { receivedOn: dates } : {}), ...(locs ? { locationId: { $in: locs } } : {}) }).lean<CollectionDoc[]>();
      const matched = new Set((await ReconciliationMatch.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, state: 'CONFIRMED' }).select('targets').lean<{ targets: { type: string; id: string }[] }[]>()).flatMap((m) => m.targets.filter((t) => t.type === 'collection').map((t) => t.id)));
      const funded = cols.filter((c) => ['POSTED', 'CLEARED'].includes(c.status));
      const out = [
        { measure: 'Billed (accrual)', amountPaise: docs.reduce((s, d) => s + (d.kind === 'CREDIT_NOTE' ? -d.totalPaise : d.totalPaise), 0), meaning: 'What families were asked to pay. Not money received.' },
        { measure: 'Received and verified', amountPaise: funded.reduce((s, c) => s + c.amountPaise, 0), meaning: 'Cash counted, bank credits seen, cheques cleared.' },
        { measure: 'Waiting to be verified', amountPaise: cols.filter((c) => ['PENDING_VERIFICATION', 'RECEIVED', 'DEPOSITED'].includes(c.status)).reduce((s, c) => s + c.amountPaise, 0), meaning: 'Reported or handed in, but not yet confirmed. Not money yet.' },
        { measure: 'Matched with the bank statement', amountPaise: funded.filter((c) => matched.has(c._id)).reduce((s, c) => s + c.amountPaise, 0), meaning: 'Verified money that also appears on an imported bank statement.' },
      ];
      return makeReport({ type, title: 'Collections summary', basis: BASIS.RECEIVED, ...range, columns: [text('measure', 'Measure'), money('amountPaise', 'Amount'), text('meaning', 'What it means')], rows: out, totals: null, notes: ['These are four different things and are never added together. What is expected later is shown on each student\'s account.'] });
    }
    default:
      throw AppError.notFound('Report not found.');
  }
}

export async function financialReportCsv(ctx: ServiceContext, type: string, query: Q): Promise<string> {
  if (!can(ctx, 'finance:report:export')) throw new AppError('FORBIDDEN', undefined, { required: ['finance:report:export'] });
  const report = await financialReport(ctx, type, query);
  await auditFinance(await financeCtx(ctx), undefined, { action: 'report.exported', entityType: 'finance_report', entityId: type, after: { rows: report.rows.length, from: query.from ?? null, to: query.to ?? null } });
  return reportCsv(report);
}
