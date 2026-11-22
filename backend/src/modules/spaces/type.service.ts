import { randomUUID } from 'node:crypto';
import { SYSTEM_SPACE_TYPES, type CreateSpaceTypeData, type SpaceTypeDTO, type UpdateSpaceTypeData } from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { recordSpaceAudit } from './audit';
import { loadSpaceType, requireSchool } from './guards';
import { toSpaceTypeDTO } from './mappers';
import { firstFree } from './codes';
import { PhysicalSpace, SpaceType, type SpaceTypeDoc } from './space.models';

/** SPACE-10, 11 — Space Types hold the defaults a room inherits. The seven built-in types exist from the first visit. */

const AUDITED = ['name', 'isSchedulable', 'isHomeClassroomEligible', 'defaultSuitabilityTags', 'defaultAcademicCapacity', 'status'] as const;

/** Makes sure the school has its seven starter types. Safe to call on every request: it only inserts what is missing. */
export async function ensureSystemTypes(ctx: ServiceContext): Promise<void> {
  const existing = await SpaceType.countDocuments({ tenantId: ctx.tenantId, isSystem: true });
  if (existing >= SYSTEM_SPACE_TYPES.length) return;
  const school = await requireSchool(ctx);
  for (const t of SYSTEM_SPACE_TYPES) {
    try {
      await SpaceType.updateOne(
        { tenantId: ctx.tenantId, code: t.code },
        { $setOnInsert: { _id: randomUUID(), schoolId: school._id, ...t, isSystem: true, status: 'ACTIVE', createdBy: ctx.userId, updatedBy: ctx.userId } },
        { upsert: true },
      );
    } catch (err) {
      if (!duplicateKeyFields(err)) throw err; // two requests seeded at once: the other one won
    }
  }
}

async function roomCounts(ctx: ServiceContext): Promise<Map<string, number>> {
  const rows = await PhysicalSpace.aggregate<{ _id: string; n: number }>([
    { $match: { tenantId: ctx.tenantId, operationalStatus: { $ne: 'ARCHIVED' } } },
    { $group: { _id: '$spaceTypeId', n: { $sum: 1 } } },
  ]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

export async function listSpaceTypes(ctx: ServiceContext): Promise<SpaceTypeDTO[]> {
  await ensureSystemTypes(ctx);
  const [docs, counts] = await Promise.all([SpaceType.find({ tenantId: ctx.tenantId }).sort({ isSystem: -1, name: 1 }).lean<SpaceTypeDoc[]>(), roomCounts(ctx)]);
  return docs.map((d) => toSpaceTypeDTO(d, counts.get(d._id) ?? 0));
}

export async function getSpaceType(ctx: ServiceContext, id: string): Promise<SpaceTypeDTO> {
  const doc = await loadSpaceType(ctx, id);
  const count = await PhysicalSpace.countDocuments({ tenantId: ctx.tenantId, spaceTypeId: id, operationalStatus: { $ne: 'ARCHIVED' } });
  return toSpaceTypeDTO(doc, count);
}

export async function createSpaceType(ctx: ServiceContext, data: CreateSpaceTypeData): Promise<SpaceTypeDTO> {
  await ensureSystemTypes(ctx);
  const school = await requireSchool(ctx);
  const taken = new Set((await SpaceType.find({ tenantId: ctx.tenantId }).select('code').lean<{ code: string }[]>()).map((t) => t.code));
  const typed = data.code ?? null;
  if (typed && taken.has(typed)) throw new AppError('SPACE_TYPE_CODE_TAKEN');
  const code = typed ?? firstFree(data.name.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 20) || 'TYPE', taken);
  const id = await withTransaction(async (db) => {
    const [doc] = await SpaceType.create(
      [{ tenantId: ctx.tenantId, schoolId: school._id, code, name: data.name, isSchedulable: data.isSchedulable, isHomeClassroomEligible: data.isHomeClassroomEligible, defaultSuitabilityTags: data.defaultSuitabilityTags, defaultAcademicCapacity: data.defaultAcademicCapacity ?? null, isOutdoor: data.isOutdoor, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    await recordSpaceAudit(ctx, db, { entityType: 'space_type', entityId: doc!._id, action: 'space_type.created', metadata: { code } });
    return doc!._id;
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('code')) throw new AppError('SPACE_TYPE_CODE_TAKEN');
    throw err;
  });
  return getSpaceType(ctx, id);
}

export async function updateSpaceType(ctx: ServiceContext, id: string, data: UpdateSpaceTypeData): Promise<SpaceTypeDTO> {
  const before = await loadSpaceType(ctx, id);
  const patch = pickDefined(data);
  if (data.defaultAcademicCapacity !== undefined && data.defaultAcademicCapacity !== null && !(Number.isInteger(data.defaultAcademicCapacity) && data.defaultAcademicCapacity > 0)) throw new AppError('CAPACITY_INVALID');
  await withTransaction(async (db) => {
    const after = { ...before, ...patch } as SpaceTypeDoc;
    const changes = diffFields(before, after, AUDITED);
    if (changes.length === 0) return;
    await SpaceType.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'space_type', entityId: id, action: 'space_type.updated', changes });
  });
  return getSpaceType(ctx, id);
}

/** `POST /space-types/:id/inactivate` is blocked while active rooms use the type. */
export async function setSpaceTypeStatus(ctx: ServiceContext, id: string, to: 'ACTIVE' | 'INACTIVE'): Promise<SpaceTypeDTO> {
  const before = await loadSpaceType(ctx, id);
  if (before.isSystem && to === 'INACTIVE') throw new AppError('SPACE_TYPE_SYSTEM');
  if (before.status === to) return getSpaceType(ctx, id);
  if (to === 'INACTIVE') {
    const using = await PhysicalSpace.countDocuments({ tenantId: ctx.tenantId, spaceTypeId: id, operationalStatus: { $nin: ['ARCHIVED', 'INACTIVE'] } });
    if (using > 0) throw new AppError('SPACE_TYPE_IN_USE', `${using} room${using === 1 ? ' still uses' : 's still use'} this type. Change their type first.`, { roomCount: using });
  }
  await withTransaction(async (db) => {
    await SpaceType.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { status: to, updatedBy: ctx.userId } }, { session: db });
    await recordSpaceAudit(ctx, db, { entityType: 'space_type', entityId: id, action: `space_type.${to === 'ACTIVE' ? 'activated' : 'inactivated'}`, changes: [{ field: 'status', from: before.status, to }] });
  });
  return getSpaceType(ctx, id);
}
