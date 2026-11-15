import {
  createLocationSchema,
  createSchoolSchema,
  hasPermission,
  LOCATION_ACTIONS,
  LOCATION_STATUSES,
  missingActivationFields,
  normalizeLocationCode,
  postalCodeError,
  ROLES,
  suggestLocationCodeBase,
  updateLocationSchema,
  type LocationAction,
  type LocationStatus,
  type Permission,
} from '@shared';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors';
import { diffFields } from '../src/modules/audit/diff';
import { assertTransition, availableActions, canTransition } from '../src/modules/locations/lifecycle';

describe('location lifecycle state machine (SCH-LOC-06)', () => {
  const legal: Record<LocationStatus, Partial<Record<LocationAction, LocationStatus>>> = {
    DRAFT: { activate: 'ACTIVE', archive: 'ARCHIVED' },
    ACTIVE: { deactivate: 'INACTIVE' },
    INACTIVE: { activate: 'ACTIVE', archive: 'ARCHIVED' },
    ARCHIVED: {},
  };

  for (const from of LOCATION_STATUSES) {
    for (const action of LOCATION_ACTIONS) {
      const to = legal[from][action];
      if (to) {
        it(`${from} --${action}--> ${to}`, () => {
          expect(canTransition(from, action)).toBe(true);
          expect(assertTransition(from, action)).toBe(to);
        });
      } else {
        it(`${from} --${action}--> rejected with INVALID_STATUS_TRANSITION`, () => {
          expect(canTransition(from, action)).toBe(false);
          try {
            assertTransition(from, action);
            expect.unreachable();
          } catch (err) {
            expect(err).toBeInstanceOf(AppError);
            expect((err as AppError).code).toBe('INVALID_STATUS_TRANSITION');
          }
        });
      }
    }
  }

  it('ARCHIVED is terminal', () => {
    expect(availableActions('ARCHIVED')).toEqual([]);
  });

  it('an ACTIVE location must be deactivated before it can be archived', () => {
    expect(() => assertTransition('ACTIVE', 'archive')).toThrow('Deactivate this location before archiving it.');
  });
});

describe('location code rules (SCH-LOC-08)', () => {
  it('trims and upper-cases codes', () => {
    expect(normalizeLocationCode('  del01 ')).toBe('DEL01');
    const parsed = createLocationSchema.parse({ displayName: 'Delhi', locationCode: ' del01 ', locationType: 'BRANCH_CAMPUS' });
    expect(parsed.locationCode).toBe('DEL01');
  });

  it.each(['M', 'TOOLONGCODE1', 'MO H', 'MOH!', '-MOH', ''])('rejects invalid code %j', (code) => {
    const res = createLocationSchema.safeParse({ displayName: 'X', locationCode: code, locationType: 'MAIN_CAMPUS' });
    expect(res.success).toBe(false);
  });

  it.each(['MOH', 'CHD', 'PKL', 'DEL01', 'NORTH-1', 'mo'])('accepts valid code %j', (code) => {
    const res = createLocationSchema.safeParse({ displayName: 'X', locationCode: code, locationType: 'MAIN_CAMPUS' });
    expect(res.success).toBe(true);
  });

  it.each([
    ['Mohali Campus', 'MOH'],
    ['Panchkula', 'PAN'],
    ['New Delhi Campus', 'ND'],
    ['Main Campus', 'MC'],
    ['Sector 17 Branch', 'S1'],
    ['São Paulo', 'SP'],
    ['शाखा', 'LOC'],
  ])('suggests a code base for %j → %s', (name, expected) => {
    expect(suggestLocationCodeBase(name)).toBe(expected);
  });
});

