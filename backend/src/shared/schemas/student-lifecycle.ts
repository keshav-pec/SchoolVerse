import { z } from 'zod';
import {
  DUES_STATUSES,
  IMPORT_FIELDS,
  IMPORT_MODES,
  IMPORT_ROW_STATUSES,
  PROMOTION_DECISIONS,
  READMISSION_POLICIES,
  STUDENT_CHANGE_FIELDS,
  STUDENT_DOCUMENT_TYPES,
  STUDENT_EXPORT_PURPOSES,
  WITHDRAWAL_REASON_CATEGORIES,
  CHANGE_REQUEST_STATUSES,
} from '../enums';
import { paginationQuerySchema, personNameSchema, uuidSchema } from './common';
import { optionalDateSchema, optionalEmailSchema, optionalPhoneSchema, optionalText, requiredDateSchema, requiredText } from './fields';
import { admissionNumberSchema } from './students';
import { dateOfBirthValueSchema } from './staff';

/**
 * Parent access, documents, transfers, promotion, exit, transfer certificates, readmission, import and export (Module 4, Part 3).
 * Every body is `.strict()`: a stray `status`, `portalEnabled`, `tenantId` or `studentId` is a validation error.
 */

// ───────────────────────────────────────────────────────────── parent access

const emptyBody = z.object({}).strict();

/** Enable, revoke and resend take no body. */
export const portalActionSchema = emptyBody;

const inviteScopeSchema = z
  .object({
    academicSessionId: uuidSchema.optional(),
    locationId: uuidSchema.optional(),
    classOfferingId: uuidSchema.optional(),
    sectionId: uuidSchema.optional(),
  })
  .strict();

/** Invite many parents: the guardian links to invite, or a filter ("every parent of Class VIII who has no access yet"). */
export const bulkInvitationSchema = z
  .object({
    guardianLinkIds: z.array(uuidSchema).min(1, { message: 'Choose at least one parent.' }).max(500, { message: 'Invite at most 500 parents at a time.' }).optional(),
    filter: inviteScopeSchema.optional(),
  })
  .strict()
  .refine((v) => Boolean(v.guardianLinkIds) !== Boolean(v.filter), { message: 'Send either the parents to invite or a filter, not both.', path: ['guardianLinkIds'] });
export type BulkInvitationData = z.output<typeof bulkInvitationSchema>;

// ───────────────────────────────────────────────────────────── documents

export const uploadStudentDocumentFieldsSchema = z
  .object({
    documentType: z.enum(STUDENT_DOCUMENT_TYPES, { message: 'Choose the kind of document.' }),
    displayName: optionalText(120),
  })
  .strict();
export type UploadStudentDocumentFields = z.output<typeof uploadStudentDocumentFieldsSchema>;

// ───────────────────────────────────────────────────────────── parent change requests

const nameValueSchema = z.object({ legalFirstName: personNameSchema, legalMiddleName: optionalText(100), legalLastName: z.string().trim().max(100) }).strict();
const dobValueSchema = z.object({ dateOfBirth: dateOfBirthValueSchema }).strict();
const contactValueSchema = z
  .object({ phone: optionalPhoneSchema, email: optionalEmailSchema })
  .strict()
  .refine((v) => Boolean(v.phone || v.email), { message: 'Enter a new phone number or email.', path: ['phone'] });

/** What the parent sends: which detail, and the new value. The old value is read by the server, never trusted from the browser. */
export const createStudentChangeRequestSchema = z.discriminatedUnion('field', [
  z.object({ field: z.literal('LEGAL_NAME'), value: nameValueSchema, reason: optionalText(300) }).strict(),
  z.object({ field: z.literal('DATE_OF_BIRTH'), value: dobValueSchema, reason: optionalText(300) }).strict(),
  z.object({ field: z.literal('GUARDIAN_CONTACT'), value: contactValueSchema, reason: optionalText(300) }).strict(),
]);
export type CreateStudentChangeRequestData = z.output<typeof createStudentChangeRequestSchema>;

