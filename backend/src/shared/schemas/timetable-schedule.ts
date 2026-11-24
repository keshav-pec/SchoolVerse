import { z } from 'zod';
import { BULK_OPS, ENTRY_TYPES, GRID_VIEWS, OVERRIDABLE_RULES, RULE_CODES, SMART_DRAFT_MODES } from '../timetable-schedule';
import { WEEKDAYS } from '../timetable';
import { uuidSchema } from './common';
import { requiredText } from './fields';

/** Module 6, Part 3 — request bodies and queries. Every body is `.strict()`. */

const weekdaySchema = z.enum(WEEKDAYS, { message: 'Choose a day of the week.' });
const requestIdSchema = z.string().trim().min(1).max(80);
const ruleSchema = z.enum(RULE_CODES);

/** Options every write accepts. */
const writeOptions = {
  /** A repeated request with the same id returns the first answer and never makes a second lesson. */
  requestId: requestIdSchema.optional(),
  /** The lesson's `version` when the screen loaded it. */
  expectedVersion: z.number().int().min(1).optional(),
  /** Needed to change or remove a fixed lesson. */
  confirmUnlock: z.boolean().optional(),
  /** Accept one overridable clash, with a reason. Needs `timetable:conflict:override`. */
  override: z.object({ rule: ruleSchema, reason: requiredText('Reason', 300) }).strict().optional(),
};

const entryFields = {
  weekday: weekdaySchema,
  periodId: uuidSchema,
  entryType: z.enum(ENTRY_TYPES).default('SUBJECT'),
  subjectOfferingId: uuidSchema.optional(),
  activityName: requiredText('Activity name', 60).optional(),
  teachingGroupId: uuidSchema.optional(),
  sectionOfferingIds: z.array(uuidSchema).max(30).default([]),
  /** First is the main teacher, the rest co-teach. Left out: the teacher from Assign Classes is used. */
  teacherIds: z.array(uuidSchema).max(6).optional(),
  /** `null` means no room. Left out: the Home Classroom (or the best suitable room) is used. */
  physicalSpaceId: uuidSchema.nullable().optional(),
  isFixed: z.boolean().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
};

export const createEntrySchema = z.object({ ...entryFields, ...writeOptions }).strict();
export type CreateEntryData = z.output<typeof createEntrySchema>;

const patchFields = {
  weekday: weekdaySchema.optional(),
  periodId: uuidSchema.optional(),
  subjectOfferingId: uuidSchema.optional(),
  activityName: requiredText('Activity name', 60).nullable().optional(),
  sectionOfferingIds: z.array(uuidSchema).max(30).optional(),
  teacherIds: z.array(uuidSchema).max(6).optional(),
  physicalSpaceId: uuidSchema.nullable().optional(),
  isFixed: z.boolean().optional(),
  notes: z.string().trim().max(300).nullable().optional(),
};
export const updateEntrySchema = z.object({ ...patchFields, ...writeOptions }).strict();
export type UpdateEntryData = z.output<typeof updateEntrySchema>;

export const moveEntrySchema = z.object({ weekday: weekdaySchema.optional(), periodId: uuidSchema.optional(), swapWith: uuidSchema.optional(), ...writeOptions }).strict();
export type MoveEntryData = z.output<typeof moveEntrySchema>;

export const deleteEntrySchema = z.object({ requestId: writeOptions.requestId, expectedVersion: writeOptions.expectedVersion, confirmUnlock: writeOptions.confirmUnlock }).strict();
export type DeleteEntryData = z.output<typeof deleteEntrySchema>;

// ───────────────────────────────────────────────────────────── check (dry run)

/** The same steps a write is made of. Nothing is saved. */
export const opSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('create'), ...entryFields }).strict(),
  z.object({ op: z.literal('update'), entryId: uuidSchema, patch: z.object(patchFields).strict() }).strict(),
  z.object({ op: z.literal('move'), entryId: uuidSchema, weekday: weekdaySchema, periodId: uuidSchema }).strict(),
  z.object({ op: z.literal('delete'), entryId: uuidSchema }).strict(),
]);
export type PublicOp = z.output<typeof opSchema>;

export const checkSchema = z.object({ versionId: uuidSchema, ops: z.array(opSchema).min(1).max(200), mode: z.literal('RECURRING').default('RECURRING') }).strict();
export type CheckData = z.output<typeof checkSchema>;

// ───────────────────────────────────────────────────────────── bulk

const bulkItem = z.object({ entryId: uuidSchema, weekday: weekdaySchema.optional(), periodId: uuidSchema.optional() }).strict();
export const bulkSchema = z
  .object({
    versionId: uuidSchema,
    op: z.enum(BULK_OPS),
    items: z.array(bulkItem).max(500).default([]),
    mode: z.enum(['ALL_OR_NOTHING', 'APPLY_VALID']).default('ALL_OR_NOTHING'),
    /** SET_ROOM */
    physicalSpaceId: uuidSchema.nullable().optional(),
    /** DUPLICATE_TO and COPY_REQUIREMENTS: copy one section's lessons (or needs) to other sections. */
    fromSectionId: uuidSchema.optional(),
    toSectionIds: z.array(uuidSchema).max(60).optional(),
    /** DUPLICATE_TO: copy one day's lessons to other days. */
    fromWeekday: weekdaySchema.optional(),
    toWeekdays: z.array(weekdaySchema).max(6).optional(),
    sectionId: uuidSchema.optional(),
    requestId: writeOptions.requestId,
    confirmUnlock: writeOptions.confirmUnlock,
  })
  .strict();
