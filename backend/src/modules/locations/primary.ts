import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import { actorFrom, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { School } from '../school/school.model';
import { Location, type LocationDoc } from './location.model';

/**
 * SCH-LOC-02 / SCH-LOC-07 — Primary Location rules (PRD §10):
 *   1. The first active location automatically becomes Primary.
 *   2. Only one active location can have isPrimary = true (also a partial unique index).
 *   3. Selecting a new Primary removes it from the previous one in the same transaction.
 *   4. An archived location can never be Primary.
 *   5. A Primary location cannot be deactivated until another active location is Primary.
 *
 * Every function here must run inside a transaction that first called `lockSchoolLocations`.
 */

/**
 * Serialises primary-affecting transactions per school: they all write the same school document,
 * so concurrent ones hit a write conflict and the driver retries them one after another.
 */
export async function lockSchoolLocations(session: ClientSession, tenantId: string, schoolId: string) {
  const res = await School.updateOne(
    { _id: schoolId, tenantId },
    { $inc: { locationsVersion: 1 } },
    { session, timestamps: false },
  );
  if (res.matchedCount === 0) throw AppError.notFound('School not found.');
}

export async function findPrimary(session: ClientSession, tenantId: string, schoolId: string) {
  return Location.findOne({ tenantId, schoolId, isPrimary: true }).session(session).lean<LocationDoc>();
}

async function markPrimary(
  session: ClientSession,
  ctx: ServiceContext,
  location: Pick<LocationDoc, '_id' | 'schoolId' | 'displayName' | 'locationCode'>,
  previous: Pick<LocationDoc, '_id' | 'displayName' | 'locationCode'> | null,
  reason: 'FIRST_ACTIVE_LOCATION' | 'SET_BY_USER',
) {
  if (previous) {
    // Unset first: the partial unique index never sees two primaries, even inside the transaction.
    await Location.updateOne(
      { _id: previous._id, tenantId: ctx.tenantId, isPrimary: true },
      { $set: { isPrimary: false, updatedBy: ctx.userId } },
      { session },
    );
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'school_location',
        entityId: previous._id,
        action: 'location.primary_unset',
        actor: actorFrom(ctx),
        changes: [{ field: 'isPrimary', from: true, to: false }],
        metadata: {
          schoolId: location.schoolId,
          newPrimaryLocationId: location._id,
          newPrimaryName: location.displayName,
          newPrimaryCode: location.locationCode,
        },
        requestId: ctx.requestId,
      },
      session,
    );
  }

  await Location.updateOne(
    { _id: location._id, tenantId: ctx.tenantId, status: 'ACTIVE' },
    { $set: { isPrimary: true, updatedBy: ctx.userId } },
    { session },
  );
  await recordAudit(
    {
      tenantId: ctx.tenantId,
      entityType: 'school_location',
      entityId: location._id,
      action: 'location.primary_set',
      actor: actorFrom(ctx),
      changes: [{ field: 'isPrimary', from: false, to: true }],
      metadata: {
        schoolId: location.schoolId,
        reason,
        previousPrimaryLocationId: previous?._id ?? null,
        previousPrimaryName: previous?.displayName ?? null,
        previousPrimaryCode: previous?.locationCode ?? null,
      },
      requestId: ctx.requestId,
    },
    session,
  );
}

/** Rule 1: call after a location becomes ACTIVE. Returns true when it was made Primary. */
export async function assignPrimaryIfNone(session: ClientSession, ctx: ServiceContext, location: LocationDoc) {
  const current = await findPrimary(session, ctx.tenantId, location.schoolId);
  if (current) return false;
  await markPrimary(session, ctx, location, null, 'FIRST_ACTIVE_LOCATION');
  return true;
}

/** Rules 3 + 4: atomically move Primary to an ACTIVE location. No-op when it already is Primary. */
export async function switchPrimary(session: ClientSession, ctx: ServiceContext, target: LocationDoc) {
  if (target.status !== 'ACTIVE') {
    throw new AppError(
      'PRIMARY_REQUIRES_ACTIVE',
      target.status === 'ARCHIVED'
        ? 'An archived location can never be the Primary Location.'
        : 'Activate this location before making it the Primary Location.',
      { status: target.status },
    );
  }
  if (target.isPrimary) return { changed: false, previous: null };
  const previous = await findPrimary(session, ctx.tenantId, target.schoolId);
  await markPrimary(session, ctx, target, previous, 'SET_BY_USER');
  return { changed: true, previous };
}
