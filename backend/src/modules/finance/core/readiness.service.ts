import type { FinanceReadinessDTO, FinanceReadinessItemDTO } from '@shared';
import { SYSTEM_ACCOUNT_ROLES } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { AcademicSession } from '../../academic/session.model';
import { todayFor } from '../../staff/status';
import { StudentEnrollment } from '../../students/student.models';
import { FeeHead, FeePlan, FeePlanVersion, StudentFeeAssignment } from '../fees/models';
import { financeCtx } from './context';
import { AccountingPeriod, ApprovalPolicy, BankAccount, ChartAccount, FinancialYear } from './models';

/** FUX-01. A short checklist the setup screen shows: what is done, what needs attention, and where to fix it. Part 3 adds its own items later. */
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
  const ready = items.filter((i) => i.status !== 'NEEDS_ATTENTION').length;
  const next = items.find((i) => i.status === 'NEEDS_ATTENTION');
  return { items, ready, total: items.length, headline: `${ready} of ${items.length} ready.${next ? ` Next: ${next.fix?.label.toLowerCase() ?? next.title.toLowerCase()}.` : ''}` };
}
