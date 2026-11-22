import {
  floorFromName,
  type BuildingDTO,
  type BulkFloorsData,
  type CreateBuildingData,
  type CreateFloorData,
  type FloorDTO,
  type FloorsCreatedDTO,
  type SpaceDependencyDTO,
  type SpaceTreeDTO,
  type SpaceTreeQuery,
  type StructureStatus,
  type UpdateBuildingData,
  type UpdateFloorData,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { recordSpaceAudit, emitSpaceEvent } from './audit';
import { buildingCodeFrom, floorCodeFrom } from './codes';
import { assertInScope, assertLocationWritable, assertStructureWritable, assertVersion, loadBuilding, loadFloor, loadLocation, requireSchool, spaceScope, type SpaceScope } from './guards';
import { assertStructureTransition } from './lifecycle';
import { toBuildingDTO, toFloorDTO } from './mappers';
import { isNeverSchedulable } from './resolve';
import { Building, Floor, PhysicalSpace, SpaceType, type BuildingDoc, type FloorDoc, type PhysicalSpaceDoc, type SpaceTypeDoc } from './space.models';

/** SPACE-03 to SPACE-07 — buildings and floors. Floors come back ordered by `floorNumber`. Nothing used in the past is deleted. */

const BUILDING_AUDITED = ['buildingName', 'buildingType', 'effectiveFrom', 'effectiveTo', 'displayOrder', 'status'] as const;
const FLOOR_AUDITED = ['floorName', 'floorNumber', 'levelType', 'effectiveFrom', 'effectiveTo', 'status'] as const;

const liveRooms = { operationalStatus: { $ne: 'ARCHIVED' } } as const;

async function roomCountsBy(ctx: ServiceContext, field: 'buildingId' | 'floorId', ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await PhysicalSpace.aggregate<{ _id: string; n: number }>([{ $match: { tenantId: ctx.tenantId, [field]: { $in: ids }, ...liveRooms } }, { $group: { _id: `$${field}`, n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

async function floorCountsByBuilding(ctx: ServiceContext, ids: string[]): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map();
  const rows = await Floor.aggregate<{ _id: string; n: number }>([{ $match: { tenantId: ctx.tenantId, buildingId: { $in: ids }, status: { $ne: 'ARCHIVED' } } }, { $group: { _id: '$buildingId', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

async function buildingDTOs(ctx: ServiceContext, docs: BuildingDoc[]): Promise<BuildingDTO[]> {
  const ids = docs.map((d) => d._id);
  const [floors, rooms] = await Promise.all([floorCountsByBuilding(ctx, ids), roomCountsBy(ctx, 'buildingId', ids)]);
  return docs.map((d) => toBuildingDTO(d, { floors: floors.get(d._id) ?? 0, rooms: rooms.get(d._id) ?? 0 }));
}

async function floorDTOs(ctx: ServiceContext, docs: FloorDoc[], building?: BuildingDoc): Promise<FloorDTO[]> {
  const rooms = await roomCountsBy(ctx, 'floorId', docs.map((d) => d._id));
  const buildings = building ? new Map([[building._id, building]]) : new Map((await Building.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(docs.map((d) => d.buildingId))] } }).lean<BuildingDoc[]>()).map((b) => [b._id, b]));
  return docs.map((d) => toFloorDTO(d, rooms.get(d._id) ?? 0, buildings.get(d.buildingId) ?? null));
}

// ───────────────────────────────────────────────────────────── buildings

export async function createBuilding(ctx: ServiceContext, locationId: string, data: CreateBuildingData): Promise<BuildingDTO> {
  const [school, location, scope] = await Promise.all([requireSchool(ctx), loadLocation(ctx, locationId), spaceScope(ctx)]);
  await assertInScope(ctx, scope, locationId, 'location', locationId);
  assertLocationWritable(location);
  const taken = new Set((await Building.find({ tenantId: ctx.tenantId, locationId }).select('buildingCode').lean<{ buildingCode: string }[]>()).map((b) => b.buildingCode));
  if (data.buildingCode && taken.has(data.buildingCode)) throw new AppError('BUILDING_CODE_TAKEN');
  const code = data.buildingCode ?? buildingCodeFrom(data.buildingName, taken);
  const id = await withTransaction(async (db) => {
    const [doc] = await Building.create(
      [{ tenantId: ctx.tenantId, schoolId: school._id, locationId, buildingCode: code, buildingName: data.buildingName, buildingType: data.buildingType, status: data.status, effectiveFrom: data.effectiveFrom ?? null, effectiveTo: data.effectiveTo ?? null, displayOrder: data.displayOrder ?? taken.size, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    await recordSpaceAudit(ctx, db, { entityType: 'building', entityId: doc!._id, action: 'building.created', locationId, metadata: { buildingCode: code } });
    await emitSpaceEvent(db, ctx.tenantId, 'building.created', { buildingId: doc!._id, locationId });
    return doc!._id;
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('buildingCode')) throw new AppError('BUILDING_CODE_TAKEN');
    throw err;
  });
  return getBuilding(ctx, id);
}

export async function listBuildings(ctx: ServiceContext, locationId: string): Promise<BuildingDTO[]> {
  const [scope] = await Promise.all([spaceScope(ctx), loadLocation(ctx, locationId)]);
  await assertInScope(ctx, scope, locationId, 'location', locationId);
  const docs = await Building.find({ tenantId: ctx.tenantId, locationId }).sort({ displayOrder: 1, buildingName: 1 }).lean<BuildingDoc[]>();
  return buildingDTOs(ctx, docs);
}

export async function getBuilding(ctx: ServiceContext, id: string): Promise<BuildingDTO> {
  const doc = await loadBuilding(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), doc.locationId, 'building', id);
  return (await buildingDTOs(ctx, [doc]))[0]!;
}

export async function updateBuilding(ctx: ServiceContext, id: string, data: UpdateBuildingData): Promise<BuildingDTO> {
  const before = await loadBuilding(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), before.locationId, 'building', id);
  assertStructureWritable(before);
  assertVersion(before.version, data.version);
  const { version: _version, ...rest } = data;
  const patch = pickDefined(rest);
  await withTransaction(async (db) => {
    const changes = diffFields(before, { ...before, ...patch }, BUILDING_AUDITED);
    if (changes.length === 0) return;
    const updated = await Building.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, version: data.version }, { $set: { ...patch, updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    await recordSpaceAudit(ctx, db, { entityType: 'building', entityId: id, action: 'building.updated', changes, locationId: before.locationId });
  });
  return getBuilding(ctx, id);
}

/** Why a building or floor cannot be archived or deleted, in words. */
function structureBlocked(what: string, items: SpaceDependencyDTO[]): AppError {
  const text = items.map((i) => i.label).join(' ');
  return new AppError('HAS_DEPENDENCIES', `${what} cannot be changed yet. ${text}`, { dependencies: items });
}

export async function changeBuildingStatus(ctx: ServiceContext, id: string, to: StructureStatus): Promise<BuildingDTO> {
  const before = await loadBuilding(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), before.locationId, 'building', id);
  assertStructureTransition('building', before.status, to);
  await withTransaction(async (db) => {
    if (to === 'ARCHIVED') {
      const rooms = await PhysicalSpace.countDocuments({ tenantId: ctx.tenantId, buildingId: id, ...liveRooms }).session(db);
      if (rooms > 0) throw structureBlocked('This building', [{ kind: 'ROOMS', label: `${rooms} room${rooms === 1 ? ' is' : 's are'} still in it. Archive or move them first.`, count: rooms }]);
      // Empty floors go with their building, so an empty building is one click.
      const floors = await Floor.find({ tenantId: ctx.tenantId, buildingId: id, status: { $ne: 'ARCHIVED' } }).session(db).lean<FloorDoc[]>();
      for (const f of floors) {
        await Floor.updateOne({ _id: f._id, tenantId: ctx.tenantId }, { $set: { status: 'ARCHIVED', archivedAt: new Date(), archivedBy: ctx.userId, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
        await recordSpaceAudit(ctx, db, { entityType: 'floor', entityId: f._id, action: 'floor.archived', changes: [{ field: 'status', from: f.status, to: 'ARCHIVED' }], locationId: before.locationId, metadata: { because: 'building archived' } });
      }
    }
    await Building.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { status: to, updatedBy: ctx.userId, ...(to === 'ARCHIVED' ? { archivedAt: new Date(), archivedBy: ctx.userId } : {}) }, $inc: { version: 1 } }, { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'building', entityId: id, action: `building.${to.toLowerCase()}`, changes: [{ field: 'status', from: before.status, to }], locationId: before.locationId });
    await emitSpaceEvent(db, ctx.tenantId, 'building.status.changed', { buildingId: id, locationId: before.locationId, from: before.status, to });
  });
  return getBuilding(ctx, id);
}

/** Hard delete only when the building is a draft, has no floors and was never used. Otherwise it is archived. */
export async function deleteBuilding(ctx: ServiceContext, id: string): Promise<void> {
  const doc = await loadBuilding(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), doc.locationId, 'building', id);
  await withTransaction(async (db) => {
    const floors = await Floor.countDocuments({ tenantId: ctx.tenantId, buildingId: id }).session(db);
    const rooms = await PhysicalSpace.countDocuments({ tenantId: ctx.tenantId, buildingId: id }).session(db);
    const items: SpaceDependencyDTO[] = [];
    if (doc.status !== 'DRAFT') items.push({ kind: 'ROOMS', label: 'Only a draft building can be deleted. Archive this one instead.' });
    if (floors > 0) items.push({ kind: 'ROOMS', label: `It has ${floors} floor${floors === 1 ? '' : 's'}.`, count: floors });
    if (rooms > 0) items.push({ kind: 'ROOMS', label: `It has ${rooms} room${rooms === 1 ? '' : 's'}, some of them in the past.`, count: rooms });
    if (items.length > 0) throw structureBlocked('This building', items);
    await Building.deleteOne({ _id: id, tenantId: ctx.tenantId }, { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'building', entityId: id, action: 'building.deleted', locationId: doc.locationId, metadata: { buildingCode: doc.buildingCode } });
  });
}

// ───────────────────────────────────────────────────────────── floors

async function writableBuilding(ctx: ServiceContext, buildingId: string, scope: SpaceScope) {
  const building = await loadBuilding(ctx, buildingId);
  await assertInScope(ctx, scope, building.locationId, 'building', buildingId);
  assertStructureWritable(building);
  assertLocationWritable(await loadLocation(ctx, building.locationId));
  return building;
}

type NewFloor = { name: string; code: string | null; floorNumber: number; levelType: FloorDoc['levelType']; status: 'DRAFT' | 'ACTIVE'; effectiveFrom?: string | null; effectiveTo?: string | null };

async function insertFloors(ctx: ServiceContext, building: BuildingDoc, floors: NewFloor[]): Promise<FloorDoc[]> {
  return withTransaction(async (db) => {
    const taken = new Set((await Floor.find({ tenantId: ctx.tenantId, buildingId: building._id }).session(db).select('floorCode').lean<{ floorCode: string }[]>()).map((f) => f.floorCode));
    const rows: Record<string, unknown>[] = [];
    for (const f of floors) {
      if (f.code && taken.has(f.code)) throw new AppError('FLOOR_CODE_TAKEN');
      const code = f.code ?? floorCodeFrom(f.floorNumber, taken);
      taken.add(code);
      rows.push({ tenantId: ctx.tenantId, schoolId: building.schoolId, locationId: building.locationId, buildingId: building._id, floorCode: code, floorName: f.name, floorNumber: f.floorNumber, levelType: f.levelType, status: f.status, effectiveFrom: f.effectiveFrom ?? null, effectiveTo: f.effectiveTo ?? null, createdBy: ctx.userId, updatedBy: ctx.userId });
    }
    const created = (await Floor.create(rows, { session: db, ordered: true })) as unknown as { toObject(): FloorDoc }[];
    const docs = created.map((c) => c.toObject());
    for (const d of docs) {
      await recordSpaceAudit(ctx, db, { entityType: 'floor', entityId: d._id, action: 'floor.created', locationId: building.locationId, metadata: { floorCode: d.floorCode, buildingId: building._id } });
      await emitSpaceEvent(db, ctx.tenantId, 'floor.created', { floorId: d._id, buildingId: building._id, locationId: building.locationId });
    }
    return docs;
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('floorCode')) throw new AppError('FLOOR_CODE_TAKEN');
    throw err;
  });
}

const levelFor = (n: number): FloorDoc['levelType'] => (n < 0 ? 'BASEMENT' : n === 0 ? 'GROUND' : 'UPPER');

export async function createFloor(ctx: ServiceContext, buildingId: string, data: CreateFloorData): Promise<FloorDTO> {
  const building = await writableBuilding(ctx, buildingId, await spaceScope(ctx));
  const [doc] = await insertFloors(ctx, building, [{ name: data.floorName, code: data.floorCode ?? null, floorNumber: data.floorNumber, levelType: data.levelType ?? levelFor(data.floorNumber), status: data.status, effectiveFrom: data.effectiveFrom, effectiveTo: data.effectiveTo }]);
  return (await floorDTOs(ctx, [doc!], building))[0]!;
}

/** "Ground, First, Second" in one go: the number and kind are read from the name when not given. */
export async function createFloorsBulk(ctx: ServiceContext, buildingId: string, data: BulkFloorsData): Promise<FloorsCreatedDTO> {
  const building = await writableBuilding(ctx, buildingId, await spaceScope(ctx));
  const rows = data.floors.map((f, i): NewFloor => {
    const guess = floorFromName(f.name, i);
    const floorNumber = f.floorNumber ?? guess.floorNumber;
    return { name: f.name, code: null, floorNumber, levelType: f.levelType ?? (f.floorNumber === undefined ? guess.levelType : levelFor(floorNumber)), status: 'ACTIVE' };
  });
  const docs = await insertFloors(ctx, building, rows);
  return { floors: await floorDTOs(ctx, docs.sort((a, b) => a.floorNumber - b.floorNumber), building) };
}

export async function listFloors(ctx: ServiceContext, buildingId: string): Promise<FloorDTO[]> {
  const building = await loadBuilding(ctx, buildingId);
  await assertInScope(ctx, await spaceScope(ctx), building.locationId, 'building', buildingId);
  const docs = await Floor.find({ tenantId: ctx.tenantId, buildingId }).sort({ floorNumber: 1, floorName: 1 }).lean<FloorDoc[]>();
  return floorDTOs(ctx, docs, building);
}

export async function getFloor(ctx: ServiceContext, id: string): Promise<FloorDTO> {
  const doc = await loadFloor(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), doc.locationId, 'floor', id);
  return (await floorDTOs(ctx, [doc]))[0]!;
}

export async function updateFloor(ctx: ServiceContext, id: string, data: UpdateFloorData): Promise<FloorDTO> {
  const before = await loadFloor(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), before.locationId, 'floor', id);
  assertStructureWritable(before);
  assertVersion(before.version, data.version);
  const { version: _version, ...rest } = data;
  const patch = pickDefined(rest);
  await withTransaction(async (db) => {
    const changes = diffFields(before, { ...before, ...patch }, FLOOR_AUDITED);
    if (changes.length === 0) return;
    const updated = await Floor.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, version: data.version }, { $set: { ...patch, updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    await recordSpaceAudit(ctx, db, { entityType: 'floor', entityId: id, action: 'floor.updated', changes, locationId: before.locationId });
  });
  return getFloor(ctx, id);
}

export async function changeFloorStatus(ctx: ServiceContext, id: string, to: StructureStatus): Promise<FloorDTO> {
  const before = await loadFloor(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), before.locationId, 'floor', id);
  assertStructureTransition('floor', before.status, to);
  await withTransaction(async (db) => {
    if (to === 'ARCHIVED') {
      const rooms = await PhysicalSpace.countDocuments({ tenantId: ctx.tenantId, floorId: id, ...liveRooms }).session(db);
      if (rooms > 0) throw structureBlocked('This floor', [{ kind: 'ROOMS', label: `${rooms} room${rooms === 1 ? ' is' : 's are'} still on it. Archive or move them first.`, count: rooms }]);
    }
    await Floor.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { status: to, updatedBy: ctx.userId, ...(to === 'ARCHIVED' ? { archivedAt: new Date(), archivedBy: ctx.userId } : {}) }, $inc: { version: 1 } }, { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'floor', entityId: id, action: `floor.${to.toLowerCase()}`, changes: [{ field: 'status', from: before.status, to }], locationId: before.locationId });
    await emitSpaceEvent(db, ctx.tenantId, 'floor.status.changed', { floorId: id, buildingId: before.buildingId, locationId: before.locationId, from: before.status, to });
  });
  return getFloor(ctx, id);
}

export async function deleteFloor(ctx: ServiceContext, id: string): Promise<void> {
  const doc = await loadFloor(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), doc.locationId, 'floor', id);
  await withTransaction(async (db) => {
    const rooms = await PhysicalSpace.countDocuments({ tenantId: ctx.tenantId, floorId: id }).session(db);
    const items: SpaceDependencyDTO[] = [];
    if (doc.status !== 'DRAFT') items.push({ kind: 'ROOMS', label: 'Only a draft floor can be deleted. Archive this one instead.' });
    if (rooms > 0) items.push({ kind: 'ROOMS', label: `It has ${rooms} room${rooms === 1 ? '' : 's'}, some of them in the past.`, count: rooms });
    if (items.length > 0) throw structureBlocked('This floor', items);
    await Floor.deleteOne({ _id: id, tenantId: ctx.tenantId }, { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'floor', entityId: id, action: 'floor.deleted', locationId: doc.locationId, metadata: { floorCode: doc.floorCode } });
  });
}

