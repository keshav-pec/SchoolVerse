import type { FinanceAttentionDTO, FinanceAttentionGroupDTO, FinanceOverviewDTO, SearchResultDTO } from '@shared';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { Person } from '../../staff/person.model';
import { todayFor } from '../../staff/status';
import { Student, StudentAdmission, StudentEnrollment, StudentGuardianLink } from '../../students/student.models';
import { Employee } from '../../staff/employee.model';
import { BankStatementLine } from '../banking/models';
import { CashierShift, Collection, PaymentClaim, Receipt, RefundRequest, type CollectionDoc } from '../collections/models';
import { normRef } from '../collections/collection.service';
import { APPROVER_PERMISSION } from '../core/approvals.service';
import { financeCtx, financeScope, scopeFilter, type FinanceCtx } from '../core/context';
import { AccountingPeriod, ApprovalRequest, CashAccount, ChartAccount, JournalEntry, JournalLine, type AccountingPeriodDoc, type ApprovalRequestDoc } from '../core/models';
import { studentLabels } from '../core/people';
import { placementOf } from '../fees/account.service';
import { BillingRun, BillingRunRow, FeeDocument, FeeHead, StudentFeeAssignment } from '../fees/models';
import { Advance, DisbursementItem, Compensation, PayrollRun, PayrollRunEmployee, Payslip, StatutoryRule } from '../payroll/models';
import { employeesInScope } from '../payroll/setup.service';
import { closeReadiness } from './close.service';
import { Expense, TaxLine, Vendor, VendorBill } from './models';

/**
 * Needs Attention (FUX-03), the Finance Pulse (FUX-02) and finance search (FUX-15).
 *
 * Attention is worked out live from the current data, never stored. A group appears only for someone who could act on it, and the rows are
 * limited to the campuses the caller may use. Salary figures never appear in a count, a row or a search result.
 */

