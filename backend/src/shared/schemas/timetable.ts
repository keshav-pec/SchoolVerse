import { z } from 'zod';
import {
  AVAILABILITY_KINDS,
  BELL_KINDS,
  BELL_SCOPES,
  CAPACITY_POLICIES,
  DOUBLE_MODES,
  GENERATED_BLOCK_TYPES,
  PERIOD_TYPES,
  PREFERRED_BANDS,
  REQUIREMENT_SCOPES,
  TEACHING_GROUP_KINDS,
  TIMETABLE_BUNDLES,
  WEEKDAYS,
  clockToMinutes,
} from '../timetable';
import { paginationQuerySchema, uuidSchema } from './common';
import { optionalDateSchema, requiredText } from './fields';

/**
 * Module 6, Part 1 — request bodies and queries. Every body is `.strict()`: a stray `tenantId`, `status` or `rev` is a validation
 * error. Times are "HH:MM" text; the server stores minutes from midnight.
 */

const weekdaySchema = z.enum(WEEKDAYS, { message: 'Choose a day of the week.' });
const weekdaysSchema = z.array(weekdaySchema).max(7).refine((a) => new Set(a).size === a.length, { message: 'Each day can only be listed once.' });
const clockSchema = z
  .string({ message: 'Enter a time like 08:30.' })
  .trim()
  .refine((v) => clockToMinutes(v) !== null, { message: 'Enter a time like 08:30.' });
const intRange = (min: number, max: number, label = 'This number') => z.number({ message: `${label} must be a whole number.` }).int({ message: `${label} must be a whole number.` }).min(min, { message: `${label} must be at least ${min}.` }).max(max, { message: `${label} must be at most ${max}.` });
const nullableInt = (min: number, max: number, label?: string) => intRange(min, max, label).nullable();

// ───────────────────────────────────────────────────────────── plan

export const createTimetablePlanSchema = z
  .object({
    locationId: uuidSchema,
    academicSessionId: uuidSchema,
    planName: requiredText('Plan name', 100).optional(),
    effectiveFrom: optionalDateSchema,
    effectiveTo: optionalDateSchema,
    operatingDays: weekdaysSchema.min(1, { message: 'Choose at least one school day.' }).optional(),
    capacityPolicy: z.enum(CAPACITY_POLICIES).optional(),
    transitionMinutes: intRange(0, 240).optional(),
  })
  .strict();
export type CreateTimetablePlanData = z.output<typeof createTimetablePlanSchema>;

export const updateTimetablePlanSchema = z
  .object({
    version: z.number().int().min(1),
    planName: requiredText('Plan name', 100).optional(),
    effectiveFrom: optionalDateSchema,
    effectiveTo: optionalDateSchema,
    operatingDays: weekdaysSchema.min(1, { message: 'Choose at least one school day.' }).optional(),
    capacityPolicy: z.enum(CAPACITY_POLICIES).optional(),
    transitionMinutes: intRange(0, 240).optional(),
    defaultMaxPerDay: nullableInt(1, 12).optional(),
    defaultMaxConsecutive: nullableInt(1, 12).optional(),
    defaultMaxPerWeek: nullableInt(1, 80).optional(),
  })
  .strict();
export type UpdateTimetablePlanData = z.output<typeof updateTimetablePlanSchema>;

export const planStatusSchema = z.object({ to: z.enum(['ARCHIVED', 'DRAFT']) }).strict();

export const listTimetablePlansQuerySchema = z.object({ locationId: uuidSchema.optional(), academicSessionId: uuidSchema.optional(), includeArchived: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false) });
export type ListTimetablePlansQuery = z.output<typeof listTimetablePlansQuerySchema>;

// ───────────────────────────────────────────────────────────── Daily Periods

export const createBellScheduleSchema = z.object({ name: requiredText('Name', 60), kind: z.enum(BELL_KINDS).default('REGULAR') }).strict();
export const updateBellScheduleSchema = z.object({ name: requiredText('Name', 60).optional(), kind: z.enum(BELL_KINDS).optional() }).strict();

