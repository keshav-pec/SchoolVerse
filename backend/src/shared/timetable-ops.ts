/**
 * Module 6, Part 5 contract: validating, publishing and revising a timetable, one-day changes (absence, substitutes, room changes,
 * cancellations, swaps), the effective schedule, views, reports and the overview. Names are looked up each time; only ids are stored.
 */
import type { SuitabilityTagCode } from './spaces';
import type { Weekday } from './timetable';
import type { RuleCode, TimetableIssueDTO, TimetableVersionDTO } from './timetable-schedule';

// ───────────────────────────────────────────────────────────── versions

/** What a version is right now. Published versions get their phase from dates, so no nightly job is needed. */
export const VERSION_PHASES = ['DRAFT', 'READY', 'UPCOMING', 'ACTIVE', 'SUPERSEDED', 'DISCARDED'] as const;
export type VersionPhase = (typeof VERSION_PHASES)[number];
export const VERSION_PHASE_LABELS: Record<VersionPhase, string> = { DRAFT: 'Draft', READY: 'Ready for review', UPCOMING: 'Published, starts later', ACTIVE: 'Published', SUPERSEDED: 'Superseded', DISCARDED: 'Discarded' };

/** Where to open the lesson in the Schedule: its section, or its Teaching Group. */
export interface ValidationPlaceDTO {
  sectionOfferingId: string | null;
  teachingGroupId: string | null;
}

export interface ValidationClashDTO extends ValidationPlaceDTO {
  entryId: string;
  label: string;
  issues: TimetableIssueDTO[];
}

export interface ValidationWarningDTO extends ValidationPlaceDTO {
  entryId: string;
  label: string;
  message: string;
  when: string | null;
  rule: RuleCode;
}

export interface ValidationWarningGroupDTO {
  rule: RuleCode;
  label: string;
  count: number;
  /** The first few. */
  items: ValidationWarningDTO[];
}

export interface ValidationSectionDTO {
  sectionOfferingId: string;
  label: string;
  needed: number;
  placed: number;
  left: number;
  over: number;
  /** Nothing at all is placed. */
  empty: boolean;
}

export interface VersionValidationDTO {
  versionId: string;
  rev: number;
  entryCount: number;
  clashCount: number;
  clashes: ValidationClashDTO[];
  warningCount: number;
  warnings: ValidationWarningGroupDTO[];
  sections: ValidationSectionDTO[];
  sectionsTotal: number;
  sectionsComplete: number;
  emptySections: string[];
  /** Periods the plan asks for that are not placed. */
  unplacedCount: number;
  canPublish: boolean;
  /** Publishing needs a tick because there are warnings or unplaced periods. */
  needsAcknowledge: boolean;
  /** "All 36 sections complete. 0 clashes. 6 warnings." */
  summary: string;
}

export interface PublishResultDTO {
  version: TimetableVersionDTO;
  warningCount: number;
  unplacedCount: number;
  supersededVersionId: string | null;
  /** The day the earlier timetable stops. */
  previousRunsUntil: string | null;
  /** One-day changes on the earlier timetable that moved to the new one, and ones that could not. */
  movedOverrides: number;
  cancelledOverrides: number;
  message: string;
}

export const COMPARE_KINDS = ['ADDED', 'REMOVED', 'MOVED', 'CHANGED'] as const;
export type CompareKind = (typeof COMPARE_KINDS)[number];

export interface CompareChangeDTO {
  kind: CompareKind;
  label: string;
  was: string | null;
  now: string | null;
  entryId: string | null;
}

export interface CompareDTO {
  versionId: string;
  versionName: string;
  toVersionId: string | null;
  toVersionName: string | null;
  added: number;
  removed: number;
  moved: number;
  changed: number;
  unchanged: number;
  changes: CompareChangeDTO[];
  summary: string;
}

// ───────────────────────────────────────────────────────────── one-day changes

