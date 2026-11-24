import { Schema, model } from 'mongoose';
import {
  AVAILABILITY_KINDS,
  BELL_KINDS,
  CAPACITY_POLICIES,
  CHANGE_KINDS,
  DOUBLE_MODES,
  ENTRY_SOURCES,
  ENTRY_TYPES,
  FACULTY_ROLES,
  PERIOD_TYPES,
  RULE_CODES,
  RUN_ITEM_REASONS,
  RUN_ITEM_STATUSES,
  RUN_STATUSES,
  GENERATION_RUN_TYPES,
  VERSION_STATUSES,
  PLAN_STATUSES,
  PREFERRED_BANDS,
  REQUIREMENT_SCOPES,
  TEACHING_GROUP_KINDS,
  TIMETABLE_BUNDLES,
  WEEKDAYS,
  type AvailabilityKind,
  type BellKind,
  type CapacityPolicy,
  type ChangeKind,
  type DoubleMode,
  type EntrySource,
  type EntryType,
  type FacultyRole,
  type PeriodType,
  type PlanStatus,
  type PreferredBand,
  type RequirementScope,
  type RuleCode,
  type RunItemReason,
  type RunItemStatus,
  type RunStatus,
  type GenerationRunType,
  type SuitabilityTagCode,
  type TeachingGroupKind,
  type TimetableBundle,
  type VersionStatus,
  type Weekday,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Module 6, Part 1 collections. The timetable stores ids and numbers, never names: a teacher, a room, a subject or a student is
 * looked up each time. Times are minutes from midnight and dates are `YYYY-MM-DD` in the school's time zone.
 */

const common = {
  ...uuidPrimaryKey,
  tenantId: { type: String, required: true, immutable: true },
  schoolId: { type: String, required: true, immutable: true },
  ...auditFields,
};

// ───────────────────────────────────────────────────────────── plan

export interface TimetablePlanDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  locationId: string;
  academicSessionId: string;
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

const planSchema = new Schema<TimetablePlanDoc>(
  {
    ...common,
    locationId: { type: String, required: true, immutable: true },
    academicSessionId: { type: String, required: true, immutable: true },
    planName: { type: String, required: true, trim: true, maxlength: 100 },
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, required: true },
    operatingDays: { type: [{ type: String, enum: WEEKDAYS }], default: [] },
    defaultBellScheduleId: { type: String, default: null },
    capacityPolicy: { type: String, enum: CAPACITY_POLICIES, default: 'WARN' },
    transitionMinutes: { type: Number, default: 30 },
    defaultMaxPerDay: { type: Number, default: null },
    defaultMaxConsecutive: { type: Number, default: null },
    defaultMaxPerWeek: { type: Number, default: null },
    status: { type: String, enum: PLAN_STATUSES, default: 'DRAFT' },
    version: { type: Number, default: 1 },
  },
  baseSchemaOptions('timetable_plans'),
);
planSchema.index({ tenantId: 1, locationId: 1, academicSessionId: 1 }, { unique: true });
planSchema.plugin(tenantScopePlugin);
export const TimetablePlan = model<TimetablePlanDoc>('TimetablePlan', planSchema);

// ───────────────────────────────────────────────────────────── Daily Periods

export interface BellScheduleDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  planId: string;
  name: string;
  kind: BellKind;
  status: 'ACTIVE' | 'ARCHIVED';
}

const bellScheduleSchema = new Schema<BellScheduleDoc>(
  {
    ...common,
    planId: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 60 },
    kind: { type: String, enum: BELL_KINDS, default: 'REGULAR' },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
  },
  baseSchemaOptions('bell_schedule_templates'),
);
bellScheduleSchema.index({ tenantId: 1, planId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
bellScheduleSchema.plugin(tenantScopePlugin);
export const BellSchedule = model<BellScheduleDoc>('BellSchedule', bellScheduleSchema);

export interface BellPeriodDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  planId: string;
  templateId: string;
  periodCode: string;
  periodName: string;
  startMin: number;
  endMin: number;
  periodType: PeriodType;
  schedulable: boolean;
  displayOrder: number;
}

const bellPeriodSchema = new Schema<BellPeriodDoc>(
  {
    ...common,
    planId: { type: String, required: true, immutable: true },
    templateId: { type: String, required: true, immutable: true },
    periodCode: { type: String, required: true, trim: true, uppercase: true, maxlength: 12 },
    periodName: { type: String, required: true, trim: true, maxlength: 60 },
    startMin: { type: Number, required: true },
    endMin: { type: Number, required: true },
    periodType: { type: String, enum: PERIOD_TYPES, default: 'TEACHING' },
    schedulable: { type: Boolean, default: true },
    displayOrder: { type: Number, default: 0 },
  },
  baseSchemaOptions('bell_schedule_periods'),
);
bellPeriodSchema.index({ tenantId: 1, templateId: 1, periodCode: 1 }, { unique: true });
bellPeriodSchema.index({ tenantId: 1, planId: 1 });
bellPeriodSchema.plugin(tenantScopePlugin);
export const BellPeriod = model<BellPeriodDoc>('BellPeriod', bellPeriodSchema);

export interface BellAssignmentDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  planId: string;
  scope: 'CLASS' | 'SECTION';
  classOfferingId: string | null;
  sectionOfferingId: string | null;
  templateId: string;
  /** Empty means every school day. */
  weekdays: Weekday[];
}

