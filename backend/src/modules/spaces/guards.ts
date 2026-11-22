import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import { recordSecurityEvent } from '../../platform/identity/security-events';
import { can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { Location, type LocationDoc } from '../locations/location.model';
import { getCurrentSchool } from '../school/school.service';
import type { SchoolDoc } from '../school/school.model';
import { currentLocationIds, findCallerEmployee } from '../staff/access';
import { todayFor } from '../staff/status';
import { Building, Floor, PhysicalSpace, SpaceType, type BuildingDoc, type FloorDoc, type PhysicalSpaceDoc, type SpaceTypeDoc } from './space.models';

/** Loaders that answer 404 for another tenant's id exactly as for a missing one, plus the location scope and version rules. */

export async function requireSchool(ctx: ServiceContext): Promise<SchoolDoc> {
  const school = await getCurrentSchool(ctx);
  if (!school) throw AppError.notFound('Set up the school profile before building the campus.');
  return school;
}

export async function loadLocation(ctx: ServiceContext, locationId: string, db?: ClientSession): Promise<LocationDoc> {
  const doc = await Location.findOne({ _id: locationId, tenantId: ctx.tenantId }).session(db ?? null).lean<LocationDoc>();
  if (!doc) throw AppError.notFound('Location not found.');
  return doc;
}

/** New buildings and rooms go into a location that is being set up or in use, not one that was closed. */
export function assertLocationWritable(location: Pick<LocationDoc, 'status'>) {
  if (location.status === 'ARCHIVED' || location.status === 'INACTIVE') throw new AppError('LOCATION_NOT_ACTIVE');
}

export async function loadBuilding(ctx: ServiceContext, id: string, db?: ClientSession): Promise<BuildingDoc> {
  const doc = await Building.findOne({ _id: id, tenantId: ctx.tenantId }).session(db ?? null).lean<BuildingDoc>();
  if (!doc) throw AppError.notFound('Building not found.');
  return doc;
}

export async function loadFloor(ctx: ServiceContext, id: string, db?: ClientSession): Promise<FloorDoc> {
  const doc = await Floor.findOne({ _id: id, tenantId: ctx.tenantId }).session(db ?? null).lean<FloorDoc>();
  if (!doc) throw AppError.notFound('Floor not found.');
  return doc;
}

export async function loadSpace(ctx: ServiceContext, id: string, db?: ClientSession): Promise<PhysicalSpaceDoc> {
  const doc = await PhysicalSpace.findOne({ _id: id, tenantId: ctx.tenantId }).session(db ?? null).lean<PhysicalSpaceDoc>();
  if (!doc) throw AppError.notFound('Room not found.');
  return doc;
}

export async function loadSpaceType(ctx: ServiceContext, id: string, db?: ClientSession): Promise<SpaceTypeDoc> {
  const doc = await SpaceType.findOne({ _id: id, tenantId: ctx.tenantId }).session(db ?? null).lean<SpaceTypeDoc>();
  if (!doc) throw AppError.notFound('Room type not found.');
  return doc;
}

/** Editable rows carry a `version`; a PATCH that was built from an older copy is refused. */
export function assertVersion(current: number, sent: number) {
  if (current !== sent) throw new AppError('VERSION_CONFLICT', undefined, { currentVersion: current });
}

export function assertStructureWritable(row: { status: string }) {
  if (row.status === 'ARCHIVED') throw new AppError('STRUCTURE_ARCHIVED');
}

export function assertSpaceWritable(row: Pick<PhysicalSpaceDoc, 'operationalStatus'>) {
  if (row.operationalStatus === 'ARCHIVED') throw new AppError('SPACE_ARCHIVED');
}

// ───────────────────────────────────────────────────────────── location scope (SPACE-76)

/**
 * School Admin (anyone who can edit rooms) reaches every location. Faculty reach only the locations where they have an assignment
 * running today, and only rooms that can be scheduled. A location outside that is refused (403) and written as `CROSS_SCOPE_DENIED`.
 */
export interface SpaceScope {
  all: boolean;
  locationIds: string[];
}

export async function spaceScope(ctx: ServiceContext): Promise<SpaceScope> {
  if (can(ctx, 'space:edit') || can(ctx, 'space:create')) return { all: true, locationIds: [] };
  const employee = await findCallerEmployee(ctx);
  if (!employee) return { all: false, locationIds: [] };
  return { all: false, locationIds: await currentLocationIds(ctx.tenantId, employee._id, await todayFor(ctx)) };
}

export function inScope(scope: SpaceScope, locationId: string): boolean {
  return scope.all || scope.locationIds.includes(locationId);
}

export async function assertInScope(ctx: ServiceContext, scope: SpaceScope, locationId: string, resource: 'location' | 'building' | 'floor' | 'space', targetId: string) {
  if (inScope(scope, locationId)) return;
  await recordSecurityEvent({ tenantId: ctx.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: ctx.userId, targetId, ip: ctx.ip ?? null, outcome: 'DENIED', metadata: { resource, locationId } });
  throw new AppError('FORBIDDEN', "You don't have access to this campus.");
}
