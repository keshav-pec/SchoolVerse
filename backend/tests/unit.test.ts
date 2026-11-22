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
import { floorCodeFor, floorFromName } from '@shared';
import { buildingCodeFrom, shiftTrailingNumber, spaceCodeFrom } from '../src/modules/spaces/codes';
import { assertSpaceTransition, assertStructureTransition } from '../src/modules/spaces/lifecycle';
import { effectiveStatusOf, resolveSpace, warningsFor } from '../src/modules/spaces/resolve';
import { endOf, isLive, periodsOverlap, phaseOf, runsOn, shiftsClash } from '../src/modules/spaces/assignment.rules';
import { suggestSpaceMapping } from '../src/modules/spaces/import.service';
import { Building, Floor, OutboxEvent, PhysicalSpace, SpaceAvailabilityBlock, SectionSpaceAssignment, SpaceAssignmentLock, SpaceChangeLog, SpaceImport, SpaceImportRow, SpaceType } from '../src/modules/spaces/space.models';
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
import { MASKED_DTO_ALLOWED_CLASSES } from '@shared';
import { createFieldCrypto, mask, signFileToken, verifyFileToken } from '../src/platform/identity/crypto';
import { csvCell, parseCsv, toCsv } from '../src/platform/identity/csv';
import { classKey, parseGender, parseImportDate, parseRelationship, sectionKey, splitName, splitSubjects, suggestMapping } from '../src/modules/students/import-rules';
import { formatTcNumber, isFinalClass, pickSection, PROMOTION_REASON_TEXT, promotionReviewReasons, resolveNextClass } from '../src/modules/students/rules';
import { simplePdf } from '../src/modules/students/tc.service';
import { StudentChangeRequest, StudentCounter, StudentDocument, StudentExport, StudentImport, StudentImportRow, StudentTransferCertificate } from '../src/modules/students/records.models';
import { safeFileName, scanFile, sniffDocumentType, EICAR_SIGNATURE } from '../src/platform/identity/file-checks';
import { AccountToken } from '../src/platform/identity/account-token.model';
import { toRestrictedDTO } from '../src/platform/identity/restricted-data';
import { RestrictedPersonData, type RestrictedPersonDataDoc } from '../src/platform/identity/restricted-data.model';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { DevOutbox } from '../src/platform/identity/notifier';
import { EmployeeDocument, ProfileChangeRequest, StaffExport } from '../src/modules/staff/identity.models';
import { toUserDTO } from '../src/platform/users/user.mapper';
import { User, type UserDoc } from '../src/platform/users/user.model';
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
import { addDays, daysBetween } from '../src/core/dates';
import { assignmentStatus, overlapping } from '../src/modules/staff/status';
import {
  PROMOTION_REVIEW_REASONS,
  STUDENT_ACTIONS,
  STUDENT_DTO_ALLOWED_CLASSES,
  STUDENT_STATUSES,
  admissionNumberSchema,
  rollNumberSchema,
  type StudentAction,
  type StudentStatus,
} from '@shared';
import type { ClassOfferingDoc, SectionOfferingDoc } from '../src/modules/academic/offering.model';
import type { StudentHydration } from '../src/modules/students/directory';
import {
  ACTION_FOR_TARGET as STUDENT_ACTION_FOR_TARGET,
  assertStudentTransition,
  availableActions as availableStudentActions,
  canTransition as canStudentTransition,
} from '../src/modules/students/lifecycle';
import { toAdmissionDTO, toDirectoryDTO as toStudentDirectoryDTO, toFacultySummaryDTO } from '../src/modules/students/mappers';
import { pickEnrollment, pickEnrollmentIn } from '../src/modules/students/placement';
import { endPatch } from '../src/modules/students/rows';
import {
  checkSubjectSelection,
  editDistance,
  enrollmentStatus,
  formatAdmissionNumber,
  isOpenOn,
  isSimilarName,
  mandatoryOfferingIds,
  naturalCompare,
  nameKey,
  nextFreeRoll,
  type CheckConstraint,
  type CheckGroup,
  type CheckOffering,
  type CheckProgramme,
} from '../src/modules/students/rules';
import {
  AdmissionNumberSettings,
  Student,
  StudentAdmission,
  StudentEnrollment,
  StudentExternalId,
  StudentGuardianLink,
  StudentSectionAssignment,
  StudentSubjectEnrollment,
  StudentTransferEvent,
  type StudentAdmissionDoc,
  type StudentDoc,
  type StudentEnrollmentDoc,
  type StudentSectionAssignmentDoc,
} from '../src/modules/students/student.models';

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
    expect(daysBetween('2026-04-01', '2027-04-01')).toBe(365);
    expect(daysBetween('2027-03-01', '2026-03-01')).toBe(-365);
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


describe('data classification covers the identity collections too (SEC-01)', () => {
  const systemFields: readonly string[] = SYSTEM_FIELDS;
  const businessPaths = (schema: { paths: Record<string, unknown> }) => [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]!))].filter((p) => !systemFields.includes(p));
  const classified = (entity: keyof typeof DATA_CLASSIFICATION) => Object.keys(DATA_CLASSIFICATION[entity]).sort();

  it('every field of every identity collection has a class, and nothing in the map is stale', () => {
    const cases: [keyof typeof DATA_CLASSIFICATION, { schema: { paths: Record<string, unknown> } }][] = [
      ['restricted_person_data', RestrictedPersonData],
      ['user', User],
      ['account_token', AccountToken],
      ['employee_document', EmployeeDocument],
      ['profile_change_request', ProfileChangeRequest],
      ['security_event', SecurityEvent],
      ['export', StaffExport],
      ['dev_outbox', DevOutbox],
    ];
    for (const [entity, model] of cases) {
      // Timestamps the schema adds itself are system fields; `requestedBy` is the only creator column of an export.
      expect(businessPaths(model.schema).sort(), entity).toEqual(classified(entity));
    }
  });

  it('secrets are classed SECRET, and no DTO kind may carry them', () => {
    expect(classOf('user', 'passwordHash')).toBe('SECRET');
    expect(classOf('account_token', 'tokenHash')).toBe('SECRET');
    expect(classOf('employee_document', 'objectKey')).toBe('SECRET');
    expect(classOf('export', 'objectKey')).toBe('SECRET');
    expect(classOf('dev_outbox', 'link')).toBe('SECRET');
    expect(classOf('profile_change_request', 'proposedValueEnc')).toBe('RESTRICTED');
    for (const allowed of Object.values(MASKED_DTO_ALLOWED_CLASSES) as readonly (readonly DataClass[])[]) expect(allowed).not.toContain('SECRET');
  });

  it('the restricted DTO and the user DTO leak no ciphertext, hash or secret', () => {
    const doc = {
      _id: 'r1', tenantId: 't', personId: 'p1', createdAt: new Date(), updatedAt: new Date(),
      governmentIds: [{ type: 'PAN', valueEnc: 'CANARY_valueEnc', last4: '1234' }],
      bank: { accountHolderName: 'A B', accountNumberEnc: 'CANARY_accountNumberEnc', last4: '5678', ifsc: 'TEST0000001', bankName: 'Demo' },
    } as unknown as RestrictedPersonDataDoc;
    const dto = JSON.stringify(toRestrictedDTO({ employeeId: 'e1', personId: 'p1' }, doc, '1988-03-14'));
    expect(dto).not.toMatch(/CANARY|1988-03|"last4"/);
    expect(dto).toContain('XXXX XXXX 1234');

    const user = { _id: 'u1', tenantId: 't', email: 'a@x.demo', fullName: 'A', role: 'FACULTY', status: 'ACTIVE', personId: 'p1', passwordHash: 'CANARY_hash', createdAt: new Date() } as unknown as UserDoc;
    expect(JSON.stringify(toUserDTO(user))).not.toContain('CANARY');
  });
});

