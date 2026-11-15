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
