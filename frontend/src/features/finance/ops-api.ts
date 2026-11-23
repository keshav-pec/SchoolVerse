import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AccountDTO,
  AdvanceDTO,
  AutoMatchResultDTO,
  CashDepositDTO,
  CashbookDTO,
  ClaimDTO,
  ClosedPeriodDTO,
  CloseReadinessDTO,
  CollectionDTO,
  CollectionListDTO,
  CollectionResultDTO,
  CompensationDTO,
  DisbursementBatchDTO,
  ExpenseCategoryDTO,
  ExpenseDTO,
  FinanceAttentionDTO,
  FinanceOverviewDTO,
  GstPaymentDTO,
  GeneralLedgerDTO,
  JournalDetailDTO,
  JournalDTO,
  LiabilityDTO,
  MatchDTO,
  MyPayrollSummaryDTO,
  OpeningPreviewDTO,
  PayablesAgingDTO,
  PayrollInputDTO,
  PayrollPolicyDTO,
  PayrollRunDTO,
  PayslipDTO,
  ReceiptDTO,
  ReceiptListDTO,
  ReconExceptionsDTO,
  ReconSummaryDTO,
  RefundableDTO,
  RefundDTO,
  ReminderPreviewDTO,
  ReminderResultDTO,
  ReportDTO,
  RunEmployeeDTO,
  RunExceptionsDTO,
  RunLineDTO,
  SalaryComponentDTO,
  SalaryRevisionDTO,
  SalaryStructureDTO,
  SearchResultDTO,
  ShiftDTO,
  StatementImportDTO,
  StatementLineDTO,
  StatutoryRuleDTO,
  TaxDeclarationDTO,
  TaxLineDTO,
  TaxReviewQueueDTO,
  TrialBalanceDTO,
  VendorBillDTO,
  VendorDTO,
  VendorPaymentDTO,
  VerificationQueueDTO,
} from '@shared';
import { api, fetchBlob } from '@/lib/api';
import { FIN, qs, type Paged } from './api';

/**
 * Module 7, Part 4: reads and writes for collections, banking, payroll, expenses, tax, close and reports. Every key starts with
 * `finance`, so `useFinanceMutation` refreshes all of them after any change.
 */

const PAY = [...FIN, 'payroll'] as const;

// ───────────────────────────────────────────────────────────── collections

export const useVerificationQueue = (enabled = true) => useQuery({ queryKey: [...FIN, 'verify-queue'], queryFn: () => api.get<VerificationQueueDTO>('/finance/verification-queue'), enabled });
export const useCollections = (params: { status?: string; method?: string; studentId?: string; q?: string; page?: number }, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'collections', params], queryFn: () => api.get<CollectionListDTO>(`/finance/collections${qs({ ...params, pageSize: 25 })}`), enabled, placeholderData: keepPreviousData });
export const useClaims = (params: { status?: string; studentId?: string }, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'claims', params], queryFn: () => api.get<Paged<ClaimDTO>>(`/finance/payment-claims${qs({ ...params, pageSize: 50 })}`), enabled });
export const useReceipts = (params: { q?: string; studentId?: string; page?: number }) =>
  useQuery({ queryKey: [...FIN, 'receipts', params], queryFn: () => api.get<ReceiptListDTO>(`/finance/receipts${qs({ ...params, pageSize: 25 })}`), placeholderData: keepPreviousData });
export const useRefunds = (params: { state?: string; studentId?: string; page?: number }) =>
  useQuery({ queryKey: [...FIN, 'refunds', params], queryFn: () => api.get<Paged<RefundDTO>>(`/finance/refunds${qs({ ...params, pageSize: 25 })}`), placeholderData: keepPreviousData });
