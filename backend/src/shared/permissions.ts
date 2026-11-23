import type { Role } from './enums';
import { TIMETABLE_BUNDLES, type TimetableBundle } from './timetable';

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
  // Finance (Module 7). Nobody but the School Admin has these by default; Staff get them through job bundles (FINANCE_BUNDLES).
  'finance:view',
  'finance:setup:manage',
  'finance:fee_plan:manage',
  'finance:billing:create',
  'finance:billing:approve',
  'finance:concession:manage',
  'finance:concession:approve',
  'finance:adjustment:create',
  'finance:adjustment:approve',
  'finance:collection:record',
  'finance:collection:verify',
  'finance:receipt:cancel',
  'finance:refund:request',
  'finance:refund:approve',
  'finance:refund:disburse',
  'finance:reconciliation:manage',
  'finance:cashier:shift',
  'finance:cashier:supervise',
  'finance:accounting:view',
  'finance:accounting:post',
  'finance:period:close',
  'finance:expense:record',
  'finance:expense:approve',
  'finance:vendor:manage',
  'finance:tax:manage',
  'finance:tax:review',
  'finance:report:view',
  'finance:report:export',
  'finance:audit:view',
  'finance:access:manage',
  'payroll:setup:manage',
  'payroll:structure:manage',
  'payroll:input:manage',
  'payroll:run:prepare',
  'payroll:run:approve',
  'payroll:disbursement:manage',
  'payroll:disbursement:verify',
  'payroll:salary:view_sensitive',
  'payroll:settlement:manage',
  'payroll:report:view',
  // Timetable (Module 6). Faculty get `timetable:view` only. Staff get the rest through job bundles (TIMETABLE_BUNDLES).
  'timetable:view',
  'timetable:setup:manage', // plan, school week, Daily Periods, Subject Needs, Teaching Groups
  'timetable:draft:create',
  'timetable:entry:create',
  'timetable:entry:edit',
  'timetable:entry:delete',
  'timetable:bulk:manage',
  'timetable:smart_draft:run',
  'timetable:conflict:override',
  'timetable:review',
  'timetable:publish',
  'timetable:faculty_availability:manage',
  'timetable:substitution:manage',
  'timetable:override:manage',
  'timetable:report:view',
  'timetable:audit:view',
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
const FACULTY_VIEW: Permission[] = [...COLLEAGUE_VIEW, 'space:view', 'timetable:view'];

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

// ───────────────────────────────────────────────────────────── Finance job bundles (Module 7)

/**
 * Finance work is given as job bundles, not new roles. A School Admin gives a Staff user one or more bundles; the server reads them
 * from the database on every request, so removing a bundle takes effect at once. A bundle never widens the user's campus scope.
 */
export const FINANCE_BUNDLES = ['COLLECTOR', 'FEE_MANAGER', 'ACCOUNTANT', 'PAYROLL_OFFICER', 'APPROVER', 'AUDITOR'] as const;
export type FinanceBundle = (typeof FINANCE_BUNDLES)[number];

const PAYROLL_ALL = PERMISSIONS.filter((p) => p.startsWith('payroll:'));
const ALL_APPROVE = PERMISSIONS.filter((p) => p.endsWith(':approve'));

export const FINANCE_BUNDLE_PERMISSIONS: Record<FinanceBundle, readonly Permission[]> = {
  COLLECTOR: ['finance:view', 'finance:collection:record', 'finance:cashier:shift'],
  FEE_MANAGER: ['finance:view', 'finance:fee_plan:manage', 'finance:billing:create', 'finance:concession:manage', 'finance:adjustment:create'],
  ACCOUNTANT: [
    'finance:view', 'finance:accounting:view', 'finance:accounting:post', 'finance:reconciliation:manage', 'finance:collection:verify', 'finance:refund:request',
    'finance:expense:record', 'finance:vendor:manage', 'finance:tax:manage', 'finance:tax:review', 'finance:report:view', 'finance:report:export', 'finance:cashier:supervise', 'finance:refund:disburse',
  ],
  PAYROLL_OFFICER: ['finance:view', ...PAYROLL_ALL.filter((p) => p !== 'payroll:run:approve')],
  APPROVER: ['finance:view', ...ALL_APPROVE, 'finance:period:close'],
  AUDITOR: ['finance:view', 'finance:audit:view', 'finance:accounting:view', 'finance:report:view'],
};

/** What each bundle lets a person do, in plain words (the Access tab shows these). */
export const FINANCE_BUNDLE_LABELS: Record<FinanceBundle, { label: string; help: string }> = {
  COLLECTOR: { label: 'Cashier', help: 'Can take fees and manage their own cash shift.' },
  FEE_MANAGER: { label: 'Fee Manager', help: 'Can set up fee plans, prepare bills and manage concessions.' },
  ACCOUNTANT: { label: 'Accountant', help: 'Can verify payments, match the bank, record expenses, manage tax and see reports.' },
  PAYROLL_OFFICER: { label: 'Payroll Officer', help: 'Can prepare salaries and payslips. Cannot approve a payroll run.' },
  APPROVER: { label: 'Approver', help: 'Can approve bills, refunds, credit notes, payroll and period close.' },
  AUDITOR: { label: 'Auditor', help: 'Can look at finance records and the audit trail. Cannot change anything.' },
};

export function bundlePermissions(bundles: readonly FinanceBundle[]): Permission[] {
  return [...new Set(bundles.flatMap((b) => FINANCE_BUNDLE_PERMISSIONS[b]))];
}

// ───────────────────────────────────────────────────────────── Timetable job bundles (Module 6)

const TIMETABLE_ALL = PERMISSIONS.filter((p) => p.startsWith('timetable:'));

/** The same idea as the finance bundles: given to a Staff or Faculty login, read from the database on every request, never a new role. */
export const TIMETABLE_BUNDLE_PERMISSIONS: Record<TimetableBundle, readonly Permission[]> = {
  SCHEDULING_COORDINATOR: TIMETABLE_ALL.filter((p) => !['timetable:publish', 'timetable:conflict:override', 'timetable:audit:view'].includes(p)),
  SUBSTITUTION_MANAGER: ['timetable:view', 'timetable:substitution:manage', 'timetable:override:manage'],
  FRONT_OFFICE: ['timetable:view', 'timetable:report:view'],
};

export function timetableBundlePermissions(bundles: readonly TimetableBundle[]): Permission[] {
  return [...new Set(bundles.flatMap((b) => TIMETABLE_BUNDLE_PERMISSIONS[b]))];
}
export { TIMETABLE_BUNDLES };
