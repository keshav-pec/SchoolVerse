import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { CopyPreviewDTO, CopyResultDTO, CopyStructureData, DuplicateFloorData, GeneratePreviewDTO, GenerateResultDTO, GenerateSpacesData, GeneratedSpaceRowDTO } from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { todayFor } from '../staff/status';
import { emitSpaceEvent, recordSpaceAudit } from './audit';
import { shiftTrailingNumber } from './codes';
import { assertInScope, assertLocationWritable, assertStructureWritable, loadFloor, loadLocation, loadSpaceType, requireSchool, spaceScope } from './guards';
import { toSpaceDTOs } from './mappers';
import { Building, Floor, PhysicalSpace, type BuildingDoc, type FloorDoc, type PhysicalSpaceDoc, type SpaceTypeDoc } from './space.models';
import { ensureSystemTypes } from './type.service';
import { insertSpaces, type SpaceInsert } from './space.service';

/** SPACE-21 to 25 — room generator, duplicate floor and copy campus. Each has a preview that writes nothing and a commit that is safe to retry. */

interface Candidate {
  spaceCode: string;
  spaceName: string;
  roomNumber: string | null;
  insert: Omit<SpaceInsert, 'locationId' | 'buildingId' | 'floorId'>;
}

const slug = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20);

/** Marks each candidate as new, already there (a retry), or clashing. A room is "already there" only when the same code, name and floor match. */
function judge(candidates: Candidate[], existing: PhysicalSpaceDoc[], floorId: string | null): GeneratePreviewDTO & { rows: (GeneratedSpaceRowDTO & { skip: boolean })[] } {
  const byCode = new Map(existing.map((s) => [s.spaceCode, s]));
  const seen = new Set<string>();
  const rows = candidates.map((c) => {
    let clash: GeneratedSpaceRowDTO['clash'] = null;
    let clashMessage: string | null = null;
    const there = byCode.get(c.spaceCode);
    if (seen.has(c.spaceCode)) {
      clash = 'DUPLICATE_IN_LIST';
      clashMessage = 'This code appears twice in the list.';
    } else if (there) {
      if (there.floorId === floorId && there.spaceName === c.spaceName) clash = 'EXISTS';
      else {
        clash = 'CODE_TAKEN';
        clashMessage = `Another room (${there.spaceName}) already uses this code.`;
      }
    }
    seen.add(c.spaceCode);
    return { spaceCode: c.spaceCode, spaceName: c.spaceName, roomNumber: c.roomNumber, clash, clashMessage: clash === 'EXISTS' ? 'Already on this floor.' : clashMessage, skip: clash === 'EXISTS' };
  });
  return { rows, willCreate: rows.filter((r) => r.clash === null).length, alreadyThere: rows.filter((r) => r.clash === 'EXISTS').length, clashes: rows.filter((r) => r.clash !== null && r.clash !== 'EXISTS').length };
}

const publicRows = (rows: (GeneratedSpaceRowDTO & { skip?: boolean })[]): GeneratedSpaceRowDTO[] => rows.map(({ skip: _skip, ...r }) => r);

async function floorContext(ctx: ServiceContext, floorId: string, db?: ClientSession) {
  const floor = await loadFloor(ctx, floorId, db);
  await assertInScope(ctx, await spaceScope(ctx), floor.locationId, 'floor', floorId);
  assertStructureWritable(floor);
  assertLocationWritable(await loadLocation(ctx, floor.locationId, db));
  const building = await Building.findOne({ _id: floor.buildingId, tenantId: ctx.tenantId }).session(db ?? null).lean<BuildingDoc>();
  if (!building) throw AppError.notFound('Building not found.');
  assertStructureWritable(building);
  return { floor, building };
}

// ───────────────────────────────────────────────────────────── generator

