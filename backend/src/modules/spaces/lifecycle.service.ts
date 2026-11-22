import type { ArchiveSpaceData, ArchiveSpaceResultDTO, DependencyListDTO, MoveSpaceData, SpaceChangeDTO, SpaceDTO } from '@shared';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AuditEvent } from '../audit/audit.model';
import { toAuditEventDTO } from '../audit/audit.service';
import { todayFor } from '../staff/status';
import { emitSpaceEvent, recordSpaceAudit } from './audit';
import { findSpaceDependencies, spaceHasHistory } from './dependencies';
import { assertSpaceWritable, assertStructureWritable, loadBuilding, loadFloor, loadSpaceType } from './guards';
import { assertSpaceTransition } from './lifecycle';
import { toSpaceDTOOne } from './mappers';
import { effectiveStatusOf, resolveSpace } from './resolve';
import { loadVisibleSpace } from './space.service';
import { AcademicSession } from '../academic/session.model';
import { Building, Floor, PhysicalSpace, SectionSpaceAssignment, SpaceAvailabilityBlock, SpaceChangeLog, type BuildingDoc, type FloorDoc, type PhysicalSpaceDoc, type SpaceChangeLogDoc } from './space.models';

/** SPACE-48 to 53 — move, archive, hard delete and history. A used room is never moved or deleted: it is archived, with an explanation. */

async function pathText(ctx: ServiceContext, room: Pick<PhysicalSpaceDoc, 'buildingId' | 'floorId'>): Promise<string> {
  const [b, f] = await Promise.all([room.buildingId ? Building.findOne({ _id: room.buildingId, tenantId: ctx.tenantId }).lean<BuildingDoc>() : null, room.floorId ? Floor.findOne({ _id: room.floorId, tenantId: ctx.tenantId }).lean<FloorDoc>() : null]);
  return [b?.buildingName, f?.floorName].filter(Boolean).join(' › ') || 'Outdoors';
}

/** A room can move to another floor or building only when nothing ever used it. Otherwise the answer says what to do. */
export async function moveSpace(ctx: ServiceContext, id: string, data: MoveSpaceData): Promise<SpaceDTO> {
  const room = await loadVisibleSpace(ctx, id);
  assertSpaceWritable(room);
  const type = await loadSpaceType(ctx, room.spaceTypeId);
  if (type.isOutdoor) throw AppError.validation({ buildingId: 'Outdoor spaces are not on a floor, so there is nothing to move.' });
  const [building, floor] = await Promise.all([loadBuilding(ctx, data.buildingId), loadFloor(ctx, data.floorId)]);
  if (floor.buildingId !== building._id || building.locationId !== room.locationId) throw new AppError('SPACE_LOCATION_MISMATCH');
  assertStructureWritable(building);
  assertStructureWritable(floor);
  if (room.floorId === floor._id) throw AppError.validation({ floorId: 'The room is already on this floor.' });

  const from = await pathText(ctx, room);
  await withTransaction(async (db) => {
    const query = { tenantId: ctx.tenantId, physicalSpaceId: id, session: db };
    // Any history — an assignment, a block, anything another module registered — makes the move unsafe.
    if (await spaceHasHistory(query)) throw new AppError('GUARDED_MOVE_REQUIRED', undefined, { actions: ['ARCHIVE_AND_CREATE'] });
    const updated = await PhysicalSpace.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, version: room.version }, { $set: { buildingId: building._id, floorId: floor._id, updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    const to = [building.buildingName, floor.floorName].join(' › ');
    await SpaceChangeLog.create([{ tenantId: ctx.tenantId, physicalSpaceId: id, type: 'MOVE', from, to, reason: data.reason, actorId: ctx.userId }], { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'physical_space', entityId: id, action: 'physical_space.moved', locationId: room.locationId, changes: [{ field: 'floorId', from: room.floorId, to: floor._id }, { field: 'buildingId', from: room.buildingId, to: building._id }], metadata: { reason: data.reason } });
    await emitSpaceEvent(db, ctx.tenantId, 'physical_space.updated', { spaceId: id, locationId: room.locationId, fields: ['buildingId', 'floorId'] });
  });
  return toSpaceDTOOne(ctx, (await PhysicalSpace.findOne({ _id: id, tenantId: ctx.tenantId }).lean<PhysicalSpaceDoc>())!, await todayFor(ctx));
}

/** Rooms that hold a Home Classroom today or later: they cannot take over another section's room. */
async function roomsInUse(ctx: ServiceContext, locationId: string, today: string): Promise<Set<string>> {
  const open = (await AcademicSession.find({ tenantId: ctx.tenantId, endDate: { $gte: today } }).select('_id').lean<{ _id: string }[]>()).map((s) => s._id);
  const rows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, locationId, status: { $ne: 'CANCELLED' }, $or: [{ effectiveTo: { $gte: today } }, { effectiveTo: null, academicSessionId: { $in: open } }] }).select('physicalSpaceId').lean<{ physicalSpaceId: string }[]>();
  return new Set(rows.map((r) => r.physicalSpaceId));
}