export const useRefundable = (studentId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'refundable', studentId], queryFn: () => api.get<RefundableDTO>(`/finance/refundable${qs({ studentId })}`), enabled: !!studentId });
export const useMyShift = (enabled = true) => useQuery({ queryKey: [...FIN, 'shift', 'mine'], queryFn: () => api.get<ShiftDTO | null>('/finance/cashier-shifts/mine'), enabled });
export const useShifts = (params: { state?: string; mine?: boolean }, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'shifts', params], queryFn: () => api.get<Paged<ShiftDTO>>(`/finance/cashier-shifts${qs({ ...params, pageSize: 25 })}`), enabled });
export const useDeposits = (enabled = true) => useQuery({ queryKey: [...FIN, 'deposits'], queryFn: () => api.get<CashDepositDTO[]>('/finance/cash-deposits'), enabled });
export const useCashbook = (date: string, enabled = true) => useQuery({ queryKey: [...FIN, 'cashbook', date], queryFn: () => api.get<CashbookDTO>(`/finance/cashbook${qs({ date })}`), enabled });

export const collectApi = {
  create: (body: Record<string, unknown>, key: string) => api.post<CollectionResultDTO>('/finance/collections', body, { 'Idempotency-Key': key }),
  verify: (id: string, body: Record<string, unknown>) => api.post<CollectionResultDTO>(`/finance/collections/${id}/verify`, body),
  reject: (id: string, reason: string) => api.post<CollectionDTO>(`/finance/collections/${id}/reject`, { reason }),
  createClaim: (body: Record<string, unknown>) => api.post<ClaimDTO>('/finance/payment-claims', body),
  verifyClaim: (id: string, body: Record<string, unknown>) => api.post<CollectionResultDTO>(`/finance/payment-claims/${id}/verify`, body),
  rejectClaim: (id: string, reason: string) => api.post<ClaimDTO>(`/finance/payment-claims/${id}/reject`, { reason }),
  deposit: (id: string, body: Record<string, unknown> = {}) => api.post<CollectionDTO>(`/finance/collections/${id}/deposit`, body),
  clear: (id: string, body: Record<string, unknown>) => api.post<CollectionResultDTO>(`/finance/collections/${id}/clear`, body),
  returnCheque: (id: string, body: Record<string, unknown>) => api.post<CollectionDTO>(`/finance/collections/${id}/return`, body),
  cancelReceipt: (id: string, body: { reason: string; approvalId?: string }) => api.post<ReceiptDTO>(`/finance/receipts/${id}/cancel`, body),
  createRefund: (body: Record<string, unknown>) => api.post<RefundDTO>('/finance/refunds', body),
  approveRefund: (id: string) => api.post<RefundDTO>(`/finance/refunds/${id}/approve`, {}),
  rejectRefund: (id: string, reason: string) => api.post<RefundDTO>(`/finance/refunds/${id}/reject`, { reason }),
  disburseRefund: (id: string, body: Record<string, unknown>) => api.post<RefundDTO>(`/finance/refunds/${id}/record-disbursement`, body),
  openShift: (body: { openingFloatPaise: number; cashAccountId?: string; locationId?: string }) => api.post<ShiftDTO>('/finance/cashier-shifts/open', body),
  closeShift: (id: string, body: { countedPaise: number; note?: string }) => api.post<ShiftDTO>(`/finance/cashier-shifts/${id}/close`, body),
  signOff: (id: string, note?: string) => api.post<ShiftDTO>(`/finance/cashier-shifts/${id}/sign-off`, { note }),
  createDeposit: (body: Record<string, unknown>) => api.post<CashDepositDTO>('/finance/cash-deposits', body),
  applyAdvance: (studentId: string) => api.post<{ appliedPaise: number; bills: number; remainingAdvancePaise: number }>(`/finance/students/${studentId}/apply-advance`, {}),
  previewReminders: (body: Record<string, unknown>) => api.post<ReminderPreviewDTO>('/finance/reminders/preview', body),
  sendReminders: (body: Record<string, unknown>) => api.post<ReminderResultDTO>('/finance/reminders/send', body),
};

