import { permissionsFor, type EmployeeProfileDTO, type RestrictedEmployeeProfileDTO, type SelfProfileDTO, type LocationDetailDTO, type LocationListDTO, type Role, type SchoolDTO, type SessionDTO } from '@shared';

export const SCHOOL_ID = '11111111-1111-4111-8111-111111111111';

export function sessionFor(role: Role): SessionDTO {
  return {
    user: { userId: 'u1', tenantId: 't1', email: `${role.toLowerCase()}@greenfield.demo`, fullName: 'Test User', role, status: 'ACTIVE', personId: null, lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
    tenant: { tenantId: 't1', name: 'Greenfield', slug: 'greenfield', status: 'ACTIVE' },
    permissions: permissionsFor(role),
  };
}

export const school: SchoolDTO = {
  schoolId: SCHOOL_ID,
  tenantId: 't1',
  schoolCode: 'GPS',
  legalName: 'Greenfield Public School Society',
  displayName: 'Greenfield Public School',
  shortName: 'Greenfield',
  logoUrl: null,
  primaryEmail: 'office@greenfield.demo',
  primaryPhone: '+919876543210',
  alternatePhone: null,
  websiteUrl: null,
  defaultTimezone: 'Asia/Kolkata',
  defaultCurrency: 'INR',
  defaultLocale: 'en-IN',
  status: 'ACTIVE',
  setupCompleted: true,
  setup: { status: 'COMPLETED', currentStep: 5, completedAt: '2026-01-02T00:00:00.000Z' },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export function location(overrides: Partial<LocationDetailDTO> = {}): LocationDetailDTO {
  return {
    locationId: '22222222-2222-4222-8222-222222222222',
    schoolId: SCHOOL_ID,
    locationCode: 'MOH',
    displayName: 'Mohali Campus',
    officialName: null,
    locationType: 'MAIN_CAMPUS',
    isPrimary: true,
    status: 'ACTIVE',
    openingDate: null,
    timezoneOverride: null,
    currencyOverride: null,
    localeOverride: null,
    effectiveDefaults: { timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN', inherited: { timezone: true, currency: true, locale: true } },
    email: null,
    phone: '+919876543210',
    alternatePhone: null,
    websiteUrl: null,
    latitude: null,
    longitude: null,
    address: { line1: '1 Sector 70', line2: null, locality: null, city: 'Mohali', district: null, state: 'Punjab', postalCode: '160071', country: 'IN' },
    staffCount: null,
    studentCount: null,
    notes: null,
    statusChangedAt: null,
    archivedAt: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    codeLocked: false,
    deletable: false,
    ...overrides,
  };
}

export function list(items: LocationDetailDTO[]): LocationListDTO {
  const statuses = { DRAFT: 0, ACTIVE: 0, INACTIVE: 0, ARCHIVED: 0 };
  const types = { MAIN_CAMPUS: 0, BRANCH_CAMPUS: 0, ADMINISTRATIVE: 0 };
  for (const l of items) {
    statuses[l.status] += 1;
    types[l.locationType] += 1;
  }
  return {
    items,
    page: 1,
    pageSize: 20,
    total: items.length,
    facets: { cities: [...new Set(items.map((l) => l.address.city).filter((c): c is string => !!c))].map((city) => ({ city, count: 1 })), statuses, types },
  };
}

/** A school whose first-time setup is not finished yet. */
export function unfinishedSchool(currentStep = 1) {
  return { ...school, setupCompleted: false, setup: { status: 'IN_PROGRESS' as const, currentStep, completedAt: null } };
}

export const setupStatus = {
  schoolId: SCHOOL_ID,
  setupStatus: 'COMPLETED' as const,
  currentStep: 5,
  completionPercent: 88,
  coreCompletionPercent: 92,
  items: [
    { key: 'school_profile', label: 'School Profile', description: 'Name, legal name, code and operational defaults.', status: 'completed' as const, weight: 15, module: 'school-setup', href: '/school-setup/profile' },
    { key: 'primary_location', label: 'Primary Location', description: 'Your main campus.', status: 'completed' as const, weight: 20, module: 'school-setup', href: '/school-setup/locations' },
    { key: 'official_identifiers', label: 'Official Identifiers', description: 'Affiliation, registration or UDISE+ numbers.', status: 'pending' as const, weight: 5, module: 'school-setup', href: '/school-setup/profile' },
    { key: 'academic_structure', label: 'Academic Structure', description: 'Academic years, grades, sections and subjects.', status: 'upcoming' as const, weight: 20, module: 'academic-structure', href: null },
    { key: 'buildings_rooms', label: 'Buildings & Rooms', description: 'Buildings and rooms for each campus.', status: 'upcoming' as const, weight: 10, module: 'buildings-rooms', href: null },
    { key: 'academic_calendar', label: 'Academic Calendar', description: 'Terms, holidays and key dates.', status: 'upcoming' as const, weight: 10, module: 'academic-calendar', href: null },
  ],
  nextStep: null as unknown,
  summary: { schoolName: 'Greenfield Public School', primaryLocation: { locationId: '22222222-2222-4222-8222-222222222222', displayName: 'Mohali Campus', locationCode: 'MOH' }, activeLocations: 2, draftLocations: 1, totalLocations: 3 },
};
setupStatus.nextStep = setupStatus.items[2];

// ───────────────────────────────────────────────────────────── Faculty & Staff (Module 3)

export const EMPLOYEE_ID = '77777777-7777-4777-8777-777777777777';
export const PERSON_ID = '88888888-8888-4888-8888-888888888888';

export function employeeProfile(overrides: Partial<EmployeeProfileDTO> = {}): EmployeeProfileDTO {
  const loc = { locationId: '22222222-2222-4222-8222-222222222222', locationCode: 'MOH', displayName: 'Mohali Campus', isPrimary: true, status: 'ACTIVE' as const };
  return {
    employeeId: EMPLOYEE_ID,
    employeeCode: 'FAC-001',
    fullName: 'Priya Sharma',
    displayName: 'Priya Sharma',
    preferredName: null,
    employeeCategory: 'FACULTY',
    employmentType: 'Permanent',
    department: { departmentId: 'd1', code: 'ACADEMICS', name: 'Academics' },
    designation: { designationId: 'g1', code: 'PGT', name: 'PGT' },
    status: 'ACTIVE',
    primaryLocation: loc,
    locations: [loc],
    officialEmail: 'priya@greenfield.demo',
    officialPhone: null,
    personId: PERSON_ID,
    schoolId: 's1',
    legalFirstName: 'Priya',
    legalMiddleName: null,
    legalLastName: 'Sharma',
    joiningDate: '2016-04-01',
    confirmationDate: null,
    reportingManager: null,
    exit: null,
    lifecycleActions: ['leave', 'suspend', 'exit'],
    deletable: false,
    readOnly: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

export const restrictedProfile: RestrictedEmployeeProfileDTO = {
  employeeId: EMPLOYEE_ID,
  personId: PERSON_ID,
  dateOfBirth: { masked: '••/••/1988' },
  governmentIds: [{ type: 'PAN', masked: 'XXXX XXXX 000X' }],
  bank: { accountHolderName: 'Priya Sharma', accountNumberMasked: '•••• 5678', ifsc: 'TEST0000001', bankName: 'Demo Bank' },
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export function selfProfile(overrides: Partial<SelfProfileDTO> = {}): SelfProfileDTO {
  const user = sessionFor('FACULTY').user;
  return {
    profile: employeeProfile({ personal: { primaryEmail: null, primaryPhone: null, personalEmail: 'priya.home@greenfield.demo', personalPhone: null, address: null, emergencyContact: null } }),
    dateOfBirth: '1988-03-14',
    restricted: restrictedProfile,
    locationAssignments: [],
    academicAssignments: [],
    responsibilities: [],
    account: { ...user, personId: PERSON_ID },
    pendingRequests: [],
    ...overrides,
  };
}
