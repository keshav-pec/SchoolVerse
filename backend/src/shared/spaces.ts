/**
 * Module 5 — Building, Floor & Room setup: the words the API and the web app share.
 *
 * A school builds its campus once: Location → Building → Floor → Room. A room (`PhysicalSpace`) takes its settings from its Space Type
 * and only stores an exception. The same room list serves every later module; nobody keeps a second one.
 */

// ───────────────────────────────────────────────────────────── status values

/** A building or a floor. */
export const STRUCTURE_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type StructureStatus = (typeof STRUCTURE_STATUSES)[number];
export const STRUCTURE_STATUS_LABELS: Record<StructureStatus, string> = { DRAFT: 'Draft', ACTIVE: 'Active', INACTIVE: 'Inactive', ARCHIVED: 'Archived' };
/** What an admin may ask for. Draft is only a starting point; archive is the end. */
export const STRUCTURE_TARGET_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type StructureTargetStatus = (typeof STRUCTURE_TARGET_STATUSES)[number];

/** A room (or outdoor space). Temporary closures are availability blocks; `INACTIVE` is the long-term closure. */
export const SPACE_STATUSES = ['DRAFT', 'ACTIVE', 'TEMPORARILY_UNAVAILABLE', 'RESTRICTED', 'INACTIVE', 'ARCHIVED'] as const;
export type SpaceStatus = (typeof SPACE_STATUSES)[number];
export const SPACE_STATUS_LABELS: Record<SpaceStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  TEMPORARILY_UNAVAILABLE: 'Temporarily unavailable',
  RESTRICTED: 'Restricted',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archived',
};
export const SPACE_TARGET_STATUSES = ['ACTIVE', 'TEMPORARILY_UNAVAILABLE', 'RESTRICTED', 'INACTIVE'] as const;
export type SpaceTargetStatus = (typeof SPACE_TARGET_STATUSES)[number];

// ───────────────────────────────────────────────────────────── buildings and floors

export const BUILDING_TYPES = ['ACADEMIC', 'ADMIN', 'SPORTS', 'MIXED', 'OTHER'] as const;
export type BuildingType = (typeof BUILDING_TYPES)[number];
export const BUILDING_TYPE_LABELS: Record<BuildingType, string> = { ACADEMIC: 'Academic block', ADMIN: 'Admin block', SPORTS: 'Sports block', MIXED: 'Mixed use', OTHER: 'Other' };

export const FLOOR_LEVEL_TYPES = ['BASEMENT', 'GROUND', 'UPPER', 'CUSTOM'] as const;
export type FloorLevelType = (typeof FLOOR_LEVEL_TYPES)[number];

/** `GF`, `F1`, `F2`, `B1` — the code a floor gets when none is typed. */
export function floorCodeFor(floorNumber: number): string {
  if (floorNumber === 0) return 'GF';
  return floorNumber > 0 ? `F${floorNumber}` : `B${-floorNumber}`;
}

