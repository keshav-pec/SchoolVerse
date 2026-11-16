import { z } from 'zod';
import { CHANGE_FIELD_CATEGORIES, DOCUMENT_TYPES, EXPORT_PURPOSES, GOVERNMENT_ID_TYPES, PROVISIONABLE_ROLES, RESTRICTED_FIELDS } from '../enums';
import { emailSchema, passwordSchema, personNameSchema } from './common';
import { optionalText, requiredText } from './fields';
import { dateOfBirthValueSchema, listEmployeesQuerySchema, personShape } from './staff';

/**
 * Identity, restricted data, self-service, documents and exports (Module 3, Part 2).
 * Every body schema is `.strict()`: a stray `role`, `status` or `tenantId` is a validation error (QA S11).
 * Passwords and government IDs only ever appear in request bodies, never in a URL.
 */

// ───────────────────────────────────────────────────────────── accounts and sign-in

const linkTokenSchema = z.string({ message: 'This link is not valid.' }).trim().min(20, { message: 'This link is not valid.' }).max(200, { message: 'This link is not valid.' });

export const tokenParamsSchema = z.object({ token: linkTokenSchema });

export const activateAccountSchema = z.object({ token: linkTokenSchema, password: passwordSchema }).strict();
export type ActivateAccountData = z.output<typeof activateAccountSchema>;

export const forgotPasswordSchema = z.object({ email: emailSchema }).strict();
export type ForgotPasswordData = z.output<typeof forgotPasswordSchema>;

export const resetPasswordSchema = z.object({ token: linkTokenSchema, password: passwordSchema }).strict();
export type ResetPasswordData = z.output<typeof resetPasswordSchema>;

/** Step-up re-checks the password of the signed-in user. */
export const stepUpSchema = z.object({ password: z.string({ message: 'Password is required.' }).min(1, { message: 'Password is required.' }).max(128) }).strict();
export type StepUpData = z.output<typeof stepUpSchema>;

/** The role is always chosen: a designation such as Principal never grants access by itself. */
export const createUserAccountSchema = z
  .object({
    /** Defaults to the employee's official email. */
    email: emailSchema.optional(),
    role: z.enum(PROVISIONABLE_ROLES, { message: 'Choose a role for this login.' }),
  })
  .strict();
export type CreateUserAccountData = z.output<typeof createUserAccountSchema>;

export const suspendUserSchema = z.object({ reason: requiredText('Reason', 300) }).strict();
export type SuspendUserData = z.output<typeof suspendUserSchema>;

export const changeUserRoleSchema = z.object({ role: z.enum(PROVISIONABLE_ROLES, { message: 'Choose a role.' }) }).strict();
export type ChangeUserRoleData = z.output<typeof changeUserRoleSchema>;

// ───────────────────────────────────────────────────────────── restricted data

/** Spaces and hyphens are typed for readability and dropped before storing. */
const idValueSchema = z
  .string({ message: 'Enter the ID number.' })
  .transform((v) => v.replace(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{5,20}$/, { message: 'Use 5–20 letters and numbers.' }));

const governmentIdEntry = z
  .object({
    type: z.enum(GOVERNMENT_ID_TYPES, { message: 'Choose an ID type.' }),
    /** `null` removes that ID. */
    value: idValueSchema.nullable(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.type === 'AADHAAR' && entry.value !== null && !/^[0-9]{12}$/.test(entry.value)) {
      ctx.addIssue({ code: 'custom', message: 'An Aadhaar number has 12 digits.', path: ['value'] });
    }
  });

export const bankDetailsSchema = z
  .object({
    accountHolderName: requiredText('Account holder name', 100),
    accountNumber: z
      .string({ message: 'Enter the account number.' })
      .transform((v) => v.replace(/[\s-]/g, ''))
      .pipe(z.string().regex(/^[0-9]{6,18}$/, { message: 'Use 6–18 digits.' })),
    ifsc: z
      .string({ message: 'Enter the IFSC code.' })
      .transform((v) => v.trim().toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{4}0[A-Z0-9]{6}$/, { message: 'An IFSC code looks like HDFC0001234.' })),
    bankName: requiredText('Bank name', 100),
  })
  .strict();
export type BankDetailsData = z.output<typeof bankDetailsSchema>;

/**
 * `PUT /employees/:id/restricted`. Each ID is added or replaced by its type (`value: null` removes it) and `bank: null`
 * removes the bank details. What is not sent stays as it is.
 */
