import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  AcademicContextDTO,
  AcademicContextGradesDTO,
  AcademicOverviewDTO,
  AcademicSessionDTO,
  AcademicTermDTO,
  AuditPageDTO,
  BoardDTO,
  BoardRuleVersionDTO,
  ChoiceGroupDTO,
  ConstraintDTO,
  GradeMasterDTO,
  GradeOfferingDTO,
  MasterLocationDTO,
  PaginatedDTO,
  ProgrammeDTO,
  SectionOfferingDTO,
  SubjectDTO,
  SubjectOfferingDTO,
  ValidationResultDTO,
} from '@shared';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/** Every academic query key starts with 'academic', so one invalidation refreshes the whole feature. */
export const A = ['academic'] as const;

function qs(params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') q.set(k, String(v));
  const text = q.toString();
  return text ? `?${text}` : '';
}

// ───────────────────────────────────────────────────────────── reads

export const useSessions = (enabled = true) =>
  useQuery({ queryKey: [...A, 'sessions'], queryFn: () => api.get<AcademicSessionDTO[]>('/academic-sessions'), enabled });

export const useSession = (id: string | undefined) =>
  useQuery({ queryKey: [...A, 'session', id], queryFn: () => api.get<AcademicSessionDTO>(`/academic-sessions/${id}`), enabled: !!id });

export const useOverview = (id: string | undefined, enabled = true) =>
  useQuery({ queryKey: [...A, 'overview', id], queryFn: () => api.get<AcademicOverviewDTO>(`/academic-sessions/${id}/overview`), enabled: !!id && enabled });

export const useGradeMaster = () =>
  useQuery({ queryKey: [...A, 'grades'], queryFn: () => api.get<GradeMasterDTO[]>('/grades'), staleTime: Infinity });

export const useBoards = () => useQuery({ queryKey: [...A, 'boards'], queryFn: () => api.get<BoardDTO[]>('/boards'), staleTime: 60_000 });

export const useRuleVersions = (boardId: string | undefined) =>
  useQuery({ queryKey: [...A, 'rule-versions', boardId], queryFn: () => api.get<BoardRuleVersionDTO[]>(`/boards/${boardId}/rule-versions`), enabled: !!boardId, staleTime: 60_000 });

/** Rule versions for several boards at once (subject master board-code mapping). */
export function useAllRuleVersions(boards: BoardDTO[]) {
  return useQueries({
    queries: boards.map((b) => ({ queryKey: [...A, 'rule-versions', b.boardId], queryFn: () => api.get<BoardRuleVersionDTO[]>(`/boards/${b.boardId}/rule-versions`), staleTime: 60_000 })),
  });
}

export const useActiveLocations = () =>
  useQuery({ queryKey: [...A, 'locations'], queryFn: () => api.get<MasterLocationDTO[]>('/master/locations'), staleTime: 30_000 });

export const useGradeOfferings = (sessionId: string | undefined, locationId: string | undefined) =>
  useQuery({
    queryKey: [...A, 'grade-offerings', sessionId, locationId],
    queryFn: () => api.get<GradeOfferingDTO[]>(`/academic-sessions/${sessionId}/grade-offerings${qs({ locationId })}`),
    enabled: !!sessionId && !!locationId,
  });

export const useSections = (gradeOfferingId: string | undefined, enabled = true) =>
  useQuery({ queryKey: [...A, 'sections', gradeOfferingId], queryFn: () => api.get<SectionOfferingDTO[]>(`/grade-offerings/${gradeOfferingId}/sections`), enabled: !!gradeOfferingId && enabled });

export const useSubjectOfferings = (gradeOfferingId: string | undefined) =>
  useQuery({ queryKey: [...A, 'subject-offerings', gradeOfferingId], queryFn: () => api.get<SubjectOfferingDTO[]>(`/grade-offerings/${gradeOfferingId}/subjects`), enabled: !!gradeOfferingId });

/** Subject offerings of several grade offerings (programme subject picker). */
export function useSubjectOfferingsOf(gradeOfferingIds: string[]) {
  return useQueries({
    queries: gradeOfferingIds.map((id) => ({ queryKey: [...A, 'subject-offerings', id], queryFn: () => api.get<SubjectOfferingDTO[]>(`/grade-offerings/${id}/subjects`) })),
  });
}

