import type { EntrySource, EntryType, FacultyRole, IssueFixDTO, IssueSeverity, RequirementValuesDTO, RuleCode, SuitabilityTagCode, Weekday } from '@shared';
import type { AcademicAssignmentDoc } from '../../staff/assignment.models';
import type { AvailabilityDoc, AvailabilityExceptionDoc, TimetablePlanDoc } from '../models';
import type { BellContext } from '../bell.resolve';
import type { PlanFacts } from '../facts';
import type { Board } from './board';

/** A lesson as the checker sees it: ids and numbers only. */
export interface EntryRec {
  id: string;
  weekday: Weekday;
  periodId: string;
  /** Copied from the period, so overlap checks compare real time. */
  startMin: number;
  endMin: number;
  templateId: string;
  entryType: EntryType;
  subjectOfferingId: string | null;
  activityName: string | null;
  groupId: string | null;
  spaceId: string | null;
  isFixed: boolean;
  source: EntrySource;
  notes: string | null;
  /** The lesson's own change counter (for stale screens). */
  version: number;
  /** The version's `rev` when this lesson was last written. */
  rev: number;
  copiedFromEntryId: string | null;
  sectionIds: string[];
  teachers: { employeeId: string; role: FacultyRole }[];
  /** Overridable clashes someone accepted, with their reasons. Only set while checking. */
  overridden?: Partial<Record<RuleCode, { reason: string; signature: string }>>;
}

/** What may change on a lesson. */
export type EntryContent = Pick<EntryRec, 'weekday' | 'periodId' | 'entryType' | 'subjectOfferingId' | 'activityName' | 'groupId' | 'spaceId' | 'isFixed' | 'notes' | 'sectionIds' | 'teachers'>;

export type Op = { type: 'create'; entry: EntryRec } | { type: 'update'; id: string; patch: Partial<EntryContent> } | { type: 'delete'; id: string };

export interface PeriodRec {
  id: string;
  templateId: string;
  code: string;
  name: string;
  startMin: number;
  endMin: number;
  schedulable: boolean;
  /** Position among the template's lesson periods, starting at 0. -1 for breaks. */
  lessonIndex: number;
  lessonCount: number;
}

export interface Issue {
  rule: RuleCode;
  severity: IssueSeverity;
  message: string;
  who: string[];
  when: string | null;
  overridable: boolean;
  overriddenReason: string | null;
  entryId: string | null;
  blockedBy: string[];
  fix: IssueFixDTO | null;
  /** What is in the way, for "blocked by Rakesh, Lab 1…" counts. */
  culprit: { kind: 'TEACHER' | 'ROOM' | 'SECTION' | 'STUDENT' | 'OTHER'; id: string } | null;
}

export interface RoomRec {
  spaceId: string;
  spaceName: string;
  tags: SuitabilityTagCode[];
  capacity: number | null;
  usable: boolean;
  reason: string | null;
}

export interface GroupRec {
  id: string;
  name: string;
  classOfferingId: string | null;
  subjectOfferingId: string | null;
  sectionPool: string[];
  members: Set<string>;
  /** Teachers allowed for the group's lessons. Empty means none is set. */
  teacherIds: string[];
  teacherStatus: 'OK' | 'MISSING' | 'PICK_ONE';
}

export interface WorkloadLimits {
  maxPerDay: number | null;
  maxConsecutive: number | null;
  maxPerWeek: number | null;
}

/** Another campus's published lesson that blocks a teacher here. */
export interface OutsideLesson {
  weekday: Weekday;
  startMin: number;
  endMin: number;
  locationName: string;
  from: string;
  to: string;
}

export interface Snapshot {
  tenantId: string;
  plan: TimetablePlanDoc;
  versionId: string;
  rev: number;
  /** The date the plan's data was read for (today, held inside the plan's dates). */
  day: string;
  /** Set when the board is one real date (the published lessons with that day's one-day changes). The same rules apply, minus the weekly ones. */
  onDate: string | null;
  facts: PlanFacts;
  bell: BellContext;
  periods: Map<string, PeriodRec>;
  board: Board;
  teacherNames: Map<string, string>;
  campusTeachers: Set<string>;
  availability: Map<string, AvailabilityDoc[]>;
  exceptions: Map<string, AvailabilityExceptionDoc[]>;
  workloadDefault: WorkloadLimits;
  workload: Map<string, WorkloadLimits>;
  rooms: Map<string, RoomRec>;
  /** Rooms that exist in the school but are archived or at another campus. */
  strangerRooms: Map<string, { spaceName: string; archived: boolean }>;
  closures: Map<string, { from: string; to: string }>;
  homeRoom: Map<string, string>;
  sectionSize: Map<string, number>;
  studentSection: Map<string, string>;
  groups: Map<string, GroupRec>;
  assignments: AcademicAssignmentDoc[];
  requirements: RequirementIndex;
  outside: Map<string, OutsideLesson[]>;
}

export interface RequirementIndex {
  /** Effective values for a section's subject: the section row, else the class row. */
  forSection(sectionId: string, subjectOfferingId: string): RequirementValuesDTO | null;
  /** Effective values for a Teaching Group: its own row, else the class row for the subject. */
  forGroup(groupId: string): RequirementValuesDTO | null;
}

export interface CheckOutcome {
  issues: Issue[];
  blockers: Issue[];
  warnings: Issue[];
  info: Issue[];
  perOp: { index: number; entryId: string | null; blockers: number; warnings: number; info: number }[];
}