/** The proof image a parent attached, opened in a new tab (kept in memory only). */
export async function openBlob(path: string): Promise<void> {
  const blob = await fetchBlob(path);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Saves a CSV (or any file) the API sends, under the given name. */
export async function downloadFile(path: string, fileName: string): Promise<void> {
  const blob = await fetchBlob(path);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ───────────────────────────────────────────────────────────── banking

export const useStatementImports = (bankAccountId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'imports', bankAccountId], queryFn: () => api.get<StatementImportDTO[]>(`/finance/bank-accounts/${bankAccountId}/statements`), enabled: !!bankAccountId });
export const useStatementLines = (params: { bankAccountId?: string; status?: string; q?: string; page?: number }, enabled = true) =>
  useQuery({
    queryKey: [...FIN, 'lines', params],
    queryFn: () => api.get<Paged<StatementLineDTO>>(`/finance/reconciliation/lines${qs({ ...params, pageSize: 50 })}`),
    enabled: enabled && !!params.bankAccountId,
    placeholderData: keepPreviousData,
  });
export const useReconExceptions = (bankAccountId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'recon', bankAccountId], queryFn: () => api.get<ReconExceptionsDTO>(`/finance/reconciliation/exceptions${qs({ bankAccountId })}`), enabled: !!bankAccountId });
export const useMatches = (bankAccountId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'matches', bankAccountId], queryFn: () => api.get<MatchDTO[]>(`/finance/reconciliation/matches${qs({ bankAccountId })}`), enabled: !!bankAccountId });
export const useReconSummary = (bankAccountId: string | undefined, asOf?: string) =>
  useQuery({ queryKey: [...FIN, 'recon-summary', bankAccountId, asOf], queryFn: () => api.get<ReconSummaryDTO>(`/finance/reconciliation/summary${qs({ bankAccountId, asOf })}`), enabled: !!bankAccountId });

export const bankApi = {
  importStatement: (bankAccountId: string, form: FormData) => api.post<StatementImportDTO>(`/finance/bank-accounts/${bankAccountId}/statements`, form),
  autoMatch: (bankAccountId: string) => api.post<AutoMatchResultDTO>('/finance/reconciliation/auto-match', { bankAccountId }),
  confirm: (matchId: string, body: { verify?: boolean; seenOn?: string } = {}) => api.post<MatchDTO>(`/finance/reconciliation/matches/${matchId}/confirm`, body),
  reverse: (matchId: string, reason: string) => api.post<MatchDTO>(`/finance/reconciliation/matches/${matchId}/reverse`, { reason }),
  manualMatch: (body: Record<string, unknown>) => api.post<MatchDTO>('/finance/reconciliation/manual-match', body),
  ignore: (lineId: string, body: { reason: string; approvalId?: string }) => api.post<StatementLineDTO>(`/finance/reconciliation/lines/${lineId}/ignore`, body),
  bankCharge: (lineId: string, memo?: string) => api.post<StatementLineDTO>(`/finance/reconciliation/lines/${lineId}/record-bank-charge`, { memo }),
  interest: (lineId: string, memo?: string) => api.post<StatementLineDTO>(`/finance/reconciliation/lines/${lineId}/record-interest`, { memo }),
};

// ───────────────────────────────────────────────────────────── payroll

