import type { Role } from './enums';

/**
 * Permission catalog (PRD §7). Server-side enforcement is the source of truth;
 * the web app reuses this matrix only to decide what to *show*.
 */
export const PERMISSIONS = [
  // School master
  'school:view', // profile, contact and operational defaults
  'school:view_config', // official identifiers + setup/audit metadata
  'school:edit',
  // School locations
  'location:view', // operational (ACTIVE) locations, limited fields
  'location:view_config', // drafts / inactive / archived + internal fields (notes)
  'location:create',
  'location:edit',
  'location:set_primary',
  'location:change_status',
  'location:archive',
  // Academic structure (Module 2)
  'academic:view', // PUBLISHED / ACTIVE / CLOSED sessions, structure fields only
  'academic:view_config', // DRAFT sessions, validation results, audit
  'academic:manage', // create / edit / delete configuration
  'academic:publish', // validate, publish, activate, close, clone
  // Faculty & Staff (Module 3)
  'employee:directory', // colleague directory fields (Faculty / Staff: only people who share a location)
  'employee:view', // full profile, assignments, history
  'employee:view_personal', // personal contact on the profile
  'employee:manage', // create, edit, assign, lifecycle, departments / designations
  'employee:view_restricted', // masked date of birth, government IDs and bank details
  'employee:reveal_restricted', // show one restricted value in full (step-up, audited)
  'employee:manage_restricted', // enter or replace government IDs and bank details (step-up)
  'employee:documents', // upload, list, download and delete any employee's documents
  'employee:approve_changes', // approve or reject profile change requests
  'employee:export', // download staff exports
  // Setup & governance
  'setup:manage',
  'audit:view',
  // Platform
  'user:view',
  'user:manage', // create logins, suspend, disable, change role
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const LIMITED_VIEW: Permission[] = ['school:view', 'location:view', 'academic:view'];

const COLLEAGUE_VIEW: Permission[] = [...LIMITED_VIEW, 'employee:directory'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SCHOOL_ADMIN: PERMISSIONS,
  FACULTY: COLLEAGUE_VIEW,
  STAFF: COLLEAGUE_VIEW,
  PARENT: [],
};

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