export const useChoiceGroups = (gradeOfferingId: string | undefined) =>
  useQuery({ queryKey: [...A, 'choice-groups', gradeOfferingId], queryFn: () => api.get<ChoiceGroupDTO[]>(`/grade-offerings/${gradeOfferingId}/choice-groups`), enabled: !!gradeOfferingId });

export const useConstraints = (gradeOfferingId: string | undefined) =>
  useQuery({ queryKey: [...A, 'constraints', gradeOfferingId], queryFn: () => api.get<ConstraintDTO[]>(`/grade-offerings/${gradeOfferingId}/constraints`), enabled: !!gradeOfferingId });

export const useProgrammes = (sessionId: string | undefined, locationId: string | undefined) =>
  useQuery({
    queryKey: [...A, 'programmes', sessionId, locationId],
    queryFn: () => api.get<ProgrammeDTO[]>(`/academic-programmes${qs({ academicSessionId: sessionId, locationId })}`),
    enabled: !!sessionId,
  });

export const useTerms = (sessionId: string | undefined) =>
  useQuery({ queryKey: [...A, 'terms', sessionId], queryFn: () => api.get<AcademicTermDTO[]>(`/academic-sessions/${sessionId}/terms`), enabled: !!sessionId });

export interface SubjectParams {
  search?: string;
  boardCode?: string;
  category?: string;
  gradeId?: string;
  languageCode?: string;
  status?: string;
  page?: number;
}

export const useSubjects = (params: SubjectParams, pageSize = 50) =>
  useQuery({
    queryKey: [...A, 'subjects', params, pageSize],
    queryFn: () => api.get<PaginatedDTO<SubjectDTO>>(`/subjects${qs({ ...params, pageSize })}`),
  });

export function useAcademicContext(args: { academicSessionId?: string; locationId?: string; gradeId?: string }) {
  return useQuery({
    queryKey: [...A, 'context', args],
    queryFn: () => api.get<AcademicContextGradesDTO | AcademicContextDTO>(`/academic-context${qs(args)}`),
    enabled: !!args.academicSessionId && !!args.locationId,
  });
}

export function useSessionAudit(academicSessionId: string | undefined, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: ['audit', 'session', academicSessionId],
    queryFn: ({ pageParam }) => api.get<AuditPageDTO>(`/audit${qs({ academicSessionId, cursor: pageParam, limit: 20 })}`),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: enabled && !!academicSessionId,
  });
}

// ───────────────────────────────────────────────────────────── mutations

interface MutationOptions<V, R> {
  /** Toast shown on success. */
  success?: string | ((result: R, vars: V) => string);
  /** Let the caller handle errors (e.g. attach them to form fields) instead of toasting. */
  quiet?: boolean;
  optimistic?: { key: QueryKey; update: (old: never, vars: V) => unknown };
}

/** Runs a write, refreshes the academic queries and the audit trail, and toasts the outcome. */
export function useAcademicMutation<V, R>(fn: (vars: V) => Promise<R>, options: MutationOptions<V, R> = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onMutate: async (vars) => {
      if (!options.optimistic) return undefined;
      await qc.cancelQueries({ queryKey: options.optimistic.key });
      const previous = qc.getQueryData(options.optimistic.key);
      if (previous !== undefined) qc.setQueryData(options.optimistic.key, options.optimistic.update(previous as never, vars));
      return { previous };
    },
    onError: (err, _vars, ctx) => {
      if (options.optimistic && ctx?.previous !== undefined) qc.setQueryData(options.optimistic.key, ctx.previous);
      if (!options.quiet) toast.error(messageFor(err));
    },
    onSuccess: (result, vars) => {
      const message = typeof options.success === 'function' ? options.success(result, vars) : options.success;
      if (message) toast.success(message);
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: A });
      void qc.invalidateQueries({ queryKey: ['audit'] });
      void qc.invalidateQueries({ queryKey: ['setup-status'] });
    },
  });
}

export const sessionCall = {
  create: (body: unknown) => api.post<AcademicSessionDTO>('/academic-sessions', body),
  clone: (id: string, body: unknown) => api.post<AcademicSessionDTO>(`/academic-sessions/${id}/clone`, body),
  action: (id: string, action: string) => api.post<AcademicSessionDTO>(`/academic-sessions/${id}/${action}`),
  validate: (id: string) => api.post<ValidationResultDTO>(`/academic-sessions/${id}/validate`),
  remove: (id: string) => api.delete<void>(`/academic-sessions/${id}`),
};
