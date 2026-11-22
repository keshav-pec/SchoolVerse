import { z } from 'zod';
import {
  BLOCK_REASON_CODES,
  BLOCK_TYPES,
  BUILDING_TYPES,
  FLOOR_LEVEL_TYPES,
  SPACE_FEATURE_CODES,
  SPACE_IMPORT_FIELDS,
  SPACE_STATUSES,
  SPACE_TARGET_STATUSES,
  STRUCTURE_TARGET_STATUSES,
  SUITABILITY_TAG_CODES,
} from '../spaces';
import { paginationQuerySchema, uuidSchema } from './common';
import { optionalDateSchema, optionalText, requiredText } from './fields';

/**
 * Module 5, Part 1 — request bodies and queries for buildings, floors, rooms, space types, generators, import and availability.
 * Every body is `.strict()`: a stray `tenantId`, `status` or `effectiveStatus` is a validation error. Rooms never take a section strength
 * or a Home Classroom from the client.
 */

const emptyToNull = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
const csv = <T extends z.ZodType>(item: T) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(item));
const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

// ───────────────────────────────────────────────────────────── building blocks

export const SPACE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;
export const SPACE_CODE_MESSAGE = 'Use letters, numbers, dots or hyphens, up to 20 characters. Example: A-101.';

/** A code typed by hand: trimmed, upper-case. Empty means "make one for me". */
export const spaceCodeSchema = z.preprocess(
  (v) => (typeof v === 'string' ? (v.trim() === '' ? null : v.trim().toUpperCase()) : v),
  z.string().regex(SPACE_CODE_PATTERN, { message: SPACE_CODE_MESSAGE }).nullable(),
);
const optionalCode = spaceCodeSchema.optional();

/** A seat count. A positive whole number, or empty. The service rejects anything else with `CAPACITY_INVALID`. */
const capacitySchema = z.preprocess(emptyToNull, z.number({ message: 'Enter a whole number, for example 40.' }).nullable()).optional();

const featureList = z.array(z.enum(SPACE_FEATURE_CODES)).max(SPACE_FEATURE_CODES.length);
const tagList = z.array(z.enum(SUITABILITY_TAG_CODES)).max(SUITABILITY_TAG_CODES.length);
const idList = (max: number) => z.array(uuidSchema).min(1, { message: 'Choose at least one room.' }).max(max, { message: `Choose at most ${max} rooms at once.` });

const versionField = z.number({ message: 'Version is required.' }).int().min(1);
const nameField = (label: string) => requiredText(label, 100);

// ───────────────────────────────────────────────────────────── buildings

