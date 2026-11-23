import { expect } from 'vitest';
import type { AccountDTO, BankAccountDTO, BillingCommitDTO, BillingRunDTO, BillingValidationDTO, FeeDocumentListDTO, FeeHeadDTO, FeePlanDTO, FinancialYearDTO, TaxCodeDTO } from '@shared';
import { addActiveEmployee, addStudent, API, data, loginAs, staffSchool, today, type Agent } from './helpers';
import { StudentEnrollment } from '../src/modules/students/student.models';
import { StudentFeeAssignment } from '../src/modules/finance/fees/models';
import { fyCodeFor } from '../src/modules/finance/core/context';

/** Shared setup for the Part 3 finance test files. The Part 1 and 2 file keeps its own copies on purpose, so it can stay as it is. */

export const post = (t: { agent: Agent }, path: string, body: unknown = {}) => t.agent.post(`${API}/finance${path}`).send(body as object);
export const patch = (t: { agent: Agent }, path: string, body: unknown = {}) => t.agent.patch(`${API}/finance${path}`).send(body as object);
export const put = (t: { agent: Agent }, path: string, body: unknown = {}) => t.agent.put(`${API}/finance${path}`).send(body as object);
export const getOk = async <T>(t: { agent: Agent }, path: string) => {
  const res = await t.agent.get(`${API}/finance${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as T;
};
export const created = async <T>(res: { status: number; body: { data: T } }) => {
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};
export const ok = async <T>(res: { status: number; body: { data: T } }) => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
export const money = (rupees: number) => rupees * 100;
export const withKey = (agent: Agent, path: string, key: string, body: unknown) => agent.post(`${API}/finance${path}`).set('Idempotency-Key', key).send(body as object);

/** A seeded school with finance set up: standard chart and tax codes, FY 2026-27 (and the year of today), a fees bank account and a cash account. */
export async function financeBase() {
  const t = await staffSchool();
  await post(t, '/setup/standard').expect(200);
  const fy = await created<FinancialYearDTO>(await post(t, '/financial-years', { code: '2026-27' }));
  const nowCode = fyCodeFor(today(), 4);
  if (nowCode !== '2026-27') await post(t, '/financial-years', { code: nowCode }).expect(201);
  const accounts = Object.fromEntries((await getOk<AccountDTO[]>(t, '/chart-of-accounts')).map((a) => [a.code, a]));
  const taxCodes = Object.fromEntries((await getOk<TaxCodeDTO[]>(t, '/tax-codes')).map((c) => [c.code, c]));
  return { ...t, fy, accounts, taxCodes };
}

/** A Staff login (a real employee at Mohali) holding the given finance bundles. */
export async function staffWith(t: Awaited<ReturnType<typeof staffSchool>>, bundles: string[], employeeOver: Record<string, unknown> = {}) {
  const login = await loginAs(t, 'STAFF', await addActiveEmployee(t, employeeOver));
  if (bundles.length) await put(t, `/access/users/${login.userId}`, { bundles }).expect(200);
  return login;
}

const heads = async (t: Awaited<ReturnType<typeof financeBase>>) => {
  const { accounts: a, taxCodes: x } = t;
  const head = async (body: Record<string, unknown>) => created<FeeHeadDTO>(await post(t, '/fee-heads', body));
  return {
    tuition: await head({ code: 'TUITION', name: 'Tuition Fee', category: 'TUITION', incomeAccountId: a['4100']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId, isRecurring: true }),
    annual: await head({ code: 'ANNUAL', name: 'Annual Charges', category: 'ANNUAL', incomeAccountId: a['4300']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId }),
    deposit: await head({ code: 'DEPOSIT', name: 'Security Deposit', category: 'DEPOSIT', incomeAccountId: a['2200']!.accountId, isRefundableDeposit: true }),
    uniform: await head({ code: 'UNIFORM', name: 'Uniform', incomeAccountId: a['4600']!.accountId, taxCodeId: x.GST_12!.taxCodeId, isOptional: true }),
    lateFee: await head({ code: 'LATEFEE', name: 'Late Fee', category: 'LATE_FEE', incomeAccountId: a['4700']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId }),
  };
};

/**
 * Finance ready for money to move: a published Class VIII plan (Tuition ₹4,000 monthly, Annual ₹8,000 yearly, a ₹5,000 refundable deposit),
 * a fees bank account, a cash account, and staff logins: a cashier, a second cashier, an accountant and an approver.
 */
export async function moneySchool() {
  const t = await financeBase();
  const h = await heads(t);
  const item = (head: FeeHeadDTO, rupees: number, frequency: string, extra: Record<string, unknown> = {}) => ({ feeHeadId: head.feeHeadId, amountPaise: money(rupees), frequency, dueDay: 10, ...extra });
  const planBody = {
    name: 'Class VIII 2026-27', sessionId: t.sessionId, appliesTo: { locationIds: [t.moh.locationId], classIds: [t.ref.classId.G08!], studentType: 'ALL' }, autoAssign: true,
    items: [item(h.tuition, 4000, 'MONTHLY', { prorationMethod: 'CALENDAR_DAYS' }), item(h.annual, 8000, 'YEARLY'), item(h.deposit, 5000, 'ONE_TIME')],
  };
  const plan = await created<FeePlanDTO>(await post(t, '/fee-plans', planBody));
  const published = (await ok(await post(t, `/fee-plan-versions/${plan.latestVersion!.versionId}/publish`))) as FeePlanDTO;
  const bank = await created<BankAccountDTO>(await post(t, '/bank-accounts', { label: 'Fees account', bankName: 'State Bank', holderName: 'Greenfield Trust', accountNumber: '123456781234', ifsc: 'SBIN0001234', purpose: 'FEES' }));
  const cash = await created<{ cashAccountId: string }>(await post(t, '/cash-accounts', { label: 'Front office cash' }));
  const cashier = await staffWith(t, ['COLLECTOR']);
  const cashier2 = await staffWith(t, ['COLLECTOR']);
  const accountant = await staffWith(t, ['ACCOUNTANT']);
  const approver = await staffWith(t, ['APPROVER']);
  return { ...t, heads: h, plan: published, planVersionId: published.publishedVersion!.versionId, bank, cash, cashier, cashier2, accountant, approver };
}
export type MoneySchool = Awaited<ReturnType<typeof moneySchool>>;

/** A new Class VIII student whose enrollment and fee plan start on `from`. */
export async function enrolled(t: MoneySchool, from = '2026-04-01', over: Record<string, unknown> = {}) {
  const made = await addStudent(t, over);
  const studentId = made.student.studentId;
  await StudentEnrollment.updateOne({ tenantId: t.tenantId, studentId }, { $set: { effectiveFrom: from } });
  await StudentFeeAssignment.updateOne({ tenantId: t.tenantId, studentId }, { $set: { effectiveFrom: from } });
  return { ...made, studentId };
}

/** Check then issue a billing run, the way the screen does. */
export async function issueMonth(t: MoneySchool, periodKey = '2026-11', issueDate = '2026-11-05') {
  const run = await created<BillingRunDTO>(await post(t, '/billing-runs', { sessionId: t.sessionId, locationId: t.moh.locationId, periodKey, issueDate }));
  const checked = (await ok(await post(t, `/billing-runs/${run.runId}/validate`))) as BillingValidationDTO;
  const res = await t.agent.post(`${API}/finance/billing-runs/${run.runId}/commit`).set('Idempotency-Key', `key-${periodKey}`).send({ confirmedReadyCount: checked.run.counts.ready, confirmedTotalPaise: checked.run.totalPaise });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as BillingCommitDTO;
}

export const billsOf = async (t: MoneySchool, studentId: string) => (await getOk<FeeDocumentListDTO>(t, `/fee-documents?studentId=${studentId}&kind=BILL&pageSize=50`)).items;
export const billOf = async (t: MoneySchool, studentId: string, periodKey = '2026-11') => (await billsOf(t, studentId)).find((b) => b.periodKey === periodKey)!;

let keyCounter = 0;
/** A fresh idempotency key. */
export const key = (prefix = 'k') => `${prefix}-${Date.now()}-${(keyCounter += 1)}`;

export const openShift = async (login: { agent: Agent }, openingFloatPaise = 0) => created<{ shiftId: string }>(await login.agent.post(`${API}/finance/cashier-shifts/open`).send({ openingFloatPaise }));
export { data };
