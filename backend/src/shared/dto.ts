import type {
  ChangeFieldCategory,
  ChangeRequestStatus,
  DocumentMimeType,
  DocumentType,
  ExportPurpose,
  GovernmentIdType,
  RestrictedField,
  AcademicAssignmentType,
  AcademicPurpose,
  AssignmentEndReason,
  AssignmentStatus,
  EmployeeAction,
  EmployeeCategory,
  EmployeeStatus,
  ExitReasonCategory,
  LocationEndReason,
  MasterStatus,
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
  /** The person this login belongs to (an employee today; a student or parent later). */
  personId: string | null;
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

export type SchoolCodeAvailabilityDTO = LocationCodeAvailabilityDTO;

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
  /** Weighted completion across every item that can be completed today. Modules that aren't built yet are left out, so a fully set-up school reads 100%. */
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

// ───────────────────────────────────────────────────────────── Faculty & Staff (Module 3)
//
// Five rules (PRD §16): no route returns a Mongoose document, every DTO is built by an explicit mapper,
// and a field's class (`data-classification.ts`) decides which DTOs may carry it. Date-only values are `YYYY-MM-DD`.

export interface DepartmentDTO {
  departmentId: string;
  code: string;
  name: string;
  status: MasterStatus;
  createdAt: string;
  updatedAt: string;
}

export interface DesignationDTO {
  designationId: string;
  code: string;
  name: string;
  status: MasterStatus;
  createdAt: string;
  updatedAt: string;
}

export interface SuggestedMastersDTO<T> {
  created: T[];
  /** Suggestions that were left alone because the code already exists. */
  skipped: number;
}

export interface EmployeeLocationRefDTO {
  locationId: string;
  locationCode: string;
  displayName: string;
  isPrimary: boolean;
  status: AssignmentStatus;
}

/** INTERNAL fields only: safe for the colleague directory. */
export interface EmployeeDirectoryDTO {
  employeeId: string;
  employeeCode: string;
  /** Legal name, first + middle + last. */
  fullName: string;
  /** Preferred name when set, otherwise first + last. */
  displayName: string;
  preferredName: string | null;
  employeeCategory: EmployeeCategory;
  employmentType: string | null;
  department: { departmentId: string; code: string; name: string };
  designation: { designationId: string; code: string; name: string };
  status: EmployeeStatus;
  /** The primary placement that applies today (or the next planned one). */
  primaryLocation: EmployeeLocationRefDTO | null;
  /** Primary and secondary placements that are active or planned. */
  locations: EmployeeLocationRefDTO[];
  officialEmail: string | null;
  officialPhone: string | null;
}

/** PERSONAL contact. Only returned to callers with `employee:view_personal`. */
export interface EmployeePersonalDTO {
  primaryEmail: string | null;
  primaryPhone: string | null;
  personalEmail: string | null;
  personalPhone: string | null;
  address: {
    line1: string | null;
    line2: string | null;
    city: string | null;
    state: string | null;
    postalCode: string | null;
    country: string | null;
  } | null;
  emergencyContact: { name: string; relation: string; phone: string } | null;
}

/** Never includes date of birth, government IDs or bank details: those are restricted data. */
export interface EmployeeProfileDTO extends EmployeeDirectoryDTO {
  personId: string;
  schoolId: string;
  legalFirstName: string;
  legalMiddleName: string | null;
  legalLastName: string;
  joiningDate: string;
  confirmationDate: string | null;
  reportingManager: { employeeId: string; employeeCode: string; fullName: string } | null;
  exit: { exitDate: string; exitReasonCategory: ExitReasonCategory; note?: string | null } | null;
  /** Present only with `employee:view_personal`. */
  personal?: EmployeePersonalDTO;
  /** Lifecycle buttons that make sense from the current status. */
  lifecycleActions: EmployeeAction[];
  /** True while a hard delete is still allowed (onboarding, nothing recorded yet). */
  deletable: boolean;
  /** Exited employees are history only. */
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LocationAssignmentDTO {
  locationAssignmentId: string;
  employeeId: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  isPrimary: boolean;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: string | null;
  endReason: LocationEndReason | null;
  /** Computed from the dates and `cancelledAt`, in the school's time zone. */
  status: AssignmentStatus;
}

export interface TransferResultDTO {
  ended: LocationAssignmentDTO;
  started: LocationAssignmentDTO;
  /** The old location kept as a secondary placement when `keepOldAsSecondary` was set. */
  secondary: LocationAssignmentDTO | null;
}

export interface FacultyAssignmentDTO {
  academicAssignmentId: string;
  employeeId: string;
  academicSessionId: string;
  sessionCode: string;
  sessionName: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  gradeOfferingId: string;
  gradeName: string;
  sectionId: string | null;
  sectionCode: string | null;
  sectionName: string | null;
  subjectOfferingId: string | null;
  subjectId: string | null;
  subjectName: string | null;
  assignmentType: AcademicAssignmentType;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: string | null;
  endReason: AssignmentEndReason | null;
  status: AssignmentStatus;
}

export interface ResponsibilityDTO {
  responsibilityId: string;
  employeeId: string;
  locationId: string;
  locationCode: string;
  locationName: string;
  responsibilityType: string;
  description: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: string | null;
  endReason: AssignmentEndReason | null;
  status: AssignmentStatus;
}

export interface EmployeeHistoryDTO {
  locationAssignments: LocationAssignmentDTO[];
  academicAssignments: FacultyAssignmentDTO[];
  responsibilities: ResponsibilityDTO[];
  /** Audit timeline for this employee, newest first. */
  events: AuditEventDTO[];
}

/** What other modules get from `employeeService.getEmployeeSummary()`. */
export interface EmployeeSummaryDTO {
  employeeId: string;
  personId: string;
  employeeCode: string;
  fullName: string;
  displayName: string;
  employeeCategory: EmployeeCategory;
  status: EmployeeStatus;
  departmentName: string;
  designationName: string;
  primaryLocationId: string | null;
}

export interface SectionFacultyDTO {
  employeeId: string;
  fullName: string;
  assignmentType: AcademicAssignmentType;
  subjectOfferingId: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
}

// ───────────────────────────────────────────────────────────── Identity, restricted data and documents (Module 3, Part 2)
//
// Nothing here carries a secret: no password hash, token, key, storage key or file checksum. Restricted values are masked
// unless `RevealedValueDTO` is asked for (permission + step-up, audited).

/** `GET /employees/:id/user-account`: the login behind an employee, if any. */
export interface EmployeeAccountDTO {
  account: UserDTO | null;
  /** The official email, offered as the default for a new login. */
  defaultEmail: string | null;
}

/** `GET /auth/activation/:token`: just enough to greet the person. */
export interface ActivationCheckDTO {
  firstName: string;
}

export interface StepUpDTO {
  stepUpAt: string;
  validForSeconds: number;
}

/** Date of birth, government IDs and bank details, always masked. */
export interface RestrictedEmployeeProfileDTO {
  employeeId: string;
  personId: string;
  /** For example `••/••/1988`. */
  dateOfBirth: { masked: string } | null;
  /** For example `XXXX XXXX 1234`. */
  governmentIds: { type: GovernmentIdType; masked: string }[];
  bank: { accountHolderName: string; accountNumberMasked: string; ifsc: string; bankName: string } | null;
  updatedAt: string | null;
}

export interface RevealedValueDTO {
  field: RestrictedField;
  value: string;
  /** The page should hide the value again after this many seconds. */
  hideAfterSeconds: number;
}

/** `GET /me/profile`: the signed-in employee's own record. Government IDs and bank details stay masked. */
export interface SelfProfileDTO {
  profile: EmployeeProfileDTO;
  /** The employee's own date of birth. */
  dateOfBirth: string | null;
  restricted: RestrictedEmployeeProfileDTO;
  locationAssignments: LocationAssignmentDTO[];
  academicAssignments: FacultyAssignmentDTO[];
  responsibilities: ResponsibilityDTO[];
  account: UserDTO;
  pendingRequests: ProfileChangeRequestDTO[];
}

export interface ProfileChangeRequestDTO {
  changeRequestId: string;
  employeeId: string;
  employeeCode: string;
  employeeName: string;
  fieldCategory: ChangeFieldCategory;
  status: ChangeRequestStatus;
  /** Legal names are shown in full; everything else is masked. */
  currentDisplay: string | null;
  proposedDisplay: string;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
}

export interface EmployeeDocumentDTO {
  documentId: string;
  employeeId: string;
  documentType: DocumentType;
  displayName: string;
  mime: DocumentMimeType;
  sizeBytes: number;
  uploadedAt: string;
}

/** A link that works for a minute (documents) or a quarter of an hour (exports). The URL is the only credential. */
export interface SignedFileLinkDTO {
  url: string;
  expiresAt: string;
}

export interface ExportResultDTO extends SignedFileLinkDTO {
  exportId: string;
  purpose: ExportPurpose;
  fileName: string;
  rowCount: number;
}