export const OVERRIDE_TYPES = ['SUBSTITUTE_FACULTY', 'ROOM_CHANGE', 'CLASS_CANCELLED', 'PERIOD_SWAP', 'SUBJECT_CHANGE', 'SPECIAL_ACTIVITY', 'COMBINED_CLASS'] as const;
export type OverrideType = (typeof OVERRIDE_TYPES)[number];
export const OVERRIDE_TYPE_LABELS: Record<OverrideType, string> = {
  SUBSTITUTE_FACULTY: 'Substitute teacher',
  ROOM_CHANGE: 'Room change',
  CLASS_CANCELLED: 'Cancelled',
  PERIOD_SWAP: 'Swapped periods',
  SUBJECT_CHANGE: 'Subject change',
  SPECIAL_ACTIVITY: 'Special activity',
  COMBINED_CLASS: 'Combined class',
};
export const OVERRIDE_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export type OverrideStatus = (typeof OVERRIDE_STATUSES)[number];
export const OVERRIDE_ROLES = ['ORIGINAL', 'SUBSTITUTE'] as const;
export type OverrideRole = (typeof OVERRIDE_ROLES)[number];

/** How a lesson looks on one date. `NORMAL` is the weekly timetable as published. */
export const EFFECTIVE_STATES = ['NORMAL', 'SUBSTITUTED', 'ROOM_CHANGED', 'CANCELLED', 'SWAPPED', 'CHANGED'] as const;
export type EffectiveState = (typeof EFFECTIVE_STATES)[number];
export const EFFECTIVE_STATE_LABELS: Record<EffectiveState, string> = { NORMAL: 'As planned', SUBSTITUTED: 'Substitute', ROOM_CHANGED: 'Room changed', CANCELLED: 'Cancelled', SWAPPED: 'Swapped', CHANGED: 'Changed' };

/** The most days one request may cover. */
export const MAX_RANGE_DAYS = 31;

export interface OverrideTeacherDTO {
  employeeId: string;
  fullName: string;
}

export interface OverrideDTO {
  overrideId: string;
  planId: string;
  versionId: string;
  entryId: string;
  date: string;
  weekday: Weekday;
  type: OverrideType;
  status: OverrideStatus;
  reason: string | null;
  /** "8-A Mathematics". */
  label: string;
  /** "Period 3, 09:30-10:15". */
  when: string;
  original: OverrideTeacherDTO[];
  substitutes: OverrideTeacherDTO[];
  roomName: string | null;
  subjectName: string | null;
  activityName: string | null;
  otherEntryId: string | null;
  otherLabel: string | null;
  /** One-line summary for lists: "Mr. Rao covers for Ms. Gupta". */
  summary: string;
  /** Clashes someone accepted, with their reasons. */
  acknowledged: { rule: RuleCode; reason: string }[];
  createdBy: string;
  createdAt: string;
  cancelledAt: string | null;
}

export interface OverrideResultDTO {
  override: OverrideDTO;
  /** Warnings that came with it (a heavy day for the substitute, a small room…). A clash would have refused it. */
  issues: TimetableIssueDTO[];
}

export interface OverrideFailureDTO {
  entryId: string;
  date: string;
  label: string;
  message: string;
}

export interface OverrideBulkResultDTO {
  requested: number;
  done: number;
  failed: OverrideFailureDTO[];
  overrides: OverrideDTO[];
  message: string;
}

// ───────────────────────────────────────────────────────────── absence and substitutes

export interface AbsenceDTO {
  absenceId: string;
  employeeId: string;
  employeeName: string;
  dateFrom: string;
  dateTo: string;
  /** Set when only some periods are affected. */
  startMin: number | null;
  endMin: number | null;
  kind: 'ABSENT' | 'UNAVAILABLE';
  reason: string | null;
  status: 'ACTIVE' | 'CANCELLED';
  /** Lessons the absence touches, and how many of them nobody covers yet. */
  affected: number;
  uncovered: number;
}

