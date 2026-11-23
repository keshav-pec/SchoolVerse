/**
 * Module 6 (Timetable & Scheduling), Part 1 contract: constants, helpers and DTOs for the plan, Daily Periods, Subject Needs, teacher
 * availability, Teaching Groups and the readiness check. The timetable stores ids only; names, rooms and teachers are looked up each time.
 */
import type { SuitabilityTagCode } from './spaces';

// ───────────────────────────────────────────────────────────── time

export const WEEKDAYS = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const WEEKDAY_LABELS: Record<Weekday, string> = { MON: 'Monday', TUE: 'Tuesday', WED: 'Wednesday', THU: 'Thursday', FRI: 'Friday', SAT: 'Saturday', SUN: 'Sunday' };
export const DEFAULT_OPERATING_DAYS: Weekday[] = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export const MINUTES_PER_DAY = 1440;

/** "08:30" → 510. "24:00" is allowed as the end of the day. Returns null for anything else. */
export function clockToMinutes(clock: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(clock.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) return null;
  return hours * 60 + minutes;
}

/** 510 → "08:30". */
export function minutesToClock(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// ───────────────────────────────────────────────────────────── plan

export const PLAN_STATUSES = ['DRAFT', 'ACTIVE', 'ARCHIVED'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const CAPACITY_POLICIES = ['WARN', 'BLOCK'] as const;
export type CapacityPolicy = (typeof CAPACITY_POLICIES)[number];
export const DEFAULT_TRANSITION_MINUTES = 30;

// ───────────────────────────────────────────────────────────── Daily Periods

export const BELL_KINDS = ['REGULAR', 'JUNIOR', 'SATURDAY', 'EXAM_DAY', 'OTHER'] as const;
export type BellKind = (typeof BELL_KINDS)[number];
export const BELL_KIND_LABELS: Record<BellKind, string> = { REGULAR: 'Regular', JUNIOR: 'Junior', SATURDAY: 'Saturday', EXAM_DAY: 'Exam day', OTHER: 'Other' };

export const PERIOD_TYPES = ['TEACHING', 'HOMEROOM', 'ACTIVITY', 'ASSEMBLY', 'BREAK', 'LUNCH', 'NON_INSTRUCTIONAL'] as const;
export type PeriodType = (typeof PERIOD_TYPES)[number];
/** Only these can hold a lesson. Breaks, lunch and assembly never can. */
export const SCHEDULABLE_PERIOD_TYPES: readonly PeriodType[] = ['TEACHING', 'HOMEROOM', 'ACTIVITY'];
export const PERIOD_TYPE_LABELS: Record<PeriodType, string> = { TEACHING: 'Teaching', HOMEROOM: 'Homeroom', ACTIVITY: 'Activity', ASSEMBLY: 'Assembly', BREAK: 'Break', LUNCH: 'Lunch', NON_INSTRUCTIONAL: 'Not a lesson' };

export const BELL_SCOPES = ['CLASS', 'SECTION', 'DEFAULT'] as const;
export type BellScope = (typeof BELL_SCOPES)[number];
export type BellSource = BellScope;

/** The breaks the generator may place between periods. */
export const GENERATED_BLOCK_TYPES = ['BREAK', 'LUNCH', 'ASSEMBLY', 'NON_INSTRUCTIONAL'] as const;
export type GeneratedBlockType = (typeof GENERATED_BLOCK_TYPES)[number];

// ───────────────────────────────────────────────────────────── Subject Needs

export const REQUIREMENT_SCOPES = ['CLASS', 'SECTION', 'GROUP'] as const;
export type RequirementScope = (typeof REQUIREMENT_SCOPES)[number];
export type RequirementSource = RequirementScope | 'NONE';
export const DOUBLE_MODES = ['NONE', 'PREFERRED', 'REQUIRED'] as const;
export type DoubleMode = (typeof DOUBLE_MODES)[number];
export const PREFERRED_BANDS = ['ANY', 'MORNING', 'AFTERNOON', 'AVOID_LAST'] as const;
export type PreferredBand = (typeof PREFERRED_BANDS)[number];
export const DEFAULT_MAX_PER_DAY = 2;
export const MAX_PERIODS_PER_WEEK = 60;

// ───────────────────────────────────────────────────────────── availability, workload and groups

export const AVAILABILITY_KINDS = ['UNAVAILABLE', 'PREFERRED', 'NOT_PREFERRED'] as const;
export type AvailabilityKind = (typeof AVAILABILITY_KINDS)[number];
export const AVAILABILITY_KIND_LABELS: Record<AvailabilityKind, string> = { UNAVAILABLE: 'Not available', PREFERRED: 'Prefers', NOT_PREFERRED: 'Prefers not' };

export const TEACHING_GROUP_KINDS = ['SUBJECT', 'LANGUAGE', 'ACTIVITY'] as const;
export type TeachingGroupKind = (typeof TEACHING_GROUP_KINDS)[number];
export const GROUP_MEMBER_SOURCES = ['SUBJECT_CHOICE', 'MANUAL'] as const;
export type GroupMemberSource = (typeof GROUP_MEMBER_SOURCES)[number];

export const WORKLOAD_FIELDS = ['maxPerDay', 'maxConsecutive', 'maxPerWeek', 'preferredFreePerDay'] as const;
export type WorkloadField = (typeof WORKLOAD_FIELDS)[number];

// ───────────────────────────────────────────────────────────── access bundles (job bundles on Staff and Faculty logins)

export const TIMETABLE_BUNDLES = ['SCHEDULING_COORDINATOR', 'SUBSTITUTION_MANAGER', 'FRONT_OFFICE'] as const;
export type TimetableBundle = (typeof TIMETABLE_BUNDLES)[number];
export const TIMETABLE_BUNDLE_LABELS: Record<TimetableBundle, { label: string; help: string }> = {
  SCHEDULING_COORDINATOR: { label: 'Scheduling Coordinator', help: 'Can set up and build the timetable. Cannot publish it or override a clash.' },
  SUBSTITUTION_MANAGER: { label: 'Substitution Manager', help: 'Can arrange substitutes and one-day changes.' },
  FRONT_OFFICE: { label: 'Front Office', help: 'Can look at the timetable and its reports. Cannot change anything.' },
};

// ───────────────────────────────────────────────────────────── DTOs

export interface TimetablePlanDTO {
  planId: string;
  locationId: string;
  locationName: string;
  academicSessionId: string;
  sessionName: string;
  planName: string;
  effectiveFrom: string;
  effectiveTo: string;
  operatingDays: Weekday[];
  defaultBellScheduleId: string | null;
  capacityPolicy: CapacityPolicy;
  transitionMinutes: number;
  defaultMaxPerDay: number | null;
  defaultMaxConsecutive: number | null;
  defaultMaxPerWeek: number | null;
  status: PlanStatus;
  version: number;
}

export interface BellPeriodDTO {
  periodId: string;
  bellScheduleId: string;
  periodCode: string;
  periodName: string;
  startMin: number;
  endMin: number;
  start: string;
  end: string;
  periodType: PeriodType;
  schedulable: boolean;
  displayOrder: number;
  /** How many lessons use this period. Always 0 until the Timetable entries exist (Part 3). */
  usedByEntries: number;
}

export interface BellScheduleDTO {
  bellScheduleId: string;
  planId: string;
  name: string;
  kind: BellKind;
  status: 'ACTIVE' | 'ARCHIVED';
  isDefault: boolean;
  periods: BellPeriodDTO[];
  /** Periods that can hold a lesson. */
  lessonPeriods: number;
  /** Classes and sections that use this template. */
  usedBy: number;
}

export interface GeneratedPeriodDTO {
  periodCode: string;
  periodName: string;
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  periodType: PeriodType;
  schedulable: boolean;
}

export interface BellGeneratePreviewDTO {
  name: string;
  periods: GeneratedPeriodDTO[];
  lessonPeriods: number;
  leftoverMinutes: number;
  message: string | null;
}

export interface BellGenerateResultDTO {
  schedule: BellScheduleDTO;
  /** True when the same template already existed with the same periods (a safe retry). */
  alreadyExisted: boolean;
}

export interface BellAssignmentDTO {
  assignmentId: string;
  planId: string;
  scope: Exclude<BellScope, 'DEFAULT'>;
  classOfferingId: string | null;
  sectionOfferingId: string | null;
  bellScheduleId: string;
  /** Empty means every school day. */
  weekdays: Weekday[];
}

export interface BellAssignmentsDTO {
  defaultBellScheduleId: string | null;
  items: BellAssignmentDTO[];
}

export interface BellBulkResultDTO {
  applied: number;
  defaultSet: boolean;
  items: BellAssignmentDTO[];
}

export interface BellResolutionCellDTO {
  bellScheduleId: string | null;
  bellScheduleName: string | null;
  source: BellSource | null;
}

export interface BellResolutionRowDTO {
  sectionOfferingId: string;
  classOfferingId: string;
  label: string;
  className: string;
  byDay: Partial<Record<Weekday, BellResolutionCellDTO>>;
  missingDays: Weekday[];
}

export interface BellResolutionDTO {
  planId: string;
  operatingDays: Weekday[];
  rows: BellResolutionRowDTO[];
  /** Sections with no Daily Periods on at least one school day. */
  missing: { sectionOfferingId: string; label: string; days: Weekday[] }[];
}

export interface RequirementValuesDTO {
  periodsPerWeek: number;
  minPerWeek: number | null;
  maxPerWeek: number | null;
  maxPerDay: number;
  doubleMode: DoubleMode;
  doublesPerWeek: number;
  preferredBand: PreferredBand;
  neededSuitability: SuitabilityTagCode[];
  priority: number;
}

export interface EffectiveRequirementDTO {
  subjectOfferingId: string;
  subjectName: string;
  subjectCode: string;
  /** The row that is in force: the section row if there is one, else the class row. `NONE` means nobody has set it yet. */
  source: RequirementSource;
  requirementId: string | null;
  version: number | null;
  /** True when no one has set the periods yet. */
  configured: boolean;
  effective: RequirementValuesDTO;
  /** The class value, for the "Different" tag and the Reset link. Null when the class has none. */
  classDefault: RequirementValuesDTO | null;
}

export interface WeekTotalDTO {
  /** Periods the subjects ask for in a week. */
  needed: number;
  /** Periods a week can hold on the Daily Periods that apply. Null when no Daily Periods apply yet. */
  available: number | null;
  ok: boolean;
  message: string;
}

export interface RequirementListDTO {
  planId: string;
  classOfferingId: string;
  sectionOfferingId: string | null;
  items: EffectiveRequirementDTO[];
  total: WeekTotalDTO;
  /** Sections that have their own values for at least one subject. */
  sectionsWithOverrides: number;
}

export interface RequirementSaveResultDTO {
  saved: number;
  unchanged: number;
  total: WeekTotalDTO;
}

export interface RequirementCopyResultDTO {
  copied: number;
  alreadySame: number;
  message: string;
}

export interface AvailabilityRowDTO {
  availabilityId: string;
  weekday: Weekday;
  startMin: number;
  endMin: number;
  start: string;
  end: string;
  kind: AvailabilityKind;
}

export interface FacultyAvailabilityDTO {
  planId: string;
  employeeId: string;
  fullName: string;
  /** Only the exceptions are stored. Anything not listed is available. */
  rows: AvailabilityRowDTO[];
}

export interface AvailabilityBulkResultDTO {
  teachers: number;
  rowsPerTeacher: number;
}

export interface WorkloadValuesDTO {
  maxPerDay: number | null;
  maxConsecutive: number | null;
  maxPerWeek: number | null;
  preferredFreePerDay: number | null;
}

export interface TeacherWorkloadDTO {
  employeeId: string;
  fullName: string;
  /** What this teacher has set. Null fields use the school default. */
  own: WorkloadValuesDTO;
  effective: WorkloadValuesDTO;
  usingDefault: Record<WorkloadField, boolean>;
}

export interface WorkloadRulesDTO {
  planId: string;
  planDefault: Omit<WorkloadValuesDTO, 'preferredFreePerDay'> & { preferredFreePerDay: null };
  teachers: TeacherWorkloadDTO[];
}

export interface PlanTeacherDTO {
  employeeId: string;
  fullName: string;
  employeeCode: string;
  hasAvailabilityRows: boolean;
  hasOwnWorkload: boolean;
}

export type GroupTeacherStatus = 'OK' | 'MISSING' | 'PICK_ONE';

export interface GroupTeacherDTO {
  status: GroupTeacherStatus;
  /** `ASSIGNMENT` comes from Assign Classes, `CHOSEN` was picked on the group. */
  source: 'ASSIGNMENT' | 'CHOSEN' | null;
  employeeIds: string[];
  names: string[];
  /** Everyone Assign Classes offers when the answer is not clear. */
  candidates: { employeeId: string; fullName: string }[];
}

export interface TeachingGroupDTO {
  groupId: string;
  planId: string;
  name: string;
  kind: TeachingGroupKind;
  classOfferingId: string | null;
  className: string | null;
  subjectOfferingId: string | null;
  subjectName: string | null;
  sectionPool: { sectionOfferingId: string; label: string }[];
  teacher: GroupTeacherDTO;
  memberCount: number;
  manualCount: number;
  /** Short words for the badge, e.g. "4 students not in any group". Null when healthy. */
  healthBadge: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}

export interface GroupMemberDTO {
  studentId: string;
  fullName: string;
  admissionNumber: string | null;
  sectionLabel: string | null;
  source: GroupMemberSource;
}

export interface GroupMemberListDTO {
  items: GroupMemberDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface GroupHealthStudentDTO {
  studentId: string;
  fullName: string;
  admissionNumber: string | null;
  sectionLabel: string | null;
}

export interface GroupHealthDTO {
  groupId: string;
  /** Chose the subject but are in no group for it. */
  notInAnyGroup: GroupHealthStudentDTO[];
  /** Added by hand but no longer in one of the group's sections. */
  leftSection: GroupHealthStudentDTO[];
  /** In this group and another group for the same subject. */
  inTwoGroups: GroupHealthStudentDTO[];
  healthy: boolean;
}

// ───────────────────────────────────────────────────────────── readiness

export const READINESS_AREAS = ['CLASSES_SUBJECTS', 'TEACHERS', 'ROOMS', 'TIME'] as const;
export type ReadinessArea = (typeof READINESS_AREAS)[number];
export const READINESS_AREA_LABELS: Record<ReadinessArea, string> = { CLASSES_SUBJECTS: 'Classes & Subjects', TEACHERS: 'Teachers', ROOMS: 'Rooms', TIME: 'Time' };

export const READINESS_FIX_ACTIONS = ['CREATE_PLAN', 'OPEN_GROUPS', 'SET_SCHOOL_WEEK', 'SET_DAILY_PERIODS', 'ASSIGN_DAILY_PERIODS', 'SET_SUBJECT_NEEDS', 'ASSIGN_CLASSES', 'CLASSROOM_ALLOCATION', 'SPACE_SETUP', 'ACADEMIC_SETUP'] as const;
export type ReadinessFixAction = (typeof READINESS_FIX_ACTIONS)[number];

export interface ReadinessFixDTO {
  action: ReadinessFixAction;
  /** Button text in Title Case, e.g. "Go To Assign Classes". */
  label: string;
  /** An app route the button opens. */
  path: string;
}

export interface TimetableReadinessItemDTO {
  /** Stable, e.g. `NO_SUBJECT_NEEDS:<classOfferingId>`. */
  key: string;
  code: string;
  severity: 'BLOCKER' | 'WARNING';
  message: string;
  count: number;
  /** A few names to show under the message (subjects, sections, teachers). */
  examples: string[];
  fix: ReadinessFixDTO;
}

export interface TimetableReadinessAreaDTO {
  area: ReadinessArea;
  label: string;
  status: 'READY' | 'NEEDS_ACTION';
  summary: string;
  items: TimetableReadinessItemDTO[];
}

export interface TimetableReadinessDTO {
  planId: string;
  ready: boolean;
  needsActions: number;
  /** "Timetable setup needs 5 actions" or "Ready to build". */
  message: string;
  areas: TimetableReadinessAreaDTO[];
  /** Smart Draft needs the Time area ready and some Subject Needs. Missing teachers or rooms only leave lessons unplaced. */
  canSmartDraft: boolean;
  smartDraftBlockedBy: string[];
  counts: { sections: number; subjects: number; teachers: number; homeClassrooms: number; specialRooms: number };
}

export interface TimetableAccessGrantDTO {
  userId: string;
  fullName: string;
  email: string;
  role: string;
  bundles: TimetableBundle[];
  locationIds: string[] | null;
}

export const TIMETABLE_EVENT_TYPES = ['timetable.plan.created', 'timetable.plan.updated', 'timetable.plan.archived'] as const;
export type TimetableEventType = (typeof TIMETABLE_EVENT_TYPES)[number];
