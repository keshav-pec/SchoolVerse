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
import {
  DATA_CLASSIFICATION,
  DTO_ALLOWED_CLASSES,
  EMPLOYEE_ACTIONS,
  EMPLOYEE_STATUSES,
  SYSTEM_FIELDS,
  classOf,
  type DataClass,
  type EmployeeAction,
  type EmployeeStatus,
} from '@shared';
import { AppError } from '../src/core/errors';
import { diffFields } from '../src/modules/audit/diff';
import { assertTransition, availableActions, canTransition } from '../src/modules/locations/lifecycle';
import type { EmployeeDoc } from '../src/modules/staff/employee.model';
import { Employee } from '../src/modules/staff/employee.model';
import { assertEmployeeTransition, availableActions as employeeActions, canTransition as canEmployeeTransition, exitTarget } from '../src/modules/staff/lifecycle';
import type { Hydration } from '../src/modules/staff/mappers';
import { toDirectoryDTO, toProfileDTO } from '../src/modules/staff/mappers';
import type { PersonDoc } from '../src/modules/staff/person.model';
import { Person } from '../src/modules/staff/person.model';
import type { StaffMasterDoc } from '../src/modules/staff/master.model';
import { addDays, assignmentStatus, overlapping } from '../src/modules/staff/status';

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


describe('employee lifecycle state machine (FSM-01)', () => {
  const legal: Record<EmployeeStatus, Partial<Record<EmployeeAction, EmployeeStatus>>> = {
    ONBOARDING: { activate: 'ACTIVE', exit: 'NOTICE_PERIOD' },
    ACTIVE: { leave: 'ON_LEAVE', suspend: 'SUSPENDED', exit: 'NOTICE_PERIOD' },
    ON_LEAVE: { activate: 'ACTIVE', suspend: 'SUSPENDED', exit: 'NOTICE_PERIOD' },
    SUSPENDED: { activate: 'ACTIVE', exit: 'NOTICE_PERIOD' },
    NOTICE_PERIOD: { cancel_exit: 'ACTIVE', complete_exit: 'EXITED' },
    EXITED: {},
  };

  for (const from of EMPLOYEE_STATUSES) {
    for (const action of EMPLOYEE_ACTIONS) {
      const to = legal[from][action];
      if (to) {
        it(`${from} --${action}--> ${to}`, () => {
          expect(canEmployeeTransition(from, action)).toBe(true);
          expect(assertEmployeeTransition(from, action)).toBe(to);
        });
      } else {
        it(`${from} --${action}--> rejected with INVALID_STATUS_TRANSITION`, () => {
          expect(canEmployeeTransition(from, action)).toBe(false);
          expect(() => assertEmployeeTransition(from, action)).toThrow(AppError);
          try {
            assertEmployeeTransition(from, action);
          } catch (err) {
            expect((err as AppError).code).toBe('INVALID_STATUS_TRANSITION');
          }
        });
      }
    }
  }

  it('offers EXITED employees no actions, and never lists the system-only completion', () => {
    expect(employeeActions('EXITED')).toEqual([]);
    expect(employeeActions('NOTICE_PERIOD')).toEqual(['cancel_exit']);
    for (const status of EMPLOYEE_STATUSES) expect(employeeActions(status)).not.toContain('complete_exit');
  });

  it('an exit dated today or earlier is immediate; a later one is a notice period', () => {
    expect(exitTarget('2026-11-14', '2026-11-15')).toBe('EXITED');
    expect(exitTarget('2026-11-15', '2026-11-15')).toBe('EXITED');
    expect(exitTarget('2026-11-16', '2026-11-15')).toBe('NOTICE_PERIOD');
  });
});