const bellAssignmentSchema = new Schema<BellAssignmentDoc>(
  {
    ...common,
    planId: { type: String, required: true, immutable: true },
    scope: { type: String, enum: ['CLASS', 'SECTION'], required: true, immutable: true },
    classOfferingId: { type: String, default: null },
    sectionOfferingId: { type: String, default: null },
    templateId: { type: String, required: true },
    weekdays: { type: [{ type: String, enum: WEEKDAYS }], default: [] },
  },
  baseSchemaOptions('bell_schedule_assignments'),
);
bellAssignmentSchema.index({ tenantId: 1, planId: 1, scope: 1, classOfferingId: 1, sectionOfferingId: 1 });
bellAssignmentSchema.index({ tenantId: 1, templateId: 1 });
bellAssignmentSchema.plugin(tenantScopePlugin);
export const BellAssignment = model<BellAssignmentDoc>('BellAssignment', bellAssignmentSchema);

// ───────────────────────────────────────────────────────────── Subject Needs

export interface RequirementDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  planId: string;
  scope: RequirementScope;
  classOfferingId: string;
  sectionOfferingId: string | null;
  teachingGroupId: string | null;
  subjectOfferingId: string;
  periodsPerWeek: number;
  minPerWeek: number | null;
  maxPerWeek: number | null;
  maxPerDay: number;
  doubleMode: DoubleMode;
  doublesPerWeek: number;
  preferredBand: PreferredBand;
  neededSuitability: SuitabilityTagCode[];
  priority: number;
  version: number;
}

const requirementSchema = new Schema<RequirementDoc>(
  {
    ...common,
    planId: { type: String, required: true, immutable: true },
    scope: { type: String, enum: REQUIREMENT_SCOPES, required: true, immutable: true },
    classOfferingId: { type: String, required: true, immutable: true },
    sectionOfferingId: { type: String, default: null, immutable: true },
    teachingGroupId: { type: String, default: null, immutable: true },
    subjectOfferingId: { type: String, required: true, immutable: true },
    periodsPerWeek: { type: Number, required: true },
    minPerWeek: { type: Number, default: null },
    maxPerWeek: { type: Number, default: null },
    maxPerDay: { type: Number, default: 2 },
    doubleMode: { type: String, enum: DOUBLE_MODES, default: 'NONE' },
    doublesPerWeek: { type: Number, default: 0 },
    preferredBand: { type: String, enum: PREFERRED_BANDS, default: 'ANY' },
    neededSuitability: { type: [String], default: [] },
    priority: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
  },
  baseSchemaOptions('subject_schedule_requirements'),
);
requirementSchema.index({ tenantId: 1, planId: 1, scope: 1, classOfferingId: 1, sectionOfferingId: 1, teachingGroupId: 1, subjectOfferingId: 1 }, { unique: true });
requirementSchema.index({ tenantId: 1, subjectOfferingId: 1 });
requirementSchema.plugin(tenantScopePlugin);
export const Requirement = model<RequirementDoc>('SubjectScheduleRequirement', requirementSchema);

// ───────────────────────────────────────────────────────────── teacher availability and workload

export interface AvailabilityDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  planId: string;
  employeeId: string;
  weekday: Weekday;
  startMin: number;
  endMin: number;
  kind: AvailabilityKind;
}

