import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AccountDTO,
  AccountingPeriodDTO,
  AdjustmentResultDTO,
  ApprovalPolicyDTO,
  ApprovalRequestDTO,
  AssignmentRecommendationDTO,
  BalanceExplanationDTO,
  BankAccountDTO,
  BillingCommitDTO,
  BillingRowDTO,
  BillingRunDTO,
  BillingValidationDTO,
  BulkAssignResultDTO,
  CashAccountDTO,
  ConcessionAwardDTO,
  ConcessionPolicyDTO,
  ConcessionSuggestionDTO,
  FamilyDTO,
  FeeDocumentDTO,
  FeeDocumentListDTO,
  FeeHeadDTO,
  FeePlanDTO,
  FinanceAccessDTO,
  FinancePulseDTO,
  FinanceReadinessDTO,
  FinancialYearDTO,
  JournalDetailDTO,
  LateFeePolicyDTO,
  LateFeePreviewDTO,
  LedgerEntryDTO,
  LegalEntityDTO,
  OutstandingDTO,
  ParentFeeSummaryDTO,
  ParentStudentFeesDTO,
  PlanValidationDTO,
  RevealedBankNumberDTO,
  StatementDTO,
  StudentAccountDTO,
  StudentAccountListDTO,
  StudentAssignmentDTO,
  TaxCodeDTO,
  TaxProfileDTO,
  UpcomingDTO,
} from '@shared';
import { api, fetchBlob } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/** Every finance query key starts with 'finance', so one invalidation refreshes the whole feature. */
export const FIN = ['finance'] as const;

export function qs(params: Record<string, string | number | boolean | undefined | null>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

// ───────────────────────────────────────────────────────────── setup reads

export const useReadiness = (enabled = true) => useQuery({ queryKey: [...FIN, 'readiness'], queryFn: () => api.get<FinanceReadinessDTO>('/finance/readiness'), enabled });
export const useLegalEntity = () => useQuery({ queryKey: [...FIN, 'entity'], queryFn: () => api.get<LegalEntityDTO>('/finance/legal-entity') });
export const useTaxProfile = () => useQuery({ queryKey: [...FIN, 'tax-profile'], queryFn: () => api.get<TaxProfileDTO>('/finance/tax-profile') });
export const useTaxCodes = () => useQuery({ queryKey: [...FIN, 'tax-codes'], queryFn: () => api.get<TaxCodeDTO[]>('/finance/tax-codes') });
export const useFinancialYears = () => useQuery({ queryKey: [...FIN, 'years'], queryFn: () => api.get<FinancialYearDTO[]>('/finance/financial-years') });
export const usePeriods = (financialYearId?: string) =>
  useQuery({ queryKey: [...FIN, 'periods', financialYearId], queryFn: () => api.get<AccountingPeriodDTO[]>(`/finance/accounting-periods${qs({ financialYearId })}`) });
export const useChart = (q?: string) => useQuery({ queryKey: [...FIN, 'chart', q ?? ''], queryFn: () => api.get<AccountDTO[]>(`/finance/chart-of-accounts${qs({ q })}`), placeholderData: keepPreviousData });
export const useBankAccounts = () => useQuery({ queryKey: [...FIN, 'banks'], queryFn: () => api.get<BankAccountDTO[]>('/finance/bank-accounts') });
export const useCashAccounts = () => useQuery({ queryKey: [...FIN, 'cash'], queryFn: () => api.get<CashAccountDTO[]>('/finance/cash-accounts') });
export const useApprovalPolicies = () => useQuery({ queryKey: [...FIN, 'policies'], queryFn: () => api.get<ApprovalPolicyDTO[]>('/finance/approval-policies') });
export const useApprovals = (params: { decision?: string; page?: number }) =>
  useQuery({ queryKey: [...FIN, 'approvals', params], queryFn: () => api.get<Paged<ApprovalRequestDTO>>(`/finance/approvals${qs({ ...params, pageSize: 25 })}`), placeholderData: keepPreviousData });
export const useFinanceAccess = (enabled: boolean) => useQuery({ queryKey: [...FIN, 'access'], queryFn: () => api.get<FinanceAccessDTO[]>('/finance/access/users'), enabled });

// ───────────────────────────────────────────────────────────── fee reads

export const useFeeHeads = () => useQuery({ queryKey: [...FIN, 'fee-heads'], queryFn: () => api.get<FeeHeadDTO[]>('/finance/fee-heads') });
export const useFeePlans = (sessionId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'plans', sessionId], queryFn: () => api.get<FeePlanDTO[]>(`/finance/fee-plans${qs({ sessionId })}`), enabled: !!sessionId });
export const useConcessionPolicies = () => useQuery({ queryKey: [...FIN, 'concession-policies'], queryFn: () => api.get<ConcessionPolicyDTO[]>('/finance/concession-policies') });
export const useAwards = (params: { status?: string; page?: number }) =>
  useQuery({ queryKey: [...FIN, 'awards', params], queryFn: () => api.get<Paged<ConcessionAwardDTO>>(`/finance/concessions${qs({ ...params, pageSize: 25 })}`), placeholderData: keepPreviousData });
