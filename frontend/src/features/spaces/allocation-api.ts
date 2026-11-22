import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AssignmentChangeResultDTO,
  BulkAssignmentResultDTO,
  HomeClassroomDTO,
  HomeClassroomListDTO,
  MyClassroomsDTO,
  RecommendationSetDTO,
  ReplaceRoomResultDTO,
  RolloverCommitDTO,
  RolloverSummaryDTO,
  RoomRefDTO,
  SpaceAttentionDTO,
  SpaceReportDTO,
  SpaceReportType,
} from '@shared';
import { api, ApiError } from '@/lib/api';
import { qs, SP, useSpaceMutation } from './api';

/** Module 5, Part 4 — reads and writes for Home Classrooms, rollover, Needs Attention and reports. Every key starts with 'spaces'. */

// ───────────────────────────────────────────────────────────── reads

/** The suggested room for every section of the year at this campus, plus the ones that need a look. Worked out fresh on the server. */
export const useRecommendations = (sessionId: string | undefined, locationId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...SP, 'recommendations', sessionId, locationId],
    queryFn: () => api.post<RecommendationSetDTO>('/sections/home-classroom-recommendations', { sessionId, locationId }),
    enabled: !!sessionId && !!locationId && enabled,
    retry: false,
  });

export interface AssignmentListParams {
  academicSessionId?: string;
  locationId?: string;
  sectionOfferingId?: string;
  physicalSpaceId?: string;
  phase?: 'current' | 'planned' | 'ended' | 'cancelled';
  pageSize?: number;
}

export const useAssignments = (params: AssignmentListParams, enabled = true) =>
  useQuery({
    queryKey: [...SP, 'assignments', params],
    queryFn: () => api.get<HomeClassroomListDTO>(`/section-space-assignments${qs({ pageSize: 200, ...params })}`),
    enabled: enabled && (!!params.locationId || !!params.sectionOfferingId || !!params.physicalSpaceId),
    placeholderData: keepPreviousData,
  });

export const useAssignment = (assignmentId: string | null | undefined) =>
  useQuery({ queryKey: [...SP, 'assignment', assignmentId], queryFn: () => api.get<HomeClassroomDTO>(`/section-space-assignments/${assignmentId}`), enabled: !!assignmentId, retry: false });

/** Rows that still hold a room: in force now or starting later (not ended, not cancelled). */
export const isLiveRow = (row: Pick<HomeClassroomDTO, 'phase'>) => row.phase === 'ACTIVE' || row.phase === 'PLANNED';

export const useSpaceAttention = (locationId: string | undefined, sessionId: string | undefined, enabled = true) =>
  useQuery({
    queryKey: [...SP, 'attention', locationId, sessionId],
    queryFn: () => api.get<SpaceAttentionDTO>(`/spaces/attention${qs({ locationId, sessionId })}`),
    enabled: !!locationId && enabled,
    staleTime: 30_000,
  });

export const useRolloverPreview = (input: { fromSessionId?: string; toSessionId?: string; locationId?: string }) =>
  useQuery({
    queryKey: [...SP, 'rollover', input],
    queryFn: () => api.post<RolloverSummaryDTO>('/section-space-assignments/rollover/preview', input),
    enabled: !!input.fromSessionId && !!input.toSessionId && !!input.locationId && input.fromSessionId !== input.toSessionId,
    retry: false,
  });

export const useSpaceReport = (type: SpaceReportType, params: { locationId?: string; sessionId?: string }) =>
  useQuery({
    queryKey: [...SP, 'report', type, params],
    queryFn: () => api.get<SpaceReportDTO>(`/spaces/reports/${type}${qs(params)}`),
    enabled: !!params.locationId,
    placeholderData: keepPreviousData,
  });

export const reportCsvUrl = (type: SpaceReportType, params: { locationId?: string; sessionId?: string }) => `/api/v1/spaces/reports/${type}${qs({ ...params, format: 'csv' })}`;

export const useMyClassrooms = (enabled = true) => useQuery({ queryKey: [...SP, 'my-classrooms'], queryFn: () => api.get<MyClassroomsDTO>('/spaces/my-classrooms'), enabled });

// ───────────────────────────────────────────────────────────── writes

export interface AssignBody {
  sectionOfferingId: string;
  physicalSpaceId: string;
  replaceExisting?: boolean;
  capacityOverride?: { reason: string };
  reason?: string;
}

/** All errors are shown by the screen itself (the capacity dialog, a row's message), so the mutations stay quiet. */
export const useAssignRoom = () => useSpaceMutation((body: AssignBody) => api.post<AssignmentChangeResultDTO>('/section-space-assignments', body), { quiet: true });

export const useReplaceAssignmentRoom = () =>
  useSpaceMutation(({ assignmentId, ...body }: { assignmentId: string; physicalSpaceId: string; capacityOverride?: { reason: string }; reason?: string }) => api.post<AssignmentChangeResultDTO>(`/section-space-assignments/${assignmentId}/replace`, body), { quiet: true });

export const useEndAssignment = () =>
  useSpaceMutation(({ assignmentId, ...body }: { assignmentId: string; effectiveTo: string; reason?: string }) => api.post<AssignmentChangeResultDTO>(`/section-space-assignments/${assignmentId}/end`, body), { quiet: true });

export const useBulkAssign = () =>
  useSpaceMutation((body: { items: AssignBody[]; source: 'SYSTEM_RECOMMENDED' | 'BULK' | 'MANUAL' }) => api.post<BulkAssignmentResultDTO>('/section-space-assignments/bulk', body), { quiet: true });

export const useRolloverCommit = () =>
  useSpaceMutation((body: { fromSessionId: string; toSessionId: string; locationId: string }) => api.post<RolloverCommitDTO>('/section-space-assignments/rollover/commit', body), { quiet: true });

export const useReplaceRoom = (spaceId: string) =>
  useSpaceMutation((body: { mode: 'NOW' | 'AFTER_SESSION'; replacementSpaceId?: string; capacityOverride?: { reason: string }; reason?: string }) => api.post<ReplaceRoomResultDTO>(`/physical-spaces/${spaceId}/replace`, body), { quiet: true });

// ───────────────────────────────────────────────────────────── the "room too small" answer

/** What the server says when a room has fewer seats than the section has students. The same dialog shows it everywhere. */
export interface TooSmall {
  message: string;
  sectionStrength: number;
  roomCapacity: number;
  shortBy: number;
  suggestedRoom: RoomRefDTO | null;
}

export function tooSmallFrom(error: unknown): TooSmall | null {
  if (!(error instanceof ApiError) || error.code !== 'ROOM_TOO_SMALL') return null;
  const d = (error.details ?? {}) as Record<string, unknown>;
  return {
    message: error.message,
    sectionStrength: Number(d.sectionStrength ?? 0),
    roomCapacity: Number(d.roomCapacity ?? 0),
    shortBy: Number(d.shortBy ?? 0),
    suggestedRoom: (d.suggestedRoom as RoomRefDTO | null | undefined) ?? null,
  };
}
