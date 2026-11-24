/**
 * Module 6, Part 3 contract: versions, lessons (entries), the clash rules, safe editing, recommendations, last year's copy, Smart Draft and
 * Needs Attention. The timetable stores ids only. Names, rooms and teachers in these DTOs are looked up each time.
 */
import type { SuitabilityTagCode } from './spaces';
import type { Weekday } from './timetable';

// ───────────────────────────────────────────────────────────── versions

export const VERSION_STATUSES = ['DRAFT', 'READY', 'PUBLISHED', 'DISCARDED'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
/** A version can be edited only while it is open. */
export const OPEN_VERSION_STATUSES: readonly VersionStatus[] = ['DRAFT', 'READY'];

// ───────────────────────────────────────────────────────────── lessons

export const ENTRY_TYPES = ['SUBJECT', 'HOMEROOM', 'ACTIVITY', 'ASSEMBLY', 'LIBRARY', 'SPORTS', 'CLUB', 'OTHER'] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];
export const ENTRY_TYPE_LABELS: Record<EntryType, string> = { SUBJECT: 'Subject', HOMEROOM: 'Homeroom', ACTIVITY: 'Activity', ASSEMBLY: 'Assembly', LIBRARY: 'Library', SPORTS: 'Sports', CLUB: 'Club', OTHER: 'Other' };

export const ENTRY_SOURCES = ['MANUAL', 'SMART_DRAFT', 'PREVIOUS_SESSION_COPY', 'BULK', 'FIX_SUGGESTION'] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

export const FACULTY_ROLES = ['MAIN', 'CO_TEACHER'] as const;
export type FacultyRole = (typeof FACULTY_ROLES)[number];

// ───────────────────────────────────────────────────────────── the rules

export const RULE_CODES = [
  'TEACHER_BUSY',
  'SECTION_BUSY',
  'ROOM_BUSY',
  'STUDENT_BUSY',
  'TEACHER_UNAVAILABLE',
  'ROOM_UNAVAILABLE',
  'NOT_THIS_TEACHER',
  'SUBJECT_NOT_OFFERED',
  'WRONG_CAMPUS',
  'ROOM_NOT_SUITABLE',
  'PERIOD_NOT_TEACHING',
  'BELL_MISMATCH',
  'ROOM_TOO_SMALL',
  'WEEK_COUNT',
  'MAX_PER_DAY',
  'DOUBLE_PERIOD',
  'TEACHER_LOAD',
  'TEACHER_NOT_PREFERRED',
  'BAND_NOT_PREFERRED',
  'TRAVEL_TIME',
  'NOT_HOME_ROOM',
] as const;
export type RuleCode = (typeof RULE_CODES)[number];

/** Only these can be overridden, by someone with `timetable:conflict:override`, with a reason. Double-booking never can. */
export const OVERRIDABLE_RULES: readonly RuleCode[] = ['TEACHER_UNAVAILABLE', 'ROOM_NOT_SUITABLE', 'ROOM_TOO_SMALL'];

export const ISSUE_SEVERITIES = ['CLASH', 'WARNING', 'INFO'] as const;
export type IssueSeverity = (typeof ISSUE_SEVERITIES)[number];

export const RULE_LABELS: Record<RuleCode, string> = {
  TEACHER_BUSY: 'Teacher is busy',
  SECTION_BUSY: 'Section is busy',
  ROOM_BUSY: 'Room is busy',
  STUDENT_BUSY: 'Students are busy',
  TEACHER_UNAVAILABLE: 'Teacher is not available',
  ROOM_UNAVAILABLE: 'Room is not available',
  NOT_THIS_TEACHER: 'Not this teacher',
  SUBJECT_NOT_OFFERED: 'Subject not offered',
  WRONG_CAMPUS: 'Another campus',
  ROOM_NOT_SUITABLE: 'Room is not suitable',
  PERIOD_NOT_TEACHING: 'Not a lesson period',
  BELL_MISMATCH: 'Different Daily Periods',
  ROOM_TOO_SMALL: 'Room is too small',
  WEEK_COUNT: 'Too many periods in the week',
  MAX_PER_DAY: 'Too often in a day',
  DOUBLE_PERIOD: 'Double period is split',
  TEACHER_LOAD: 'Heavy day for the teacher',
  TEACHER_NOT_PREFERRED: 'Teacher prefers not',
  BAND_NOT_PREFERRED: 'Not the preferred time of day',
  TRAVEL_TIME: 'Travel time between campuses',
  NOT_HOME_ROOM: 'Not in the Home Classroom',
};