export const useLateFeePolicies = () => useQuery({ queryKey: [...FIN, 'late-fee-policies'], queryFn: () => api.get<LateFeePolicyDTO[]>('/finance/late-fee-policies') });
export const useBillingRuns = (sessionId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'runs', sessionId], queryFn: () => api.get<Paged<BillingRunDTO>>(`/finance/billing-runs${qs({ sessionId, pageSize: 20 })}`), enabled: !!sessionId });
export const useRun = (runId: string | undefined) => useQuery({ queryKey: [...FIN, 'run', runId], queryFn: () => api.get<BillingRunDTO>(`/finance/billing-runs/${runId}`), enabled: !!runId });
export const useRunRows = (runId: string | undefined, params: { status?: string; page?: number }, enabled = true) =>
  useQuery({
    queryKey: [...FIN, 'run-rows', runId, params],
    queryFn: () => api.get<Paged<BillingRowDTO>>(`/finance/billing-runs/${runId}/rows${qs({ ...params, pageSize: 50 })}`),
    enabled: !!runId && enabled,
    placeholderData: keepPreviousData,
  });

// ───────────────────────────────────────────────────────────── money reads

export interface AccountsParams {
  locationId?: string;
  academicSessionId?: string;
  classOfferingId?: string;
  q?: string;
  page?: number;
}
export const useAccounts = (params: AccountsParams) =>
  useQuery({
    queryKey: [...FIN, 'accounts', params],
    queryFn: () => api.get<StudentAccountListDTO>(`/finance/accounts${qs({ ...params, pageSize: 25 })}`),
    enabled: !!params.locationId,
    placeholderData: keepPreviousData,
  });
export const usePulse = (locationId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'pulse', locationId], queryFn: () => api.get<FinancePulseDTO>(`/finance/pulse${qs({ locationId })}`), enabled: !!locationId });
export const useOutstanding = (params: { locationId?: string; bucket?: string }, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'outstanding', params], queryFn: () => api.get<OutstandingDTO>(`/finance/outstanding${qs({ ...params, pageSize: 50 })}`), enabled: enabled && !!params.locationId, placeholderData: keepPreviousData });
export const useStudentAccount = (studentId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'account', studentId], queryFn: () => api.get<StudentAccountDTO>(`/finance/students/${studentId}/account`), enabled: !!studentId, retry: false });
export const useLedger = (studentId: string | undefined) => useQuery({ queryKey: [...FIN, 'ledger', studentId], queryFn: () => api.get<LedgerEntryDTO[]>(`/finance/students/${studentId}/ledger`), enabled: !!studentId });
export const useUpcoming = (studentId: string | undefined) => useQuery({ queryKey: [...FIN, 'upcoming', studentId], queryFn: () => api.get<UpcomingDTO>(`/finance/students/${studentId}/upcoming`), enabled: !!studentId });
export const useStatement = (studentId: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: [...FIN, 'statement', studentId], queryFn: () => api.get<StatementDTO>(`/finance/students/${studentId}/statement`), enabled: !!studentId && enabled });
export const useExplanation = (studentId: string | undefined, enabled = true) =>
  useQuery({ queryKey: [...FIN, 'explain', studentId], queryFn: () => api.get<BalanceExplanationDTO>(`/finance/students/${studentId}/balance-explanation`), enabled: !!studentId && enabled });
export const useStudentBills = (studentId: string | undefined) =>
  useQuery({ queryKey: [...FIN, 'bills', studentId], queryFn: () => api.get<FeeDocumentListDTO>(`/finance/fee-documents${qs({ studentId, pageSize: 100 })}`), enabled: !!studentId });
export const useDocuments = (params: { kind?: string; page?: number; periodKey?: string; locationId?: string }) =>
  useQuery({ queryKey: [...FIN, 'documents', params], queryFn: () => api.get<FeeDocumentListDTO>(`/finance/fee-documents${qs({ ...params, pageSize: 25 })}`), placeholderData: keepPreviousData });
