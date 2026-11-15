import type { ClientSession } from 'mongoose';
import {
  LOCATION_EDITABLE_FIELDS,
  LOCATION_STATUSES,
  LOCATION_TYPES,
  missingActivationFields,
  type CreateLocationData,
  type ListLocationsQuery,
  type LocationAction,
  type LocationDetailDTO,
  type LocationDTO,
  type LocationFacetsDTO,
  type LocationListDTO,
  type LocationStatus,
  type LocationType,
  type UpdateLocationData,
} from '@shared';
import { AppError } from '../../core/errors';
import { escapeRegex, pickDefined, toIso } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { actorFrom, can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { diffFields } from '../audit/diff';
import { findActiveDependencies, isLocationReferenced } from '../dependencies/registry';
import type { SchoolDoc } from '../school/school.model';
import { getSchoolOrThrow } from '../school/school.service';
import { assertTransition } from './lifecycle';
import { assertCodeAvailable, assertCodeChangeAllowed, codeTakenError } from './location-code';
import { Location, type LocationAddress, type LocationDoc } from './location.model';
import { assignPrimaryIfNone, lockSchoolLocations, switchPrimary } from './primary';

/** SCH-LOC-03/04/05/06/07/11 — school location master. */

const EMPTY_ADDRESS: LocationAddress = {
  line1: null,
  line2: null,
  locality: null,
  city: null,
  district: null,
  state: null,
  postalCode: null,
  country: 'IN',
};

// ───────────────────────────────────────────────────────────── mapping

type DefaultsSource = Pick<SchoolDoc, 'defaultTimezone' | 'defaultCurrency' | 'defaultLocale'>;

export function effectiveDefaults(location: Pick<LocationDoc, 'timezoneOverride' | 'currencyOverride' | 'localeOverride'>, school: DefaultsSource) {
  return {
    timezone: location.timezoneOverride ?? school.defaultTimezone,
    currency: location.currencyOverride ?? school.defaultCurrency,
    locale: location.localeOverride ?? school.defaultLocale,
    inherited: {
      timezone: !location.timezoneOverride,
      currency: !location.currencyOverride,
      locale: !location.localeOverride,
    },
  };
}

export function toLocationDTO(doc: LocationDoc, school: DefaultsSource, options: { includeConfig: boolean }): LocationDTO {
  const a = { ...EMPTY_ADDRESS, ...(doc.address ?? {}) };
  return {
    locationId: doc._id,
    schoolId: doc.schoolId,
    locationCode: doc.locationCode,
    displayName: doc.displayName,
    officialName: doc.officialName ?? null,
    locationType: doc.locationType,
    isPrimary: Boolean(doc.isPrimary),
    status: doc.status,
    openingDate: doc.openingDate ?? null,
    timezoneOverride: doc.timezoneOverride ?? null,
    currencyOverride: doc.currencyOverride ?? null,
    localeOverride: doc.localeOverride ?? null,
    effectiveDefaults: effectiveDefaults(doc, school),
    email: doc.email ?? null,
    phone: doc.phone ?? null,
    alternatePhone: doc.alternatePhone ?? null,
    websiteUrl: doc.websiteUrl ?? null,
    latitude: doc.latitude ?? null,
    longitude: doc.longitude ?? null,
    address: {
      line1: a.line1 ?? null,
      line2: a.line2 ?? null,
      locality: a.locality ?? null,
      city: a.city ?? null,
      district: a.district ?? null,
      state: a.state ?? null,
      postalCode: a.postalCode ?? null,
      country: a.country ?? 'IN',
    },
    // Filled in once the Staff / Student modules exist (PRD §13: otherwise "—").
    staffCount: null,
    studentCount: null,
    ...(options.includeConfig ? { notes: doc.notes ?? null } : {}),
    statusChangedAt: toIso(doc.statusChangedAt),
    archivedAt: toIso(doc.archivedAt),
    createdAt: toIso(doc.createdAt)!,
    updatedAt: toIso(doc.updatedAt)!,
  };
}

const canViewConfig = (ctx: ServiceContext) => can(ctx, 'location:view_config');

/** Detail view: adds `codeLocked` / `deletable` for configuration users. */
export async function toLocationDetailDTO(ctx: ServiceContext, doc: LocationDoc, school: DefaultsSource): Promise<LocationDetailDTO> {
  const includeConfig = canViewConfig(ctx);
  const base = toLocationDTO(doc, school, { includeConfig });
  if (!includeConfig) return { ...base, codeLocked: false, deletable: false };
  const referenced = await isLocationReferenced({ tenantId: ctx.tenantId, schoolId: doc.schoolId, locationId: doc._id });
  return { ...base, codeLocked: referenced, deletable: doc.status === 'DRAFT' && !referenced };
}

// ───────────────────────────────────────────────────────────── reads

/**
 * Loads a location of the caller's tenant. Users without `location:view_config` (Faculty/Staff)
 * only see ACTIVE locations; anything else looks like it doesn't exist.
 */
export async function getLocationOrThrow(ctx: ServiceContext, locationId: string, session?: ClientSession) {
  const doc = await Location.findOne({ _id: locationId, tenantId: ctx.tenantId })
    .session(session ?? null)
    .lean<LocationDoc>();
  if (!doc || (!canViewConfig(ctx) && doc.status !== 'ACTIVE')) throw AppError.notFound('Location not found.');
  return doc;
}

const SORT_FIELDS: Record<string, string> = {
  displayName: 'displayName',
  locationCode: 'locationCode',
  city: 'address.city',
  status: 'status',
  locationType: 'locationType',
  openingDate: 'openingDate',
  createdAt: 'createdAt',
};

export async function listLocations(ctx: ServiceContext, school: SchoolDoc, query: ListLocationsQuery): Promise<LocationListDTO> {
  const includeConfig = canViewConfig(ctx);
  // Visibility first: limited viewers (Faculty/Staff) only ever see operational (ACTIVE) locations.
  const visible: Record<string, unknown> = { tenantId: ctx.tenantId, schoolId: school._id };
  if (!includeConfig) visible.status = 'ACTIVE';

  const filter: Record<string, unknown> = { ...visible };
  if (includeConfig) {
    filter.status = query.status ? { $in: query.status } : { $ne: 'ARCHIVED' };
  } else if (query.status && !query.status.includes('ACTIVE')) {
    filter.status = { $in: [] }; // asked only for statuses they cannot see
  }
  if (query.type) filter.locationType = { $in: query.type };
  if (query.city) filter['address.city'] = { $regex: `^${escapeRegex(query.city)}$`, $options: 'i' };
  if (query.q) {
    const rx = { $regex: escapeRegex(query.q), $options: 'i' };
    filter.$or = [{ displayName: rx }, { officialName: rx }, { locationCode: rx }, { 'address.city': rx }];
  }

  const desc = query.sort.startsWith('-');
  const sortField = SORT_FIELDS[desc ? query.sort.slice(1) : query.sort] ?? 'displayName';
  const sort: Record<string, 1 | -1> = { isPrimary: -1, [sortField]: desc ? -1 : 1, _id: 1 };

  const [items, total, facets] = await Promise.all([
    Location.find(filter)
      .collation({ locale: 'en', strength: 2 })
      .sort(sort)
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean<LocationDoc[]>(),
    Location.countDocuments(filter),
    computeFacets(visible),
  ]);

  return {
    items: items.map((doc) => toLocationDTO(doc, school, { includeConfig })),
    page: query.page,
    pageSize: query.pageSize,
    total,
    facets,
  };
}

async function computeFacets(visible: Record<string, unknown>): Promise<LocationFacetsDTO> {
  const [result] = await Location.aggregate<{
    cities: { _id: string; city: string; count: number }[];
    statuses: { _id: LocationStatus; count: number }[];
    types: { _id: LocationType; count: number }[];
  }>([
    { $match: visible },
    {
      $facet: {
        cities: [
          { $match: { 'address.city': { $nin: [null, ''] }, status: { $ne: 'ARCHIVED' } } },
          { $group: { _id: { $toLower: '$address.city' }, city: { $first: '$address.city' }, count: { $sum: 1 } } },
          { $sort: { _id: 1 } },
        ],
        statuses: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
        types: [{ $match: { status: { $ne: 'ARCHIVED' } } }, { $group: { _id: '$locationType', count: { $sum: 1 } } }],
      },
    },
  ]);

  const statuses = Object.fromEntries(LOCATION_STATUSES.map((s) => [s, 0])) as Record<LocationStatus, number>;
  for (const row of result?.statuses ?? []) statuses[row._id] = row.count;
  const types = Object.fromEntries(LOCATION_TYPES.map((t) => [t, 0])) as Record<LocationType, number>;
  for (const row of result?.types ?? []) types[row._id] = row.count;
  return { cities: (result?.cities ?? []).map(({ city, count }) => ({ city, count })), statuses, types };
}

// ───────────────────────────────────────────────────────────── create

function mapLocationDuplicate(err: unknown, code: string | undefined): never {
  const fields = duplicateKeyFields(err);
  if (fields?.includes('locationCode') && code) throw codeTakenError(code);
  throw err;
}

export async function createLocation(ctx: ServiceContext, schoolId: string, data: CreateLocationData) {
  const { intent, isPrimary, ...fields } = data;
  const status: LocationStatus = intent === 'ACTIVE' ? 'ACTIVE' : 'DRAFT';
  const scope = { tenantId: ctx.tenantId, schoolId };

  try {
    return await withTransaction(async (session) => {
      if (status === 'ACTIVE') await lockSchoolLocations(session, ctx.tenantId, schoolId);
      else await getSchoolOrThrow(ctx, schoolId, session);
      await assertCodeAvailable(scope, fields.locationCode, { session });

      const now = new Date();
      const [created] = await Location.create(
        [
          {
            ...pickDefined(fields),
            address: { ...EMPTY_ADDRESS, ...pickDefined(fields.address ?? {}) },
            tenantId: ctx.tenantId,
            schoolId,
            status,
            isPrimary: false,
            statusChangedAt: now,
            statusChangedBy: ctx.userId,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session },
      );
      const location = created!.toObject() as LocationDoc;
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'school_location',
          entityId: location._id,
          action: 'location.created',
          actor: actorFrom(ctx),
          changes: diffFields({}, location, [...LOCATION_EDITABLE_FIELDS, 'status']),
          metadata: { schoolId, intent },
          requestId: ctx.requestId,
        },
        session,
      );

      if (status === 'ACTIVE') {
        if (isPrimary) await switchPrimary(session, ctx, location);
        else await assignPrimaryIfNone(session, ctx, location);
      }
      return reload(ctx, location._id, session);
    });
  } catch (err) {
    mapLocationDuplicate(err, fields.locationCode);
  }
}

