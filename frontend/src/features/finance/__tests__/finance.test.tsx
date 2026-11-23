import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, type Mock } from 'vitest';
import { Route, Routes } from 'react-router';
import { bundlePermissions, type AssignmentRecommendationDTO, type BalanceExplanationDTO, type BillingRunDTO, type FeePlanDTO, type FeePlanVersionDTO, type FinanceBundle, type FinanceReadinessDTO, type OutstandingDTO, type ParentStudentFeesDTO, type SessionDTO, type StudentAccountDTO, type BankAccountDTO, type ClaimDTO, type CloseReadinessDTO, type CollectionDTO, type CollectionResultDTO, type PayrollRunDTO, type PayslipDTO, type ReconExceptionsDTO, type ReportDTO, type VerificationItemDTO } from '@shared';
import { MoneyField } from '@/components/finance/money';
import { bpsToPercentText, formatMoney, formatMoneyShort, paiseToText, percentTextToBps, toPaise } from '@/lib/money';
import { academicSession, classOffering, LOCATION_ID, masterLocation, SESSION_ID, STUDENT_ID, sessionFor } from '@/test/fixtures';
import { API, Ready, mockApi, pickOption, renderWithApp, type MockResponse } from '@/test/utils';
import { ParentFeesPage } from '../../parent/parent-fees-page';
import { FinanceLayout } from '../context';
import { FeesPage } from '../fees-page';
import { FinanceOverviewPage } from '../overview-page';
import { FinanceSettingsPage } from '../settings-page';
import { StudentAccountPage } from '../student-account-page';
import { RequireEmployeeLogin, RequireFinanceAccess, RequireFinancePermission } from '@/routes/guards';
import { MySalaryPage } from '../../me/my-salary-page';
import { AccountingPage } from '../accounting/accounting-page';
import { BankingPage } from '../banking/banking-page';
import { CollectPage } from '../collect/collect-page';
import { RefundDrawer } from '../collect/refunds-tab';
import { breakdown } from '../collect/take-payment';
import { ExpensesPage } from '../expenses/expenses-page';
import { PayrollPage } from '../payroll/payroll-page';

const F = `${API}/finance`;
const RUN_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const HEAD_ID = 'b1b1b1b1-0000-4000-8000-000000000001';
const PLAN_ID = 'c1c1c1c1-0000-4000-8000-000000000001';
const VERSION_ID = 'c2c2c2c2-0000-4000-8000-000000000001';
const V_A = 'd1d1d1d1-0000-4000-8000-000000000001';
const V_B = 'd2d2d2d2-0000-4000-8000-000000000002';

type Handlers = Record<string, MockResponse | ((r: { url: URL; method: string; body: unknown }) => MockResponse | undefined)>;

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
    // the money actions are switched on (Part 4): Collect opens Take Payment for this student
    expect(screen.getByRole('link', { name: 'Collect' })).toHaveAttribute('href', `/finance/collect?tab=take&student=${STUDENT_ID}`);
    for (const label of ['Report Claim', 'Refund', 'Send Reminder']) expect(screen.getByRole('button', { name: label })).toBeEnabled();
    expect(screen.queryByText(/coming soon/i)).toBeNull();
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

/**
 * Module 7, Part 4 screens: collections, banking, payroll, My Salary, expenses, close, reports, the parent's payment report and the
 * route guards. QA tags in the titles.
 */

const P = `${API}/payroll`;
const BANK_ID = 'b0b0b0b0-0000-4000-8000-000000000001';
const PAY_RUN_ID = 'a2a2a2a2-0000-4000-8000-000000000001';


const octYear = {
  financialYearId: 'fy1',
  code: '2026-27',
  startDate: '2026-04-01',
  endDate: '2027-03-31',
  periods: [{ periodId: 'p-oct', financialYearId: 'fy1', code: '2026-10', month: 10, startDate: '2026-10-01', endDate: '2026-10-31', state: 'OPEN' as const }],
};

const bank: BankAccountDTO = { bankAccountId: BANK_ID, label: 'Fees account', bankName: 'State Bank', holderName: null, accountNumberMasked: '••••1234', ifsc: 'SBIN0001234', purpose: 'FEES', glAccountId: 'gl1', locationIds: [], status: 'ACTIVE', pendingApprovalId: null };

function opsBase(extra: Handlers = {}, as?: SessionDTO): Handlers {
  return {
    ...(as ? { [`GET ${API}/auth/me`]: { data: as } } : {}),
    [`GET ${API}/academic-sessions`]: { data: [academicSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation] },
    [`GET ${API}/academic-sessions/${SESSION_ID}/class-offerings`]: { data: [classOffering] },
    [`GET ${F}/financial-years`]: { data: [octYear] },
    [`GET ${F}/bank-accounts`]: { data: [bank] },
    [`GET ${F}/cash-accounts`]: { data: [{ cashAccountId: 'c1', label: 'Front office cash', glAccountId: 'g', locationIds: [], status: 'ACTIVE' }] },
    [`GET ${F}/verification-queue`]: { data: { items: [], total: 0 } },
    ...extra,
  };
}

