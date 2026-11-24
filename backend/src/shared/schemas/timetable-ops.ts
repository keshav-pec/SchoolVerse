import { z } from 'zod';
import { REPORT_TYPES, SCHEDULE_TARGETS } from '../timetable-ops';
import { RULE_CODES } from '../timetable-schedule';
import { uuidSchema } from './common';
import { requiredDateSchema, requiredText } from './fields';

/** Module 6, Part 5 — request bodies and queries. Every body is `.strict()`. */

const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const requestIdSchema = z.string().trim().min(1).max(80);
const clock = z.string().trim().regex(/^\d{1,2}:\d{2}$/, 'Use a time like 09:30.');
const reasonSchema = z.string().trim().max(300);
const overrideRule = z.object({ rule: z.enum(RULE_CODES), reason: requiredText('Reason', 300) }).strict();

// ───────────────────────────────────────────────────────────── versions

export const validateVersionSchema = z.object({}).strict();

export const publishSchema = z
  .object({
    /** The day the timetable starts. Left out: today. */
    effectiveFrom: requiredDateSchema.optional(),
    /** A tick that says "I know periods are not placed or there are warnings, and I want to publish." */
    acknowledgeWarnings: z.boolean().default(false),
  })
  .strict();
export type PublishData = z.output<typeof publishSchema>;

export const cloneVersionSchema = z.object({ versionName: requiredText('Version name', 80).optional() }).strict();
export type CloneVersionData = z.output<typeof cloneVersionSchema>;

export const compareQuerySchema = z.object({ to: uuidSchema.optional() });

// ───────────────────────────────────────────────────────────── one-day changes

const overrideCommon = { entryId: uuidSchema, date: requiredDateSchema, reason: reasonSchema.optional(), requestId: requestIdSchema.optional(), override: overrideRule.optional() };

export const createOverrideSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('SUBSTITUTE_FACULTY'), ...overrideCommon, substituteEmployeeId: uuidSchema, originalEmployeeId: uuidSchema.optional() }).strict(),
  z.object({ type: z.literal('ROOM_CHANGE'), ...overrideCommon, physicalSpaceId: uuidSchema.nullable() }).strict(),
  z.object({ type: z.literal('CLASS_CANCELLED'), ...overrideCommon, reason: requiredText('Reason', 300) }).strict(),
  z.object({ type: z.literal('PERIOD_SWAP'), ...overrideCommon, otherEntryId: uuidSchema }).strict(),
  z.object({ type: z.literal('SUBJECT_CHANGE'), ...overrideCommon, subjectOfferingId: uuidSchema, substituteEmployeeId: uuidSchema.optional() }).strict(),
  z.object({ type: z.literal('SPECIAL_ACTIVITY'), ...overrideCommon, activityName: requiredText('Activity name', 60) }).strict(),
  z.object({ type: z.literal('COMBINED_CLASS'), ...overrideCommon, withEntryId: uuidSchema }).strict(),
]);
export type CreateOverrideData = z.output<typeof createOverrideSchema>;

export const updateOverrideSchema = z
  .object({
    reason: reasonSchema.nullable().optional(),
    substituteEmployeeId: uuidSchema.optional(),
    physicalSpaceId: uuidSchema.nullable().optional(),
    subjectOfferingId: uuidSchema.optional(),
    activityName: requiredText('Activity name', 60).optional(),
    otherEntryId: uuidSchema.optional(),
    withEntryId: uuidSchema.optional(),
    override: overrideRule.optional(),
  })
  .strict();
export type UpdateOverrideData = z.output<typeof updateOverrideSchema>;

export const cancelOverrideSchema = z.object({ reason: reasonSchema.optional() }).strict();

export const listOverridesQuerySchema = z.object({
  planId: uuidSchema,
  date: requiredDateSchema.optional(),
  dateFrom: requiredDateSchema.optional(),
  dateTo: requiredDateSchema.optional(),
  type: z.enum(['SUBSTITUTE_FACULTY', 'ROOM_CHANGE', 'CLASS_CANCELLED', 'PERIOD_SWAP', 'SUBJECT_CHANGE', 'SPECIAL_ACTIVITY', 'COMBINED_CLASS']).optional(),
  status: z.enum(['ACTIVE', 'CANCELLED']).default('ACTIVE'),
});
export type ListOverridesQuery = z.output<typeof listOverridesQuerySchema>;

/** Cancel many lessons at once: some, a section's day, or the whole campus's day (the interim "day off"). */
export const cancelLessonsSchema = z
  .object({
    planId: uuidSchema,
    date: requiredDateSchema,
    reason: requiredText('Reason', 300),
    /** Only these lessons. Left out: every lesson that day (limited by `sectionIds` when given). */
    entryIds: z.array(uuidSchema).max(500).optional(),
    sectionIds: z.array(uuidSchema).max(100).optional(),
    requestId: requestIdSchema.optional(),
  })
  .strict();
export type CancelLessonsData = z.output<typeof cancelLessonsSchema>;