export const usePayrollPolicy = () => useQuery({ queryKey: [...PAY, 'policy'], queryFn: () => api.get<PayrollPolicyDTO>('/payroll/policy') });
export const useComponents = () => useQuery({ queryKey: [...PAY, 'components'], queryFn: () => api.get<SalaryComponentDTO[]>('/payroll/components') });
export const useStructures = () => useQuery({ queryKey: [...PAY, 'structures'], queryFn: () => api.get<SalaryStructureDTO[]>('/payroll/salary-structures') });
export const useCompensations = (enabled = true) => useQuery({ queryKey: [...PAY, 'compensations'], queryFn: () => api.get<CompensationDTO[]>('/payroll/employee-assignments'), enabled });
export const useRevisions = (enabled = true) => useQuery({ queryKey: [...PAY, 'revisions'], queryFn: () => api.get<SalaryRevisionDTO[]>('/payroll/salary-revisions'), enabled });
export const useInputs = (month: string, enabled = true) => useQuery({ queryKey: [...PAY, 'inputs', month], queryFn: () => api.get<PayrollInputDTO[]>(`/payroll/inputs${qs({ month })}`), enabled });
export const useRules = () => useQuery({ queryKey: [...PAY, 'rules'], queryFn: () => api.get<StatutoryRuleDTO[]>('/payroll/statutory-rules') });
export const useAdvances = () => useQuery({ queryKey: [...PAY, 'advances'], queryFn: () => api.get<AdvanceDTO[]>('/payroll/advances') });
export const usePayrollRuns = (params: { month?: string; page?: number } = {}) =>
  useQuery({ queryKey: [...PAY, 'runs', params], queryFn: () => api.get<Paged<PayrollRunDTO>>(`/payroll/runs${qs({ ...params, pageSize: 24 })}`), placeholderData: keepPreviousData });
export const usePayrollRun = (runId: string | undefined) => useQuery({ queryKey: [...PAY, 'run', runId], queryFn: () => api.get<PayrollRunDTO>(`/payroll/runs/${runId}`), enabled: !!runId });
export const useRunEmployees = (runId: string | undefined, params: { status?: string; q?: string; page?: number }, enabled = true) =>
  useQuery({
    queryKey: [...PAY, 'run-employees', runId, params],
    queryFn: () => api.get<Paged<RunEmployeeDTO>>(`/payroll/runs/${runId}/employees${qs({ ...params, pageSize: 50 })}`),
    enabled: !!runId && enabled,
    placeholderData: keepPreviousData,
  });
export const useRunExceptions = (runId: string | undefined, enabled = true) =>
  useQuery({ queryKey: [...PAY, 'run-exceptions', runId], queryFn: () => api.get<RunExceptionsDTO>(`/payroll/runs/${runId}/exceptions`), enabled: !!runId && enabled });
export const useRunLines = (runId: string | undefined, employeeId: string | undefined) =>
  useQuery({ queryKey: [...PAY, 'run-lines', runId, employeeId], queryFn: () => api.get<RunLineDTO[]>(`/payroll/runs/${runId}/employees/${employeeId}/lines`), enabled: !!runId && !!employeeId });
export const usePayslips = (params: { month?: string; employeeId?: string }, enabled = true) =>
  useQuery({ queryKey: [...PAY, 'payslips', params], queryFn: () => api.get<PayslipDTO[]>(`/payroll/payslips${qs(params)}`), enabled });
export const useBatches = (runId: string | undefined) =>
  useQuery({ queryKey: [...PAY, 'batches', runId], queryFn: () => api.get<DisbursementBatchDTO[]>(`/payroll/runs/${runId}/disbursement-batches`), enabled: !!runId });
export const useLiabilities = (enabled = true) => useQuery({ queryKey: [...PAY, 'liabilities'], queryFn: () => api.get<LiabilityDTO>('/payroll/liabilities'), enabled });
export const usePayrollReport = (type: string, month: string | undefined, enabled = true) =>
  useQuery({ queryKey: [...PAY, 'report', type, month], queryFn: () => api.get<ReportDTO>(`/payroll/reports/${type}${qs({ month })}`), enabled });

