import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  BellAssignmentsDTO,
  BellGeneratePreviewDTO,
  BellResolutionDTO,
  BellScheduleDTO,
  FacultyAvailabilityDTO,
  GroupHealthDTO,
  GroupMemberListDTO,
  PlanTeacherDTO,
  RequirementListDTO,
  TeachingGroupDTO,
  TimetablePlanDTO,
  TimetableReadinessDTO,
  WorkloadRulesDTO,
} from '@shared';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/** Every timetable query key starts with 'timetable', so one invalidation refreshes the whole feature. */
export const TT = ['timetable'] as const;

export function qs(params: Record<string, string | number | boolean | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
}

// ───────────────────────────────────────────────────────────── reads

export const usePlans = (locationId: string | undefined, academicSessionId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'plans', locationId, academicSessionId], queryFn: () => api.get<TimetablePlanDTO[]>(`/timetable-plans${qs({ locationId, academicSessionId })}`), enabled: !!locationId && !!academicSessionId });

export const useReadiness = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'readiness', planId], queryFn: () => api.get<TimetableReadinessDTO>(`/timetable-plans/${planId}/readiness`), enabled: !!planId });

export const useBellSchedules = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'bells', planId], queryFn: () => api.get<BellScheduleDTO[]>(`/timetable-plans/${planId}/bell-schedules`), enabled: !!planId });

export const useBellAssignments = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'bell-assignments', planId], queryFn: () => api.get<BellAssignmentsDTO>(`/timetable-plans/${planId}/bell-assignments`), enabled: !!planId });

export const useBellResolution = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'bell-resolution', planId], queryFn: () => api.get<BellResolutionDTO>(`/timetable-plans/${planId}/bell-resolution`), enabled: !!planId });

export interface GenerateBody {
  name: string;
  kind?: string;
  start: string;
  end: string;
  periodMinutes: number;
  breaks: { name: string; start: string; end: string; type: 'BREAK' | 'LUNCH' }[];
  assembly?: { name: string; start: string; end: string };
}

/** What the day would look like. Read-only (it is a POST only because it carries the whole form). */
export const useBellPreview = (planId: string | undefined, body: GenerateBody | null) =>
  useQuery({
    queryKey: [...TT, 'bell-preview', planId, body],
    queryFn: () => api.post<BellGeneratePreviewDTO>(`/timetable-plans/${planId}/bell-schedules/generate/preview`, body),
    enabled: !!planId && !!body,
    placeholderData: keepPreviousData,
    retry: false,
  });

export const useRequirements = (planId: string | undefined, classOfferingId: string | undefined, sectionOfferingId?: string) =>
  useQuery({
    queryKey: [...TT, 'needs', planId, classOfferingId, sectionOfferingId],
    queryFn: () => api.get<RequirementListDTO>(`/subject-schedule-requirements${qs({ planId, classOfferingId, sectionOfferingId })}`),
    enabled: !!planId && !!classOfferingId,
  });

export const usePlanTeachers = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'teachers', planId], queryFn: () => api.get<PlanTeacherDTO[]>(`/timetable-plans/${planId}/teachers`), enabled: !!planId });

export const useAvailability = (planId: string | undefined, employeeId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'availability', planId, employeeId], queryFn: () => api.get<FacultyAvailabilityDTO>(`/faculty-availability/${employeeId}${qs({ planId })}`), enabled: !!planId && !!employeeId });

export const useWorkload = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'workload', planId], queryFn: () => api.get<WorkloadRulesDTO>(`/faculty-workload-rules${qs({ planId })}`), enabled: !!planId });

export const useGroups = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'groups', planId], queryFn: () => api.get<TeachingGroupDTO[]>(`/teaching-groups${qs({ planId })}`), enabled: !!planId });

export const useGroupMembers = (groupId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'group-members', groupId], queryFn: () => api.get<GroupMemberListDTO>(`/teaching-groups/${groupId}/members${qs({ pageSize: 200 })}`), enabled: !!groupId });

export const useGroupHealth = (groupId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'group-health', groupId], queryFn: () => api.get<GroupHealthDTO>(`/teaching-groups/${groupId}/health`), enabled: !!groupId });

// ───────────────────────────────────────────────────────────── writes

/** Runs a change, then refreshes everything on the timetable screens. Errors show as a toast with the server's plain words. */
export function useTimetableMutation<V, R>(fn: (vars: V) => Promise<R>, options: { success?: string | ((result: R) => string); quiet?: boolean; refresh?: boolean } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      if (options.refresh !== false) void qc.invalidateQueries({ queryKey: TT });
      const message = typeof options.success === 'function' ? options.success(result) : options.success;
      if (message) toast.success(message);
    },
    onError: (error) => {
      if (!options.quiet) toast.error(messageFor(error));
    },
  });
}