function candidatesFor(data: GenerateSpacesData): Candidate[] {
  const base = { spaceTypeId: data.spaceTypeId, spaceCode: null, physicalCapacity: data.physicalCapacity ?? null, academicCapacity: data.academicCapacity ?? null, examCapacity: null, schedulableOverride: null, homeClassroomEligibleOverride: null, features: [], suitabilityOverrides: null, status: 'ACTIVE' as const };
  if (data.names) {
    return data.names.map((name) => ({ spaceCode: slug(name) || 'ROOM', spaceName: name, roomNumber: null, insert: { ...base, spaceName: name, roomNumber: null } }));
  }
  const out: Candidate[] = [];
  for (let n = data.from!; n <= data.to!; n += 1) {
    const code = `${data.prefix ?? ''}${n}`;
    out.push({ spaceCode: code, spaceName: `Room ${code}`, roomNumber: String(n), insert: { ...base, spaceName: `Room ${code}`, roomNumber: String(n) } });
  }
  return out;
}

async function generatorPlan(ctx: ServiceContext, floorId: string, data: GenerateSpacesData, db?: ClientSession) {
  await ensureSystemTypes(ctx);
  const { floor } = await floorContext(ctx, floorId, db);
  const type = await loadSpaceType(ctx, data.spaceTypeId, db);
  if (type.isOutdoor) throw AppError.validation({ spaceTypeId: 'Outdoor spaces are not on a floor. Add them from the campus screen.' });
  if (type.status !== 'ACTIVE') throw AppError.validation({ spaceTypeId: 'This room type is inactive. Choose another one.' });
  const candidates = candidatesFor(data);
  for (const c of candidates) if (!/^[A-Z0-9][A-Z0-9._-]{0,19}$/.test(c.spaceCode)) throw AppError.validation({ prefix: 'This prefix makes a code that is too long or has characters we cannot use.' });
  const existing = await PhysicalSpace.find({ tenantId: ctx.tenantId, locationId: floor.locationId, spaceCode: { $in: candidates.map((c) => c.spaceCode) } }).session(db ?? null).lean<PhysicalSpaceDoc[]>();
  return { floor, candidates, verdict: judge(candidates, existing, floor._id) };
}

export async function previewGenerate(ctx: ServiceContext, floorId: string, data: GenerateSpacesData): Promise<GeneratePreviewDTO> {
  const { verdict } = await generatorPlan(ctx, floorId, data);
  return { rows: publicRows(verdict.rows), willCreate: verdict.willCreate, alreadyThere: verdict.alreadyThere, clashes: verdict.clashes };
}

export async function generateSpaces(ctx: ServiceContext, floorId: string, data: GenerateSpacesData): Promise<GenerateResultDTO> {
  const { created, alreadyThere } = await withTransaction(async (db) => {
    const { floor, candidates, verdict } = await generatorPlan(ctx, floorId, data, db);
    if (verdict.clashes > 0) {
      const bad = verdict.rows.filter((r) => r.clash !== null && r.clash !== 'EXISTS');
      throw new AppError('SPACE_CODE_TAKEN', `${bad.length} code${bad.length === 1 ? ' is' : 's are'} already used: ${bad.slice(0, 5).map((r) => r.spaceCode).join(', ')}. Change the numbers or add a prefix.`, { clashes: publicRows(bad) });
    }
    const fresh = candidates.filter((_, i) => !verdict.rows[i]!.skip);
    const inserts = fresh.map((c): SpaceInsert => ({ ...c.insert, locationId: floor.locationId, buildingId: floor.buildingId, floorId: floor._id, spaceCode: c.spaceCode }));
    return { created: await insertSpaces(ctx, db, inserts, 'generator'), alreadyThere: verdict.alreadyThere };
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('spaceCode')) throw new AppError('SPACE_CODE_TAKEN');
    throw err;
  });
  return { created: await toSpaceDTOs(ctx, created, await todayFor(ctx)), alreadyThere };
}

// ───────────────────────────────────────────────────────────── duplicate floor

