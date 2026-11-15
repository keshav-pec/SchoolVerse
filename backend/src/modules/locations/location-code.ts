import type { ClientSession } from 'mongoose';
import {
  LOCATION_CODE_FORMAT_MESSAGE,
  LOCATION_CODE_PATTERN,
  normalizeLocationCode,
  suggestLocationCodeBase,
  type LocationCodeAvailabilityDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { escapeRegex } from '../../core/objects';
import { isLocationReferenced } from '../dependencies/registry';
import { Location } from './location.model';

/**
 * SCH-LOC-08 — location code rules (PRD §10).
 * Codes are trimmed + upper-cased, 2–10 characters, unique within the school (archived codes stay
 * reserved), and locked once downstream records reference the location. `locationId` never changes.
 */

interface SchoolScope {
  tenantId: string;
  schoolId: string;
}

export const codeTakenMessage = (code: string) => `Location code ${code} is already in use.`;

export async function isCodeTaken(scope: SchoolScope, code: string, excludeLocationId?: string, session?: ClientSession) {
  const found = await Location.exists({
    tenantId: scope.tenantId,
    schoolId: scope.schoolId,
    locationCode: code,
    ...(excludeLocationId ? { _id: { $ne: excludeLocationId } } : {}),
  }).session(session ?? null);
  return Boolean(found);
}

/** First free code for a base: MOH → MOH2 → MOH3 … (always ≤ 10 characters). */
export async function nextFreeCode(scope: SchoolScope, rawBase: string, excludeLocationId?: string): Promise<string> {
  const base = normalizeLocationCode(rawBase).replace(/[^A-Z0-9-]/g, '').slice(0, 10) || 'LOC';
  // Candidates are `stem + n` (n ≤ 3 digits), so every candidate starts with the first 7 stem characters.
  const stem = base.replace(/[0-9]+$/, '') || base;
  const prefix = stem.slice(0, 7);
  const rows = await Location.find({
    tenantId: scope.tenantId,
    schoolId: scope.schoolId,
    locationCode: { $regex: `^${escapeRegex(prefix)}` },
    ...(excludeLocationId ? { _id: { $ne: excludeLocationId } } : {}),
  })
    .select('locationCode')
    .lean<{ locationCode: string }[]>();
  const taken = new Set(rows.map((r) => r.locationCode));

  if (base.length >= 2 && !taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = String(n);
    const candidate = stem.slice(0, 10 - suffix.length) + suffix;
    if (!taken.has(candidate)) return candidate;
  }
  return `L${Date.now().toString(36).toUpperCase()}`.slice(0, 10);
}

/** Powers the live availability check + suggestion in the Add/Edit Location forms. */
export async function checkCodeAvailability(
  scope: SchoolScope,
  query: { code?: string; name?: string; excludeLocationId?: string },
): Promise<LocationCodeAvailabilityDTO> {
  const name = query.name?.trim();
  const code = query.code !== undefined && query.code.trim() !== '' ? normalizeLocationCode(query.code) : null;

  if (!code) {
    return {
      code: null,
      valid: false,
      available: false,
      message: null,
      suggestion: name ? await nextFreeCode(scope, suggestLocationCodeBase(name), query.excludeLocationId) : null,
    };
  }

  if (!LOCATION_CODE_PATTERN.test(code)) {
    return {
      code,
      valid: false,
      available: false,
      message: LOCATION_CODE_FORMAT_MESSAGE,
      suggestion: await nextFreeCode(scope, name ? suggestLocationCodeBase(name) : code, query.excludeLocationId),
    };
  }

  const taken = await isCodeTaken(scope, code, query.excludeLocationId);
  return {
    code,
    valid: true,
    available: !taken,
    message: taken ? codeTakenMessage(code) : null,
    suggestion: taken ? await nextFreeCode(scope, code, query.excludeLocationId) : null,
  };
}

/** Throws LOCATION_CODE_TAKEN (with a suggestion) when the code is used by another location of the school. */
export async function assertCodeAvailable(
  scope: SchoolScope,
  code: string,
  options: { excludeLocationId?: string; session?: ClientSession } = {},
) {
  if (await isCodeTaken(scope, code, options.excludeLocationId, options.session)) {
    throw codeTakenError(code, await nextFreeCode(scope, code, options.excludeLocationId));
  }
}

export function codeTakenError(code: string, suggestion?: string | null) {
  const message = codeTakenMessage(code);
  return new AppError('LOCATION_CODE_TAKEN', message, {
    fields: { locationCode: message },
    ...(suggestion ? { suggestion } : {}),
  });
}

/** PRD §10: once downstream records reference a location, its code can no longer change. */
export async function assertCodeChangeAllowed(scope: SchoolScope & { locationId: string; session?: ClientSession }) {
  if (await isLocationReferenced(scope)) {
    throw new AppError('LOCATION_CODE_LOCKED', undefined, {
      fields: { locationCode: 'This code is locked because other records already reference this location.' },
    });
  }
}