describe('field encryption (SEC-02, PRD §14)', () => {
  const k1 = Buffer.alloc(32, 1).toString('base64');
  const k2 = Buffer.alloc(32, 2).toString('base64');

  it('round-trips a value, never repeats a ciphertext, and writes the key id in front', () => {
    const c = createFieldCrypto(`v1:${k1}`);
    const a = c.encryptField('TESTP1234X', 'p1:id:PAN');
    const b = c.encryptField('TESTP1234X', 'p1:id:PAN');
    expect(a).toMatch(/^v1:[\w-]+:[\w-]+:[\w-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain('TESTP1234X');
    expect(c.decryptField(a, 'p1:id:PAN')).toBe('TESTP1234X');
    expect(c.decryptField(c.encryptField(''))).toBe('');
  });

  it('key rotation: a new key encrypts, the old one still decrypts, and removing it makes old values unreadable', () => {
    const old = createFieldCrypto(`v1:${k1}`).encryptField('secret', 'ctx');
    const rotated = createFieldCrypto(`v2:${k2},v1:${k1}`);
    expect(rotated.decryptField(old, 'ctx')).toBe('secret');
    expect(rotated.encryptField('secret', 'ctx').startsWith('v2:')).toBe(true);
    expect(() => createFieldCrypto(`v2:${k2}`).decryptField(old, 'ctx')).toThrow();
  });

  it('a tampered value, a wrong context and a moved ciphertext are all refused', () => {
    const c = createFieldCrypto(`v1:${k1}`);
    const stored = c.encryptField('secret', 'p1:bank');
    const [kid, iv, tag, ct] = stored.split(':');
    expect(() => c.decryptField(stored, 'p2:bank')).toThrow(); // copied onto another person
    expect(() => c.decryptField(`${kid}:${iv}:${tag}:${ct!.slice(0, -2)}AA`, 'p1:bank')).toThrow();
    expect(() => c.decryptField(`${kid}:${iv}:${Buffer.alloc(16).toString('base64url')}:${ct}`, 'p1:bank')).toThrow();
    expect(() => c.decryptField('garbage', 'p1:bank')).toThrow();
  });

  it('rejects keys of the wrong size, repeated ids and an empty list', () => {
    expect(() => createFieldCrypto('v1:abc')).toThrow(/32 bytes/);
    expect(() => createFieldCrypto(`v1:${k1},v1:${k2}`)).toThrow(/repeats/);
    expect(() => createFieldCrypto('')).toThrow();
    expect(() => createFieldCrypto(k1)).toThrow();
  });

  it('masks show the year, or the last four characters, and nothing else', () => {
    expect(mask('1988-03-14', 'DATE_OF_BIRTH')).toBe('••/••/1988');
    expect(mask('123456781234', 'GOVERNMENT_ID')).toBe('XXXX XXXX 1234');
    expect(mask('1234', 'GOVERNMENT_ID')).toBe('XXXX XXXX 1234');
    expect(mask('000000005678', 'BANK_ACCOUNT')).toBe('•••• 5678');
  });
});

describe('signed file links (SEC-05, PRD §18)', () => {
  const payload = { k: 'documents/abc', m: 'application/pdf', n: 'a.pdf', t: 'tenant-1' };

  it('verifies a fresh token and returns what was signed', () => {
    const { token, expiresAt } = signFileToken(payload, 60, 1_000_000);
    expect(verifyFileToken(token, 1_000_000 + 59_000)).toMatchObject(payload);
    expect(expiresAt.getTime()).toBe(1_060_000);
  });

  it('refuses an expired, tampered, truncated or foreign-signed token, all the same way', () => {
    const { token } = signFileToken(payload, 60, 1_000_000);
    const [body, signature] = token.split('.');
    expect(verifyFileToken(token, 1_000_000 + 61_000)).toBeNull();
    const forged = Buffer.from(JSON.stringify({ ...payload, k: 'documents/other', exp: 9_999_999_999 })).toString('base64url');
    expect(verifyFileToken(`${forged}.${signature}`)).toBeNull();
    expect(verifyFileToken(`${body}.${signature!.slice(0, -1)}A`, 1_000_000)).toBeNull();
    expect(verifyFileToken(`${body}.`)).toBeNull();
    expect(verifyFileToken(body!)).toBeNull();
    expect(verifyFileToken(`${token}.extra`)).toBeNull();
    expect(verifyFileToken('')).toBeNull();
  });
});

describe('uploads and CSV (PRD §18, §19)', () => {
  it('detects PDF, PNG and JPEG from their bytes and nothing else', () => {
    expect(sniffDocumentType(Buffer.from('%PDF-1.7\n'))).toBe('application/pdf');
    expect(sniffDocumentType(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffDocumentType(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    for (const bytes of ['<svg/>', '<html>', 'GIF89a', 'PK\x03\x04', '', 'MZ']) expect(sniffDocumentType(Buffer.from(bytes))).toBeNull();
  });

  it('the default scanner flags the EICAR test string and passes ordinary files', async () => {
    expect(await scanFile(Buffer.from(`%PDF-1.4 ${EICAR_SIGNATURE}`))).toEqual({ clean: false, reason: 'EICAR' });
    expect(await scanFile(Buffer.from('%PDF-1.4 hello'))).toEqual({ clean: true });
  });

  it('file names are made safe for headers', () => {
    expect(safeFileName('../../etc/passwd')).toBe('_.._etc_passwd');
    expect(safeFileName('a"b\r\nc.pdf')).not.toMatch(/["\r\n]/);
    expect(safeFileName('', 'fallback')).toBe('fallback');
    expect(safeFileName('résumé.pdf')).toBe('resume.pdf');
  });

  it('CSV cells that would run as formulas get a leading apostrophe, and standard quoting applies', () => {
    for (const bad of ['=SUM(A1)', '+1', '-1', '@cmd', '\tx', '\rx']) expect(csvCell(bad), bad).toMatch(/^"?'/);
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('two\nlines')).toBe('"two\nlines"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(toCsv(['A', 'B'], [['=x', 'y']])).toBe("A,B\r\n'=x,y\r\n");
  });
});

// ───────────────────────────────────────────────────────────── students and parents (Module 4, Part 1)

describe('student lifecycle state machine (SPM-33)', () => {
  const statuses = STUDENT_STATUSES;
  const expected: Record<string, Partial<Record<StudentAction, StudentStatus>>> = {
    DRAFT: { admit: 'ADMISSION_PENDING', activate: 'ACTIVE' },
    ADMISSION_PENDING: { activate: 'ACTIVE' },
    ACTIVE: { deactivate: 'INACTIVE', start_withdrawal: 'WITHDRAWAL_INITIATED', complete_schooling: 'COMPLETED_SCHOOLING' },
    INACTIVE: { reactivate: 'ACTIVE', start_withdrawal: 'WITHDRAWAL_INITIATED' },
    WITHDRAWAL_INITIATED: { cancel_withdrawal: 'ACTIVE', complete_withdrawal: 'WITHDRAWN' },
    WITHDRAWN: { readmit: 'ACTIVE' },
    TRANSFERRED_OUT: { readmit: 'ACTIVE' },
    COMPLETED_SCHOOLING: { readmit: 'ACTIVE' },
  };

  it('allows exactly the documented moves and refuses everything else', () => {
    for (const from of statuses) {
      for (const action of STUDENT_ACTIONS) {
        const to = expected[from]![action];
        expect(canStudentTransition(from, action), `${from} ${action}`).toBe(Boolean(to));
        if (to) expect(assertStudentTransition(from, action)).toBe(to);
        else expect(() => assertStudentTransition(from, action)).toThrowError(expect.objectContaining({ code: 'INVALID_STATUS_TRANSITION' }));
      }
    }
  });

  it('says why a move is refused, in plain words', () => {
    expect(() => assertStudentTransition('WITHDRAWN', 'deactivate')).toThrowError(/left the school/);
    expect(() => assertStudentTransition('WITHDRAWAL_INITIATED', 'deactivate')).toThrowError(/Cancel the withdrawal/);
    expect(() => assertStudentTransition('DRAFT', 'deactivate')).toThrowError(/not confirmed/);
  });

  it('offers the buttons that fit a status, and the status endpoint maps its two targets', () => {
    expect(availableStudentActions('ACTIVE').sort()).toEqual(['complete_schooling', 'deactivate', 'start_withdrawal']);
    expect(availableStudentActions('WITHDRAWN')).toEqual(['readmit']);
    expect(STUDENT_ACTION_FOR_TARGET).toEqual({ ACTIVE: 'reactivate', INACTIVE: 'deactivate' });
  });
});

describe('student rules without a database (Module 4, Part 1)', () => {
  it('works out the shown status of an enrollment from its dates', () => {
    expect(enrollmentStatus({ state: 'OPEN', effectiveFrom: '2026-04-01' }, '2026-03-31')).toBe('PLANNED');
    expect(enrollmentStatus({ state: 'OPEN', effectiveFrom: '2026-04-01' }, '2026-04-01')).toBe('ACTIVE');
    for (const state of ['COMPLETED', 'WITHDRAWN', 'TRANSFERRED', 'CANCELLED'] as const) expect(enrollmentStatus({ state, effectiveFrom: '2026-04-01' }, '2026-06-01')).toBe(state);
    expect(isOpenOn({ effectiveFrom: '2026-04-01', effectiveTo: '2026-09-30' }, '2026-09-30')).toBe(true);
    expect(isOpenOn({ effectiveFrom: '2026-04-01', effectiveTo: '2026-09-30' }, '2026-10-01')).toBe(false);
    expect(isOpenOn({ effectiveFrom: '2026-04-01', cancelledAt: new Date() }, '2026-06-01')).toBe(false);
    expect(endPatch({ effectiveFrom: '2026-06-01' }, '2026-05-31')).toHaveProperty('cancelledAt');
    expect(endPatch({ effectiveFrom: '2026-04-01' }, '2026-05-31')).toEqual({ effectiveTo: '2026-05-31' });
  });

  it('picks where a student is from the rows: the one running, then the next, then the latest', () => {
    const row = (id: string, effectiveFrom: string, effectiveTo: string | null = null, state: StudentEnrollmentDoc['state'] = 'OPEN') =>
      ({ _id: id, effectiveFrom, effectiveTo, state, cancelledAt: null, academicSessionId: 's' }) as unknown as StudentEnrollmentDoc;
    expect(pickEnrollment([row('old', '2025-04-01', '2026-03-31', 'COMPLETED'), row('now', '2026-04-01')], '2026-08-01')?._id).toBe('now');
    expect(pickEnrollment([row('old', '2025-04-01', '2026-03-31', 'COMPLETED'), row('next', '2027-04-01')], '2026-08-01')?._id).toBe('next');
    expect(pickEnrollment([row('old', '2025-04-01', '2026-03-31', 'COMPLETED'), row('bad', '2026-04-01', null, 'CANCELLED')], '2026-08-01')?._id).toBe('old');
    expect(pickEnrollment([], '2026-08-01')).toBeNull();
    expect(pickEnrollmentIn([row('a', '2026-04-01', '2026-06-30', 'TRANSFERRED'), row('b', '2026-07-01')], 's')?._id).toBe('b');
  });

  it('builds admission numbers from the pattern and leaves empty parts out', () => {
    const pattern = { prefix: 'GPS', includeLocationCode: false, includeYear: true, padding: 5 };
    expect(formatAdmissionNumber(pattern, { locationCode: 'MOH', year: 2027, sequence: 482 })).toBe('GPS/2027/00482');
    expect(formatAdmissionNumber({ ...pattern, includeLocationCode: true }, { locationCode: 'MOH', year: 2027, sequence: 7 })).toBe('GPS/MOH/2027/00007');
    expect(formatAdmissionNumber({ ...pattern, includeYear: false, padding: 3 }, { locationCode: null, year: 2027, sequence: 12 })).toBe('GPS/012');
    expect(formatAdmissionNumber({ prefix: '', includeLocationCode: true, includeYear: false, padding: 4 }, { locationCode: null, year: null, sequence: 1 })).toBe('0001');
    expect(formatAdmissionNumber({ ...pattern, prefix: 'gps' }, { locationCode: null, year: 2026, sequence: 123456 })).toBe('GPS/2026/123456');
    expect(admissionNumberSchema.parse(' gps/2026/00482 ')).toBe('GPS/2026/00482');
    expect(admissionNumberSchema.safeParse('has space').success).toBe(false);
  });

  it('hands out the next free roll number', () => {
    expect(nextFreeRoll([])).toBe('1');
    expect(nextFreeRoll(['1', '2', '3'])).toBe('4');
    expect(nextFreeRoll(['1', '5', null])).toBe('6');
    expect(nextFreeRoll(['A1', 'B2'])).toBe('1');
    expect(['A-10', 'A-2', 'A-1'].sort(naturalCompare)).toEqual(['A-1', 'A-2', 'A-10']);
    expect(rollNumberSchema.parse(' a-7 ')).toBe('A-7');
    expect(rollNumberSchema.safeParse('too long for a roll').success).toBe(false);
  });

  it('compares names ignoring order, case and accents, and spots near misses', () => {
    expect(nameKey('Riya', null, 'Sharma')).toBe(nameKey('sharma', 'RIYA'));
    expect(nameKey('Zoë', 'Müller')).toBe('muller zoe');
    expect(editDistance('kitten', 'sitting')).toBe(3);
    expect(isSimilarName('simran kaur', 'simrann kaur')).toBe(true);
    expect(isSimilarName('riya sharma', 'riya sharma')).toBe(false);
    expect(isSimilarName('riya sharma', 'tina verma')).toBe(false);
    expect(isSimilarName('amit', 'amir')).toBe(true);
  });

  describe('subject choice check', () => {
    const o = (id: string, name: string, type: CheckOffering['type'] = 'ELECTIVE'): CheckOffering => ({ id, name, type, active: true });
    const offerings = [o('m', 'Maths', 'MANDATORY'), o('e', 'English', 'MANDATORY'), o('h', 'Hindi'), o('p', 'Punjabi'), o('c', 'Computer'), o('b', 'Biology'), o('u', 'Urdu'), o('x', 'Retired')];
    offerings[7]!.active = false;
    const groups: CheckGroup[] = [
      { id: 'g1', name: 'Language', ruleType: 'CHOOSE_ONE', min: 1, max: 1, subjectOfferingIds: ['h', 'p'], active: true },
      { id: 'g2', name: 'Activity', ruleType: 'CHOOSE_N', min: 1, max: 2, subjectOfferingIds: ['c', 'b', 'u'], active: true },
    ];
    const constraints: CheckConstraint[] = [
      { type: 'REQUIRES', subjectOfferingId: 'b', otherSubjectOfferingId: 'c' },
      { type: 'EXCLUDES', subjectOfferingId: 'p', otherSubjectOfferingId: 'u' },
    ];
    const check = (selected: string[], extra: Partial<Parameters<typeof checkSubjectSelection>[0]> = {}) =>
      checkSubjectSelection({ offerings, groups, constraints, programme: null, selected, addMandatory: true, ...extra });

    it('adds the always-taken subjects itself when saving, and asks for them when checking what a student takes', () => {
      expect(check(['h', 'c']).selectedOfferingIds.sort()).toEqual(['c', 'e', 'h', 'm']);
      const today = check(['h', 'c'], { addMandatory: false });
      expect(today.problems).toEqual([expect.objectContaining({ code: 'MISSING_MANDATORY', message: 'Required: Maths and English.' })]);
    });

    it('counts each group and explains it in words', () => {
      expect(check(['h', 'p', 'c']).problems).toEqual([expect.objectContaining({ code: 'GROUP_TOO_MANY', message: 'Pick only 1 from Language. You picked 2.' })]);
      expect(check(['h']).problems).toEqual([expect.objectContaining({ code: 'GROUP_TOO_FEW', message: 'Pick 1 from Activity. You picked 0.' })]);
      expect(check(['h', 'c', 'u']).valid).toBe(true);
      expect(check(['h', 'c', 'b', 'u']).problems.map((p) => p.code)).toContain('GROUP_TOO_MANY');
      expect(check(['h', 'c']).groups).toEqual([expect.objectContaining({ summary: 'Choose 1 of Hindi, Punjabi', picked: 1, satisfied: true }), expect.objectContaining({ summary: 'Choose 1 to 2 of Computer, Biology, Urdu', satisfied: true })]);
    });

    it('applies requires and excludes pairs, and refuses subjects the class does not offer', () => {
      expect(check(['h', 'b']).problems).toEqual([expect.objectContaining({ code: 'REQUIRES', message: 'Biology needs Computer too.' })]);
      expect(check(['p', 'u']).problems).toEqual([expect.objectContaining({ code: 'EXCLUDES', message: 'Punjabi and Urdu cannot be taken together.' })]);
      expect(check(['h', 'c', 'x']).problems).toEqual([expect.objectContaining({ code: 'NOT_OFFERED' })]);
      expect(check(['h', 'c', 'nope']).problems[0]!.message).toBe('One of the subjects is not offered in this class.');
    });

    it('applies a stream’s own rules, and leaves a flexible combination to the class rules', () => {
      const stream: CheckProgramme = {
        name: 'Science',
        kind: 'STREAM',
        subjectRules: [
          { subjectOfferingId: 'h', requirement: 'REQUIRED' },
          { subjectOfferingId: 'c', requirement: 'CHOICE' },
          { subjectOfferingId: 'b', requirement: 'CHOICE' },
        ],
        choiceMin: 1,
        choiceMax: 1,
      };
      expect(check(['h', 'c'], { programme: stream }).valid).toBe(true);
      expect(check(['p', 'c'], { programme: stream }).problems.map((p) => p.code)).toEqual(expect.arrayContaining(['PROGRAMME_REQUIRED', 'NOT_IN_PROGRAMME']));
      expect(check(['h', 'u'], { programme: stream }).problems.map((p) => p.code)).toEqual(expect.arrayContaining(['PROGRAMME_CHOICE_TOO_FEW', 'NOT_IN_PROGRAMME']));
      expect(check(['h', 'c', 'b'], { programme: stream }).problems.map((p) => p.code)).toContain('PROGRAMME_CHOICE_TOO_MANY');
      expect(check(['p', 'u'], { programme: { ...stream, kind: 'FLEXIBLE' } }).problems.map((p) => p.code)).not.toContain('PROGRAMME_REQUIRED');
      expect(mandatoryOfferingIds(offerings, [{ id: 'g3', name: 'All', ruleType: 'REQUIRED_ALL', min: 2, max: 2, subjectOfferingIds: ['h', 'x'], active: true }])).toEqual(['m', 'e', 'h']);
    });
  });
});

describe('student data classification (SEC-SPM-02)', () => {
  const systemFields: readonly string[] = SYSTEM_FIELDS;
  const businessPaths = (schema: { paths: Record<string, unknown> }) => [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]!))].filter((p) => !systemFields.includes(p));
  const classified = (entity: keyof typeof DATA_CLASSIFICATION) => Object.keys(DATA_CLASSIFICATION[entity]).sort();

  it('every field of every student collection has a class, and nothing in the map is stale', () => {
    const cases: [keyof typeof DATA_CLASSIFICATION, { schema: { paths: Record<string, unknown> } }][] = [
      ['student', Student],
      ['student_admission', StudentAdmission],
      ['admission_number_settings', AdmissionNumberSettings],
      ['student_external_id', StudentExternalId],
      ['student_guardian_link', StudentGuardianLink],
      ['student_enrollment', StudentEnrollment],
      ['student_section_assignment', StudentSectionAssignment],
      ['student_subject_enrollment', StudentSubjectEnrollment],
      ['student_transfer_event', StudentTransferEvent],
    ];
    for (const [entity, model] of cases) expect(businessPaths(model.schema).sort(), entity).toEqual(classified(entity));
    // The people table gained a gender column, and it is classed too.
    expect(classOf('person', 'gender')).toBe('PERSONAL');
  });

  it('puts contact, previous school, outside IDs and the photo key out of every list, and never in a DTO', () => {
    expect(classOf('student', 'photoKey')).toBe('SECRET');
    expect(classOf('student_external_id', 'value')).toBe('PERSONAL');
    expect(classOf('student_admission', 'previousSchool')).toBe('PERSONAL');
    expect(classOf('student', 'bloodGroup')).toBe('PERSONAL');
    for (const kind of ['directory', 'facultySummary', 'parentSummary', 'adminProfile'] as const) expect(STUDENT_DTO_ALLOWED_CLASSES[kind]).toEqual(['INTERNAL']);
    for (const allowed of Object.values(STUDENT_DTO_ALLOWED_CLASSES) as readonly (readonly DataClass[])[]) expect(allowed).not.toContain('SECRET');
  });

  it('the student mappers leak only the classes they are allowed to carry', () => {
    const canary = (field: string) => `CANARY_${field}`;
    const person = {
      _id: 'p1', tenantId: 't', legalFirstName: 'Riya', legalMiddleName: null, legalLastName: 'Sharma', preferredName: null,
      gender: canary('gender'), dateOfBirth: canary('dateOfBirth'), primaryEmail: canary('primaryEmail'), primaryPhone: canary('primaryPhone'),
      personalEmail: canary('personalEmail'), personalPhone: canary('personalPhone'), address: { line1: canary('address'), line2: null, city: null, state: null, postalCode: null, country: null },
      emergencyContact: null, profilePhotoKey: canary('profilePhotoKey'),
    } as unknown as PersonDoc;
    const student = { _id: 's1', tenantId: 't', personId: 'p1', status: 'ACTIVE', photoKey: canary('photoKey'), bloodGroup: canary('bloodGroup'), notes: canary('notes'), version: 1 } as unknown as StudentDoc;
    const admission = {
      _id: 'a1', studentId: 's1', admissionNumber: 'GPS/1', admissionDate: '2026-04-01', mode: 'NEW_ADMISSION', admissionSessionId: 'x', admissionLocationId: 'y', admissionClassOfferingId: 'c1',
      isCurrent: true, category: canary('category'), previousSchool: { name: canary('previousSchool'), board: null, className: null, tcNumber: null }, remarks: canary('remarks'),
    } as unknown as StudentAdmissionDoc;
    const klass = { _id: 'c1', displayName: 'Class VIII', displayCode: 'VIII' } as unknown as ClassOfferingDoc;
    const section = { _id: 'sec1', sectionCode: 'A', displayName: 'A' } as unknown as SectionOfferingDoc;
    const enrollment = { _id: 'e1', studentId: 's1', classOfferingId: 'c1', academicSessionId: 'x', locationId: 'y', state: 'OPEN', effectiveFrom: '2026-04-01' } as unknown as StudentEnrollmentDoc;
    const assignment = { _id: 'as1', sectionId: 'sec1', rollNumber: '7' } as unknown as StudentSectionAssignmentDoc;
    const h: StudentHydration = {
      today: '2026-11-15',
      people: new Map([['p1', person]]),
      admissions: new Map([['s1', admission]]),
      placements: new Map([['s1', { enrollment, assignment }]]),
      classes: new Map([['c1', klass]]),
      sections: new Map([['sec1', section]]),
      primaryGuardianNames: new Map([['s1', 'Priya Sharma']]),
    };
    const directory = JSON.stringify(toStudentDirectoryDTO(student, h));
    const faculty = JSON.stringify(toFacultySummaryDTO(student, h, [{ subjectOfferingId: 'o1', subjectName: 'Maths' }]));
    const withoutPersonal = JSON.stringify(toAdmissionDTO(admission, 'Class VIII', false));
    const withPersonal = JSON.stringify(toAdmissionDTO(admission, 'Class VIII', true));

    const fields = [...Object.entries(DATA_CLASSIFICATION.student), ...Object.entries(DATA_CLASSIFICATION.student_admission), ...Object.entries(DATA_CLASSIFICATION.person)] as [string, DataClass][];
    for (const [field, cls] of fields) {
      if (cls === 'INTERNAL') continue;
      for (const [name, dto] of [['directory', directory], ['faculty summary', faculty]] as const) expect(dto, `${field} must not be in the ${name}`).not.toContain(canary(field));
      if (cls === 'PERSONAL' || cls === 'RESTRICTED') expect(withoutPersonal, `${field} needs student:view_personal`).not.toContain(canary(field));
      if (cls === 'SECRET') expect(withPersonal, `${field} is never sent`).not.toContain(canary(field));
    }
    for (const field of ['category', 'previousSchool', 'remarks']) expect(withPersonal, field).toContain(canary(field));
    expect(directory).toContain('Priya Sharma');
    expect(faculty).not.toContain('Priya Sharma');
    expect(directory).toContain('VIII-A');
  });
});

// ───────────────────────────────────────────────────────────── Module 4, Part 3

describe('promotion rules (SPM-28)', () => {
  const levels = [5, 6, 7, 9].map((n) => ({ classOfferingId: `c${n}`, classId: `k${n}`, sequenceNumber: n }));

  it('the standard next class is the one straight after; a gap needs a person, and the last class has none', () => {
    expect(resolveNextClass(6, levels)?.classOfferingId).toBe('c7');
    expect(resolveNextClass(7, levels)).toBeNull(); // Class 8 is not offered: no skipping to 9
    expect(resolveNextClass(9, levels)).toBeNull();
    expect(isFinalClass(9, [5, 6, 7, 9])).toBe(true);
    expect(isFinalClass(7, [5, 6, 7, 9])).toBe(false);
  });

  it('sections are filled evenly: not full first, fewest students, then the usual order', () => {
    const load = (sectionId: string, enrolled: number, capacity: number | null, sequenceOrder = 0) => ({ sectionId, enrolled, capacity, sequenceOrder });
    expect(pickSection([load('a', 30, 40, 1), load('b', 25, 40, 2), load('c', 25, 40, 3)])?.sectionId).toBe('b');
    expect(pickSection([load('a', 40, 40, 1), load('b', 39, 40, 2)])?.sectionId).toBe('b');
    expect(pickSection([load('a', 40, 40, 1), load('b', 41, 40, 2)])?.sectionId).toBe('a'); // all full: the least over
    expect(pickSection([load('a', 99, null, 1), load('b', 10, 40, 2)])?.sectionId).toBe('b');
    expect(pickSection([])).toBeNull();
  });

  it('review reasons are plain, and a student in the last class needs nothing about next year', () => {
    const facts = { studentStatus: 'ACTIVE' as const, hasSection: true, locationInTarget: true, nextClassFound: true, isFinal: false, subjectChoiceIncomplete: false, programmeOk: true, alreadyHasTargetEnrollment: false };
    expect(promotionReviewReasons(facts)).toEqual([]);
    expect(promotionReviewReasons({ ...facts, studentStatus: 'WITHDRAWAL_INITIATED' })).toEqual(['LEAVING']);
    expect(promotionReviewReasons({ ...facts, studentStatus: 'INACTIVE' })).toEqual(['STUDENT_NOT_ACTIVE']);
    expect(promotionReviewReasons({ ...facts, nextClassFound: false })).toEqual(['NO_NEXT_CLASS']);
    expect(promotionReviewReasons({ ...facts, locationInTarget: false, nextClassFound: false })).toEqual(['LOCATION_MISSING']);
    expect(promotionReviewReasons({ ...facts, hasSection: false, subjectChoiceIncomplete: true, programmeOk: false })).toEqual(['SECTION_MISSING', 'SUBJECT_CHOICE_PENDING', 'PROGRAMME_NOT_VALID']);
    expect(promotionReviewReasons({ ...facts, alreadyHasTargetEnrollment: true })).toEqual(['ALREADY_PROMOTED']);
    expect(promotionReviewReasons({ ...facts, isFinal: true, nextClassFound: false, subjectChoiceIncomplete: true, programmeOk: false })).toEqual([]);
    for (const code of PROMOTION_REVIEW_REASONS) expect(PROMOTION_REASON_TEXT[code], code).toMatch(/[a-z]/);
  });
});

describe('transfer certificate number (SPM-30)', () => {
  it('is TC / session / four digits, and only the counter decides the number', () => {
    expect(formatTcNumber('2026-27', 4)).toBe('TC/2026-27/0004');
    expect(formatTcNumber('2026-27', 12345)).toBe('TC/2026-27/12345');
    expect(formatTcNumber('20 26/27!', 1)).toBe('TC/202627/0001');
  });

  it('simplePdf makes a real one-page PDF that passes the upload checks, whatever the text', () => {
    const pdf = simplePdf(['Greenfield (Public) School', 'Name: Riya \\ Kaur', 'Ünïcode → ?']);
    expect(sniffDocumentType(pdf)).toBe('application/pdf');
    const text = pdf.toString('latin1');
    expect(text).toContain('%%EOF');
    expect(text).toContain('Greenfield \\(Public\\) School');
    expect(text).toMatch(/xref\n0 6/);
    // The cross-reference table points at real objects.
    const offsets = [...text.matchAll(/(\d{10}) 00000 n/g)].map((m) => Number(m[1]));
    expect(offsets).toHaveLength(5);
    offsets.forEach((offset, i) => expect(text.slice(offset, offset + 8)).toBe(`${i + 1} 0 obj\n`));
  });
});

describe('student import rules (SPM-32)', () => {
  it('QA M1: matches the headers schools really use, and uses a column only once', () => {
    expect(suggestMapping(['Student Name', 'Admission No', 'Class', 'Section', 'Father Mobile', 'DOB', 'Roll No.', 'Parent Email'])).toEqual({
      studentName: 'Student Name',
      admissionNumber: 'Admission No',
      className: 'Class',
      sectionName: 'Section',
      guardianPhone: 'Father Mobile',
      dateOfBirth: 'DOB',
      rollNumber: 'Roll No.',
      guardianEmail: 'Parent Email',
    });
    // Two phone columns: the first is used, the second is left for the admin.
    expect(suggestMapping(['Name', 'Father Mobile', 'Mother Mobile', 'Grade'])).toEqual({ studentName: 'Name', guardianPhone: 'Father Mobile', className: 'Grade' });
    expect(suggestMapping(['x', 'y'])).toEqual({});
  });

  it('reads class and section the way schools write them', () => {
    for (const v of ['VIII', 'Class 8', 'class VIII', '8', '8th', 'Grade 8', 'STD. 8', ' viii ']) expect(classKey(v), v).toBe('8');
    expect(classKey('Class 12')).toBe('12');
    expect(classKey('XII')).toBe('12');
    expect(classKey('Nursery')).toBe('nursery');
    expect(classKey('LKG')).toBe('lkg');
    for (const v of ['A', 'a', 'VIII-A', '8 A', 'Class 8 - a']) expect(sectionKey(v), v).toBe('A');
  });

  it('reads dates day-first, and refuses dates that do not exist', () => {
    expect(parseImportDate('2019-04-01')).toBe('2019-04-01');
    expect(parseImportDate('01/04/2019')).toBe('2019-04-01');
    expect(parseImportDate('1-4-2019')).toBe('2019-04-01');
    expect(parseImportDate('1.4.2019')).toBe('2019-04-01');
    for (const bad of ['31/02/2019', '2019-13-01', 'April 1', '', '2019/04/01']) expect(parseImportDate(bad), bad).toBeNull();
  });

  it('reads gender, relationship, subjects and full names', () => {
    expect([parseGender('M'), parseGender('female'), parseGender('Boy'), parseGender('x'), parseGender('')]).toEqual(['MALE', 'FEMALE', 'MALE', 'OTHER', null]);
    expect([parseRelationship('mother'), parseRelationship('', 'Father Name'), parseRelationship('', 'Guardian'), parseRelationship('Uncle')]).toEqual(['Mother', 'Father', 'Other', 'Uncle']);
    expect(splitSubjects('Maths; Hindi, Physics | Art')).toEqual(['Maths', 'Hindi', 'Physics', 'Art']);
    expect(splitName('Riya')).toEqual({ first: 'Riya', middle: null, last: '' });
    expect(splitName('Riya Kaur')).toEqual({ first: 'Riya', middle: null, last: 'Kaur' });
    expect(splitName('Riya Preet  Kaur')).toEqual({ first: 'Riya', middle: 'Preet', last: 'Kaur' });
  });

  it('QA CSV: reads quotes, commas, line breaks and a byte-order mark; writing escapes formulas', () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi"""\n\n,\n')).toEqual([['a', 'b'], ['x, y', 'say "hi"']]);
    expect(parseCsv('a,b\n"line\nbreak",2')).toEqual([['a', 'b'], ['line\nbreak', '2']]);
    expect(parseCsv('')).toEqual([]);
    // A cell is only text: a formula is kept as typed and is escaped when it is written back out.
    const [, row] = parseCsv('n\n=SUM(A1)');
    expect(row).toEqual(['=SUM(A1)']);
    expect(csvCell(row![0])).toBe("'=SUM(A1)");
    expect(parseCsv(toCsv(['a', 'b'], [['x,y', 'q"r'], ['1', '2']]))).toEqual([['a', 'b'], ['x,y', 'q"r'], ['1', '2']]);
  });
});

describe('Part 3 data classification (SEC-SPM-02)', () => {
  const systemFields: readonly string[] = SYSTEM_FIELDS;
  const businessPaths = (schema: { paths: Record<string, unknown> }) => [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]!))].filter((p) => !systemFields.includes(p));

  it('every field of every Part 3 collection has a class, and nothing in the map is stale', () => {
    const cases: [keyof typeof DATA_CLASSIFICATION, { schema: { paths: Record<string, unknown> } }][] = [
      ['student_document', StudentDocument],
      ['student_change_request', StudentChangeRequest],
      ['student_transfer_certificate', StudentTransferCertificate],
      ['student_import', StudentImport],
      ['student_import_row', StudentImportRow],
      ['student_export', StudentExport],
      ['student_counter', StudentCounter],
    ];
    for (const [entity, model] of cases) expect(businessPaths(model.schema).sort(), entity).toEqual(Object.keys(DATA_CLASSIFICATION[entity]).sort());
  });

  it('keeps file keys secret, and the values a parent asks to change and an import row restricted, so the audit trail redacts them', () => {
    expect(classOf('student_document', 'objectKey')).toBe('SECRET');
    expect(classOf('student_export', 'objectKey')).toBe('SECRET');
    expect(classOf('student_change_request', 'oldValue')).toBe('RESTRICTED');
    expect(classOf('student_change_request', 'proposedValue')).toBe('RESTRICTED');
    expect(classOf('student_import_row', 'raw')).toBe('RESTRICTED');
    expect(classOf('student_transfer_certificate', 'reasonForLeaving')).toBe('PERSONAL');
    expect(classOf('student', 'withdrawal')).toBe('PERSONAL');
    expect(classOf('student_guardian_link', 'portalRevokedAt')).toBe('INTERNAL');
  });

  it('the exit statuses can only be reached through the exit workflow', () => {
    for (const action of ['complete_withdrawal', 'complete_schooling', 'readmit'] as const) expect(STUDENT_ACTIONS).toContain(action);
    expect(canStudentTransition('ACTIVE', 'complete_withdrawal')).toBe(false);
    expect(canStudentTransition('WITHDRAWAL_INITIATED', 'complete_withdrawal')).toBe(true);
    expect(canStudentTransition('WITHDRAWN', 'readmit')).toBe(true);
    expect(canStudentTransition('ACTIVE', 'readmit')).toBe(false);
    expect(hasPermission('FACULTY', 'student:lifecycle')).toBe(false);
    expect(hasPermission('PARENT', 'student:documents')).toBe(false);
    expect(hasPermission('SCHOOL_ADMIN', 'parent_access:manage')).toBe(true);
  });
});

// ───────────────────────────────────────────────────────────── Module 5, Part 1

describe('room data classification (SEC-SPACE-01)', () => {
  const systemFields: readonly string[] = SYSTEM_FIELDS;
  const businessPaths = (schema: { paths: Record<string, unknown> }) => [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]!))].filter((p) => !systemFields.includes(p));

  it('every field of every campus collection has a class, and nothing in the map is stale', () => {
    const cases: [keyof typeof DATA_CLASSIFICATION, { schema: { paths: Record<string, unknown> } }][] = [
      ['building', Building], ['floor', Floor], ['space_type', SpaceType], ['physical_space', PhysicalSpace], ['space_availability_block', SpaceAvailabilityBlock],
      ['space_import', SpaceImport], ['space_import_row', SpaceImportRow], ['space_change_log', SpaceChangeLog], ['outbox_event', OutboxEvent],
      ['section_space_assignment', SectionSpaceAssignment], ['space_assignment_lock', SpaceAssignmentLock],
    ];
    for (const [entity, model] of cases) expect(businessPaths(model.schema).sort(), entity).toEqual(Object.keys(DATA_CLASSIFICATION[entity]).sort());
  });
});

describe('room status machines (SPACE-06, 48)', () => {
  it('buildings and floors: draft → active ⇄ inactive, archive ends it', () => {
    expect(assertStructureTransition('building', 'DRAFT', 'ACTIVE')).toBe('ACTIVE');
    expect(assertStructureTransition('floor', 'ACTIVE', 'INACTIVE')).toBe('INACTIVE');
    expect(() => assertStructureTransition('building', 'ARCHIVED', 'ACTIVE')).toThrow(/kept for history/);
    expect(() => assertStructureTransition('floor', 'ACTIVE', 'ACTIVE')).toThrow(/already active/);
  });
  it('rooms: temporary and restricted moves both ways, archived is final', () => {
    expect(assertSpaceTransition('ACTIVE', 'TEMPORARILY_UNAVAILABLE')).toBe('TEMPORARILY_UNAVAILABLE');
    expect(assertSpaceTransition('INACTIVE', 'ACTIVE')).toBe('ACTIVE');
    expect(() => assertSpaceTransition('DRAFT', 'INACTIVE')).toThrow(/made active first/);
    expect(() => assertSpaceTransition('ARCHIVED', 'ACTIVE')).toThrow(/kept for history/);
  });
});

describe('room inheritance and effective status (SPACE-16 to 19)', () => {
  const type = { _id: 't1', code: 'STANDARD_CLASSROOM', name: 'Standard Classroom', isSchedulable: true, isHomeClassroomEligible: true, defaultSuitabilityTags: ['GENERAL_TEACHING'], defaultAcademicCapacity: 40, isOutdoor: false } as never;
  const lab = { _id: 't2', code: 'CHEMISTRY_LAB', name: 'Chemistry Lab', isSchedulable: true, isHomeClassroomEligible: false, defaultSuitabilityTags: ['CHEMISTRY_PRACTICAL'], defaultAcademicCapacity: 30, isOutdoor: false } as never;
  const office = { _id: 't3', code: 'OFFICE', name: 'Office', isSchedulable: false, isHomeClassroomEligible: false, defaultSuitabilityTags: [], defaultAcademicCapacity: null, isOutdoor: false } as never;
  const room = (over: object = {}) => ({ schedulableOverride: null, homeClassroomEligibleOverride: null, suitabilityOverrides: null, academicCapacity: null, ...over }) as never;

  it('uses the type default and says so; an override says so too', () => {
    expect(resolveSpace(room(), type)).toMatchObject({ academicCapacity: { value: 40, source: 'TYPE_DEFAULT' }, schedulable: { value: true, source: 'TYPE_DEFAULT' } });
    expect(resolveSpace(room({ academicCapacity: 35 }), type).academicCapacity).toEqual({ value: 35, source: 'OVERRIDE' });
    expect(resolveSpace(room({ suitabilityOverrides: [] }), type).suitabilityTags).toEqual({ value: [], source: 'OVERRIDE' });
  });
  it('schedulable and home-classroom eligible are separate; an office is never schedulable', () => {
    const r = resolveSpace(room(), lab);
    expect([r.schedulable.value, r.homeClassroomEligible.value]).toEqual([true, false]);
    expect(resolveSpace(room({ schedulableOverride: true }), office).schedulable.value).toBe(false);
  });
  it('a room under an inactive floor says why, and nothing is rewritten', () => {
    const space = { operationalStatus: 'ACTIVE' as const, archiveAfterDate: null as string | null };
    expect(effectiveStatusOf(space, { floorName: 'Floor 2', status: 'INACTIVE' }, { buildingName: 'Main', status: 'ACTIVE' })).toEqual({ available: false, status: 'ACTIVE', reason: 'Unavailable because Floor 2 is inactive.' });
    expect(effectiveStatusOf(space, null, { buildingName: 'Main', status: 'INACTIVE' }).reason).toMatch(/Main is inactive/);
    expect(effectiveStatusOf({ ...space, archiveAfterDate: '2027-03-31' }, null, null, '2027-04-01').status).toBe('ARCHIVED');
  });
  it('warns when seats for classes exceed what the room holds, and when seats are missing', () => {
    const noCap = { ...(type as object), defaultAcademicCapacity: null } as never;
    expect(warningsFor({ physicalCapacity: 30 }, type, resolveSpace(room(), type)).map((w) => w.code)).toEqual(['ACADEMIC_OVER_PHYSICAL']);
    expect(warningsFor({ physicalCapacity: null }, noCap, resolveSpace(room(), noCap)).map((w) => w.code)).toEqual(['MISSING_ACADEMIC_CAPACITY']);
  });
});

describe('room codes, floors and import columns (SPACE-06, 12, 21, 27)', () => {
  it('floor codes and names', () => {
    expect([0, 1, 2, -1].map(floorCodeFor)).toEqual(['GF', 'F1', 'F2', 'B1']);
    expect(['Ground', 'First', 'Second', 'Basement', 'Third Floor'].map((n, i) => floorFromName(n, i).floorNumber)).toEqual([0, 1, 2, -1, 3]);
    expect(floorFromName('Ground').levelType).toBe('GROUND');
    expect(floorFromName('Mezzanine', 4).floorNumber).toBe(4);
  });
  it('makes building and room codes, putting the building in front when the number is taken', () => {
    expect(buildingCodeFrom('Main Academic Block', new Set())).toBe('MAB');
    expect(buildingCodeFrom('Main Academic Block', new Set(['MAB']))).toBe('MAB-2');
    expect(spaceCodeFrom({ roomNumber: '101', spaceName: 'Room 101', buildingCode: 'A' }, new Set())).toBe('101');
    expect(spaceCodeFrom({ roomNumber: '101', spaceName: 'Room 101', buildingCode: 'A' }, new Set(['101']))).toBe('A-101');
    expect(spaceCodeFrom({ roomNumber: null, spaceName: 'Chemistry Lab', buildingCode: null }, new Set())).toBe('CHEMISTRY-LAB');
  });
  it('shifts a trailing number and keeps its padding', () => {
    expect(shiftTrailingNumber('101', 100)).toBe('201');
    expect(shiftTrailingNumber('G01', 1)).toBe('G02');
    expect(shiftTrailingNumber('LAB', 1)).toBeNull();
  });
  it('matches import columns from common headers', () => {
    const m = suggestSpaceMapping(['Block', 'Level', 'Room Name', 'Room Type', 'Seats', 'Facilities']);
    expect(m).toMatchObject({ building: 'Block', floor: 'Level', spaceName: 'Room Name', type: 'Room Type', academicCapacity: 'Seats', features: 'Facilities' });
  });
});

describe('Home Classroom date and shift rules (SPACE-33, 37)', () => {
  const row = (over: object = {}) => ({ status: 'ACTIVE' as const, effectiveFrom: '2026-04-01', effectiveTo: null as string | null, ...over });
  const END = '2027-03-31';
  it('phases come from the dates; a row with no last day runs to the end of its session', () => {
    expect(phaseOf(row(), END, '2026-03-01')).toBe('PLANNED');
    expect(phaseOf(row(), END, '2026-11-22')).toBe('ACTIVE');
    expect(phaseOf(row(), END, '2027-04-01')).toBe('ENDED');
    expect(phaseOf(row({ effectiveTo: '2026-09-30', status: 'ENDED' }), END, '2026-09-30')).toBe('ACTIVE');
    expect(phaseOf(row({ effectiveTo: '2026-09-30', status: 'ENDED' }), END, '2026-10-01')).toBe('ENDED');
    expect(phaseOf(row({ status: 'CANCELLED' }), END, '2026-11-22')).toBe('CANCELLED');
    expect(endOf({ effectiveTo: null }, END)).toBe(END);
    expect(runsOn(row(), '2026-04-01', END)).toBe(true);
    expect(runsOn(row({ status: 'CANCELLED' }), '2026-04-01', END)).toBe(false);
    expect(isLive(row({ effectiveTo: '2026-05-01' }), END, '2026-06-01')).toBe(false);
    expect(isLive(row(), END, '2026-06-01')).toBe(true);
  });
  it('periods overlap on a shared day; touching days overlap, a gap does not', () => {
    expect(periodsOverlap(row({ effectiveTo: '2026-09-30' }), row({ effectiveFrom: '2026-09-30' }), END)).toBe(true);
    expect(periodsOverlap(row({ effectiveTo: '2026-09-30' }), row({ effectiveFrom: '2026-10-01' }), END)).toBe(false);
    expect(periodsOverlap(row(), row({ effectiveFrom: '2027-01-01' }), END)).toBe(true);
  });
  it('shifts: no shift always clashes; two named shifts clash only when equal', () => {
    expect(shiftsClash(null, 'MORNING')).toBe(true);
    expect(shiftsClash('MORNING', undefined)).toBe(true);
    expect(shiftsClash('MORNING', 'MORNING')).toBe(true);
    expect(shiftsClash('MORNING', 'AFTERNOON')).toBe(false);
  });
});