const periodFields = {
  periodName: requiredText('Period name', 60),
  start: clockSchema,
  end: clockSchema,
  periodType: z.enum(PERIOD_TYPES).default('TEACHING'),
  schedulable: z.boolean().optional(),
};
export const createBellPeriodSchema = z.object({ periodCode: requiredText('Period code', 12).optional(), ...periodFields }).strict();
export const updateBellPeriodSchema = z
  .object({
    periodName: periodFields.periodName.optional(),
    start: clockSchema.optional(),
    end: clockSchema.optional(),
    periodType: z.enum(PERIOD_TYPES).optional(),
    schedulable: z.boolean().optional(),
  })
  .strict();

export const generateBellSchema = z
  .object({
    name: requiredText('Name', 60),
    kind: z.enum(BELL_KINDS).default('REGULAR'),
    start: clockSchema,
    end: clockSchema,
    periodMinutes: intRange(10, 180, 'Period length'),
    breaks: z.array(z.object({ name: requiredText('Break name', 40), start: clockSchema, end: clockSchema, type: z.enum(GENERATED_BLOCK_TYPES).default('BREAK') }).strict()).max(8).default([]),
    assembly: z.object({ name: requiredText('Assembly name', 40).default('Assembly'), start: clockSchema, end: clockSchema }).strict().optional(),
  })
  .strict();
export type GenerateBellData = z.output<typeof generateBellSchema>;

export const bulkBellAssignmentSchema = z
  .object({
    bellScheduleId: uuidSchema,
    scope: z.enum(BELL_SCOPES),
    classOfferingIds: z.array(uuidSchema).min(1).max(100).optional(),
    sectionOfferingIds: z.array(uuidSchema).min(1).max(300).optional(),
    weekdays: weekdaysSchema.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.scope === 'CLASS' && !v.classOfferingIds) ctx.addIssue({ code: 'custom', path: ['classOfferingIds'], message: 'Choose at least one class.' });
    if (v.scope === 'SECTION' && !v.sectionOfferingIds) ctx.addIssue({ code: 'custom', path: ['sectionOfferingIds'], message: 'Choose at least one section.' });
    if (v.scope === 'DEFAULT' && v.weekdays?.length) ctx.addIssue({ code: 'custom', path: ['weekdays'], message: 'The school default applies every day.' });
  });
export type BulkBellAssignmentData = z.output<typeof bulkBellAssignmentSchema>;

export const clearBellAssignmentSchema = z.object({ assignmentIds: z.array(uuidSchema).min(1).max(300) }).strict();

// ───────────────────────────────────────────────────────────── Subject Needs

const requirementValueFields = {
  periodsPerWeek: intRange(0, 60, 'Periods a week'),
  minPerWeek: nullableInt(0, 60, 'Minimum a week').optional(),
  maxPerWeek: nullableInt(0, 60, 'Maximum a week').optional(),
  maxPerDay: intRange(1, 12, 'Most in a day').optional(),
  doubleMode: z.enum(DOUBLE_MODES).optional(),
  doublesPerWeek: intRange(0, 30, 'Double periods').optional(),
  preferredBand: z.enum(PREFERRED_BANDS).optional(),
  neededSuitability: z.array(z.string().trim().min(1).max(40)).max(8).optional(),
  priority: intRange(0, 100, 'Priority').optional(),
};

export const requirementItemSchema = z
  .object({
    scope: z.enum(REQUIREMENT_SCOPES).default('CLASS'),
    classOfferingId: uuidSchema,
    sectionOfferingId: uuidSchema.optional(),
    teachingGroupId: uuidSchema.optional(),
    subjectOfferingId: uuidSchema,
    /** The row's `version` when it was read. A stale one is refused. */
    version: z.number().int().min(1).optional(),
    ...requirementValueFields,
  })
  .strict();
export type RequirementItemData = z.output<typeof requirementItemSchema>;

export const saveRequirementsSchema = z.object({ planId: uuidSchema, items: z.array(requirementItemSchema).min(1).max(200) }).strict();
export type SaveRequirementsData = z.output<typeof saveRequirementsSchema>;

export const applyGradeSchema = z
  .object({
    planId: uuidSchema,
    classOfferingId: uuidSchema,
    items: z.array(z.object({ subjectOfferingId: uuidSchema, ...requirementValueFields }).strict()).min(1).max(60),
  })
  .strict();
export type ApplyGradeData = z.output<typeof applyGradeSchema>;

export const copySectionSchema = z.object({ planId: uuidSchema, fromSectionId: uuidSchema, toSectionIds: z.array(uuidSchema).min(1).max(100) }).strict();
export type CopySectionData = z.output<typeof copySectionSchema>;