const availabilitySchema = new Schema<AvailabilityDoc>(
  {
    ...common,
    planId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    weekday: { type: String, enum: WEEKDAYS, required: true },
    startMin: { type: Number, required: true },
    endMin: { type: Number, required: true },
    kind: { type: String, enum: AVAILABILITY_KINDS, required: true },
  },
  baseSchemaOptions('faculty_schedule_availability'),
);
availabilitySchema.index({ tenantId: 1, planId: 1, employeeId: 1, weekday: 1 });
availabilitySchema.plugin(tenantScopePlugin);
export const Availability = model<AvailabilityDoc>('FacultyScheduleAvailability', availabilitySchema);

/** One-day absences. Part 5 (Daily Operations) writes them; the clash checker reads them from Part 3 on. */
export interface AvailabilityExceptionDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  employeeId: string;
  dateFrom: string;
  dateTo: string;
  startMin: number | null;
  endMin: number | null;
  kind: 'ABSENT' | 'UNAVAILABLE';
  reason: string | null;
  status: 'ACTIVE' | 'CANCELLED';
}

const availabilityExceptionSchema = new Schema<AvailabilityExceptionDoc>(
  {
    ...common,
    employeeId: { type: String, required: true, immutable: true },
    dateFrom: { type: String, required: true },
    dateTo: { type: String, required: true },
    startMin: { type: Number, default: null },
    endMin: { type: Number, default: null },
    kind: { type: String, enum: ['ABSENT', 'UNAVAILABLE'], required: true },
    reason: { type: String, default: null },
    status: { type: String, enum: ['ACTIVE', 'CANCELLED'], default: 'ACTIVE' },
  },
  baseSchemaOptions('faculty_schedule_availability_exceptions'),
);
availabilityExceptionSchema.index({ tenantId: 1, employeeId: 1, dateFrom: 1 });
availabilityExceptionSchema.plugin(tenantScopePlugin);
export const AvailabilityException = model<AvailabilityExceptionDoc>('FacultyScheduleAvailabilityException', availabilityExceptionSchema);

export interface WorkloadRuleDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  planId: string;
  employeeId: string;
  maxPerDay: number | null;
  maxConsecutive: number | null;
  maxPerWeek: number | null;
  preferredFreePerDay: number | null;
}

const workloadSchema = new Schema<WorkloadRuleDoc>(
  {
    ...common,
    planId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    maxPerDay: { type: Number, default: null },
    maxConsecutive: { type: Number, default: null },
    maxPerWeek: { type: Number, default: null },
    preferredFreePerDay: { type: Number, default: null },
  },
  baseSchemaOptions('faculty_workload_rules'),
);
workloadSchema.index({ tenantId: 1, planId: 1, employeeId: 1 }, { unique: true });
workloadSchema.plugin(tenantScopePlugin);
export const WorkloadRule = model<WorkloadRuleDoc>('FacultyWorkloadRule', workloadSchema);

// ───────────────────────────────────────────────────────────── Teaching Groups

export interface TeachingGroupDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  planId: string;
  academicSessionId: string;
  locationId: string;
  name: string;
  /** Lower-case name, so "French 8" and "french 8" collide. */
  nameKey: string;
  kind: TeachingGroupKind;
  classOfferingId: string | null;
  subjectOfferingId: string | null;
  sectionPool: string[];
  teacherIds: string[];
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
}

const groupSchema = new Schema<TeachingGroupDoc>(
  {
    ...common,
    planId: { type: String, required: true, immutable: true },
    academicSessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    nameKey: { type: String, required: true },
    kind: { type: String, enum: TEACHING_GROUP_KINDS, required: true },
    classOfferingId: { type: String, default: null },
    subjectOfferingId: { type: String, default: null },
    sectionPool: { type: [String], default: [] },
    teacherIds: { type: [String], default: [] },
    status: { type: String, enum: ['ACTIVE', 'ARCHIVED'], default: 'ACTIVE' },
    version: { type: Number, default: 1 },
  },
  baseSchemaOptions('teaching_groups'),
);
groupSchema.index({ tenantId: 1, planId: 1, nameKey: 1 }, { unique: true });
groupSchema.plugin(tenantScopePlugin);
export const TeachingGroup = model<TeachingGroupDoc>('TeachingGroup', groupSchema);

/** Only hand-added members. Members of a Subject or Language group come live from Module 4 subject enrollment. */
export interface GroupMembershipDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  groupId: string;
  studentId: string;
  source: 'MANUAL';
  addedBy: string;
}

