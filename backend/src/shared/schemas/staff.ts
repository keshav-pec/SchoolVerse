import { z } from 'zod';
import {
  ACADEMIC_ASSIGNMENT_TYPES,
  EMPLOYEE_CATEGORIES,
  EMPLOYEE_STATUSES,
  EMPLOYEE_STATUS_TARGETS,
  EXIT_REASON_CATEGORIES,
  MASTER_STATUSES,
} from '../enums';
import { paginationQuerySchema, personNameSchema, uuidSchema } from './common';
import { countrySchema, optionalDateSchema, optionalEmailSchema, optionalPhoneSchema, optionalText, phoneSchema, postalCodeError, requiredDateSchema, requiredText } from './fields';

/**
 * Faculty & Staff contracts (Module 3). Every body schema is `.strict()`: an unknown key such as `status`,
 * `role` or `tenantId` is a validation error, never silently ignored (QA S11).
 */

const emptyToNull = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : v);

const nullableUuid = z.preprocess(emptyToNull, uuidSchema.nullable()).optional();

// ───────────────────────────────────────────────────────────── codes

export const EMPLOYEE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9/_-]{0,19}$/;
export const EMPLOYEE_CODE_FORMAT_MESSAGE = 'Use up to 20 letters, numbers, hyphens or slashes, e.g. FAC-014.';

/** Uppercase, trimmed, up to 20 characters. Codes are unique per school and can be edited; other modules store `employeeId`. */
export const employeeCodeSchema = z
  .string({ message: 'Employee code is required.' })
  .transform((v) => v.trim().toUpperCase())
  .pipe(
    z
      .string()
      .min(1, { message: 'Employee code is required.' })
      .regex(EMPLOYEE_CODE_PATTERN, { message: EMPLOYEE_CODE_FORMAT_MESSAGE }),
  );

/**
 * Live check for the Employee code field, plus the next free code for a category (FAC-015, STF-008).
 * `employeeId` is sent while editing, so the employee's own code counts as free.
 */
export const employeeCodeAvailabilityQuerySchema = z.object({
  code: z.string().max(40).optional(),
  category: z.enum(EMPLOYEE_CATEGORIES).optional(),
  employeeId: uuidSchema.optional(),
});
export type EmployeeCodeAvailabilityQuery = z.output<typeof employeeCodeAvailabilityQuerySchema>;

export const MASTER_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;

export const masterCodeSchema = z
  .string({ message: 'Code is required.' })
  .transform((v) => v.trim().toUpperCase())
  .pipe(
    z
      .string()
      .min(1, { message: 'Code is required.' })
      .regex(MASTER_CODE_PATTERN, { message: 'Use up to 20 letters, numbers, hyphens or underscores, e.g. ACADEMICS.' }),
  );

/** The code a suggested name gets: "Vice Principal" → VICE-PRINCIPAL. */
export function codeFromName(name: string): string {
  return name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);
}

// ───────────────────────────────────────────────────────────── departments & designations (FSM-02)

export const MASTER_EDITABLE_FIELDS = ['name', 'status'] as const;

export const createMasterSchema = z
  .object({
    code: masterCodeSchema,
    name: requiredText('Name', 80),
  })
  .strict();
export type CreateMasterData = z.output<typeof createMasterSchema>;

export const updateMasterSchema = z
  .object({
    name: requiredText('Name', 80),
    status: z.enum(MASTER_STATUSES, { message: 'Choose a valid status.' }),
  })
  .partial()
  .strict();
export type UpdateMasterData = z.output<typeof updateMasterSchema>;

export const listMastersQuerySchema = z.object({
  status: z.enum(MASTER_STATUSES).optional(),
});
export type ListMastersQuery = z.output<typeof listMastersQuerySchema>;

// ───────────────────────────────────────────────────────────── person & employee (FSM-01)

const personAddressSchema = z
  .object({
    line1: optionalText(120),
    line2: optionalText(120),
    city: optionalText(80),
    state: optionalText(80),
    postalCode: optionalText(12),
    country: countrySchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.postalCode) {
      const message = postalCodeError(value.postalCode, value.country ?? 'IN');
      if (message) ctx.addIssue({ code: 'custom', message, path: ['postalCode'] });
    }
  });

const emergencyContactSchema = z
  .object({
    name: requiredText('Contact name', 100),
    relation: requiredText('Relation', 50),
    phone: phoneSchema,
  })
  .strict();