/** The best other room to take over: same location and type, active, free of other Home Classrooms, big enough, and the smallest that fits. */
async function suggestReplacement(ctx: ServiceContext, room: PhysicalSpaceDoc, today: string): Promise<{ id: string; name: string } | null> {
  const type = await loadSpaceType(ctx, room.spaceTypeId);
  const need = resolveSpace(room, type).academicCapacity.value ?? 0;
  const taken = await roomsInUse(ctx, room.locationId, today);
  const peers = (await PhysicalSpace.find({ tenantId: ctx.tenantId, locationId: room.locationId, _id: { $ne: room._id }, spaceTypeId: room.spaceTypeId, operationalStatus: 'ACTIVE', archiveAfterDate: null }).lean<PhysicalSpaceDoc[]>()).filter((p) => !taken.has(p._id));
  if (peers.length === 0) return null;
  const [floors, buildings] = await Promise.all([Floor.find({ tenantId: ctx.tenantId, _id: { $in: peers.map((p) => p.floorId).filter(Boolean) as string[] } }).lean<FloorDoc[]>(), Building.find({ tenantId: ctx.tenantId, _id: { $in: peers.map((p) => p.buildingId).filter(Boolean) as string[] } }).lean<BuildingDoc[]>()]);
  const floorOf = new Map(floors.map((f) => [f._id, f]));
  const buildingOf = new Map(buildings.map((b) => [b._id, b]));
  const fits = peers
    .filter((p) => effectiveStatusOf(p, p.floorId ? (floorOf.get(p.floorId) ?? null) : null, p.buildingId ? (buildingOf.get(p.buildingId) ?? null) : null, today).available)
    .map((p) => ({ p, cap: resolveSpace(p, type).academicCapacity.value ?? 0 }))
    .filter((x) => x.cap >= need)
    .sort((a, b) => a.cap - b.cap || a.p.spaceCode.localeCompare(b.p.spaceCode, 'en', { numeric: true }));
  const best = fits[0]?.p;
  return best ? { id: best._id, name: best.spaceName } : null;
}

export async function dependenciesOf(ctx: ServiceContext, id: string): Promise<DependencyListDTO> {
  await loadVisibleSpace(ctx, id);
  return { dependencies: await findSpaceDependencies({ tenantId: ctx.tenantId, physicalSpaceId: id }) };
}

/**
 * Archives a room, or explains why it cannot yet. A room that something depends on is NEVER refused with a raw error: the answer lists
 * what depends on it in plain words, suggests a replacement room, and names the next steps. Archived rooms stay readable.
 */