// ───────────────────────────────────────────────────────────── the workspace tree

/** Location → Building → Floor with a room count on each node, and the numbers for the KPI strip. Outdoor spaces are counted on their own. */
export async function spaceTree(ctx: ServiceContext, locationId: string, query: SpaceTreeQuery): Promise<SpaceTreeDTO> {
  const [location, scope] = await Promise.all([loadLocation(ctx, locationId), spaceScope(ctx)]);
  await assertInScope(ctx, scope, locationId, 'location', locationId);
  const archived = query.includeArchived ? {} : { status: { $ne: 'ARCHIVED' as const } };
  const [buildings, floors, spaces, types] = await Promise.all([
    Building.find({ tenantId: ctx.tenantId, locationId, ...archived }).sort({ displayOrder: 1, buildingName: 1 }).lean<BuildingDoc[]>(),
    Floor.find({ tenantId: ctx.tenantId, locationId, ...archived }).sort({ floorNumber: 1 }).lean<FloorDoc[]>(),
    PhysicalSpace.find({ tenantId: ctx.tenantId, locationId, ...liveRooms }).select('buildingId floorId spaceTypeId schedulableOverride').lean<Pick<PhysicalSpaceDoc, 'buildingId' | 'floorId' | 'spaceTypeId' | 'schedulableOverride'>[]>(),
    SpaceType.find({ tenantId: ctx.tenantId }).lean<SpaceTypeDoc[]>(),
  ]);
  const typeOf = new Map(types.map((t) => [t._id, t]));
  const byBuilding = new Map<string, number>();
  const byFloor = new Map<string, number>();
  let outdoor = 0;
  let schedulable = 0;
  for (const s of spaces) {
    const t = typeOf.get(s.spaceTypeId);
    if (t && !isNeverSchedulable(t) && (s.schedulableOverride ?? t.isSchedulable)) schedulable += 1;
    if (!s.buildingId) outdoor += 1;
    else byBuilding.set(s.buildingId, (byBuilding.get(s.buildingId) ?? 0) + 1);
    if (s.floorId) byFloor.set(s.floorId, (byFloor.get(s.floorId) ?? 0) + 1);
  }
  const buildingStatus = new Map(buildings.map((b) => [b._id, b]));
  return {
    locationId,
    locationName: location.displayName,
    buildings: buildings.map((b) => ({
      buildingId: b._id,
      buildingCode: b.buildingCode,
      buildingName: b.buildingName,
      buildingType: b.buildingType,
      status: b.status,
      roomCount: byBuilding.get(b._id) ?? 0,
      floors: floors
        .filter((f) => f.buildingId === b._id)
        .map((f) => ({ floorId: f._id, floorCode: f.floorCode, floorName: f.floorName, floorNumber: f.floorNumber, status: f.status, roomCount: byFloor.get(f._id) ?? 0, unavailableBecause: toFloorDTO(f, 0, buildingStatus.get(b._id) ?? null).unavailableBecause })),
    })),
    outdoorCount: outdoor,
    totals: { buildings: buildings.filter((b) => b.status !== 'ARCHIVED').length, floors: floors.filter((f) => f.status !== 'ARCHIVED').length, rooms: spaces.length, schedulableRooms: schedulable },
  };
}