export const useDocument = (documentId: string | undefined) =>
  useQuery({
    queryKey: [...FIN, 'document', documentId],
    queryFn: () => api.get<FeeDocumentDTO & { history: { adjustmentId: string; type: string; amountPaise: number; reason: string; newDocumentId: string; createdAt: string }[] }>(`/finance/fee-documents/${documentId}`),
    enabled: !!documentId,
  });
export const useJournal = (journalId: string | undefined) => useQuery({ queryKey: [...FIN, 'journal', journalId], queryFn: () => api.get<JournalDetailDTO>(`/finance/journals/${journalId}`), enabled: !!journalId, retry: false });
export const useFamily = (guardianId: string | undefined) => useQuery({ queryKey: [...FIN, 'family', guardianId], queryFn: () => api.get<FamilyDTO>(`/finance/families/${guardianId}`), enabled: !!guardianId, retry: false });

// ───────────────────────────────────────────────────────────── parent reads

export const useParentFees = () => useQuery({ queryKey: ['parent', 'fees'], queryFn: () => api.get<ParentFeeSummaryDTO>('/parent/fees/summary'), staleTime: 0, refetchOnWindowFocus: true });
export const useParentChildFees = (studentId: string | undefined) =>
  useQuery({ queryKey: ['parent', 'fees', studentId], queryFn: () => api.get<ParentStudentFeesDTO>(`/parent/fees/students/${studentId}`), enabled: !!studentId, retry: false, staleTime: 0 });

// ───────────────────────────────────────────────────────────── writes

/** Runs a change, refreshes every finance list, and says what happened. Errors become friendly toasts unless `quiet`. */
export function useFinanceMutation<V, R>(fn: (vars: V) => Promise<R>, options: { success?: string | ((result: R) => string); quiet?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      void qc.invalidateQueries({ queryKey: FIN });
      void qc.invalidateQueries({ queryKey: ['parent', 'fees'] });
      const message = typeof options.success === 'function' ? options.success(result) : options.success;
      if (message) toast.success(message);
    },
    onError: (error) => {
      if (!options.quiet) toast.error(messageFor(error));
    },
  });
}

/** One click: the standard chart of accounts, the example tax codes and the default approval rules. Safe to press twice. */
export const useStandardSetup = () => useFinanceMutation(() => financeApi.standardSetup(), { success: 'The standard setup is ready.' });

