import type { ClientSession } from 'mongoose';
import type {
  LocationInvalidReason,
  LocationStatus,
  LocationValidationDTO,
  LocationValidationPurpose,
  MasterLocationDTO,
  MasterLocationScope,
  MasterSchoolContextDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { registerLocationDependency } from '../dependencies/registry';
import { Location, type LocationDoc } from '../locations/location.model';
import { effectiveDefaults } from '../locations/location.service';
import type { SchoolDoc } from '../school/school.model';
import { getCurrentSchool, getSchoolOrThrow } from '../school/school.service';

/**
 * SCH-LOC-14 — the downstream contract of School Setup (PRD §16).
 *
 * Other modules must consume the School / Location master through this file (in-process) or through
 * `/api/v1/master/*` (over HTTP) and store `locationId` — never a copied name or code. The DTO fields
 * below are frozen; see docs/CONTRACTS.md.
 */

const SCOPE_STATUSES: Record<MasterLocationScope, LocationStatus[]> = {
  operational: ['ACTIVE'],
  configuration: ['DRAFT', 'ACTIVE', 'INACTIVE'],
  all: ['DRAFT', 'ACTIVE', 'INACTIVE', 'ARCHIVED'],
};

export function toMasterLocationDTO(doc: LocationDoc, school: Pick<SchoolDoc, 'defaultTimezone' | 'defaultCurrency' | 'defaultLocale'>): MasterLocationDTO {
  const defaults = effectiveDefaults(doc, school);
  return {
    locationId: doc._id,
    schoolId: doc.schoolId,
    locationCode: doc.locationCode,
    displayName: doc.displayName,
    locationType: doc.locationType,
    status: doc.status,
    isPrimary: Boolean(doc.isPrimary),
    city: doc.address?.city ?? null,
    state: doc.address?.state ?? null,
    country: doc.address?.country ?? null,
    effectiveDefaults: { timezone: defaults.timezone, currency: defaults.currency, locale: defaults.locale },
  };
}

/** Limited roles never see DRAFT locations: a draft has never been operational, so no record can refer to it. */
function visibleStatuses(ctx: ServiceContext, wanted: LocationStatus[]): LocationStatus[] {
  return can(ctx, 'location:view_config') ? wanted : wanted.filter((s) => s !== 'DRAFT');
}

// ───────────────────────────────────────────────────────────── reads

export async function getSchoolContext(ctx: ServiceContext): Promise<MasterSchoolContextDTO> {
  const school = await getCurrentSchool(ctx);
  if (!school) throw AppError.notFound('This workspace has no school yet.');
  const primary = await Location.findOne({ tenantId: ctx.tenantId, schoolId: school._id, isPrimary: true, status: 'ACTIVE' }).select('_id').lean<{ _id: string }>();
  return {
    schoolId: school._id,
    tenantId: school.tenantId,
    displayName: school.displayName,
    shortName: school.shortName ?? null,
    defaults: { timezone: school.defaultTimezone, currency: school.defaultCurrency, locale: school.defaultLocale },
    primaryLocationId: primary?._id ?? null,
    setupCompleted: school.setup?.status === 'COMPLETED',
  };
}

export async function listMasterLocations(ctx: ServiceContext, scope: MasterLocationScope): Promise<MasterLocationDTO[]> {
  const school = await getCurrentSchool(ctx);
  if (!school) return [];
  const rows = await Location.find({ tenantId: ctx.tenantId, schoolId: school._id, status: { $in: visibleStatuses(ctx, SCOPE_STATUSES[scope]) } })
    .collation({ locale: 'en', strength: 2 })
    .sort({ isPrimary: -1, displayName: 1, _id: 1 })
    .lean<LocationDoc[]>();
  return rows.map((l) => toMasterLocationDTO(l, school));
}

/** Resolves a location of any status, so historical records can still show its name. */
export async function getMasterLocation(ctx: ServiceContext, locationId: string, session?: ClientSession): Promise<MasterLocationDTO> {
  const doc = await Location.findOne({ _id: locationId, tenantId: ctx.tenantId }).session(session ?? null).lean<LocationDoc>();
  if (!doc || !visibleStatuses(ctx, [doc.status]).length) throw AppError.notFound('Location not found.');
  const school = await getSchoolOrThrow(ctx, doc.schoolId, session);
  return toMasterLocationDTO(doc, school);
}

export async function validateLocations(ctx: ServiceContext, locationIds: string[], purpose: LocationValidationPurpose): Promise<LocationValidationDTO> {
  const unique = [...new Set(locationIds)];
  const rows = await Location.find({ tenantId: ctx.tenantId, _id: { $in: unique } }).select('status').lean<{ _id: string; status: LocationStatus }[]>();
  const statusOf = new Map(rows.map((r) => [r._id, r.status]));

  const results = unique.map((locationId) => {
    const status = statusOf.get(locationId);
    let reason: LocationInvalidReason | null = null;
    if (!status || !visibleStatuses(ctx, [status]).length) reason = 'NOT_FOUND';
    else if (purpose === 'NEW_ASSIGNMENT' && status === 'ARCHIVED') reason = 'ARCHIVED';
    else if (purpose === 'NEW_ASSIGNMENT' && status !== 'ACTIVE') reason = 'NOT_ACTIVE';
    return { locationId, valid: reason === null, reason };
  });
  return { purpose, allValid: results.every((r) => r.valid), results };
}

// ───────────────────────────────────────────────────────────── in-process contract for future modules

/**
 * Use inside any write that assigns something to a location (a staff assignment, an enrollment, a room…).
 * Throws 404 for unknown / other-tenant ids and `LOCATION_NOT_ACTIVE` for draft, inactive or archived ones.
 */
export async function assertOperationalLocation(ctx: ServiceContext, locationId: string, session?: ClientSession): Promise<MasterLocationDTO> {
  const location = await getMasterLocation(ctx, locationId, session);
  if (location.status !== 'ACTIVE') {
    throw new AppError('LOCATION_NOT_ACTIVE', location.status === 'ARCHIVED' ? 'This location is archived and cannot be used for new records.' : undefined, {
      locationId,
      status: location.status,
    });
  }
  return location;
}

/** The school's Primary Location, or `null` before setup has produced one. */
export async function getPrimaryLocation(ctx: ServiceContext): Promise<MasterLocationDTO | null> {
  const school = await getCurrentSchool(ctx);
  if (!school) return null;
  const doc = await Location.findOne({ tenantId: ctx.tenantId, schoolId: school._id, isPrimary: true, status: 'ACTIVE' }).lean<LocationDoc>();
  return doc ? toMasterLocationDTO(doc, school) : null;
}

/** Facade handed to other modules: one import, the whole School Setup contract. */
export const masterService = {
  getSchoolContext,
  listLocations: listMasterLocations,
  getLocation: getMasterLocation,
  validateLocations,
  assertOperationalLocation,
  getPrimaryLocation,
  registerLocationDependency,
};
