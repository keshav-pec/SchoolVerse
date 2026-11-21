import { z } from 'zod';
import {
  ADMISSION_NUMBER_MODES,
  ENROLLMENT_OUTCOMES,
  ENROLLMENT_STATUSES,
  ENROLLMENT_TYPES,
  GENDERS,
  READMISSION_POLICIES,
  RELATIONSHIP_TYPES,
  ROLL_NUMBER_ORDERS,
  SECTION_CAPACITY_POLICIES,
  STUDENT_STATUSES,
  STUDENT_STATUS_TARGETS,
} from '../enums';
import { paginationQuerySchema, personNameSchema, uuidSchema } from './common';
import { optionalDateSchema, optionalEmailSchema, optionalPhoneSchema, optionalText, requiredDateSchema, requiredText, countrySchema, postalCodeError } from './fields';
import { dateOfBirthValueSchema } from './staff';

/**
 * Student & Parent contracts (Module 4). Every body schema is `.strict()`: an unknown key such as `status`,
 * `admissionNumber` (on a PATCH), `tenantId` or `portalEnabled` is a validation error, never silently ignored.
 */

const emptyToNull = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : v);
const nullableUuid = z.preprocess(emptyToNull, uuidSchema.nullable()).optional();

export const BLOOD_GROUPS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] as const;

const genderSchema = z.preprocess(emptyToNull, z.enum(GENDERS, { message: 'Choose a valid option.' }).nullable()).optional();
const bloodGroupSchema = z.preprocess(emptyToNull, z.enum(BLOOD_GROUPS, { message: 'Choose a valid blood group.' }).nullable()).optional();
const dateOfBirthSchema = z.preprocess(emptyToNull, dateOfBirthValueSchema.nullable()).optional();

/** A single-word name is fine: the last name may be empty. */
const lastNameSchema = z.preprocess(
  (v) => (v === null || v === undefined ? '' : v),
  z.string({ message: 'Enter a valid name.' }).trim().max(100, { message: 'Use at most 100 characters.' }),
);

const addressSchema = z
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

// ───────────────────────────────────────────────────────────── admission number

export const ADMISSION_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9/_.-]{0,29}$/;
export const ADMISSION_NUMBER_FORMAT_MESSAGE = 'Use up to 30 letters, numbers, slashes, dots or hyphens, e.g. GPS/2026/00482.';

export const admissionNumberSchema = z
  .string({ message: 'Admission number is required.' })
  .transform((v) => v.trim().toUpperCase())
  .pipe(z.string().min(1, { message: 'Admission number is required.' }).regex(ADMISSION_NUMBER_PATTERN, { message: ADMISSION_NUMBER_FORMAT_MESSAGE }));

export const PREFIX_PATTERN = /^[A-Z0-9/_.-]{0,20}$/;

export const admissionNumberSettingsSchema = z
  .object({
    mode: z.enum(ADMISSION_NUMBER_MODES, { message: 'Choose how admission numbers are made.' }),
    prefix: z
      .string()
      .transform((v) => v.trim().toUpperCase())
      .pipe(z.string().regex(PREFIX_PATTERN, { message: 'Use up to 20 letters, numbers, slashes, dots or hyphens.' })),
    includeLocationCode: z.boolean(),
    includeYear: z.boolean(),
    padding: z.number().int().min(1, { message: 'Use at least 1 digit.' }).max(10, { message: 'Use at most 10 digits.' }),
    /** Optional: start the counter at this number. It can only move forward. */
    nextSequence: z.number().int().min(1).max(99_999_999).optional(),
    readmissionPolicy: z.enum(READMISSION_POLICIES, { message: 'Choose a valid option.' }),
    sectionCapacityPolicy: z.enum(SECTION_CAPACITY_POLICIES, { message: 'Choose a valid option.' }),
  })
  .strict();
export type AdmissionNumberSettingsData = z.output<typeof admissionNumberSettingsSchema>;

export const ADMISSION_SETTINGS_FIELDS = ['mode', 'prefix', 'includeLocationCode', 'includeYear', 'padding', 'nextSequence', 'readmissionPolicy', 'sectionCapacityPolicy'] as const;

export const previewAdmissionNumberSchema = z
  .object({ academicSessionId: uuidSchema.optional(), locationId: uuidSchema.optional() })
  .strict();
export type PreviewAdmissionNumberData = z.output<typeof previewAdmissionNumberSchema>;

// ───────────────────────────────────────────────────────────── roll numbers