const WORD_NUMBERS: Record<string, number> = { zero: 0, ground: 0, gf: 0, g: 0, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

/**
 * Reads a floor's number and kind from its name, so "Ground, First, Second" works without typing numbers.
 * `position` (0-based, in the order typed) is the fallback for names it cannot read.
 */
export function floorFromName(name: string, position = 0): { floorNumber: number; levelType: FloorLevelType } {
  const text = name.trim().toLowerCase();
  const digits = /(\d+)/.exec(text)?.[1];
  const basement = /basement|cellar|lower ground/.test(text);
  if (basement) return { floorNumber: -(digits ? Number(digits) : 1), levelType: 'BASEMENT' };
  const word = Object.keys(WORD_NUMBERS).find((w) => new RegExp(`\\b${w}\\b`).test(text));
  const number = word !== undefined ? WORD_NUMBERS[word]! : digits !== undefined ? Number(digits) : position;
  return { floorNumber: number, levelType: number === 0 ? 'GROUND' : /ground/.test(text) ? 'GROUND' : 'UPPER' };
}

// ───────────────────────────────────────────────────────────── space types, features and tags

export const SPACE_SOURCES = ['TYPE_DEFAULT', 'OVERRIDE'] as const;
export type SpaceValueSource = (typeof SPACE_SOURCES)[number];

export const SPACE_SUITABILITY_TAGS = [
  { code: 'GENERAL_TEACHING', label: 'General teaching' },
  { code: 'CHEMISTRY_PRACTICAL', label: 'Chemistry practical' },
  { code: 'PHYSICS_PRACTICAL', label: 'Physics practical' },
  { code: 'BIOLOGY_PRACTICAL', label: 'Biology practical' },
  { code: 'COMPUTER_PRACTICAL', label: 'Computer practical' },
  { code: 'LANGUAGE_LAB', label: 'Language lab' },
  { code: 'MUSIC', label: 'Music' },
  { code: 'ART', label: 'Art' },
  { code: 'SPORTS_INDOOR', label: 'Indoor sports' },
  { code: 'SPORTS_OUTDOOR', label: 'Outdoor sports' },
  { code: 'ASSEMBLY', label: 'Assembly' },
  { code: 'EXAMINATION', label: 'Examination' },
] as const;
export type SuitabilityTagCode = (typeof SPACE_SUITABILITY_TAGS)[number]['code'];
export const SUITABILITY_TAG_CODES = SPACE_SUITABILITY_TAGS.map((t) => t.code) as [SuitabilityTagCode, ...SuitabilityTagCode[]];

/** What a room has. This is not an asset list: no serial numbers, no counts. */
export const SPACE_FEATURES = [
  { code: 'SMART_BOARD', label: 'Smart Board' },
  { code: 'PROJECTOR', label: 'Projector' },
  { code: 'COMPUTERS', label: 'Computers' },
  { code: 'INTERNET', label: 'Internet' },
  { code: 'AUDIO_SYSTEM', label: 'Audio System' },
  { code: 'AIR_CONDITIONING', label: 'Air Conditioning' },
  { code: 'LAB_BENCHES', label: 'Laboratory Benches' },
  { code: 'WHITEBOARD', label: 'Whiteboard' },
  { code: 'ACCESSIBLE_ENTRY', label: 'Accessible Entry' },
  { code: 'LIFT_ACCESS', label: 'Lift Access' },
  { code: 'CCTV', label: 'CCTV' },
  { code: 'PA_SYSTEM', label: 'Public Address System' },
] as const;
export type SpaceFeatureCode = (typeof SPACE_FEATURES)[number]['code'];
export const SPACE_FEATURE_CODES = SPACE_FEATURES.map((f) => f.code) as [SpaceFeatureCode, ...SpaceFeatureCode[]];

/** The seven types every school starts with. An admin can add more; these cannot be deleted. */
export interface SystemSpaceType {
  code: string;
  name: string;
  isSchedulable: boolean;
  isHomeClassroomEligible: boolean;
  defaultSuitabilityTags: SuitabilityTagCode[];
  defaultAcademicCapacity: number | null;
  isOutdoor: boolean;
}
export const SYSTEM_SPACE_TYPES: readonly SystemSpaceType[] = [
  { code: 'STANDARD_CLASSROOM', name: 'Standard Classroom', isSchedulable: true, isHomeClassroomEligible: true, defaultSuitabilityTags: ['GENERAL_TEACHING'], defaultAcademicCapacity: 40, isOutdoor: false },
  { code: 'SMART_CLASSROOM', name: 'Smart Classroom', isSchedulable: true, isHomeClassroomEligible: true, defaultSuitabilityTags: ['GENERAL_TEACHING'], defaultAcademicCapacity: 40, isOutdoor: false },
  { code: 'CHEMISTRY_LAB', name: 'Chemistry Lab', isSchedulable: true, isHomeClassroomEligible: false, defaultSuitabilityTags: ['CHEMISTRY_PRACTICAL'], defaultAcademicCapacity: 30, isOutdoor: false },
  { code: 'COMPUTER_LAB', name: 'Computer Lab', isSchedulable: true, isHomeClassroomEligible: false, defaultSuitabilityTags: ['COMPUTER_PRACTICAL'], defaultAcademicCapacity: 30, isOutdoor: false },
  { code: 'LIBRARY', name: 'Library', isSchedulable: true, isHomeClassroomEligible: false, defaultSuitabilityTags: [], defaultAcademicCapacity: 60, isOutdoor: false },
  { code: 'PLAYGROUND', name: 'Playground', isSchedulable: true, isHomeClassroomEligible: false, defaultSuitabilityTags: ['SPORTS_OUTDOOR'], defaultAcademicCapacity: null, isOutdoor: true },
  { code: 'OFFICE', name: 'Office', isSchedulable: false, isHomeClassroomEligible: false, defaultSuitabilityTags: [], defaultAcademicCapacity: null, isOutdoor: false },
];
/** Staff rooms and offices are never offered for scheduling, whatever an override says. */
export const SCHEDULING_EXCLUDED_TYPE_CODES: readonly string[] = ['OFFICE'];

// ───────────────────────────────────────────────────────────── availability

export const BLOCK_TYPES = ['UNAVAILABLE', 'RESTRICTED'] as const;
export type BlockType = (typeof BLOCK_TYPES)[number];
export const BLOCK_STATUSES = ['ACTIVE', 'CANCELLED'] as const;
export type BlockStatus = (typeof BLOCK_STATUSES)[number];
export const BLOCK_REASON_CODES = ['MAINTENANCE', 'EXAM', 'EVENT', 'CLEANING', 'CONSTRUCTION', 'OTHER'] as const;
export type BlockReasonCode = (typeof BLOCK_REASON_CODES)[number];
export const BLOCK_REASON_LABELS: Record<BlockReasonCode, string> = { MAINTENANCE: 'Repair or maintenance', EXAM: 'Exam', EVENT: 'Event', CLEANING: 'Cleaning', CONSTRUCTION: 'Construction work', OTHER: 'Something else' };
/** A closure longer than this is a long-term closure: the room should be made Inactive instead. */
export const MAX_BLOCK_DAYS = 366;

/** Why a room cannot be used for a period. */
export const UNAVAILABLE_REASONS = ['SPACE_NOT_ACTIVE', 'PARENT_NOT_ACTIVE', 'BLOCK_ACTIVE', 'NOT_SCHEDULABLE'] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

// ───────────────────────────────────────────────────────────── history, import

export const SPACE_CHANGE_TYPES = ['RENAME', 'TYPE_CONVERSION', 'MOVE'] as const;
export type SpaceChangeType = (typeof SPACE_CHANGE_TYPES)[number];

export const SPACE_IMPORT_ROW_STATUSES = ['READY', 'NEEDS_ATTENTION', 'IMPORTED', 'SKIPPED'] as const;
export type SpaceImportRowStatus = (typeof SPACE_IMPORT_ROW_STATUSES)[number];
export const SPACE_IMPORT_STATUSES = ['UPLOADED', 'CHECKED', 'COMMITTED'] as const;
export type SpaceImportStatus = (typeof SPACE_IMPORT_STATUSES)[number];

export const SPACE_IMPORT_FIELDS = ['building', 'floor', 'spaceCode', 'spaceName', 'roomNumber', 'type', 'physicalCapacity', 'academicCapacity', 'examCapacity', 'features', 'tags'] as const;
export type SpaceImportField = (typeof SPACE_IMPORT_FIELDS)[number];
export const SPACE_IMPORT_REQUIRED_FIELDS: readonly SpaceImportField[] = ['spaceName', 'type'];
export const SPACE_IMPORT_FIELD_LABELS: Record<SpaceImportField, string> = {
  building: 'Building',
  floor: 'Floor',
  spaceCode: 'Room code',
  spaceName: 'Room name',
  roomNumber: 'Room number',
  type: 'Type',
  physicalCapacity: 'Physical capacity',
  academicCapacity: 'Seats for classes',
  examCapacity: 'Exam capacity',
  features: 'Features',
  tags: 'Suitable for',
};
export const SPACE_IMPORT_MAX_ROWS = 2000;
export const SPACE_IMPORT_MAX_BYTES = 1024 * 1024;

export const SPACE_IMPORT_ISSUE_CODES = [
  'NAME_MISSING',
  'TYPE_UNKNOWN',
  'BUILDING_UNKNOWN',
  'FLOOR_UNKNOWN',
  'INDOOR_NEEDS_FLOOR',
  'OUTDOOR_WITH_FLOOR',
  'CAPACITY_INVALID',
  'CODE_DUPLICATE_IN_FILE',
  'CODE_TAKEN',
  'FEATURE_UNKNOWN',
  'TAG_UNKNOWN',
] as const;
export type SpaceImportIssueCode = (typeof SPACE_IMPORT_ISSUE_CODES)[number];

// ───────────────────────────────────────────────────────────── events

/** Written to the outbox in the same transaction as the change. There is no message broker yet. */
export const SPACE_EVENT_TYPES = [
  'building.created',
  'building.status.changed',
  'floor.created',
  'floor.status.changed',
  'physical_space.created',
  'physical_space.updated',
  'physical_space.capacity.changed',
  'physical_space.status.changed',
  'physical_space.unavailable',
  'physical_space.available',
  'section.home_classroom.assigned',
  'section.home_classroom.changed',
  'section.home_classroom.ended',
] as const;
export type SpaceEventType = (typeof SPACE_EVENT_TYPES)[number];

/** What a dependency can say about a room, in words a school secretary understands. */
export const DEPENDENCY_KINDS = ['HOME_CLASSROOM', 'TIMETABLE', 'EXAM', 'ATTENDANCE', 'ASSET', 'MAINTENANCE', 'VISITOR', 'EVENT', 'AVAILABILITY_BLOCK', 'ROOMS'] as const;
export type DependencyKind = (typeof DEPENDENCY_KINDS)[number];
/** Modules that will add themselves to the room dependency list later. They store the room's id only. */
export const FUTURE_SPACE_REGISTRANTS = ['Timetable', 'Exams', 'Attendance', 'Assets', 'Maintenance', 'Visitor', 'Events'] as const;

export const ARCHIVE_ACTIONS = ['CHOOSE_REPLACEMENT', 'ARCHIVE_AFTER_SESSION'] as const;
export type ArchiveAction = (typeof ARCHIVE_ACTIONS)[number];
