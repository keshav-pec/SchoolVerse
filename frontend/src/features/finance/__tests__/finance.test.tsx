import { useState, type ReactNode } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Route, Routes } from 'react-router';
import { bundlePermissions, type AssignmentRecommendationDTO, type BalanceExplanationDTO, type BillingRunDTO, type FeePlanDTO, type FeePlanVersionDTO, type FinanceBundle, type FinanceReadinessDTO, type OutstandingDTO, type ParentStudentFeesDTO, type SessionDTO, type StudentAccountDTO } from '@shared';
import { MoneyField } from '@/components/finance/money';
import { useAuth } from '@/lib/auth';
import { bpsToPercentText, formatMoney, formatMoneyShort, paiseToText, percentTextToBps, toPaise } from '@/lib/money';
import { academicSession, classOffering, LOCATION_ID, masterLocation, SESSION_ID, STUDENT_ID, sessionFor } from '@/test/fixtures';
import { mockApi, pickOption, renderWithApp, type MockResponse } from '@/test/utils';
import { ParentFeesPage } from '../../parent/parent-fees-page';
import { FinanceLayout } from '../context';
import { FeesPage } from '../fees-page';
import { FinanceOverviewPage } from '../overview-page';
import { FinanceSettingsPage } from '../settings-page';
import { StudentAccountPage } from '../student-account-page';

afterEach(() => vi.unstubAllGlobals());

const API = '/api/v1';
const F = `${API}/finance`;
const RUN_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const HEAD_ID = 'b1b1b1b1-0000-4000-8000-000000000001';
const PLAN_ID = 'c1c1c1c1-0000-4000-8000-000000000001';
const VERSION_ID = 'c2c2c2c2-0000-4000-8000-000000000001';
const V_A = 'd1d1d1d1-0000-4000-8000-000000000001';
const V_B = 'd2d2d2d2-0000-4000-8000-000000000002';

type Handlers = Record<string, MockResponse | ((r: { url: URL; method: string; body: unknown }) => MockResponse | undefined)>;