function renderOps(route: string, handlers: Handlers = {}, as?: SessionDTO) {
  const api = mockApi(as ? 'STAFF' : 'SCHOOL_ADMIN', opsBase(handlers, as));
  renderWithApp(
    <Ready>
      <Routes>
        <Route path="/finance" element={<FinanceLayout />}>
          <Route path="collect" element={<CollectPage />} />
          <Route path="banking" element={<BankingPage />} />
          <Route path="payroll" element={<PayrollPage />} />
          <Route path="expenses" element={<ExpensesPage />} />
          <Route path="accounting" element={<AccountingPage />} />
        </Route>
      </Routes>
    </Ready>,
    { route },
  );
  return api;
}

const collection = (over: Partial<CollectionDTO> = {}): CollectionDTO => ({
  collectionId: 'col1', method: 'CASH', status: 'POSTED', payerName: null, amountPaise: 950_000, unallocatedPaise: 150_000, receivedOn: '2026-11-20', reference: null, flags: [], cheque: null, provisionalNumber: null,
  receiptId: 'r1', receiptNumber: 'RCT/2026-27/000001', claimId: null, shiftId: 's1', bankAccountId: null, cashAccountId: 'c1', students: [{ studentId: STUDENT_ID, studentName: 'Riya Sharma' }], plannedAllocations: [], allocations: [], cashierName: 'Test User', returnedReason: null, createdAt: '2026-11-20T10:00:00.000Z',
  ...over,
});

const result = (over: Partial<CollectionDTO> = {}, receipt = true): CollectionResultDTO => ({
  collection: collection(over),
  receipt: receipt ? { receiptId: 'r1', number: 'RCT/2026-27/000001', collectionId: 'col1', status: 'ISSUED', amountPaise: 950_000, advancePaise: 150_000, method: 'CASH', receivedOn: '2026-11-20', payerName: null, lines: [{ studentId: STUDENT_ID, studentName: 'Riya Sharma', documentNumber: 'BILL/1', amountPaise: 400_000 }], cancelledReason: null, cancelledAt: null } : null,
  repeated: false,
});

const shift = { shiftId: 's1', cashierId: 'u1', cashierName: 'Test User', locationId: LOCATION_ID, cashAccountId: 'c1', state: 'OPEN', openingPaise: 0, collectedPaise: 0, refundedPaise: 0, expectedPaise: 0, countedPaise: null, variancePaise: null, varianceNote: null, depositedPaise: 0, signedOffByName: null, openedAt: '2026-11-20T08:00:00.000Z', closedAt: null, sentence: null };

const bill = (n: number, due: string, balance: number) => ({ documentId: `doc${n}`, number: `BILL/2026-27/00000${n}`, kind: 'BILL', studentId: STUDENT_ID, studentName: 'Riya Sharma', periodKey: due.slice(0, 7), issueDate: due, dueDate: due, status: 'ISSUED', totalPaise: balance, paidPaise: 0, creditedPaise: 0, balancePaise: balance, overdue: n === 1, parentDocumentId: null, journalId: null, isTaxInvoice: false });

function takeHandlers(extra: Handlers = {}): Handlers {
  return {
    [`GET ${F}/students/${STUDENT_ID}/account`]: { data: { studentId: STUDENT_ID, studentName: 'Riya Sharma', admissionNumber: 'GPS/1', className: 'Class VIII-A', locationId: LOCATION_ID, billedPaise: 800_000, concessionPaise: 0, taxPaise: 0, creditedPaise: 0, paidPaise: 0, outstandingPaise: 800_000, overduePaise: 400_000, advancePaise: 0, expectedLaterPaise: 0, assignment: null } },
    [`GET ${F}/fee-documents`]: { data: { items: [bill(2, '2026-11-10', 400_000), bill(1, '2026-10-10', 400_000)], total: 2, page: 1, pageSize: 100 } },
    [`GET ${F}/accounts`]: { data: { items: [], total: 0, page: 1, pageSize: 25 } },
    [`GET ${F}/cashier-shifts/mine`]: { data: shift },
    ...extra,
  };
}

// ───────────────────────────────────────────────────────────── collections

