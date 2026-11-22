import { Schema, model } from 'mongoose';
import {
  BLOCK_REASON_CODES,
  BLOCK_STATUSES,
  BLOCK_TYPES,
  BUILDING_TYPES,
  FLOOR_LEVEL_TYPES,
  SPACE_CHANGE_TYPES,
  SPACE_FEATURE_CODES,
  SPACE_IMPORT_ISSUE_CODES,
  SPACE_IMPORT_ROW_STATUSES,
  SPACE_IMPORT_STATUSES,
  SPACE_STATUSES,
  STRUCTURE_STATUSES,
  SUITABILITY_TAG_CODES,
  type BlockReasonCode,
  type BlockStatus,
  type BlockType,
  type BuildingType,
  type FloorLevelType,
  type SpaceChangeType,
  type SpaceFeatureCode,
  type SpaceImportField,
  type SpaceImportIssueCode,
  type SpaceImportRowStatus,
  type SpaceImportStatus,
  type SpaceStatus,
  type StructureStatus,
  type SuitabilityTagCode,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Module 5 collections. There is ONE room list, `physical_spaces`; every other module stores `physicalSpaceId` and nothing more.
 *
 *   locations → buildings → floors → physical_spaces        (outdoor spaces have no building or floor)
 *   space_types hold the defaults a room inherits; a room stores only its exceptions (nullable `…Override` fields)
 *
 * Status is stored per row. Whether a room is usable (its floor or building may be inactive) is worked out when it is read.
 */

// ───────────────────────────────────────────────────────────── buildings

export interface BuildingDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  locationId: string;
  buildingCode: string;
  buildingName: string;
  buildingType: BuildingType;
  status: StructureStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  displayOrder: number;
  version: number;
}

const buildingSchema = new Schema<BuildingDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    buildingCode: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    buildingName: { type: String, required: true, trim: true, maxlength: 100 },
    buildingType: { type: String, enum: BUILDING_TYPES, default: 'ACADEMIC' },
    status: { type: String, enum: STRUCTURE_STATUSES, default: 'ACTIVE' },
    effectiveFrom: { type: String, default: null },
    effectiveTo: { type: String, default: null },
    displayOrder: { type: Number, default: 0 },
    version: { type: Number, default: 1 },
    ...auditFields,
  },
  baseSchemaOptions('buildings'),
);
buildingSchema.index({ tenantId: 1, locationId: 1, buildingCode: 1 }, { unique: true });
buildingSchema.plugin(tenantScopePlugin);
export const Building = model<BuildingDoc>('Building', buildingSchema);

// ───────────────────────────────────────────────────────────── floors

export interface FloorDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  /** Copied from the building, so a location scope check does not need a second lookup. */
  locationId: string;
  buildingId: string;
  floorCode: string;
  floorName: string;
  floorNumber: number;
  levelType: FloorLevelType;
  status: StructureStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  version: number;
}

const floorSchema = new Schema<FloorDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    buildingId: { type: String, required: true, immutable: true },
    floorCode: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    floorName: { type: String, required: true, trim: true, maxlength: 100 },
    floorNumber: { type: Number, required: true },
    levelType: { type: String, enum: FLOOR_LEVEL_TYPES, default: 'UPPER' },
    status: { type: String, enum: STRUCTURE_STATUSES, default: 'ACTIVE' },
    effectiveFrom: { type: String, default: null },
    effectiveTo: { type: String, default: null },
    version: { type: Number, default: 1 },
    ...auditFields,
  },
  baseSchemaOptions('floors'),
);
floorSchema.index({ tenantId: 1, buildingId: 1, floorCode: 1 }, { unique: true });
floorSchema.index({ tenantId: 1, locationId: 1 });
floorSchema.plugin(tenantScopePlugin);
export const Floor = model<FloorDoc>('Floor', floorSchema);

// ───────────────────────────────────────────────────────────── space types

export interface SpaceTypeDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  code: string;
  name: string;
  isSchedulable: boolean;
  isHomeClassroomEligible: boolean;
  defaultSuitabilityTags: SuitabilityTagCode[];
  defaultAcademicCapacity: number | null;
  isOutdoor: boolean;
  isSystem: boolean;
  status: 'ACTIVE' | 'INACTIVE';
}