export const updateRestrictedSchema = z
  .object({
    governmentIds: z
      .array(governmentIdEntry)
      .max(GOVERNMENT_ID_TYPES.length)
      .refine((items) => new Set(items.map((i) => i.type)).size === items.length, { message: 'Each ID type can appear once.' })
      .optional(),
    bank: bankDetailsSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => v.governmentIds !== undefined || v.bank !== undefined, { message: 'Send government IDs or bank details.' });
export type UpdateRestrictedData = z.output<typeof updateRestrictedSchema>;

export const revealRestrictedSchema = z.object({ field: z.enum(RESTRICTED_FIELDS, { message: 'Choose what to reveal.' }) }).strict();
export type RevealRestrictedData = z.output<typeof revealRestrictedSchema>;

// ───────────────────────────────────────────────────────────── self-service and change approval

export const SELF_EDITABLE_FIELDS = ['preferredName', 'personalEmail', 'personalPhone', 'address', 'emergencyContact'] as const;

/** `PATCH /me/profile`: low-risk details only. Role, status, restricted and approval-only fields are not in it. */
export const updateSelfProfileSchema = z
  .object({
    preferredName: personShape.preferredName,
    personalEmail: personShape.personalEmail,
    personalPhone: personShape.personalPhone,
    address: personShape.address,
    emergencyContact: personShape.emergencyContact,
  })
  .partial()
  .strict();
export type UpdateSelfProfileData = z.output<typeof updateSelfProfileSchema>;

const reasonField = { reason: optionalText(300) };

export const createChangeRequestSchema = z.discriminatedUnion('fieldCategory', [
  z
    .object({
      fieldCategory: z.literal('LEGAL_NAME'),
      value: z.object({ legalFirstName: personNameSchema, legalMiddleName: optionalText(100), legalLastName: personNameSchema }).strict(),
      ...reasonField,
    })
    .strict(),
  z.object({ fieldCategory: z.literal('DATE_OF_BIRTH'), value: z.object({ dateOfBirth: dateOfBirthValueSchema }).strict(), ...reasonField }).strict(),
  z.object({ fieldCategory: z.literal('GOVERNMENT_ID'), value: z.object({ type: z.enum(GOVERNMENT_ID_TYPES), value: idValueSchema }).strict(), ...reasonField })
    .strict()
    .superRefine((req, ctx) => {
      if (req.value.type === 'AADHAAR' && !/^[0-9]{12}$/.test(req.value.value)) {
        ctx.addIssue({ code: 'custom', message: 'An Aadhaar number has 12 digits.', path: ['value', 'value'] });
      }
    }),
  z.object({ fieldCategory: z.literal('BANK_DETAILS'), value: bankDetailsSchema, ...reasonField }).strict(),
]);
export type CreateChangeRequestData = z.output<typeof createChangeRequestSchema>;

export const listChangeRequestsQuerySchema = z.object({ status: z.enum(['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED']).optional() });
export type ListChangeRequestsQuery = z.output<typeof listChangeRequestsQuerySchema>;

export const approveChangeRequestSchema = z.object({ note: optionalText(300) }).strict();
export const rejectChangeRequestSchema = z.object({ note: requiredText('Note', 300) }).strict();
export type DecideChangeRequestData = { note?: string | null };

// Values the field categories carry, as stored (encrypted) on a request.
export type ChangeRequestValue = CreateChangeRequestData['value'];
export const CHANGE_CATEGORIES_NEEDING_STEP_UP: readonly (typeof CHANGE_FIELD_CATEGORIES)[number][] = ['GOVERNMENT_ID', 'BANK_DETAILS'];

// ───────────────────────────────────────────────────────────── documents and exports

/** Text fields sent beside the file in the multipart body. */
export const uploadDocumentFieldsSchema = z
  .object({
    documentType: z.enum(DOCUMENT_TYPES, { message: 'Choose a document type.' }),
    displayName: optionalText(120),
  })
  .strict();
export type UploadDocumentFields = z.output<typeof uploadDocumentFieldsSchema>;

export const createExportSchema = z
  .object({
    purpose: z.enum(EXPORT_PURPOSES, { message: 'Choose what the export is for.' }),
    filters: listEmployeesQuerySchema.omit({ page: true, pageSize: true }).strict().default({}),
  })
  .strict();
export type CreateExportData = z.output<typeof createExportSchema>;
