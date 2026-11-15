/**
 * Canonical enums shared by API and Web.
 * Labels are presentation only — persist and compare the enum values.
 */

export const ROLES = ['SCHOOL_ADMIN', 'FACULTY', 'STAFF', 'PARENT'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS: Record<Role, string> = {
  SCHOOL_ADMIN: 'School Admin',
  FACULTY: 'Faculty',
  STAFF: 'Staff',
  PARENT: 'Parent',
};

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  SCHOOL_ADMIN: 'Full access to school configuration',
  FACULTY: 'Teaching staff — limited, read-only view of school setup',
  STAFF: 'Non-teaching staff — limited, read-only view of school setup',
  PARENT: 'Guardian access — no access to school configuration',
};

export const USER_STATUSES = ['ACTIVE', 'DISABLED'] as const;
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
export const SETUP_STEPS = ['IDENTITY', 'CONTACT', 'PRIMARY_LOCATION', 'ADDITIONAL_LOCATIONS', 'REVIEW', 'COMPLETE'] as const;
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

export const EDUCATION_STAGE_LABELS: Record<EducationStage, string> = {
  FOUNDATIONAL: 'Foundational',
  PREPARATORY: 'Preparatory',
  MIDDLE: 'Middle',
  SECONDARY: 'Secondary',
};

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
  'grade_offering.created': 'Grade added to session',
  'grade_offering.updated': 'Grade updated',
  'grade_offering.deleted': 'Grade removed from draft session',
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
};

