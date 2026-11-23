import type { ReactNode } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import {
  bundlePermissions,
  type BankAccountDTO,
  type ClaimDTO,
  type CloseReadinessDTO,
  type CollectionDTO,
  type CollectionResultDTO,
  type FinanceBundle,
  type PayrollRunDTO,
  type PayslipDTO,
  type ReconExceptionsDTO,
  type ReportDTO,
  type SessionDTO,
  type VerificationItemDTO,
} from '@shared';
import { useAuth } from '@/lib/auth';
import { RequireEmployeeLogin, RequireFinanceAccess, RequireFinancePermission } from '@/routes/guards';
import { academicSession, classOffering, LOCATION_ID, masterLocation, SESSION_ID, STUDENT_ID, sessionFor } from '@/test/fixtures';
import { mockApi, pickOption, renderWithApp, type MockResponse } from '@/test/utils';
import { MySalaryPage } from '../../me/my-salary-page';
import { ParentFeesPage } from '../../parent/parent-fees-page';
import { AccountingPage } from '../accounting/accounting-page';
import { BankingPage } from '../banking/banking-page';
import { CollectPage } from '../collect/collect-page';
import { RefundDrawer } from '../collect/refunds-tab';
import { breakdown } from '../collect/take-payment';
import { FinanceLayout } from '../context';
import { ExpensesPage } from '../expenses/expenses-page';
import { PayrollPage } from '../payroll/payroll-page';

/**
 * Module 7, Part 4 screens: collections, banking, payroll, My Salary, expenses, close, reports, the parent's payment report and the
 * route guards. QA tags in the titles.
 */

afterEach(() => vi.unstubAllGlobals());

const API = '/api/v1';
const F = `${API}/finance`;
const P = `${API}/payroll`;
const BANK_ID = 'b0b0b0b0-0000-4000-8000-000000000001';
const RUN_ID = 'a2a2a2a2-0000-4000-8000-000000000001';

type Handlers = Record<string, MockResponse | ((r: { url: URL; method: string; body: unknown }) => MockResponse | undefined)>;

function Ready({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session ? <>{children}</> : null;
}

function staffWith(bundles: FinanceBundle[]): SessionDTO {
  const s = sessionFor('STAFF');
  return { ...s, permissions: [...new Set([...s.permissions, ...bundlePermissions(bundles)])] };
}

const year = {
  financialYearId: 'fy1',
  code: '2026-27',
  startDate: '2026-04-01',
  endDate: '2027-03-31',
  periods: [{ periodId: 'p-oct', financialYearId: 'fy1', code: '2026-10', month: 10, startDate: '2026-10-01', endDate: '2026-10-31', state: 'OPEN' as const }],
};

const bank: BankAccountDTO = { bankAccountId: BANK_ID, label: 'Fees account', bankName: 'State Bank', holderName: null, accountNumberMasked: '••••1234', ifsc: 'SBIN0001234', purpose: 'FEES', glAccountId: 'gl1', locationIds: [], status: 'ACTIVE', pendingApprovalId: null };

function base(extra: Handlers = {}, as?: SessionDTO): Handlers {
  return {
    ...(as ? { [`GET ${API}/auth/me`]: { data: as } } : {}),
    [`GET ${API}/academic-sessions`]: { data: [academicSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation] },
    [`GET ${API}/academic-sessions/${SESSION_ID}/class-offerings`]: { data: [classOffering] },
    [`GET ${F}/financial-years`]: { data: [year] },
    [`GET ${F}/bank-accounts`]: { data: [bank] },
    [`GET ${F}/cash-accounts`]: { data: [{ cashAccountId: 'c1', label: 'Front office cash', glAccountId: 'g', locationIds: [], status: 'ACTIVE' }] },
    [`GET ${F}/verification-queue`]: { data: { items: [], total: 0 } },
    ...extra,
  };
}

function renderOps(route: string, handlers: Handlers = {}, as?: SessionDTO) {
  const api = mockApi(as ? 'STAFF' : 'SCHOOL_ADMIN', base(handlers, as));
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
    runId: RUN_ID, number: 'PRN/2026-27/000001', month: '2026-11', type: 'MONTHLY', state: 'APPROVED', payoutStatus: 'UNPAID', headline: 'November payroll · 3 employees · 2 ready · 1 need action',
    counts: { employees: 3, ready: 2, needAction: 1, held: 0 }, totals: { grossPaise: 12_600_000, deductionsPaise: 975_000, employerCostPaise: 720_000, netPaise: 11_625_000 }, previousNetPaise: 11_000_000,
    changeSentence: 'Net pay is ₹6,250 more than October.', warnings: [], locationId: null, parentRunId: null, preparedByName: 'Officer', approvedByName: 'Approver', finalizedAt: null, version: 3, createdAt: '2026-11-25T00:00:00.000Z',
    ...over,
  });
  const exceptionRow = { rowId: 'row1', runId: RUN_ID, employeeId: 'e1', employeeName: 'Gurpreet Kaur', employeeCode: 'FAC-001', departmentName: null, designationName: 'Teacher', locationId: null, status: 'NEEDS_ACTION' as const, held: false, holdReason: null, grossPaise: 0, deductionsPaise: 0, employerCostPaise: 0, netPaise: 0, paidDays: null, exceptions: [{ code: 'MISSING_INPUT' as const, level: 'BLOCKER' as const, message: 'No days for November.', fixHint: 'Add the leave summary.' }], paidOutPaise: 0, payslipId: null };

  it('(FUX-11) the run opens with the headline and totals, people who need action come first, and the ready rows stay folded', async () => {
    renderOps('/finance/payroll?tab=runs', { [`GET ${P}/runs`]: { data: { items: [run({ state: 'CALCULATED' })], total: 1, page: 1, pageSize: 24 } }, [`GET ${P}/runs/${RUN_ID}/exceptions`]: { data: { runId: RUN_ID, blockers: 1, items: [exceptionRow] } } });
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
    renderOps('/finance/payroll?tab=runs', { [`GET ${P}/runs`]: { data: { items: [run()], total: 1, page: 1, pageSize: 24 } }, [`GET ${P}/runs/${RUN_ID}/exceptions`]: { data: { runId: RUN_ID, blockers: 0, items: [] } } });
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
      [`GET ${P}/runs/${RUN_ID}/disbursement-batches`]: { data: [{ batchId: 'bt1', runId: RUN_ID, month: '2026-11', bankAccountId: BANK_ID, fileHash: 'h', state: 'BUILT', totalPaise: 11_625_000, paidPaise: 0, verifiedPaise: 0, items: [], skipped: [], createdAt: '2026-11-26T00:00:00.000Z' }] },
      [`GET ${P}/employee-assignments`]: { data: [] },
    });
    expect(await screen.findByTestId('bank-file-note')).toHaveTextContent('Making the file does not pay anyone.');
    expect(screen.getByRole('button', { name: 'Download Bank File' })).toBeInTheDocument();
  });

  it('(PAY-13) My Salary shows the signed-in person’s own payslip and asks only the /me endpoints', async () => {
    const user = userEvent.setup();
    const slip: PayslipDTO = { payslipId: 'ps1', number: 'PSL/1', runId: RUN_ID, month: '2026-11', employeeId: 'e1', employeeName: 'Test User', published: true, grossPaise: 4_200_000, deductionsPaise: 325_000, netPaise: 3_875_000, paidDays: '30/30', lines: [{ kind: 'EARNING', label: 'Basic', amountPaise: 3_000_000, formula: 'Basic ₹30,000 × 30/30 days' }], school: 'Greenfield', department: null, designation: null, paymentStatus: 'PAID' };
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