const spaceTypeSchema = new Schema<SpaceTypeDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    code: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    isSchedulable: { type: Boolean, required: true },
    isHomeClassroomEligible: { type: Boolean, required: true },
    defaultSuitabilityTags: { type: [{ type: String, enum: SUITABILITY_TAG_CODES }], default: [] },
    defaultAcademicCapacity: { type: Number, default: null },
    isOutdoor: { type: Boolean, default: false, immutable: true },
    isSystem: { type: Boolean, default: false, immutable: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    ...auditFields,
  },
  baseSchemaOptions('space_types'),
);
spaceTypeSchema.index({ tenantId: 1, code: 1 }, { unique: true });
spaceTypeSchema.plugin(tenantScopePlugin);
export const SpaceType = model<SpaceTypeDoc>('SpaceType', spaceTypeSchema);

// ───────────────────────────────────────────────────────────── physical spaces (rooms)

export interface PhysicalSpaceDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  locationId: string;
  buildingId: string | null;
  floorId: string | null;
  spaceCode: string;
  spaceName: string;
  roomNumber: string | null;
  spaceTypeId: string;
  physicalCapacity: number | null;
  academicCapacity: number | null;
  examCapacity: number | null;
  /** `null` = follow the Space Type. */
  schedulableOverride: boolean | null;
  homeClassroomEligibleOverride: boolean | null;
  features: SpaceFeatureCode[];
  /** `null` = follow the Space Type. */
  suitabilityOverrides: SuitabilityTagCode[] | null;
  operationalStatus: SpaceStatus;
  /** From this date the room counts as archived. Set by "Archive After Current Session" (Part 3); worked out from the date. */
  archiveAfterDate: string | null;
  /** Set when the type changed, so the Timetable module re-checks the room. */
  readinessRecheckAt: Date | null;
  version: number;
}

const physicalSpaceSchema = new Schema<PhysicalSpaceDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    buildingId: { type: String, default: null },
    floorId: { type: String, default: null },
    spaceCode: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    spaceName: { type: String, required: true, trim: true, maxlength: 100 },
    roomNumber: { type: String, default: null, maxlength: 20 },
    spaceTypeId: { type: String, required: true },
    physicalCapacity: { type: Number, default: null },
    academicCapacity: { type: Number, default: null },
    examCapacity: { type: Number, default: null },
    schedulableOverride: { type: Boolean, default: null },
    homeClassroomEligibleOverride: { type: Boolean, default: null },
    features: { type: [{ type: String, enum: SPACE_FEATURE_CODES }], default: [] },
    suitabilityOverrides: { type: [{ type: String, enum: SUITABILITY_TAG_CODES }], default: null },
    operationalStatus: { type: String, enum: SPACE_STATUSES, default: 'ACTIVE' },
    archiveAfterDate: { type: String, default: null },
    readinessRecheckAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
    ...auditFields,
  },
  baseSchemaOptions('physical_spaces'),
);
// The same room number may exist in two buildings; the code must differ (A-101, B-101).
physicalSpaceSchema.index({ tenantId: 1, locationId: 1, spaceCode: 1 }, { unique: true });
physicalSpaceSchema.index({ tenantId: 1, locationId: 1, operationalStatus: 1 });
physicalSpaceSchema.index({ tenantId: 1, floorId: 1 });
physicalSpaceSchema.index({ tenantId: 1, buildingId: 1 });
physicalSpaceSchema.index({ tenantId: 1, spaceTypeId: 1 });
physicalSpaceSchema.plugin(tenantScopePlugin);
export const PhysicalSpace = model<PhysicalSpaceDoc>('PhysicalSpace', physicalSpaceSchema);

// ───────────────────────────────────────────────────────────── availability blocks

export interface SpaceAvailabilityBlockDoc extends BaseDoc, AuditFields {
  tenantId: string;
  physicalSpaceId: string;
  locationId: string;
  blockType: BlockType;
  startDatetime: Date;
  endDatetime: Date;
  reasonCode: BlockReasonCode;
  reason: string | null;
  recurrenceRule: string | null;
  status: BlockStatus;
  cancelledAt: Date | null;
  cancelledBy: string | null;
}

const blockSchema = new Schema<SpaceAvailabilityBlockDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    physicalSpaceId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    blockType: { type: String, enum: BLOCK_TYPES, default: 'UNAVAILABLE' },
    startDatetime: { type: Date, required: true },
    endDatetime: { type: Date, required: true },
    reasonCode: { type: String, enum: BLOCK_REASON_CODES, required: true },
    reason: { type: String, default: null, maxlength: 300 },
    recurrenceRule: { type: String, default: null, maxlength: 200 },
    status: { type: String, enum: BLOCK_STATUSES, default: 'ACTIVE' },
    cancelledAt: { type: Date, default: null },
    cancelledBy: { type: String, default: null },
    ...auditFields,
  },
  baseSchemaOptions('space_availability_blocks'),
);
blockSchema.index({ tenantId: 1, physicalSpaceId: 1, startDatetime: 1 });
blockSchema.index({ tenantId: 1, locationId: 1, status: 1, endDatetime: 1 });
blockSchema.plugin(tenantScopePlugin);
export const SpaceAvailabilityBlock = model<SpaceAvailabilityBlockDoc>('SpaceAvailabilityBlock', blockSchema);