export const createBuildingSchema = z
  .object({
    buildingName: nameField('Building name'),
    buildingCode: optionalCode,
    buildingType: z.enum(BUILDING_TYPES).default('ACADEMIC'),
    status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
    effectiveFrom: optionalDateSchema,
    effectiveTo: optionalDateSchema,
    displayOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();
export type CreateBuildingData = z.output<typeof createBuildingSchema>;

export const updateBuildingSchema = z
  .object({
    version: versionField,
    buildingName: nameField('Building name').optional(),
    buildingType: z.enum(BUILDING_TYPES).optional(),
    effectiveFrom: optionalDateSchema,
    effectiveTo: optionalDateSchema,
    displayOrder: z.number().int().min(0).max(9999).optional(),
  })
  .strict();
export type UpdateBuildingData = z.output<typeof updateBuildingSchema>;

export const structureStatusSchema = z.object({ to: z.enum(STRUCTURE_TARGET_STATUSES) }).strict();
export type StructureStatusData = z.output<typeof structureStatusSchema>;

// ───────────────────────────────────────────────────────────── floors

export const createFloorSchema = z
  .object({
    floorName: nameField('Floor name'),
    floorCode: optionalCode,
    floorNumber: z.number({ message: 'Floor number is required.' }).int().min(-5).max(100),
    levelType: z.enum(FLOOR_LEVEL_TYPES).optional(),
    status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
    effectiveFrom: optionalDateSchema,
    effectiveTo: optionalDateSchema,
  })
  .strict();
export type CreateFloorData = z.output<typeof createFloorSchema>;

/** "Ground, First, Second": a name is enough. The number and kind are read from the name when left out. */
export const bulkFloorsSchema = z
  .object({
    floors: z
      .array(z.object({ name: nameField('Floor name'), floorNumber: z.number().int().min(-5).max(100).optional(), levelType: z.enum(FLOOR_LEVEL_TYPES).optional() }).strict())
      .min(1, { message: 'Add at least one floor.' })
      .max(30, { message: 'Add at most 30 floors at once.' }),
  })
  .strict();
export type BulkFloorsData = z.output<typeof bulkFloorsSchema>;

export const updateFloorSchema = z
  .object({
    version: versionField,
    floorName: nameField('Floor name').optional(),
    floorNumber: z.number().int().min(-5).max(100).optional(),
    levelType: z.enum(FLOOR_LEVEL_TYPES).optional(),
    effectiveFrom: optionalDateSchema,
    effectiveTo: optionalDateSchema,
  })
  .strict();
export type UpdateFloorData = z.output<typeof updateFloorSchema>;

// ───────────────────────────────────────────────────────────── space types

const typeShape = {
  isSchedulable: z.boolean(),
  isHomeClassroomEligible: z.boolean(),
  defaultSuitabilityTags: tagList,
  defaultAcademicCapacity: capacitySchema,
};

export const createSpaceTypeSchema = z
  .object({
    name: nameField('Type name'),
    code: optionalCode,
    isOutdoor: z.boolean().default(false),
    ...typeShape,
    defaultSuitabilityTags: tagList.default([]),
  })
  .strict();
export type CreateSpaceTypeData = z.output<typeof createSpaceTypeSchema>;

export const updateSpaceTypeSchema = z
  .object({ name: nameField('Type name').optional(), isSchedulable: typeShape.isSchedulable.optional(), isHomeClassroomEligible: typeShape.isHomeClassroomEligible.optional(), defaultSuitabilityTags: tagList.optional(), defaultAcademicCapacity: capacitySchema })
  .strict();
export type UpdateSpaceTypeData = z.output<typeof updateSpaceTypeSchema>;

// ───────────────────────────────────────────────────────────── rooms

const spaceFields = {
  spaceName: nameField('Room name'),
  roomNumber: optionalText(20),
  physicalCapacity: capacitySchema,
  academicCapacity: capacitySchema,
  examCapacity: capacitySchema,
  /** `null` = follow the Space Type. */
  schedulableOverride: z.boolean().nullable().optional(),
  homeClassroomEligibleOverride: z.boolean().nullable().optional(),
  features: featureList.optional(),
  /** `null` = follow the Space Type. */
  suitabilityOverrides: tagList.nullable().optional(),
};

export const createSpaceSchema = z
  .object({
    locationId: uuidSchema,
    buildingId: uuidSchema.nullable().optional(),
    floorId: uuidSchema.nullable().optional(),
    spaceTypeId: uuidSchema,
    spaceCode: optionalCode,
    status: z.enum(['DRAFT', 'ACTIVE']).default('ACTIVE'),
    ...spaceFields,
  })
  .strict();
export type CreateSpaceData = z.output<typeof createSpaceSchema>;

export const bulkCreateSpacesSchema = z.object({ spaces: z.array(createSpaceSchema).min(1, { message: 'Add at least one room.' }).max(200, { message: 'Add at most 200 rooms at once.' }) }).strict();
export type BulkCreateSpacesData = z.output<typeof bulkCreateSpacesSchema>;

/** A type change is a conversion: it needs `confirm: true`. A rename is just a new `spaceName`. */
export const updateSpaceSchema = z
  .object({
    version: versionField,
    spaceName: spaceFields.spaceName.optional(),
    roomNumber: spaceFields.roomNumber,
    spaceTypeId: uuidSchema.optional(),
    confirm: z.boolean().optional(),
    physicalCapacity: capacitySchema,
    academicCapacity: capacitySchema,
    examCapacity: capacitySchema,
    schedulableOverride: spaceFields.schedulableOverride,
    homeClassroomEligibleOverride: spaceFields.homeClassroomEligibleOverride,
    suitabilityOverrides: spaceFields.suitabilityOverrides,
    features: featureList.optional(),
  })
  .strict();
export type UpdateSpaceData = z.output<typeof updateSpaceSchema>;

export const convertTypePreviewSchema = z.object({ spaceTypeId: uuidSchema }).strict();
export type ConvertTypePreviewData = z.output<typeof convertTypePreviewSchema>;

export const spaceStatusSchema = z.object({ to: z.enum(SPACE_TARGET_STATUSES), reason: optionalText(300) }).strict();
export type SpaceStatusData = z.output<typeof spaceStatusSchema>;

export const featureChangeSchema = z.object({ add: featureList.default([]), remove: featureList.default([]) }).strict();
export type FeatureChangeData = z.output<typeof featureChangeSchema>;
export const tagChangeSchema = z.object({ add: tagList.default([]), remove: tagList.default([]) }).strict();
export type TagChangeData = z.output<typeof tagChangeSchema>;

export const bulkFeatureChangeSchema = z.object({ ids: idList(200), add: featureList.default([]), remove: featureList.default([]) }).strict();
export type BulkFeatureChangeData = z.output<typeof bulkFeatureChangeSchema>;
export const bulkTagChangeSchema = z.object({ ids: idList(200), add: tagList.default([]), remove: tagList.default([]) }).strict();
export type BulkTagChangeData = z.output<typeof bulkTagChangeSchema>;

export const bulkEditChangesSchema = z
  .object({
    spaceTypeId: uuidSchema.optional(),
    physicalCapacity: capacitySchema,
    academicCapacity: capacitySchema,
    examCapacity: capacitySchema,
    addFeatures: featureList.optional(),
    removeFeatures: featureList.optional(),
    addTags: tagList.optional(),
    removeTags: tagList.optional(),
    status: z.enum(SPACE_TARGET_STATUSES).optional(),
    schedulableOverride: spaceFields.schedulableOverride,
    homeClassroomEligibleOverride: spaceFields.homeClassroomEligibleOverride,
  })
  .strict();

/** `dryRun` answers "12 rooms will change" without changing anything. A type change needs `confirm`. */
export const bulkEditSchema = z
  .object({ ids: idList(200), changes: bulkEditChangesSchema, confirm: z.boolean().optional(), dryRun: z.boolean().optional() })
  .strict()
  .refine((v) => Object.values(v.changes).some((x) => x !== undefined), { message: 'Choose what to change.', path: ['changes'] });
export type BulkEditData = z.output<typeof bulkEditSchema>;

export const moveSpaceSchema = z.object({ buildingId: uuidSchema, floorId: uuidSchema, reason: requiredText('Reason', 300) }).strict();
export type MoveSpaceData = z.output<typeof moveSpaceSchema>;

export const archiveSpaceSchema = z.object({ reason: optionalText(300) }).strict();
export type ArchiveSpaceData = z.output<typeof archiveSpaceSchema>;

// ───────────────────────────────────────────────────────────── list and filters

export const listSpacesQuerySchema = z.object({
  page: paginationQuerySchema.shape.page,
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  q: z.string().trim().max(100).optional(),
  locationId: uuidSchema.optional(),
  buildingId: uuidSchema.optional(),
  floorId: uuidSchema.optional(),
  spaceTypeId: uuidSchema.optional(),
  status: csv(z.enum(SPACE_STATUSES)).optional(),
  schedulable: flag.optional(),
  homeClassroomEligible: flag.optional(),
  feature: z.enum(SPACE_FEATURE_CODES).optional(),
  tag: z.enum(SUITABILITY_TAG_CODES).optional(),
  missingCapacity: flag.optional(),
  /** Rooms with no building: playgrounds, assembly grounds. */
  outdoor: flag.optional(),
});
export type ListSpacesQuery = z.output<typeof listSpacesQuerySchema>;

export const spaceTreeQuerySchema = z.object({ includeArchived: flag.optional() });
export type SpaceTreeQuery = z.output<typeof spaceTreeQuerySchema>;

// ───────────────────────────────────────────────────────────── generator, duplicate floor, copy campus

const rangeNumber = z.number({ message: 'Enter a whole number.' }).int().min(0).max(99999);

/** Either a number range (`from`–`to`, with an optional prefix) or a list of names. */
export const generateSpacesSchema = z
  .object({
    from: rangeNumber.optional(),
    to: rangeNumber.optional(),
    prefix: z.preprocess(emptyToNull, z.string().trim().toUpperCase().max(10, { message: 'Use at most 10 characters.' }).nullable()).optional(),
    names: z.array(requiredText('Name', 100)).min(1).max(100).optional(),
    spaceTypeId: uuidSchema,
    physicalCapacity: capacitySchema,
    academicCapacity: capacitySchema,
  })
  .strict()
  .superRefine((v, ctx) => {
    const hasRange = v.from !== undefined && v.to !== undefined;
    if (!hasRange && !v.names) ctx.addIssue({ code: 'custom', path: ['from'], message: 'Enter a start and end number, or a list of names.' });
    if (hasRange && v.names) ctx.addIssue({ code: 'custom', path: ['names'], message: 'Use a number range or a list of names, not both.' });
    if (hasRange && v.to! < v.from!) ctx.addIssue({ code: 'custom', path: ['to'], message: 'The end number must not be smaller than the start.' });
    if (hasRange && v.to! - v.from! >= 200) ctx.addIssue({ code: 'custom', path: ['to'], message: 'Make at most 200 rooms at once.' });
  });
export type GenerateSpacesData = z.output<typeof generateSpacesSchema>;

export const duplicateFloorSchema = z
  .object({ targetFloorId: uuidSchema, transform: z.object({ add: z.number().int().min(-10000).max(10000) }).strict().default({ add: 0 }) })
  .strict();
export type DuplicateFloorData = z.output<typeof duplicateFloorSchema>;

export const copyStructureSchema = z.object({ fromLocationId: uuidSchema }).strict();
export type CopyStructureData = z.output<typeof copyStructureSchema>;

// ───────────────────────────────────────────────────────────── import

/** The mapping is `{ field: column header | null }`. The server suggests it from common headers. */
export const spaceImportMappingSchema = z.object(Object.fromEntries(SPACE_IMPORT_FIELDS.map((f) => [f, z.string().trim().max(120).nullable().optional()]))).strict();
export type SpaceImportMappingData = z.output<typeof spaceImportMappingSchema>;

export const createSpaceImportFieldsSchema = z.object({ locationId: uuidSchema });
export type CreateSpaceImportFields = z.output<typeof createSpaceImportFieldsSchema>;

export const mapSpaceImportSchema = z.object({ mapping: spaceImportMappingSchema }).strict();
export type MapSpaceImportData = z.output<typeof mapSpaceImportSchema>;

export const spaceImportRowsQuerySchema = paginationQuerySchema.extend({ status: z.enum(['READY', 'NEEDS_ATTENTION', 'IMPORTED', 'SKIPPED']).optional() });
export type SpaceImportRowsQuery = z.output<typeof spaceImportRowsQuerySchema>;

// ───────────────────────────────────────────────────────────── availability

/** `start` and `end` are date-times (ISO 8601). */
const dateTime = (label: string) =>
  z
    .string({ message: `${label} is required.` })
    .trim()
    .min(1, { message: `${label} is required.` })
    .refine((v) => !Number.isNaN(Date.parse(v)), { message: 'Enter a valid date and time.' });

export const createAvailabilityBlockSchema = z
  .object({
    blockType: z.enum(BLOCK_TYPES).default('UNAVAILABLE'),
    startDatetime: dateTime('Start'),
    endDatetime: dateTime('End'),
    reasonCode: z.enum(BLOCK_REASON_CODES),
    reason: optionalText(300),
    /** Stored, not evaluated yet (one-off blocks only). */
    recurrenceRule: optionalText(200),
  })
  .strict()
  .refine((v) => Date.parse(v.endDatetime) > Date.parse(v.startDatetime), { message: 'The end must be after the start.', path: ['endDatetime'] });
export type CreateAvailabilityBlockData = z.output<typeof createAvailabilityBlockSchema>;

export const availabilityCheckSchema = z
  .object({ physicalSpaceId: uuidSchema, start: dateTime('Start'), end: dateTime('End') })
  .strict()
  .refine((v) => Date.parse(v.end) > Date.parse(v.start), { message: 'The end must be after the start.', path: ['end'] });
export type AvailabilityCheckData = z.output<typeof availabilityCheckSchema>;

export const listBlocksQuerySchema = z.object({ includeCancelled: flag.optional() });
export type ListBlocksQuery = z.output<typeof listBlocksQuerySchema>;

export const spaceHistoryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(100) });
export type SpaceHistoryQuery = z.output<typeof spaceHistoryQuerySchema>;