const cap = <T>(items: T[], n = 8) => items.slice(0, n);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function attention(ctx: ServiceContext, query: { locationId?: string | undefined; sessionId?: string | undefined }): Promise<FinanceAttentionDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const today = await todayFor(ctx);
  const t = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  const loc = query.locationId ? { locationId: query.locationId } : scopeFilter(scope);
  const groups: FinanceAttentionGroupDTO[] = [];
  const group = (key: FinanceAttentionGroupDTO['key'], title: string, items: { id: string; label: string; fix: { action: string; label: string; path: string } | null }[], count = items.length) => {
    if (count > 0 || items.length > 0) groups.push({ key, title, count, items: cap(items) });
  };

  if (can(ctx, 'finance:fee_plan:manage')) {
    const heads = await FeeHead.find({ ...t, status: 'ACTIVE', taxCodeId: null, isRefundableDeposit: false }).select('name').lean<{ _id: string; name: string }[]>();
    const enrollments = await StudentEnrollment.find({ tenantId: f.tenantId, state: 'OPEN', ...(query.sessionId ? { academicSessionId: query.sessionId } : {}), ...(query.locationId ? { locationId: query.locationId } : scope.all ? {} : { locationId: { $in: scope.locationIds } }) }).select('studentId').lean<{ studentId: string }[]>();
    const assigned = new Set((await StudentFeeAssignment.distinct('studentId', { tenantId: f.tenantId, state: 'OPEN' })) as string[]);
    const without = enrollments.filter((e) => !assigned.has(e.studentId));
    const labels = await studentLabels(f, cap(without).map((e) => e.studentId));
    group('FEE_SETUP', 'Fee setup', [
      ...heads.map((h) => ({ id: h._id, label: `${h.name} has no tax setting`, fix: { action: 'ADD_TAX_CODE', label: 'Add A Tax Code', path: '/finance/fees?tab=plans' } })),
      ...cap(without).map((e) => ({ id: e.studentId, label: `${labels.get(e.studentId)?.name ?? 'A student'} has no fee plan`, fix: { action: 'ASSIGN_PLAN', label: 'Assign A Plan', path: '/finance/fees?tab=accounts' } })),
    ], heads.length + without.length);
  }

  if (can(ctx, 'finance:billing:create') || can(ctx, 'finance:billing:approve')) {
    const runs = await BillingRun.find({ ...t, state: { $in: ['DRAFT', 'VALIDATED', 'APPROVED'] }, ...(query.locationId ? { locationId: query.locationId } : scope.all ? {} : { locationId: { $in: scope.locationIds } }) }).lean<{ _id: string; periodKey: string; state: string }[]>();
    const problems = await BillingRunRow.countDocuments({ tenantId: f.tenantId, runId: { $in: runs.map((r) => r._id) }, status: 'NEEDS_ATTENTION' });
    group('BILLING', 'Billing', [...runs.map((r) => ({ id: r._id, label: `The ${r.periodKey} billing run is not issued yet (${r.state.toLowerCase()})`, fix: { action: 'OPEN_RUN', label: 'Open Billing', path: '/finance/fees?tab=billing' } })), ...(problems ? [{ id: 'rows', label: `${problems} bill${problems === 1 ? '' : 's'} need a look before they can be issued`, fix: { action: 'FIX_ROWS', label: 'Fix Them', path: '/finance/fees?tab=billing' } }] : [])], runs.length + problems);
  }

  if (can(ctx, 'finance:collection:verify') || can(ctx, 'finance:cashier:supervise')) {
    const claims = await PaymentClaim.find({ ...t, status: 'PENDING_VERIFICATION', ...(query.locationId ? { locationId: query.locationId } : scope.all ? {} : { locationId: { $in: scope.locationIds } }) }).sort({ createdAt: 1 }).lean<{ _id: string; amountPaise: number; flags: string[] }[]>();
    const waiting = await Collection.find({ ...t, ...loc, status: { $in: ['PENDING_VERIFICATION', 'DEPOSITED', 'RECEIVED'] } }).lean<CollectionDoc[]>();
    const returned = await Collection.find({ ...t, ...loc, status: 'RETURNED', returnedOn: { $gte: new Date(new Date(`${today}T00:00:00Z`).getTime() - 30 * 86_400_000).toISOString().slice(0, 10) } }).lean<CollectionDoc[]>();
    const shifts = await CashierShift.find({ ...t, ...loc, $or: [{ state: 'OPEN', openedAt: { $lt: new Date(`${today}T00:00:00Z`) } }, { state: 'CLOSED', variancePaise: { $ne: 0 } }] }).lean<{ _id: string; state: string }[]>();
    const items = [
      ...claims.map((c) => ({ id: c._id, label: c.flags.length ? 'A reported payment looks like a duplicate' : 'A reported payment is waiting to be verified', fix: { action: 'VERIFY_CLAIM', label: 'Verify', path: '/finance/collect?tab=pending' } })),
      ...waiting.map((c) => ({ id: c._id, label: `${c.method === 'CHEQUE' ? 'A cheque' : 'A payment'} is waiting${c.flags.includes('DUPLICATE_SUSPECTED') ? ' (possible duplicate)' : ''}`, fix: { action: 'VERIFY', label: c.method === 'CHEQUE' ? 'Clear Or Return' : 'Verify', path: '/finance/collect?tab=pending' } })),
      ...returned.map((c) => ({ id: c._id, label: 'A cheque came back', fix: { action: 'FOLLOW_UP', label: 'Open Payment', path: '/finance/collect?tab=pending' } })),
      ...shifts.map((s) => ({ id: s._id, label: s.state === 'OPEN' ? 'A cash shift from an earlier day is still open' : 'A cash difference needs a supervisor', fix: { action: 'SIGN_OFF', label: 'Open Cash Shifts', path: '/finance/collect?tab=shifts' } })),
    ];
    group('COLLECTIONS', 'Collections', items, items.length);
  }

  if (can(ctx, 'finance:reconciliation:manage')) {
    const lines = await BankStatementLine.find({ ...t, status: { $in: ['UNMATCHED', 'SUGGESTED', 'VARIANCE', 'DUPLICATE_SUSPECTED', 'PARTIAL'] } }).sort({ date: 1 }).lean<{ _id: string; status: string; creditPaise: number; debitPaise: number }[]>();
    group('BANKING', 'Banking', lines.map((l) => ({ id: l._id, label: l.status === 'VARIANCE' ? 'A bank line matched with a different amount' : l.status === 'DUPLICATE_SUSPECTED' ? 'A bank line looks like a duplicate' : `A bank ${l.creditPaise > 0 ? 'credit' : 'debit'} is not matched`, fix: { action: 'MATCH', label: 'Open Bank Matching', path: '/finance/banking' } })));
  }

  if (can(ctx, 'payroll:run:prepare') || can(ctx, 'payroll:disbursement:manage')) {
    const allowed = await employeesInScope(ctx, f, query.locationId ?? null);
    const emp = allowed ? { employeeId: { $in: allowed } } : {};
    const rows = await PayrollRunEmployee.find({ ...t, ...emp, held: false, status: 'NEEDS_ACTION', runId: { $in: (await PayrollRun.find({ ...t, state: { $in: ['DRAFT', 'CALCULATED'] } }).select('_id').lean<{ _id: string }[]>()).map((r) => r._id) } }).lean<{ _id: string; exceptions: { code: string; level: string }[] }[]>();
    const noSalary = (await Employee.find({ tenantId: f.tenantId, status: { $in: ['ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD'] }, ...(allowed ? { _id: { $in: allowed } } : {}) }).select('_id').lean<{ _id: string }[]>()).filter(() => true);
    const withSalary = new Set((await Compensation.distinct('employeeId', { tenantId: f.tenantId, state: 'OPEN' })) as string[]);
    const missing = noSalary.filter((e) => !withSalary.has(e._id));
    const exited = await Employee.find({ tenantId: f.tenantId, status: 'EXITED', ...(allowed ? { _id: { $in: allowed } } : {}) }).select('_id').lean<{ _id: string }[]>();
    const settled = new Set((await PayrollRunEmployee.find({ ...t, runId: { $in: (await PayrollRun.find({ ...t, type: 'FULL_FINAL', state: { $ne: 'CANCELLED' } }).select('_id').lean<{ _id: string }[]>()).map((r) => r._id) } }).select('employeeId').lean<{ employeeId: string }[]>()).map((r) => r.employeeId));
    const pendingRevisions = await ApprovalRequest.countDocuments({ ...t, action: 'SALARY_REVISION', decision: 'PENDING' });
    const items = [
      ...rows.map((r) => ({ id: r._id, label: `A payroll row needs action (${r.exceptions.map((e) => e.code.toLowerCase().replace(/_/g, ' ')).join(', ')})`, fix: { action: 'FIX_PAYROLL', label: 'Open Payroll', path: '/finance/payroll' } })),
      ...missing.map((e) => ({ id: e._id, label: 'An employee has no salary assigned', fix: { action: 'ASSIGN_SALARY', label: 'Assign A Salary', path: '/finance/payroll?tab=salaries' } })),
      ...exited.filter((e) => !settled.has(e._id)).map((e) => ({ id: e._id, label: 'A leaver is waiting for a full and final settlement', fix: { action: 'SETTLE', label: 'Start Settlement', path: '/finance/payroll?tab=settlements' } })),
      ...(pendingRevisions ? [{ id: 'revisions', label: `${pendingRevisions} salary change${pendingRevisions === 1 ? ' is' : 's are'} waiting for approval`, fix: { action: 'APPROVE', label: 'Open Approvals', path: '/finance/settings?tab=approvals' } }] : []),
    ];
    group('PAYROLL', 'Payroll', items, items.length);
    const unverified = await DisbursementItem.find({ ...t, ...emp, $or: [{ status: { $in: ['FAILED', 'RETURNED'] } }, { status: 'PAID', verified: false }] }).lean<{ _id: string; status: string }[]>();
    group('PAYOUTS', 'Salary payments', unverified.map((i) => ({ id: i._id, label: i.status === 'PAID' ? 'A salary payment is recorded but not verified' : `A salary payment ${i.status.toLowerCase()}`, fix: { action: 'VERIFY_PAYOUT', label: 'Open Payments', path: '/finance/payroll?tab=payments' } })));
  }

  // Approvals waiting for me
  const mine: { id: string; label: string; fix: { action: string; label: string; path: string } | null }[] = [];
  const requests = await ApprovalRequest.find({ ...t, decision: 'PENDING' }).sort({ createdAt: 1 }).lean<ApprovalRequestDoc[]>();
  for (const r of requests) if (can(ctx, APPROVER_PERMISSION[r.action]) && !(r.requestedBy === ctx.userId && r.differentApproverRequired)) mine.push({ id: r._id, label: r.summary, fix: { action: 'DECIDE', label: 'Decide', path: '/finance/settings?tab=approvals' } });
  if (can(ctx, 'finance:refund:approve')) for (const r of await RefundRequest.find({ ...t, ...loc, state: { $in: ['ELIGIBLE', 'REQUESTED'] }, requestedBy: { $ne: ctx.userId } }).lean<{ _id: string; number: string }[]>()) mine.push({ id: r._id, label: `Refund ${r.number} is waiting for approval`, fix: { action: 'APPROVE_REFUND', label: 'Open Refunds', path: '/finance/collect?tab=refunds' } });
  if (can(ctx, 'finance:expense:approve')) {
    for (const e of await Expense.find({ ...t, ...loc, state: 'PENDING', needsApproval: true, approvedBy: null, createdBy: { $ne: ctx.userId } }).lean<{ _id: string; number: string }[]>()) mine.push({ id: e._id, label: `Expense ${e.number} is waiting for approval`, fix: { action: 'APPROVE_EXPENSE', label: 'Open Expenses', path: '/finance/expenses' } });
    for (const b of await VendorBill.find({ ...t, ...loc, state: 'PENDING', needsApproval: true, approvedBy: null, createdBy: { $ne: ctx.userId } }).lean<{ _id: string; number: string }[]>()) mine.push({ id: b._id, label: `Vendor bill ${b.number} is waiting for approval`, fix: { action: 'APPROVE_BILL', label: 'Open Bills', path: '/finance/expenses?tab=bills' } });
  }
  if (can(ctx, 'payroll:run:approve')) {
    for (const r of await PayrollRun.find({ ...t, state: 'CALCULATED', preparedBy: { $ne: ctx.userId } }).lean<{ _id: string; number: string }[]>()) mine.push({ id: r._id, label: `Payroll run ${r.number} is waiting for approval`, fix: { action: 'APPROVE_RUN', label: 'Open Payroll', path: '/finance/payroll' } });
    for (const a of await Advance.find({ ...t, state: 'REQUESTED', requestedBy: { $ne: ctx.userId } }).lean<{ _id: string }[]>()) mine.push({ id: a._id, label: 'A salary advance is waiting for approval', fix: { action: 'APPROVE_ADVANCE', label: 'Open Payroll', path: '/finance/payroll?tab=advances' } });
    for (const r of await StatutoryRule.find({ ...t, state: 'DRAFT' }).lean<{ _id: string; kind: string }[]>()) mine.push({ id: r._id, label: `${r.kind} rules are waiting for approval`, fix: { action: 'APPROVE_RULES', label: 'Open Payroll Rules', path: '/finance/payroll?tab=rules' } });
  }
  group('APPROVALS', 'Waiting for me', mine, mine.length);

  if (can(ctx, 'finance:tax:review')) {
    const lines = await TaxLine.find({ ...t, voided: false, itcStatus: 'NEEDS_REVIEW', ...loc }).lean<{ _id: string; sourceNumber: string }[]>();
    const noCode = await FeeHead.countDocuments({ ...t, status: 'ACTIVE', taxCodeId: null, isRefundableDeposit: false });
    group('TAX', 'Tax', [...lines.map((l) => ({ id: l._id, label: `Input tax on ${l.sourceNumber} needs a decision`, fix: { action: 'DECIDE_ITC', label: 'Decide', path: '/finance/tax' } })), ...(noCode ? [{ id: 'codes', label: `${noCode} fee type${noCode === 1 ? ' has' : 's have'} no tax setting`, fix: { action: 'ADD_TAX_CODE', label: 'Add A Tax Code', path: '/finance/fees?tab=plans' } }] : [])], lines.length + noCode);
  }

  if (can(ctx, 'finance:period:close') || can(ctx, 'finance:accounting:post')) {
    const due = await AccountingPeriod.findOne({ ...t, state: 'OPEN', endDate: { $lt: today } }).sort({ startDate: 1 }).lean<AccountingPeriodDoc>();
    if (due) {
      const r = await closeReadiness(ctx, due._id);
      group('CLOSE', `Closing ${due.code}`, r.checks.filter((c) => c.level === 'BLOCKER' && c.count > 0).map((c) => ({ id: `${due._id}:${c.key}`, label: `${c.title}: ${c.sentence}`, fix: c.fix ? { action: c.key, ...c.fix } : null })), r.blockers);
    }
  }
  return { total: groups.reduce((s, g) => s + g.count, 0), groups };
}

