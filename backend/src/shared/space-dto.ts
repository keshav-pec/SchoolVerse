import type {
  ArchiveAction,
  BlockReasonCode,
  BlockStatus,
  BlockType,
  BuildingType,
  DependencyKind,
  FloorLevelType,
  SpaceChangeType,
  SpaceFeatureCode,
  SpaceImportField,
  SpaceImportIssueCode,
  SpaceImportRowStatus,
  SpaceImportStatus,
  SpaceStatus,
  SpaceValueSource,
  StructureStatus,
  SuitabilityTagCode,
  UnavailableReason,
} from './spaces';

/** A value a room gets from its type unless an admin overrode it, and where it came from. */
export interface SourcedValue<T> {
  value: T;
  source: SpaceValueSource;
}

export interface BuildingDTO {
  buildingId: string;
  locationId: string;
  buildingCode: string;
  buildingName: string;
  buildingType: BuildingType;
  status: StructureStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  displayOrder: number;
  version: number;
  floorCount: number;
  roomCount: number;
}

export interface FloorDTO {
  floorId: string;
  buildingId: string;
  floorCode: string;
  floorName: string;
  floorNumber: number;
  levelType: FloorLevelType;
  status: StructureStatus;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  version: number;
  roomCount: number;
  /** Set when the building above is not active: "Unavailable because Main Block is inactive". */
  unavailableBecause: string | null;
}

export interface SpaceTypeDTO {
  spaceTypeId: string;
  code: string;
  name: string;
  isSchedulable: boolean;
  isHomeClassroomEligible: boolean;
  defaultSuitabilityTags: SuitabilityTagCode[];
  defaultAcademicCapacity: number | null;
  isOutdoor: boolean;
  isSystem: boolean;
  status: 'ACTIVE' | 'INACTIVE';
  /** Rooms that use this type: "34 rooms use this default". */
  roomCount: number;
}

export interface SpaceWarningDTO {
  code: 'ACADEMIC_OVER_PHYSICAL' | 'MISSING_ACADEMIC_CAPACITY';
  message: string;
}

/** Whether a room can be used right now, from its own status and the floor and building above it. Nothing is rewritten. */
export interface EffectiveStatusDTO {
  available: boolean;
  /** The room's own stored status. */
  status: SpaceStatus;
  /** Plain words, e.g. "Unavailable because Floor 2 is inactive". `null` when available. */
  reason: string | null;
}

export interface SpaceDTO {
  spaceId: string;
  locationId: string;
  building: { buildingId: string; buildingCode: string; buildingName: string } | null;
  floor: { floorId: string; floorCode: string; floorName: string; floorNumber: number } | null;
  spaceCode: string;
  spaceName: string;
  roomNumber: string | null;
  type: { spaceTypeId: string; code: string; name: string; isOutdoor: boolean };
  physicalCapacity: number | null;
  academicCapacity: SourcedValue<number | null>;
  examCapacity: number | null;
  schedulable: SourcedValue<boolean>;
  homeClassroomEligible: SourcedValue<boolean>;
  suitabilityTags: SourcedValue<SuitabilityTagCode[]>;
  features: SpaceFeatureCode[];
  status: SpaceStatus;
  effectiveStatus: EffectiveStatusDTO;
  /** Set when an admin asked for the room to be archived after the current session. */
  archiveAfterDate: string | null;
  needsReadinessRecheck: boolean;
  warnings: SpaceWarningDTO[];
  version: number;
}

/** What other modules read: the room, where it is, its final settings and what is blocking it. */
export interface SpaceContextDTO extends SpaceDTO {
  locationName: string;
  /** "Main Block › First Floor › 101". */
  path: string;
  activeBlock: AvailabilityBlockDTO | null;
  upcomingBlocks: AvailabilityBlockDTO[];
  /** Filled in by Part 3 (Home Classroom). `null` until then. */
  homeClassroom: { sectionOfferingId: string; label: string } | null;
}

