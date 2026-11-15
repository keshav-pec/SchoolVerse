import { z } from 'zod';
import { LOCATION_CREATE_INTENTS, LOCATION_STATUSES, LOCATION_TYPES } from '../enums';
import { paginationQuerySchema, uuidSchema } from './common';
import {
  countrySchema,
  currencySchema,
  DEFAULT_COUNTRY,
  localeSchema,
  locationCodeSchema,
  optionalDateSchema,
  optionalEmailSchema,
  optionalLatitudeSchema,
  optionalLongitudeSchema,
  optionalPhoneSchema,
  optionalText,
  optionalUrlSchema,
  postalCodeError,
  requiredText,
  timezoneSchema,
} from './fields';

/**
 * School locations (SCH-LOC-03/04/05, PRD §9).
 *
 * A DRAFT is "configuration incomplete" (PRD §10), so drafts only need a name, code and type.
 * Everything an operational location needs (phone + structured address) is checked when the
 * location is created with `intent: "ACTIVE"` or activated later — see `missingActivationFields`.
 */

// ───────────────────────────────────────────────────────────── address

export const addressSchema = z
  .object({
    line1: optionalText(200),
    line2: optionalText(200),
    locality: optionalText(120),
    city: optionalText(100),
    district: optionalText(100),
    state: optionalText(100),
    postalCode: optionalText(12),
    country: countrySchema.default(DEFAULT_COUNTRY),
  })
  .superRefine((address, ctx) => {
    if (address.postalCode) {
      const message = postalCodeError(address.postalCode, address.country);
      if (message) ctx.addIssue({ code: 'custom', path: ['postalCode'], message });
    }
  });
export type AddressInput = z.input<typeof addressSchema>;
export type AddressData = z.output<typeof addressSchema>;

/** Optional override: `""`/`null` → null (inherit), missing key → undefined. */
const nullable = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? null : v), schema.nullable()).optional();

// ───────────────────────────────────────────────────────────── create / update

const locationShape = {
  displayName: requiredText('Location name', 120),
  locationCode: locationCodeSchema,
  locationType: z.enum(LOCATION_TYPES, { message: 'Choose a location type.' }),
  officialName: optionalText(200),
  openingDate: optionalDateSchema,
  /** `null` = inherit the school default (PRD §6 "Operational Defaults"). */
  timezoneOverride: nullable(timezoneSchema),
  currencyOverride: nullable(currencySchema),
  localeOverride: nullable(localeSchema),
  email: optionalEmailSchema,
  phone: optionalPhoneSchema,
  alternatePhone: optionalPhoneSchema,
  websiteUrl: optionalUrlSchema,
  latitude: optionalLatitudeSchema,
  longitude: optionalLongitudeSchema,
  notes: optionalText(2000),
  address: addressSchema,
};

/** Fields a PATCH may change, in the order the audit diff reports them. */
export const LOCATION_EDITABLE_FIELDS = [
  'displayName',
  'locationCode',
  'locationType',
  'officialName',
  'openingDate',
  'timezoneOverride',
  'currencyOverride',
  'localeOverride',
  'email',
  'phone',
  'alternatePhone',
  'websiteUrl',
  'latitude',
  'longitude',
  'notes',
  'address.line1',
  'address.line2',
  'address.locality',
  'address.city',
  'address.district',
  'address.state',
  'address.postalCode',
  'address.country',
] as const;

/** Lifecycle fields that only business operations may change (PRD §17). */
export const LOCATION_NON_EDITABLE_FIELDS = {
  status: 'Use the Activate, Deactivate or Archive actions to change the status.',
  isPrimary: 'Use the Set as Primary action to change the Primary Location.',
} as const;

function checkCoordinatesPair(value: { latitude?: number | null; longitude?: number | null }, ctx: z.RefinementCtx) {
  const hasLat = value.latitude !== null && value.latitude !== undefined;
  const hasLng = value.longitude !== null && value.longitude !== undefined;
  if (hasLat !== hasLng) {
    ctx.addIssue({
      code: 'custom',
      path: [hasLat ? 'longitude' : 'latitude'],
      message: 'Enter both latitude and longitude, or leave both empty.',
    });
  }
}

export const createLocationSchema = z
  .object({
    ...locationShape,
    address: addressSchema.prefault({}),
    /** Save as Draft or Activate Location (PRD §12). */
    intent: z.enum(LOCATION_CREATE_INTENTS).default('DRAFT'),
    /** "Primary flag" in the Add Location flow. Only an active location can be Primary. */
    isPrimary: z.boolean().default(false),
  })
  .superRefine((value, ctx) => {
    checkCoordinatesPair(value, ctx);
    if (value.isPrimary && value.intent !== 'ACTIVE') {
      ctx.addIssue({
        code: 'custom',
        path: ['isPrimary'],
        message: 'Only an active location can be Primary. Choose Activate Location, or untick Primary.',
      });
    }
    if (value.intent === 'ACTIVE') {
      for (const [path, message] of Object.entries(missingActivationFields(value))) {
        ctx.addIssue({ code: 'custom', path: path.split('.'), message });
      }
    }
  });