// ───────────────────────────────────────────────────────────── Finance Pulse (FUX-02)

export async function overview(ctx: ServiceContext): Promise<FinanceOverviewDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const today = await todayFor(ctx);
  const t = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  const loc = scopeFilter(scope);
  const docs = await FeeDocument.find({ ...t, ...loc, kind: { $in: ['BILL', 'LATE_FEE', 'DEBIT_NOTE', 'OPENING'] }, status: { $in: ['ISSUED', 'PARTIALLY_SETTLED'] }, balancePaise: { $gt: 0 } }).select('balancePaise overdueAfter').lean<{ balancePaise: number; overdueAfter: string }[]>();
  const month = today.slice(0, 7);
  const collectionsToday = (await Collection.find({ ...t, ...loc, receivedOn: today, status: { $in: ['POSTED', 'CLEARED'] } }).select('amountPaise').lean<{ amountPaise: number }[]>()).reduce((s, c) => s + c.amountPaise, 0);
  const expenses = (await Expense.find({ ...t, ...loc, state: 'POSTED', date: { $gte: `${month}-01`, $lte: `${month}-31` } }).select('totalPaise').lean<{ totalPaise: number }[]>()).reduce((s, e) => s + e.totalPaise, 0) + (await VendorBill.find({ ...t, ...loc, state: { $in: ['POSTED', 'PARTIALLY_PAID', 'PAID'] }, date: { $gte: `${month}-01`, $lte: `${month}-31` } }).select('totalPaise').lean<{ totalPaise: number }[]>()).reduce((s, b) => s + b.totalPaise, 0);
  const roles = new Map((await ChartAccount.find({ ...t, systemRole: { $in: ['SALARY_PAYABLE', 'CASH'] } }).select('systemRole').lean<{ _id: string; systemRole: string }[]>()).map((a) => [a.systemRole, a._id]));
  const net = async (accountIds: string[], sign: 1 | -1) => (await JournalLine.find({ ...t, accountId: { $in: accountIds } }).select('debitPaise creditPaise').lean<{ debitPaise: number; creditPaise: number }[]>()).reduce((s, l) => s + sign * (l.debitPaise - l.creditPaise), 0);
  const cashAccounts = (await CashAccount.find(t).select('glAccountId').lean<{ glAccountId: string }[]>()).map((c) => c.glAccountId);
  const view = can(ctx, 'finance:view');
  return {
    asOf: today,
    collectionsTodayPaise: view ? collectionsToday : null,
    outstandingPaise: view ? docs.reduce((s, d) => s + d.balancePaise, 0) : null,
    overduePaise: view ? docs.filter((d) => d.overdueAfter < today).reduce((s, d) => s + d.balancePaise, 0) : null,
    payrollPayablePaise: can(ctx, 'payroll:report:view') && roles.has('SALARY_PAYABLE') ? await net([roles.get('SALARY_PAYABLE')!], -1) : null,
    monthlyExpensesPaise: can(ctx, 'finance:expense:record') ? expenses : null,
    unreconciledBankLines: can(ctx, 'finance:reconciliation:manage') ? await BankStatementLine.countDocuments({ ...t, status: { $in: ['UNMATCHED', 'SUGGESTED', 'VARIANCE', 'DUPLICATE_SUSPECTED', 'PARTIAL'] } }) : null,
    cashInHandPaise: can(ctx, 'finance:cashier:supervise') ? await net([...new Set([...cashAccounts, ...(roles.has('CASH') ? [roles.get('CASH')!] : [])])], 1) : null,
    attentionTotal: (await attention(ctx, {})).total,
  };
}