export const payApi = {
  updatePolicy: (body: Record<string, unknown>) => api.patch<PayrollPolicyDTO>('/payroll/policy', body),
  createComponent: (body: Record<string, unknown>) => api.post<SalaryComponentDTO>('/payroll/components', body),
  createStructure: (body: Record<string, unknown>) => api.post<SalaryStructureDTO>('/payroll/salary-structures', body),
  approveStructureVersion: (versionId: string) => api.post<SalaryStructureDTO>(`/payroll/salary-structure-versions/${versionId}/approve`, {}),
  assign: (body: Record<string, unknown>) => api.post<CompensationDTO>('/payroll/employee-assignments', body),
  recommend: (body: { locationId?: string }) =>
    api.post<{ asOf: string; items: { employeeId: string; employeeName: string; employeeCode: string; designationName: string | null; suggestedStructureVersionId: string | null; suggestedStructureName: string | null }[] }>('/payroll/employee-assignments/recommend', body),
  createRevision: (body: Record<string, unknown>) => api.post<SalaryRevisionDTO>('/payroll/salary-revisions', body),
  putInput: (body: Record<string, unknown>) => api.put<PayrollInputDTO>('/payroll/inputs', body),
  fillInputs: (body: { month: string; workingDays?: number; locationId?: string }) => api.post<{ filled: number }>('/payroll/inputs/fill', body),
  importInputs: (form: FormData) => api.post<{ saved: number; problems: { row: number; message: string }[] }>('/payroll/employee-inputs/import', form),
  approveRule: (ruleId: string) => api.post<StatutoryRuleDTO>(`/payroll/statutory-rules/${ruleId}/approve`, {}),
  createAdvance: (body: Record<string, unknown>) => api.post<AdvanceDTO>('/payroll/advances', body),
  approveAdvance: (id: string) => api.post<AdvanceDTO>(`/payroll/advances/${id}/approve`, {}),
  payAdvance: (id: string, body: Record<string, unknown>) => api.post<AdvanceDTO>(`/payroll/advances/${id}/record-payment`, body),
  repayAdvance: (id: string, body: Record<string, unknown>) => api.post<AdvanceDTO>(`/payroll/advances/${id}/repay`, body),
  createRun: (body: Record<string, unknown>) => api.post<PayrollRunDTO>('/payroll/runs', body),
  calculate: (runId: string) => api.post<PayrollRunDTO>(`/payroll/runs/${runId}/calculate`, {}),
  patchEmployee: (runId: string, employeeId: string, body: Record<string, unknown>) => api.patch<RunEmployeeDTO>(`/payroll/runs/${runId}/employees/${employeeId}`, body),
  approve: (runId: string) => api.post<PayrollRunDTO>(`/payroll/runs/${runId}/approve`, {}),
  finalize: (runId: string, body: { version: number; acknowledgeDemoRules?: boolean }) => api.post<PayrollRunDTO>(`/payroll/runs/${runId}/finalize`, body),
  cancel: (runId: string) => api.post<PayrollRunDTO>(`/payroll/runs/${runId}/cancel`, {}),
  publish: (runId: string) => api.post<{ published: number }>(`/payroll/runs/${runId}/publish-payslips`, {}),
  buildBatch: (runId: string, bankAccountId: string) => api.post<DisbursementBatchDTO>(`/payroll/runs/${runId}/disbursement-batch`, { bankAccountId }),
  record: (batchId: string, body: Record<string, unknown>) => api.post<DisbursementBatchDTO>(`/payroll/disbursements/${batchId}/record`, body),
  verify: (batchId: string, employeeIds?: string[]) => api.post<DisbursementBatchDTO>(`/payroll/disbursements/${batchId}/verify`, employeeIds ? { employeeIds } : {}),
  fullFinal: (employeeId: string, body: Record<string, unknown>) => api.post<PayrollRunDTO>(`/payroll/employees/${employeeId}/full-final`, body),
  saveDeclaration: (employeeId: string, body: Record<string, unknown>) => api.put<TaxDeclarationDTO>(`/payroll/employees/${employeeId}/tax-declaration`, body),
};

// ───────────────────────────────────────────────────────────── my salary (the signed-in employee only)