export const ROLL_NUMBER_PATTERN = /^[A-Z0-9][A-Z0-9-]{0,9}$/;
/** `AUTO` asks for the next free number in the section. */
export const AUTO_ROLL = 'AUTO';

export const rollNumberSchema = z
  .string({ message: 'Enter a roll number.' })
  .transform((v) => v.trim().toUpperCase())
  .pipe(z.string().regex(ROLL_NUMBER_PATTERN, { message: 'Use up to 10 letters, numbers or hyphens.' }));

// ───────────────────────────────────────────────────────────── guardians

const guardianFlags = {
  isPrimary: z.boolean().optional(),
  isEmergencyContact: z.boolean().optional(),
  communicationPriority: z.number().int().min(1).max(9).optional(),
  canSeeAcademics: z.boolean().optional(),
  canSeeFees: z.boolean().optional(),
  pickupAllowed: z.boolean().optional(),
};

/** A new guardian person (name, contact, relationship). Login access is a separate step (Part 3). */
export const newGuardianSchema = z
  .object({
    legalFirstName: personNameSchema,
    legalLastName: lastNameSchema.optional(),
    phone: optionalPhoneSchema,
    email: optionalEmailSchema,
    relationshipType: z.enum(RELATIONSHIP_TYPES, { message: 'Choose how this person is related to the student.' }),
    effectiveFrom: optionalDateSchema,
    ...guardianFlags,
  })
  .strict();
export type NewGuardianData = z.output<typeof newGuardianSchema>;
export const addGuardianSchema = newGuardianSchema;

/** Link a person who is already a guardian (this is how a sibling reuses the same parent). */
export const linkExistingGuardianSchema = z
  .object({
    guardianPersonId: uuidSchema,
    relationshipType: z.enum(RELATIONSHIP_TYPES, { message: 'Choose how this person is related to the student.' }),
    effectiveFrom: optionalDateSchema,
    ...guardianFlags,
  })
  .strict();
export type LinkExistingGuardianData = z.output<typeof linkExistingGuardianSchema>;

/** Quick Add accepts either shape. */
export const guardianInputSchema = z
  .object({
    guardianPersonId: uuidSchema.optional(),
    legalFirstName: personNameSchema.optional(),
    legalLastName: lastNameSchema.optional(),
    phone: optionalPhoneSchema,
    email: optionalEmailSchema,
    relationshipType: z.enum(RELATIONSHIP_TYPES, { message: 'Choose how this person is related to the student.' }),
    effectiveFrom: optionalDateSchema,
    ...guardianFlags,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!value.guardianPersonId && !value.legalFirstName) {
      ctx.addIssue({ code: 'custom', message: 'Enter the parent’s name, or choose an existing parent.', path: ['legalFirstName'] });
    }
    if (value.guardianPersonId && (value.legalFirstName || value.phone || value.email)) {
      ctx.addIssue({ code: 'custom', message: 'Use either an existing parent or new details, not both.', path: ['guardianPersonId'] });
    }
  });
export type GuardianInputData = z.output<typeof guardianInputSchema>;

export const GUARDIAN_LINK_EDITABLE_FIELDS = ['relationshipType', 'isPrimary', 'isEmergencyContact', 'communicationPriority', 'canSeeAcademics', 'canSeeFees', 'pickupAllowed'] as const;

export const updateGuardianLinkSchema = z
  .object({
    version: z.number().int().min(1),
    relationshipType: z.enum(RELATIONSHIP_TYPES, { message: 'Choose how this person is related to the student.' }),
    isPrimary: z.boolean(),
    isEmergencyContact: z.boolean(),
    communicationPriority: z.number().int().min(1).max(9),
    canSeeAcademics: z.boolean(),
    canSeeFees: z.boolean(),
    pickupAllowed: z.boolean(),
  })
  .partial({ relationshipType: true, isPrimary: true, isEmergencyContact: true, communicationPriority: true, canSeeAcademics: true, canSeeFees: true, pickupAllowed: true })
  .strict();
export type UpdateGuardianLinkData = z.output<typeof updateGuardianLinkSchema>;

export const endGuardianLinkSchema = z.object({ effectiveTo: optionalDateSchema }).strict();
export type EndGuardianLinkData = z.output<typeof endGuardianLinkSchema>;

export const matchGuardianSchema = z
  .object({ phone: optionalPhoneSchema, email: optionalEmailSchema, name: optionalText(100) })
  .strict()
  .refine((v) => Boolean(v.phone || v.email || v.name), { message: 'Enter a phone number, an email or a name.', path: ['phone'] });
export type MatchGuardianData = z.output<typeof matchGuardianSchema>;