describe('Take Payment (FUX-06, COL-02, COL-03)', () => {
  it('(COL-03) pays the oldest bills first and keeps the rest as an advance', () => {
    const bills = [
      { documentId: 'a', number: 'A', studentId: 's', studentName: 'x', dueDate: '2026-10-10', balancePaise: 400_000, overdue: true },
      { documentId: 'b', number: 'B', studentId: 's', studentName: 'x', dueDate: '2026-11-10', balancePaise: 400_000, overdue: false },
    ];
    expect(breakdown(bills, new Set(['a', 'b']), 500_000)).toEqual({ lines: [{ bill: bills[0], payPaise: 400_000 }, { bill: bills[1], payPaise: 100_000 }], advancePaise: 0 });
    expect(breakdown(bills, new Set(['b']), 500_000)).toEqual({ lines: [{ bill: bills[1], payPaise: 400_000 }], advancePaise: 100_000 });
  });

  it('(FUX-06) shows the live breakdown, oldest bill first, the advance note, and "wait for verification" for UPI', async () => {
    const user = userEvent.setup();
    renderOps(`/finance/collect?tab=take&student=${STUDENT_ID}`, takeHandlers());
    const bills = await screen.findByRole('list', { name: 'Open bills' });
    expect(within(bills).getAllByRole('listitem')[0]).toHaveTextContent('BILL/2026-27/000001');
    const box = screen.getByRole('textbox', { name: /amount received/i });
    expect(box).toHaveValue('8000');
    const plan = screen.getByRole('list', { name: 'Breakdown' });
    expect(within(plan).getAllByRole('listitem')).toHaveLength(2);
    await user.clear(box);
    await user.type(box, '9500');
    expect(await screen.findByTestId('advance-note')).toHaveTextContent('₹1,500 will be kept as advance.');
    await user.click(screen.getByRole('radio', { name: /^UPI/ }));
    expect(screen.getByText(/this will wait for verification/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save And Verify' })).toBeInTheDocument();
    // a bank payment needs its reference before it can be saved
    expect(screen.getByRole('button', { name: 'Save Payment' })).toBeDisabled();
  });

  it('(COL-02) a double click saves once, and the result card shows the receipt with Print, Share and Next Payment', async () => {
    const user = userEvent.setup();
    const mock = renderOps(`/finance/collect?tab=take&student=${STUDENT_ID}`, takeHandlers({ [`POST ${F}/collections`]: { status: 201, data: result() } }));
    await screen.findByRole('list', { name: 'Breakdown' });
    await user.dblClick(screen.getByRole('button', { name: 'Save Payment' }));
    const card = await screen.findByRole('region', { name: 'Payment saved' });
    expect(mock.callsTo('/finance/collections', 'POST')).toHaveLength(1);
    expect(mock.callsTo('/finance/collections', 'POST')[0]!.body).toMatchObject({ method: 'CASH', amountPaise: 800_000, allocations: [{ documentId: 'doc1', amountPaise: 400_000 }, { documentId: 'doc2', amountPaise: 400_000 }], advanceStudentId: STUDENT_ID });
    expect(within(card).getByText(/Receipt RCT\/2026-27\/000001/)).toBeInTheDocument();
    for (const name of ['Print', 'Share', 'Next Payment']) expect(within(card).getByRole('button', { name })).toBeInTheDocument();
  });

  it('(COL-06) cash with no open shift shows the Open Shift step right there, and Save Payment waits for it', async () => {
    renderOps(`/finance/collect?tab=take&student=${STUDENT_ID}`, takeHandlers({ [`GET ${F}/cashier-shifts/mine`]: { data: null } }));
    expect(await screen.findByRole('region', { name: 'Open your shift' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open Shift' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save Payment' })).toBeDisabled();
  });
});

describe('verification, cheques and refunds (COL-04, 07, 10)', () => {
  const item = (over: Partial<VerificationItemDTO> = {}): VerificationItemDTO => ({
    kind: 'CLAIM', id: 'cl1', method: 'UPI', amountPaise: 400_000, date: '2026-11-12', reference: 'UTR4821', students: [{ studentId: STUDENT_ID, studentName: 'Riya Sharma' }], reportedByName: 'Simran Kaur', reportedByParent: true, hasProof: true, flags: [], createdAt: '2026-11-12T09:00:00.000Z',
    suggestion: { lineId: 'l1', bankAccountId: BANK_ID, date: '2026-11-12', amountPaise: 400_000, reference: 'UTR4821', exact: true, sentence: 'Matches ₹4,000 on 12 Nov, ref …4821' },
    ...over,
  });

  it('(COL-04) the queue shows the suggested bank line, Fast Verify for an exact match, the duplicate warning, and that a UTR is not proof', async () => {
    renderOps('/finance/collect?tab=verify', { [`GET ${F}/verification-queue`]: { data: { items: [item(), item({ id: 'cl2', suggestion: null, flags: ['DUPLICATE_SUSPECTED'], createdAt: '2026-11-13T09:00:00.000Z' })], total: 2 } } });
    const list = await screen.findByRole('list', { name: 'Payments waiting for verification' });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(within(first!).getByTestId('suggested-line')).toHaveTextContent('Matches ₹4,000 on 12 Nov, ref …4821');
    expect(within(first!).getByRole('button', { name: 'Fast Verify' })).toBeInTheDocument();
    expect(within(first!).getByRole('button', { name: 'See Proof' })).toBeInTheDocument();
    expect(within(second!).getByText(/maybe a duplicate/i)).toBeInTheDocument();
    expect(within(second!).queryByRole('button', { name: 'Fast Verify' })).toBeNull();
    expect(screen.getByText(/a utr alone is not proof/i)).toBeInTheDocument();
  });

  it('(COL-07) a cheque gets its receipt only when it clears', async () => {
    const user = userEvent.setup();
    const cheque = collection({ method: 'CHEQUE', status: 'RECEIVED', receiptId: null, receiptNumber: null, provisionalNumber: 'ACK/2026-27/000001', cheque: { number: '000123', bankName: 'HDFC', chequeDate: '2026-11-18', payerName: null } });
    const mock = renderOps('/finance/collect?tab=cheques', {
      [`GET ${F}/collections`]: { data: { items: [cheque], total: 1, page: 1, pageSize: 25 } },
      [`POST ${F}/collections/col1/clear`]: { data: result({ method: 'CHEQUE', status: 'CLEARED' }) },
    });
    expect(await screen.findByText(/a receipt is made only after the cheque clears/i)).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Cheques' });
    expect(within(list).queryByText(/Receipt RCT/)).toBeNull();
    await user.click(within(list).getByRole('button', { name: /^Clear cheque 000123/ }));
    await user.click(await screen.findByRole('button', { name: 'Mark Cleared' }));
    await waitFor(() => expect(mock.callsTo('/collections/col1/clear', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/collections/col1/clear', 'POST')[0]!.body).toEqual({ clearedOn: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) });
  });

  it('(COL-10) New Refund shows how much can be refunded and why, before anything is asked', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${F}/students/${STUDENT_ID}/account`]: { data: { studentId: STUDENT_ID, studentName: 'Riya Sharma', admissionNumber: 'GPS/1', className: 'VIII-A', locationId: LOCATION_ID, billedPaise: 0, concessionPaise: 0, taxPaise: 0, creditedPaise: 0, paidPaise: 0, outstandingPaise: 0, overduePaise: 0, advancePaise: 150_000, expectedLaterPaise: 0, assignment: null } },
      [`GET ${F}/refundable`]: { data: { studentId: STUDENT_ID, advancePaise: 150_000, depositPaise: 0, outstandingPaise: 0, openRefundsPaise: 0, refundablePaise: 150_000, sentence: 'The school holds ₹1,500 as an advance and nothing is owed.' } },
    });
    renderWithApp(
      <Ready>
        <RefundDrawer open studentId={STUDENT_ID} onClose={() => undefined} />
      </Ready>,
    );
    expect(await screen.findByText('Can refund up to ₹1,500')).toBeInTheDocument();
    expect(screen.getByText(/holds ₹1,500 as an advance/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Ask For Refund' })).toBeDisabled();
  });
});

// ───────────────────────────────────────────────────────────── banking

describe('banking (FUX-10, FIN-10)', () => {
  const recon: ReconExceptionsDTO = {
    bankAccountId: BANK_ID,
    headline: '',
    counts: { imported: 432, matched: 407, waitingForVerification: 18, amountMismatches: 4, possibleDuplicates: 3, unmatched: 0, ignored: 0 },
    groups: [
      {
        key: 'WAITING_FOR_VERIFICATION',
        title: 'Waiting for verification',
        items: [
          {
            line: { lineId: 'l1', importId: 'i1', bankAccountId: BANK_ID, date: '2026-11-12', description: 'UPI CR PRIYA', reference: 'UTR4821', debitPaise: 0, creditPaise: 400_000, balancePaise: null, status: 'SUGGESTED', matchId: 'm1', ignoredReason: null },
            matches: [{ matchId: 'm1', bankAccountId: BANK_ID, state: 'SUGGESTED', confidence: 'HIGH', reasons: ['Same reference', 'Same amount'], auto: false, needsVerification: true, lines: [], targets: [{ type: 'collection', id: 'col1', label: 'Riya Sharma · UPI', amountPaise: 400_000, date: '2026-11-12', reference: 'UTR4821', verified: false }], linesPaise: 400_000, targetsPaise: 400_000 }],
            candidates: [],
            hint: 'A parent reported this payment. Check it and match it.',
          },
        ],
      },
    ],
    timingDifferences: [{ type: 'collection', id: 'chq', label: 'Cheque 000123', amountPaise: 250_000, date: '2026-11-19', reference: '000123', verified: true }],
  };

  it('(FUX-10) the headline counts everything and offers one Resolve button; the inspector gives the reasons in words', async () => {
    const user = userEvent.setup();
    renderOps('/finance/banking', { [`GET ${F}/reconciliation/exceptions`]: { data: recon }, [`GET ${F}/reconciliation/matches`]: { data: [] } });
    const headline = await screen.findByTestId('recon-headline');
    expect(headline).toHaveTextContent('432 imported · 407 matched · 18 waiting for verification · 4 amount mismatches · 3 possible duplicates');
    expect(screen.getByRole('region', { name: 'Timing differences' })).toHaveTextContent('Cheque 000123');
    await user.click(screen.getByRole('button', { name: 'Resolve 1 Exception' }));
    const dialog = await screen.findByRole('dialog', { name: 'Check this bank line' });
    expect(within(dialog).getByTestId('match-reasons')).toHaveTextContent('Same reference, same amount');
    expect(within(dialog).getByText('Very likely')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Verify And Match' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Ignore (Needs Approval)' })).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────── payroll

describe('payroll (FUX-11, 12, PAY-10)', () => {
  const run = (over: Partial<PayrollRunDTO> = {}): PayrollRunDTO => ({
    runId: PAY_RUN_ID, number: 'PRN/2026-27/000001', month: '2026-11', type: 'MONTHLY', state: 'APPROVED', payoutStatus: 'UNPAID', headline: 'November payroll · 3 employees · 2 ready · 1 need action',
    counts: { employees: 3, ready: 2, needAction: 1, held: 0 }, totals: { grossPaise: 12_600_000, deductionsPaise: 975_000, employerCostPaise: 720_000, netPaise: 11_625_000 }, previousNetPaise: 11_000_000,
    changeSentence: 'Net pay is ₹6,250 more than October.', warnings: [], locationId: null, parentRunId: null, preparedByName: 'Officer', approvedByName: 'Approver', finalizedAt: null, version: 3, createdAt: '2026-11-25T00:00:00.000Z',
    ...over,
  });
  const exceptionRow = { rowId: 'row1', runId: PAY_RUN_ID, employeeId: 'e1', employeeName: 'Gurpreet Kaur', employeeCode: 'FAC-001', departmentName: null, designationName: 'Teacher', locationId: null, status: 'NEEDS_ACTION' as const, held: false, holdReason: null, grossPaise: 0, deductionsPaise: 0, employerCostPaise: 0, netPaise: 0, paidDays: null, exceptions: [{ code: 'MISSING_INPUT' as const, level: 'BLOCKER' as const, message: 'No days for November.', fixHint: 'Add the leave summary.' }], paidOutPaise: 0, payslipId: null };

  it('(FUX-11) the run opens with the headline and totals, people who need action come first, and the ready rows stay folded', async () => {
    renderOps('/finance/payroll?tab=runs', { [`GET ${P}/runs`]: { data: { items: [run({ state: 'CALCULATED' })], total: 1, page: 1, pageSize: 24 } }, [`GET ${P}/runs/${PAY_RUN_ID}/exceptions`]: { data: { runId: PAY_RUN_ID, blockers: 1, items: [exceptionRow] } } });
    expect(await screen.findByTestId('payroll-headline')).toHaveTextContent('November payroll · 3 employees · 2 ready · 1 need action');
    for (const label of ['Gross', 'Deductions', 'Employer cost', 'Net pay']) expect(screen.getByRole('group', { name: label })).toBeInTheDocument();
    expect(screen.getByText('Net pay is ₹6,250 more than October.')).toBeInTheDocument();
    const needs = await screen.findByRole('region', { name: 'Needs action' });
    expect(within(needs).getByText('Days not entered:')).toBeInTheDocument();
    expect(within(needs).getByRole('link', { name: 'Add Days' })).toHaveAttribute('href', '/finance/payroll?tab=inputs');
    const ready = screen.getByText(/^Ready · 2/).closest('details')!;
    expect(ready).not.toHaveAttribute('open');
    // exception first: the Needs action card comes before the folded Ready list
    expect(needs.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('(PAY-10) the Finalize confirm shows the journal effect in rupees and says it cannot be edited later', async () => {
    const user = userEvent.setup();
    renderOps('/finance/payroll?tab=runs', { [`GET ${P}/runs`]: { data: { items: [run()], total: 1, page: 1, pageSize: 24 } }, [`GET ${P}/runs/${PAY_RUN_ID}/exceptions`]: { data: { runId: PAY_RUN_ID, blockers: 0, items: [] } } });
    await user.click(await screen.findByRole('button', { name: 'Finalize Payroll' }));
    const confirm = await screen.findByRole('alertdialog');
    expect(confirm).toHaveTextContent(/this cannot be edited later\. use a correction run\./i);
    const effect = within(confirm).getByRole('region', { name: 'What goes into the books' });
    expect(effect).toHaveTextContent('Salary expense (gross + employer cost)₹1,33,200');
    expect(effect).toHaveTextContent('Salaries to pay (net)₹1,16,250');
  });

  it('(PAY-11) Payments says plainly that making the bank file does not pay anyone', async () => {
    renderOps('/finance/payroll?tab=payments', {
      [`GET ${P}/runs`]: { data: { items: [run({ state: 'FINALIZED' })], total: 1, page: 1, pageSize: 24 } },
      [`GET ${P}/runs/${PAY_RUN_ID}/disbursement-batches`]: { data: [{ batchId: 'bt1', runId: PAY_RUN_ID, month: '2026-11', bankAccountId: BANK_ID, fileHash: 'h', state: 'BUILT', totalPaise: 11_625_000, paidPaise: 0, verifiedPaise: 0, items: [], skipped: [], createdAt: '2026-11-26T00:00:00.000Z' }] },
      [`GET ${P}/employee-assignments`]: { data: [] },
    });
    expect(await screen.findByTestId('bank-file-note')).toHaveTextContent('Making the file does not pay anyone.');
    expect(screen.getByRole('button', { name: 'Download Bank File' })).toBeInTheDocument();
  });

  it('(PAY-13) My Salary shows the signed-in person’s own payslip and asks only the /me endpoints', async () => {
    const user = userEvent.setup();
    const slip: PayslipDTO = { payslipId: 'ps1', number: 'PSL/1', runId: PAY_RUN_ID, month: '2026-11', employeeId: 'e1', employeeName: 'Test User', published: true, grossPaise: 4_200_000, deductionsPaise: 325_000, netPaise: 3_875_000, paidDays: '30/30', lines: [{ kind: 'EARNING', label: 'Basic', amountPaise: 3_000_000, formula: 'Basic ₹30,000 × 30/30 days' }], school: 'Greenfield', department: null, designation: null, paymentStatus: 'PAID' };
    const mock = mockApi('FACULTY', {
      [`GET ${API}/me/payroll/summary`]: { data: { employeeId: 'e1', latestPayslip: { payslipId: 'ps1', month: '2026-11', netPaise: 3_875_000 }, openAdvancePaise: 0, taxDeclaration: null } },
      [`GET ${API}/me/payslips`]: { data: [slip] },
      [`GET ${API}/me/advances`]: { data: [] },
    });
    renderWithApp(
      <Ready>
        <MySalaryPage />
      </Ready>,
    );
    expect(await screen.findByRole('group', { name: 'Net Pay' })).toHaveTextContent('₹38,750');
    expect(screen.getByText('Paid')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'View Breakdown' }));
    expect(screen.getByText('Gross ₹42,000 − Deductions ₹3,250 = Net ₹38,750')).toBeInTheDocument();
    expect(mock.calls.filter((c) => c.path.startsWith(`${API}/payroll`))).toHaveLength(0);
    expect(mock.calls.every((c) => !c.path.includes('e1'))).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────── expenses, close, reports

describe('expenses, close and reports (FIN-13, FIN-15, FUX-13, TAX-06)', () => {
  const spend: Handlers = {
    [`GET ${F}/expense-categories`]: { data: [{ categoryId: 'cat1', code: 'UTILITIES', name: 'Utilities', accountId: 'a1', accountName: 'Electricity and Water', defaultItcStatus: 'NEEDS_REVIEW', status: 'ACTIVE' }] },
    [`GET ${F}/vendors`]: { data: [] },
    [`GET ${F}/expenses`]: { data: { items: [], total: 0, page: 1, pageSize: 25 } },
  };

  it('(FIN-13) Add Expense is one panel: amount, category, date; campus and account are filled in, and a big one says it waits for approval', async () => {
    const user = userEvent.setup();
    const mock = renderOps('/finance/expenses', {
      ...spend,
      [`POST ${F}/expenses`]: { status: 201, data: { expenseId: 'x1', number: 'EXP/2026-27/000001', state: 'PENDING', categoryId: 'cat1', categoryName: 'Utilities', vendorId: null, vendorName: null, locationId: LOCATION_ID, date: '2026-11-20', description: 'Utilities', taxableValuePaise: 3_000_000, taxPaise: 0, totalPaise: 3_000_000, paymentMode: 'BANK', needsApproval: true, approved: false, waitingForItc: false, hasEvidence: false, journalId: null, createdByName: 'Test User', taxLines: [], createdAt: '2026-11-20T00:00:00.000Z' } },
    });
    const panel = await screen.findByRole('region', { name: 'Add expense' });
    await user.type(within(panel).getByRole('textbox', { name: /^amount/i }), '30000');
    await pickOption(user, within(panel).getByRole('combobox', { name: /^category/i }), /utilities/i);
    await user.click(within(panel).getByRole('button', { name: 'Save Expense' }));
    expect(await screen.findByText(/waiting for approval/i)).toBeInTheDocument();
    expect(mock.callsTo('/finance/expenses', 'POST')[0]!.body).toMatchObject({ categoryId: 'cat1', taxableValuePaise: 3_000_000, locationId: LOCATION_ID, paymentMode: 'BANK', bankAccountId: BANK_ID, gstRateBps: 0, description: 'Utilities' });
  });

  it('(TAX-06) tax shows only for a taxable purchase, with the three ITC choices and the help card', async () => {
    const user = userEvent.setup();
    renderOps('/finance/expenses', spend);
    const panel = await screen.findByRole('region', { name: 'Add expense' });
    expect(within(panel).queryByRole('radiogroup', { name: 'ITC choice' })).toBeNull();
    await user.click(within(panel).getByRole('checkbox', { name: 'This bill has GST' }));
    const choices = within(panel).getByRole('radiogroup', { name: 'ITC choice' });
    expect(within(choices).getAllByRole('radio').map((r) => r.textContent)).toEqual([expect.stringMatching(/^Claim/), expect.stringMatching(/^Don’t Claim/), expect.stringMatching(/^Decide Later/)]);
    expect(within(panel).getByRole('button', { name: 'About ITC' })).toBeInTheDocument();
  });

  it('(FUX-13) close readiness lists each item with its level (Must fix / Can accept) and a Fix button, and Close waits for the blockers', async () => {
    const readiness: CloseReadinessDTO = {
      periodId: 'p-oct', periodCode: '2026-10', state: 'OPEN', blockers: 3, warnings: 1, canClose: false, closedByName: null, closedAt: null,
      headline: 'October close: 3 bank items = 3 need attention.',
      checks: [
        { key: 'BANK_ITEMS', title: 'Bank lines not matched', level: 'BLOCKER', count: 3, sentence: '3 bank lines are not matched.', fix: { label: 'Open Banking', path: '/finance/banking' } },
        { key: 'OLD_CLAIMS', title: 'Old payment reports', level: 'WARNING', count: 1, sentence: '1 report is older than 7 days.', fix: null },
      ],
    };
    renderOps('/finance/accounting?tab=close', { [`GET ${F}/close-readiness`]: { data: readiness } });
    expect(await screen.findByTestId('close-headline')).toHaveTextContent('October close: 3 bank items = 3 need attention.');
    const checks = screen.getByRole('list', { name: 'Close checks' });
    expect(within(checks).getByText('Must fix')).toBeInTheDocument();
    expect(within(checks).getByText('Can accept')).toBeInTheDocument();
    expect(within(checks).getByRole('link', { name: 'Fix' })).toHaveAttribute('href', '/finance/banking');
    expect(screen.getByRole('button', { name: /close period/i })).toBeDisabled();
  });

  it('(FIN-18) every report shows its basis line', async () => {
    const report: ReportDTO = { type: 'income-and-expenditure', title: 'Income and expenditure', basis: 'Based on posted journals (accrual)', from: '2026-04-01', to: '2026-11-20', columns: [{ key: 'name', label: 'Account', kind: 'text' }, { key: 'amount', label: 'Amount', kind: 'money' }], rows: [{ name: 'Tuition Fee', amount: 1_250_000 }], totals: { amount: 1_250_000 }, notes: [] };
    renderOps('/finance/accounting?tab=reports', { [`GET ${F}/reports/income-and-expenditure`]: { data: report } });
    expect(await screen.findByTestId('report-basis')).toHaveTextContent('Based on posted journals (accrual)');
    expect(screen.getByRole('button', { name: 'Download CSV' })).toBeInTheDocument();
  });
});

// ───────────────────────────────────────────────────────────── parent and guards

describe('parent payment report and route guards (FUX-09, FUX-16)', () => {
  const summary = { children: [{ studentId: 'k1', studentName: 'Aarav Kaur', className: 'VIII-A', outstandingPaise: 400_000, overduePaise: 0, advancePaise: 0, nextDueDate: '2026-11-10', nextDuePaise: 400_000 }] };
  const claim = (over: Partial<ClaimDTO> = {}): ClaimDTO => ({ claimId: 'cl1', status: 'PENDING_VERIFICATION', method: 'UPI', amountPaise: 400_000, paidOn: '2026-11-20', reference: '123456789012', students: [{ studentId: 'k1', studentName: 'Aarav Kaur', amountPaise: 400_000 }], flags: [], hasProof: false, reportedByName: null, reportedByParent: true, rejectReason: null, collectionId: null, createdAt: '2026-11-20T00:00:00.000Z', ...over });
  const parentHandlers = (claims: ClaimDTO[], receipts: unknown[] = []): Handlers => ({
    [`GET ${API}/parent/fees/summary`]: { data: summary },
    [`GET ${API}/parent/fees/students/k1`]: { data: { studentId: 'k1', studentName: 'Aarav Kaur', outstandingPaise: 400_000, overduePaise: 0, advancePaise: 0, bills: [], howToPay: null } },
    [`GET ${API}/parent/payment-claims`]: { data: claims },
    [`GET ${API}/parent/fees/receipts`]: { data: receipts },
  });

  it('(FUX-09) a parent reports a UPI payment and sees "Awaiting school verification", never an instant "Paid"', async () => {
    const user = userEvent.setup();
    const mock = mockApi('PARENT', { ...parentHandlers([]), [`POST ${API}/parent/payment-claims`]: { status: 201, data: claim() } });
    renderWithApp(
      <Ready>
        <ParentFeesPage />
      </Ready>,
    );
    await user.click(await screen.findByRole('button', { name: 'Report a Payment' }));
    const form = screen.getByRole('region', { name: 'Report a payment' });
    expect(within(form).getByRole('textbox', { name: /amount you paid/i })).toHaveValue('4000');
    await user.type(within(form).getByRole('textbox', { name: /reference/i }), '123456789012');
    await user.click(within(form).getByRole('button', { name: 'Send Report' }));
    expect(await within(form).findByText('Awaiting school verification')).toBeInTheDocument();
    expect(within(form).queryByText(/^paid$/i)).toBeNull();
    expect(mock.callsTo('/parent/payment-claims', 'POST')[0]!.body).toEqual({ students: [{ studentId: 'k1', amountPaise: 400_000 }], method: 'UPI', amountPaise: 400_000, paidOn: expect.any(String), reference: '123456789012' });
  });

  it('(FUX-09) only after the school verifies does the report say "Payment verified · Receipt available" with a download', async () => {
    mockApi('PARENT', parentHandlers([claim({ status: 'VERIFIED', collectionId: 'col9' })], [{ receiptId: 'r9', number: 'RCT/9', collectionId: 'col9', status: 'ISSUED', amountPaise: 400_000, advancePaise: 0, method: 'UPI', receivedOn: '2026-11-21', payerName: null, lines: [{ studentId: 'k1', studentName: 'Aarav Kaur', documentNumber: 'BILL/1', amountPaise: 400_000 }], cancelledReason: null, cancelledAt: null }]));
    renderWithApp(
      <Ready>
        <ParentFeesPage />
      </Ready>,
    );
    const reports = await screen.findByRole('region', { name: 'Your payment reports' });
    expect(within(reports).getByText(/payment verified · receipt available/i)).toBeInTheDocument();
    expect(within(reports).getByRole('button', { name: 'Download receipt RCT/9' })).toBeInTheDocument();
  });

  function renderGuards(route: string, as: SessionDTO) {
    mockApi('STAFF', { [`GET ${API}/auth/me`]: { data: as } });
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/finance" element={<RequireFinanceAccess />}>
            <Route index element={<p>Finance home</p>} />
            <Route element={<RequireFinancePermission any={['payroll:run:prepare', 'payroll:report:view']} />}>
              <Route path="payroll" element={<p>Payroll page</p>} />
            </Route>
          </Route>
          <Route path="/me/salary" element={<RequireEmployeeLogin />}>
            <Route index element={<p>My salary page</p>} />
          </Route>
          <Route path="/restricted" element={<p>Restricted page</p>} />
        </Routes>
      </Ready>,
      { route },
    );
  }

  it('(FUX-16) a Staff login without a finance job is kept out of every finance route', async () => {
    renderGuards('/finance', sessionFor('STAFF'));
    expect(await screen.findByText('Restricted page')).toBeInTheDocument();
  });

  it('(FUX-16) a Collector cannot open Payroll', async () => {
    renderGuards('/finance/payroll', staffWith(['COLLECTOR']));
    expect(await screen.findByText(/error 404/i)).toBeInTheDocument();
    expect(screen.queryByText('Payroll page')).toBeNull();
  });

  it('(FUX-16) a parent asking for /me/salary is sent to the restricted page', async () => {
    renderGuards('/me/salary', sessionFor('PARENT'));
    expect(await screen.findByText('Restricted page')).toBeInTheDocument();
  });
});