const ME = ['me', 'payroll'] as const;
export const useMyPayrollSummary = () => useQuery({ queryKey: [...ME, 'summary'], queryFn: () => api.get<MyPayrollSummaryDTO>('/me/payroll/summary'), retry: false });
export const useMyPayslips = (enabled = true) => useQuery({ queryKey: [...ME, 'payslips'], queryFn: () => api.get<PayslipDTO[]>('/me/payslips'), enabled });
export const useMyAdvances = (enabled = true) =>
  useQuery({ queryKey: [...ME, 'advances'], queryFn: () => api.get<Pick<AdvanceDTO, 'advanceId' | 'principalPaise' | 'installmentPaise' | 'remainingPaise' | 'startMonth' | 'state' | 'paidOn'>[]>('/me/advances'), enabled });
export const myApi = { saveDeclaration: (body: Record<string, unknown>) => api.post<TaxDeclarationDTO>('/me/tax-declaration', body) };

// ───────────────────────────────────────────────────────────── expenses, vendors, tax

export const useExpenseCategories = () => useQuery({ queryKey: [...FIN, 'expense-categories'], queryFn: () => api.get<ExpenseCategoryDTO[]>('/finance/expense-categories') });
export const useVendors = (enabled = true) => useQuery({ queryKey: [...FIN, 'vendors'], queryFn: () => api.get<VendorDTO[]>('/finance/vendors'), enabled });
export const useExpenses = (params: { state?: string; page?: number; locationId?: string }) =>
  useQuery({ queryKey: [...FIN, 'expenses', params], queryFn: () => api.get<Paged<ExpenseDTO>>(`/finance/expenses${qs({ ...params, pageSize: 25 })}`), placeholderData: keepPreviousData });
export const useVendorBills = (params: { vendorId?: string; open?: boolean; page?: number }) =>
  useQuery({ queryKey: [...FIN, 'vendor-bills', params], queryFn: () => api.get<Paged<VendorBillDTO>>(`/finance/vendor-bills${qs({ ...params, pageSize: 50 })}`), placeholderData: keepPreviousData });
export const useVendorPayments = (vendorId?: string) => useQuery({ queryKey: [...FIN, 'vendor-payments', vendorId], queryFn: () => api.get<VendorPaymentDTO[]>(`/finance/vendor-payments${qs({ vendorId })}`) });
export const usePayablesAging = () => useQuery({ queryKey: [...FIN, 'payables-aging'], queryFn: () => api.get<PayablesAgingDTO>('/finance/payables/aging') });
export const useTaxLines = (params: { itcStatus?: string; month?: string }, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'tax-lines', params], queryFn: () => api.get<Paged<TaxLineDTO>>(`/finance/tax/lines${qs({ ...params, pageSize: 100 })}`), enabled });
export const useTaxReviewQueue = () => useQuery({ queryKey: [...FIN, 'tax-review'], queryFn: () => api.get<TaxReviewQueueDTO>('/finance/tax/review-queue') });
export const useGstPayments = (month: string, enabled = true) => useQuery({ queryKey: [...FIN, 'gst-payments', month], queryFn: () => api.get<GstPaymentDTO[]>(`/finance/tax/payments${qs({ month })}`), enabled });
export const useGstReport = (type: string, month: string) => useQuery({ queryKey: [...FIN, 'gst-report', type, month], queryFn: () => api.get<ReportDTO>(`/finance/tax/reports/${type}${qs({ month })}`) });

export const spendApi = {
  createExpense: (body: Record<string, unknown>) => api.post<ExpenseDTO>('/finance/expenses', body),
  approveExpense: (id: string) => api.post<ExpenseDTO>(`/finance/expenses/${id}/approve`, {}),
  rejectExpense: (id: string, reason: string) => api.post<ExpenseDTO>(`/finance/expenses/${id}/reject`, { reason }),
  attachEvidence: (id: string, form: FormData) => api.post<ExpenseDTO>(`/finance/expenses/${id}/evidence`, form),
  createVendor: (body: Record<string, unknown>) => api.post<VendorDTO>('/finance/vendors', body),
  updateVendor: (id: string, body: Record<string, unknown>) => api.patch<VendorDTO>(`/finance/vendors/${id}`, body),
  createBill: (body: Record<string, unknown>) => api.post<VendorBillDTO>('/finance/vendor-bills', body),
  approveBill: (id: string) => api.post<VendorBillDTO>(`/finance/vendor-bills/${id}/approve`, {}),
  payVendor: (body: Record<string, unknown>) => api.post<VendorPaymentDTO>('/finance/vendor-payments', body),
  reviewItc: (body: { lineIds: string[]; decision: 'ELIGIBLE' | 'NOT_ELIGIBLE'; reason: string }) => api.post<{ updated: number }>('/finance/tax/itc-review', body),
  createGstPayment: (body: Record<string, unknown>) => api.post<GstPaymentDTO>('/finance/tax/payments', body),
};

