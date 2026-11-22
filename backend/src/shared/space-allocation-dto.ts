import type {
  ArchiveAction,
  AssignmentSource,
  AssignmentStoredStatus,
  HomeClassroomPhase,
  ReadinessGap,
  RecommendationPurpose,
  ReplaceMode,
  RolloverReviewReason,
  SpaceAttentionFix,
  SpaceAttentionGroup,
  SpaceReportType,
  SuitabilityTagCode,
  UnresolvedReason,
} from './spaces';
import type { AvailabilityBlockDTO, EffectiveStatusDTO, SourcedValue, SpaceDTO } from './space-dto';

/** Module 5, Part 3 — Home Classroom assignments, recommendations, rollover, readiness, Needs Attention and reports. */

/** The section a room is given to, in words: "VIII-A · 36 students". `strength` is counted live from the student records. */
export interface SectionRefDTO {
  sectionOfferingId: string;
  classOfferingId: string;
  academicSessionId: string;
  locationId: string;
  className: string;
  sectionCode: string;
  /** "VIII-A". */
  label: string;
  strength: number;
}

/** A short view of a room, enough to show a row without a second request. */
export interface RoomRefDTO {
  spaceId: string;
  spaceCode: string;
  spaceName: string;
  /** "Main Block › First Floor › 101". */
  path: string;
  /** Seats for classes (final value). `null` when nobody has set it. */
  academicCapacity: number | null;
  physicalCapacity: number | null;
  effectiveStatus: EffectiveStatusDTO;
  homeClassroomEligible: boolean;
}

export interface AssignmentWarningDTO {
  code: 'ROOM_TOO_SMALL' | 'CAPACITY_UNKNOWN' | 'BLOCK_IN_PERIOD' | 'ROOM_UNAVAILABLE' | 'ROOM_NOT_ELIGIBLE' | 'NO_STUDENTS_YET';
  message: string;
}

/** The numbers behind "42 students, but the room holds 40". */
export interface CapacityOverrideDTO {
  reason: string;
  byUserId: string;
  at: string;
  strength: number | null;
  capacity: number | null;
}

export interface HomeClassroomDTO {
  assignmentId: string;
  academicSessionId: string;
  section: SectionRefDTO;
  room: RoomRefDTO;
  shiftId: string | null;
  effectiveFrom: string;
  /** `null` = until the session ends. */
  effectiveTo: string | null;
  /** Worked out from the dates, never stored. */
  phase: HomeClassroomPhase;
  status: AssignmentStoredStatus;
  source: AssignmentSource;
  reason: string | null;
  capacityOverride: CapacityOverrideDTO | null;
  assignedBy: string | null;
  /** Live checks: the room became too small, closed, or has a closure coming up. A warning never ends the assignment. */
  warnings: AssignmentWarningDTO[];
  version: number;
}

export interface HomeClassroomListDTO {
  items: HomeClassroomDTO[];
  total: number;
  page: number;
  pageSize: number;
}

/** `GET /sections/:id/home-classroom?date=` — the room in force on that date, or none. */
export interface SectionHomeClassroomDTO {
  sectionOfferingId: string;
  date: string;
  homeClassroom: HomeClassroomDTO | null;
}

export interface AssignmentChangeResultDTO {
  assignment: HomeClassroomDTO;
  /** The row that was ended or cancelled to make room for this one. */
  replaced: HomeClassroomDTO | null;
  /** Warnings that did not stop the save (a closure during the period, a missing seat count). */
  warnings: AssignmentWarningDTO[];
}

/** `GET /spaces/my-classrooms` — a teacher's view: the Home Classroom of each section they teach today, and the ones still without a room. */
export interface MyClassroomsDTO {
  items: HomeClassroomDTO[];
  withoutRoom: { sectionOfferingId: string; label: string }[];
}

// ───────────────────────────────────────────────────────────── bulk

export interface BulkAssignmentResultDTO {
  source: AssignmentSource;
  done: { sectionOfferingId: string; label: string; assignmentId: string; roomName: string }[];
  /** The same room was already in force for the section: running the request again is safe. */
  alreadyDone: { sectionOfferingId: string; label: string; roomName: string }[];
  failed: { sectionOfferingId: string; label: string | null; physicalSpaceId: string; code: string; message: string }[];
  message: string;
}

// ───────────────────────────────────────────────────────────── recommendations

export interface RoomChoiceDTO extends RoomRefDTO {
  /** Free seats left over for this section; negative = too small. */
  seatsLeft: number | null;
}

export interface RecommendationDTO {
  section: SectionRefDTO;
  room: RoomChoiceDTO;
  /** 0 to 100: higher is a better fit. */
  score: number;
  /** "Same room as last year", "Best fit: 36 students in a 40-seat room". */
  reasons: string[];
  warnings: AssignmentWarningDTO[];
  /** Set when the section has a Home Classroom whose room is no longer usable: accepting replaces it. */
  replacesAssignmentId: string | null;
}

