import { isSupportedCountry, parsePhoneNumberFromString } from 'libphonenumber-js';
import { z } from 'zod';

/**
 * Field-level building blocks shared by the API and the web forms (PRD §18 "Validation rules").
 *
 * Conventions:
 * - Optional fields accept `""` or `null` (both stored as `null`) or a missing key (`undefined`).
 *   On create, a missing key falls back to the model default (`null`); on PATCH it means
 *   "leave unchanged", while `null` / `""` clears the value.
 * - Values are normalised on the way in (trimmed, upper-cased codes, E.164 phones), so the API
 *   stores one canonical form.
 */

const emptyToNull = (v: unknown) => (v === null || (typeof v === 'string' && v.trim() === '') ? null : v);

/** Required, trimmed text. */
export function requiredText(label: string, max: number) {
  return z
    .string({ message: `${label} is required.` })
    .trim()
    .min(1, { message: `${label} is required.` })
    .max(max, { message: `Use at most ${max} characters.` });
}

/** Optional, trimmed text. Empty → null. */
export function optionalText(max: number) {
  return z.preprocess(emptyToNull, z.string().trim().max(max, { message: `Use at most ${max} characters.` }).nullable()).optional();
}

// ───────────────────────────────────────────────────────────── email

export const optionalEmailSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .toLowerCase()
    .max(254, { message: 'Email is too long.' })
    .pipe(z.email({ message: 'Enter a valid email address.' }))
    .nullable(),
).optional();

// ───────────────────────────────────────────────────────────── phone

/** India is the default deployment region; numbers elsewhere must include their country code. */
export const DEFAULT_PHONE_COUNTRY = 'IN' as const;
const PHONE_MESSAGE = 'Enter a valid phone number. Include the country code for numbers outside India.';

/** Returns the E.164 form (e.g. `+919876543210`) or `null` when the number is not valid. */
export function normalizePhone(value: string): string | null {
  const parsed = parsePhoneNumberFromString(value.trim(), DEFAULT_PHONE_COUNTRY);
  return parsed && parsed.isValid() ? parsed.number : null;
}

const phoneCore = z
  .string()
  .trim()
  .max(32, { message: PHONE_MESSAGE })
  .transform((value, ctx) => {
    const normalized = normalizePhone(value);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: PHONE_MESSAGE });
      return z.NEVER;
    }
    return normalized;
  });

export const phoneSchema = z
  .string({ message: 'Phone number is required.' })
  .trim()
  .min(1, { message: 'Phone number is required.' })
  .pipe(phoneCore);

export const optionalPhoneSchema = z.preprocess(emptyToNull, phoneCore.nullable()).optional();

// ───────────────────────────────────────────────────────────── website / document URLs

const URL_MESSAGE = 'Enter a valid web address, e.g. https://example.edu.in';

/** Accepts `example.edu.in` or a full http(s) URL and stores the normalised `https://…` form. */
export function normalizeUrl(value: string): string | null {
  const raw = value.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.') && url.hostname !== 'localhost') return null;
    const text = url.toString();
    return url.pathname === '/' && !url.search && !url.hash ? text.replace(/\/$/, '') : text;
  } catch {
    return null;
  }
}

export const optionalUrlSchema = z.preprocess(
  emptyToNull,
  z
    .string()
    .trim()
    .max(500, { message: 'This web address is too long.' })
    .transform((value, ctx) => {
      const normalized = normalizeUrl(value);
      if (!normalized) {
        ctx.addIssue({ code: 'custom', message: URL_MESSAGE });
        return z.NEVER;
      }
      return normalized;
    })
    .nullable(),
).optional();

// ───────────────────────────────────────────────────────────── operational defaults

const SUPPORTED_TIME_ZONES = new Set<string>(
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [],
);

