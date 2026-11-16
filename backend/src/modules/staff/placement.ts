import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AcademicAssignment, LocationAssignment, Responsibility } from './assignment.models';
import { overlapping } from './status';

/**
 * Rules that tie class and responsibility assignments to where the employee is actually placed.
 */

/**
 * The employee must have ONE location assignment at `locationId` that covers the whole range
 * (`to = null` means open-ended, so the placement must be open-ended too). `LOCATION_NOT_ASSIGNED` otherwise.
 */
export async function assertLocationCoverage(
  ctx: ServiceContext,
  employeeId: string,
  locationId: string,
  from: string,
  to: string | null,
  db: ClientSession,
) {
  const covering = await LocationAssignment.exists({
    tenantId: ctx.tenantId,
    employeeId,
    locationId,
    cancelledAt: null,
    effectiveFrom: { $lte: from },
    ...(to ? { $or: [{ effectiveTo: null }, { effectiveTo: { $gte: to } }] } : { effectiveTo: null }),
  }).session(db);
  if (!covering) throw new AppError('LOCATION_NOT_ASSIGNED', undefined, { locationId, effectiveFrom: from, effectiveTo: to });
}

/**
 * Classes and responsibilities that need a placement at `locationId` beyond `lastDay`. Ending or moving the placement
 * while any exist would leave them without cover, so the caller refuses (`LOCATION_ASSIGNMENT_IN_USE`).
 */
export async function countDependents(ctx: ServiceContext, employeeId: string, locationId: string, lastDay: string | null, db: ClientSession): Promise<number> {
  const filter = {
    tenantId: ctx.tenantId,
    employeeId,
    locationId,
    cancelledAt: null,
    ...(lastDay ? { $or: [{ effectiveTo: null }, { effectiveTo: { $gt: lastDay } }] } : {}),
  };
  const [academic, responsibilities] = await Promise.all([
    AcademicAssignment.countDocuments(filter).session(db),
    Responsibility.countDocuments(filter).session(db),
  ]);
  return academic + responsibilities;
}

export async function assertNoDependents(ctx: ServiceContext, employeeId: string, locationId: string, lastDay: string | null, db: ClientSession) {
  const count = await countDependents(ctx, employeeId, locationId, lastDay, db);
  if (count > 0) throw new AppError('LOCATION_ASSIGNMENT_IN_USE', undefined, { locationId, count });
}

/** Two primary placements may never overlap, whatever their location (`PRIMARY_LOCATION_OVERLAP`). */
export async function assertNoPrimaryOverlap(ctx: ServiceContext, employeeId: string, from: string, to: string | null, excludeId: string | null, db: ClientSession) {
  const clash = await LocationAssignment.exists({
    tenantId: ctx.tenantId,
    employeeId,
    isPrimary: true,
    cancelledAt: null,
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    ...overlapping(from, to),
  }).session(db);
  if (clash) throw new AppError('PRIMARY_LOCATION_OVERLAP');
}