export async function archiveSpace(ctx: ServiceContext, id: string, data: ArchiveSpaceData): Promise<ArchiveSpaceResultDTO> {
  const room = await loadVisibleSpace(ctx, id);
  assertSpaceWritable(room);
  const today = await todayFor(ctx);
  const dependencies = await findSpaceDependencies({ tenantId: ctx.tenantId, physicalSpaceId: id });
  if (dependencies.length > 0) {
    const suggestion = await suggestReplacement(ctx, room, today);
    return {
      archived: false,
      space: await toSpaceDTOOne(ctx, room, today),
      message: `${room.spaceName} is still in use, so it was not archived. ${dependencies.map((d) => d.label).join(' ')}${suggestion ? ` ${suggestion.name} could take over.` : ''}`,
      dependencies,
      suggestedReplacementId: suggestion?.id ?? null,
      suggestedReplacementName: suggestion?.name ?? null,
      actions: ['CHOOSE_REPLACEMENT', 'ARCHIVE_AFTER_SESSION'],
    };
  }
  await withTransaction(async (db) => {
    assertSpaceTransition(room.operationalStatus, 'ARCHIVED');
    const updated = await PhysicalSpace.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, version: room.version }, { $set: { operationalStatus: 'ARCHIVED', archivedAt: new Date(), archivedBy: ctx.userId, updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    await recordSpaceAudit(ctx, db, { entityType: 'physical_space', entityId: id, action: 'physical_space.archived', locationId: room.locationId, changes: [{ field: 'operationalStatus', from: room.operationalStatus, to: 'ARCHIVED' }], metadata: data.reason ? { reason: data.reason } : undefined });
    await emitSpaceEvent(db, ctx.tenantId, 'physical_space.status.changed', { spaceId: id, locationId: room.locationId, from: room.operationalStatus, to: 'ARCHIVED' });
  });
  return { archived: true, space: await toSpaceDTOOne(ctx, (await PhysicalSpace.findOne({ _id: id, tenantId: ctx.tenantId }).lean<PhysicalSpaceDoc>())!, today), message: `${room.spaceName} was archived. It stays in the history.`, dependencies: [], suggestedReplacementId: null, suggestedReplacementName: null, actions: [] };
}

/** Hard delete: only a draft room that nothing ever referenced. Everything else is archived. */
export async function deleteSpace(ctx: ServiceContext, id: string): Promise<void> {
  const room = await loadVisibleSpace(ctx, id);
  await withTransaction(async (db) => {
    const reasons: string[] = [];
    if (room.operationalStatus !== 'DRAFT') reasons.push('Only a draft room can be deleted. Archive this one instead.');
    if (await spaceHasHistory({ tenantId: ctx.tenantId, physicalSpaceId: id, session: db })) reasons.push('It has history (a closure, an assignment or another record).');
    if (await SpaceChangeLog.exists({ tenantId: ctx.tenantId, physicalSpaceId: id }).session(db)) reasons.push('It was renamed, moved or converted before.');
    if (await SpaceAvailabilityBlock.exists({ tenantId: ctx.tenantId, physicalSpaceId: id }).session(db)) reasons.push('It has been closed for dates before.');
    if (reasons.length > 0) throw new AppError('HAS_DEPENDENCIES', `${room.spaceName} cannot be deleted. ${reasons.join(' ')}`, { dependencies: reasons.map((label) => ({ kind: 'ROOMS', label })) });
    await PhysicalSpace.deleteOne({ _id: id, tenantId: ctx.tenantId }, { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'physical_space', entityId: id, action: 'physical_space.deleted', locationId: room.locationId, metadata: { spaceCode: room.spaceCode } });
  });
}

// ───────────────────────────────────────────────────────────── history

export async function spaceHistory(ctx: ServiceContext, id: string, limit: number) {
  await loadVisibleSpace(ctx, id);
  const [changes, events] = await Promise.all([
    SpaceChangeLog.find({ tenantId: ctx.tenantId, physicalSpaceId: id }).sort({ createdAt: -1 }).limit(limit).lean<SpaceChangeLogDoc[]>(),
    AuditEvent.find({ tenantId: ctx.tenantId, entityType: 'physical_space', entityId: id }).sort({ occurredAt: -1 }).limit(limit).lean(),
  ]);
  const log: SpaceChangeDTO[] = changes.map((c) => ({ changeId: c._id, physicalSpaceId: c.physicalSpaceId, type: c.type, from: c.from ?? null, to: c.to ?? null, reason: c.reason ?? null, actorId: c.actorId ?? null, occurredAt: toIso(c.createdAt)! }));
  return { changes: log, audit: events.map((e) => toAuditEventDTO(e)) };
}