export interface AffectedLessonDTO {
  entryId: string;
  date: string;
  weekday: Weekday;
  label: string;
  periodName: string;
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  sections: string[];
  subjectName: string | null;
  roomName: string | null;
  state: EffectiveState;
  /** Someone already covers it, or it is cancelled. */
  covered: boolean;
  coveredBy: string | null;
}

export interface AbsenceImpactDTO {
  employeeId: string;
  employeeName: string;
  items: AffectedLessonDTO[];
  uncovered: number;
  summary: string;
}

export interface SubstituteChoiceDTO {
  employeeId: string;
  fullName: string;
  /** How well they match: teaches this subject, teaches this class, teaches this section, or neither. */
  match: 'SUBJECT' | 'CLASS' | 'SECTION' | 'OTHER';
  periodsThatDay: number;
  coversThisMonth: number;
  /** "Teaches Mathematics · free · 2 periods today". */
  why: string;
  warnings: string[];
}

export interface SubstituteRecommendationDTO {
  entryId: string;
  date: string;
  label: string;
  when: string;
  recommended: SubstituteChoiceDTO | null;
  alternatives: SubstituteChoiceDTO[];
  /** When nobody is free: why, in words. */
  message: string | null;
}

export interface OneDayRoomChoiceDTO {
  physicalSpaceId: string;
  name: string;
  capacity: number | null;
  tags: SuitabilityTagCode[];
  why: string;
  warnings: string[];
}

export interface RoomImpactItemDTO extends AffectedLessonDTO {
  currentRoomId: string | null;
  currentRoomName: string | null;
}

export interface RoomImpactDTO {
  physicalSpaceId: string;
  roomName: string;
  items: RoomImpactItemDTO[];
  summary: string;
}

export interface OneDayRoomRecommendationDTO {
  entryId: string;
  date: string;
  label: string;
  when: string;
  currentRoomName: string | null;
  recommended: OneDayRoomChoiceDTO | null;
  alternatives: OneDayRoomChoiceDTO[];
  message: string | null;
}

// ───────────────────────────────────────────────────────────── the effective schedule

export interface EffectiveSectionDTO {
  sectionOfferingId: string;
  label: string;
}

export interface EffectiveTeacherDTO {
  employeeId: string;
  fullName: string;
  role: 'MAIN' | 'CO_TEACHER';
}

/** What the weekly timetable said, beside what happens today. */
export interface EffectiveOriginalDTO {
  teachers: EffectiveTeacherDTO[];
  roomName: string | null;
  subjectName: string | null;
  activityName: string | null;
  periodName: string;
  start: string;
  end: string;
}

export interface EffectiveItemDTO {
  date: string;
  weekday: Weekday;
  entryId: string;
  versionId: string;
  periodId: string;
  periodCode: string;
  periodName: string;
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  state: EffectiveState;
  entryType: string;
  subjectOfferingId: string | null;
  subjectName: string | null;
  activityName: string | null;
  teachingGroupId: string | null;
  groupName: string | null;
  sections: EffectiveSectionDTO[];
  teachers: EffectiveTeacherDTO[];
  physicalSpaceId: string | null;
  roomName: string | null;
  original: EffectiveOriginalDTO | null;
  overrideId: string | null;
  overrideType: OverrideType | null;
  reason: string | null;
  /** The teacher is away and nobody covers the lesson. */
  uncovered: boolean;
  /** A short sentence for people: "Maths today is taken by Mr. Rao". */
  note: string | null;
}

export interface FreeSlotDTO {
  periodId: string;
  periodName: string;
  start: string;
  end: string;
  startMin: number;
  endMin: number;
}

export interface EffectiveDayDTO {
  date: string;
  weekday: Weekday;
  isSchoolDay: boolean;
  versionId: string | null;
  versionName: string | null;
  items: EffectiveItemDTO[];
  /** Free periods, for a teacher or a room. */
  free: FreeSlotDTO[];
}

export const SCHEDULE_TARGETS = ['section', 'employee', 'space', 'student', 'group'] as const;
export type ScheduleTarget = (typeof SCHEDULE_TARGETS)[number];