// ───────────────────────────────────────────────────────────── search (FUX-15)

export async function search(ctx: ServiceContext, q: string): Promise<SearchResultDTO[]> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const t = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  const like = new RegExp(esc(q), 'i');
  const norm = normRef(q);
  const out: SearchResultDTO[] = [];
  const inScope = (locationId: string | null | undefined) => scope.all || !locationId || scope.locationIds.includes(locationId);

  // students: by admission number, their own name, or a parent's name
  const admissions = await StudentAdmission.find({ tenantId: f.tenantId, isCurrent: true, admissionNumber: like }).select('studentId').limit(10).lean<{ studentId: string }[]>();
  const people = await Person.find({ tenantId: f.tenantId, $or: [{ legalFirstName: like }, { legalLastName: like }, { preferredName: like }] }).select('_id').limit(30).lean<{ _id: string }[]>();
  const byName = await Student.find({ tenantId: f.tenantId, personId: { $in: people.map((p) => p._id) } }).select('_id').limit(10).lean<{ _id: string }[]>();
  const guardians = await StudentGuardianLink.find({ tenantId: f.tenantId, guardianPersonId: { $in: people.map((p) => p._id) }, cancelledAt: null }).select('studentId').limit(10).lean<{ studentId: string }[]>();
  const studentIds = [...new Set([...admissions.map((a) => a.studentId), ...byName.map((s) => s._id), ...guardians.map((g) => g.studentId)])];
  const labels = await studentLabels(f, studentIds);
  for (const id of studentIds) {
    if (!inScope((await placementOf(f, id)).locationId)) continue;
    out.push({ type: 'student', id, label: labels.get(id)?.name ?? 'Student', sub: labels.get(id)?.admissionNumber ?? null, path: `/finance/fees/students/${id}` });
  }
  for (const r of await Receipt.find({ ...t, number: like }).limit(8).lean<{ _id: string; number: string; locationId: string }[]>()) if (inScope(r.locationId)) out.push({ type: 'receipt', id: r._id, label: r.number, sub: 'Receipt', path: `/finance/collect?receipt=${r._id}` });
  for (const d of await FeeDocument.find({ ...t, number: like }).limit(8).lean<{ _id: string; number: string; locationId: string; studentId: string }[]>()) if (inScope(d.locationId)) out.push({ type: 'bill', id: d._id, label: d.number, sub: 'Bill', path: `/finance/fees/students/${d.studentId}` });
  if (norm) {
    for (const c of await Collection.find({ ...t, $or: [{ referenceNorm: { $regex: esc(norm) } }, { 'cheque.number': like }] }).limit(8).lean<CollectionDoc[]>()) if (inScope(c.locationId)) out.push({ type: c.method === 'CHEQUE' ? 'cheque' : 'payment', id: c._id, label: c.reference ?? c.cheque?.number ?? c.method, sub: c.status.replace(/_/g, ' ').toLowerCase(), path: `/finance/collect?payment=${c._id}` });
    if (can(ctx, 'finance:reconciliation:manage')) for (const l of await BankStatementLine.find({ ...t, referenceNorm: { $regex: esc(norm) } }).limit(8).lean<{ _id: string; reference: string | null; date: string }[]>()) out.push({ type: 'bank_line', id: l._id, label: l.reference ?? 'Bank line', sub: l.date, path: '/finance/banking' });
  }
  if (can(ctx, 'finance:accounting:view')) for (const j of await JournalEntry.find({ ...t, number: like }).limit(8).lean<{ _id: string; number: string; memo: string }[]>()) out.push({ type: 'journal', id: j._id, label: j.number, sub: j.memo, path: `/finance/accounting?journal=${j._id}` });
  if (can(ctx, 'finance:expense:record')) {
    for (const e of await Expense.find({ ...t, number: like }).limit(5).lean<{ _id: string; number: string; description: string; locationId: string }[]>()) if (inScope(e.locationId)) out.push({ type: 'expense', id: e._id, label: e.number, sub: e.description, path: '/finance/expenses' });
    for (const v of await Vendor.find({ ...t, name: like }).limit(5).lean<{ _id: string; name: string }[]>()) out.push({ type: 'vendor', id: v._id, label: v.name, sub: 'Vendor', path: '/finance/expenses?tab=vendors' });
  }
  // Salary hits only for someone allowed to see salary. Never an amount, never an employee's name next to a figure.
  if (can(ctx, 'payroll:salary:view_sensitive')) {
    for (const r of await PayrollRun.find({ ...t, number: like }).limit(5).lean<{ _id: string; number: string; month: string }[]>()) out.push({ type: 'payroll_run', id: r._id, label: r.number, sub: r.month, path: '/finance/payroll' });
    for (const p of await Payslip.find({ ...t, number: like }).limit(5).lean<{ _id: string; number: string; month: string }[]>()) out.push({ type: 'payslip', id: p._id, label: p.number, sub: p.month, path: '/finance/payroll?tab=payslips' });
  }
  return out.slice(0, 40);
}

export type { FinanceCtx };
