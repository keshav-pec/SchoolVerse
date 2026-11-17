import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  ChangeRequestStatus,
  DepartmentDTO,
  DesignationDTO,
  EmployeeAccountDTO,
  EmployeeDirectoryDTO,
  EmployeeDocumentDTO,
  EmployeeHistoryDTO,
  EmployeeProfileDTO,
  FacultyAssignmentDTO,
  LocationAssignmentDTO,
  PaginatedDTO,
  ProfileChangeRequestDTO,
  RestrictedEmployeeProfileDTO,
  ResponsibilityDTO,
  SelfProfileDTO,
  SuggestedMastersDTO,
} from '@shared';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { isStepUpCancelled } from '@/lib/step-up';

/** Every Faculty & Staff query key starts with 'people', so one invalidation refreshes the whole feature. */
export const P = ['people'] as const;

export function qs(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
}

// ───────────────────────────────────────────────────────────── reads

export interface EmployeeListParams {
  q?: string;
  category?: string;
  departmentId?: string;
  designationId?: string;
  locationId?: string;
  status?: string;
  page?: number;
  pageSize?: number;
}

export const useEmployees = (params: EmployeeListParams, enabled = true) =>
  useQuery({
    queryKey: [...P, 'list', params],
    queryFn: () => api.get<PaginatedDTO<EmployeeDirectoryDTO>>(`/employees${qs({ ...params })}`),
    placeholderData: keepPreviousData,
    enabled,
  });

export const useEmployee = (employeeId: string | undefined) =>
  useQuery({
    queryKey: [...P, 'employee', employeeId],
    queryFn: () => api.get<EmployeeProfileDTO>(`/employees/${employeeId}`),
    enabled: !!employeeId,
  });

export const useEmployeeHistory = (employeeId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...P, 'history', employeeId],
    queryFn: () => api.get<EmployeeHistoryDTO>(`/employees/${employeeId}/history`),
    enabled: !!employeeId && enabled,
  });

export const useLocationAssignments = (employeeId: string | undefined) =>
  useQuery({
    queryKey: [...P, 'locations', employeeId],
    queryFn: () =>
      api.get<LocationAssignmentDTO[]>(`/employees/${employeeId}/location-assignments`),
    enabled: !!employeeId,
  });

export const useFacultyAssignments = (
  employeeId: string | undefined,
  academicSessionId?: string,
  enabled = true,
) =>
  useQuery({
    queryKey: [...P, 'academic', employeeId, academicSessionId ?? 'all'],
    queryFn: () =>
      api.get<FacultyAssignmentDTO[]>(
        `/employees/${employeeId}/academic-assignments${qs({ academicSessionId })}`,
      ),
    enabled: !!employeeId && enabled,
  });

export const useResponsibilities = (employeeId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...P, 'responsibilities', employeeId],
    queryFn: () => api.get<ResponsibilityDTO[]>(`/employees/${employeeId}/responsibilities`),
    enabled: !!employeeId && enabled,
  });

export const useDepartments = (enabled = true) =>
  useQuery({
    queryKey: [...P, 'departments'],
    queryFn: () => api.get<DepartmentDTO[]>('/departments'),
    enabled,
    staleTime: 60_000,
  });

export const useDesignations = (enabled = true) =>
  useQuery({
    queryKey: [...P, 'designations'],
    queryFn: () => api.get<DesignationDTO[]>('/designations'),
    enabled,
    staleTime: 60_000,
  });

export const useRestricted = (employeeId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...P, 'restricted', employeeId],
    queryFn: () => api.get<RestrictedEmployeeProfileDTO>(`/employees/${employeeId}/restricted`),
    enabled: !!employeeId && enabled,
  });

export const useEmployeeAccount = (employeeId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...P, 'account', employeeId],
    queryFn: () => api.get<EmployeeAccountDTO>(`/employees/${employeeId}/user-account`),
    enabled: !!employeeId && enabled,
  });

export const useEmployeeDocuments = (employeeId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...P, 'documents', employeeId],
    queryFn: () => api.get<EmployeeDocumentDTO[]>(`/employees/${employeeId}/documents`),
    enabled: !!employeeId && enabled,
  });

export const useChangeRequests = (status: ChangeRequestStatus | undefined, enabled = true) =>
  useQuery({
    queryKey: [...P, 'requests', status ?? 'all'],
    queryFn: () => api.get<ProfileChangeRequestDTO[]>(`/profile-change-requests${qs({ status })}`),
    enabled,
  });

/** For the badge in the sidebar. Polls gently so a new request shows up without a reload. */
export const usePendingRequestCount = (enabled: boolean) =>
  useQuery({
    queryKey: [...P, 'requests', 'PENDING'],
    queryFn: () => api.get<ProfileChangeRequestDTO[]>('/profile-change-requests?status=PENDING'),
    enabled,
    refetchInterval: 60_000,
    select: (items) => items.length,
  });

// ───────────────────────────────────────────────────────────── self-service

export const useSelfProfile = () =>
  useQuery({
    queryKey: [...P, 'me'],
    queryFn: () => api.get<SelfProfileDTO>('/me/profile'),
    retry: false,
  });

export const useOwnRequests = (enabled = true) =>
  useQuery({
    queryKey: [...P, 'me', 'requests'],
    queryFn: () => api.get<ProfileChangeRequestDTO[]>('/me/profile-change-requests'),
    enabled,
  });

export const useOwnDocuments = (enabled = true) =>
  useQuery({
    queryKey: [...P, 'me', 'documents'],
    queryFn: () => api.get<EmployeeDocumentDTO[]>('/me/documents'),
    enabled,
  });

// ───────────────────────────────────────────────────────────── writes

interface MutationOptions<V, R> {
  /** Toast shown on success. */
  success?: string | ((result: R, vars: V) => string);
  /** The caller shows errors itself (inside a dialog or next to a field). */
  quiet?: boolean;
}

/** Runs a write, refreshes everything under 'people' and the audit trails, and toasts the outcome. */
export function usePeopleMutation<V, R>(
  fn: (vars: V) => Promise<R>,
  options: MutationOptions<V, R> = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: P });
      void qc.invalidateQueries({ queryKey: ['audit'] });
      if (options.success)
        toast.success(
          typeof options.success === 'function' ? options.success(result, vars) : options.success,
        );
    },
    onError: (err) => {
      if (options.quiet || isStepUpCancelled(err)) return;
      toast.error(messageFor(err));
    },
  });
}

export const suggestedLabel = <T>(r: SuggestedMastersDTO<T>) =>
  r.created.length === 0
    ? 'Everything on the starter list was already there.'
    : `Added ${r.created.length}${r.skipped ? `, skipped ${r.skipped} that already existed` : ''}.`;

/** Opens a signed download link the way a browser would, without leaving the page. */
export function openSignedLink(url: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
