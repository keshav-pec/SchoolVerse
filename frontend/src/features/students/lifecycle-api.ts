import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  ChangeRequestStatus,
  ImportDTO,
  ImportIssuesDTO,
  ImportRowListDTO,
  ParentAccessDTO,
  PromotionReadinessDTO,
  StudentChangeRequestListDTO,
  StudentDocumentsDTO,
  StudentTransfersDTO,
  TransferCertificateDTO,
  WithdrawalDTO,
} from '@shared';
import { api, ApiError } from '@/lib/api';
import { qs, S } from './api';

/**
 * Reads for Module 4, Part 4 screens (documents, parent access, transfers, exit, promotion, imports, change requests). Every key
 * starts with 'students', so `useStudentMutation` refreshes these too.
 */

export const useStudentDocuments = (studentId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'documents', studentId],
    queryFn: () => api.get<StudentDocumentsDTO>(`/students/${studentId}/documents`),
    enabled: !!studentId && enabled,
  });

export const useParentAccess = (studentId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'parent-access', studentId],
    queryFn: () => api.get<ParentAccessDTO[]>(`/students/${studentId}/parent-access`),
    enabled: !!studentId && enabled,
  });

export const useStudentTransfers = (studentId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'transfers', studentId],
    queryFn: () => api.get<StudentTransfersDTO>(`/students/${studentId}/transfers`),
    enabled: !!studentId && enabled,
  });

/** The withdrawal in progress, or null when none was started (the API answers 404 then). */
export const useWithdrawal = (studentId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'withdrawal', studentId],
    queryFn: async () => {
      try {
        return await api.get<WithdrawalDTO>(`/students/${studentId}/withdrawal`);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 404 || err.code === 'WITHDRAWAL_NOT_STARTED')) return null;
        throw err;
      }
    },
    enabled: !!studentId && enabled,
  });

export const useTransferCertificates = (studentId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'certificates', studentId],
    queryFn: () => api.get<TransferCertificateDTO[]>(`/students/${studentId}/transfer-certificates`),
    enabled: !!studentId && enabled,
  });

export const useStudentChangeRequests = (status: ChangeRequestStatus, page = 1) =>
  useQuery({
    queryKey: [...S, 'change-requests', status, page],
    queryFn: () => api.get<StudentChangeRequestListDTO>(`/student-change-requests${qs({ status, page, pageSize: 20 })}`),
    placeholderData: keepPreviousData,
  });

/** The count behind the "Change requests" sidebar badge. */
export const usePendingStudentRequests = (enabled: boolean) =>
  useQuery({
    queryKey: [...S, 'change-requests', 'count'],
    queryFn: () => api.get<StudentChangeRequestListDTO>(`/student-change-requests${qs({ status: 'PENDING', pageSize: 1 })}`),
    enabled,
    staleTime: 60_000,
    refetchInterval: 180_000,
    select: (d) => d.pendingCount,
  });

export const usePromotionReadiness = (scope: { fromSessionId?: string; toSessionId?: string; locationId?: string }) =>
  useQuery({
    queryKey: [...S, 'promotion', scope],
    queryFn: () => api.get<PromotionReadinessDTO>(`/promotions/readiness${qs({ ...scope })}`),
    enabled: Boolean(scope.fromSessionId && scope.toSessionId && scope.locationId),
  });

export const useImports = () => useQuery({ queryKey: [...S, 'imports'], queryFn: () => api.get<ImportDTO[]>('/students/imports') });

export const useImport = (importId: string | undefined) =>
  useQuery({ queryKey: [...S, 'import', importId], queryFn: () => api.get<ImportDTO>(`/students/imports/${importId}`), enabled: !!importId, retry: false });

export const useImportIssues = (importId: string | undefined, enabled: boolean) =>
  useQuery({ queryKey: [...S, 'import', importId, 'issues'], queryFn: () => api.get<ImportIssuesDTO>(`/students/imports/${importId}/issues`), enabled: !!importId && enabled });

export const useImportRows = (importId: string | undefined, params: { status?: string; page: number }, enabled: boolean) =>
  useQuery({
    queryKey: [...S, 'import', importId, 'rows', params],
    queryFn: () => api.get<ImportRowListDTO>(`/students/imports/${importId}/rows${qs({ ...params, pageSize: 25 })}`),
    enabled: !!importId && enabled,
    placeholderData: keepPreviousData,
  });

/** Plain links: the browser sends the session cookie, and the server answers with a CSV attachment. */
export const IMPORT_TEMPLATE_URL = `${import.meta.env.VITE_API_URL ?? '/api/v1'}/students/imports/template.csv`;
export const importIssuesCsvUrl = (importId: string) => `${import.meta.env.VITE_API_URL ?? '/api/v1'}/students/imports/${importId}/issues.csv`;