const membershipSchema = new Schema<GroupMembershipDoc>(
  {
    ...common,
    groupId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    source: { type: String, enum: ['MANUAL'], default: 'MANUAL' },
    addedBy: { type: String, required: true },
  },
  baseSchemaOptions('teaching_group_memberships'),
);
membershipSchema.index({ tenantId: 1, groupId: 1, studentId: 1 }, { unique: true });
membershipSchema.index({ tenantId: 1, studentId: 1 });
membershipSchema.plugin(tenantScopePlugin);
export const GroupMembership = model<GroupMembershipDoc>('TeachingGroupMembership', membershipSchema);

// ───────────────────────────────────────────────────────────── access bundles

export interface TimetableGrantDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  userId: string;
  bundles: TimetableBundle[];
  /** Narrows the campuses the bundle works on. Null means the campuses the person already works at. */
  locationIds: string[] | null;
  grantedBy: string;
}

const grantSchema = new Schema<TimetableGrantDoc>(
  {
    ...common,
    userId: { type: String, required: true, immutable: true },
    bundles: { type: [{ type: String, enum: TIMETABLE_BUNDLES }], default: [] },
    locationIds: { type: [String], default: null },
    grantedBy: { type: String, required: true },
  },
  baseSchemaOptions('timetable_access_grants'),
);
grantSchema.index({ tenantId: 1, userId: 1 }, { unique: true });
grantSchema.plugin(tenantScopePlugin);
export const TimetableGrant = model<TimetableGrantDoc>('TimetableAccessGrant', grantSchema);

// ───────────────────────────────────────────────────────────── Part 3: versions and lessons

export interface TimetableVersionDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  planId: string;
  versionNumber: number;
  versionName: string;
  sourceVersionId: string | null;
  status: VersionStatus;
  /** True while Draft or Ready. A partial unique index lets a plan have one open version. */
  isOpen: boolean;
  /** Goes up by 1 on every saved change. Two writers to one draft take turns on it. */
  rev: number;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  publishedAt: Date | null;
  publishedBy: string | null;
}

const versionSchema = new Schema<TimetableVersionDoc>(
  {
    ...common,
    planId: { type: String, required: true, immutable: true },
    versionNumber: { type: Number, required: true, immutable: true },
    versionName: { type: String, required: true, trim: true, maxlength: 80 },
    sourceVersionId: { type: String, default: null },
    status: { type: String, enum: VERSION_STATUSES, default: 'DRAFT' },
    isOpen: { type: Boolean, default: true },
    rev: { type: Number, default: 0 },
    effectiveFrom: { type: String, default: null },
    effectiveTo: { type: String, default: null },
    publishedAt: { type: Date, default: null },
    publishedBy: { type: String, default: null },
  },
  baseSchemaOptions('timetable_versions'),
);
versionSchema.index({ tenantId: 1, planId: 1, versionNumber: 1 }, { unique: true });
versionSchema.index({ tenantId: 1, planId: 1 }, { unique: true, partialFilterExpression: { isOpen: true } });
versionSchema.plugin(tenantScopePlugin);
export const TimetableVersion = model<TimetableVersionDoc>('TimetableVersion', versionSchema);

export interface TimetableEntryDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  versionId: string;
  planId: string;
  weekday: Weekday;
  periodId: string;
  /** Copied from the period so overlap checks are fast. */
  startMin: number;
  endMin: number;
  entryType: EntryType;
  subjectOfferingId: string | null;
  activityName: string | null;
  teachingGroupId: string | null;
  physicalSpaceId: string | null;
  isFixed: boolean;
  source: EntrySource;
  copiedFromEntryId: string | null;
  notes: string | null;
  version: number;
  /** The version's `rev` when this lesson was last written. Feeds live refresh. */
  rev: number;
}

const entrySchema = new Schema<TimetableEntryDoc>(
  {
    ...common,
    versionId: { type: String, required: true, immutable: true },
    planId: { type: String, required: true, immutable: true },
    weekday: { type: String, enum: WEEKDAYS, required: true },
    periodId: { type: String, required: true },
    startMin: { type: Number, required: true },
    endMin: { type: Number, required: true },
    entryType: { type: String, enum: ENTRY_TYPES, default: 'SUBJECT' },
    subjectOfferingId: { type: String, default: null },
    activityName: { type: String, default: null },
    teachingGroupId: { type: String, default: null },
    physicalSpaceId: { type: String, default: null },
    isFixed: { type: Boolean, default: false },
    source: { type: String, enum: ENTRY_SOURCES, default: 'MANUAL' },
    copiedFromEntryId: { type: String, default: null },
    notes: { type: String, default: null },
    version: { type: Number, default: 1 },
    rev: { type: Number, default: 0 },
  },
  baseSchemaOptions('timetable_entries'),
);
entrySchema.index({ tenantId: 1, versionId: 1, weekday: 1 });
entrySchema.index({ tenantId: 1, versionId: 1, rev: 1 });
entrySchema.index({ tenantId: 1, periodId: 1 });
// The last safety net for a room used twice in the same period. The checker also catches overlapping times.
entrySchema.index({ tenantId: 1, versionId: 1, physicalSpaceId: 1, weekday: 1, periodId: 1 }, { unique: true, partialFilterExpression: { physicalSpaceId: { $type: 'string' } } });
entrySchema.plugin(tenantScopePlugin);
export const TimetableEntry = model<TimetableEntryDoc>('TimetableEntry', entrySchema);

