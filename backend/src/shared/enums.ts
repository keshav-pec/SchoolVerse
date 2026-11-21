/**
 * Canonical enums shared by API and Web.
 * Labels are presentation only — persist and compare the enum values.
 */

export const ROLES = ['SCHOOL_ADMIN', 'FACULTY', 'STAFF', 'PARENT'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  SCHOOL_ADMIN: 'School Admin',
  FACULTY: 'Teacher',
  STAFF: 'Staff',
  PARENT: 'Parent',
};

/** PENDING_ACTIVATION has no password yet. SUSPENDED is reversible. DISABLED is how access ends (an employee exit does it). */
export const USER_STATUSES = ['PENDING_ACTIVATION', 'ACTIVE', 'SUSPENDED', 'DISABLED'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const TENANT_STATUSES = ['ACTIVE', 'SUSPENDED'] as const;
export type TenantStatus = (typeof TENANT_STATUSES)[number];

// ───────────────────────────────────────────────────────────── School master (PRD §8)

export const SCHOOL_STATUSES = ['ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type SchoolStatus = (typeof SCHOOL_STATUSES)[number];

export const SETUP_STATUSES = ['IN_PROGRESS', 'COMPLETED'] as const;
export type SetupStatus = (typeof SETUP_STATUSES)[number];

export const IDENTIFIER_STATUSES = ['ACTIVE', 'EXPIRED', 'SUPERSEDED'] as const;
export type IdentifierStatus = (typeof IDENTIFIER_STATUSES)[number];

export const IDENTIFIER_STATUS_LABELS: Record<IdentifierStatus, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Expired',
  SUPERSEDED: 'Superseded',
};

/**
 * Suggestions only. `identifierType` is free text so the ERP is never hard-coded
 * to one board or regulator (PRD §8 "Official identifiers").
 */
export const IDENTIFIER_TYPE_SUGGESTIONS = [
  'Affiliation Number',
  'Registration Number',
  'UDISE+ Code',
  'Trust / Society Registration',
  'PAN',
  'GSTIN',
] as const;

// ───────────────────────────────────────────────────────────── School locations (PRD §9, §10)

export const LOCATION_TYPES = ['MAIN_CAMPUS', 'BRANCH_CAMPUS', 'ADMINISTRATIVE'] as const;
export type LocationType = (typeof LOCATION_TYPES)[number];

export const LOCATION_TYPE_LABELS: Record<LocationType, string> = {
  MAIN_CAMPUS: 'Main Campus',
  BRANCH_CAMPUS: 'Branch Campus',
  ADMINISTRATIVE: 'Administrative',
};

export const LOCATION_STATUSES = ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'] as const;
export type LocationStatus = (typeof LOCATION_STATUSES)[number];

export const LOCATION_STATUS_LABELS: Record<LocationStatus, string> = {
  DRAFT: 'Draft',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  ARCHIVED: 'Archived',
};

/** Lifecycle operations (status changes are business operations, never PATCH edits — PRD §17). */
export const LOCATION_ACTIONS = ['activate', 'deactivate', 'archive'] as const;
export type LocationAction = (typeof LOCATION_ACTIONS)[number];

/** "Save as Draft" vs "Activate Location" at the end of the Add Location flow (PRD §12). */
export const LOCATION_CREATE_INTENTS = ['DRAFT', 'ACTIVE'] as const;
export type LocationCreateIntent = (typeof LOCATION_CREATE_INTENTS)[number];

// ───────────────────────────────────────────────────────────── Setup wizard & overview (PRD §12, §14)

/** Wizard steps (PRD §12). */
export const SETUP_STEPS = ['IDENTITY', 'CONTACT', 'PRIMARY_LOCATION', 'ADDITIONAL_LOCATIONS', 'REVIEW_AND_FINISH'] as const;
export type SetupStep = (typeof SETUP_STEPS)[number];
export const SETUP_STEP_COUNT = SETUP_STEPS.length;

/** `upcoming` = belongs to a module that is not built yet; it never counts as an error. */
export const SETUP_ITEM_STATUSES = ['completed', 'pending', 'upcoming'] as const;
export type SetupItemStatus = (typeof SETUP_ITEM_STATUSES)[number];

// ───────────────────────────────────────────────────────────── Master (downstream) API (PRD §16)

/** `operational` = ACTIVE only (selectors) · `configuration` adds DRAFT + INACTIVE · `all` adds ARCHIVED (history). */
export const MASTER_LOCATION_SCOPES = ['operational', 'configuration', 'all'] as const;
export type MasterLocationScope = (typeof MASTER_LOCATION_SCOPES)[number];

export const LOCATION_VALIDATION_PURPOSES = ['NEW_ASSIGNMENT', 'HISTORICAL_READ'] as const;
export type LocationValidationPurpose = (typeof LOCATION_VALIDATION_PURPOSES)[number];

export const LOCATION_INVALID_REASONS = ['NOT_FOUND', 'NOT_ACTIVE', 'ARCHIVED'] as const;
export type LocationInvalidReason = (typeof LOCATION_INVALID_REASONS)[number];

// ───────────────────────────────────────────────────────────── Academic structure (Module 2)

export const BOARD_TYPES = ['CENTRAL', 'STATE', 'OTHER'] as const;
export type BoardType = (typeof BOARD_TYPES)[number];

export const BOARD_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export const RULE_VERSION_STATUSES = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type RuleVersionStatus = (typeof RULE_VERSION_STATUSES)[number];

export const EDUCATION_STAGES = ['FOUNDATIONAL', 'PREPARATORY', 'MIDDLE', 'SECONDARY'] as const;
export type EducationStage = (typeof EDUCATION_STAGES)[number];

export const SUBJECT_CATEGORIES = [
  'LANGUAGE',
  'MATHEMATICS',
  'SCIENCE',
  'SOCIAL_SCIENCE',
  'COMMERCE',
  'HUMANITIES',
  'TECHNOLOGY',
  'ARTS',
  'PHYSICAL_EDUCATION',
  'SKILL',
  'OTHER',
] as const;
export type SubjectCategory = (typeof SUBJECT_CATEGORIES)[number];

export const SUBJECT_CATEGORY_LABELS: Record<SubjectCategory, string> = {
  LANGUAGE: 'Language',
  MATHEMATICS: 'Mathematics',
  SCIENCE: 'Science',
  SOCIAL_SCIENCE: 'Social Science',
  COMMERCE: 'Commerce',
  HUMANITIES: 'Humanities',
  TECHNOLOGY: 'Technology',
  ARTS: 'Arts',
  PHYSICAL_EDUCATION: 'Physical Education',
  SKILL: 'Skill / Vocational',
  OTHER: 'Other',
};

export const SUBJECT_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type SubjectStatus = (typeof SUBJECT_STATUSES)[number];

/** `DRAFT → PUBLISHED → ACTIVE → CLOSED → ARCHIVED`. "Validated" is a stored result, not a status. */
export const SESSION_STATUSES = ['DRAFT', 'PUBLISHED', 'ACTIVE', 'CLOSED', 'ARCHIVED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export const SESSION_STATUS_LABELS: Record<SessionStatus, string> = {
  DRAFT: 'Draft',
  PUBLISHED: 'Published',
  ACTIVE: 'Active',
  CLOSED: 'Closed',
  ARCHIVED: 'Archived',
};

/** Statuses Faculty / Staff may read (no `academic:view_config`): never drafts. */
export const SESSION_STATUSES_FOR_LIMITED_VIEW: readonly SessionStatus[] = ['PUBLISHED', 'ACTIVE', 'CLOSED'];

export const OFFERING_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type OfferingStatus = (typeof OFFERING_STATUSES)[number];

export const SUBJECT_OFFERING_TYPES = ['MANDATORY', 'ELECTIVE', 'OPTIONAL_ADDITIONAL', 'LANGUAGE', 'SKILL', 'INTERNAL'] as const;
export type SubjectOfferingType = (typeof SUBJECT_OFFERING_TYPES)[number];

export const SUBJECT_OFFERING_TYPE_LABELS: Record<SubjectOfferingType, string> = {
  MANDATORY: 'Mandatory',
  ELECTIVE: 'Elective',
  OPTIONAL_ADDITIONAL: 'Optional / additional',
  LANGUAGE: 'Language',
  SKILL: 'Skill',
  INTERNAL: 'Internal',
};

export const TERM_TYPES = ['TERM', 'SEMESTER', 'QUARTER', 'ANNUAL', 'CUSTOM'] as const;
export type TermType = (typeof TERM_TYPES)[number];

export const TERM_TYPE_LABELS: Record<TermType, string> = {
  TERM: 'Term',
  SEMESTER: 'Semester',
  QUARTER: 'Quarter',
  ANNUAL: 'Annual',
  CUSTOM: 'Custom',
};

/** Computed from today's date; there is no manual term closing. */
export const TERM_STATUSES = ['planned', 'current', 'closed'] as const;
export type TermStatus = (typeof TERM_STATUSES)[number];

/** Session lifecycle operations (status moves are business operations, never PATCH fields). */
export const SESSION_ACTIONS = ['publish', 'activate', 'close', 'archive'] as const;
export type SessionAction = (typeof SESSION_ACTIONS)[number];

export const CHOICE_RULE_TYPES = ['REQUIRED_ALL', 'CHOOSE_ONE', 'CHOOSE_N', 'OPTIONAL'] as const;
export type ChoiceRuleType = (typeof CHOICE_RULE_TYPES)[number];

export const CHOICE_RULE_TYPE_LABELS: Record<ChoiceRuleType, string> = {
  REQUIRED_ALL: 'Take all',
  CHOOSE_ONE: 'Choose one',
  CHOOSE_N: 'Choose a number',
  OPTIONAL: 'Optional',
};

export const CONSTRAINT_TYPES = ['REQUIRES', 'EXCLUDES'] as const;
export type ConstraintType = (typeof CONSTRAINT_TYPES)[number];

export const PROGRAMME_KINDS = ['STREAM', 'FLEXIBLE'] as const;
export type ProgrammeKind = (typeof PROGRAMME_KINDS)[number];

export const PROGRAMME_REQUIREMENTS = ['REQUIRED', 'CHOICE', 'OPTIONAL'] as const;
export type ProgrammeRequirement = (typeof PROGRAMME_REQUIREMENTS)[number];

export const VALIDATION_LEVELS = ['ERROR', 'WARNING', 'INFO'] as const;
export type ValidationLevel = (typeof VALIDATION_LEVELS)[number];

/** Same meaning as the location purposes: new assignments need live rows, history can read anything. */
export const ACADEMIC_PURPOSES = ['NEW_ASSIGNMENT', 'HISTORICAL_READ'] as const;
export type AcademicPurpose = (typeof ACADEMIC_PURPOSES)[number];

// ───────────────────────────────────────────────────────────── Audit (PRD §18)

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'tenant.created': 'Workspace created',
  'user.created': 'User created',
  'school.created': 'School profile created',
  'school.updated': 'School profile updated',
  'school.logo_updated': 'Logo updated',
  'school.logo_removed': 'Logo removed',
  'school.setup_completed': 'School setup completed',
  'school_identifier.created': 'Official identifier added',
  'school_identifier.updated': 'Official identifier updated',
  'school_identifier.deleted': 'Official identifier removed',
  'location.created': 'Location created',
  'location.updated': 'Location details updated',
  'location.activated': 'Location activated',
  'location.deactivated': 'Location deactivated',
  'location.archived': 'Location archived',
  'location.primary_set': 'Set as Primary Location',
  'location.primary_unset': 'No longer the Primary Location',
  'location.deleted': 'Draft location discarded',
  'board.created': 'Board added',
  'rule_version.created': 'Board rule version added',
  'rule_version.published': 'Board rule version published',
  'subject.created': 'Subject added',
  'subject.updated': 'Subject updated',
  'subject.board_code_set': 'Board subject code mapped',
  'subject.board_code_removed': 'Board subject code removed',
  'academic_session.created': 'Academic session created',
  'academic_session.updated': 'Academic session updated',
  'academic_session.deleted': 'Draft academic session discarded',
  'class_offering.created': 'Class added to session',
  'class_offering.updated': 'Class updated',
  'class_offering.deleted': 'Class removed from draft session',
  'section.created': 'Section added',
  'section.updated': 'Section updated',
  'section.deleted': 'Section removed from draft session',
  'subject_offering.created': 'Subject offered',
  'subject_offering.updated': 'Subject offering updated',
  'subject_offering.deleted': 'Subject offering removed from draft session',
  'academic_term.created': 'Term added',
  'academic_term.updated': 'Term updated',
  'academic_term.deleted': 'Term removed',
  'academic_session.published': 'Academic session published',
  'academic_session.activated': 'Academic session activated',
  'academic_session.closed': 'Academic session closed',
  'academic_session.archived': 'Academic session archived',
  'academic_session.cloned': 'Academic session created from a previous session',
  'choice_group.created': 'Subject choice group added',
  'choice_group.updated': 'Subject choice group updated',
  'choice_group.deleted': 'Subject choice group removed',
  'constraint.created': 'Subject constraint added',
  'constraint.deleted': 'Subject constraint removed',
  'programme.created': 'Programme added',
  'programme.updated': 'Programme updated',
  'programme.deleted': 'Programme removed',
  // Faculty & Staff (Module 3)
  'employee.created': 'Employee onboarded',
  'employee.updated': 'Employee details updated',
  'employee.deleted': 'Onboarding record discarded',
  'employee.status_changed': 'Employment status changed',
  'employee.exit_initiated': 'Exit initiated',
  'employee.exit_cancelled': 'Exit cancelled',
  'employee.exited': 'Employee exited',
  'person.created': 'Person record created',
  'person.updated': 'Personal details updated',
  'department.created': 'Department added',
  'department.updated': 'Department updated',
  'designation.created': 'Designation added',
  'designation.updated': 'Designation updated',
  'location_assignment.created': 'Location assigned',
  'location_assignment.updated': 'Placement start date corrected',
  'location_assignment.ended': 'Location assignment ended',
  'location_assignment.cancelled': 'Location assignment cancelled',
  'location_assignment.transferred': 'Transferred to another location',
  'academic_assignment.created': 'Class or subject assigned',
  'academic_assignment.ended': 'Class or subject assignment ended',
  'academic_assignment.cancelled': 'Class or subject assignment cancelled',
  'responsibility.created': 'Responsibility assigned',
  'responsibility.ended': 'Responsibility ended',
  'responsibility.cancelled': 'Responsibility cancelled',
  // Identity and restricted data (Module 3, Part 2)
  'user.account_created': 'Login created',
  'user.account_restored': 'Login restored',
  'user.activation_resent': 'Activation link re-sent',
  'user.activated': 'Account activated',
  'user.password_reset': 'Password reset',
  'user.suspended': 'Account suspended',
  'user.reactivated': 'Account reactivated',
  'user.disabled': 'Account disabled',
  'user.role_changed': 'Role changed',
  'restricted.updated': 'Restricted details updated',
  'restricted.revealed': 'Restricted value revealed',
  'profile.self_updated': 'Profile updated by the employee',
  'change_request.created': 'Change requested',
  'change_request.approved': 'Change request approved',
  'change_request.rejected': 'Change request rejected',
  'change_request.cancelled': 'Change request cancelled',
  'document.uploaded': 'Document uploaded',
  'document.downloaded': 'Document downloaded',
  'document.download_denied': 'Document download refused',
  'document.deleted': 'Document deleted',
  'export.created': 'Staff export created',
  // Students and parents (Module 4)
  'student.created': 'Student added',
  'student.draft_saved': 'Student saved as a draft',
  'student.updated': 'Student details updated',
  'student.status_changed': 'Student status changed',
  'student.activated': 'Student admission confirmed',
  'student.deleted': 'Draft student discarded',
  'student.external_id_added': 'Outside ID added',
  'student.external_id_ended': 'Outside ID ended',
  'admission.created': 'Admission recorded',
  'admission_settings.updated': 'Admission number settings updated',
  'guardian_link.created': 'Parent or guardian linked',
  'guardian_link.updated': 'Parent or guardian link updated',
  'guardian_link.primary_changed': 'Primary guardian changed',
  'guardian_link.ended': 'Parent or guardian link ended',
  'guardian.updated': 'Parent or guardian details updated',
  'enrollment.created': 'Enrolled in a class',
  'enrollment.updated': 'Enrollment updated',
  'enrollment.programme_changed': 'Programme changed',
  'enrollment.completed': 'Enrollment completed',
  'section_assignment.created': 'Placed in a section',
  'section_assignment.updated': 'Roll number changed',
  'section_assignment.ended': 'Section placement ended',
  'section_assignment.transferred': 'Moved to another section',
  'subject_enrollment.created': 'Subject added',
  'subject_enrollment.ended': 'Subject ended',
};


