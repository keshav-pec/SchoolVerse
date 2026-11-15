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

// ───────────────────────────────────────────────────────────── Audit (PRD §18)

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  'tenant.created': 'Workspace created',
  'user.created': 'User created',
  'school.created': 'School profile created',
  'school.updated': 'School profile updated',
  'school.logo_updated': 'Logo updated',
  'school.logo_removed': 'Logo removed',
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
};
