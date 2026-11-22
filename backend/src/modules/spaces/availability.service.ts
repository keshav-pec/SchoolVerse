import type { ClientSession } from 'mongoose';
import { MAX_BLOCK_DAYS, type AvailabilityBlockDTO, type AvailabilityCheckData, type AvailabilityCheckDTO, type CreateAvailabilityBlockData, type ListBlocksQuery } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { emitSpaceEvent, recordSpaceAudit } from './audit';
import { assertSpaceWritable, assertInScope, loadSpace, loadSpaceType, spaceScope } from './guards';
import { toBlockDTO } from './mappers';
import { effectiveStatusOf, resolveSpace } from './resolve';
import { loadVisibleSpace } from './space.service';
import { Building, Floor, PhysicalSpace, SpaceAvailabilityBlock, type BuildingDoc, type FloorDoc, type PhysicalSpaceDoc, type SpaceAvailabilityBlockDoc } from './space.models';

/**
 * SPACE-46, 47 — a dated closure (Availability Block) is not the same as a long-term closure (Inactive). A block NEVER ends or edits a
 * Home Classroom assignment: it only shows up as a warning where the room is used.
 */

const DAY = 86_400_000;

const fmt = (d: Date) => d.toISOString().slice(0, 16).replace('T', ' ');