export interface SpaceListDTO {
  items: SpaceDTO[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SpaceTreeFloorDTO {
  floorId: string;
  floorCode: string;
  floorName: string;
  floorNumber: number;
  status: StructureStatus;
  roomCount: number;
  unavailableBecause: string | null;
}
export interface SpaceTreeBuildingDTO {
  buildingId: string;
  buildingCode: string;
  buildingName: string;
  buildingType: BuildingType;
  status: StructureStatus;
  roomCount: number;
  floors: SpaceTreeFloorDTO[];
}
export interface SpaceTreeDTO {
  locationId: string;
  locationName: string;
  buildings: SpaceTreeBuildingDTO[];
  /** Playgrounds and other spaces that have no building. */
  outdoorCount: number;
  totals: { buildings: number; floors: number; rooms: number; schedulableRooms: number };
}

export interface AvailabilityBlockDTO {
  blockId: string;
  physicalSpaceId: string;
  blockType: BlockType;
  startDatetime: string;
  endDatetime: string;
  reasonCode: BlockReasonCode;
  reason: string | null;
  recurrenceRule: string | null;
  status: BlockStatus;
  /** Worked out from the dates. */
  phase: 'UPCOMING' | 'NOW' | 'PAST' | 'CANCELLED';
  createdBy: string | null;
}

export interface AvailabilityCheckDTO {
  available: boolean;
  reasons: { code: UnavailableReason; message: string }[];
}

/** One thing that depends on a room, in words a school secretary understands. */
export interface SpaceDependencyDTO {
  kind: DependencyKind;
  label: string;
  /** How many records (for example 3 availability blocks). */
  count?: number;
}

/** `archive` never answers with a raw error: it says what is in the way and what to do. */
export interface ArchiveSpaceResultDTO {
  archived: boolean;
  space: SpaceDTO | null;
  message: string;
  dependencies: SpaceDependencyDTO[];
  suggestedReplacementId: string | null;
  suggestedReplacementName: string | null;
  actions: ArchiveAction[];
}

export interface DependencyListDTO {
  dependencies: SpaceDependencyDTO[];
}

export interface TypeConversionPreviewDTO {
  from: { spaceTypeId: string; name: string };
  to: { spaceTypeId: string; name: string };
  /** The final values before and after, so the dialog can say "Home Classroom changes from Yes to No". */
  changes: { field: 'schedulable' | 'homeClassroomEligible' | 'academicCapacity' | 'suitabilityTags'; label: string; from: unknown; to: unknown }[];
  /** Things that will be checked again: assignments that would become invalid (Part 3), the scheduling-readiness check. */
  rechecks: string[];
}

export interface BulkEditResultDTO {
  dryRun: boolean;
  done: { spaceId: string; spaceCode: string }[];
  skipped: { spaceId: string; spaceCode: string | null; reason: string }[];
  message: string;
}

export interface BulkCreateResultDTO {
  created: SpaceDTO[];
}

export interface FloorsCreatedDTO {
  floors: FloorDTO[];
}

// ───────────────────────────────────────────────────────────── generator, duplicate, copy

export interface GeneratedSpaceRowDTO {
  spaceCode: string;
  spaceName: string;
  roomNumber: string | null;
  /** `EXISTS` = this very room is already on the floor (a retry); the others block the commit. */
  clash: null | 'CODE_TAKEN' | 'DUPLICATE_IN_LIST' | 'EXISTS';
  clashMessage: string | null;
}
export interface GeneratePreviewDTO {
  rows: GeneratedSpaceRowDTO[];
  willCreate: number;
  alreadyThere: number;
  clashes: number;
}
export interface GenerateResultDTO {
  created: SpaceDTO[];
  alreadyThere: number;
}

export interface CopyPreviewDTO {
  buildings: { create: number; existing: number };
  floors: { create: number; existing: number };
  rooms: { create: number; existing: number };
  /** Rooms whose code is already used by another room in the target. They are listed, not copied. */
  clashes: { spaceCode: string; message: string }[];
  note: string;
}
export interface CopyResultDTO extends CopyPreviewDTO {
  committed: true;
}

// ───────────────────────────────────────────────────────────── import

export interface SpaceImportIssueDTO {
  code: SpaceImportIssueCode;
  field: SpaceImportField | null;
  title: string;
  fix: string;
}
export interface SpaceImportRowDTO {
  rowId: string;
  rowNumber: number;
  status: SpaceImportRowStatus;
  values: Partial<Record<SpaceImportField, string>>;
  issues: SpaceImportIssueDTO[];
  spaceId: string | null;
}
export interface SpaceImportDTO {
  importId: string;
  locationId: string;
  fileName: string;
  status: SpaceImportStatus;
  headers: string[];
  mapping: Partial<Record<SpaceImportField, string | null>>;
  missingRequired: SpaceImportField[];
  rowCount: number;
  ready: number;
  needsAttention: number;
  imported: number;
  /** "412 rows: 398 ready, 14 need attention". */
  message: string;
  /** Issues grouped by kind, biggest group first. */
  issueGroups: { code: SpaceImportIssueCode; title: string; fix: string; count: number }[];
  createdAt: string;
}
export interface SpaceImportRowListDTO {
  items: SpaceImportRowDTO[];
  total: number;
  page: number;
  pageSize: number;
}
export interface SpaceImportCommitDTO {
  imported: number;
  skipped: number;
  alreadyImported: number;
  message: string;
  import: SpaceImportDTO;
}

// ───────────────────────────────────────────────────────────── history

export interface SpaceChangeDTO {
  changeId: string;
  physicalSpaceId: string;
  type: SpaceChangeType;
  from: string | null;
  to: string | null;
  reason: string | null;
  actorId: string | null;
  occurredAt: string;
}
