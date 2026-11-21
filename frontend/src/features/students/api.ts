import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AdmissionNumberPreviewDTO,
  AdmissionNumberSettingsDTO,
  DuplicateCheckResultDTO,
  EnrollmentDTO,
  FacultyStudentListDTO,
  FacultyStudentSummaryDTO,
  FamilyListDTO,
  GuardianFamilyDTO,
  GuardianLinkDTO,
  GuardianMatchDTO,
  SectionRecommendationDTO,
  StudentAdminProfileDTO,
  StudentAttentionDTO,
  StudentHistoryDTO,
  StudentListDTO,
  StudentSubjectsDTO,
  SubjectSelectionResultDTO,
} from '@shared';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/** Every student query key starts with 'students', so one invalidation refreshes the whole feature. */
export const S = ['students'] as const;

export function qs(params: Record<string, string | number | boolean | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '' && v !== false) q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
}

// ───────────────────────────────────────────────────────────── reads

export interface StudentListParams {
  q?: string;
  academicSessionId?: string;
  locationId?: string;
  classOfferingId?: string;
  sectionId?: string;
  status?: string;
  enrollmentStatus?: string;
  missingGuardian?: boolean;
  missingSection?: boolean;
  page?: number;
  pageSize?: number;
}

export const useStudents = (params: StudentListParams, enabled = true) =>
  useQuery({
    queryKey: [...S, 'list', params],
    queryFn: () => api.get<StudentListDTO>(`/students${qs({ ...params })}`),
    placeholderData: keepPreviousData,
    enabled,
  });

/** What a teacher gets from the same route: the short summary only. */
export const useMyStudents = (params: { q?: string; sectionId?: string; page?: number; pageSize?: number }) =>
  useQuery({
    queryKey: [...S, 'mine', params],
    queryFn: () => api.get<FacultyStudentListDTO>(`/students${qs({ ...params })}`),
    placeholderData: keepPreviousData,
  });

export const useStudent = (studentId: string | undefined) =>
  useQuery({
    queryKey: [...S, 'student', studentId],
    queryFn: () => api.get<StudentAdminProfileDTO>(`/students/${studentId}`),
    enabled: !!studentId,
  });

/** What a teacher gets for one student: the short summary, or a 404 when the student is not in their sections. */
export const useFacultyStudent = (studentId: string | undefined) =>
  useQuery({
    queryKey: [...S, 'faculty-student', studentId],
    queryFn: () => api.get<FacultyStudentSummaryDTO>(`/students/${studentId}`),
    enabled: !!studentId,
    retry: false,
  });

export const useStudentHistory = (studentId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'history', studentId],
    queryFn: () => api.get<StudentHistoryDTO>(`/students/${studentId}/history`),
    enabled: !!studentId && enabled,
  });

export const useStudentGuardians = (studentId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'guardians', studentId],
    queryFn: () => api.get<GuardianLinkDTO[]>(`/students/${studentId}/guardians`),
    enabled: !!studentId && enabled,
  });

export const useStudentEnrollments = (studentId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'enrollments', studentId],
    queryFn: () => api.get<EnrollmentDTO[]>(`/students/${studentId}/enrollments`),
    enabled: !!studentId && enabled,
  });

export const useEnrollmentSubjects = (enrollmentId: string | null | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'subjects', enrollmentId],
    queryFn: () => api.get<StudentSubjectsDTO>(`/student-enrollments/${enrollmentId}/subjects`),
    enabled: !!enrollmentId && enabled,
  });

export const useAdmissionSettings = (enabled = true) =>
  useQuery({
    queryKey: [...S, 'admission-settings'],
    queryFn: () => api.get<AdmissionNumberSettingsDTO>('/admission-number-settings'),
    enabled,
    staleTime: 30_000,
  });

export const useAdmissionPreview = (args: { academicSessionId?: string; locationId?: string }, enabled = true) =>
  useQuery({
    queryKey: [...S, 'admission-preview', args],
    queryFn: () => api.post<AdmissionNumberPreviewDTO>('/admission-numbers/preview', args),
    enabled,
    staleTime: 10_000,
  });

/** The best section for a new student first, with seats left. */
export const useSectionRecommendations = (classOfferingId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...S, 'recommend', classOfferingId],
    queryFn: () => api.post<SectionRecommendationDTO[]>('/sections/recommend', { classOfferingId }),
    enabled: !!classOfferingId && enabled,
  });

/** Is the typed phone or email already a parent? Called as soon as one is typed. */
export const useGuardianMatch = (args: { phone?: string; email?: string; name?: string }, enabled = true) =>
  useQuery({
    queryKey: [...S, 'guardian-match', args],
    queryFn: () => api.post<GuardianMatchDTO[]>('/guardians/match', args),
    enabled: enabled && Boolean(args.phone || args.email || args.name),
    staleTime: 10_000,
    retry: false,
  });

export const useFamilies = (params: { q?: string; page?: number; pageSize?: number }) =>
  useQuery({
    queryKey: [...S, 'families', params],
    queryFn: () => api.get<FamilyListDTO>(`/guardians${qs({ ...params })}`),
    placeholderData: keepPreviousData,
  });

export const useFamily = (personId: string | undefined) =>
  useQuery({
    queryKey: [...S, 'family', personId],
    queryFn: () => api.get<GuardianFamilyDTO>(`/guardians/${personId}/children`),
    enabled: !!personId,
  });

export const useAttention = (args: { academicSessionId?: string; locationId?: string }, enabled = true) =>
  useQuery({
    queryKey: [...S, 'attention', args],
    queryFn: () => api.get<StudentAttentionDTO>(`/students/attention${qs({ ...args })}`),
    enabled,
    staleTime: 30_000,
  });

export function useDuplicateCheck() {
  return useMutation({ mutationFn: (body: object) => api.post<DuplicateCheckResultDTO>('/students/duplicate-check', body) });
}

export function useValidateSubjects(enrollmentId: string | undefined) {
  return useMutation({ mutationFn: (subjectOfferingIds: string[]) => api.post<SubjectSelectionResultDTO>(`/student-enrollments/${enrollmentId}/subjects/validate-selection`, { subjectOfferingIds }) });
}

// ───────────────────────────────────────────────────────────── writes

interface MutationOptions<V, R> {
  success?: string | ((result: R, vars: V) => string);
  /** The caller shows errors itself (inside a dialog or next to a field). */
  quiet?: boolean;
}

/** Runs a write, refreshes everything under 'students' and the audit trails, and toasts the outcome. */
export function useStudentMutation<V, R>(fn: (vars: V) => Promise<R>, options: MutationOptions<V, R> = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result, vars) => {
      void qc.invalidateQueries({ queryKey: S });
      void qc.invalidateQueries({ queryKey: ['audit'] });
      if (options.success) toast.success(typeof options.success === 'function' ? options.success(result, vars) : options.success);
    },
    onError: (error) => {
      if (!options.quiet) toast.error(messageFor(error));
    },
  });
}

/** The count behind the sidebar badge. Refreshes after every student change (same 'students' key) and now and then. */
export const useAttentionCount = (enabled: boolean, ctx: { academicSessionId?: string; locationId?: string }) =>
  useQuery({
    queryKey: [...S, 'attention', ctx],
    queryFn: () => api.get<StudentAttentionDTO>(`/students/attention${qs({ ...ctx })}`),
    enabled,
    staleTime: 60_000,
    refetchInterval: 180_000,
    select: (d) => d.counts.needsAttention,
  });