async function reload(ctx: ServiceContext, locationId: string, session: ClientSession) {
  const doc = await Location.findOne({ _id: locationId, tenantId: ctx.tenantId }).session(session).lean<LocationDoc>();
  if (!doc) throw AppError.notFound('Location not found.');
  return doc;
}

// ───────────────────────────────────────────────────────────── update (SCH-LOC-05)

export async function updateLocation(ctx: ServiceContext, locationId: string, patch: UpdateLocationData) {
  const { address, ...rest } = patch;
  const updates: Record<string, unknown> = pickDefined(rest);
  if (address !== undefined) updates.address = { ...EMPTY_ADDRESS, ...pickDefined(address) };

  try {
    return await withTransaction(async (session) => {
      const before = await getLocationOrThrow(ctx, locationId, session);
      if (before.status === 'ARCHIVED') throw new AppError('LOCATION_ARCHIVED');

      const merged = { ...before, ...updates } as LocationDoc;
      const changes = diffFields(before, merged, LOCATION_EDITABLE_FIELDS);
      if (changes.length === 0) return before;

      // Coordinates are a pair; check against stored values when only one side changes.
      const hasLat = merged.latitude !== null && merged.latitude !== undefined;
      const hasLng = merged.longitude !== null && merged.longitude !== undefined;
      if (hasLat !== hasLng) {
        throw AppError.validation({ [hasLat ? 'longitude' : 'latitude']: 'Enter both latitude and longitude, or leave both empty.' });
      }
      // Operational locations must stay complete (can't clear the phone of an active campus).
      if (before.status !== 'DRAFT') {
        const missing = missingActivationFields(merged);
        if (Object.keys(missing).length > 0) throw AppError.validation(missing);
      }

      const scope = { tenantId: ctx.tenantId, schoolId: before.schoolId };
      if (changes.some((c) => c.field === 'locationCode')) {
        await assertCodeChangeAllowed({ ...scope, locationId, session });
        await assertCodeAvailable(scope, merged.locationCode, { excludeLocationId: locationId, session });
      }

      const $set: Record<string, unknown> = { updatedBy: ctx.userId };
      for (const change of changes) {
        $set[change.field] = change.field.startsWith('address.')
          ? (merged.address as unknown as Record<string, unknown>)[change.field.slice('address.'.length)]
          : (merged as unknown as Record<string, unknown>)[change.field];
      }
      await Location.updateOne({ _id: locationId, tenantId: ctx.tenantId }, { $set }, { session });
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'school_location',
          entityId: locationId,
          action: 'location.updated',
          actor: actorFrom(ctx),
          changes,
          metadata: { schoolId: before.schoolId },
          requestId: ctx.requestId,
        },
        session,
      );
      return reload(ctx, locationId, session);
    });
  } catch (err) {
    mapLocationDuplicate(err, typeof updates.locationCode === 'string' ? updates.locationCode : undefined);
  }
}