// ───────────────────────────────────────────────────────────── absence and substitutes

const absenceRange = {
  planId: uuidSchema,
  employeeId: uuidSchema,
  dateFrom: requiredDateSchema,
  dateTo: requiredDateSchema.optional(),
  /** Some periods only. Both or neither. */
  start: clock.optional(),
  end: clock.optional(),
};

export const recordAbsenceSchema = z.object({ ...absenceRange, reason: reasonSchema.optional() }).strict();
export type RecordAbsenceData = z.output<typeof recordAbsenceSchema>;

export const absenceImpactSchema = z.object(absenceRange).strict();
export type AbsenceImpactData = z.output<typeof absenceImpactSchema>;

export const listAbsencesQuerySchema = z.object({ planId: uuidSchema, date: requiredDateSchema.optional(), employeeId: uuidSchema.optional(), includeCancelled: flag.default(false) });
export type ListAbsencesQuery = z.output<typeof listAbsencesQuerySchema>;

const lessonOnDate = z.object({ entryId: uuidSchema, date: requiredDateSchema }).strict();

export const recommendSubstitutesSchema = z.object({ planId: uuidSchema, items: z.array(lessonOnDate).min(1).max(200) }).strict();
export type RecommendSubstitutesData = z.output<typeof recommendSubstitutesSchema>;

export const bulkSubstitutionsSchema = z
  .object({
    planId: uuidSchema,
    items: z.array(lessonOnDate.extend({ substituteEmployeeId: uuidSchema }).strict()).min(1).max(200),
    reason: reasonSchema.optional(),
    requestId: requestIdSchema.optional(),
  })
  .strict();
export type BulkSubstitutionsData = z.output<typeof bulkSubstitutionsSchema>;

// ───────────────────────────────────────────────────────────── room changes

export const roomImpactSchema = z.object({ planId: uuidSchema, physicalSpaceId: uuidSchema, dateFrom: requiredDateSchema, dateTo: requiredDateSchema.optional() }).strict();
export type RoomImpactData = z.output<typeof roomImpactSchema>;

export const recommendDayRoomsSchema = z.object({ planId: uuidSchema, items: z.array(lessonOnDate).min(1).max(200), avoidRoomId: uuidSchema.optional() }).strict();
export type RecommendDayRoomsData = z.output<typeof recommendDayRoomsSchema>;

export const applyRoomChangesSchema = z
  .object({
    planId: uuidSchema,
    items: z.array(lessonOnDate.extend({ physicalSpaceId: uuidSchema }).strict()).min(1).max(200),
    reason: reasonSchema.optional(),
    requestId: requestIdSchema.optional(),
  })
  .strict();
export type ApplyRoomChangesData = z.output<typeof applyRoomChangesSchema>;

// ───────────────────────────────────────────────────────────── reading the day

export const dailyQuerySchema = z
  .object({ planId: uuidSchema.optional(), locationId: uuidSchema.optional(), date: requiredDateSchema.optional() })
  .refine((q) => Boolean(q.planId) !== Boolean(q.locationId), { message: 'Choose a plan or a campus.' });
export type DailyQuery = z.output<typeof dailyQuerySchema>;

export const effectiveQuerySchema = z
  .object({
    date: requiredDateSchema.optional(),
    from: requiredDateSchema.optional(),
    to: requiredDateSchema.optional(),
    sectionId: uuidSchema.optional(),
    /** A teacher's id, or `me` for the signed-in teacher. */
    employeeId: z.union([uuidSchema, z.literal('me')]).optional(),
    physicalSpaceId: uuidSchema.optional(),
    studentId: uuidSchema.optional(),
    groupId: uuidSchema.optional(),
    planId: uuidSchema.optional(),
  })
  .refine((q) => [q.sectionId, q.employeeId, q.physicalSpaceId, q.studentId, q.groupId].filter(Boolean).length === 1, { message: 'Choose one of section, teacher, room, student or group.' });
export type EffectiveQuery = z.output<typeof effectiveQuerySchema>;

export const viewQuerySchema = z.object({ date: requiredDateSchema.optional(), from: requiredDateSchema.optional(), to: requiredDateSchema.optional(), versionId: uuidSchema.optional(), week: flag.default(true) });
export type ViewQuery = z.output<typeof viewQuerySchema>;

export const reportQuerySchema = z.object({
  planId: uuidSchema,
  format: z.enum(['json', 'csv']).default('json'),
  dateFrom: requiredDateSchema.optional(),
  dateTo: requiredDateSchema.optional(),
  versionId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
  employeeId: uuidSchema.optional(),
});
export type ReportQuery = z.output<typeof reportQuerySchema>;
export const reportTypeParams = z.object({ type: z.enum(REPORT_TYPES) });

export const overviewQuerySchema = z.object({ locationId: uuidSchema, academicSessionId: uuidSchema.optional() });
export type OverviewQuery = z.output<typeof overviewQuerySchema>;

export const scheduleTargetSchema = z.enum(SCHEDULE_TARGETS);
