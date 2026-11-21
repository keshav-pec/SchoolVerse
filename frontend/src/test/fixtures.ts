import { permissionsFor, type AcademicSessionDTO, type ClassOfferingDTO, type EnrollmentDTO, type GuardianLinkDTO, type MasterLocationDTO, type SectionAssignmentDTO, type StudentAdminProfileDTO, type StudentDirectoryDTO, type EmployeeProfileDTO, type RestrictedEmployeeProfileDTO, type SelfProfileDTO, type LocationDetailDTO, type LocationListDTO, type Role, type SchoolDTO, type SessionDTO } from '@shared';

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
    { key: 'academic_structure', label: 'Academic Structure', description: 'Academic years, classes, sections and subjects.', status: 'upcoming' as const, weight: 20, module: 'academic-structure', href: null },
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


// ───────────────────────────────────────────────────────────── Students (Module 4)

export const STUDENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
export const SESSION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
export const LOCATION_ID = '22222222-2222-4222-8222-222222222222';
export const CLASS_OFFERING_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
export const SECTION_A_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
export const SECTION_B_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
export const ENROLLMENT_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

export const academicSession: AcademicSessionDTO = {
  academicSessionId: SESSION_ID,
  schoolId: SCHOOL_ID,
  name: 'Academic Year 2026-27',
  code: '2026-27',
  startDate: '2026-04-01',
  endDate: '2027-03-31',
  status: 'ACTIVE',
  isCurrent: true,
  locations: [],
  previousSessionId: null,
  warnings: [],
  deletable: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export const masterLocation: MasterLocationDTO = {
  locationId: LOCATION_ID,
  schoolId: SCHOOL_ID,
  locationCode: 'MOH',
  displayName: 'Mohali Campus',
  locationType: 'MAIN_CAMPUS',
  status: 'ACTIVE',
  isPrimary: true,
  city: 'Mohali',
  state: 'Punjab',
  country: 'IN',
  effectiveDefaults: { timezone: 'Asia/Kolkata', currency: 'INR', locale: 'en-IN' },
};

export const classOffering: ClassOfferingDTO = {
  classOfferingId: CLASS_OFFERING_ID,
  academicSessionId: SESSION_ID,
  locationId: LOCATION_ID,
  classId: 'class-8',
  canonicalCode: 'G08',
  displayName: 'Class VIII',
  displayCode: 'VIII',
  medium: null,
  capacity: null,
  sequenceOrder: 8,
  status: 'ACTIVE',
  sectionCount: 2,
  subjectCount: 5,
};

export const classSection = (code: string | null = 'A') => ({
  classOfferingId: CLASS_OFFERING_ID,
  className: 'Class VIII',
  classCode: 'VIII',
  sectionId: code ? (code === 'A' ? SECTION_A_ID : SECTION_B_ID) : null,
  sectionCode: code,
  label: code ? `VIII-${code}` : 'VIII',
});

export function sectionAssignment(overrides: Partial<SectionAssignmentDTO> = {}): SectionAssignmentDTO {
  return {
    sectionAssignmentId: 'assign-1',
    enrollmentId: ENROLLMENT_ID,
    studentId: STUDENT_ID,
    sectionId: SECTION_A_ID,
    sectionCode: 'A',
    sectionName: 'VIII-A',
    rollNumber: '17',
    effectiveFrom: '2026-04-01',
    effectiveTo: null,
    cancelledAt: null,
    reason: null,
    status: 'ACTIVE',
    ...overrides,
  };
}

export function enrollmentDto(overrides: Partial<EnrollmentDTO> = {}): EnrollmentDTO {
  return {
    enrollmentId: ENROLLMENT_ID,
    studentId: STUDENT_ID,
    academicSessionId: SESSION_ID,
    sessionCode: '2026-27',
    sessionName: 'Academic Year 2026-27',
    locationId: LOCATION_ID,
    locationName: 'Mohali Campus',
    classOfferingId: CLASS_OFFERING_ID,
    className: 'Class VIII',
    classCode: 'VIII',
    programmeId: null,
    programmeName: null,
    enrollmentType: 'NEW_ADMISSION',
    effectiveFrom: '2026-04-01',
    effectiveTo: null,
    state: 'OPEN',
    status: 'ACTIVE',
    outcome: null,
    previousEnrollmentId: null,
    section: sectionAssignment(),
    version: 1,
    createdAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

export function studentProfile(overrides: Partial<StudentAdminProfileDTO> = {}): StudentAdminProfileDTO {
  return {
    studentId: STUDENT_ID,
    admissionNumber: 'GPS/2026/00001',
    fullName: 'Riya Sharma',
    displayName: 'Riya Sharma',
    status: 'ACTIVE',
    hasPhoto: false,
    academicSessionId: SESSION_ID,
    locationId: LOCATION_ID,
    enrollmentId: ENROLLMENT_ID,
    enrollmentStatus: 'ACTIVE',
    classSection: classSection('A'),
    rollNumber: '17',
    primaryGuardianName: 'Priya Sharma',
    personId: 'person-1',
    legalFirstName: 'Riya',
    legalMiddleName: null,
    legalLastName: 'Sharma',
    preferredName: null,
    gender: 'FEMALE',
    bloodGroup: null,
    notes: null,
    personalIncluded: true,
    dateOfBirth: '2014-05-10',
    primaryPhone: null,
    primaryEmail: null,
    address: null,
    admission: null,
    externalIds: [],
    guardianCount: 1,
    enrollment: enrollmentDto(),
    missing: [],
    deletable: false,
    availableActions: ['deactivate'],
    version: 1,
    createdAt: '2026-04-01T00:00:00.000Z',
    updatedAt: '2026-04-01T00:00:00.000Z',
    ...overrides,
  };
}

export function directoryRow(overrides: Partial<StudentDirectoryDTO> = {}): StudentDirectoryDTO {
  return {
    studentId: STUDENT_ID,
    admissionNumber: 'GPS/2026/00001',
    fullName: 'Riya Sharma',
    displayName: 'Riya Sharma',
    status: 'ACTIVE',
    hasPhoto: false,
    academicSessionId: SESSION_ID,
    locationId: LOCATION_ID,
    enrollmentId: ENROLLMENT_ID,
    enrollmentStatus: 'ACTIVE',
    classSection: classSection('A'),
    rollNumber: '17',
    primaryGuardianName: 'Priya Sharma',
    ...overrides,
  };
}

export function guardianLink(overrides: Partial<GuardianLinkDTO> = {}): GuardianLinkDTO {
  return {
    guardianLinkId: 'link-1',
    studentId: STUDENT_ID,
    guardianPersonId: 'person-parent',
    fullName: 'Priya Sharma',
    relationshipType: 'Mother',
    isPrimary: true,
    isEmergencyContact: false,
    communicationPriority: 1,
    canSeeAcademics: true,
    canSeeFees: true,
    pickupAllowed: false,
    portalEnabled: false,
    effectiveFrom: '2026-04-01',
    effectiveTo: null,
    status: 'ACTIVE',
    phone: '+910000000001',
    email: 'priya@family.demo',
    version: 1,
    ...overrides,
  };
}