export type CreateLocationInput = z.input<typeof createLocationSchema>;
export type CreateLocationData = z.output<typeof createLocationSchema>;

/**
 * PATCH: a missing key leaves the field unchanged. `address` is replaced as a whole object
 * so postal-code rules can always be checked against its country.
 */
export const updateLocationSchema = z.object(locationShape).partial();
export type UpdateLocationInput = z.input<typeof updateLocationSchema>;
export type UpdateLocationData = z.output<typeof updateLocationSchema>;

// ───────────────────────────────────────────────────────────── activation completeness

interface ActivationCandidate {
  phone?: string | null;
  address?: {
    line1?: string | null;
    city?: string | null;
    state?: string | null;
    postalCode?: string | null;
    country?: string | null;
  } | null;
}

/** Required for any non-draft location (PRD §9 required columns + structured address). */
export function missingActivationFields(location: ActivationCandidate): Record<string, string> {
  const missing: Record<string, string> = {};
  const a = location.address ?? {};
  if (!location.phone) missing.phone = 'Phone number is required for an active location.';
  if (!a.line1) missing['address.line1'] = 'Address line 1 is required for an active location.';
  if (!a.city) missing['address.city'] = 'City is required for an active location.';
  if (!a.state) missing['address.state'] = 'State is required for an active location.';
  if (!a.postalCode) missing['address.postalCode'] = 'Postal code is required for an active location.';
  if (!a.country) missing['address.country'] = 'Country is required for an active location.';
  return missing;
}

// ───────────────────────────────────────────────────────────── list / search

/** Accepts `status=ACTIVE,DRAFT` or `status=ACTIVE&status=DRAFT`. */
function csvEnum<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
    z.array(z.enum(values)).min(1),
  );
}

export const LOCATION_SORTS = [
  'displayName',
  '-displayName',
  'locationCode',
  '-locationCode',
  'city',
  '-city',
  'status',
  '-status',
  'locationType',
  '-locationType',
  'openingDate',
  '-openingDate',
  'createdAt',
  '-createdAt',
] as const;
export type LocationSort = (typeof LOCATION_SORTS)[number];

export const listLocationsQuerySchema = paginationQuerySchema.extend({
  /** Matches location name, official name, code or city (case-insensitive, partial). */
  q: z.string().trim().max(100).optional(),
  /** Defaults to every status except ARCHIVED. */
  status: csvEnum(LOCATION_STATUSES).optional(),
  type: csvEnum(LOCATION_TYPES).optional(),
  city: z.string().trim().max(100).optional(),
  /** Primary first, then this sort (default `displayName`). */
  sort: z.enum(LOCATION_SORTS).default('displayName'),
});
export type ListLocationsQuery = z.output<typeof listLocationsQuerySchema>;

// ───────────────────────────────────────────────────────────── location code availability (SCH-LOC-08)

export const codeAvailabilityQuerySchema = z
  .object({
    code: z.string().max(40).optional(),
    /** Location name to base a suggestion on, e.g. "Mohali Campus" → MOH. */
    name: z.string().max(120).optional(),
    /** Ignore this location when checking (editing an existing location). */
    excludeLocationId: uuidSchema.optional(),
  })
  .refine((v) => Boolean(v.code?.trim() || v.name?.trim()), { message: 'Provide a code or a name.', path: ['code'] });
export type CodeAvailabilityQuery = z.output<typeof codeAvailabilityQuerySchema>;

const CODE_STOP_WORDS = new Set([
  'THE', 'OF', 'AND', 'CAMPUS', 'BRANCH', 'SCHOOL', 'PUBLIC', 'LOCATION', 'OFFICE', 'MAIN',
  'ADMIN', 'ADMINISTRATIVE', 'CENTRE', 'CENTER', 'BLOCK', 'WING', 'UNIT',
]);

/**
 * First guess for a location code from its name (before checking availability):
 * one meaningful word → its first 3 letters ("Mohali Campus" → MOH);
 * several → their initials ("New Delhi Campus" → ND). Falls back to LOC.
 */
export function suggestLocationCodeBase(name: string): string {
  const words = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean);
  const meaningful = words.filter((w) => !CODE_STOP_WORDS.has(w));
  const pool = meaningful.length > 0 ? meaningful : words;
  if (pool.length === 0) return 'LOC';
  let base = pool.length === 1 ? pool[0]!.slice(0, 3) : pool.slice(0, 3).map((w) => w[0]).join('');
  if (base.length < 2) base = (base + pool[0]!.slice(1)).slice(0, 3);
  return base.length >= 2 ? base : 'LOC';
}