export const GUARDIAN_PERSON_FIELDS = ['legalFirstName', 'legalMiddleName', 'legalLastName', 'primaryPhone', 'primaryEmail', 'address'] as const;

/** The parent's own details, edited once: every child sees the change. */
export const updateGuardianPersonSchema = z
  .object({
    legalFirstName: personNameSchema,
    legalMiddleName: optionalText(100),
    legalLastName: lastNameSchema,
    primaryPhone: optionalPhoneSchema,
    primaryEmail: optionalEmailSchema,
    address: addressSchema.nullable().optional(),
  })
  .partial()
  .strict();
export type UpdateGuardianPersonData = z.output<typeof updateGuardianPersonSchema>;

// ───────────────────────────────────────────────────────────── student

const externalIdSchema = z
  .object({
    type: requiredText('ID type', 40),
    value: requiredText('ID value', 60),
    effectiveFrom: optionalDateSchema,
  })
  .strict();

export const previousSchoolSchema = z
  .object({
    name: requiredText('School name', 120),
    board: optionalText(60),
    className: optionalText(40),
    tcNumber: optionalText(40),
  })
  .strict();

const studentPersonShape = {
  legalFirstName: personNameSchema,
  legalMiddleName: optionalText(100),
  legalLastName: lastNameSchema,
  preferredName: optionalText(100),
  dateOfBirth: dateOfBirthSchema,
  gender: genderSchema,
  primaryPhone: optionalPhoneSchema,
  primaryEmail: optionalEmailSchema,
  address: addressSchema.nullable().optional(),
};

export const STUDENT_PERSON_FIELDS = ['legalFirstName', 'legalMiddleName', 'legalLastName', 'preferredName', 'dateOfBirth', 'gender', 'primaryPhone', 'primaryEmail', 'address'] as const;
export const STUDENT_RECORD_FIELDS = ['bloodGroup', 'notes'] as const;
export const STUDENT_EDITABLE_FIELDS = [...STUDENT_PERSON_FIELDS, ...STUDENT_RECORD_FIELDS] as const;

/**
 * Quick Add (`POST /students`). A full add needs a location, a class (by offering or by class) and a guardian; a draft needs only a name.
 * The class can be sent as `classOfferingId`, or as `classId` and the system finds the offering for the session and location.
 */
export const createStudentSchema = z
  .object({
    draft: z.boolean().optional(),
    /** An existing person (a former student being admitted again). */
    personId: uuidSchema.optional(),
    legalFirstName: studentPersonShape.legalFirstName.optional(),
    legalMiddleName: studentPersonShape.legalMiddleName,
    legalLastName: studentPersonShape.legalLastName.optional(),
    preferredName: studentPersonShape.preferredName,
    dateOfBirth: studentPersonShape.dateOfBirth,
    gender: studentPersonShape.gender,
    primaryPhone: studentPersonShape.primaryPhone,
    primaryEmail: studentPersonShape.primaryEmail,
    address: studentPersonShape.address,
    bloodGroup: bloodGroupSchema,
    notes: optionalText(500),

    mode: z.enum(['NEW_ADMISSION', 'MIGRATION'], { message: 'Choose a valid option.' }).optional(),
    admissionDate: requiredDateSchema.optional(),
    admissionNumber: admissionNumberSchema.optional(),
    category: optionalText(60),
    previousSchool: previousSchoolSchema.nullable().optional(),
    remarks: optionalText(500),

    academicSessionId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    classOfferingId: uuidSchema.optional(),
    classId: uuidSchema.optional(),
    programmeId: nullableUuid,
    sectionId: uuidSchema.optional(),
    rollNumber: z.union([z.literal(AUTO_ROLL), rollNumberSchema]).optional(),

    externalIds: z.array(externalIdSchema).max(5).optional(),
    guardian: guardianInputSchema.optional(),
    confirmNotDuplicate: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
    if (!v.personId && !v.legalFirstName) issue('legalFirstName', 'Name is required.');
    if (v.classOfferingId && v.classId) issue('classId', 'Send the class or the class offering, not both.');
    if (v.rollNumber && !v.sectionId) issue('rollNumber', 'Choose a section before giving a roll number.');
    if (v.mode === 'MIGRATION') {
      if (!v.admissionDate) issue('admissionDate', 'Enter the original admission date.');
      if (!v.admissionNumber) issue('admissionNumber', 'Enter the original admission number.');
    }
    if (!v.draft) {
      if (!v.locationId) issue('locationId', 'Choose a location.');
      if (!v.classOfferingId && !v.classId) issue('classOfferingId', 'Choose a class.');
      if (!v.guardian) issue('guardian', 'Add a parent or guardian.');
    }
    if (v.draft && (v.classOfferingId || v.classId) && !v.locationId) issue('locationId', 'Choose a location for this class.');
  });
