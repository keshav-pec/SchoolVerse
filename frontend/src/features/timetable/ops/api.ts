import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type {
  AbsenceDTO,
  AbsenceImpactDTO,
  CompareDTO,
  DailyScheduleDTO,
  EffectiveScheduleDTO,
  OneDayRoomRecommendationDTO,
  OverrideBulkResultDTO,
  OverrideDTO,
  OverrideResultDTO,
  PublishResultDTO,
  RoomImpactDTO,
  SubstituteRecommendationDTO,
  TimetableOverviewDTO,
  TimetableReportDTO,
  TimetableVersionDTO,
  VersionValidationDTO,
} from '@shared';
import { api } from '@/lib/api';
import { TT, qs } from '../api';

/** Reads and calls for publishing, one-day changes, views and reports (Module 6, Part 6). Every key starts with `timetable`, so a change refreshes them all. */

export const useOverview = (locationId: string | undefined, academicSessionId?: string) =>
  useQuery({ queryKey: [...TT, 'overview', locationId, academicSessionId], queryFn: () => api.get<TimetableOverviewDTO>(`/timetable/overview${qs({ locationId, academicSessionId })}`), enabled: !!locationId });

/** The whole-version check. It is a POST because it is a heavy read; nothing is written. */
export const useValidation = (versionId: string | undefined, rev: number | undefined, enabled = true) =>
  useQuery({ queryKey: [...TT, 'validation', versionId, rev], queryFn: () => api.post<VersionValidationDTO>(`/timetable-versions/${versionId}/validate`, {}), enabled: !!versionId && enabled });

export const useCompare = (versionId: string | undefined, to?: string, enabled = true) =>
  useQuery({ queryKey: [...TT, 'compare', versionId, to], queryFn: () => api.get<CompareDTO>(`/timetable-versions/${versionId}/compare${qs({ to })}`), enabled: !!versionId && enabled });

export const useDaily = (planId: string | undefined, date: string) =>
  useQuery({ queryKey: [...TT, 'daily', planId, date], queryFn: () => api.get<DailyScheduleDTO>(`/daily-schedule${qs({ planId, date })}`), enabled: !!planId && !!date, placeholderData: keepPreviousData });

export const useOverrides = (planId: string | undefined, date: string) =>
  useQuery({ queryKey: [...TT, 'overrides', planId, date], queryFn: () => api.get<OverrideDTO[]>(`/timetable-overrides${qs({ planId, date })}`), enabled: !!planId && !!date });

export const useAbsences = (planId: string | undefined, date: string) =>
  useQuery({ queryKey: [...TT, 'absences', planId, date], queryFn: () => api.get<AbsenceDTO[]>(`/faculty-absence${qs({ planId, date })}`), enabled: !!planId && !!date });

export interface AbsenceInput {
  planId: string;
  employeeId: string;
  dateFrom: string;
  dateTo?: string;
  start?: string;
  end?: string;
}

/** Who is affected by a teacher being away. Nothing is saved. */
export const useImpact = (input: AbsenceInput | null) =>
  useQuery({ queryKey: [...TT, 'impact', input], queryFn: () => api.post<AbsenceImpactDTO>('/faculty-absence/impact', input), enabled: !!input, placeholderData: keepPreviousData });

export const useRoomImpact = (input: { planId: string; physicalSpaceId: string; dateFrom: string; dateTo?: string } | null) =>
  useQuery({ queryKey: [...TT, 'room-impact', input], queryFn: () => api.post<RoomImpactDTO>('/room-changes/impact', input), enabled: !!input, placeholderData: keepPreviousData });

export interface LessonOnDate {
  entryId: string;
  date: string;
}

export const useSubstituteRecommendations = (planId: string | undefined, items: LessonOnDate[]) =>
  useQuery({
    queryKey: [...TT, 'recommend-substitutes', planId, items],
    queryFn: () => api.post<SubstituteRecommendationDTO[]>('/substitutions/recommend', { planId, items }),
    enabled: !!planId && items.length > 0,
    placeholderData: keepPreviousData,
  });