async function duplicatePlan(ctx: ServiceContext, sourceFloorId: string, data: DuplicateFloorData, db?: ClientSession) {
  if (sourceFloorId === data.targetFloorId) throw AppError.validation({ targetFloorId: 'Choose a different floor to copy to.' });
  const { floor: source } = await floorContext(ctx, sourceFloorId, db);
  const { floor: target, building } = await floorContext(ctx, data.targetFloorId, db);
  if (source.locationId !== target.locationId) throw new AppError('SPACE_LOCATION_MISMATCH');
  const rooms = await PhysicalSpace.find({ tenantId: ctx.tenantId, floorId: sourceFloorId, operationalStatus: { $ne: 'ARCHIVED' } }).sort({ spaceCode: 1 }).collation({ locale: 'en', numericOrdering: true }).session(db ?? null).lean<PhysicalSpaceDoc[]>();
  if (rooms.length === 0) throw AppError.validation({ targetFloorId: 'The first floor has no rooms to copy.' });
  const add = data.transform.add;
  const candidates: Candidate[] = rooms.map((r) => {
    const shifted = shiftTrailingNumber(r.spaceCode, add);
    const code = shifted && add !== 0 ? shifted : `${r.spaceCode}-${target.floorCode}`.slice(0, 20);
    const newNumber = r.roomNumber ? (shiftTrailingNumber(r.roomNumber, add) ?? r.roomNumber) : null;
    const name = r.roomNumber && r.spaceName.includes(r.roomNumber) && newNumber ? r.spaceName.replace(r.roomNumber, newNumber) : r.spaceName;
    return {
      spaceCode: code,
      spaceName: name,
      roomNumber: newNumber,
      insert: { spaceTypeId: r.spaceTypeId, spaceCode: code, spaceName: name, roomNumber: newNumber, physicalCapacity: r.physicalCapacity, academicCapacity: r.academicCapacity, examCapacity: r.examCapacity, schedulableOverride: r.schedulableOverride, homeClassroomEligibleOverride: r.homeClassroomEligibleOverride, features: [...r.features], suitabilityOverrides: r.suitabilityOverrides ? [...r.suitabilityOverrides] : null, status: r.operationalStatus === 'DRAFT' ? 'DRAFT' : 'ACTIVE' },
    };
  });
  const existing = await PhysicalSpace.find({ tenantId: ctx.tenantId, locationId: target.locationId, spaceCode: { $in: candidates.map((c) => c.spaceCode) } }).session(db ?? null).lean<PhysicalSpaceDoc[]>();
  return { target, building, candidates, verdict: judge(candidates, existing, target._id) };
}

export async function previewDuplicateFloor(ctx: ServiceContext, floorId: string, data: DuplicateFloorData): Promise<GeneratePreviewDTO> {
  const { verdict } = await duplicatePlan(ctx, floorId, data);
  return { rows: publicRows(verdict.rows), willCreate: verdict.willCreate, alreadyThere: verdict.alreadyThere, clashes: verdict.clashes };
}

export async function duplicateFloor(ctx: ServiceContext, floorId: string, data: DuplicateFloorData): Promise<GenerateResultDTO> {
  const { created, alreadyThere } = await withTransaction(async (db) => {
    const { target, candidates, verdict } = await duplicatePlan(ctx, floorId, data, db);
    if (verdict.clashes > 0) {
      const bad = verdict.rows.filter((r) => r.clash !== null && r.clash !== 'EXISTS');
      throw new AppError('SPACE_CODE_TAKEN', `${bad.length} code${bad.length === 1 ? ' is' : 's are'} already used: ${bad.slice(0, 5).map((r) => r.spaceCode).join(', ')}. Choose a different number to add.`, { clashes: publicRows(bad) });
    }
    const fresh = candidates.filter((_, i) => !verdict.rows[i]!.skip);
    const docs = await insertSpaces(ctx, db, fresh.map((c): SpaceInsert => ({ ...c.insert, locationId: target.locationId, buildingId: target.buildingId, floorId: target._id })), 'duplicate-floor');
    return { created: docs, alreadyThere: verdict.alreadyThere };
  });
  return { created: await toSpaceDTOs(ctx, created, await todayFor(ctx)), alreadyThere };
}