describe('field validation (PRD §18)', () => {
  it('normalises phone numbers to E.164 and rejects invalid ones', () => {
    const ok = updateLocationSchema.parse({ phone: '098765 43210' });
    expect(ok.phone).toBe('+919876543210');
    expect(updateLocationSchema.safeParse({ phone: '12345' }).success).toBe(false);
    expect(updateLocationSchema.parse({ phone: '+1 415 555 2671' }).phone).toBe('+14155552671');
  });

  it('validates emails and clears empty optional fields', () => {
    expect(updateLocationSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
    expect(updateLocationSchema.parse({ email: '', notes: '  ' })).toEqual({ email: null, notes: null });
    expect(updateLocationSchema.parse({})).toEqual({});
  });

  it('checks postal codes against the country', () => {
    expect(postalCodeError('160071', 'IN')).toBeNull();
    expect(postalCodeError('06007', 'IN')).toMatch(/PIN/);
    expect(postalCodeError('94105-1234', 'US')).toBeNull();
    expect(postalCodeError('SW1A 1AA', 'GB')).toBeNull();
    expect(postalCodeError('10115', 'DE')).toBeNull(); // generic fallback
    const res = updateLocationSchema.safeParse({ address: { postalCode: '1600', country: 'IN' } });
    expect(res.success).toBe(false);
  });

  it('validates time zones, currencies and locales', () => {
    const base = {
      schoolCode: 'GPS',
      legalName: 'L',
      displayName: 'D',
      primaryEmail: 'a@b.co',
      primaryPhone: '+919876543210',
    };
    const parsed = createSchoolSchema.parse(base);
    expect(parsed).toMatchObject({ defaultTimezone: 'Asia/Kolkata', defaultCurrency: 'INR', defaultLocale: 'en-IN' });
    expect(createSchoolSchema.safeParse({ ...base, defaultTimezone: 'Mars/Olympus' }).success).toBe(false);
    expect(createSchoolSchema.safeParse({ ...base, defaultTimezone: 'EST' }).success).toBe(false);
    expect(createSchoolSchema.safeParse({ ...base, defaultCurrency: 'XYZ' }).success).toBe(false);
    expect(createSchoolSchema.parse({ ...base, defaultLocale: 'en-in' }).defaultLocale).toBe('en-IN');
  });

  it('requires both coordinates or neither, within range', () => {
    const base = { displayName: 'X', locationCode: 'XX', locationType: 'MAIN_CAMPUS' };
    expect(createLocationSchema.safeParse({ ...base, latitude: 30.7 }).success).toBe(false);
    expect(createLocationSchema.safeParse({ ...base, latitude: 95, longitude: 76 }).success).toBe(false);
    expect(createLocationSchema.safeParse({ ...base, latitude: '30.70', longitude: '76.71' }).success).toBe(true);
  });

  it('drafts may be incomplete, but ACTIVE needs phone + structured address', () => {
    const base = { displayName: 'X', locationCode: 'XX', locationType: 'MAIN_CAMPUS' };
    expect(createLocationSchema.safeParse(base).success).toBe(true);
    const res = createLocationSchema.safeParse({ ...base, intent: 'ACTIVE' });
    expect(res.success).toBe(false);
    expect(Object.keys(missingActivationFields({}))).toEqual([
      'phone',
      'address.line1',
      'address.city',
      'address.state',
      'address.postalCode',
      'address.country',
    ]);
  });

  it('a draft cannot be created as Primary', () => {
    const res = createLocationSchema.safeParse({ displayName: 'X', locationCode: 'XX', locationType: 'MAIN_CAMPUS', isPrimary: true });
    expect(res.success).toBe(false);
  });
});

describe('audit diffFields (SCH-LOC-10)', () => {
  it('captures only changed, whitelisted fields with previous and new values', () => {
    const before = { name: 'Mohali', phone: '+91 98', secret: 'a', address: { city: 'Mohali', state: 'PB' } };
    const after = { name: 'Mohali', phone: '+91 99', secret: 'b', address: { city: 'SAS Nagar', state: 'PB' } };
    expect(diffFields(before, after, ['name', 'phone', 'address.city', 'address.state'])).toEqual([
      { field: 'phone', from: '+91 98', to: '+91 99' },
      { field: 'address.city', from: 'Mohali', to: 'SAS Nagar' },
    ]);
  });

  it('treats undefined and null as equal, serialises dates and ignores key order', () => {
    const d1 = new Date('2026-01-01T00:00:00Z');
    const d2 = new Date('2026-06-01T00:00:00Z');
    expect(diffFields({ a: undefined, d: d1 }, { a: null, d: d2 }, ['a', 'd'])).toEqual([
      { field: 'd', from: d1.toISOString(), to: d2.toISOString() },
    ]);
    expect(diffFields({ o: { x: 1, y: 2 } }, { o: { y: 2, x: 1 } }, ['o'])).toEqual([]);
  });
});

describe('RBAC matrix (PRD §7)', () => {
  const adminOnly: Permission[] = [
    'school:edit',
    'school:view_config',
    'location:view_config',
    'location:create',
    'location:edit',
    'location:set_primary',
    'location:change_status',
    'location:archive',
    'setup:manage',
    'audit:view',
  ];

  it('defines the four baseline roles: admin has everything, Faculty/Staff read-only, Parents nothing', () => {
    expect([...ROLES]).toEqual(['SCHOOL_ADMIN', 'FACULTY', 'STAFF', 'PARENT']);
    for (const p of adminOnly) expect(hasPermission('SCHOOL_ADMIN', p)).toBe(true);
    for (const role of ['FACULTY', 'STAFF'] as const) {
      expect(hasPermission(role, 'school:view')).toBe(true);
      expect(hasPermission(role, 'location:view')).toBe(true);
      for (const p of adminOnly) expect(hasPermission(role, p)).toBe(false);
    }
    expect(hasPermission('PARENT', 'school:view')).toBe(false);
    expect(hasPermission('PARENT', 'location:view')).toBe(false);
  });
});
