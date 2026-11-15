import type {
  AcademicPurpose,
  ChoiceRuleType,
  ConstraintType,
  ProgrammeKind,
  ProgrammeRequirement,
  ValidationLevel,
  BoardStatus,
  BoardType,
  EducationStage,
  IdentifierStatus,
  OfferingStatus,
  RuleVersionStatus,
  SessionStatus,
  SubjectCategory,
  SubjectOfferingType,
  SubjectStatus,
  TermStatus,
  TermType,
  LocationInvalidReason,
  LocationValidationPurpose,
  SetupItemStatus,
  LocationStatus,
  LocationType,
  Role,
  SchoolStatus,
  SetupStatus,
  TenantStatus,
  UserStatus,
} from './enums';
import type { Permission } from './permissions';

/** All IDs are permanent UUID strings. Labels are presentation only. */

export interface TenantDTO {
  tenantId: string;
  name: string;
  slug: string;
  status: TenantStatus;
}

export interface UserDTO {
  userId: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface SessionDTO {
  user: UserDTO;
  tenant: TenantDTO;
  permissions: Permission[];
}

export interface PaginatedDTO<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface AuditChangeDTO {
  field: string;
  from: unknown;
  to: unknown;
}

export interface AuditEventDTO {
  auditEventId: string;
  entityType: string;
  entityId: string;
  action: string;
  actor: { userId: string | null; role: Role | 'SYSTEM'; name?: string | null };
  changes: AuditChangeDTO[];
  metadata: Record<string, unknown>;
  occurredAt: string;
  requestId: string | null;
}

export interface AuditPageDTO {
  items: AuditEventDTO[];
  /** Pass back as `cursor` to load older events; `null` when there are no more. */
  nextCursor: string | null;
}

// ───────────────────────────────────────────────────────────── School master

export interface SchoolSetupDTO {
  status: SetupStatus;
  currentStep: number;
  completedAt: string | null;
}

export interface SchoolDTO {
  schoolId: string;
  tenantId: string;
  schoolCode: string;
  legalName: string;
  displayName: string;
  shortName: string | null;
  logoUrl: string | null;
  primaryEmail: string;
  primaryPhone: string;
  alternatePhone: string | null;
  websiteUrl: string | null;
  defaultTimezone: string;
  defaultCurrency: string;
  defaultLocale: string;
  status: SchoolStatus;
  /** Whether first-time School Setup is finished. Visible to everyone who can see the school. */
  setupCompleted: boolean;
  /** Present only for users who can view configuration (`school:view_config`). */
  setup?: SchoolSetupDTO;
  createdAt: string;
  updatedAt: string;
}

export interface SchoolIdentifierDTO {
  identifierId: string;
  schoolId: string;
  identifierType: string;
  identifierValue: string;
  issuingAuthority: string | null;
  issueDate: string | null;
  expiryDate: string | null;
  documentUrl: string | null;
  status: IdentifierStatus;
  createdAt: string;
  updatedAt: string;
}

// ───────────────────────────────────────────────────────────── School locations

export interface LocationAddressDTO {
  line1: string | null;
  line2: string | null;
  locality: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2, e.g. `IN`. */
  country: string;
}

/** Timezone / currency / locale after inheriting from the school. */
export interface EffectiveDefaultsDTO {
  timezone: string;
  currency: string;
  locale: string;
  inherited: { timezone: boolean; currency: boolean; locale: boolean };
}

export interface LocationDTO {
  locationId: string;
  schoolId: string;
  locationCode: string;
  displayName: string;
  officialName: string | null;
  locationType: LocationType;
  isPrimary: boolean;
  status: LocationStatus;
  openingDate: string | null;
  timezoneOverride: string | null;
  currencyOverride: string | null;
  localeOverride: string | null;
  effectiveDefaults: EffectiveDefaultsDTO;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  websiteUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  address: LocationAddressDTO;
  /** `null` until the Staff / Student modules exist (UI shows "—"). */
  staffCount: number | null;
  studentCount: number | null;
  /** Internal notes — only for users with `location:view_config`. */
  notes?: string | null;
  statusChangedAt: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LocationDetailDTO extends LocationDTO {
  /** The code can no longer change because downstream records reference the location. */
  codeLocked: boolean;
  /** Only an unreferenced DRAFT can be deleted; everything else must be archived. */
  deletable: boolean;
}

export interface LocationFacetsDTO {
  cities: { city: string; count: number }[];
  statuses: Record<LocationStatus, number>;
  types: Record<LocationType, number>;
}

export interface LocationListDTO extends PaginatedDTO<LocationDTO> {
  /** Counts across every location the user can see (ignoring the active filters). */
  facets: LocationFacetsDTO;
}

export interface LocationCodeAvailabilityDTO {
  /** The normalised code that was checked (`null` when only a name was sent). */
  code: string | null;
  valid: boolean;
  available: boolean;
  message: string | null;
  /** A free code based on `name` (or on the checked code when it is taken). */
  suggestion: string | null;
}

/** One reason an archive is blocked (`LOCATION_HAS_DEPENDENCIES` → `details.dependencies`). */
export interface LocationDependencyDTO {
  key: string;
  label: string;
  count: number;
  message: string;
}

// ───────────────────────────────────────────────────────────── Setup overview (SCH-LOC-13)

export interface SetupItemDTO {
  key: string;
  label: string;
  description: string;
  status: SetupItemStatus;
  /** Share of the overall completion percentage (all weights add up to 100). */
  weight: number;
  /** Module that owns the item, e.g. `school-setup` or `academic-structure`. */
  module: string;
  /** Web route that fixes or opens the item, when one exists today. */
  href: string | null;
}

export interface SetupStatusDTO {
  schoolId: string;
  setupStatus: SchoolSetupDTO['status'];
  currentStep: number;
  /** Overall weighted completion across School Setup and the modules that follow it. */
  completionPercent: number;
  /** Completion of this module's own items only. */
  coreCompletionPercent: number;
  items: SetupItemDTO[];
  /** The most useful thing to do next (first pending item, then the first upcoming one). */
  nextStep: SetupItemDTO | null;
  summary: {
    schoolName: string;
    primaryLocation: { locationId: string; displayName: string; locationCode: string } | null;
    activeLocations: number;
    draftLocations: number;
    totalLocations: number;
  };
}

// ───────────────────────────────────────────────────────────── Master (downstream) contract (SCH-LOC-14)

export interface MasterSchoolContextDTO {
  schoolId: string;
  tenantId: string;
  displayName: string;
  shortName: string | null;
  defaults: { timezone: string; currency: string; locale: string };
  primaryLocationId: string | null;
  setupCompleted: boolean;
}

/** Deliberately small and frozen: downstream modules store `locationId`, never copy these fields. */
export interface MasterLocationDTO {
  locationId: string;
  schoolId: string;
  locationCode: string;
  displayName: string;
  locationType: LocationType;
  status: LocationStatus;
  isPrimary: boolean;
  city: string | null;
  state: string | null;
  country: string | null;
  effectiveDefaults: { timezone: string; currency: string; locale: string };
}

export interface LocationValidationResultDTO {
  locationId: string;
  valid: boolean;
  reason: LocationInvalidReason | null;
}

export interface LocationValidationDTO {
  purpose: LocationValidationPurpose;
  allValid: boolean;
  results: LocationValidationResultDTO[];
}

// ───────────────────────────────────────────────────────────── Academic structure (Module 2)
//
// Other modules store offering UUIDs (`gradeOfferingId`, `sectionOfferingId`, `subjectOfferingId`),
// never display labels such as "Class VIII-A".

export interface BoardDTO {
  boardId: string;
  boardCode: string;
  boardName: string;
  boardType: BoardType;
  stateCode: string | null;
  status: BoardStatus;
  /** Built-in boards are shared by every school and cannot be edited. */
  isSystem: boolean;
}

export interface BoardRuleVersionDTO {
  ruleVersionId: string;
  boardId: string;
  name: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceReference: string | null;
  status: RuleVersionStatus;
  isSystem: boolean;
}

export interface GradeMasterDTO {
  gradeId: string;
  canonicalCode: string;
  canonicalName: string;
  /** Short label used as the default display code, e.g. `8` or `KG`. */
  shortCode: string;
  sequenceNumber: number;
  educationStage: EducationStage;
  isPrePrimary: boolean;
  isBoardGrade: boolean;
}

export interface BoardSubjectCodeDTO {
  definitionId: string;
  boardRuleVersionId: string;
  boardId: string;
  boardCode: string | null;
  ruleVersionName: string | null;
  boardSubjectCode: string;
  boardSubjectName: string | null;
}

export interface SubjectDTO {
  subjectId: string;
  subjectCode: string;
  name: string;
  shortName: string | null;
  category: SubjectCategory;
  languageCode: string | null;
  hasTheory: boolean;
  hasPractical: boolean;
  hasProject: boolean;
  hasInternalAssessment: boolean;
  status: SubjectStatus;
  boardCodes: BoardSubjectCodeDTO[];
  createdAt: string;
  updatedAt: string;
}

export interface SessionLocationDTO {
  locationId: string;
  locationCode: string | null;
  locationName: string | null;
  boardId: string;
  boardCode: string | null;
  boardName: string | null;
  boardRuleVersionId: string;
  ruleVersionName: string | null;
  affiliationNumber: string | null;
}

export interface SessionWarningDTO {
  code: 'SESSION_DATES_OVERLAP';
  message: string;
  academicSessionId: string;
}

export interface ValidationSummaryDTO {
  at: string;
  errors: number;
  warnings: number;
}

export interface AcademicSessionDTO {
  academicSessionId: string;
  schoolId: string;
  name: string;
  code: string;
  startDate: string;
  endDate: string;
  status: SessionStatus;
  /** True for the single ACTIVE session of the school. */
  isCurrent: boolean;
  locations: SessionLocationDTO[];
  previousSessionId: string | null;
  warnings: SessionWarningDTO[];
  /** Hard delete is only possible while the session is a DRAFT. */
  deletable: boolean;
  /** Only for users with `academic:view_config`. */
  lastValidation?: ValidationSummaryDTO | null;
  createdAt: string;
  updatedAt: string;
}

export interface GradeOfferingDTO {
  gradeOfferingId: string;
  academicSessionId: string;
  locationId: string;
  gradeId: string;
  canonicalCode: string;
  displayName: string;
  displayCode: string;
  medium: string | null;
  capacity: number | null;
  sequenceOrder: number;
  status: OfferingStatus;
  sectionCount: number;
  subjectCount: number;
}

export interface SectionOfferingDTO {
  sectionOfferingId: string;
  gradeOfferingId: string;
  academicSessionId: string;
  locationId: string;
  sectionCode: string;
  displayName: string;
  capacity: number | null;
  sequenceOrder: number;
  status: OfferingStatus;
}

export interface SubjectOfferingDTO {
  subjectOfferingId: string;
  gradeOfferingId: string;
  academicSessionId: string;
  locationId: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  category: SubjectCategory;
  offeringType: SubjectOfferingType;
  boardSubjectDefinitionId: string | null;
  boardSubjectCode: string | null;
  boardSubjectName: string | null;
  status: OfferingStatus;
}

export interface AcademicTermDTO {
  termId: string;
  academicSessionId: string;
  /** `null` = applies to every location in the session. */
  locationId: string | null;
  name: string;
  code: string;
  type: TermType;
  sequence: number;
  startDate: string;
  endDate: string;
  /** Computed from today's date in the school's time zone. */
  status: TermStatus;
}

// ── Part 2: rules, programmes, validation, context

export interface ChoiceGroupDTO {
  choiceGroupId: string;
  gradeOfferingId: string;
  academicSessionId: string;
  name: string;
  ruleType: ChoiceRuleType;
  /** Derived for REQUIRED_ALL (all items) and CHOOSE_ONE (1); entered for CHOOSE_N; 0 for OPTIONAL. */
  min: number;
  max: number;
  sequence: number;
  status: OfferingStatus;
  subjects: { subjectOfferingId: string; subjectCode: string; subjectName: string; status: OfferingStatus }[];
  /** Plain-language rule, e.g. "Choose 1 of Punjabi, Hindi, Urdu". */
  summary: string;
}

export interface ConstraintDTO {
  constraintId: string;
  gradeOfferingId: string;
  academicSessionId: string;
  type: ConstraintType;
  subjectOfferingId: string;
  subjectName: string;
  otherSubjectOfferingId: string;
  otherSubjectName: string;
  /** e.g. "Physics requires Mathematics". */
  summary: string;
}

export interface ProgrammeSubjectRuleDTO {
  subjectOfferingId: string;
  subjectId: string;
  subjectCode: string;
  subjectName: string;
  requirement: ProgrammeRequirement;
  status: OfferingStatus;
}

export interface ProgrammeDTO {
  programmeId: string;
  academicSessionId: string;
  locationId: string;
  name: string;
  code: string;
  kind: ProgrammeKind;
  gradeFromId: string;
  gradeToId: string;
  boardId: string | null;
  subjectRules: ProgrammeSubjectRuleDTO[];
  choiceMin: number | null;
  choiceMax: number | null;
  status: OfferingStatus;
}

export interface ValidationIssueDTO {
  level: ValidationLevel;
  code: string;
  message: string;
  entityType: string;
  entityId: string;
}

export interface ValidationResultDTO {
  academicSessionId: string;
  validatedAt: string;
  summary: { errors: number; warnings: number; info: number };
  /** True when there are no errors (warnings and info never block publishing). */
  canPublish: boolean;
  issues: ValidationIssueDTO[];
}

export type ChecklistStatus = 'completed' | 'pending' | 'optional';

export interface AcademicOverviewDTO {
  academicSessionId: string;
  status: SessionStatus;
  counts: { locations: number; grades: number; sections: number; subjects: number; programmes: number; terms: number; choiceGroups: number };
  boards: { locationId: string; locationCode: string | null; locationName: string | null; boardCode: string | null; boardName: string | null; ruleVersionName: string | null }[];
  checklist: { key: 'session' | 'board' | 'grades' | 'sections' | 'subjects' | 'rules' | 'terms' | 'validation'; label: string; status: ChecklistStatus; detail: string }[];
  lastValidation: ValidationSummaryDTO | null;
}

export interface AcademicContextGradesDTO {
  academicSessionId: string;
  locationId: string;
  sessionStatus: SessionStatus;
  board: { boardId: string; boardCode: string | null; boardRuleVersionId: string; ruleVersionName: string | null };
  grades: GradeOfferingDTO[];
}

export interface AcademicContextDTO extends AcademicContextGradesDTO {
  gradeOffering: GradeOfferingDTO;
  sections: SectionOfferingDTO[];
  subjectOfferings: SubjectOfferingDTO[];
  choiceGroups: ChoiceGroupDTO[];
  constraints: ConstraintDTO[];
  programmes: ProgrammeDTO[];
  /** Session-wide terms plus the location's own terms (each carries its `locationId`). */
  terms: AcademicTermDTO[];
}

export interface AcademicUsabilityDTO {
  purpose: AcademicPurpose;
  location: { locationId: string; locationCode: string; displayName: string };
  session: { academicSessionId: string; code: string; name: string; status: SessionStatus };
  gradeOffering: { gradeOfferingId: string; gradeId: string; displayName: string };
  section?: { sectionOfferingId: string; sectionCode: string; displayName: string };
  subjectOffering?: { subjectOfferingId: string; subjectId: string; subjectName: string; offeringType: SubjectOfferingType };
}
