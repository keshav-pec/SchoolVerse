import { z } from 'zod';
import { IDENTIFIER_STATUSES } from '../enums';
import { emailSchema } from './common';
import {
  currencySchema,
  DEFAULT_CURRENCY,
  DEFAULT_LOCALE,
  DEFAULT_TIMEZONE,
  localeSchema,
  optionalDateSchema,
  optionalPhoneSchema,
  optionalText,
  optionalUrlSchema,
  phoneSchema,
  requiredText,
  schoolCodeSchema,
  timezoneSchema,
} from './fields';

// ───────────────────────────────────────────────────────────── School profile (SCH-LOC-01, PRD §8)

/** Editable school profile fields. `status`, `logoUrl` and `setup` change only through dedicated operations. */
const schoolProfileShape = {
  schoolCode: schoolCodeSchema,
  legalName: requiredText('Legal name', 200),
  displayName: requiredText('School name', 120),
  shortName: optionalText(30),
  primaryEmail: emailSchema,
  primaryPhone: phoneSchema,
  alternatePhone: optionalPhoneSchema,
  websiteUrl: optionalUrlSchema,
  defaultTimezone: timezoneSchema,
  defaultCurrency: currencySchema,
  defaultLocale: localeSchema,
};

export const SCHOOL_PROFILE_FIELDS = Object.keys(schoolProfileShape) as (keyof typeof schoolProfileShape)[];

export const createSchoolSchema = z.object({
  ...schoolProfileShape,
  defaultTimezone: timezoneSchema.default(DEFAULT_TIMEZONE),
  defaultCurrency: currencySchema.default(DEFAULT_CURRENCY),
  defaultLocale: localeSchema.default(DEFAULT_LOCALE),
});
export type CreateSchoolInput = z.input<typeof createSchoolSchema>;
export type CreateSchoolData = z.output<typeof createSchoolSchema>;

/** PATCH: a missing key leaves the field unchanged; `null`/`""` clears an optional field. */
/** Live check for the School code field + a suggestion from the school name. */
export const schoolCodeAvailabilityQuerySchema = z
  .object({ code: z.string().max(40).optional(), name: z.string().max(200).optional() })
  .refine((v) => Boolean(v.code?.trim() || v.name?.trim()), { message: 'Provide a code or a name.', path: ['code'] });
export type SchoolCodeAvailabilityQuery = z.output<typeof schoolCodeAvailabilityQuerySchema>;

export const updateSchoolSchema =z.object(schoolProfileShape).partial();
export type UpdateSchoolInput = z.input<typeof updateSchoolSchema>;
export type UpdateSchoolData = z.output<typeof updateSchoolSchema>;

// ───────────────────────────────────────────────────────────── Official identifiers (PRD §8)

const identifierShape = {
  identifierType: requiredText('Identifier type', 60),
  identifierValue: requiredText('Identifier value', 100),
  issuingAuthority: optionalText(120),
  issueDate: optionalDateSchema,
  expiryDate: optionalDateSchema,
  documentUrl: optionalUrlSchema,
  status: z.enum(IDENTIFIER_STATUSES, { message: 'Choose a valid status.' }),
};

function checkDateOrder(
  value: { issueDate?: string | null; expiryDate?: string | null },
  ctx: z.RefinementCtx,
) {
  if (value.issueDate && value.expiryDate && value.expiryDate < value.issueDate) {
    ctx.addIssue({ code: 'custom', path: ['expiryDate'], message: 'Expiry date must be on or after the issue date.' });
  }
}

export const IDENTIFIER_FIELDS = Object.keys(identifierShape) as (keyof typeof identifierShape)[];

export const createIdentifierSchema = z
  .object({ ...identifierShape, status: identifierShape.status.default('ACTIVE') })
  .superRefine(checkDateOrder);
export type CreateIdentifierInput = z.input<typeof createIdentifierSchema>;
export type CreateIdentifierData = z.output<typeof createIdentifierSchema>;

/** Date order against stored values is re-checked by the service after merging. */
export const updateIdentifierSchema = z.object(identifierShape).partial().superRefine(checkDateOrder);
export type UpdateIdentifierInput = z.input<typeof updateIdentifierSchema>;
export type UpdateIdentifierData = z.output<typeof updateIdentifierSchema>;