export type BulkData = z.output<typeof bulkSchema>;

// ───────────────────────────────────────────────────────────── versions, grid, history

export const createVersionSchema = z.object({ versionName: requiredText('Version name', 80).optional() }).strict();
export type CreateVersionData = z.output<typeof createVersionSchema>;

export const gridQuerySchema = z.object({ view: z.enum(GRID_VIEWS).default('section'), id: uuidSchema });
export type GridQuery = z.output<typeof gridQuerySchema>;
export const sinceQuerySchema = z.object({ since: z.coerce.number().int().min(0).default(0) });
export const historyQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(100).default(30) });

export const undoSchema = z.object({ requestId: writeOptions.requestId }).strict();

// ───────────────────────────────────────────────────────────── slots and recommendations

const targetFields = {
  versionId: uuidSchema,
  sectionId: uuidSchema.optional(),
  groupId: uuidSchema.optional(),
  subjectOfferingId: uuidSchema.optional(),
};

export const slotMapSchema = z.object({ ...targetFields, entryId: uuidSchema.optional() }).strict();
export type SlotMapData = z.output<typeof slotMapSchema>;

export const recommendSlotsSchema = z.object({ ...targetFields, count: z.number().int().min(1).max(20).default(5), double: z.boolean().optional() }).strict();
export type RecommendSlotsData = z.output<typeof recommendSlotsSchema>;

export const availabilityQuerySchema = z.object({
  versionId: uuidSchema,
  weekday: weekdaySchema,
  periodId: uuidSchema,
  sectionId: uuidSchema.optional(),
  groupId: uuidSchema.optional(),
  subjectOfferingId: uuidSchema.optional(),
  /** The lesson being edited, so its own slot and room do not count as busy. */
  excludeEntryId: uuidSchema.optional(),
});
export type AvailabilityQuery = z.output<typeof availabilityQuerySchema>;

export const recommendPickSchema = z
  .object({ versionId: uuidSchema, weekday: weekdaySchema, periodId: uuidSchema, sectionId: uuidSchema.optional(), groupId: uuidSchema.optional(), subjectOfferingId: uuidSchema.optional(), excludeEntryId: uuidSchema.optional() })
  .strict();
export type RecommendPickData = z.output<typeof recommendPickSchema>;

export const explainQuerySchema = z.object({ versionId: uuidSchema, sectionId: uuidSchema.optional(), groupId: uuidSchema.optional(), subjectOfferingId: uuidSchema.optional() });
export type ExplainQuery = z.output<typeof explainQuerySchema>;

export const fixRecommendationsSchema = z.object({ versionId: uuidSchema, entryId: uuidSchema, rule: z.enum(RULE_CODES) }).strict();
export type FixRecommendationsData = z.output<typeof fixRecommendationsSchema>;

export const applyFixSchema = z.object({ versionId: uuidSchema, suggestionToken: z.string().min(10).max(4000), requestId: writeOptions.requestId }).strict();
export type ApplyFixData = z.output<typeof applyFixSchema>;

// ───────────────────────────────────────────────────────────── Smart Draft and last year's copy

export const smartDraftSchema = z.object({ mode: z.enum(SMART_DRAFT_MODES).default('FILL_GAPS'), requestId: writeOptions.requestId, confirm: z.boolean().optional() }).strict();
export type SmartDraftData = z.output<typeof smartDraftSchema>;

export const copyPreviousSchema = z.object({ mode: z.enum(['PREVIEW', 'COMMIT']).default('PREVIEW'), requestId: writeOptions.requestId }).strict();
export type CopyPreviousData = z.output<typeof copyPreviousSchema>;

export const acceptItemSchema = z
  .object({
    requestId: writeOptions.requestId,
    weekday: weekdaySchema.optional(),
    periodId: uuidSchema.optional(),
    teacherIds: z.array(uuidSchema).max(6).optional(),
    physicalSpaceId: uuidSchema.nullable().optional(),
  })
  .strict();
export type AcceptItemData = z.output<typeof acceptItemSchema>;

export const acceptGroupSchema = z.object({ runId: uuidSchema, reason: z.enum(['TEACHER_CHANGED', 'ROOM_PROBLEM', 'SUBJECT_CHANGED', 'SECTION_NOT_FOUND', 'PERIOD_NOT_FOUND', 'STILL_CLASHES']) }).strict();
export type AcceptGroupData = z.output<typeof acceptGroupSchema>;

export const isOverridable = (rule: string) => (OVERRIDABLE_RULES as readonly string[]).includes(rule);