export interface EffectiveScheduleDTO {
  from: string;
  to: string;
  target: { kind: ScheduleTarget; id: string; label: string };
  planId: string | null;
  days: EffectiveDayDTO[];
}

// ───────────────────────────────────────────────────────────── Daily Operations

export interface DailyExceptionDTO {
  kind: 'ABSENT' | 'ROOM' | 'CANCELLED';
  title: string;
  message: string;
  affected: number;
  uncovered: number;
  employeeId: string | null;
  physicalSpaceId: string | null;
}

export interface DailySummaryDTO {
  lessons: number;
  uncovered: number;
  substituted: number;
  roomChanged: number;
  cancelled: number;
  swapped: number;
  changed: number;
}

export interface DailyScheduleDTO {
  date: string;
  weekday: Weekday;
  planId: string;
  locationId: string;
  isSchoolDay: boolean;
  versionId: string | null;
  versionName: string | null;
  /** Why there is nothing to show, when there is nothing. */
  message: string | null;
  summary: DailySummaryDTO;
  /** "5 periods have no teacher". */
  line: string;
  exceptions: DailyExceptionDTO[];
  uncovered: EffectiveItemDTO[];
  lessons: EffectiveItemDTO[];
}

// ───────────────────────────────────────────────────────────── reports and overview

export const REPORT_TYPES = ['section-coverage', 'subject-coverage', 'teacher-workload', 'room-utilization', 'unplaced-requirements', 'conflict-overrides', 'substitution-history'] as const;
export type ReportType = (typeof REPORT_TYPES)[number];
export const REPORT_TITLES: Record<ReportType, string> = {
  'section-coverage': 'Section coverage',
  'subject-coverage': 'Subject coverage',
  'teacher-workload': 'Teacher workload',
  'room-utilization': 'Room use',
  'unplaced-requirements': 'Periods not placed',
  'conflict-overrides': 'Accepted clashes',
  'substitution-history': 'Substitutions',
};

export interface ReportColumnDTO {
  key: string;
  label: string;
  align?: 'left' | 'right';
}

export interface TimetableReportDTO {
  type: ReportType;
  title: string;
  planId: string;
  versionId: string | null;
  versionName: string | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  dateFrom: string | null;
  dateTo: string | null;
  /** "Version 2 · published · from 1 Jul". Every report says what it is based on. */
  basis: string;
  columns: ReportColumnDTO[];
  rows: Record<string, string | number | null>[];
  message: string | null;
}

export interface TimetableOverviewDTO {
  planId: string | null;
  locationId: string;
  planStatus: string | null;
  /** The version the numbers describe: the open draft while there is one, else the running published one. */
  versionId: string | null;
  versionName: string | null;
  phase: VersionPhase | null;
  /** "Version 2 · Published · from 1 Jul". */
  statusLine: string;
  publishedVersionId: string | null;
  draftVersionId: string | null;
  coveragePercent: number | null;
  needed: number;
  placed: number;
  clashes: number;
  warnings: number;
  today: { date: string; uncovered: number; absentTeachers: number; cancelled: number; substituted: number } | null;
  /** Which main button to show. */
  next: 'SETUP' | 'OPEN_SCHEDULE' | 'REVIEW_AND_PUBLISH' | 'OPEN_DAILY_OPERATIONS';
  ux: {
    inheritedPercent: number | null;
    autoTeacherPercent: number | null;
    defaultRoomPercent: number | null;
    smartDraftCompletionPercent: number | null;
    manualPercent: number | null;
    unresolved: number;
    lastYearReusePercent: number | null;
    fixesApplied: number;
  };
}

// ───────────────────────────────────────────────────────────── events

export const OPS_EVENT_TYPES = ['timetable.published', 'timetable.version.superseded', 'timetable.substitution.created', 'timetable.room.changed', 'timetable.class.cancelled', 'timetable.override.created', 'timetable.override.cancelled', 'timetable.absence.recorded'] as const;
export type OpsEventType = (typeof OPS_EVENT_TYPES)[number];