function Ready({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session ? <>{children}</> : null;
}

/** A Staff login holding the given finance jobs. */
function staffWith(bundles: FinanceBundle[]): SessionDTO {
  const s = sessionFor('STAFF');
  return { ...s, permissions: [...new Set([...s.permissions, ...bundlePermissions(bundles)])] };
}

const year = {
  financialYearId: 'fy1',
  code: '2026-27',
  startDate: '2026-04-01',
  endDate: '2027-03-31',
  periods: Array.from({ length: 12 }, (_, i) => {
    const month = ((i + 3) % 12) + 1;
    const y = month >= 4 ? 2026 : 2027;
    const code = `${y}-${String(month).padStart(2, '0')}`;
    return { periodId: `p${i}`, financialYearId: 'fy1', code, month, startDate: `${code}-01`, endDate: `${code}-28`, state: 'OPEN' as const };
  }),
};

function base(extra: Handlers = {}, as?: SessionDTO): Handlers {
  return {
    ...(as ? { [`GET ${API}/auth/me`]: { data: as } } : {}),
    [`GET ${API}/academic-sessions`]: { data: [academicSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation] },
    [`GET ${API}/academic-sessions/${SESSION_ID}/class-offerings`]: { data: [classOffering] },
    [`GET ${F}/financial-years`]: { data: [year] },
    ...extra,
  };
}

function renderFinance(route: string, handlers: Handlers = {}, as?: SessionDTO) {
  const api = mockApi(as ? 'STAFF' : 'SCHOOL_ADMIN', base(handlers, as));
  renderWithApp(
    <Ready>
      <Routes>
        <Route path="/finance" element={<FinanceLayout />}>
          <Route index element={<FinanceOverviewPage />} />
          <Route path="fees" element={<FeesPage />} />
          <Route path="fees/students/:studentId" element={<StudentAccountPage />} />
          <Route path="settings" element={<FinanceSettingsPage />} />
        </Route>
      </Routes>
    </Ready>,
    { route },
  );
  return api;
}

const readiness = (items: FinanceReadinessDTO['items']): FinanceReadinessDTO => {
  const ready = items.filter((i) => i.status !== 'NEEDS_ATTENTION').length;
  return { items, ready, total: items.length, headline: `${ready} of ${items.length} ready. Next: add a bank account.` };
};

const emptyAging: OutstandingDTO = { asOf: '2026-11-22', buckets: [], byClass: [], totalPaise: 0, rows: [] };
const accountsEmpty = { items: [], total: 0, page: 1, pageSize: 25 };

const recommendation = (over: Partial<AssignmentRecommendationDTO> = {}): AssignmentRecommendationDTO => ({
  sessionId: SESSION_ID,
  locationId: LOCATION_ID,
  classes: [{ classOfferingId: classOffering.classOfferingId, className: 'Class VIII', eligible: 164, ready: 157, needReview: 7, alreadyAssigned: 0 }],
  totals: { eligible: 164, ready: 157, needReview: 7, alreadyAssigned: 0 },
  expectedPaise: 412_000_000,
  rows: [],
  ...over,
});

const version = (over: Partial<FeePlanVersionDTO> = {}): FeePlanVersionDTO => ({
  versionId: VERSION_ID,
  planId: PLAN_ID,
  versionNo: 1,
  effectiveFrom: '2026-04-01',
  state: 'DRAFT',
  items: [{ itemId: 'i1', feeHeadId: HEAD_ID, feeHeadName: 'Tuition Fee', amountPaise: 400_000, frequency: 'MONTHLY', dueDay: 10, graceDays: 0, prorationMethod: 'FULL_PERIOD', isOptional: false }],
  yearlyPaise: 4_800_000,
  approvedBy: null,
  publishedAt: null,
  ...over,
});

const plan = (over: Partial<FeePlanDTO> = {}): FeePlanDTO => ({
  planId: PLAN_ID,
  name: 'Class VIII 2026-27',
  sessionId: SESSION_ID,
  appliesTo: { locationIds: [LOCATION_ID], classIds: [classOffering.classId], studentType: 'ALL', studentId: null },
  autoAssign: true,
  status: 'ACTIVE',
  latestVersion: version(),
  publishedVersion: null,
  versions: [{ versionId: VERSION_ID, versionNo: 1, state: 'DRAFT', effectiveFrom: '2026-04-01' }],
  ...over,
});

// ───────────────────────────────────────────────────────────── money

describe('money on screen', () => {
  it('(FIN-12) shows rupees with lakh and crore commas, never a float, and reads back what it wrote', () => {
    expect(formatMoney(400_000)).toBe('₹4,000');
    expect(formatMoney(15_050)).toBe('₹150.50');
    expect(formatMoney(123_456_789_00)).toBe('₹12,34,56,789');
    expect(formatMoney(-5_000)).toBe('-₹50');
    expect(formatMoneyShort(412_000_000)).toBe('₹41.2 lakh');
    expect(formatMoneyShort(11_800_000_000)).toBe('₹11.8 crore');
    expect(toPaise('1,500.50')).toBe(150_050);
    expect(toPaise('₹4000')).toBe(400_000);
    expect(toPaise('12.345')).toBeNull();
    expect(toPaise('abc')).toBeNull();
    expect(paiseToText(150_050)).toBe('1500.50');
    expect(paiseToText(400_000)).toBe('4000');
    expect(percentTextToBps('12.5')).toBe(1250);
    expect(bpsToPercentText(1800)).toBe('18');
    expect(bpsToPercentText(1250)).toBe('12.5');
  });

  it('(FUX-14) MoneyField takes rupees and hands out whole paise, and says so when the text is not an amount', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [v, setV] = useState<number | null>(null);
      return (
        <>
          <MoneyField label="Amount" value={v} onChange={setV} />
          <output data-testid="paise">{String(v)}</output>
        </>
      );
    }
    renderWithApp(<Harness />);
    await user.type(screen.getByRole('textbox', { name: /amount/i }), '1,500.50');
    expect(screen.getByTestId('paise')).toHaveTextContent('150050');
    await user.clear(screen.getByRole('textbox', { name: /amount/i }));
    await user.type(screen.getByRole('textbox', { name: /amount/i }), '12.345');
    expect(screen.getByTestId('paise')).toHaveTextContent('null');
    expect(screen.getByText(/enter an amount like 1500/i)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────── setup

describe('finance settings (FIN-01 to 07, TAX-01 to 03, FUX-01)', () => {
  const items: FinanceReadinessDTO['items'] = [
    { key: 'legal_entity', title: 'School details', status: 'DONE', sentence: 'Greenfield is set up.', fix: null },
    { key: 'tax_profile', title: 'GST details', status: 'NOT_NEEDED', sentence: 'GST is optional if the school is not registered.', fix: null },
    { key: 'bank_account', title: 'Bank account', status: 'NEEDS_ATTENTION', sentence: 'Add the school bank account.', fix: { label: 'Add Bank Account', path: '/finance/settings?tab=bank' } },
    { key: 'fee_plan', title: 'Fee plan', status: 'NEEDS_ATTENTION', sentence: 'Publish a fee plan for the current session.', fix: { label: 'Add Fee Plan', path: '/finance/fees?tab=plans' } },
  ];

  it('(FUX-01) the checklist says what is done, shows a Fix button on every item that needs attention, and none on the rest', async () => {
    renderFinance('/finance/settings', { [`GET ${F}/readiness`]: { data: readiness(items) } });
    expect(await screen.findByTestId('readiness-headline')).toHaveTextContent('2 of 4 ready. Next: add a bank account.');
    const list = screen.getByRole('list', { name: 'Setup checklist' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(4);
    expect(within(list).getAllByRole('link', { name: /^Fix:/ })).toHaveLength(2);
    expect(within(rows[0]!).queryByRole('link')).toBeNull();
    expect(within(list).getByRole('link', { name: 'Fix: Bank account' })).toHaveAttribute('href', '/finance/settings?tab=bank');
    // the intro says what is required and what can be skipped
    expect(screen.getByLabelText('About Setup Checklist')).toHaveTextContent(/GST is optional/i);
  });

  it('(TAX-02) tax codes are marked "example only" and the help says tuition is usually exempt but to ask the accountant', async () => {
    const user = userEvent.setup();
    renderFinance('/finance/settings?tab=school', {
      [`GET ${F}/legal-entity`]: { data: { legalEntityId: 'e1', name: 'Greenfield Public School Trust', legalForm: 'TRUST', pan: null, gstin: null, gstRegistered: false, stateCode: '03', stateName: 'Punjab', address: null, currency: 'INR', fyStartMonth: 4, status: 'ACTIVE' } },
      [`GET ${F}/tax-profile`]: { data: { gstRegistered: false, gstin: null, stateCode: '03', stateName: 'Punjab', note: '' } },
      [`GET ${F}/tax-codes`]: { data: [{ taxCodeId: 't1', code: 'EXEMPT_EDU', name: 'Exempt – educational service', category: 'EXEMPT', rateBps: 0, hsnSac: null, note: 'Example only. Confirm with your accountant.', status: 'ACTIVE', inUse: true }] },
    });
    expect(await screen.findByText('Exempt – educational service')).toBeInTheDocument();
    expect(screen.getByText(/these are examples/i)).toBeInTheDocument();
    expect(screen.getAllByText(/confirm with your accountant/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/most school tuition is usually exempt/i)).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /about tax codes/i }));
    await waitFor(() => expect(screen.getAllByText(/most school tuition is usually exempt/i)).toHaveLength(2)); // the warning above, and the "i" card
    // GST is optional: the GSTIN box only appears when the school says it is registered
    expect(screen.queryByRole('textbox', { name: /gstin/i })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: /registered for gst/i }));
    expect(screen.getByRole('textbox', { name: /gstin/i })).toBeInTheDocument();
  });

  it('(FIN-04) a bank account shows only its last four digits; Show asks for a reason first and writes it down', async () => {
    const user = userEvent.setup();
    const mock = renderFinance('/finance/settings?tab=bank', {
      [`GET ${F}/bank-accounts`]: { data: [{ bankAccountId: 'ba1', label: 'Fee collection', bankName: 'State Bank of India', holderName: null, accountNumberMasked: '••••1234', ifsc: 'SBIN0001234', purpose: 'FEES', glAccountId: 'g1', locationIds: [], status: 'ACTIVE', pendingApprovalId: null }] },
      [`GET ${F}/cash-accounts`]: { data: [] },
      [`POST ${F}/bank-accounts/ba1/reveal`]: { data: { bankAccountId: 'ba1', accountNumber: '123456781234' } },
    });
    expect(await screen.findByText('••••1234')).toBeInTheDocument();
    expect(screen.queryByText('123456781234')).toBeNull();
    await user.click(screen.getByRole('button', { name: /show the full number/i }));
    const ask = screen.getByRole('button', { name: 'Show Number' });
    expect(ask).toBeDisabled();
    await user.type(screen.getByLabelText(/why do you need to see it/i), 'Checking the cheque book');
    await user.click(ask);
    expect(await screen.findByTestId('revealed-number')).toHaveTextContent('123456781234');
    expect(mock.callsTo('/reveal', 'POST')[0]!.body).toEqual({ reason: 'Checking the cheque book' });
  });

  it('(FIN-06) approvals list shows what was asked and what it would change, and a person can approve or reject', async () => {
    const user = userEvent.setup();
    const mock = renderFinance('/finance/settings?tab=approvals', {
      [`GET ${F}/approvals`]: { data: { items: [{ approvalId: 'ap1', action: 'CREDIT_NOTE', entityType: 'fee_document', entityId: 'd1', amountPaise: 800_000, summary: 'Credit ₹8,000 on bill BILL/2026-27/000231', impact: 'The student will owe ₹0 on this bill instead of ₹8,000.', reason: 'Fee was charged twice', requestedBy: 'u9', requestedByName: 'Gurpreet Kaur', decision: 'PENDING', decidedBy: null, decidedByName: null, decisionReason: null, decidedAt: null, createdAt: '2026-11-20T10:00:00.000Z' }], total: 1, page: 1, pageSize: 25 } },
      [`GET ${F}/approval-policies`]: { data: [{ policyId: 'pol1', action: 'CREDIT_NOTE', thresholdPaise: 500_000, needsDifferentApprover: true, enabled: true, description: 'Credit notes above this amount need approval.' }] },
      [`POST ${F}/approvals/ap1/decide`]: { data: {} },
    });
    expect(await screen.findByText(/credit ₹8,000 on bill/i)).toBeInTheDocument();
    expect(screen.getByText(/what will change: the student will owe/i)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /ask for approval above/i })).toHaveValue('5000');
    await user.click(screen.getByRole('button', { name: /^approve:/i }));
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(mock.callsTo('/decide', 'POST')[0]!.body).toEqual({ decision: 'APPROVE' }));
  });

  it('(FIN-07) the Access tab is for people who may manage access, and ticking a job saves it at once', async () => {
    const user = userEvent.setup();
    const mock = renderFinance('/finance/settings?tab=access', {
      [`GET ${F}/access/users`]: { data: [{ userId: 'u7', fullName: 'Gurpreet Kaur', email: 'accounts@greenfield.demo', role: 'STAFF', bundles: ['COLLECTOR'], locationIds: null }] },
      [`PUT ${F}/access/users/u7`]: { data: {} },
    });
    expect(await screen.findByText('Gurpreet Kaur')).toBeInTheDocument();
    const group = screen.getByRole('group', { name: /finance jobs for gurpreet kaur/i });
    expect(within(group).getByRole('checkbox', { name: /cashier/i })).toBeChecked();
    await user.click(within(group).getByRole('checkbox', { name: /accountant/i }));
    await waitFor(() => expect(mock.callsTo('/access/users/u7', 'PUT')[0]!.body).toEqual({ bundles: ['COLLECTOR', 'ACCOUNTANT'], locationIds: null }));
  });

  it('(FIN-07) a staff login without access management never sees the Access tab', async () => {
    renderFinance('/finance/settings', { [`GET ${F}/readiness`]: { data: readiness(items) } }, staffWith(['ACCOUNTANT']));
    await screen.findByTestId('readiness-headline');
    expect(screen.queryByRole('tab', { name: 'Access' })).toBeNull();
    expect(screen.getByRole('tab', { name: 'Bank & Cash' })).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────── fee plans and assignment

describe('fee plans and smart assignment (FEE-01 to 04, FUX-05)', () => {
  it('(FUX-05) the button says "Assign 157 Students", assigns only the ready ones, and then says how many need a decision', async () => {
    const user = userEvent.setup();
    const mock = renderFinance('/finance/fees', {
      [`POST ${F}/fee-plan-assignments/recommend`]: { data: recommendation() },
      [`POST ${F}/fee-plan-assignments/bulk`]: { data: { done: 157, skipped: 7, expectedPaise: 412_000_000, results: [] } },
      [`GET ${F}/accounts`]: { data: accountsEmpty },
      [`GET ${F}/outstanding`]: { data: emptyAging },
    });
    expect(await screen.findByText(/164 eligible · 157 ready · 7 need review/)).toBeInTheDocument();
    expect(screen.getByText(/expected this year from these students: ₹41\.2 lakh/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Assign 157 Students' }));
    expect(await screen.findByText(/done 157\. 7 need your decision/i)).toBeInTheDocument();
    expect(mock.callsTo('/fee-plan-assignments/bulk', 'POST')[0]!.body).toEqual({ sessionId: SESSION_ID, locationId: LOCATION_ID });
  });

  it('(FEE-04) a student with two matching plans gets Choose Plan; a student with no plan can only be skipped', async () => {
    const user = userEvent.setup();
    const mock = renderFinance('/finance/fees', {
      [`POST ${F}/fee-plan-assignments/recommend`]: {
        data: recommendation({
          totals: { eligible: 3, ready: 1, needReview: 2, alreadyAssigned: 0 },
          rows: [
            { studentId: 's-conflict', studentName: 'Aman Verma', admissionNumber: 'A1', classOfferingId: 'c', className: 'Class VIII', status: 'PLAN_CONFLICT', planVersionId: null, planName: null, candidatePlans: [{ versionId: V_A, planName: 'Class VIII 2026-27' }, { versionId: V_B, planName: 'Class VIII Staff' }], reason: 'Two plans match.' },
            { studentId: 's-none', studentName: 'Neha Rao', admissionNumber: 'A2', classOfferingId: 'c', className: 'Class VIII', status: 'NO_PLAN', planVersionId: null, planName: null, candidatePlans: [], reason: 'No plan.' },
          ],
        }),
      },
      [`POST ${F}/fee-plan-assignments/bulk`]: { data: { done: 1, skipped: 0, expectedPaise: 0, results: [] } },
      [`GET ${F}/accounts`]: { data: accountsEmpty },
      [`GET ${F}/outstanding`]: { data: emptyAging },
    });
    expect(await screen.findByText('Aman Verma')).toBeInTheDocument();
    expect(screen.getByText(/two fee plans match\. choose the right one\./i)).toBeInTheDocument();
    expect(screen.getByText(/no fee plan fits this class yet\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose plan for Aman Verma' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choose plan for Neha Rao' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Skip Neha Rao' })).toBeInTheDocument();
    await pickOption(user, screen.getByRole('combobox', { name: 'Plan for Aman Verma' }), 'Class VIII Staff');
    await user.click(screen.getByRole('button', { name: 'Choose plan for Aman Verma' }));
    await waitFor(() => expect(mock.callsTo('/fee-plan-assignments/bulk', 'POST')[0]!.body).toMatchObject({ items: [{ studentId: 's-conflict', planVersionId: V_B }] }));
    await user.click(screen.getByRole('button', { name: 'Skip Neha Rao' }));
    expect(screen.queryByText('Neha Rao')).toBeNull();
  });

  it('(FEE-02) the plan builder checks a draft in plain words, then Publish shows how many students it will apply to and the expected money', async () => {
    const user = userEvent.setup();
    let ok = false;
    const mock = renderFinance('/finance/fees?tab=plans', {
      [`GET ${F}/fee-plans`]: { data: [] },
      [`POST ${F}/fee-plan-assignments/recommend`]: { data: recommendation() },
      [`GET ${F}/fee-heads`]: { data: [{ feeHeadId: HEAD_ID, code: 'TUITION', name: 'Tuition Fee', category: 'TUITION', incomeAccountId: 'a1', incomeAccountName: 'Tuition Income', taxCodeId: null, taxCodeName: null, priceMode: 'EXCLUSIVE', isRecurring: true, isOptional: false, isRefundableDeposit: false, status: 'ACTIVE', inUse: false }] },
      [`POST ${F}/fee-plans`]: { status: 201, data: plan() },
      [`PATCH ${F}/fee-plan-versions/${VERSION_ID}`]: { data: plan() },
      [`POST ${F}/fee-plan-versions/${VERSION_ID}/validate`]: () => ({
        data: ok ? { versionId: VERSION_ID, ok: true, problems: [], impact: { students: 164, expectedPaise: 412_000_000 } } : { versionId: VERSION_ID, ok: false, problems: [{ code: 'TAX_CODE_MISSING', message: 'Tuition Fee has no tax setting. Add a tax code to this fee head.' }], impact: { students: 164, expectedPaise: 412_000_000 } },
      }),
      [`POST ${F}/fee-plan-versions/${VERSION_ID}/publish`]: { data: plan({ publishedVersion: version({ state: 'PUBLISHED' }) }) },
    });
    await user.click((await screen.findAllByRole('button', { name: /new fee plan/i }))[0]!);
    await user.type(await screen.findByRole('textbox', { name: /plan name/i }), 'Class VIII 2026-27');
    await pickOption(user, screen.getByRole('combobox', { name: /fee type/i }), /^Tuition Fee/);
    await user.type(screen.getByRole('textbox', { name: /^amount/i }), '4000');
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    // the check is a list of problems in plain words, and Publish stays off
    const checks = await screen.findByRole('region', { name: 'Plan checks' });
    expect(within(checks).getByText(/tuition fee has no tax setting/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish…' })).toBeDisabled();
    expect(mock.callsTo('/finance/fee-plans', 'POST')[0]!.body).toMatchObject({ name: 'Class VIII 2026-27', sessionId: SESSION_ID, items: [{ feeHeadId: HEAD_ID, amountPaise: 400_000, frequency: 'MONTHLY' }] });

    ok = true;
    await user.click(screen.getByRole('button', { name: 'Save Draft' }));
    expect(await within(await screen.findByRole('region', { name: 'Plan checks' })).findByText(/no problems found/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Publish…' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('164')).toBeInTheDocument();
    expect(within(dialog).getByText('₹41.2 lakh')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Publish Plan' }));
    await waitFor(() => expect(mock.callsTo('/publish', 'POST')).toHaveLength(1));
  });

  it('(FEE-02) a published plan opens read-only with New Version, and has no Save button', async () => {
    const user = userEvent.setup();
    renderFinance('/finance/fees?tab=plans', {
      [`GET ${F}/fee-plans`]: { data: [plan({ latestVersion: version({ state: 'PUBLISHED' }), publishedVersion: version({ state: 'PUBLISHED' }) })] },
      [`POST ${F}/fee-plan-assignments/recommend`]: { data: recommendation() },
      [`GET ${F}/fee-heads`]: { data: [] },
    });
    await user.click(await screen.findByRole('button', { name: 'Open Class VIII 2026-27' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/a published plan never changes/i)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: /new version/i })).toBeInTheDocument();
    expect(within(drawer).queryByRole('button', { name: 'Save Draft' })).toBeNull();
    expect(within(drawer).getByText('₹4,000')).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────── concessions

describe('concessions (FEE-05, 06)', () => {
  it('(FEE-06) the suggested list says how many sibling and staff-child discounts were found, and Award All Suggested sends them all', async () => {
    const user = userEvent.setup();
    const suggestion = (i: number, type: 'SIBLING' | 'STAFF_CHILD') => ({ studentId: `s${i}`, studentName: `Student ${i}`, type, policyId: type === 'SIBLING' ? 'pol-sib' : 'pol-staff', policyName: type === 'SIBLING' ? 'Sibling discount' : 'Staff child discount', reason: type === 'SIBLING' ? 'Second child in the school.' : 'Parent works at the school.', alreadyAwarded: false });
    const suggestions = [...Array.from({ length: 12 }, (_, i) => suggestion(i, 'SIBLING')), ...Array.from({ length: 3 }, (_, i) => suggestion(100 + i, 'STAFF_CHILD'))];
    const mock = renderFinance('/finance/fees?tab=concessions', {
      [`GET ${F}/concession-policies`]: { data: [{ policyId: 'pol-sib', name: 'Sibling discount', type: 'SIBLING', valueType: 'PERCENT', value: 1000, feeHeadIds: [], stackMode: 'HIGHEST_WINS', capPercentBps: null, validFrom: null, validTo: null, needsEvidence: false, needsApproval: false, status: 'ACTIVE' }] },
      [`GET ${F}/concessions`]: { data: { items: [], total: 0, page: 1, pageSize: 25 } },
      [`POST ${F}/concessions/recommend`]: { data: suggestions },
      [`POST ${F}/concessions/award-many`]: { data: { done: suggestions.map(() => ({})), skipped: [] } },
    });
    expect(await screen.findByText('12 sibling discounts and 3 staff-child discounts found.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /award all suggested/i }));
    await waitFor(() => expect(mock.callsTo('/concessions/award-many', 'POST')).toHaveLength(1));
    expect((mock.callsTo('/concessions/award-many', 'POST')[0]!.body as { awards: unknown[] }).awards).toHaveLength(15);
    expect(await screen.findByText(/15 concessions awarded/i)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────── billing

describe('billing (FEE-09, FUX-04)', () => {
  const run = (over: Partial<BillingRunDTO> = {}): BillingRunDTO => ({
    runId: RUN_ID,
    periodKey: '2026-11',
    sessionId: SESSION_ID,
    locationId: LOCATION_ID,
    classIds: [],
    issueDate: '2026-11-05',
    dueDate: null,
    state: 'VALIDATED',
    counts: { ready: 2796, needsAttention: 54, issued: 0, skipped: 0 },
    totalPaise: 11_800_000_000,
    createdAt: '2026-11-05T00:00:00.000Z',
    ...over,
  });
  const row = (id: string, name: string, reasonCode: string, over = {}) => ({ rowId: id, studentId: `s-${id}`, studentName: name, className: 'Class VIII', status: 'NEEDS_ATTENTION', reasonCode, reasonText: null, fixHint: null, totalPaise: 0, documentId: null, ...over });
  const handlers = (state: BillingRunDTO = run()): Handlers => ({
    [`GET ${F}/billing-runs`]: { data: { items: [], total: 0, page: 1, pageSize: 20 } },
    [`POST ${F}/billing-runs`]: { status: 201, data: { ...state, state: 'DRAFT' } },
    [`POST ${F}/billing-runs/${RUN_ID}/validate`]: { data: { run: state, headline: '2,796 ready · 54 need attention', byReason: [] } },
    [`GET ${F}/billing-runs/${RUN_ID}`]: { data: state },
    [`GET ${F}/billing-runs/${RUN_ID}/rows`]: ({ url }) =>
      url.searchParams.get('status') === 'READY'
        ? { data: { items: [row('r1', 'Riya Sharma', '', { status: 'READY', reasonCode: null, totalPaise: 400_000 })], total: 1, page: 1, pageSize: 50 } }
        : { data: { items: [row('x1', 'Aman Verma', 'NO_PLAN'), row('x2', 'Neha Rao', 'NO_PLAN'), row('x3', 'Karan Mehta', 'TAX_CODE_MISSING')], total: 3, page: 1, pageSize: 50 } },
    [`POST ${F}/billing-runs/${RUN_ID}/commit`]: { data: { run: run({ state: 'ISSUED', counts: { ready: 0, needsAttention: 54, issued: 2796, skipped: 0 } }), issued: 2796, failed: 0, alreadyIssued: 0, totalPaise: 11_800_000_000 } },
  });

  it('(FUX-04) Check shows "2,796 ready · 54 need attention", the problems grouped by reason with a fix, and the ready rows stay collapsed', async () => {
    const user = userEvent.setup();
    renderFinance('/finance/fees?tab=billing', handlers());
    await user.click(await screen.findByRole('button', { name: 'Check' }));
    const result = await screen.findByRole('region', { name: 'Check result' });
    expect(result.querySelector('[aria-live="polite"]')).toHaveTextContent('2,796 ready·54 need attention·₹11.8 crore');
    // grouped by reason, each row with a fix or Skip
    const needs = await within(result).findByRole('region', { name: 'Needs a look' });
    expect(await within(needs).findByText('No fee plan')).toBeInTheDocument();
    expect(within(needs).getByText('Fee type has no tax setting')).toBeInTheDocument();
    expect(within(needs).getAllByRole('link', { name: 'Choose Plan' })).toHaveLength(2);
    expect(within(needs).getByRole('link', { name: 'Add Tax Code' })).toBeInTheDocument();
    expect(within(needs).getByRole('button', { name: 'Skip Aman Verma' })).toBeInTheDocument();
    // the ready rows are folded away until asked for
    const folded = within(result).getByText(/2,796 ready · show a few/i).closest('details')!;
    expect(folded).not.toHaveAttribute('open');
  });

  it('(FUX-14) Issue shows the money preview first, sends the checked numbers with an Idempotency-Key, and says running it again is safe', async () => {
    const user = userEvent.setup();
    const mock = renderFinance('/finance/fees?tab=billing', handlers());
    await user.click(await screen.findByRole('button', { name: 'Check' }));
    await user.click(await screen.findByRole('button', { name: 'Issue 2,796 Bills' }));
    const dialog = await screen.findByRole('alertdialog');
    const preview = within(dialog).getByRole('region', { name: 'What will change' });
    expect(within(preview).getByText('2,796')).toBeInTheDocument();
    expect(within(preview).getByText('₹11,80,00,000')).toBeInTheDocument();
    expect(within(preview).getByText('54 students')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Issue Bills' }));
    expect(await screen.findByText(/issued 2796 bills for ₹11,80,00,000/i)).toBeInTheDocument();
    expect(screen.getByText(/nobody is billed twice/i)).toBeInTheDocument();
    const commit = mock.callsTo('/commit', 'POST')[0]!;
    expect(commit.body).toEqual({ confirmedReadyCount: 2796, confirmedTotalPaise: 11_800_000_000 });
    const sent = (fetch as Mock).mock.calls.find(([url]) => String(url).includes('/commit'))![1] as RequestInit;
    expect((sent.headers as Record<string, string>)['Idempotency-Key']).toMatch(/\S{8,}/);
  });

  it('(FUX-04) a person without finance:billing:approve can check a run but has no Issue button', async () => {
    const user = userEvent.setup();
    renderFinance('/finance/fees?tab=billing', handlers(), staffWith(['FEE_MANAGER']));
    await user.click(await screen.findByRole('button', { name: 'Check' }));
    await screen.findByRole('region', { name: 'Check result' });
    expect(screen.queryByRole('button', { name: /^issue .* bills$/i })).toBeNull();
    expect(screen.getByText(/only an approver can issue the bills/i)).toBeInTheDocument();
  });

  it('(FEE-09) a problem with the numbers (PREVIEW_CHANGED) says to check again, in plain words', async () => {
    const user = userEvent.setup();
    renderFinance('/finance/fees?tab=billing', { ...handlers(), [`POST ${F}/billing-runs/${RUN_ID}/commit`]: { status: 409, error: { code: 'PREVIEW_CHANGED', message: 'x' } } });
    await user.click(await screen.findByRole('button', { name: 'Check' }));
    await user.click(await screen.findByRole('button', { name: 'Issue 2,796 Bills' }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Issue Bills' }));
    expect(await screen.findByText(/the numbers changed since you checked them/i)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────── student account

describe('student account, explanation and family (FEE-12 to 14, FUX-07, 08)', () => {
  const account = (over: Partial<StudentAccountDTO> = {}): StudentAccountDTO => ({
    studentId: STUDENT_ID,
    studentName: 'Riya Sharma',
    admissionNumber: 'GPS/2026/00001',
    className: 'Class VIII',
    locationId: LOCATION_ID,
    billedPaise: 400_000,
    concessionPaise: 40_000,
    taxPaise: 0,
    creditedPaise: 0,
    paidPaise: 0,
    outstandingPaise: 360_000,
    overduePaise: 0,
    advancePaise: 0,
    expectedLaterPaise: 2_800_000,
    assignment: { assignmentId: 'as1', studentId: STUDENT_ID, sessionId: SESSION_ID, planVersionId: VERSION_ID, planName: 'Class VIII 2026-27', optionalItemIds: [], effectiveFrom: '2026-04-01', effectiveTo: null, source: 'AUTO' },
    ...over,
  });
  const explanation: BalanceExplanationDTO = {
    studentId: STUDENT_ID,
    lines: [
      { label: 'Tuition Fee', amountPaise: 400_000, sign: '+', documentId: 'doc1', journalId: 'j1' },
      { label: 'Sibling discount', amountPaise: 40_000, sign: '-', documentId: 'doc1', journalId: 'j1' },
    ],
    totalPaise: 360_000,
    sentence: 'Tuition Fee ₹4,000 − Sibling discount ₹400 = ₹3,600 left',
  };
  const studentHandlers = (acc = account(), exp = explanation): Handlers => ({
    [`GET ${F}/students/${STUDENT_ID}/account`]: { data: acc },
    [`GET ${F}/students/${STUDENT_ID}/ledger`]: { data: [{ entryId: 'e1', date: '2026-11-05', kind: 'BILL', amountPaise: 360_000, documentId: 'doc1', documentNumber: 'BILL/2026-27/000001', journalId: 'j1', description: 'Bill November' }] },
    [`GET ${F}/fee-documents`]: { data: { items: [{ documentId: 'doc1', number: 'BILL/2026-27/000001', kind: 'BILL', studentId: STUDENT_ID, studentName: 'Riya Sharma', periodKey: '2026-11', issueDate: '2026-11-05', dueDate: '2026-11-10', status: 'ISSUED', totalPaise: 360_000, paidPaise: 0, creditedPaise: 0, balancePaise: 360_000, overdue: false, parentDocumentId: null, journalId: 'j1', isTaxInvoice: false }], total: 1, page: 1, pageSize: 100 } },
    [`GET ${F}/students/${STUDENT_ID}/upcoming`]: { data: { items: [{ periodKey: '2026-12', dueDate: '2026-12-10', totalPaise: 400_000, lines: [{ description: 'Tuition Fee', totalPaise: 400_000 }] }], totalPaise: 400_000 } },
    [`GET ${F}/students/${STUDENT_ID}/balance-explanation`]: { data: exp },
  });

  it('(FUX-07) the account shows separate labelled amounts, with future fees apart from what is owed, and no control that edits a balance', async () => {
    renderFinance(`/finance/fees/students/${STUDENT_ID}`, studentHandlers());
    expect(await screen.findByRole('heading', { name: 'Riya Sharma' })).toBeInTheDocument();
    const amounts = screen.getByRole('region', { name: 'Amounts on this account' });
    for (const label of ['Billed', 'Concession', 'Tax', 'Paid', 'Outstanding', 'Overdue']) expect(within(amounts).getByRole('group', { name: label })).toBeInTheDocument();
    expect(within(within(amounts).getByRole('group', { name: 'Outstanding' })).getByText('₹3,600')).toBeInTheDocument();
    const later = within(screen.getByRole('region', { name: 'Held and expected amounts' })).getByRole('group', { name: 'Expected later' });
    expect(within(later).getByText('₹28,000')).toBeInTheDocument();
    expect(later).toHaveTextContent(/not counted as owed/i);
    // nothing edits a balance
    expect(screen.queryByRole('textbox', { name: /outstanding|balance|amount owed/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /(edit|change|set|adjust) (the )?(balance|outstanding)/i })).toBeNull();
    // the payment buttons are on screen, greyed out, with the reason
    for (const label of ['Collect', 'Report Claim', 'Refund', 'Send Reminder']) expect(screen.getByRole('button', { name: label })).toBeDisabled();
    expect(screen.getByText(/coming soon: taking payments/i)).toBeInTheDocument();
  });

  it('(FEE-13) Explain This Balance lists every part, each part adds up to the amount owed, and the drawer says it matches the account', async () => {
    const user = userEvent.setup();
    renderFinance(`/finance/fees/students/${STUDENT_ID}`, studentHandlers());
    await user.click(await screen.findByRole('button', { name: 'Explain This Balance' }));
    const parts = await screen.findByRole('list', { name: 'Parts of the balance' });
    const lines = within(parts).getAllByRole('listitem');
    expect(lines).toHaveLength(2);
    const signed = explanation.lines.reduce((s, l) => s + (l.sign === '+' ? l.amountPaise : -l.amountPaise), 0);
    expect(screen.getByTestId('explain-total')).toHaveTextContent(formatMoney(signed));
    expect(screen.getByTestId('explain-total')).toHaveTextContent('₹3,600');
    expect(screen.getByTestId('explain-sentence')).toHaveTextContent('Tuition Fee ₹4,000 − Sibling discount ₹400 = ₹3,600 left');
    expect(screen.getByText(/this matches the amount on the student’s account/i)).toBeInTheDocument();
    // each part with a bill can be opened
    expect(within(lines[0]!).getByRole('button', { name: /open the bill for tuition fee/i })).toBeInTheDocument();
  });

  it('(FEE-13) if an explanation ever disagrees with the account, the drawer says so instead of hiding it', async () => {
    const user = userEvent.setup();
    renderFinance(`/finance/fees/students/${STUDENT_ID}`, studentHandlers(account({ outstandingPaise: 999_000 })));
    await user.click(await screen.findByRole('button', { name: 'Explain This Balance' }));
    expect(await screen.findByText(/this does not match the account/i)).toBeInTheDocument();
  });

  it('(FUX-08) the family view shows each child on their own line with a total that only adds them up on screen', async () => {
    const GUARDIAN = 'ee000000-0000-4000-8000-0000000000aa';
    renderFinance(`/finance/fees?tab=accounts&family=${GUARDIAN}`, {
      [`GET ${F}/families/${GUARDIAN}`]: {
        data: {
          guardianPersonId: GUARDIAN,
          guardianName: 'Simran Kaur',
          children: [account({ studentId: 'k1', studentName: 'Aarav Kaur', outstandingPaise: 500_000 }), account({ studentId: 'k2', studentName: 'Riya Kaur', outstandingPaise: 350_000 })],
          totals: { billedPaise: 0, paidPaise: 0, outstandingPaise: 850_000, overduePaise: 0, advancePaise: 0 },
        },
      },
    });
    expect(await screen.findByText(/simran kaur’s family/i)).toBeInTheDocument();
    expect(screen.getByText(/each child has a separate account/i)).toBeInTheDocument();
    const kids = within(screen.getByRole('list', { name: 'Children' })).getAllByRole('listitem');
    expect(kids).toHaveLength(2);
    expect(within(screen.getByLabelText('Family total')).getByText('₹8,500')).toBeInTheDocument();
  });

  it('(FUX-07) the Accounts list finds students by name or parent and every row shows Billed, Paid, Outstanding and Overdue worked out by the server', async () => {
    const user = userEvent.setup();
    const mock = renderFinance('/finance/fees', {
      [`POST ${F}/fee-plan-assignments/recommend`]: { data: recommendation({ totals: { eligible: 1, ready: 0, needReview: 0, alreadyAssigned: 1 } }) },
      [`GET ${F}/outstanding`]: { data: emptyAging },
      [`GET ${F}/accounts`]: ({ url }) => ({
        data: {
          items: url.searchParams.get('q') === 'simran' || !url.searchParams.get('q') ? [{ studentId: STUDENT_ID, studentName: 'Riya Sharma', admissionNumber: 'GPS/2026/00001', className: 'Class VIII-A', guardianName: 'Simran Kaur', guardianPersonId: 'g1', billedPaise: 400_000, paidPaise: 100_000, outstandingPaise: 300_000, overduePaise: 300_000, advancePaise: 0 }] : [],
          total: 1,
          page: 1,
          pageSize: 25,
        },
      }),
    });
    expect(await screen.findByRole('link', { name: 'Riya Sharma' })).toHaveAttribute('href', `/finance/fees/students/${STUDENT_ID}`);
    expect(screen.getByRole('link', { name: /open the family of simran kaur/i })).toHaveAttribute('href', '/finance/fees?tab=accounts&family=g1');
    expect(screen.getByText('₹3,000', { selector: 'b' })).toBeInTheDocument();
    await user.type(screen.getByRole('textbox', { name: 'Search students' }), 'simran');
    await waitFor(() => expect(mock.callsTo('/finance/accounts').some((c) => c.path.includes('q=simran'))).toBe(true));
    expect(screen.getByText(/cannot be edited here/i)).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────── overview

describe('overview (FUX-02)', () => {
  it('(FUX-02) shows the three Finance Pulse tiles and the setup checklist card, with a fix link for what is missing', async () => {
    renderFinance('/finance', {
      [`GET ${F}/pulse`]: { data: { month: '2026-11', billedPaise: 1_250_000, billCount: 3 } },
      [`GET ${F}/outstanding`]: { data: { ...emptyAging, totalPaise: 800_000, buckets: [{ bucket: 'CURRENT', count: 1, totalPaise: 300_000 }, { bucket: 'D1_30', count: 1, totalPaise: 500_000 }] } },
      [`GET ${F}/readiness`]: { data: readiness([{ key: 'bank_account', title: 'Bank account', status: 'NEEDS_ATTENTION', sentence: 'Add the school bank account.', fix: { label: 'Add Bank Account', path: '/finance/settings?tab=bank' } }]) },
    });
    const tiles = await screen.findByLabelText('Finance pulse');
    await waitFor(() => expect(within(within(tiles).getByRole('region', { name: 'Billed this month' })).getByText('₹12,500')).toBeInTheDocument());
    expect(within(within(tiles).getByRole('region', { name: 'Outstanding' })).getByText('₹8,000')).toBeInTheDocument();
    expect(within(within(tiles).getByRole('region', { name: 'Overdue' })).getByText('₹5,000')).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Add Bank Account' })).toHaveAttribute('href', '/finance/settings?tab=bank');
  });
});

// ───────────────────────────────────────────────────────────── parent

describe('parent fees (FUX-08, 09)', () => {
  const fees = (id: string, name: string, due: number): ParentStudentFeesDTO => ({
    studentId: id,
    studentName: name,
    outstandingPaise: due,
    overduePaise: 0,
    advancePaise: 0,
    bills: [{ documentId: `d-${id}`, number: `BILL/2026-27/${id}`, kind: 'BILL', issueDate: '2026-11-05', dueDate: '2026-11-10', status: 'ISSUED', totalPaise: due, balancePaise: due, overdue: false, lines: [{ description: 'Tuition Fee', discountPaise: 40_000, taxPaise: 0, totalPaise: due }] }],
    howToPay: id === 'k1' ? { bankName: 'State Bank of India', holderName: 'Greenfield Trust', accountLast4: '1234', ifsc: 'SBIN0001234', instructions: 'Pay at the school office, or send a bank transfer to State Bank of India.' } : null,
  });

  it('(FUX-08) a parent sees "Total due ₹8,500: Aarav ₹5,000 · Riya ₹3,500", each child’s bills with the maths, and how to pay', async () => {
    const mock = mockApi('PARENT', {
      [`GET ${API}/parent/fees/summary`]: { data: { children: [{ studentId: 'k1', studentName: 'Aarav Kaur', className: 'VIII-A', outstandingPaise: 500_000, overduePaise: 0, advancePaise: 0, nextDueDate: '2026-11-10', nextDuePaise: 500_000 }, { studentId: 'k2', studentName: 'Riya Kaur', className: 'V-B', outstandingPaise: 350_000, overduePaise: 0, advancePaise: 0, nextDueDate: '2026-11-10', nextDuePaise: 350_000 }] } },
      [`GET ${API}/parent/fees/students/k1`]: { data: fees('k1', 'Aarav Kaur', 500_000) },
      [`GET ${API}/parent/fees/students/k2`]: { data: fees('k2', 'Riya Kaur', 350_000) },
    });
    renderWithApp(
      <Ready>
        <ParentFeesPage />
      </Ready>,
    );
    expect(await screen.findByTestId('family-total')).toHaveTextContent('Total due ₹8,500 · Aarav ₹5,000 · Riya ₹3,500');
    expect(await screen.findByRole('region', { name: 'Fees for Aarav Kaur' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Fees for Riya Kaur' })).toBeInTheDocument();
    expect(screen.getAllByText(/discount −₹400/i).length).toBe(2);
    const how = await screen.findByRole('region', { name: 'How to pay' });
    expect(how).toHaveTextContent('State Bank of India');
    expect(how).toHaveTextContent('•••• 1234');
    // only the linked children were asked for: no request for any other child
    expect([...new Set(mock.callsTo('/parent/fees/students/').map((c) => c.path))].sort()).toEqual(['/api/v1/parent/fees/students/k1', '/api/v1/parent/fees/students/k2']);
  });

  it('(FUX-09) a parent with no child allowed to see fees gets a polite message with no amount and no hint of one', async () => {
    mockApi('PARENT', { [`GET ${API}/parent/fees/summary`]: { data: { children: [] } } });
    renderWithApp(
      <Ready>
        <ParentFeesPage />
      </Ready>,
    );
    expect(await screen.findByText('No fees to show')).toBeInTheDocument();
    expect(screen.queryByText(/₹/)).toBeNull();
  });
});