export interface IssueFixDTO {
  action: 'MOVE_ENTRY' | 'PICK_TEACHER' | 'PICK_ROOM' | 'PLACE_SLOT' | 'APPLY_FIX' | 'ASSIGN_CLASSES' | 'SPACE_SETUP' | 'CLASSROOM_ALLOCATION';
  label: string;
}

export interface TimetableIssueDTO {
  rule: RuleCode;
  severity: IssueSeverity;
  message: string;
  /** Names of the people, rooms and sections the message is about. */
  who: string[];
  /** "Monday, Period 3". */
  when: string | null;
  overridable: boolean;
  /** Set when a person with permission overrode this clash. */
  overriddenReason: string | null;
  entryId: string | null;
  /** The lessons that cause this issue (the ones already in the way). */
  blockedBy: string[];
  fix: IssueFixDTO | null;
}

// ───────────────────────────────────────────────────────────── lesson DTOs

export interface EntrySectionDTO {
  sectionOfferingId: string;
  label: string;
}

export interface EntryTeacherDTO {
  employeeId: string;
  fullName: string;
  role: FacultyRole;
}

export interface TimetableEntryDTO {
  entryId: string;
  versionId: string;
  weekday: Weekday;
  periodId: string;
  periodCode: string;
  periodName: string;
  startMin: number;
  endMin: number;
  start: string;
  end: string;
  entryType: EntryType;
  subjectOfferingId: string | null;
  subjectName: string | null;
  activityName: string | null;
  teachingGroupId: string | null;
  groupName: string | null;
  physicalSpaceId: string | null;
  roomName: string | null;
  sections: EntrySectionDTO[];
  teachers: EntryTeacherDTO[];
  isFixed: boolean;
  source: EntrySource;
  notes: string | null;
  /** Goes up on every change. Send it back as `expectedVersion` so a stale screen is caught. */
  version: number;
  rev: number;
  issues: { clash: number; warning: number; info: number };
}

export interface AlternativeDTO {
  kind: 'SLOT' | 'ROOM' | 'TEACHER';
  label: string;
  weekday: Weekday | null;
  periodId: string | null;
  physicalSpaceId: string | null;
  employeeId: string | null;
}

export interface CheckResultDTO {
  ok: boolean;
  blockers: TimetableIssueDTO[];
  warnings: TimetableIssueDTO[];
  info: TimetableIssueDTO[];
  alternatives: AlternativeDTO[];
  perOp: { index: number; entryId: string | null; blockers: number; warnings: number; info: number }[];
  /** "9 of 10 can move. 1 clashes: …" for a set of steps. */
  summary: string;
}

export interface WriteResultDTO {
  rev: number;
  changeSetId: string;
  label: string;
  issues: TimetableIssueDTO[];
  entries: TimetableEntryDTO[];
  deletedIds: string[];
  /** True when the request had been saved before and this is the first answer again. */
  repeated: boolean;
}

export interface BulkFailureDTO {
  entryId: string | null;
  label: string;
  message: string;
}

export interface BulkResultDTO {
  op: string;
  mode: 'ALL_OR_NOTHING' | 'APPLY_VALID';
  requested: number;
  done: number;
  failed: BulkFailureDTO[];
  rev: number;
  changeSetId: string | null;
  issues: TimetableIssueDTO[];
  entries: TimetableEntryDTO[];
  deletedIds: string[];
  message: string;
}

