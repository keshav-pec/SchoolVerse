import type { ClientSession } from 'mongoose';
import type { RoomRefDTO } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { loadLookups } from './mappers';
import { effectiveStatusOf, resolveSpace, type ResolvedSpace } from './resolve';
import { PhysicalSpace, SectionSpaceAssignment, SpaceAvailabilityBlock, type BuildingDoc, type FloorDoc, type PhysicalSpaceDoc, type SectionSpaceAssignmentDoc, type SpaceAvailabilityBlockDoc, type SpaceTypeDoc } from './space.models';
import { startOfDay, endOfDay } from './assignment.rules';

/** A room with everything needed to judge it: its type, floor and building, final values and whether it is open. */
export interface RoomFacts {
  space: PhysicalSpaceDoc;
  type: SpaceTypeDoc;
  floor: FloorDoc | null;
  building: BuildingDoc | null;
  resolved: ResolvedSpace;
  effective: ReturnType<typeof effectiveStatusOf>;
  path: string;
}

export async function loadRoomFactsFor(ctx: ServiceContext, docs: PhysicalSpaceDoc[], today: string, db?: ClientSession): Promise<Map<string, RoomFacts>> {
  void db;
  const lookups = await loadLookups(ctx, docs, today);
  const out = new Map<string, RoomFacts>();
  for (const space of docs) {
    const type = lookups.types.get(space.spaceTypeId);
    if (!type) continue;
    const floor = space.floorId ? (lookups.floors.get(space.floorId) ?? null) : null;
    const building = space.buildingId ? (lookups.buildings.get(space.buildingId) ?? null) : null;
    out.set(space._id, { space, type, floor, building, resolved: resolveSpace(space, type), effective: effectiveStatusOf(space, floor, building, today), path: [building?.buildingName, floor?.floorName, space.spaceName].filter(Boolean).join(' › ') });
  }
  return out;
}

export async function loadRoomFacts(ctx: ServiceContext, ids: string[], today: string, db?: ClientSession): Promise<Map<string, RoomFacts>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const docs = await PhysicalSpace.find({ tenantId: ctx.tenantId, _id: { $in: unique } }).session(db ?? null).lean<PhysicalSpaceDoc[]>();
  return loadRoomFactsFor(ctx, docs, today, db);
}

/** Every room at a campus that is not archived. */
export async function loadLocationRoomFacts(ctx: ServiceContext, locationId: string, today: string, db?: ClientSession): Promise<RoomFacts[]> {
  const docs = await PhysicalSpace.find({ tenantId: ctx.tenantId, locationId, operationalStatus: { $ne: 'ARCHIVED' } }).session(db ?? null).lean<PhysicalSpaceDoc[]>();
  return [...(await loadRoomFactsFor(ctx, docs, today, db)).values()];
}

export function toRoomRef(f: RoomFacts): RoomRefDTO {
  return {
    spaceId: f.space._id,
    spaceCode: f.space.spaceCode,
    spaceName: f.space.spaceName,
    path: f.path,
    academicCapacity: f.resolved.academicCapacity.value,
    physicalCapacity: f.space.physicalCapacity ?? null,
    effectiveStatus: f.effective,
    homeClassroomEligible: f.resolved.homeClassroomEligible.value,
  };
}

/**
 * Can this room be somebody's Home Classroom until `until`? It must be open (active, floor and building active), allowed to be a Home
 * Classroom, indoors, and not due to be archived before the period ends. Returns the reason in plain words when it cannot.
 */
export function homeClassroomBlocker(f: RoomFacts, until: string): { code: 'ROOM_NOT_ACTIVE' | 'ROOM_PARENT_INACTIVE' | 'ROOM_NOT_ELIGIBLE' | 'ROOM_ARCHIVING'; message: string } | null {
  if (!f.effective.available) {
    const parent = f.space.operationalStatus === 'ACTIVE' && f.effective.status === 'ACTIVE';
    return { code: parent ? 'ROOM_PARENT_INACTIVE' : 'ROOM_NOT_ACTIVE', message: f.effective.reason ?? 'This room is not open.' };
  }
  if (f.type.isOutdoor || !f.resolved.homeClassroomEligible.value) return { code: 'ROOM_NOT_ELIGIBLE', message: `${f.space.spaceName} is a ${f.type.name}, which cannot be a Home Classroom.` };
  if (f.space.archiveAfterDate && until >= f.space.archiveAfterDate) return { code: 'ROOM_ARCHIVING', message: `${f.space.spaceName} is due to be archived on ${f.space.archiveAfterDate}, before these dates end.` };
  return null;
}

/** Assignments (not cancelled) that overlap a period at one campus, grouped by room. Used to see which rooms are taken. */
export async function assignmentsInPeriod(ctx: ServiceContext, input: { locationId: string; sessionId: string; from: string; to: string | null }, db?: ClientSession): Promise<SectionSpaceAssignmentDoc[]> {
  return SectionSpaceAssignment.find({
    tenantId: ctx.tenantId,
    academicSessionId: input.sessionId,
    locationId: input.locationId,
    status: { $ne: 'CANCELLED' },
    ...(input.to ? { effectiveFrom: { $lte: input.to } } : {}),
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: input.from } }],
  })
    .session(db ?? null)
    .lean<SectionSpaceAssignmentDoc[]>();
}

/** Active closures that touch `[from, to]` (dates), keyed by room. */
export async function blocksInPeriod(ctx: ServiceContext, roomIds: string[], from: string, to: string, db?: ClientSession): Promise<Map<string, SpaceAvailabilityBlockDoc[]>> {
  const out = new Map<string, SpaceAvailabilityBlockDoc[]>();
  if (roomIds.length === 0) return out;
  const blocks = await SpaceAvailabilityBlock.find({ tenantId: ctx.tenantId, physicalSpaceId: { $in: roomIds }, status: 'ACTIVE', startDatetime: { $lte: endOfDay(to) }, endDatetime: { $gte: startOfDay(from) } })
    .session(db ?? null)
    .lean<SpaceAvailabilityBlockDoc[]>();
  for (const b of blocks) out.set(b.physicalSpaceId, [...(out.get(b.physicalSpaceId) ?? []), b]);
  return out;
}

export const naturalCompare = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