export const listStudentChangeRequestsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(CHANGE_REQUEST_STATUSES).optional(),
  field: z.enum(STUDENT_CHANGE_FIELDS).optional(),
});
export type ListStudentChangeRequestsQuery = z.output<typeof listStudentChangeRequestsQuerySchema>;

export const approveStudentChangeSchema = z.object({ note: optionalText(300) }).strict();
export const rejectStudentChangeSchema = z.object({ note: requiredText('Note', 300) }).strict();

// ───────────────────────────────────────────────────────────── location transfer

export const locationTransferValidateSchema = z
  .object({
    toLocationId: uuidSchema,
    /** The class offering at the new campus, in the same session. */
    classOfferingId: uuidSchema,
    sectionId: uuidSchema.optional(),
    effectiveDate: requiredDateSchema,
  })
  .strict();
export type LocationTransferValidateData = z.output<typeof locationTransferValidateSchema>;

export const locationTransferSchema = locationTransferValidateSchema
  .extend({
    reason: requiredText('Reason', 300),
    rollNumber: z.string().trim().max(10).optional(),
    /** Needed when the new campus follows a different board; otherwise the subjects are carried over where they still fit. */
    subjectOfferingIds: z.array(uuidSchema).max(40).optional(),
  })
  .strict();
export type LocationTransferData = z.output<typeof locationTransferSchema>;

// ───────────────────────────────────────────────────────────── promotion

export const promotionScopeQuerySchema = z
  .object({
    fromSessionId: uuidSchema,
    toSessionId: uuidSchema,
    locationId: uuidSchema,
    classOfferingId: uuidSchema.optional(),
  })
  .strict();
export type PromotionScopeQuery = z.output<typeof promotionScopeQuerySchema>;

export const promotionRecommendSchema = promotionScopeQuerySchema;

const decisionRowSchema = z
  .object({
    studentId: uuidSchema,
    decision: z.enum(PROMOTION_DECISIONS, { message: 'Choose what happens to this student.' }),
    nextClassOfferingId: uuidSchema.optional(),
    sectionId: uuidSchema.optional(),
  })
  .strict();
const overrideRowSchema = z.object({ studentId: uuidSchema, nextClassOfferingId: uuidSchema.optional(), sectionId: uuidSchema.optional() }).strict();

export const bulkPromotionSchema = z
  .object({
    fromSessionId: uuidSchema,
    toSessionId: uuidSchema,
    locationId: uuidSchema.optional(),
    classOfferingId: uuidSchema.optional(),
    /** Promote everyone who is ready, as suggested. */
    readyOnly: z.boolean().optional(),
    decisions: z.array(decisionRowSchema).max(2000).optional(),
    /** With `readyOnly`: a different section or class for some students. */
    overrides: z.array(overrideRowSchema).max(2000).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.readyOnly) !== Boolean(v.decisions?.length), { message: 'Send the decisions, or ask to promote everyone who is ready.', path: ['decisions'] });
export type BulkPromotionData = z.output<typeof bulkPromotionSchema>;

export const repeatStudentSchema = z.object({ toSessionId: uuidSchema, sectionId: uuidSchema.optional() }).strict();
export type RepeatStudentData = z.output<typeof repeatStudentSchema>;

// ───────────────────────────────────────────────────────────── withdrawal, transfer certificate, readmission

const withdrawalShape = {
  leavingDate: requiredDateSchema,
  reasonCategory: z.enum(WITHDRAWAL_REASON_CATEGORIES, { message: 'Choose why the student is leaving.' }),
  destinationSchool: optionalText(120),
  note: optionalText(500),
  needsTC: z.boolean(),
};

export const startWithdrawalSchema = z.object(withdrawalShape).strict();
export type StartWithdrawalData = z.output<typeof startWithdrawalSchema>;

