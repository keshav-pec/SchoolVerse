import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AcceptGroupResultDTO,
  BulkResultDTO,
  ChangeSetDTO,
  CheckResultDTO,
  ChoiceDTO,
  CopyPreviousResultDTO,
  ExplainUnplacedDTO,
  FixRecommendationsDTO,
  GenerationRunDTO,
  GridDTO,
  GridView,
  PreviousSessionDTO,
  RunItemDTO,
  ScheduleAttentionDTO,
  SlotMapDTO,
  SlotRecommendationDTO,
  TimetableVersionDTO,
  Weekday,
  WriteResultDTO,
} from '@shared';
import { api } from '@/lib/api';
import { TT, qs } from '../api';

/** A fresh id for one change. A retry of the same change sends the same id, so the server never makes two lessons. */
export const newRequestId = () => globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

// ───────────────────────────────────────────────────────────── reads

export const useVersions = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'versions', planId], queryFn: () => api.get<TimetableVersionDTO[]>(`/timetable-plans/${planId}/versions`), enabled: !!planId });

/** The version being worked on. Other people's changes show up by watching its revision (on focus and every 20 seconds). */
export const useVersion = (versionId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'version', versionId], queryFn: () => api.get<TimetableVersionDTO>(`/timetable-versions/${versionId}`), enabled: !!versionId, refetchInterval: 20_000, refetchOnWindowFocus: true });

export const useGrid = (versionId: string | undefined, view: GridView, id: string | undefined) =>
  useQuery({
    queryKey: [...TT, 'grid', versionId, view, id],
    queryFn: () => api.get<GridDTO>(`/timetable-versions/${versionId}/grid${qs({ view, id })}`),
    enabled: !!versionId && !!id,
    placeholderData: keepPreviousData,
  });

export const useAttention = (versionId: string | undefined, enabled = true) =>
  useQuery({ queryKey: [...TT, 'attention', versionId], queryFn: () => api.get<ScheduleAttentionDTO>(`/timetable-versions/${versionId}/attention`), enabled: !!versionId && enabled });

export const useRunItems = (versionId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'run-items', versionId], queryFn: () => api.get<RunItemDTO[]>(`/timetable-versions/${versionId}/run-items${qs({ status: 'OPEN' })}`), enabled: !!versionId });

export const usePreviousSession = (planId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'previous', planId], queryFn: () => api.get<PreviousSessionDTO>(`/timetable-plans/${planId}/previous-session`), enabled: !!planId });

export const useHistory = (versionId: string | undefined) =>
  useQuery({ queryKey: [...TT, 'history', versionId], queryFn: () => api.get<ChangeSetDTO[]>(`/timetable-versions/${versionId}/history`), enabled: !!versionId });

export interface SlotTarget {
  versionId: string;
  weekday: Weekday;
  periodId: string;
  sectionId?: string;
  groupId?: string;
  subjectOfferingId?: string;
  excludeEntryId?: string;
}

const choiceQuery = (t: SlotTarget) => qs({ ...t });

/** Teachers or rooms for one slot, valid first. Busy ones come back greyed with the reason. */
export const useChoices = (kind: 'faculty' | 'spaces', target: SlotTarget | null) =>
  useQuery({ queryKey: [...TT, 'choices', kind, target], queryFn: () => api.get<ChoiceDTO[]>(`/timetable/available-${kind}${choiceQuery(target!)}`), enabled: !!target });

export const useRecommendedSlots = (versionId: string | undefined, target: { sectionId?: string; groupId?: string; subjectOfferingId?: string }, enabled: boolean) =>
  useQuery({
    queryKey: [...TT, 'recommend-slots', versionId, target],
    queryFn: () => api.post<SlotRecommendationDTO>('/timetable/recommend-slots', { versionId, ...target, count: 4 }),
    enabled: enabled && !!versionId,
  });

export const useExplain = (versionId: string | undefined, target: { sectionId?: string; groupId?: string; subjectOfferingId?: string }, enabled: boolean) =>
  useQuery({
    queryKey: [...TT, 'explain', versionId, target],
    queryFn: () => api.get<ExplainUnplacedDTO>(`/timetable/explain-unplaced${qs({ versionId, ...target })}`),
    enabled: enabled && !!versionId,
  });

// ───────────────────────────────────────────────────────────── calls (not hooks: the editor decides how to react to each answer)

export type Body = Record<string, unknown>;

export const calls = {
  createDraft: (planId: string) => api.post<TimetableVersionDTO>(`/timetable-plans/${planId}/versions`, {}),
  createEntry: (versionId: string, body: Body) => api.post<WriteResultDTO>(`/timetable-versions/${versionId}/entries`, body),
  updateEntry: (entryId: string, body: Body) => api.patch<WriteResultDTO>(`/timetable-entries/${entryId}`, body),
  moveEntry: (entryId: string, body: Body) => api.post<WriteResultDTO>(`/timetable-entries/${entryId}/move`, body),
  deleteEntry: (entryId: string, body: Body) => api.delete<WriteResultDTO>(`/timetable-entries/${entryId}`, body),
  bulk: (body: Body) => api.post<BulkResultDTO>('/timetable-entries/bulk', body),
  undo: (changeSetId: string) => api.post<WriteResultDTO>(`/timetable-changes/${changeSetId}/undo`, {}),
  check: (versionId: string, ops: Body[]) => api.post<CheckResultDTO>('/timetable/check', { versionId, ops }),
  slotMap: (versionId: string, entryId: string) => api.post<SlotMapDTO>('/timetable/slot-map', { versionId, entryId }),
  fixes: (versionId: string, entryId: string, rule: string) => api.post<FixRecommendationsDTO>('/timetable/conflicts/recommendations', { versionId, entryId, rule }),
  applyFix: (versionId: string, suggestionToken: string, requestId?: string) => api.post<WriteResultDTO>('/timetable-changes/apply', { versionId, suggestionToken, requestId }),
  smartDraft: (versionId: string, body: Body) => api.post<GenerationRunDTO>(`/timetable-versions/${versionId}/smart-draft`, body),
  copyPrevious: (planId: string, mode: 'PREVIEW' | 'COMMIT', requestId?: string) => api.post<CopyPreviousResultDTO>(`/timetable-plans/${planId}/copy-previous-session`, { mode, requestId }),
  acceptItem: (itemId: string) => api.post<{ item: RunItemDTO; result: WriteResultDTO | null }>(`/timetable-run-items/${itemId}/accept`, {}),
  dismissItem: (itemId: string) => api.post<RunItemDTO>(`/timetable-run-items/${itemId}/dismiss`, {}),
  acceptGroup: (runId: string, reason: string) => api.post<AcceptGroupResultDTO>('/timetable-run-items/accept-group', { runId, reason }),
};

/** Adds the retry id and, when the person confirmed or allowed something, the lock and override flags. */
export function withOptions<T extends Body>(body: T, o: { requestId: string; confirmUnlock?: boolean; override?: { rule: string; reason: string } }): Body {
  return { ...body, requestId: o.requestId, ...(o.confirmUnlock ? { confirmUnlock: true } : {}), ...(o.override ? { override: o.override } : {}) };
}