// ───────────────────────────────────────────────────────────── copy campus structure

interface CopyPlan {
  newBuildings: BuildingDoc[];
  newFloors: FloorDoc[];
  newRooms: SpaceInsert[];
  preview: CopyPreviewDTO;
}

async function copyPlan(ctx: ServiceContext, targetLocationId: string, data: CopyStructureData, db?: ClientSession): Promise<CopyPlan> {
  if (targetLocationId === data.fromLocationId) throw AppError.validation({ fromLocationId: 'Choose a different campus to copy from.' });
  const scope = await spaceScope(ctx);
  const target = await loadLocation(ctx, targetLocationId, db);
  const from = await loadLocation(ctx, data.fromLocationId, db);
  const school = await requireSchool(ctx);
  await assertInScope(ctx, scope, targetLocationId, 'location', targetLocationId);
  await assertInScope(ctx, scope, data.fromLocationId, 'location', data.fromLocationId);
  assertLocationWritable(target);

  const live = { status: { $ne: 'ARCHIVED' as const } };
  const own = { tenantId: ctx.tenantId };
  const srcBuildings = await Building.find({ ...own, locationId: from._id, ...live }).sort({ displayOrder: 1 }).session(db ?? null).lean<BuildingDoc[]>();
  const srcFloors = await Floor.find({ ...own, locationId: from._id, ...live }).session(db ?? null).lean<FloorDoc[]>();
  const srcRooms = await PhysicalSpace.find({ ...own, locationId: from._id, operationalStatus: { $ne: 'ARCHIVED' } }).session(db ?? null).lean<PhysicalSpaceDoc[]>();
  const dstBuildings = await Building.find({ ...own, locationId: target._id }).session(db ?? null).lean<BuildingDoc[]>();
  const dstFloors = await Floor.find({ ...own, locationId: target._id }).session(db ?? null).lean<FloorDoc[]>();
  const dstRooms = await PhysicalSpace.find({ ...own, locationId: target._id }).session(db ?? null).lean<PhysicalSpaceDoc[]>();

  // Source building id → the target building id (an existing one with the same code, or a new one).
  const buildingMap = new Map<string, string>();
  const newBuildings: BuildingDoc[] = [];
  for (const b of srcBuildings) {
    const there = dstBuildings.find((d) => d.buildingCode === b.buildingCode);
    if (there) buildingMap.set(b._id, there._id);
    else {
      const id = randomUUID();
      buildingMap.set(b._id, id);
      newBuildings.push({ ...b, _id: id, locationId: target._id, schoolId: school._id, version: 1, status: b.status === 'DRAFT' ? 'DRAFT' : b.status } as BuildingDoc);
    }
  }
  const floorMap = new Map<string, string>();
  const newFloors: FloorDoc[] = [];
  for (const f of srcFloors) {
    const targetBuildingId = buildingMap.get(f.buildingId);
    if (!targetBuildingId) continue;
    const there = dstFloors.find((d) => d.buildingId === targetBuildingId && d.floorCode === f.floorCode);
    if (there) floorMap.set(f._id, there._id);
    else {
      const id = randomUUID();
      floorMap.set(f._id, id);
      newFloors.push({ ...f, _id: id, locationId: target._id, buildingId: targetBuildingId, schoolId: school._id, version: 1 } as FloorDoc);
    }
  }
  const codes = new Map(dstRooms.map((r) => [r.spaceCode, r]));
  const newRooms: SpaceInsert[] = [];
  const clashes: CopyPreviewDTO['clashes'] = [];
  let existingRooms = 0;
  for (const r of srcRooms) {
    const floorId = r.floorId ? (floorMap.get(r.floorId) ?? null) : null;
    const buildingId = r.buildingId ? (buildingMap.get(r.buildingId) ?? null) : null;
    if (r.floorId && !floorId) continue; // its floor was archived
    const there = codes.get(r.spaceCode);
    if (there) {
      if (there.spaceName === r.spaceName && there.floorId === floorId) existingRooms += 1;
      else clashes.push({ spaceCode: r.spaceCode, message: `The code ${r.spaceCode} is already used by ${there.spaceName} at the new campus.` });
      continue;
    }
    newRooms.push({ locationId: target._id, buildingId, floorId, spaceTypeId: r.spaceTypeId, spaceCode: r.spaceCode, spaceName: r.spaceName, roomNumber: r.roomNumber, physicalCapacity: r.physicalCapacity, academicCapacity: r.academicCapacity, examCapacity: r.examCapacity, schedulableOverride: r.schedulableOverride, homeClassroomEligibleOverride: r.homeClassroomEligibleOverride, features: [...r.features], suitabilityOverrides: r.suitabilityOverrides ? [...r.suitabilityOverrides] : null, status: r.operationalStatus === 'DRAFT' ? 'DRAFT' : 'ACTIVE' });
  }
  return {
    newBuildings,
    newFloors,
    newRooms,
    preview: {
      buildings: { create: newBuildings.length, existing: srcBuildings.length - newBuildings.length },
      floors: { create: newFloors.length, existing: srcFloors.length - newFloors.length },
      rooms: { create: newRooms.length, existing: existingRooms },
      clashes,
      note: 'Buildings, floors and rooms are copied. Classroom assignments are never copied.',
    },
  };
}

