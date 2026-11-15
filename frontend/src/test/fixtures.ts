import { permissionsFor, type LocationDetailDTO, type LocationListDTO, type Role, type SchoolDTO, type SessionDTO } from '@shared';

export const SCHOOL_ID = '11111111-1111-4111-8111-111111111111';

export function sessionFor(role: Role): SessionDTO {
  return {
    user: { userId: 'u1', tenantId: 't1', email: `${role.toLowerCase()}@greenfield.demo`, fullName: 'Test User', role, status: 'ACTIVE', lastLoginAt: null, createdAt: '2026-01-01T00:00:00.000Z' },
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
  setup: { status: 'IN_PROGRESS', currentStep: 1, completedAt: null },
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
