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
  // Students and parents (Module 4). Faculty get none of these: their access to students is derived from their assigned sections.
  'student:view', // directory, profile, history
  'student:view_personal', // guardian contact, address, previous school on the profile
  'student:manage', // add, edit, status, external IDs, admission number settings
  'student:enroll', // enrollments, sections, roll numbers, subjects
  'guardian:manage', // add, link and end guardians
  'parent_access:manage', // invite parents to the portal, remove or resend access
  'student:documents', // upload, list, download and delete a student's documents
  'student:lifecycle', // transfers, promotion, repeat, withdrawal, transfer certificates, readmission
  'student:approve_changes', // approve or reject changes parents ask for
  'student:import', // import students from a file
  'student:export', // download student exports
  // Campus: buildings, floors and rooms (Module 5). Faculty get `space:view` only, and see schedulable rooms at their own locations.
  'space:view', // buildings, floors, rooms, types, availability
  'space:create', // add buildings, floors and rooms
  'space:edit', // rename, change capacity, features, tags, status
  'space:bulk_manage', // room generator, bulk edit, duplicate floor, copy campus
  'space:archive', // archive, hard delete, guarded move
  'space:capacity:manage', // change capacities
  'space:features:manage', // change features and suitability tags
  'space:availability:manage', // make a room unavailable for a period
  'space:import', // import rooms from a file
  'space:export', // download room exports
  'space:audit:view', // a room's history
  'space:section_assignment:manage', // Home Classroom assignments (Part 3)
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

/** Faculty may look up rooms; the server narrows what they see to schedulable rooms at their own locations. */
const FACULTY_VIEW: Permission[] = [...COLLEAGUE_VIEW, 'space:view'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SCHOOL_ADMIN: PERMISSIONS,
  FACULTY: FACULTY_VIEW,
  STAFF: COLLEAGUE_VIEW,
  PARENT: [],
};

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}