export type CreateStudentData = z.output<typeof createStudentSchema>;

/** Records the admission of a draft student (it consumes an admission number). */
export const recordAdmissionSchema = z
  .object({
    mode: z.enum(['NEW_ADMISSION', 'MIGRATION'], { message: 'Choose a valid option.' }).optional(),
    admissionDate: requiredDateSchema.optional(),
    admissionNumber: admissionNumberSchema.optional(),
    academicSessionId: uuidSchema.optional(),
    locationId: uuidSchema,
    classOfferingId: uuidSchema.optional(),
    classId: uuidSchema.optional(),
    category: optionalText(60),
    previousSchool: previousSchoolSchema.nullable().optional(),
    remarks: optionalText(500),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.classOfferingId && !v.classId) ctx.addIssue({ code: 'custom', path: ['classOfferingId'], message: 'Choose a class.' });
    if (v.classOfferingId && v.classId) ctx.addIssue({ code: 'custom', path: ['classId'], message: 'Send the class or the class offering, not both.' });
    if (v.mode === 'MIGRATION' && (!v.admissionDate || !v.admissionNumber)) {
      ctx.addIssue({ code: 'custom', path: ['admissionNumber'], message: 'Enter the original admission number and date.' });
    }
  });
export type RecordAdmissionData = z.output<typeof recordAdmissionSchema>;

export const updateStudentSchema = z
  .object({
    version: z.number().int().min(1),
    legalFirstName: studentPersonShape.legalFirstName,
    legalMiddleName: studentPersonShape.legalMiddleName,
    legalLastName: studentPersonShape.legalLastName,
    preferredName: studentPersonShape.preferredName,
    dateOfBirth: studentPersonShape.dateOfBirth,
    gender: studentPersonShape.gender,
    primaryPhone: studentPersonShape.primaryPhone,
    primaryEmail: studentPersonShape.primaryEmail,
    address: studentPersonShape.address,
    bloodGroup: bloodGroupSchema,
    notes: optionalText(500),
  })
  .partial({
    legalFirstName: true,
    legalLastName: true,
  })
  .strict();
export type UpdateStudentData = z.output<typeof updateStudentSchema>;

export const changeStudentStatusSchema = z
  .object({ to: z.enum(STUDENT_STATUS_TARGETS, { message: 'Choose a valid status.' }), reason: optionalText(300) })
  .strict();
export type ChangeStudentStatusData = z.output<typeof changeStudentStatusSchema>;

const csv = <T extends z.ZodType>(item: T) => z.preprocess((v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v), z.array(item));
const flag = z.preprocess((v) => (v === 'true' ? true : v === 'false' ? false : v), z.boolean());

export const listStudentsQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().max(100).optional(),
  academicSessionId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  classOfferingId: uuidSchema.optional(),
  sectionId: uuidSchema.optional(),
  status: csv(z.enum(STUDENT_STATUSES)).optional(),
  enrollmentStatus: z.enum(ENROLLMENT_STATUSES).optional(),
  missingGuardian: flag.optional(),
  missingSection: flag.optional(),
});
export type ListStudentsQuery = z.output<typeof listStudentsQuerySchema>;

export const listFamiliesQuerySchema = paginationQuerySchema.extend({ q: z.string().trim().max(100).optional() });
export type ListFamiliesQuery = z.output<typeof listFamiliesQuerySchema>;

export const studentAttentionQuerySchema = z.object({ academicSessionId: uuidSchema.optional(), locationId: uuidSchema.optional() });
export type StudentAttentionQuery = z.output<typeof studentAttentionQuerySchema>;

export const studentContextQuerySchema = z.object({ date: requiredDateSchema.optional() });
export type StudentContextQuery = z.output<typeof studentContextQuerySchema>;

export const studentHistoryQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(200) });
export type StudentHistoryQuery = z.output<typeof studentHistoryQuerySchema>;

export const duplicateCheckSchema = z
  .object({
    name: requiredText('Name', 200),
    dateOfBirth: dateOfBirthSchema,
    admissionNumber: admissionNumberSchema.optional(),
    externalIds: z.array(externalIdSchema.pick({ type: true, value: true })).max(5).optional(),
    guardianPhone: optionalPhoneSchema,
    guardianEmail: optionalEmailSchema,
    /** Leave this student out (when checking an existing record). */
    excludeStudentId: uuidSchema.optional(),
  })
  .strict();
