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
  // Setup & governance
  'setup:manage',
  'audit:view',
  // Platform
  'user:view',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const LIMITED_VIEW: Permission[] = ['school:view', 'location:view'];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  SCHOOL_ADMIN: PERMISSIONS,
  FACULTY: LIMITED_VIEW,
  STAFF: LIMITED_VIEW,
  PARENT: [],
};

export function permissionsFor(role: Role): Permission[] {
  return [...ROLE_PERMISSIONS[role]];
}

export function hasPermission(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].includes(permission);
}

export function hasAllPermissions(role: Role, permissions: readonly Permission[]): boolean {
  return permissions.every((p) => hasPermission(role, p));
}
