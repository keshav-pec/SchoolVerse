import { expect } from 'vitest';
import type { PayrollRunDTO, PayslipDTO, RunEmployeeDTO, RunLineDTO, SalaryComponentDTO, SalaryStructureDTO, StatutoryRuleDTO, TrialBalanceDTO } from '@shared';
import { RestrictedPersonData } from '../src/platform/identity/restricted-data.model';
import { sealBank } from '../src/platform/identity/restricted-data';
import { addActiveEmployee, API } from './helpers';
import { getOk, money, moneySchool, staffWith, type MoneySchool } from './finance-helpers';

/** Payroll setup shared by the payroll tests and the accounting invariants. */

export const pay = (t: { agent: { post: (u: string) => { send: (b: object) => Promise<{ status: number; body: { data: never; error?: { code: string; details?: Record<string, unknown> } } }> } } }, path: string, body: unknown = {}) => t.agent.post(`${API}/payroll${path}`).send(body as object);
export const payGet = async <T>(t: { agent: { get: (u: string) => Promise<{ status: number; body: { data: T } }> } }, path: string) => {
  const res = await t.agent.get(`${API}/payroll${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
export const payPut = (t: { agent: { put: (u: string) => { send: (b: object) => Promise<{ status: number; body: { data: never } }> } } }, path: string, body: unknown = {}) => t.agent.put(`${API}/payroll${path}`).send(body as object);
export const payOk = async <T>(res: { status: number; body: { data: T } }, status = 200) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data;
};
export const trial = (t: MoneySchool) => getOk<TrialBalanceDTO>(t, '/trial-balance');

export const MONTH = '2026-11';

/** Payroll ready: three approved statutory rules, a structure (Basic + 40% HRA), a payroll officer, a second officer, two approvers. */
export async function payrollSchool(options: { approveRules?: boolean } = {}) {
  const t = await moneySchool();
  const officer = await staffWith(t, ['PAYROLL_OFFICER']);
  const officer2 = await staffWith(t, ['PAYROLL_OFFICER']);
  const approver2 = await staffWith(t, ['APPROVER']);
  const components = await payGet<SalaryComponentDTO[]>(t, '/components');
  const basic = components.find((c) => c.code === 'BASIC')!;
  const hra = components.find((c) => c.code === 'HRA')!;
  const structure = await payOk<SalaryStructureDTO>(await pay(officer, '/salary-structures', { name: 'Senior Faculty A', effectiveFrom: '2026-04-01', items: [{ componentId: basic.componentId }, { componentId: hra.componentId, rateBps: 4000 }] }), 201);
  await payOk(await pay(t.approver, `/salary-structure-versions/${structure.latestVersion!.versionId}/approve`));
  if (options.approveRules !== false) for (const r of await payGet<StatutoryRuleDTO[]>(t, '/statutory-rules')) await payOk(await pay(t.approver, `/statutory-rules/${r.ruleId}/approve`));
  return { ...t, officer, officer2, approver2, basic, hra, structureVersionId: structure.latestVersion!.versionId };
}
export type PaySchool = Awaited<ReturnType<typeof payrollSchool>>;

/** An active employee with a salary (basic in rupees), bank details and, optionally, a tax declaration and November days. */
export async function worker(t: PaySchool, basicRupees: number, over: { days?: { lop?: number; working?: number | null }; tdsYearlyRupees?: number; noBank?: boolean; joining?: string; mode?: string } = {}) {
  const employee = await addActiveEmployee(t, { joiningDate: over.joining ?? '2020-04-01' });
  if (!over.noBank) await RestrictedPersonData.create({ tenantId: t.tenantId, personId: employee.personId, governmentIds: [], bank: sealBank(employee.personId, { accountHolderName: employee.fullName, accountNumber: `9900${employee.employeeCode.replace(/\D/g, '').padStart(8, '0')}`, ifsc: 'SBIN0001234', bankName: 'State Bank' }) });
  await payOk(await pay(t.officer, '/employee-assignments', { employeeId: employee.employeeId, structureVersionId: t.structureVersionId, mode: over.mode ?? 'MONTHLY', basicPaise: money(basicRupees), effectiveFrom: '2026-04-01' }), 201);
  if (over.tdsYearlyRupees) await payOk(await payPut(t.officer, `/employees/${employee.employeeId}/tax-declaration`, { regime: 'NEW', estimatedYearlyTaxPaise: money(over.tdsYearlyRupees), alreadyDeductedPaise: 0 }));
  if (over.days) await payOk(await payPut(t.officer, '/inputs', { employeeId: employee.employeeId, month: MONTH, workingDays: over.days.working ?? null, paidLeaveDays: 0, lopDays: over.days.lop ?? 0, unitsWorked: null, extras: [] }));
  return employee;
}

export const newRun = async (t: PaySchool, employeeIds: string[], month = MONTH) => payOk<PayrollRunDTO>(await pay(t.officer, '/runs', { month, employeeIds }), 201);
export const calc = async (t: PaySchool, runId: string) => payOk<PayrollRunDTO>(await pay(t.officer, `/runs/${runId}/calculate`));
export const rows = async (t: PaySchool, runId: string) => (await payGet<{ items: RunEmployeeDTO[] }>(t, `/runs/${runId}/employees?pageSize=100`)).items;
export const linesOf = (t: PaySchool, runId: string, employeeId: string) => payGet<RunLineDTO[]>(t, `/runs/${runId}/employees/${employeeId}/lines`);
/** Calculate, approve (a different person) and finalise. */
export async function finalise(t: PaySchool, runId: string) {
  await calc(t, runId);
  const a = await payOk<PayrollRunDTO>(await pay(t.approver, `/runs/${runId}/approve`));
  expect(a.state).toBe('APPROVED');
  return payOk<PayrollRunDTO>(await pay(t.approver2, `/runs/${runId}/finalize`, { version: a.version }));
}
export const lineAmount = (lines: RunLineDTO[], key: string) => lines.find((l) => l.componentKey === key)?.amountPaise;