/** Valid IANA time zone (canonical names plus their aliases, e.g. `Asia/Calcutta`). */
export function isValidTimeZone(tz: string): boolean {
  if (SUPPORTED_TIME_ZONES.has(tz)) return true;
  if (tz !== 'UTC' && !tz.includes('/')) return false; // reject abbreviations and raw offsets
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string({ message: 'Time zone is required.' })
  .trim()
  .refine(isValidTimeZone, { message: 'Choose a valid time zone, e.g. Asia/Kolkata.' });

const SUPPORTED_CURRENCIES = new Set<string>(
  typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : [],
);

export const currencySchema = z
  .string({ message: 'Currency is required.' })
  .trim()
  .toUpperCase()
  .refine((c) => /^[A-Z]{3}$/.test(c) && (SUPPORTED_CURRENCIES.size === 0 || SUPPORTED_CURRENCIES.has(c)), {
    message: 'Choose a valid ISO currency code, e.g. INR.',
  });

/** BCP 47 locale (e.g. `en-IN`), stored in canonical form. */
export const localeSchema = z
  .string({ message: 'Locale is required.' })
  .trim()
  .max(35)
  .transform((value, ctx) => {
    try {
      const [canonical] = Intl.getCanonicalLocales(value);
      if (canonical) return canonical;
    } catch {
      // fall through
    }
    ctx.addIssue({ code: 'custom', message: 'Choose a valid locale, e.g. en-IN.' });
    return z.NEVER;
  });

export const DEFAULT_TIMEZONE = 'Asia/Kolkata';
export const DEFAULT_CURRENCY = 'INR';
export const DEFAULT_LOCALE = 'en-IN';
export const DEFAULT_COUNTRY = 'IN';

// ───────────────────────────────────────────────────────────── address

/** ISO 3166-1 alpha-2 country code, e.g. `IN`. */
export const countrySchema = z
  .string({ message: 'Country is required.' })
  .trim()
  .toUpperCase()
  .refine((c) => /^[A-Z]{2}$/.test(c) && isSupportedCountry(c), { message: 'Choose a valid country.' });

const POSTAL_RULES: Record<string, { pattern: RegExp; message: string }> = {
  IN: { pattern: /^[1-9][0-9]{5}$/, message: 'Enter a valid 6-digit PIN code.' },
  US: { pattern: /^[0-9]{5}(-[0-9]{4})?$/, message: 'Enter a valid ZIP code, e.g. 94105.' },
  GB: { pattern: /^[A-Z]{1,2}[0-9][A-Z0-9]? ?[0-9][A-Z]{2}$/i, message: 'Enter a valid postcode, e.g. SW1A 1AA.' },
  CA: { pattern: /^[A-Z][0-9][A-Z] ?[0-9][A-Z][0-9]$/i, message: 'Enter a valid postal code, e.g. K1A 0B1.' },
  AU: { pattern: /^[0-9]{4}$/, message: 'Enter a valid 4-digit postcode.' },
  SG: { pattern: /^[0-9]{6}$/, message: 'Enter a valid 6-digit postal code.' },
};
const GENERIC_POSTAL = { pattern: /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/, message: 'Enter a valid postal code.' };

/** Country-aware postal code check. Returns an error message, or `null` when the code is valid. */
export function postalCodeError(postalCode: string, country: string | null | undefined): string | null {
  const rule = (country && POSTAL_RULES[country.toUpperCase()]) || GENERIC_POSTAL;
  return rule.pattern.test(postalCode.trim()) ? null : rule.message;
}

// ───────────────────────────────────────────────────────────── geo

export const optionalLatitudeSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : emptyToNull(v)),
  z.number({ message: 'Latitude must be a number.' }).min(-90, { message: 'Latitude must be between -90 and 90.' }).max(90, { message: 'Latitude must be between -90 and 90.' }).nullable(),
).optional();

export const optionalLongitudeSchema = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : emptyToNull(v)),
  z.number({ message: 'Longitude must be a number.' }).min(-180, { message: 'Longitude must be between -180 and 180.' }).max(180, { message: 'Longitude must be between -180 and 180.' }).nullable(),
).optional();

// ───────────────────────────────────────────────────────────── dates (date-only, no time zone shift)

export function isRealDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Required calendar date as `YYYY-MM-DD`. */
export const requiredDateSchema = z
  .string({ message: 'Date is required.' })
  .trim()
  .min(1, { message: 'Date is required.' })
  .refine(isRealDate, { message: 'Enter a valid date (YYYY-MM-DD).' });

/** Optional calendar date as `YYYY-MM-DD`. */
export const optionalDateSchema = z.preprocess(
  emptyToNull,
  z.string().trim().refine(isRealDate, { message: 'Enter a valid date (YYYY-MM-DD).' }).nullable(),
).optional();

// ───────────────────────────────────────────────────────────── codes

/** PRD §10: mandatory, uppercase, trimmed, max 10 characters. Examples: MOH, CHD, PKL, DEL01. */
export const LOCATION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,9}$/;
export const LOCATION_CODE_FORMAT_MESSAGE = 'Use 2–10 letters, numbers or hyphens, e.g. MOH or DEL01.';

export function normalizeLocationCode(value: string): string {
  return value.trim().toUpperCase();
}

export const locationCodeSchema = z
  .string({ message: 'Location code is required.' })
  .transform(normalizeLocationCode)
  .pipe(
    z
      .string()
      .min(1, { message: 'Location code is required.' })
      .regex(LOCATION_CODE_PATTERN, { message: LOCATION_CODE_FORMAT_MESSAGE }),
  );

export const SCHOOL_CODE_PATTERN = /^[A-Z0-9][A-Z0-9-]{1,19}$/;

export const schoolCodeSchema = z
  .string({ message: 'School code is required.' })
  .transform((v) => v.trim().toUpperCase())
  .pipe(
    z
      .string()
      .min(1, { message: 'School code is required.' })
      .regex(SCHOOL_CODE_PATTERN, { message: 'Use 2–20 letters, numbers or hyphens, e.g. GPS or GPS-01.' }),
  );