// ───────────────────────────────────────────────────────────── lifecycle (SCH-LOC-06, SCH-LOC-11)

const ACTION_AUDIT: Record<LocationAction, string> = {
  activate: 'location.activated',
  deactivate: 'location.deactivated',
  archive: 'location.archived',
};

export async function changeLocationStatus(ctx: ServiceContext, locationId: string, action: LocationAction) {
  return withTransaction((session) => changeLocationStatusInSession(session, ctx, locationId, action));
}

/** The same operation inside the caller's transaction (setup completion activates the primary location with it). */
export async function changeLocationStatusInSession(session: ClientSession, ctx: ServiceContext, locationId: string, action: LocationAction) {
  {
    const current = await getLocationOrThrow(ctx, locationId, session);
    await lockSchoolLocations(session, ctx.tenantId, current.schoolId);
    // Re-read after taking the school lock so the checks below see the latest committed state.
    const before = await reload(ctx, locationId, session);

    // Rule 5 (checked before the state machine so the message tells the user what to do).
    if (before.isPrimary && (action === 'deactivate' || action === 'archive')) {
      throw new AppError(
        'PRIMARY_LOCATION_REQUIRED',
        action === 'archive'
          ? 'Set another active location as Primary before archiving this location.'
          : undefined,
      );
    }
    const to = assertTransition(before.status, action);

    if (action === 'activate') {
      const missing = missingActivationFields(before);
      if (Object.keys(missing).length > 0) throw new AppError('LOCATION_INCOMPLETE', undefined, { fields: missing });
    }
    if (action === 'archive') {
      const dependencies = await findActiveDependencies({
        tenantId: ctx.tenantId,
        schoolId: before.schoolId,
        locationId,
        session,
      });
      if (dependencies.length > 0) throw new AppError('LOCATION_HAS_DEPENDENCIES', undefined, { dependencies });
    }

    const now = new Date();
    await Location.updateOne(
      { _id: locationId, tenantId: ctx.tenantId, status: before.status },
      {
        $set: {
          status: to,
          statusChangedAt: now,
          statusChangedBy: ctx.userId,
          updatedBy: ctx.userId,
          ...(to === 'ARCHIVED' ? { archivedAt: now, archivedBy: ctx.userId } : {}),
        },
      },
      { session },
    );
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'school_location',
        entityId: locationId,
        action: ACTION_AUDIT[action],
        actor: actorFrom(ctx),
        changes: [{ field: 'status', from: before.status, to }],
        metadata: { schoolId: before.schoolId },
        requestId: ctx.requestId,
      },
      session,
    );

    const after = await reload(ctx, locationId, session);
    if (to === 'ACTIVE') await assignPrimaryIfNone(session, ctx, after); // Rule 1
    return reload(ctx, locationId, session);
  }
}