export interface UnresolvedSectionDTO {
  section: SectionRefDTO;
  reason: UnresolvedReason;
  status: 'NEEDS_REVIEW';
  /** "42 students, but the closest room holds 40." */
  message: string;
  /** The nearest room to what the section needs, when there is one. */
  closestRoom: RoomChoiceDTO | null;
}

export interface RecommendationSetDTO {
  academicSessionId: string;
  locationId: string;
  /** The period the rooms are matched for. */
  from: string;
  to: string;
  summary: { sections: number; eligibleRooms: number; ready: number; needsReview: number; alreadyAssigned: number };
  recommendations: RecommendationDTO[];
  unresolved: UnresolvedSectionDTO[];
  alreadyAssigned: { section: SectionRefDTO; room: RoomRefDTO; assignmentId: string }[];
  /** "We found 35 sections and 34 eligible rooms. 32 are ready. 3 need your attention." */
  message: string;
}

export interface RoomRecommendationDTO {
  room: SpaceDTO;
  score: number;
  reasons: string[];
}
export interface RoomRecommendationListDTO {
  purpose: RecommendationPurpose;
  items: RoomRecommendationDTO[];
}

// ───────────────────────────────────────────────────────────── rollover

export interface RolloverRowDTO {
  fromSection: { sectionOfferingId: string; label: string };
  toSection: { sectionOfferingId: string; label: string; strength: number } | null;
  room: RoomRefDTO;
  /** `DONE` = the new section already has a Home Classroom (so a second run changes nothing). */
  status: 'READY' | 'REVIEW' | 'DONE';
  reason: RolloverReviewReason | null;
  message: string;
  /** What to try instead, when the reason points to one. */
  suggestedRoom: RoomRefDTO | null;
}

export interface RolloverSummaryDTO {
  fromSessionId: string;
  toSessionId: string;
  locationId: string;
  total: number;
  ready: number;
  review: number;
  done: number;
  /** "32 of 35 mappings can be carried forward. 3 need a look." */
  message: string;
  rows: RolloverRowDTO[];
}

export interface RolloverCommitDTO {
  carried: number;
  skipped: number;
  alreadyDone: number;
  total: number;
  /** "32 of 35 carried forward". */
  message: string;
  summary: RolloverSummaryDTO;
}

// ───────────────────────────────────────────────────────────── replacement on archive

export interface ReplaceRoomResultDTO {
  mode: ReplaceMode;
  /** The sections that moved to the other room (NOW) or will keep this one until the session ends (AFTER_SESSION). */
  moved: { assignmentId: string; sectionOfferingId: string; label: string; fromRoom: string; toRoom: string }[];
  archived: boolean;
  /** Set by `AFTER_SESSION`: from this date the room counts as archived. */
  archiveAfterDate: string | null;
  message: string;
  space: SpaceDTO;
  /** Still in the way after the move (another module's records), in plain words. */
  dependencies: { kind: string; label: string }[];
  actions: ArchiveAction[];
}

// ───────────────────────────────────────────────────────────── integration: availability and readiness

export interface AvailableRoomsDTO {
  items: SpaceDTO[];
  total: number;
}

export interface ReadinessItemDTO {
  spaceId: string;
  spaceCode: string;
  spaceName: string;
  path: string;
  ready: boolean;
  missing: { code: ReadinessGap; message: string }[];
  /** The room's type changed, so the Timetable looks at it again. */
  needsRecheck: boolean;
}
export interface ReadinessDTO {
  locationId: string;
  totals: { rooms: number; ready: number; notReady: number };
  items: ReadinessItemDTO[];
  /** Said in every answer so nobody assumes this module books periods. */
  boundary: string;
}

// ───────────────────────────────────────────────────────────── Needs Attention

export interface SpaceAttentionRowDTO {
  rowId: string;
  title: string;
  detail: string;
  fix: SpaceAttentionFix;
  sectionOfferingId: string | null;
  physicalSpaceId: string | null;
  assignmentId: string | null;
  /** A room that would solve it, for `CHOOSE_LARGER_ROOM` and `ASSIGN_ROOM`. */
  suggestedRoom: RoomRefDTO | null;
}
export interface SpaceAttentionGroupDTO {
  group: SpaceAttentionGroup;
  title: string;
  count: number;
  rows: SpaceAttentionRowDTO[];
}
export interface SpaceAttentionDTO {
  academicSessionId: string | null;
  locationId: string | null;
  groups: SpaceAttentionGroupDTO[];
  counts: { needsAttention: number; byGroup: Record<SpaceAttentionGroup, number> };
  kpis: { recommendedAutomaticallyPercent: number | null; rolloverReusePercent: number | null; inheritedPropertyPercent: number | null; setupCompletenessPercent: number | null };
}

// ───────────────────────────────────────────────────────────── reports

export interface SpaceReportDTO {
  type: SpaceReportType;
  title: string;
  generatedAt: string;
  columns: { key: string; label: string }[];
  rows: Record<string, string | number | null>[];
  /** For the completeness report: a plain-words line such as "31 of 34 rooms are complete". */
  summary: string | null;
}

export type { AvailabilityBlockDTO, SourcedValue, SuitabilityTagCode };