export const financeApi = {
  standardSetup: () => api.post<{ accountsAdded: number }>('/finance/setup/standard'),
  updateEntity: (body: Record<string, unknown>) => api.patch<LegalEntityDTO>('/finance/legal-entity', body),
  updateTaxProfile: (body: Record<string, unknown>) => api.patch<TaxProfileDTO>('/finance/tax-profile', body),
  createYear: (code: string) => api.post<FinancialYearDTO>('/finance/financial-years', { code }),
  createAccount: (body: Record<string, unknown>) => api.post<AccountDTO>('/finance/chart-of-accounts', body),
  updateAccount: (id: string, body: Record<string, unknown>) => api.patch<AccountDTO>(`/finance/chart-of-accounts/${id}`, body),
  createBank: (body: Record<string, unknown>) => api.post<BankAccountDTO>('/finance/bank-accounts', body),
  updateBank: (id: string, body: Record<string, unknown>) => api.patch<BankAccountDTO>(`/finance/bank-accounts/${id}`, body),
  revealBank: (id: string, reason: string) => api.post<RevealedBankNumberDTO>(`/finance/bank-accounts/${id}/reveal`, { reason }),
  createCash: (body: Record<string, unknown>) => api.post<CashAccountDTO>('/finance/cash-accounts', body),
  updateCash: (id: string, body: Record<string, unknown>) => api.patch<CashAccountDTO>(`/finance/cash-accounts/${id}`, body),
  createTaxCode: (body: Record<string, unknown>) => api.post<TaxCodeDTO>('/finance/tax-codes', body),
  updateTaxCode: (id: string, body: Record<string, unknown>) => api.patch<TaxCodeDTO>(`/finance/tax-codes/${id}`, body),
  updatePolicy: (id: string, body: Record<string, unknown>) => api.patch<ApprovalPolicyDTO>(`/finance/approval-policies/${id}`, body),
  decideApproval: (id: string, body: { decision: 'APPROVE' | 'REJECT'; reason?: string }) => api.post<ApprovalRequestDTO>(`/finance/approvals/${id}/decide`, body),
  setAccess: (userId: string, body: { bundles: string[]; locationIds?: string[] | null }) => api.put<FinanceAccessDTO>(`/finance/access/users/${userId}`, body),
  createFeeHead: (body: Record<string, unknown>) => api.post<FeeHeadDTO>('/finance/fee-heads', body),
  updateFeeHead: (id: string, body: Record<string, unknown>) => api.patch<FeeHeadDTO>(`/finance/fee-heads/${id}`, body),
  createPlan: (body: Record<string, unknown>) => api.post<FeePlanDTO>('/finance/fee-plans', body),
  updatePlan: (id: string, body: Record<string, unknown>) => api.patch<FeePlanDTO>(`/finance/fee-plans/${id}`, body),
  createVersion: (planId: string, body: Record<string, unknown> = {}) => api.post<FeePlanDTO>(`/finance/fee-plans/${planId}/versions`, body),
  updateVersion: (versionId: string, body: Record<string, unknown>) => api.patch<FeePlanDTO>(`/finance/fee-plan-versions/${versionId}`, body),
  validateVersion: (versionId: string) => api.post<PlanValidationDTO & { impact: { students: number; expectedPaise: number } }>(`/finance/fee-plan-versions/${versionId}/validate`),
  approveVersion: (versionId: string) => api.post<FeePlanDTO>(`/finance/fee-plan-versions/${versionId}/approve`, {}),
  publishVersion: (versionId: string) => api.post<FeePlanDTO>(`/finance/fee-plan-versions/${versionId}/publish`, {}),
  recommend: (body: { sessionId: string; locationId: string; classId?: string }) => api.post<AssignmentRecommendationDTO>('/finance/fee-plan-assignments/recommend', body),
  bulkAssign: (body: { sessionId: string; locationId: string; classId?: string; items?: { studentId: string; planVersionId?: string }[] }) => api.post<BulkAssignResultDTO>('/finance/fee-plan-assignments/bulk', body),
  updateAssignment: (studentId: string, body: Record<string, unknown>) => api.patch<StudentAssignmentDTO>(`/finance/students/${studentId}/assignment`, body),
  createConcessionPolicy: (body: Record<string, unknown>) => api.post<ConcessionPolicyDTO>('/finance/concession-policies', body),
  updateConcessionPolicy: (id: string, body: Record<string, unknown>) => api.patch<ConcessionPolicyDTO>(`/finance/concession-policies/${id}`, body),
  suggestConcessions: (body: { sessionId?: string; classOfferingId?: string; studentId?: string }) => api.post<ConcessionSuggestionDTO[]>('/finance/concessions/recommend', body),
  awardConcession: (body: Record<string, unknown>) => api.post<ConcessionAwardDTO>('/finance/concessions/award', body),
  awardMany: (awards: { studentId: string; policyId: string }[]) => api.post<{ done: ConcessionAwardDTO[]; skipped: { studentId: string; message: string }[] }>('/finance/concessions/award-many', { awards }),
  decideAward: (id: string, action: 'approve' | 'reject' | 'end', reason?: string) => api.post<ConcessionAwardDTO>(`/finance/concessions/${id}/${action}`, { reason }),
  createLateFeePolicy: (body: Record<string, unknown>) => api.post<LateFeePolicyDTO>('/finance/late-fee-policies', body),
  updateLateFeePolicy: (id: string, body: Record<string, unknown>) => api.patch<LateFeePolicyDTO>(`/finance/late-fee-policies/${id}`, body),
  previewLateFees: (body: { asOf?: string; locationId?: string }) => api.post<LateFeePreviewDTO>('/finance/late-fees/preview', body),
  commitLateFees: (body: { asOf?: string; locationId?: string }) => api.post<{ created: number; skipped: number }>('/finance/late-fees/commit', body),
  createRun: (body: Record<string, unknown>) => api.post<BillingRunDTO>('/finance/billing-runs', body),
  checkRun: (runId: string) => api.post<BillingValidationDTO>(`/finance/billing-runs/${runId}/validate`),
  skipRow: (runId: string, rowId: string, reason: string) => api.patch<BillingRowDTO>(`/finance/billing-runs/${runId}/rows/${rowId}`, { action: 'SKIP', reason }),
  commitRun: (runId: string, body: { confirmedReadyCount: number; confirmedTotalPaise: number }, key: string) => api.post<BillingCommitDTO>(`/finance/billing-runs/${runId}/commit`, body, { 'Idempotency-Key': key }),
  cancelRun: (runId: string) => api.post<BillingRunDTO>(`/finance/billing-runs/${runId}/cancel`),
  createAdjustment: (documentId: string, body: Record<string, unknown>) => api.post<AdjustmentResultDTO>(`/finance/fee-documents/${documentId}/adjustments`, body),
};

/** Opens a bill or statement PDF in a new tab. The browser keeps the file only in memory. */
export async function openPdf(path: string): Promise<void> {
  const blob = await fetchBlob(path);
  const url = URL.createObjectURL(blob);
  window.open(url, '_blank', 'noopener');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