// ───────────────────────────────────────────────────────────── primary (SCH-LOC-07)

export async function setPrimaryLocation(ctx: ServiceContext, locationId: string) {
  return withTransaction(async (session) => {
    const current = await getLocationOrThrow(ctx, locationId, session);
    await lockSchoolLocations(session, ctx.tenantId, current.schoolId);
    const target = await reload(ctx, locationId, session);
    await switchPrimary(session, ctx, target);
    return reload(ctx, locationId, session);
  });
}

// ───────────────────────────────────────────────────────────── delete (unreferenced drafts only)

export async function deleteLocation(ctx: ServiceContext, locationId: string) {
  await withTransaction(async (session) => {
    const before = await getLocationOrThrow(ctx, locationId, session);
    const referenced =
      before.status === 'DRAFT' &&
      (await isLocationReferenced({ tenantId: ctx.tenantId, schoolId: before.schoolId, locationId, session }));
    if (before.status !== 'DRAFT' || referenced) {
      throw new AppError('USE_ARCHIVE_INSTEAD', undefined, { status: before.status, referenced });
    }
    await Location.deleteOne({ _id: locationId, tenantId: ctx.tenantId, status: 'DRAFT' }, { session });
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'school_location',
        entityId: locationId,
        action: 'location.deleted',
        actor: actorFrom(ctx),
        changes: diffFields(before, {}, ['displayName', 'locationCode', 'locationType', 'status']),
        metadata: { schoolId: before.schoolId, locationCode: before.locationCode, displayName: before.displayName },
        requestId: ctx.requestId,
      },
      session,
    );
  });
}