/** A birth date must be a real, past date. It is restricted data: never returned by list or profile APIs. */
export const dateOfBirthValueSchema = requiredDateSchema
  .refine((v) => v >= '1900-01-01', { message: 'Enter a valid date of birth.' })
  .refine((v) => v <= new Date().toISOString().slice(0, 10), { message: 'The date of birth cannot be in the future.' });

const dateOfBirthSchema = z.preprocess(emptyToNull, dateOfBirthValueSchema.nullable()).optional();

export const personShape = {
  legalFirstName: personNameSchema,
  legalMiddleName: optionalText(100),
  legalLastName: personNameSchema,
  preferredName: optionalText(100),
  dateOfBirth: dateOfBirthSchema,
  primaryEmail: optionalEmailSchema,
  primaryPhone: optionalPhoneSchema,
  personalEmail: optionalEmailSchema,
  personalPhone: optionalPhoneSchema,
  address: personAddressSchema.nullable().optional(),
  emergencyContact: emergencyContactSchema.nullable().optional(),
};

const employeeShape = {
  employeeCode: employeeCodeSchema,
  employeeCategory: z.enum(EMPLOYEE_CATEGORIES, { message: 'Choose Teaching staff or Non-teaching staff.' }),
  /** Free text with suggestions (see `EMPLOYMENT_TYPE_SUGGESTIONS`). */
  employmentType: optionalText(60),
  joiningDate: requiredDateSchema,
  confirmationDate: optionalDateSchema,
  departmentId: uuidSchema,
  designationId: uuidSchema,
  reportingManagerId: nullableUuid,
  officialEmail: optionalEmailSchema,
  officialPhone: optionalPhoneSchema,
};

export const PERSON_EDITABLE_FIELDS = [
  'legalFirstName',
  'legalMiddleName',
  'legalLastName',
  'preferredName',
  'dateOfBirth',
  'primaryEmail',
  'primaryPhone',
  'personalEmail',
  'personalPhone',
  'address',
  'emergencyContact',
] as const;

export const EMPLOYEE_EDITABLE_FIELDS = [
  'employeeCode',
  'employeeCategory',
  'employmentType',
  'joiningDate',
  'confirmationDate',
  'departmentId',
  'designationId',
  'reportingManagerId',
  'officialEmail',
  'officialPhone',
] as const;

const personFieldKeys = Object.keys(personShape) as (keyof typeof personShape)[];

/**
 * Creates the person, the employee and the primary location assignment in one call.
 * Pass `personId` instead of the person fields to rehire someone who already has a person record.
 */
export const createEmployeeSchema = z
  .object({
    personId: uuidSchema.optional(),
    ...z.object(personShape).partial().shape,
    ...employeeShape,
    primaryLocationId: uuidSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.personId) {
      for (const key of personFieldKeys) {
        if (value[key] !== undefined) {
          ctx.addIssue({ code: 'custom', message: 'A rehire uses the existing person record. Edit personal details on the profile.', path: [key] });
        }
      }
      return;
    }
    if (!value.legalFirstName) ctx.addIssue({ code: 'custom', message: 'First name is required.', path: ['legalFirstName'] });
    if (!value.legalLastName) ctx.addIssue({ code: 'custom', message: 'Last name is required.', path: ['legalLastName'] });
  });
export type CreateEmployeeData = z.output<typeof createEmployeeSchema>;

/** PATCH allowlist. `status`, `role`, `tenantId`, `schoolId` and `personId` are not in it, so they are rejected. */
export const updateEmployeeSchema = z
  .object({ ...personShape, ...employeeShape })
  .partial()
  .strict();
export type UpdateEmployeeData = z.output<typeof updateEmployeeSchema>;

/** Accepts `status=ACTIVE,ON_LEAVE` or repeated keys. */
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(values)).min(1),
  );
}

export const listEmployeesQuerySchema = paginationQuerySchema.extend({
  /** Matches a name (legal or preferred) or an employee code. */
  q: z.string().trim().max(100).optional(),
  category: z.enum(EMPLOYEE_CATEGORIES).optional(),
  departmentId: uuidSchema.optional(),
  designationId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  /** Defaults to every status except EXITED for admins. */
  status: csvEnum(EMPLOYEE_STATUSES).optional(),
});
export type ListEmployeesQuery = z.output<typeof listEmployeesQuerySchema>;

