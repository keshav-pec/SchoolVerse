import type { FinanceReadinessDTO, FinanceReadinessItemDTO } from '@shared';
import { SYSTEM_ACCOUNT_ROLES } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { AcademicSession } from '../../academic/session.model';
import { todayFor } from '../../staff/status';
import { StudentEnrollment } from '../../students/student.models';
import { FeeHead, FeePlan, FeePlanVersion, StudentFeeAssignment } from '../fees/models';
import { financeCtx } from './context';
import { Employee } from '../../staff/employee.model';
import { Compensation, PayrollPolicy, PayrollRun, StatutoryRule } from '../payroll/models';
import { firstCloseDone, openingPosted } from '../accounting/close.service';
import { CashAccount } from './models';
import { AccountingPeriod, ApprovalPolicy, BankAccount, ChartAccount, FinancialYear } from './models';

/** FUX-01 and the Part 3 additions: a short checklist the setup screen shows: what is done, what needs attention, and where to fix it. Payroll items stay "not needed" until payroll is in use. */
export async function financeReadiness(ctx: ServiceContext): Promise<FinanceReadinessDTO> {
  const f = await financeCtx(ctx);
  const t = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  const today = await todayFor(ctx);
  const [year, roles, banks, heads, plans, policies, session] = await Promise.all([
    FinancialYear.findOne({ ...t, startDate: { $lte: today }, endDate: { $gte: today } }).lean<{ _id: string; code: string }>(),
    ChartAccount.find({ ...t, systemRole: { $type: 'string' } }).select('systemRole').lean<{ systemRole: string }[]>(),
    BankAccount.countDocuments({ ...t, status: 'ACTIVE' }),
    FeeHead.find({ ...t, status: 'ACTIVE' }).select('taxCodeId isRefundableDeposit name').lean<{ taxCodeId: string | null; isRefundableDeposit: boolean; name: string }[]>(),
    FeePlan.find({ ...t, status: 'ACTIVE' }).select('_id sessionId').lean<{ _id: string; sessionId: string }[]>(),
    ApprovalPolicy.countDocuments(t),
    AcademicSession.findOne({ tenantId: f.tenantId, status: 'ACTIVE' }).select('_id').lean<{ _id: string }>(),
  ]);
  const periods = year ? await AccountingPeriod.countDocuments({ ...t, financialYearId: year._id }) : 0;
  const published = session ? await FeePlanVersion.countDocuments({ tenantId: f.tenantId, state: 'PUBLISHED', planId: { $in: plans.filter((p) => p.sessionId === session._id).map((p) => p._id) } }) : 0;
  const enrolled = session ? await StudentEnrollment.find({ tenantId: f.tenantId, academicSessionId: session._id, state: 'OPEN' }).select('studentId').lean<{ studentId: string }[]>() : [];
  const assigned = session ? new Set((await StudentFeeAssignment.find({ tenantId: f.tenantId, sessionId: session._id, state: 'OPEN' }).select('studentId').lean<{ studentId: string }[]>()).map((a) => a.studentId)) : new Set<string>();
  const unassigned = enrolled.filter((e) => !assigned.has(e.studentId)).length;
  const need = SYSTEM_ACCOUNT_ROLES.filter((r) => ['STUDENT_RECEIVABLE', 'STUDENT_ADVANCE', 'REFUNDABLE_DEPOSIT', 'OUTPUT_CGST', 'OUTPUT_SGST', 'OUTPUT_IGST'].includes(r));
  const haveRoles = new Set(roles.map((r) => r.systemRole));
  const noTax = heads.filter((h) => !h.taxCodeId && !h.isRefundableDeposit);

  const item = (key: string, title: string, ok: boolean, sentence: { done: string; todo: string }, fix: { label: string; path: string }, notNeeded = false): FinanceReadinessItemDTO => ({
    key, title, status: notNeeded ? 'NOT_NEEDED' : ok ? 'DONE' : 'NEEDS_ATTENTION', sentence: notNeeded || ok ? sentence.done : sentence.todo, fix: ok || notNeeded ? null : fix,
  });
  const items: FinanceReadinessItemDTO[] = [
    item('legal_entity', 'School details', Boolean(f.entity.name && f.entity.stateCode), { done: `${f.entity.name} is set up.`, todo: "Add the school's state so tax can be worked out." }, { label: 'Add State', path: '/finance/settings?tab=school' }),
    item('tax_profile', 'GST details', Boolean(f.entity.gstin), { done: f.entity.gstRegistered ? 'GSTIN added.' : 'GST is optional if the school is not registered.', todo: 'The school is GST registered, so add its GSTIN.' }, { label: 'Add GSTIN', path: '/finance/settings?tab=school' }, !f.entity.gstRegistered),
    item('financial_year', 'Financial year', Boolean(year) && periods === 12, { done: `Financial year ${year?.code ?? ''} and its 12 months are ready.`, todo: 'Add the current financial year.' }, { label: 'Add Year', path: '/finance/settings?tab=years' }),
    item('chart_of_accounts', 'Chart of accounts', need.every((r) => haveRoles.has(r)), { done: 'The chart of accounts is ready.', todo: 'Use the standard chart of accounts.' }, { label: 'Use Standard Chart', path: '/finance/settings?tab=chart' }),
    item('bank_account', 'Bank account', banks > 0, { done: 'A bank account is added.', todo: 'Add the school bank account.' }, { label: 'Add Bank Account', path: '/finance/settings?tab=bank' }),
    item('fee_heads', 'Fee types', heads.length > 0 && noTax.length === 0, { done: 'Every fee type has a tax setting.', todo: heads.length === 0 ? 'Add fee types such as Tuition and Annual Fee.' : `${noTax.length} fee type${noTax.length === 1 ? ' has' : 's have'} no tax setting: ${noTax.map((h) => h.name).join(', ')}.` }, { label: 'Fix Fee Types', path: '/finance/fees?tab=plans' }),
    item('fee_plan', 'Fee plan', published > 0, { done: 'A fee plan is published.', todo: 'Publish a fee plan for the current session.' }, { label: 'Add Fee Plan', path: '/finance/fees?tab=plans' }),
    item('students_assigned', 'Students on a plan', unassigned === 0, { done: enrolled.length === 0 ? 'No students are enrolled yet.' : 'Every enrolled student has a fee plan.', todo: `${unassigned} enrolled student${unassigned === 1 ? ' has' : 's have'} no fee plan yet.` }, { label: 'Assign Students', path: '/finance/fees?tab=accounts' }, enrolled.length === 0),
    item('approval_rules', 'Approval rules', policies > 0, { done: 'Approval rules are set.', todo: 'Use the standard setup to add the approval rules.' }, { label: 'Use Standard Setup', path: '/finance/settings?tab=approvals' }),
  ];

  // Part 3: payroll, receipts, opening balances, the first close. Payroll items appear as "not needed" until someone has a salary or a run exists.
  const [policy, rules, salaried, runs, employees, cashAccounts, openingDone, closedOnce, billedOld] = await Promise.all([
    PayrollPolicy.exists(t),
    StatutoryRule.find({ ...t, state: 'APPROVED' }).select('kind').lean<{ kind: string }[]>(),
    Compensation.distinct('employeeId', { tenantId: f.tenantId, state: 'OPEN' }) as Promise<string[]>,
    PayrollRun.countDocuments(t),
    Employee.find({ tenantId: f.tenantId, status: { $in: ['ACTIVE', 'ON_LEAVE', 'NOTICE_PERIOD'] } }).select('_id').lean<{ _id: string }[]>(),
    CashAccount.countDocuments({ ...t, status: 'ACTIVE' }),
    openingPosted(f),
    firstCloseDone(f),
    AccountingPeriod.exists({ ...t, endDate: { $lt: today }, state: 'OPEN' }),
  ]);
  const payrollInUse = salaried.length > 0 || runs > 0;
  const unpaid = employees.filter((e) => !salaried.includes(e._id)).length;
  const kinds = new Set(rules.map((r) => r.kind));
  const salaryBank = await BankAccount.countDocuments({ ...t, status: 'ACTIVE', purpose: { $in: ['SALARY', 'OPERATING', 'FEES'] } });
  const hasBills = billedOld ? await (await import('../fees/models')).FeeDocument.exists({ ...t, kind: 'BILL' }) : null;
  items.push(
    item('payroll_policy', 'Payroll rules', Boolean(policy), { done: 'The payroll policy is set.', todo: 'Set how a part month is paid.' }, { label: 'Open Payroll', path: '/finance/payroll?tab=setup' }, !payrollInUse),
    item('statutory_rules', 'PF, ESI and Professional Tax', ['PF', 'ESI', 'PT'].every((k) => kinds.has(k)), { done: payrollInUse ? 'The PF, ESI and Professional Tax rules are approved.' : 'Not needed until payroll is used.', todo: 'The PF, ESI and Professional Tax rules are demo values. Your accountant must approve the real ones.' }, { label: 'Approve Rules', path: '/finance/payroll?tab=rules' }, !payrollInUse),
    item('employees_salary', 'Employee salaries', unpaid === 0, { done: payrollInUse ? 'Every active employee has a salary.' : 'Not needed until payroll is used.', todo: `${unpaid} active employee${unpaid === 1 ? ' has' : 's have'} no salary assigned.` }, { label: 'Assign Salaries', path: '/finance/payroll?tab=salaries' }, !payrollInUse),
    item('salary_bank', 'Bank account for salaries', salaryBank > 0, { done: payrollInUse ? 'A bank account is ready to pay salaries from.' : 'Not needed until payroll is used.', todo: 'Add the bank account salaries are paid from.' }, { label: 'Add Bank Account', path: '/finance/settings?tab=bank' }, !payrollInUse),
    item('receipts', 'Receipts', banks + cashAccounts > 0, { done: 'Receipts can be issued: money can be received into a bank or cash account.', todo: 'Add a bank account or a cash account so receipts can be issued.' }, { label: 'Add Account', path: '/finance/settings?tab=bank' }, banks + cashAccounts === 0),
    item('opening_balances', 'Opening balances', openingDone, { done: openingDone ? 'Opening balances are posted.' : 'Optional: only needed when the school moves from another system.', todo: '' }, { label: 'Import Balances', path: '/finance/settings?tab=opening' }, !openingDone),
    item('first_close', 'First month closed', closedOnce, { done: closedOnce ? 'A month has been closed.' : 'No month has ended with bills yet.', todo: 'A finished month is still open. Check it and close it.' }, { label: 'Open Month Close', path: '/finance/accounting?tab=close' }, !closedOnce && !hasBills),
  );
  const ready = items.filter((i) => i.status !== 'NEEDS_ATTENTION').length;
  const next = items.find((i) => i.status === 'NEEDS_ATTENTION');
  return { items, ready, total: items.length, headline: `${ready} of ${items.length} ready.${next ? ` Next: ${next.fix?.label.toLowerCase() ?? next.title.toLowerCase()}.` : ''}` };
}