export const updateWithdrawalSchema = z.object(withdrawalShape).partial().strict();
export type UpdateWithdrawalData = z.output<typeof updateWithdrawalSchema>;

export const requestTransferCertificateSchema = z
  .object({
    applicationDate: optionalDateSchema,
    leavingDate: requiredDateSchema.optional(),
    reasonForLeaving: optionalText(300),
    result: optionalText(120),
  })
  .strict();
export type RequestTransferCertificateData = z.output<typeof requestTransferCertificateSchema>;

export const updateTransferCertificateSchema = z
  .object({
    leavingDate: requiredDateSchema,
    reasonForLeaving: requiredText('Reason for leaving', 300),
    result: optionalText(120),
    duesStatus: z.enum(DUES_STATUSES, { message: 'Choose a valid option.' }),
  })
  .partial()
  .strict();
export type UpdateTransferCertificateData = z.output<typeof updateTransferCertificateSchema>;

export const issueTransferCertificateSchema = z.object({ issueDate: optionalDateSchema }).strict();
export const duplicateTransferCertificateSchema = z.object({ reason: requiredText('Reason', 300) }).strict();

export const readmitStudentSchema = z
  .object({
    academicSessionId: uuidSchema,
    locationId: uuidSchema,
    classOfferingId: uuidSchema,
    sectionId: uuidSchema.optional(),
    admissionDate: optionalDateSchema,
    admissionNumberPolicy: z.enum(READMISSION_POLICIES, { message: 'Choose a valid option.' }).optional(),
    /** Only for schools that type admission numbers, when the policy is to issue a new one. */
    admissionNumber: admissionNumberSchema.optional(),
  })
  .strict();
export type ReadmitStudentData = z.output<typeof readmitStudentSchema>;

// ───────────────────────────────────────────────────────────── import

/** The text fields sent beside the CSV file. */
export const createImportFieldsSchema = z
  .object({
    mode: z.enum(IMPORT_MODES, { message: 'Choose what kind of students are in this file.' }),
    locationId: uuidSchema,
    academicSessionId: uuidSchema.optional(),
  })
  .strict();
export type CreateImportFields = z.output<typeof createImportFieldsSchema>;

/** Which file column fills which field. A field left out (or `null`) is not imported. */
export const mapImportSchema = z
  .object({ mapping: z.partialRecord(z.enum(IMPORT_FIELDS), z.string().trim().max(120).nullable()) })
  .strict();
export type MapImportData = z.output<typeof mapImportSchema>;

export const fixImportRowSchema = z
  .object({ values: z.partialRecord(z.enum(IMPORT_FIELDS), z.string().trim().max(200)) })
  .strict();
export type FixImportRowData = z.output<typeof fixImportRowSchema>;

export const importRowsQuerySchema = paginationQuerySchema.extend({
  status: z.enum(IMPORT_ROW_STATUSES).optional(),
});
export type ImportRowsQuery = z.output<typeof importRowsQuerySchema>;

export const commitImportSchema = emptyBody;

// ───────────────────────────────────────────────────────────── export and context

export const createStudentExportSchema = z
  .object({
    purpose: z.enum(STUDENT_EXPORT_PURPOSES, { message: 'Choose what the export is for.' }),
    filters: z
      .object({
        academicSessionId: uuidSchema.optional(),
        locationId: uuidSchema.optional(),
        classOfferingId: uuidSchema.optional(),
        sectionId: uuidSchema.optional(),
      })
      .strict()
      .default({}),
  })
  .strict();
export type CreateStudentExportData = z.output<typeof createStudentExportSchema>;

export const studentContextRequestSchema = z
  .object({ studentId: uuidSchema, academicSessionId: uuidSchema.optional(), date: requiredDateSchema.optional() })
  .strict();
export type StudentContextRequest = z.output<typeof studentContextRequestSchema>;