export interface EntrySectionDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  entryId: string;
  versionId: string;
  sectionOfferingId: string;
  weekday: Weekday;
  periodId: string;
}

const entrySectionSchema = new Schema<EntrySectionDoc>(
  {
    ...common,
    entryId: { type: String, required: true, immutable: true },
    versionId: { type: String, required: true, immutable: true },
    sectionOfferingId: { type: String, required: true },
    weekday: { type: String, enum: WEEKDAYS, required: true },
    periodId: { type: String, required: true },
  },
  baseSchemaOptions('timetable_entry_sections'),
);
entrySectionSchema.index({ tenantId: 1, versionId: 1, sectionOfferingId: 1, weekday: 1, periodId: 1 }, { unique: true });
entrySectionSchema.index({ tenantId: 1, entryId: 1 });
entrySectionSchema.plugin(tenantScopePlugin);
export const EntrySection = model<EntrySectionDoc>('TimetableEntrySection', entrySectionSchema);

export interface EntryFacultyDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  entryId: string;
  versionId: string;
  employeeId: string;
  role: FacultyRole;
  weekday: Weekday;
  periodId: string;
}

const entryFacultySchema = new Schema<EntryFacultyDoc>(
  {
    ...common,
    entryId: { type: String, required: true, immutable: true },
    versionId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true },
    role: { type: String, enum: FACULTY_ROLES, default: 'MAIN' },
    weekday: { type: String, enum: WEEKDAYS, required: true },
    periodId: { type: String, required: true },
  },
  baseSchemaOptions('timetable_entry_faculty'),
);
entryFacultySchema.index({ tenantId: 1, versionId: 1, employeeId: 1, weekday: 1, periodId: 1 }, { unique: true });
entryFacultySchema.index({ tenantId: 1, entryId: 1 });
entryFacultySchema.plugin(tenantScopePlugin);
export const EntryFaculty = model<EntryFacultyDoc>('TimetableEntryFaculty', entryFacultySchema);

export interface ConflictOverrideDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  entryId: string;
  versionId: string;
  rule: RuleCode;
  reason: string;
  byUserId: string;
  at: Date;
  /** The ids the override covered. If the lesson changes so this changes, the override stops counting. */
  signature: string;
}

const conflictOverrideSchema = new Schema<ConflictOverrideDoc>(
  {
    ...common,
    entryId: { type: String, required: true, immutable: true },
    versionId: { type: String, required: true, immutable: true },
    rule: { type: String, enum: RULE_CODES, required: true },
    reason: { type: String, required: true, maxlength: 300 },
    byUserId: { type: String, required: true },
    at: { type: Date, required: true },
    signature: { type: String, required: true },
  },
  baseSchemaOptions('timetable_conflict_overrides'),
);
conflictOverrideSchema.index({ tenantId: 1, versionId: 1, entryId: 1, rule: 1 }, { unique: true });
conflictOverrideSchema.plugin(tenantScopePlugin);
export const ConflictOverride = model<ConflictOverrideDoc>('TimetableConflictOverride', conflictOverrideSchema);

/** What a lesson looked like, kept inside a change set so Undo can put it back. */
export interface StoredEntry {
  id: string;
  weekday: Weekday;
  periodId: string;
  entryType: EntryType;
  subjectOfferingId: string | null;
  activityName: string | null;
  groupId: string | null;
  spaceId: string | null;
  isFixed: boolean;
  source: EntrySource;
  notes: string | null;
  version: number;
  copiedFromEntryId: string | null;
  sectionIds: string[];
  teachers: { employeeId: string; role: FacultyRole }[];
}

export interface ChangeSetDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  versionId: string;
  planId: string;
  requestId: string | null;
  actorId: string;
  kind: ChangeKind;
  label: string;
  rev: number;
  before: StoredEntry[];
  after: StoredEntry[];
  undoneAt: Date | null;
  undoneBy: string | null;
}