export type DuplicateCheckData = z.output<typeof duplicateCheckSchema>;

export const createExternalIdSchema = z
  .object({ type: requiredText('ID type', 40), value: requiredText('ID value', 60), effectiveFrom: optionalDateSchema })
  .strict();
export type CreateExternalIdData = z.output<typeof createExternalIdSchema>;

export const endExternalIdSchema = z.object({ effectiveTo: optionalDateSchema }).strict();
export type EndExternalIdData = z.output<typeof endExternalIdSchema>;

// ───────────────────────────────────────────────────────────── enrollment, section, roll number

export const createEnrollmentSchema = z
  .object({
    academicSessionId: uuidSchema,
    locationId: uuidSchema,
    classOfferingId: uuidSchema.optional(),
    classId: uuidSchema.optional(),
    programmeId: nullableUuid,
    enrollmentType: z.enum(ENROLLMENT_TYPES, { message: 'Choose a valid option.' }).optional(),
    effectiveFrom: requiredDateSchema.optional(),
    previousEnrollmentId: uuidSchema.optional(),
    sectionId: uuidSchema.optional(),
    rollNumber: z.union([z.literal(AUTO_ROLL), rollNumberSchema]).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.classOfferingId && !v.classId) ctx.addIssue({ code: 'custom', path: ['classOfferingId'], message: 'Choose a class.' });
    if (v.classOfferingId && v.classId) ctx.addIssue({ code: 'custom', path: ['classId'], message: 'Send the class or the class offering, not both.' });
    if (v.rollNumber && !v.sectionId) ctx.addIssue({ code: 'custom', path: ['rollNumber'], message: 'Choose a section before giving a roll number.' });
  });
export type CreateEnrollmentData = z.output<typeof createEnrollmentSchema>;

/** Without `confirm` a programme change only returns a preview. */
export const updateEnrollmentSchema = z
  .object({ version: z.number().int().min(1), programmeId: z.preprocess(emptyToNull, uuidSchema.nullable()), confirm: z.boolean().optional() })
  .strict();
export type UpdateEnrollmentData = z.output<typeof updateEnrollmentSchema>;

export const completeEnrollmentSchema = z
  .object({ effectiveTo: requiredDateSchema.optional(), outcome: z.enum(ENROLLMENT_OUTCOMES, { message: 'Choose a valid outcome.' }).optional() })
  .strict();
export type CompleteEnrollmentData = z.output<typeof completeEnrollmentSchema>;

export const assignSectionSchema = z
  .object({
    sectionId: uuidSchema,
    rollNumber: z.union([z.literal(AUTO_ROLL), rollNumberSchema]).optional(),
    effectiveFrom: requiredDateSchema.optional(),
  })
  .strict();
export type AssignSectionData = z.output<typeof assignSectionSchema>;

export const updateSectionAssignmentSchema = z
  .object({ rollNumber: z.union([z.literal(AUTO_ROLL), rollNumberSchema, z.null()]) })
  .strict();
export type UpdateSectionAssignmentData = z.output<typeof updateSectionAssignmentSchema>;

export const sectionTransferSchema = z
  .object({
    toSectionId: uuidSchema,
    effectiveDate: requiredDateSchema,
    reason: requiredText('Reason', 300),
    rollNumber: z.union([z.literal(AUTO_ROLL), rollNumberSchema]).optional(),
  })
  .strict();
export type SectionTransferData = z.output<typeof sectionTransferSchema>;

/** `apply: false` (the default) only previews the numbering. */
export const bulkRollNumbersSchema = z
  .object({ sectionId: uuidSchema, order: z.enum(ROLL_NUMBER_ORDERS, { message: 'Choose how to order the students.' }), apply: z.boolean().optional() })
  .strict();
export type BulkRollNumbersData = z.output<typeof bulkRollNumbersSchema>;

export const recommendSectionSchema = z.object({ classOfferingId: uuidSchema }).strict();
export type RecommendSectionData = z.output<typeof recommendSectionSchema>;

// ───────────────────────────────────────────────────────────── subjects

export const subjectSelectionSchema = z
  .object({ subjectOfferingIds: z.array(uuidSchema).max(40, { message: 'Too many subjects.' }) })
  .strict();
export type SubjectSelectionData = z.output<typeof subjectSelectionSchema>;

export const endSubjectEnrollmentSchema = z.object({ effectiveDate: requiredDateSchema.optional() }).strict();
export type EndSubjectEnrollmentData = z.output<typeof endSubjectEnrollmentSchema>;