describe('effective-dated assignment status (Module 3 "Effective dating")', () => {
  const today = '2026-11-15';
  it('is computed from the dates and cancelledAt, with the last day inclusive', () => {
    expect(assignmentStatus({ effectiveFrom: '2026-11-16' }, today)).toBe('PLANNED');
    expect(assignmentStatus({ effectiveFrom: '2026-11-15' }, today)).toBe('ACTIVE');
    expect(assignmentStatus({ effectiveFrom: '2026-04-01', effectiveTo: null }, today)).toBe('ACTIVE');
    expect(assignmentStatus({ effectiveFrom: '2026-04-01', effectiveTo: '2026-11-15' }, today)).toBe('ACTIVE');
    expect(assignmentStatus({ effectiveFrom: '2026-04-01', effectiveTo: '2026-11-14' }, today)).toBe('COMPLETED');
    expect(assignmentStatus({ effectiveFrom: '2026-04-01', effectiveTo: '2026-11-14', cancelledAt: new Date() }, today)).toBe('CANCELLED');
    expect(assignmentStatus({ effectiveFrom: '2027-01-01', cancelledAt: new Date() }, today)).toBe('CANCELLED');
  });

  it('adds days without a time zone shift, across month and year ends', () => {
    expect(addDays('2026-04-01', -1)).toBe('2026-03-31');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  it('builds an overlap filter for open-ended and closed ranges', () => {
    expect(overlapping('2026-04-01', null).$and).toHaveLength(1);
    expect(overlapping('2026-04-01', '2026-09-30').$and).toHaveLength(2);
  });
});

describe('data classification (SEC-01, PRD §15 and §37)', () => {
  const systemFields: readonly string[] = SYSTEM_FIELDS;
  /** Top-level business paths of a Mongoose schema (nested sub-paths are covered by their parent). */
  const businessPaths = (schema: { paths: Record<string, unknown> }) => [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]!))].filter((p) => !systemFields.includes(p));

  it('classifies every field of people and employees, and nothing stale', () => {
    expect(businessPaths(Person.schema).sort()).toEqual(Object.keys(DATA_CLASSIFICATION.person).sort());
    expect(businessPaths(Employee.schema).filter((p) => !['statusChangedAt', 'statusChangedBy'].includes(p)).sort()).toEqual(Object.keys(DATA_CLASSIFICATION.employee).sort());
  });

  it('puts government IDs, bank details and the date of birth in the restricted class, and never in a DTO', () => {
    expect(classOf('person', 'dateOfBirth')).toBe('RESTRICTED');
    expect(classOf('restricted_person_data', 'governmentIds')).toBe('RESTRICTED');
    expect(classOf('restricted_person_data', 'bank')).toBe('RESTRICTED');
    expect(DTO_ALLOWED_CLASSES.directory).toEqual(['INTERNAL']);
    for (const allowed of Object.values(DTO_ALLOWED_CLASSES) as readonly (readonly DataClass[])[]) {
      expect(allowed).not.toContain('RESTRICTED');
      expect(allowed).not.toContain('SECRET');
    }
  });

  it('DTO mappers leak only the classes they are allowed to carry', () => {
    // Every non-internal value is a unique canary string; the DTO output is searched for them.
    const canary = (field: string) => `CANARY_${field}`;
    const person = {
      _id: 'p1', tenantId: 't', status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date(),
      legalFirstName: 'Priya', legalMiddleName: null, legalLastName: 'Sharma', preferredName: null,
      dateOfBirth: canary('dateOfBirth'),
      primaryEmail: canary('primaryEmail'), primaryPhone: canary('primaryPhone'),
      personalEmail: canary('personalEmail'), personalPhone: canary('personalPhone'),
      address: { line1: canary('address'), line2: null, city: null, state: null, postalCode: null, country: null },
      emergencyContact: { name: canary('emergencyContact'), relation: 'Spouse', phone: '+910000000000' },
      profilePhotoKey: canary('profilePhotoKey'),
    } as unknown as PersonDoc;
    const employee = {
      _id: 'e1', tenantId: 't', personId: 'p1', schoolId: 's', employeeCode: 'FAC-1', employeeCategory: 'FACULTY', employmentType: null,
      joiningDate: '2020-04-01', confirmationDate: null, departmentId: 'd', designationId: 'g', reportingManagerId: null,
      officialEmail: 'o@x.demo', officialPhone: null, status: 'EXITED', exitDate: '2026-01-01', exitReasonCategory: 'OTHER',
      exitNote: canary('exitNote'), createdAt: new Date(), updatedAt: new Date(),
    } as unknown as EmployeeDoc;
    const master = (id: string) => ({ _id: id, code: id.toUpperCase(), name: id }) as unknown as StaffMasterDoc;
    const h: Hydration = {
      today: '2026-11-15',
      people: new Map([['p1', person]]),
      departments: new Map([['d', master('d')]]),
      designations: new Map([['g', master('g')]]),
      placements: new Map(),
      managers: new Map(),
    };

    const directory = JSON.stringify(toDirectoryDTO(employee, h));
    const profile = JSON.stringify(toProfileDTO(employee, h, { viewPersonal: false, deletable: false }));
    const personal = JSON.stringify(toProfileDTO(employee, h, { viewPersonal: true, deletable: false }));

    const personalFields = (Object.entries(DATA_CLASSIFICATION.person) as [string, DataClass][]).concat(Object.entries(DATA_CLASSIFICATION.employee) as [string, DataClass][]);
    for (const [field, cls] of personalFields) {
      if (cls === 'INTERNAL') continue;
      if (cls === 'RESTRICTED' || cls === 'SECRET') {
        for (const dto of [directory, profile, personal]) expect(dto, `${field} must not appear`).not.toContain(canary(field));
      } else {
        expect(directory, `${field} must not be in the directory`).not.toContain(canary(field));
        expect(profile, `${field} needs employee:view_personal`).not.toContain(canary(field));
      }
    }
    for (const field of ['personalEmail', 'personalPhone', 'primaryEmail', 'primaryPhone', 'address', 'emergencyContact', 'exitNote']) expect(personal, field).toContain(canary(field));
    expect(personal).not.toContain(canary('profilePhotoKey'));
  });
});