// ───────────────────────────────────────────────────────────── effective-dated assignments

/** An assignment may end the same day it starts, never before. */
function orderedDates<T extends { effectiveFrom?: string | null | undefined; effectiveTo?: string | null | undefined }>(value: T, ctx: z.RefinementCtx) {
  if (value.effectiveFrom && value.effectiveTo && value.effectiveTo < value.effectiveFrom) {
    ctx.addIssue({ code: 'custom', message: 'The end date cannot be before the start date.', path: ['effectiveTo'] });
  }
}

const startDate = optionalDateSchema.transform((v) => v ?? undefined);
const endDate = optionalDateSchema;

export const createLocationAssignmentSchema = z
  .object({ locationId: uuidSchema, effectiveFrom: startDate, effectiveTo: endDate })
  .strict()
  .superRefine(orderedDates);
export type CreateLocationAssignmentData = z.output<typeof createLocationAssignmentSchema>;

export const endAssignmentSchema = z.object({ effectiveTo: requiredDateSchema }).strict();
export type EndAssignmentData = z.output<typeof endAssignmentSchema>;

export const transferSchema = z
  .object({
    toLocationId: uuidSchema,
    effectiveFrom: requiredDateSchema,
    keepOldAsSecondary: z.boolean().default(false),
  })
  .strict();
export type TransferData = z.output<typeof transferSchema>;

const academicItemSchema = z
  .object({
    assignmentType: z.enum(ACADEMIC_ASSIGNMENT_TYPES, { message: 'Choose an assignment type.' }),
    classOfferingId: nullableUuid,
    sectionId: nullableUuid,
    subjectOfferingId: nullableUuid,
    effectiveFrom: startDate,
    effectiveTo: endDate,
  })
  .strict()
  .superRefine((item, ctx) => {
    orderedDates(item, ctx);
    const need = (path: 'sectionId' | 'subjectOfferingId' | 'classOfferingId', label: string) => {
      if (!item[path]) ctx.addIssue({ code: 'custom', message: `${label} is required for this assignment type.`, path: [path] });
    };
    if (item.assignmentType === 'SUBJECT_FACULTY') {
      need('sectionId', 'Section');
      need('subjectOfferingId', 'Subject');
    } else if (item.assignmentType === 'CLASS_TEACHER' || item.assignmentType === 'CO_CLASS_TEACHER') {
      need('sectionId', 'Section');
      if (item.subjectOfferingId) ctx.addIssue({ code: 'custom', message: 'A class teacher is not tied to one subject.', path: ['subjectOfferingId'] });
    } else if (!item.classOfferingId) {
      need('classOfferingId', 'Class');
    }
  });

/** One call, many sections: Maths for VIII-A, B and C is three items. */
export const createAcademicAssignmentsSchema = z
  .object({ items: z.array(academicItemSchema).min(1, { message: 'Add at least one assignment.' }).max(50, { message: 'Add at most 50 assignments at a time.' }) })
  .strict();
export type CreateAcademicAssignmentsData = z.output<typeof createAcademicAssignmentsSchema>;

export const createResponsibilitySchema = z
  .object({
    locationId: uuidSchema,
    /** Free text with suggestions (see `RESPONSIBILITY_SUGGESTIONS`). */
    responsibilityType: requiredText('Responsibility', 60),
    description: optionalText(200),
    effectiveFrom: startDate,
    effectiveTo: endDate,
  })
  .strict()
  .superRefine(orderedDates);
export type CreateResponsibilityData = z.output<typeof createResponsibilitySchema>;

// ───────────────────────────────────────────────────────────── lifecycle

export const changeEmployeeStatusSchema = z
  .object({
    to: z.enum(EMPLOYEE_STATUS_TARGETS, { message: 'Choose Active, On leave or Suspended.' }),
    reason: optionalText(300),
  })
  .strict();
export type ChangeEmployeeStatusData = z.output<typeof changeEmployeeStatusSchema>;

export const exitEmployeeSchema = z
  .object({
    exitDate: requiredDateSchema,
    exitReasonCategory: z.enum(EXIT_REASON_CATEGORIES, { message: 'Choose a reason.' }),
    note: optionalText(500),
  })
  .strict();
export type ExitEmployeeData = z.output<typeof exitEmployeeSchema>;

export const employeeHistoryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(100) });
export type EmployeeHistoryQuery = z.output<typeof employeeHistoryQuerySchema>;
