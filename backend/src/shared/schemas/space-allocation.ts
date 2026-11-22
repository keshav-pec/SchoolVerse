import { z } from 'zod';
import { ASSIGNMENT_SOURCES, BULK_ASSIGNMENT_SOURCES, RECOMMENDATION_PURPOSES, REPLACE_MODES, SPACE_REPORT_TYPES, SUITABILITY_TAG_CODES } from '../spaces';
import { paginationQuerySchema, uuidSchema } from './common';
import { optionalDateSchema, optionalText, requiredDateSchema, requiredText } from './fields';

/**
 * Module 5, Part 3 — request bodies and queries for Home Classroom assignments, recommendations, rollover, replacement, readiness,
 * Needs Attention and reports. Every body is `.strict()`. A section's strength and a room's seats are never taken from the client:
 * the server counts them.
 */

const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());
const emptyToNull = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
const dateTime = (label: string) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .min(1, { message: `${label} is required.` })
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Enter a valid date and time.' });

/** There is no Shift module yet, so a shift is an opaque label the school gives. Two different shifts may share a room. */
const shiftField = z.preprocess(emptyToNull, z.string().trim().max(64).nullable()).optional();

/** "Keep Room Anyway": the reason is required and is audited. */
export const capacityOverrideSchema = z.object({ reason: requiredText('Reason', 300) }).strict();
export type CapacityOverrideData = z.output<typeof capacityOverrideSchema>;

// ───────────────────────────────────────────────────────────── assignments

const assignmentFields = {
  physicalSpaceId: uuidSchema,
  /** Leave out to start today (or the session start, when the session has not begun). */
  effectiveFrom: optionalDateSchema,
  /** Leave out to keep the room until the session ends. */
  effectiveTo: optionalDateSchema,
  shiftId: shiftField,
  reason: optionalText(300),
  capacityOverride: capacityOverrideSchema.optional(),
  /** Change the room: the section's old row ends the day before and this one starts. Without it an existing Home Classroom is refused. */
  replaceExisting: z.boolean().optional(),
};

export const createAssignmentSchema = z
  .object({
    sectionOfferingId: uuidSchema,
    /** Optional: when sent it must match the section's own session. */
    academicSessionId: uuidSchema.optional(),
    ...assignmentFields,
  })
  .strict();
export type CreateAssignmentData = z.output<typeof createAssignmentSchema>;

export const updateAssignmentSchema = z
  .object({
    version: z.number({ message: 'Version is required.' }).int().min(1),
    effectiveFrom: requiredDateSchema.optional(),
    effectiveTo: optionalDateSchema,
    shiftId: shiftField,
    reason: optionalText(300),
    capacityOverride: capacityOverrideSchema.optional(),
  })
  .strict();
export type UpdateAssignmentData = z.output<typeof updateAssignmentSchema>;

export const endHomeClassroomSchema = z.object({ effectiveTo: requiredDateSchema, reason: optionalText(300) }).strict();
export type EndHomeClassroomData = z.output<typeof endHomeClassroomSchema>;

export const replaceAssignmentSchema = z
  .object({
    physicalSpaceId: uuidSchema,
    effectiveFrom: optionalDateSchema,
    shiftId: shiftField,
    reason: optionalText(300),
    capacityOverride: capacityOverrideSchema.optional(),
  })
  .strict();
export type ReplaceAssignmentData = z.output<typeof replaceAssignmentSchema>;

export const bulkAssignmentItemSchema = z
  .object({
    sectionOfferingId: uuidSchema,
    physicalSpaceId: uuidSchema,
    effectiveFrom: optionalDateSchema,
    effectiveTo: optionalDateSchema,
    shiftId: shiftField,
    reason: optionalText(300),
    capacityOverride: capacityOverrideSchema.optional(),
    replaceExisting: z.boolean().optional(),
  })
  .strict();

/** Each item stands alone: the ones that pass are saved, the others come back as `failed` with the reason. */
export const bulkAssignmentsSchema = z
  .object({
    items: z.array(bulkAssignmentItemSchema).min(1, { message: 'Choose at least one section.' }).max(200, { message: 'Save at most 200 sections at once.' }),
    source: z.enum(BULK_ASSIGNMENT_SOURCES).default('BULK'),
  })
  .strict();
export type BulkAssignmentsData = z.output<typeof bulkAssignmentsSchema>;

