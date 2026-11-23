import { Schema, model } from 'mongoose';
import {
  AVAILABILITY_KINDS,
  BELL_KINDS,
  CAPACITY_POLICIES,
  DOUBLE_MODES,
  PERIOD_TYPES,
  PLAN_STATUSES,
  PREFERRED_BANDS,
  REQUIREMENT_SCOPES,
  TEACHING_GROUP_KINDS,
  TIMETABLE_BUNDLES,
  WEEKDAYS,
  type AvailabilityKind,
  type BellKind,
  type CapacityPolicy,
  type DoubleMode,
  type PeriodType,
  type PlanStatus,
  type PreferredBand,
  type RequirementScope,
  type SuitabilityTagCode,
  type TeachingGroupKind,
  type TimetableBundle,
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