const changeSetSchema = new Schema<ChangeSetDoc>(
  {
    ...common,
    versionId: { type: String, required: true, immutable: true },
    planId: { type: String, required: true, immutable: true },
    requestId: { type: String, default: null },
    actorId: { type: String, required: true },
    kind: { type: String, enum: CHANGE_KINDS, required: true },
    label: { type: String, required: true },
    rev: { type: Number, required: true },
    before: { type: Schema.Types.Mixed, default: () => [] },
    after: { type: Schema.Types.Mixed, default: () => [] },
    undoneAt: { type: Date, default: null },
    undoneBy: { type: String, default: null },
  },
  baseSchemaOptions('timetable_change_sets'),
);
changeSetSchema.index({ tenantId: 1, versionId: 1, rev: 1 });
changeSetSchema.index({ tenantId: 1, versionId: 1, requestId: 1 }, { unique: true, partialFilterExpression: { requestId: { $type: 'string' } } });
changeSetSchema.plugin(tenantScopePlugin);
export const ChangeSet = model<ChangeSetDoc>('TimetableChangeSet', changeSetSchema);

export interface GenerationRunDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  versionId: string;
  planId: string;
  runType: GenerationRunType;
  mode: string;
  requestedBy: string;
  startedAt: Date;
  completedAt: Date | null;
  totalRequirements: number;
  totalPeriods: number;
  entriesCreated: number;
  unresolvedCount: number;
  warningCount: number;
  status: RunStatus;
  configurationSnapshot: Record<string, unknown>;
  unresolved: { key: string; label: string; remaining: number; reason: string; message: string }[];
  rev: number | null;
  changeSetId: string | null;
}

const runSchema = new Schema<GenerationRunDoc>(
  {
    ...common,
    versionId: { type: String, required: true, immutable: true },
    planId: { type: String, required: true, immutable: true },
    runType: { type: String, enum: GENERATION_RUN_TYPES, required: true },
    mode: { type: String, required: true },
    requestedBy: { type: String, required: true },
    startedAt: { type: Date, required: true },
    completedAt: { type: Date, default: null },
    totalRequirements: { type: Number, default: 0 },
    totalPeriods: { type: Number, default: 0 },
    entriesCreated: { type: Number, default: 0 },
    unresolvedCount: { type: Number, default: 0 },
    warningCount: { type: Number, default: 0 },
    status: { type: String, enum: RUN_STATUSES, required: true },
    configurationSnapshot: { type: Schema.Types.Mixed, default: {} },
    unresolved: { type: Schema.Types.Mixed, default: () => [] },
    rev: { type: Number, default: null },
    changeSetId: { type: String, default: null },
  },
  baseSchemaOptions('timetable_generation_runs'),
);
runSchema.index({ tenantId: 1, versionId: 1, startedAt: -1 });
runSchema.index({ tenantId: 1, versionId: 1, requestedBy: 1, mode: 1, startedAt: 1 });
runSchema.plugin(tenantScopePlugin);
export const GenerationRun = model<GenerationRunDoc>('TimetableGenerationRun', runSchema);

export interface RunItemDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  runId: string;
  versionId: string;
  kind: 'MAPPING';
  reason: RunItemReason;
  /** Last year's lesson in ids and plain labels. */
  payload: Record<string, unknown>;
  /** A ready lesson to create when accepted. Null when a person must decide. */
  suggestion: Record<string, unknown> | null;
  status: RunItemStatus;
  resolvedBy: string | null;
}

const runItemSchema = new Schema<RunItemDoc>(
  {
    ...common,
    runId: { type: String, required: true, immutable: true },
    versionId: { type: String, required: true, immutable: true },
    kind: { type: String, enum: ['MAPPING'], default: 'MAPPING' },
    reason: { type: String, enum: RUN_ITEM_REASONS, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
    suggestion: { type: Schema.Types.Mixed, default: null },
    status: { type: String, enum: RUN_ITEM_STATUSES, default: 'OPEN' },
    resolvedBy: { type: String, default: null },
  },
  baseSchemaOptions('timetable_run_items'),
);
runItemSchema.index({ tenantId: 1, versionId: 1, status: 1 });
runItemSchema.index({ tenantId: 1, runId: 1, reason: 1 });
runItemSchema.plugin(tenantScopePlugin);
export const RunItem = model<RunItemDoc>('TimetableRunItem', runItemSchema);