// ───────────────────────────────────────────────────────────── import

export interface SpaceImportIssue {
  code: SpaceImportIssueCode;
  field: SpaceImportField | null;
}

export interface SpaceImportDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  locationId: string;
  fileName: string;
  fileHash: string;
  status: SpaceImportStatus;
  headers: string[];
  mapping: Partial<Record<SpaceImportField, string | null>>;
  rowCount: number;
}

const importSchema = new Schema<SpaceImportDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    fileName: { type: String, required: true },
    fileHash: { type: String, required: true },
    status: { type: String, enum: SPACE_IMPORT_STATUSES, default: 'UPLOADED' },
    headers: { type: [String], default: [] },
    mapping: { type: Schema.Types.Mixed, default: {} },
    rowCount: { type: Number, default: 0 },
    ...auditFields,
  },
  baseSchemaOptions('space_import_batches'),
);
importSchema.index({ tenantId: 1, createdAt: -1 });
importSchema.plugin(tenantScopePlugin);
export const SpaceImport = model<SpaceImportDoc>('SpaceImport', importSchema);

export interface SpaceImportRowDoc extends BaseDoc {
  tenantId: string;
  importId: string;
  rowNumber: number;
  raw: Record<string, string>;
  status: SpaceImportRowStatus;
  issues: SpaceImportIssue[];
  /** The room this row made. Together with the file hash and row number it is the key that stops a re-run making the room twice. */
  spaceId: string | null;
}

const importRowSchema = new Schema<SpaceImportRowDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    importId: { type: String, required: true, immutable: true },
    rowNumber: { type: Number, required: true, immutable: true },
    raw: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: SPACE_IMPORT_ROW_STATUSES, default: 'NEEDS_ATTENTION' },
    issues: { type: [new Schema({ code: { type: String, enum: SPACE_IMPORT_ISSUE_CODES, required: true }, field: { type: String, default: null } }, { _id: false })], default: [] },
    spaceId: { type: String, default: null },
  },
  baseSchemaOptions('space_import_rows'),
);
importRowSchema.index({ tenantId: 1, importId: 1, rowNumber: 1 }, { unique: true });
importRowSchema.plugin(tenantScopePlugin);
export const SpaceImportRow = model<SpaceImportRowDoc>('SpaceImportRow', importRowSchema);

// ───────────────────────────────────────────────────────────── history and events

/** Renames, type conversions and moves, so a room's History tab can say what happened and why. */
export interface SpaceChangeLogDoc extends BaseDoc {
  tenantId: string;
  physicalSpaceId: string;
  type: SpaceChangeType;
  from: string | null;
  to: string | null;
  reason: string | null;
  actorId: string | null;
}

const changeLogSchema = new Schema<SpaceChangeLogDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    physicalSpaceId: { type: String, required: true, immutable: true },
    type: { type: String, enum: SPACE_CHANGE_TYPES, required: true },
    from: { type: String, default: null },
    to: { type: String, default: null },
    reason: { type: String, default: null, maxlength: 300 },
    actorId: { type: String, default: null },
  },
  baseSchemaOptions('space_change_log'),
);
changeLogSchema.index({ tenantId: 1, physicalSpaceId: 1, createdAt: -1 });
changeLogSchema.plugin(tenantScopePlugin);
export const SpaceChangeLog = model<SpaceChangeLogDoc>('SpaceChangeLog', changeLogSchema);

/** Domain events, written in the same transaction as the change. There is no message broker yet; a later one reads this collection. */
export interface OutboxEventDoc extends BaseDoc {
  tenantId: string;
  type: string;
  payload: Record<string, unknown>;
}

const outboxSchema = new Schema<OutboxEventDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    type: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, default: {} },
  },
  baseSchemaOptions('outbox_events'),
);
outboxSchema.index({ tenantId: 1, createdAt: -1 });
outboxSchema.plugin(tenantScopePlugin);
export const OutboxEvent = model<OutboxEventDoc>('OutboxEvent', outboxSchema);