export async function createBlock(ctx: ServiceContext, spaceId: string, data: CreateAvailabilityBlockData): Promise<AvailabilityBlockDTO> {
  const space = await loadVisibleSpace(ctx, spaceId);
  assertSpaceWritable(space);
  const start = new Date(data.startDatetime);
  const end = new Date(data.endDatetime);
  const now = new Date();
  if (end <= now) throw AppError.validation({ endDatetime: 'The end must be in the future.' });
  // A closure with no real end is a long-term closure: the room should be Inactive.
  if (end.getTime() - now.getTime() > MAX_BLOCK_DAYS * DAY || end.getTime() - start.getTime() > MAX_BLOCK_DAYS * DAY) throw new AppError('USE_INACTIVE_FOR_INDEFINITE');
  const id = await withTransaction(async (db) => {
    const clash = await SpaceAvailabilityBlock.exists({ tenantId: ctx.tenantId, physicalSpaceId: spaceId, status: 'ACTIVE', startDatetime: { $lt: end }, endDatetime: { $gt: start } }).session(db);
    if (clash) throw new AppError('BLOCK_OVERLAP_INVALID');
    const [doc] = await SpaceAvailabilityBlock.create(
      [{ tenantId: ctx.tenantId, physicalSpaceId: spaceId, locationId: space.locationId, blockType: data.blockType, startDatetime: start, endDatetime: end, reasonCode: data.reasonCode, reason: data.reason ?? null, recurrenceRule: data.recurrenceRule ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    await recordSpaceAudit(ctx, db, { entityType: 'availability_block', entityId: doc!._id, action: 'availability_block.created', locationId: space.locationId, metadata: { physicalSpaceId: spaceId, start: start.toISOString(), end: end.toISOString(), reasonCode: data.reasonCode } });
    await emitSpaceEvent(db, ctx.tenantId, 'physical_space.unavailable', { spaceId, locationId: space.locationId, blockId: doc!._id, start: start.toISOString(), end: end.toISOString() });
    return doc!._id;
  });
  return toBlockDTO((await SpaceAvailabilityBlock.findOne({ _id: id, tenantId: ctx.tenantId }).lean<SpaceAvailabilityBlockDoc>())!);
}

export async function listBlocks(ctx: ServiceContext, spaceId: string, query: ListBlocksQuery): Promise<AvailabilityBlockDTO[]> {
  await loadVisibleSpace(ctx, spaceId);
  const docs = await SpaceAvailabilityBlock.find({ tenantId: ctx.tenantId, physicalSpaceId: spaceId, ...(query.includeCancelled ? {} : { status: 'ACTIVE' }) }).sort({ startDatetime: -1 }).limit(200).lean<SpaceAvailabilityBlockDoc[]>();
  const now = new Date();
  return docs.map((d) => toBlockDTO(d, now));
}

export async function cancelBlock(ctx: ServiceContext, blockId: string): Promise<AvailabilityBlockDTO> {
  const block = await SpaceAvailabilityBlock.findOne({ _id: blockId, tenantId: ctx.tenantId }).lean<SpaceAvailabilityBlockDoc>();
  if (!block) throw AppError.notFound('Availability block not found.');
  const space = await loadSpace(ctx, block.physicalSpaceId);
  await assertInScope(ctx, await spaceScope(ctx), space.locationId, 'space', space._id);
  if (block.status === 'ACTIVE') {
    await withTransaction(async (db) => {
      await SpaceAvailabilityBlock.updateOne({ _id: blockId, tenantId: ctx.tenantId, status: 'ACTIVE' }, { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: ctx.userId, updatedBy: ctx.userId } }, { session: db });
      await recordSpaceAudit(ctx, db, { entityType: 'availability_block', entityId: blockId, action: 'availability_block.cancelled', locationId: space.locationId, metadata: { physicalSpaceId: space._id } });
      await emitSpaceEvent(db, ctx.tenantId, 'physical_space.available', { spaceId: space._id, locationId: space.locationId, blockId });
    });
  }
  return toBlockDTO((await SpaceAvailabilityBlock.findOne({ _id: blockId, tenantId: ctx.tenantId }).lean<SpaceAvailabilityBlockDoc>())!);
}

/**
 * Can this room be used between `start` and `end`? Answers yes or no with every reason: the room is not active, the floor or building
 * above it is not active, it is blocked for dates, or it cannot be scheduled. Used by the API and (later) by Timetable through `spaceService`.
 */
export async function checkSpaceAvailability(ctx: ServiceContext, space: PhysicalSpaceDoc, start: Date, end: Date, db?: ClientSession): Promise<AvailabilityCheckDTO> {
  const [type, floor, building, blocks] = await Promise.all([
    loadSpaceType(ctx, space.spaceTypeId, db),
    space.floorId ? Floor.findOne({ _id: space.floorId, tenantId: ctx.tenantId }).session(db ?? null).lean<FloorDoc>() : null,
    space.buildingId ? Building.findOne({ _id: space.buildingId, tenantId: ctx.tenantId }).session(db ?? null).lean<BuildingDoc>() : null,
    SpaceAvailabilityBlock.find({ tenantId: ctx.tenantId, physicalSpaceId: space._id, status: 'ACTIVE', startDatetime: { $lt: end }, endDatetime: { $gt: start } }).session(db ?? null).lean<SpaceAvailabilityBlockDoc[]>(),
  ]);
  const reasons: AvailabilityCheckDTO['reasons'] = [];
  const effective = effectiveStatusOf(space, floor, building);
  if (!effective.available) reasons.push({ code: space.operationalStatus !== 'ACTIVE' ? 'SPACE_NOT_ACTIVE' : 'PARENT_NOT_ACTIVE', message: effective.reason! });
  for (const b of blocks) reasons.push({ code: 'BLOCK_ACTIVE', message: `Marked ${b.blockType === 'RESTRICTED' ? 'restricted' : 'unavailable'} from ${fmt(b.startDatetime)} to ${fmt(b.endDatetime)}${b.reason ? ` (${b.reason})` : ''}.` });
  if (!resolveSpace(space, type).schedulable.value) reasons.push({ code: 'NOT_SCHEDULABLE', message: `${type.name} rooms are not used for scheduling.` });
  return { available: reasons.length === 0, reasons };
}

export async function availabilityCheck(ctx: ServiceContext, data: AvailabilityCheckData): Promise<AvailabilityCheckDTO> {
  // A teacher asks about a room they may see; anything else is a 404 like any other room.
  const space = await loadVisibleSpace(ctx, data.physicalSpaceId);
  return checkSpaceAvailability(ctx, space, new Date(data.start), new Date(data.end));
}

export { PhysicalSpace };