export const useRoomRecommendations = (planId: string | undefined, items: LessonOnDate[], avoidRoomId?: string) =>
  useQuery({
    queryKey: [...TT, 'recommend-rooms', planId, items, avoidRoomId],
    queryFn: () => api.post<OneDayRoomRecommendationDTO[]>('/room-changes/recommend', { planId, items, avoidRoomId }),
    enabled: !!planId && items.length > 0,
    placeholderData: keepPreviousData,
  });

export type ViewKind = 'section' | 'teacher' | 'space' | 'teaching-group';

export const useView = (kind: ViewKind, id: string | undefined, params: { date: string; week: boolean }) =>
  useQuery({ queryKey: [...TT, 'view', kind, id, params], queryFn: () => api.get<EffectiveScheduleDTO>(`/timetable/${kind}/${id}${qs({ date: params.date, week: params.week })}`), enabled: !!id, placeholderData: keepPreviousData });

/** For the signed-in teacher or a parent's child. `target` is `employeeId=me` or `studentId=…`. */
export const useEffective = (target: { employeeId?: string; studentId?: string } | null, range: { from: string; to: string }) =>
  useQuery({
    queryKey: [...TT, 'effective', target, range],
    queryFn: () => api.get<EffectiveScheduleDTO>(`/schedule/effective${qs({ ...target, ...range })}`),
    enabled: !!target && (!!target.employeeId || !!target.studentId),
    placeholderData: keepPreviousData,
  });

export const useReport = (type: string, params: { planId: string | undefined; dateFrom?: string; dateTo?: string; versionId?: string }) =>
  useQuery({ queryKey: [...TT, 'report', type, params], queryFn: () => api.get<TimetableReportDTO>(`/timetable/reports/${type}${qs(params)}`), enabled: !!params.planId });

export const reportPath = (type: string, params: Record<string, string | undefined>) => `/timetable/reports/${type}${qs(params)}`;

// ───────────────────────────────────────────────────────────── calls

export const ops = {
  markReady: (versionId: string) => api.post<TimetableVersionDTO>(`/timetable-versions/${versionId}/mark-ready`, {}),
  publish: (versionId: string, body: { effectiveFrom?: string; acknowledgeWarnings: boolean }) => api.post<PublishResultDTO>(`/timetable-versions/${versionId}/publish`, body),
  clone: (versionId: string) => api.post<TimetableVersionDTO>(`/timetable-versions/${versionId}/clone`, {}),
  discard: (versionId: string) => api.post<TimetableVersionDTO>(`/timetable-versions/${versionId}/discard`, {}),
  recordAbsence: (body: AbsenceInput & { reason?: string }) => api.post<AbsenceDTO>('/faculty-absence', body),
  cancelAbsence: (absenceId: string) => api.post<AbsenceDTO>(`/faculty-absence/${absenceId}/cancel`, {}),
  bulkSubstitutions: (body: { planId: string; items: (LessonOnDate & { substituteEmployeeId: string })[]; reason?: string; requestId?: string }) => api.post<OverrideBulkResultDTO>('/substitutions/bulk', body),
  applyRoomChanges: (body: { planId: string; items: (LessonOnDate & { physicalSpaceId: string })[]; reason?: string; requestId?: string }) => api.post<OverrideBulkResultDTO>('/room-changes/apply', body),
  cancelLessons: (body: { planId: string; date: string; reason: string; entryIds?: string[]; sectionIds?: string[]; requestId?: string }) => api.post<OverrideBulkResultDTO>('/timetable-overrides/bulk-cancel', body),
  createOverride: (body: Record<string, unknown>) => api.post<OverrideResultDTO>('/timetable-overrides', body),
  cancelOverride: (overrideId: string, reason?: string) => api.post<OverrideDTO>(`/timetable-overrides/${overrideId}/cancel`, { reason }),
};