export const resetSectionSchema = z.object({ planId: uuidSchema, sectionOfferingId: uuidSchema, subjectOfferingIds: z.array(uuidSchema).max(60).optional() }).strict();

export const listRequirementsQuerySchema = z.object({ planId: uuidSchema, classOfferingId: uuidSchema.optional(), sectionOfferingId: uuidSchema.optional(), teachingGroupId: uuidSchema.optional() });
export type ListRequirementsQuery = z.output<typeof listRequirementsQuerySchema>;

// ───────────────────────────────────────────────────────────── teacher availability and workload

export const availabilityRowSchema = z.object({ weekday: weekdaySchema, start: clockSchema, end: clockSchema, kind: z.enum(AVAILABILITY_KINDS) }).strict();
export const replaceAvailabilitySchema = z.object({ planId: uuidSchema, rows: z.array(availabilityRowSchema).max(200) }).strict();
export const bulkAvailabilitySchema = z.object({ planId: uuidSchema, employeeIds: z.array(uuidSchema).min(1).max(100), rows: z.array(availabilityRowSchema).max(200), mode: z.enum(['REPLACE', 'ADD']).default('REPLACE') }).strict();
export const copyAvailabilitySchema = z.object({ planId: uuidSchema, fromEmployeeId: uuidSchema, toEmployeeIds: z.array(uuidSchema).min(1).max(100) }).strict();
export const planQuerySchema = z.object({ planId: uuidSchema });
export type ReplaceAvailabilityData = z.output<typeof replaceAvailabilitySchema>;
export type BulkAvailabilityData = z.output<typeof bulkAvailabilitySchema>;
export type CopyAvailabilityData = z.output<typeof copyAvailabilitySchema>;

export const saveWorkloadSchema = z
  .object({
    planId: uuidSchema,
    /** Null means the school default for the whole plan. */
    employeeId: uuidSchema.nullable(),
    maxPerDay: nullableInt(1, 12).optional(),
    maxConsecutive: nullableInt(1, 12).optional(),
    maxPerWeek: nullableInt(1, 80).optional(),
    preferredFreePerDay: nullableInt(0, 12).optional(),
  })
  .strict();
export type SaveWorkloadData = z.output<typeof saveWorkloadSchema>;

// ───────────────────────────────────────────────────────────── Teaching Groups

export const createTeachingGroupSchema = z
  .object({
    planId: uuidSchema,
    name: requiredText('Group name', 80),
    kind: z.enum(TEACHING_GROUP_KINDS).default('SUBJECT'),
    classOfferingId: uuidSchema.optional(),
    subjectOfferingId: uuidSchema.optional(),
    sectionPool: z.array(uuidSchema).max(60).default([]),
    teacherIds: z.array(uuidSchema).max(6).optional(),
  })
  .strict();
export type CreateTeachingGroupData = z.output<typeof createTeachingGroupSchema>;

export const updateTeachingGroupSchema = z
  .object({
    version: z.number().int().min(1),
    name: requiredText('Group name', 80).optional(),
    sectionPool: z.array(uuidSchema).max(60).optional(),
    teacherIds: z.array(uuidSchema).max(6).optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .strict();
export type UpdateTeachingGroupData = z.output<typeof updateTeachingGroupSchema>;

export const groupMembersSchema = z.object({ add: z.array(uuidSchema).max(200).default([]), remove: z.array(uuidSchema).max(200).default([]) }).strict();
export type GroupMembersData = z.output<typeof groupMembersSchema>;

export const listTeachingGroupsQuerySchema = z.object({ planId: uuidSchema, includeArchived: z.preprocess((v) => v === 'true' || v === true, z.boolean()).default(false) });
export const groupMembersQuerySchema = paginationQuerySchema.extend({ pageSize: z.coerce.number().int().min(1).max(200).default(100) });

// ───────────────────────────────────────────────────────────── access bundles

export const timetableAccessSchema = z
  .object({ bundles: z.array(z.enum(TIMETABLE_BUNDLES)).max(TIMETABLE_BUNDLES.length), locationIds: z.array(uuidSchema).max(50).nullable().optional() })
  .strict();
export type TimetableAccessData = z.output<typeof timetableAccessSchema>;