export async function previewCopyStructure(ctx: ServiceContext, locationId: string, data: CopyStructureData): Promise<CopyPreviewDTO> {
  return (await copyPlan(ctx, locationId, data)).preview;
}

export async function copyStructure(ctx: ServiceContext, locationId: string, data: CopyStructureData): Promise<CopyResultDTO> {
  return withTransaction(async (db) => {
    const plan = await copyPlan(ctx, locationId, data, db);
    const stamp = { createdBy: ctx.userId, updatedBy: ctx.userId, archivedAt: null, archivedBy: null };
    if (plan.newBuildings.length > 0) await Building.create(plan.newBuildings.map(({ createdAt: _c, updatedAt: _u, ...b }) => ({ ...b, ...stamp })), { session: db, ordered: true });
    if (plan.newFloors.length > 0) await Floor.create(plan.newFloors.map(({ createdAt: _c, updatedAt: _u, ...f }) => ({ ...f, ...stamp })), { session: db, ordered: true });
    for (const b of plan.newBuildings) {
      await recordSpaceAudit(ctx, db, { entityType: 'building', entityId: b._id, action: 'building.created', locationId, metadata: { buildingCode: b.buildingCode, source: 'copy-structure' } });
      await emitSpaceEvent(db, ctx.tenantId, 'building.created', { buildingId: b._id, locationId });
    }
    for (const f of plan.newFloors) {
      await recordSpaceAudit(ctx, db, { entityType: 'floor', entityId: f._id, action: 'floor.created', locationId, metadata: { floorCode: f.floorCode, source: 'copy-structure' } });
      await emitSpaceEvent(db, ctx.tenantId, 'floor.created', { floorId: f._id, buildingId: f.buildingId, locationId });
    }
    await insertSpaces(ctx, db, plan.newRooms, 'copy-structure');
    await recordSpaceAudit(ctx, db, { entityType: 'physical_space', entityId: locationId, action: 'structure.copied', locationId, metadata: { fromLocationId: data.fromLocationId, buildings: plan.preview.buildings.create, floors: plan.preview.floors.create, rooms: plan.preview.rooms.create } });
    return { ...plan.preview, committed: true as const };
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)) throw new AppError('SPACE_CODE_TAKEN', 'Some codes were taken while copying. Check the preview again.');
    throw err;
  });
}

export type { SpaceTypeDoc };