export const listAssignmentsQuerySchema = z.object({
  page: paginationQuerySchema.shape.page,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  academicSessionId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  sectionOfferingId: uuidSchema.optional(),
  physicalSpaceId: uuidSchema.optional(),
  /** `current` = in force today, `planned` = starts later, `ended`, `cancelled`. Leave out for everything. */
  phase: z.enum(['current', 'planned', 'ended', 'cancelled']).optional(),
  source: z.enum(ASSIGNMENT_SOURCES).optional(),
});
export type ListAssignmentsQuery = z.output<typeof listAssignmentsQuerySchema>;

export const sectionHomeClassroomQuerySchema = z.object({ date: requiredDateSchema.optional() });
export type SectionHomeClassroomQuery = z.output<typeof sectionHomeClassroomQuerySchema>;

// ───────────────────────────────────────────────────────────── recommendations

export const homeClassroomRecommendationsSchema = z
  .object({
    sessionId: uuidSchema,
    locationId: uuidSchema,
    sectionOfferingIds: z.array(uuidSchema).min(1).max(500).optional(),
  })
  .strict();
export type HomeClassroomRecommendationsData = z.output<typeof homeClassroomRecommendationsSchema>;

/** Ranks rooms for another purpose. `HOME_CLASSROOM` and `TIMETABLE` look at seats for classes; `EXAM` looks at exam capacity. */
export const recommendRoomsSchema = z
  .object({
    purpose: z.enum(RECOMMENDATION_PURPOSES),
    locationId: uuidSchema,
    start: dateTime('Start').optional(),
    end: dateTime('End').optional(),
    minCapacity: z.number().int().min(1).max(100000).optional(),
    suitability: z.array(z.enum(SUITABILITY_TAG_CODES)).max(12).optional(),
    spaceTypeId: uuidSchema.optional(),
    limit: z.number().int().min(1).max(50).default(10),
  })
  .strict()
  .refine((v) => (v.start === undefined) === (v.end === undefined), { message: 'Send both a start and an end, or neither.', path: ['end'] })
  .refine((v) => v.start === undefined || v.end === undefined || Date.parse(v.end) > Date.parse(v.start), { message: 'The end must be after the start.', path: ['end'] });
export type RecommendRoomsData = z.output<typeof recommendRoomsSchema>;

export const availableRoomsQuerySchema = z
  .object({
    locationId: uuidSchema,
    start: dateTime('Start'),
    end: dateTime('End'),
    minCapacity: z.coerce.number().int().min(1).max(100000).optional(),
    suitability: z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(z.enum(SUITABILITY_TAG_CODES))).optional(),
    spaceTypeId: uuidSchema.optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .refine((v) => Date.parse(v.end) > Date.parse(v.start), { message: 'The end must be after the start.', path: ['end'] });
export type AvailableRoomsQuery = z.output<typeof availableRoomsQuerySchema>;

// ───────────────────────────────────────────────────────────── rollover

export const rolloverSchema = z
  .object({ fromSessionId: uuidSchema, toSessionId: uuidSchema, locationId: uuidSchema })
  .strict()
  .refine((v) => v.fromSessionId !== v.toSessionId, { message: 'Choose two different sessions.', path: ['toSessionId'] });
export type RolloverData = z.output<typeof rolloverSchema>;

// ───────────────────────────────────────────────────────────── replace a room, readiness, attention, reports

export const replaceRoomSchema = z
  .object({ mode: z.enum(REPLACE_MODES), replacementSpaceId: uuidSchema.optional(), reason: optionalText(300), capacityOverride: capacityOverrideSchema.optional() })
  .strict()
  .refine((v) => v.mode !== 'NOW' || v.replacementSpaceId !== undefined, { message: 'Choose the room that takes over.', path: ['replacementSpaceId'] });
export type ReplaceRoomData = z.output<typeof replaceRoomSchema>;

export const readinessQuerySchema = z.object({ locationId: uuidSchema });
export type ReadinessQuery = z.output<typeof readinessQuerySchema>;

export const attentionQuerySchema = z.object({ locationId: uuidSchema.optional(), sessionId: uuidSchema.optional() });
export type AttentionQuery = z.output<typeof attentionQuerySchema>;

export const spaceReportParamsSchema = z.object({ type: z.enum(SPACE_REPORT_TYPES) });
export const spaceReportQuerySchema = z.object({
  locationId: uuidSchema.optional(),
  sessionId: uuidSchema.optional(),
  format: z.enum(['json', 'csv']).default('json'),
  includeCancelled: flag.optional(),
});
export type SpaceReportQuery = z.output<typeof spaceReportQuerySchema>;