// ───────────────────────────────────────────────────────────── accounting, close, reports, attention, search

export const useJournals = (params: { accountId?: string; sourceType?: string; eventType?: string; page?: number; from?: string; to?: string }, enabled = true) =>
  useQuery({
    queryKey: [...FIN, 'journals', params],
    queryFn: () => api.get<Paged<JournalDTO>>(`/finance/journals${qs({ ...params, pageSize: 25 })}`),
    enabled,
    placeholderData: keepPreviousData,
  });
export const useGeneralLedger = (params: { accountId?: string; from?: string; to?: string }) =>
  useQuery({ queryKey: [...FIN, 'general-ledger', params], queryFn: () => api.get<GeneralLedgerDTO>(`/finance/general-ledger${qs(params)}`), enabled: !!params.accountId });
export const useTrialBalance = (params: { asOf?: string }, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'trial-balance', params], queryFn: () => api.get<TrialBalanceDTO>(`/finance/trial-balance${qs(params)}`), enabled });
export const useCloseReadiness = (periodId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'close-readiness', periodId], queryFn: () => api.get<CloseReadinessDTO>(`/finance/close-readiness${qs({ periodId })}`), enabled: !!periodId });
export const useFinancialReport = (type: string, params: Record<string, string | undefined>, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'report', type, params], queryFn: () => api.get<ReportDTO>(`/finance/reports/${type}${qs(params)}`), enabled });
export const useCollectionReport = (type: string, params: Record<string, string | undefined>, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'collection-report', type, params], queryFn: () => api.get<ReportDTO>(`/finance/collection-reports/${type}${qs(params)}`), enabled });
export const useFinanceAttention = (params: { locationId?: string; sessionId?: string }, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'attention', params], queryFn: () => api.get<FinanceAttentionDTO>(`/finance/attention${qs(params)}`), enabled });
export const useFinanceOverview = (enabled = true) => useQuery({ queryKey: [...FIN, 'overview'], queryFn: () => api.get<FinanceOverviewDTO>('/finance/overview'), enabled });
export const useFinanceSearch = (q: string) =>
  useQuery({ queryKey: [...FIN, 'search', q], queryFn: () => api.get<SearchResultDTO[]>(`/finance/search${qs({ q })}`), enabled: q.trim().length >= 2, placeholderData: keepPreviousData });

export const bookApi = {
  manualJournal: (body: Record<string, unknown>) => api.post<JournalDetailDTO>('/finance/journals/manual', body),
  closePeriod: (periodId: string, body: { warningReason?: string; approvalId?: string }) => api.post<ClosedPeriodDTO>(`/finance/accounting-periods/${periodId}/close`, body),
  reopenPeriod: (periodId: string, body: { reason: string; approvalId?: string }) => api.post<ClosedPeriodDTO>(`/finance/accounting-periods/${periodId}/reopen`, body),
  lockPeriod: (periodId: string) => api.post<ClosedPeriodDTO>(`/finance/accounting-periods/${periodId}/lock`, {}),
  previewOpening: (form: FormData) => api.post<OpeningPreviewDTO>('/finance/opening-balances/preview', form),
  commitOpening: (form: FormData) => api.post<OpeningPreviewDTO>('/finance/opening-balances/commit', form),
};

export type { AccountDTO };