export const BULK_OPS = ['MOVE', 'CLEAR', 'MARK_FIXED', 'UNLOCK', 'SET_ROOM', 'DUPLICATE_TO', 'COPY_REQUIREMENTS'] as const;
export type BulkOp = (typeof BULK_OPS)[number];

export const CHANGE_KINDS = ['CREATE', 'UPDATE', 'MOVE', 'SWAP', 'DELETE', 'BULK', 'UNDO', 'SMART_DRAFT', 'PREVIOUS_COPY', 'RUN_ITEM', 'FIX'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export interface ChangeSetDTO {
  changeSetId: string;
  versionId: string;
  rev: number;
  kind: ChangeKind;
  label: string;
  actorId: string;
  createdAt: string;
  entryCount: number;
  undone: boolean;
  canUndo: boolean;
}

export interface VersionChangesDTO {
  rev: number;
  changed: TimetableEntryDTO[];
  deletedIds: string[];
}

// ───────────────────────────────────────────────────────────── versions

export interface TimetableVersionDTO {
  versionId: string;
  planId: string;
  versionNumber: number;
  versionName: string;
  sourceVersionId: string | null;
  status: VersionStatus;
  rev: number;
  entryCount: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  publishedAt: string | null;
  createdAt: string;
}

// ───────────────────────────────────────────────────────────── grid, coverage and workload

export interface GridPeriodDTO {
  periodId: string;
  periodCode: string;
  periodName: string;
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  /** False for breaks and lunch. They are drawn but never hold a lesson. */
  schedulable: boolean;
}

export interface CoverageRowDTO {
  key: string;
  kind: 'SECTION' | 'GROUP';
  sectionOfferingId: string | null;
  sectionLabel: string | null;
  teachingGroupId: string | null;
  groupName: string | null;
  subjectOfferingId: string;
  subjectName: string;
  needed: number;
  placed: number;
  left: number;
  over: number;
}

export interface CoverageDTO {
  needed: number;
  placed: number;
  left: number;
  /** "Needs 6 · Placed 5 · Left 1". */
  line: string;
  rows: CoverageRowDTO[];
}

export interface WorkloadDTO {
  employeeId: string;
  fullName: string;
  perDay: Partial<Record<Weekday, number>>;
  week: number;
  longestRun: number;
  freePeriodsPerDay: Partial<Record<Weekday, number>>;
  gaps: number;
  limits: { maxPerDay: number | null; maxConsecutive: number | null; maxPerWeek: number | null };
}

export interface GridCellDTO extends TimetableEntryDTO {
  issueList: TimetableIssueDTO[];
}

export const GRID_VIEWS = ['section', 'teacher', 'room', 'group'] as const;
export type GridView = (typeof GRID_VIEWS)[number];

export interface GridDTO {
  versionId: string;
  rev: number;
  view: GridView;
  targetId: string;
  label: string;
  status: VersionStatus;
  days: { weekday: Weekday; label: string; periods: GridPeriodDTO[] }[];
  /** Only lessons. A free period is simply a period with no cell. */
  cells: GridCellDTO[];
  coverage: CoverageDTO | null;
  workload: WorkloadDTO | null;
}

export interface HealthItemDTO {
  entryId: string;
  label: string;
  issues: TimetableIssueDTO[];
}

export interface VersionHealthDTO {
  versionId: string;
  rev: number;
  healthy: boolean;
  items: HealthItemDTO[];
}

// ───────────────────────────────────────────────────────────── slots, recommendations, fixes

export type SlotStatus = 'OK' | 'WARNING' | 'BLOCKED';

export interface SlotMapDTO {
  versionId: string;
  rev: number;
  days: { weekday: Weekday; slots: { periodId: string; periodCode: string; status: SlotStatus; reason: string | null }[] }[];
}

export interface SlotOptionDTO {
  weekday: Weekday;
  periodId: string;
  periodCode: string;
  label: string;
  /** Plain reasons this is a good slot. */
  why: string[];
  warnings: string[];
  teacherNames: string[];
  roomName: string | null;
  score: number;
  /** Second period of a double. */
  secondPeriodId: string | null;
}

export interface SlotRecommendationDTO {
  recommended: SlotOptionDTO | null;
  alternatives: SlotOptionDTO[];
  /** When nothing is valid: why, in words. */
  message: string | null;
}

export interface ChoiceDTO {
  id: string;
  name: string;
  ok: boolean;
  reason: string | null;
  recommended: boolean;
  detail: string | null;
}

export interface RoomPickDTO {
  recommended: ChoiceDTO | null;
  choices: ChoiceDTO[];
}

export interface FixSuggestionDTO {
  label: string;
  why: string;
  /** Send it back to `POST /timetable-changes/apply`. It is checked again when applied. */
  suggestionToken: string;
  /** Already checked: applying it will not clash. */
  safe: boolean;
}

export interface FixRecommendationsDTO {
  entryId: string;
  rule: RuleCode;
  suggestions: FixSuggestionDTO[];
  message: string | null;
}

export interface ExplainUnplacedDTO {
  needed: number;
  placed: number;
  left: number;
  slots: number;
  /** "No free slot where … are all free. Of 36 slots: 14 blocked by …" */
  message: string;
  blockedBy: { kind: 'TEACHER' | 'ROOM' | 'SECTION' | 'STUDENT' | 'OTHER'; name: string; slots: number }[];
  needTwo: number;
  bestFix: { label: string; action: IssueFixDTO['action']; entryId: string | null } | null;
  reasonCode: UnplacedReason;
}

export const UNPLACED_REASONS = ['NO_TEACHER', 'PICK_TEACHER', 'NO_SLOT', 'NO_ROOM_KIND', 'NO_PERIODS', 'TIME_UP'] as const;
export type UnplacedReason = (typeof UNPLACED_REASONS)[number];

// ───────────────────────────────────────────────────────────── Smart Draft and last year's copy

export const GENERATION_RUN_TYPES = ['SMART_DRAFT', 'PREVIOUS_COPY'] as const;
export type GenerationRunType = (typeof GENERATION_RUN_TYPES)[number];
export const RUN_STATUSES = ['DONE', 'PARTIAL', 'FAILED'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const SMART_DRAFT_MODES = ['FILL_GAPS', 'START_FRESH'] as const;
export type SmartDraftMode = (typeof SMART_DRAFT_MODES)[number];

export interface UnresolvedDTO {
  key: string;
  label: string;
  remaining: number;
  reason: UnplacedReason;
  message: string;
}

export interface GenerationRunDTO {
  runId: string;
  versionId: string;
  runType: GenerationRunType;
  mode: string;
  status: RunStatus;
  startedAt: string;
  completedAt: string | null;
  totalRequirements: number;
  totalPeriods: number;
  entriesCreated: number;
  unresolvedCount: number;
  warningCount: number;
  /** "1,642 of 1,728 placed · 86 left · 0 clashes · 14 warnings". */
  summary: string;
  unresolved: UnresolvedDTO[];
  rev: number | null;
  changeSetId: string | null;
}

export const RUN_ITEM_REASONS = ['TEACHER_CHANGED', 'ROOM_PROBLEM', 'SUBJECT_CHANGED', 'SECTION_NOT_FOUND', 'PERIOD_NOT_FOUND', 'STILL_CLASHES'] as const;
export type RunItemReason = (typeof RUN_ITEM_REASONS)[number];
export const RUN_ITEM_STATUSES = ['OPEN', 'ACCEPTED', 'DISMISSED'] as const;
export type RunItemStatus = (typeof RUN_ITEM_STATUSES)[number];
export const RUN_ITEM_REASON_LABELS: Record<RunItemReason, string> = {
  TEACHER_CHANGED: 'The teacher changed',
  ROOM_PROBLEM: 'The room cannot be used',
  SUBJECT_CHANGED: 'The subject changed',
  SECTION_NOT_FOUND: 'The section is not in this year',
  PERIOD_NOT_FOUND: 'The period does not exist this year',
  STILL_CLASHES: 'It clashes this year',
};

export interface RunItemDTO {
  itemId: string;
  runId: string;
  reason: RunItemReason;
  status: RunItemStatus;
  /** Plain words about last year's lesson, e.g. "8-A Maths, Monday Period 3". */
  label: string;
  message: string;
  suggestion: string | null;
  hasSuggestion: boolean;
}

export interface PreviousSessionDTO {
  available: boolean;
  previousSessionId: string | null;
  previousSessionName: string | null;
  versionId: string | null;
  lessons: number;
  message: string;
  alreadyCopied: boolean;
}

export interface CopyPreviousResultDTO {
  mode: 'PREVIEW' | 'COMMIT';
  total: number;
  copied: number;
  needLook: number;
  byReason: Partial<Record<RunItemReason, number>>;
  needsFilled: number;
  /** "91% carried over. 1,430 lessons copied. 66 need a look." */
  summary: string;
  alreadyCopied: boolean;
  runId: string | null;
  rev: number | null;
}

export interface AcceptGroupResultDTO {
  accepted: number;
  failed: { itemId: string; message: string }[];
}

// ───────────────────────────────────────────────────────────── Needs Attention

export const SCHEDULE_ATTENTION_GROUPS = ['NOT_PLACED', 'TEACHERS', 'ROOMS', 'COVERAGE', 'WORKLOAD', 'CHANGED', 'LAST_YEAR'] as const;
export type ScheduleAttentionGroup = (typeof SCHEDULE_ATTENTION_GROUPS)[number];
export const SCHEDULE_ATTENTION_LABELS: Record<ScheduleAttentionGroup, string> = {
  NOT_PLACED: 'Not Placed',
  TEACHERS: 'Teachers',
  ROOMS: 'Rooms',
  COVERAGE: 'Coverage',
  WORKLOAD: 'Workload',
  CHANGED: 'Changed Since You Scheduled',
  LAST_YEAR: "Last Year's Timetable",
};

export const ATTENTION_FIX_ACTIONS = ['PLACE_SLOT', 'PICK_TEACHER', 'MOVE_ENTRY', 'PICK_ROOM', 'APPLY_FIX', 'ACCEPT_MAPPING', 'ASSIGN_CLASSES', 'CLASSROOM_ALLOCATION', 'SPACE_SETUP'] as const;
export type AttentionFixAction = (typeof ATTENTION_FIX_ACTIONS)[number];

export interface ScheduleAttentionRowDTO {
  /** Stable: `unplaced:<key>`, `health:<entryId>:<rule>`, `item:<id>`. */
  rowId: string;
  title: string;
  message: string;
  fix: AttentionFixAction;
  fixLabel: string;
  entryId: string | null;
  sectionOfferingId: string | null;
  subjectOfferingId: string | null;
  teachingGroupId: string | null;
  employeeId: string | null;
  runItemId: string | null;
  /** The top recommended slot for a `PLACE_SLOT` row. */
  slot: { weekday: Weekday; periodId: string; label: string } | null;
  /** For `APPLY_FIX` rows: send to `POST /timetable-changes/apply`. */
  suggestionToken: string | null;
}

export interface ScheduleAttentionGroupDTO {
  group: ScheduleAttentionGroup;
  label: string;
  count: number;
  rows: ScheduleAttentionRowDTO[];
}

export interface ScheduleAttentionDTO {
  versionId: string;
  rev: number;
  groups: ScheduleAttentionGroupDTO[];
  total: number;
  needed: number;
  placed: number;
  /** "1,642 / 1,728 placed · 86 need attention". */
  progress: string;
}

// ───────────────────────────────────────────────────────────── events

export const SCHEDULE_EVENT_TYPES = ['timetable.entry.changed'] as const;
export type ScheduleEventType = (typeof SCHEDULE_EVENT_TYPES)[number];

export type { SuitabilityTagCode };