// ───────────────────────────────────────────────────────────── Faculty & Staff (Module 3)

export const EMPLOYEE_CATEGORIES = ['FACULTY', 'NON_TEACHING_STAFF'] as const;
export type EmployeeCategory = (typeof EMPLOYEE_CATEGORIES)[number];

export const EMPLOYEE_CATEGORY_LABELS: Record<EmployeeCategory, string> = {
  FACULTY: 'Teaching staff',
  NON_TEACHING_STAFF: 'Non-teaching staff',
};

export const EMPLOYEE_STATUSES = ['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'NOTICE_PERIOD', 'EXITED'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

export const EMPLOYEE_STATUS_LABELS: Record<EmployeeStatus, string> = {
  ONBOARDING: 'Onboarding',
  ACTIVE: 'Active',
  ON_LEAVE: 'On leave',
  SUSPENDED: 'Suspended',
  NOTICE_PERIOD: 'Notice period',
  EXITED: 'Exited',
};

/** Lifecycle actions an admin can take (PRD §25). `complete_exit` is system-only (the hourly job). */
export const EMPLOYEE_ACTIONS = ['activate', 'leave', 'suspend', 'exit', 'cancel_exit', 'complete_exit'] as const;
export type EmployeeAction = (typeof EMPLOYEE_ACTIONS)[number];

/** Targets accepted by `POST /employees/:id/status`. Exit has its own endpoints. */
export const EMPLOYEE_STATUS_TARGETS = ['ACTIVE', 'ON_LEAVE', 'SUSPENDED'] as const;
export type EmployeeStatusTarget = (typeof EMPLOYEE_STATUS_TARGETS)[number];

export const PERSON_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type PersonStatus = (typeof PERSON_STATUSES)[number];

export const MASTER_STATUSES = ['ACTIVE', 'INACTIVE'] as const;
export type MasterStatus = (typeof MASTER_STATUSES)[number];

export const EXIT_REASON_CATEGORIES = ['RESIGNATION', 'RETIREMENT', 'END_OF_CONTRACT', 'TERMINATION', 'TRANSFER_OUT', 'DECEASED', 'OTHER'] as const;
export type ExitReasonCategory = (typeof EXIT_REASON_CATEGORIES)[number];

export const EXIT_REASON_LABELS: Record<ExitReasonCategory, string> = {
  RESIGNATION: 'Resignation',
  RETIREMENT: 'Retirement',
  END_OF_CONTRACT: 'End of contract',
  TERMINATION: 'Termination',
  TRANSFER_OUT: 'Transferred out',
  DECEASED: 'Deceased',
  OTHER: 'Other',
};

/** Effective-dated rows never store a status: it is computed from the dates (see `assignmentStatus`). */
export const ASSIGNMENT_STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETED', 'CANCELLED'] as const;
export type AssignmentStatus = (typeof ASSIGNMENT_STATUSES)[number];

export const ASSIGNMENT_STATUS_LABELS: Record<AssignmentStatus, string> = {
  PLANNED: 'Planned',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
};

export const LOCATION_END_REASONS = ['TRANSFER', 'EXIT', 'ENDED'] as const;
export type LocationEndReason = (typeof LOCATION_END_REASONS)[number];

export const ASSIGNMENT_END_REASONS = ['EXIT', 'ENDED'] as const;
export type AssignmentEndReason = (typeof ASSIGNMENT_END_REASONS)[number];

export const ACADEMIC_ASSIGNMENT_TYPES = ['SUBJECT_FACULTY', 'CLASS_TEACHER', 'CO_CLASS_TEACHER', 'COORDINATOR', 'HOD'] as const;
export type AcademicAssignmentType = (typeof ACADEMIC_ASSIGNMENT_TYPES)[number];

export const ACADEMIC_ASSIGNMENT_TYPE_LABELS: Record<AcademicAssignmentType, string> = {
  SUBJECT_FACULTY: 'Subject teacher',
  CLASS_TEACHER: 'Class teacher',
  CO_CLASS_TEACHER: 'Co-class teacher',
  COORDINATOR: 'Coordinator',
  HOD: 'Head of department',
};

/** Suggested employee codes start with these: FAC-001, STF-001. Admins can still type any code. */
export const EMPLOYEE_CODE_PREFIXES: Record<EmployeeCategory, string> = {
  FACULTY: 'FAC',
  NON_TEACHING_STAFF: 'STF',
};

export const EMPLOYMENT_TYPE_SUGGESTIONS = ['Permanent', 'Probation', 'Contract', 'Part-time', 'Visiting', 'Intern'] as const;

export const RESPONSIBILITY_SUGGESTIONS = ['Transport In-charge', 'Library', 'Lab', 'Admissions', 'Accounts', 'IT Support', 'Exam Cell', 'Reception'] as const;

/** PRD §7 starter lists, offered by `POST /departments/suggested` and `POST /designations/suggested`. */
export const SUGGESTED_DEPARTMENTS = ['Academics', 'Administration', 'Accounts', 'Library', 'Laboratory', 'Transport', 'IT', 'Admissions', 'HR'] as const;
export const SUGGESTED_DESIGNATIONS = ['PGT', 'TGT', 'PRT', 'Principal', 'Vice Principal', 'Accountant', 'Librarian', 'Lab Assistant', 'Driver', 'Clerk'] as const;

/** Why a record was refused as a colleague. Written to `security_events`; never shown to the caller (they get 404). */
export const SECURITY_EVENT_TYPES = [
  'CROSS_LOCATION_DENIED',
  // Identity (Module 3, Part 2)
  'LOGIN_FAILED',
  'REFRESH_TOKEN_REUSE',
  'ROLE_CHANGED',
  'STEP_UP_FAILED',
  'DOCUMENT_ACCESS_DENIED',
  'FILE_REJECTED',
  // Students (Module 4)
  'CROSS_SCOPE_DENIED',
] as const;
export type SecurityEventType = (typeof SECURITY_EVENT_TYPES)[number];

/** What an employee record is being used for (same idea as `AcademicPurpose`). */
export const EMPLOYEE_PURPOSES = ['NEW_ASSIGNMENT', 'HISTORICAL_READ'] as const;
export type EmployeePurpose = (typeof EMPLOYEE_PURPOSES)[number];

// ───────────────────────────────────────────────────────────── Identity, restricted data and documents (Module 3, Part 2)

/** Roles an admin can give a login. Parents get theirs from the Parent module. */
export const PROVISIONABLE_ROLES = ['FACULTY', 'STAFF', 'SCHOOL_ADMIN'] as const satisfies readonly Role[];
export type ProvisionableRole = (typeof PROVISIONABLE_ROLES)[number];

export const GOVERNMENT_ID_TYPES = ['AADHAAR', 'PAN', 'PASSPORT', 'VOTER_ID', 'DRIVING_LICENCE'] as const;
export type GovernmentIdType = (typeof GOVERNMENT_ID_TYPES)[number];

export const GOVERNMENT_ID_LABELS: Record<GovernmentIdType, string> = {
  AADHAAR: 'Aadhaar',
  PAN: 'PAN',
  PASSPORT: 'Passport',
  VOTER_ID: 'Voter ID',
  DRIVING_LICENCE: 'Driving licence',
};

/** One value that `POST /employees/:id/restricted/reveal` can return. */
export const RESTRICTED_FIELDS = ['DATE_OF_BIRTH', 'BANK_ACCOUNT_NUMBER', ...GOVERNMENT_ID_TYPES] as const;
export type RestrictedField = (typeof RESTRICTED_FIELDS)[number];

export const DOCUMENT_TYPES = ['ID_PROOF', 'ADDRESS_PROOF', 'QUALIFICATION', 'EXPERIENCE', 'POLICE_VERIFICATION', 'MEDICAL', 'CONTRACT', 'OTHER'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

export const DOCUMENT_TYPE_LABELS: Record<DocumentType, string> = {
  ID_PROOF: 'ID proof',
  ADDRESS_PROOF: 'Address proof',
  QUALIFICATION: 'Qualification',
  EXPERIENCE: 'Experience letter',
  POLICE_VERIFICATION: 'Police verification',
  MEDICAL: 'Medical certificate',
  CONTRACT: 'Contract',
  OTHER: 'Other',
};

export const DOCUMENT_STATUSES = ['ACTIVE', 'DELETED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

/** Files are PDF, PNG or JPEG, sniffed from the bytes. */
export const DOCUMENT_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg'] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];
export const MAX_DOCUMENT_BYTES = 5 * 1024 * 1024;

/** Details that an employee cannot change directly: they go through approval. */
export const CHANGE_FIELD_CATEGORIES = ['LEGAL_NAME', 'DATE_OF_BIRTH', 'GOVERNMENT_ID', 'BANK_DETAILS'] as const;
export type ChangeFieldCategory = (typeof CHANGE_FIELD_CATEGORIES)[number];

export const CHANGE_FIELD_LABELS: Record<ChangeFieldCategory, string> = {
  LEGAL_NAME: 'Legal name',
  DATE_OF_BIRTH: 'Date of birth',
  GOVERNMENT_ID: 'Government ID',
  BANK_DETAILS: 'Bank details',
};

export const CHANGE_REQUEST_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'] as const;
export type ChangeRequestStatus = (typeof CHANGE_REQUEST_STATUSES)[number];

export const EXPORT_PURPOSES = ['DIRECTORY', 'EMPLOYMENT'] as const;
export type ExportPurpose = (typeof EXPORT_PURPOSES)[number];

export const EXPORT_PURPOSE_LABELS: Record<ExportPurpose, string> = {
  DIRECTORY: 'Directory (names, roles, locations, official contact)',
  EMPLOYMENT: 'Employment (adds dates, type and reporting manager)',
};

/** How long a step-up (re-entering the password) keeps restricted actions open. */
export const STEP_UP_SECONDS = 5 * 60;
/** How long a signed download link works. */
export const FILE_LINK_SECONDS = 60;


// ───────────────────────────────────────────────────────────── Students and parents (Module 4)

export const GENDERS = ['FEMALE', 'MALE', 'OTHER'] as const;
export type Gender = (typeof GENDERS)[number];

export const GENDER_LABELS: Record<Gender, string> = { FEMALE: 'Female', MALE: 'Male', OTHER: 'Other' };

/**
 * DRAFT → ADMISSION_PENDING → ACTIVE ↔ INACTIVE → WITHDRAWAL_INITIATED → WITHDRAWN / TRANSFERRED_OUT / COMPLETED_SCHOOLING.
 * The exit statuses are only ever set by the Part 3 workflows.
 */
export const STUDENT_STATUSES = [
  'DRAFT',
  'ADMISSION_PENDING',
  'ACTIVE',
  'INACTIVE',
  'WITHDRAWAL_INITIATED',
  'WITHDRAWN',
  'TRANSFERRED_OUT',
  'COMPLETED_SCHOOLING',
] as const;
export type StudentStatus = (typeof STUDENT_STATUSES)[number];

export const STUDENT_STATUS_LABELS: Record<StudentStatus, string> = {
  DRAFT: 'Draft',
  ADMISSION_PENDING: 'Admission pending',
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
  WITHDRAWAL_INITIATED: 'Leaving',
  WITHDRAWN: 'Withdrawn',
  TRANSFERRED_OUT: 'Transferred out',
  COMPLETED_SCHOOLING: 'Finished school',
};

/** Students who have left. They are kept for history and cannot be changed (`STUDENT_READ_ONLY`). */
export const EXITED_STUDENT_STATUSES: readonly StudentStatus[] = ['WITHDRAWN', 'TRANSFERRED_OUT', 'COMPLETED_SCHOOLING'];
/** What the student list shows unless the caller asks for another status. */
export const CURRENT_STUDENT_STATUSES: readonly StudentStatus[] = ['DRAFT', 'ADMISSION_PENDING', 'ACTIVE', 'INACTIVE', 'WITHDRAWAL_INITIATED'];

export const STUDENT_ACTIONS = [
  'admit',
  'activate',
  'deactivate',
  'reactivate',
  'start_withdrawal',
  'cancel_withdrawal',
  'complete_withdrawal',
  'complete_schooling',
  'readmit',
] as const;
export type StudentAction = (typeof STUDENT_ACTIONS)[number];

/** Targets accepted by `POST /students/:id/status`. Drafts are confirmed with `/activate`; exits have their own workflows. */
export const STUDENT_STATUS_TARGETS = ['ACTIVE', 'INACTIVE'] as const;
export type StudentStatusTarget = (typeof STUDENT_STATUS_TARGETS)[number];

export const ADMISSION_MODES = ['NEW_ADMISSION', 'MIGRATION', 'READMISSION'] as const;
export type AdmissionMode = (typeof ADMISSION_MODES)[number];

export const ADMISSION_MODE_LABELS: Record<AdmissionMode, string> = {
  NEW_ADMISSION: 'New admission',
  MIGRATION: 'Existing student (migration)',
  READMISSION: 'Readmission',
};

export const ADMISSION_NUMBER_MODES = ['AUTO', 'MANUAL'] as const;
export type AdmissionNumberMode = (typeof ADMISSION_NUMBER_MODES)[number];

export const READMISSION_POLICIES = ['KEEP_OLD', 'ISSUE_NEW'] as const;
export type ReadmissionPolicy = (typeof READMISSION_POLICIES)[number];

export const SECTION_CAPACITY_POLICIES = ['WARN', 'BLOCK'] as const;
export type SectionCapacityPolicy = (typeof SECTION_CAPACITY_POLICIES)[number];

export const RELATIONSHIP_TYPES = [
  'Father',
  'Mother',
  'Legal Guardian',
  'Grandfather',
  'Grandmother',
  'Brother',
  'Sister',
  'Uncle',
  'Aunt',
  'Foster Guardian',
  'Other',
] as const;
export type RelationshipType = (typeof RELATIONSHIP_TYPES)[number];

/** Suggestions for the free-text "type" of an outside ID. */
export const EXTERNAL_ID_TYPE_SUGGESTIONS = ['Legacy ERP ID', 'Board Reg No', 'State ID', 'PEN'] as const;

export const ENROLLMENT_TYPES = ['NEW_ADMISSION', 'CONTINUING', 'PROMOTED', 'REPEATING', 'TRANSFER_IN', 'READMISSION', 'MID_SESSION_TRANSFER'] as const;
export type EnrollmentType = (typeof ENROLLMENT_TYPES)[number];

/** Stored. `PLANNED` and `ACTIVE` are only ever worked out from the dates of an OPEN enrollment. */
export const ENROLLMENT_STATES = ['OPEN', 'COMPLETED', 'WITHDRAWN', 'TRANSFERRED', 'CANCELLED'] as const;
export type EnrollmentState = (typeof ENROLLMENT_STATES)[number];

export const ENROLLMENT_STATUSES = ['PLANNED', 'ACTIVE', 'COMPLETED', 'WITHDRAWN', 'TRANSFERRED', 'CANCELLED'] as const;
export type EnrollmentStatus = (typeof ENROLLMENT_STATUSES)[number];

export const ENROLLMENT_STATUS_LABELS: Record<EnrollmentStatus, string> = {
  PLANNED: 'Starts later',
  ACTIVE: 'Active',
  COMPLETED: 'Completed',
  WITHDRAWN: 'Withdrawn',
  TRANSFERRED: 'Transferred',
  CANCELLED: 'Cancelled',
};

export const ENROLLMENT_OUTCOMES = ['PROMOTED', 'REPEATED', 'PASSED_OUT'] as const;
export type EnrollmentOutcome = (typeof ENROLLMENT_OUTCOMES)[number];

export const SUBJECT_ENROLLMENT_SOURCES = ['AUTO_MANDATORY', 'ADMIN_SELECTED', 'MIGRATED', 'PROGRAMME_DERIVED'] as const;
export type SubjectEnrollmentSource = (typeof SUBJECT_ENROLLMENT_SOURCES)[number];

export const TRANSFER_EVENT_TYPES = ['SECTION', 'LOCATION'] as const;
export type TransferEventType = (typeof TRANSFER_EVENT_TYPES)[number];

export const ROLL_NUMBER_ORDERS = ['ALPHABETICAL', 'ADMISSION_NUMBER'] as const;
export type RollNumberOrder = (typeof ROLL_NUMBER_ORDERS)[number];

/** Why a possible duplicate was flagged. The check never merges anything. */
export const DUPLICATE_REASONS = ['SAME_ADMISSION_NUMBER', 'SAME_EXTERNAL_ID', 'SAME_NAME_AND_DOB', 'SIMILAR_NAME_AND_DOB', 'SAME_GUARDIAN_PHONE_AND_FIRST_NAME'] as const;
export type DuplicateReason = (typeof DUPLICATE_REASONS)[number];

export const DUPLICATE_REASON_LABELS: Record<DuplicateReason, string> = {
  SAME_ADMISSION_NUMBER: 'Same admission number',
  SAME_EXTERNAL_ID: 'Same outside ID',
  SAME_NAME_AND_DOB: 'Same name and date of birth',
  SIMILAR_NAME_AND_DOB: 'Almost the same name and the same date of birth',
  SAME_GUARDIAN_PHONE_AND_FIRST_NAME: 'Same parent phone and the same first name',
};

/** What a computed "needs attention" item is about (Part 2 groups them on one page). */
export const COMPLETENESS_ITEMS = ['ADMISSION', 'ENROLLMENT', 'SECTION', 'GUARDIAN', 'PRIMARY_GUARDIAN', 'SUBJECT_CHOICE'] as const;
export type CompletenessItem = (typeof COMPLETENESS_ITEMS)[number];

export const SUBJECT_PROBLEM_CODES = [
  'NOT_OFFERED',
  'MISSING_MANDATORY',
  'GROUP_TOO_FEW',
  'GROUP_TOO_MANY',
  'REQUIRES',
  'EXCLUDES',
  'PROGRAMME_REQUIRED',
  'PROGRAMME_CHOICE_TOO_FEW',
  'PROGRAMME_CHOICE_TOO_MANY',
  'NOT_IN_PROGRAMME',
] as const;
export type SubjectProblemCode = (typeof SUBJECT_PROBLEM_CODES)[number];

/** Which timeline row a history entry is. */
export const HISTORY_KINDS = ['STUDENT', 'ADMISSION', 'ENROLLMENT', 'SECTION', 'SUBJECT', 'GUARDIAN', 'TRANSFER'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];
