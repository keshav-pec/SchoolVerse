import type { ClientSession } from 'mongoose';
import {
  SCHEDULING_EXCLUDED_TYPE_CODES,
  type BulkCreateResultDTO,
  type BulkCreateSpacesData,
  type BulkEditData,
  type BulkEditResultDTO,
  type BulkFeatureChangeData,
  type BulkTagChangeData,
  type CreateSpaceData,
  type FeatureChangeData,
  type ListSpacesQuery,
  type Permission,
  type SpaceContextDTO,
  type SpaceDTO,
  type SpaceEventType,
  type SpaceFeatureCode,
  type SpaceListDTO,
  type SpaceStatus,
  type SpaceTargetStatus,
  type SuitabilityTagCode,
  type TagChangeData,
  type TypeConversionPreviewDTO,
  type UpdateSpaceData,
} from '@shared';
import { AppError } from '../../core/errors';
import { escapeRegex } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { todayFor } from '../staff/status';
import { emitSpaceEvent, recordSpaceAudit } from './audit';
import { spaceCodeFrom } from './codes';
import { conversionWarnings } from './dependencies';
import { assertInScope, assertLocationWritable, assertSpaceWritable, assertVersion, loadLocation, loadSpace, loadSpaceType, requireSchool, spaceScope, type SpaceScope } from './guards';
import { assertSpaceTransition } from './lifecycle';
import { loadLookups, pathOf, toBlockDTO, toSpaceDTO, toSpaceDTOOne, toSpaceDTOs, type SpaceLookups } from './mappers';
import { ensureSystemTypes } from './type.service';
import { isMissingCapacity, resolveSpace } from './resolve';
import { Building, Floor, PhysicalSpace, SpaceAvailabilityBlock, SpaceChangeLog, SpaceType, type BuildingDoc, type FloorDoc, type PhysicalSpaceDoc, type SpaceAvailabilityBlockDoc, type SpaceTypeDoc } from './space.models';

/** SPACE-08, 09, 12 to 15, 20 — rooms: create, list, read the context other modules use, edit, status, features, tags and bulk edit. */

const AUDITED = ['spaceName', 'roomNumber', 'spaceTypeId', 'physicalCapacity', 'academicCapacity', 'examCapacity', 'schedulableOverride', 'homeClassroomEligibleOverride', 'suitabilityOverrides', 'features', 'operationalStatus'] as const;

function requireCan(ctx: ServiceContext, permission: Permission) {
  if (!can(ctx, permission)) throw new AppError('FORBIDDEN', undefined, { required: [permission] });
}

/** A seat count is a positive whole number, or empty. */
export function assertCapacities(values: Record<string, number | null | undefined>) {
  const bad: Record<string, string> = {};
  for (const [field, v] of Object.entries(values)) {
    if (v === null || v === undefined) continue;
    if (!Number.isInteger(v) || v <= 0 || v > 100000) bad[field] = 'Enter a whole number above zero, for example 40.';
  }
  if (Object.keys(bad).length > 0) throw new AppError('CAPACITY_INVALID', undefined, { fields: bad });
}

// ───────────────────────────────────────────────────────────── create

export interface SpaceInsert {
  locationId: string;
  buildingId: string | null;
  floorId: string | null;
  spaceTypeId: string;
  /** `null` = make one. A typed code that is taken is an error. */
  spaceCode: string | null;
  spaceName: string;
  roomNumber: string | null;
  physicalCapacity: number | null;
  academicCapacity: number | null;
  examCapacity: number | null;
  schedulableOverride: boolean | null;
  homeClassroomEligibleOverride: boolean | null;
  features: SpaceFeatureCode[];
  suitabilityOverrides: SuitabilityTagCode[] | null;
  status: 'DRAFT' | 'ACTIVE';
}

export const toInsert = (d: CreateSpaceData): SpaceInsert => ({
  locationId: d.locationId,
  buildingId: d.buildingId ?? null,
  floorId: d.floorId ?? null,
  spaceTypeId: d.spaceTypeId,
  spaceCode: d.spaceCode ?? null,
  spaceName: d.spaceName,
  roomNumber: d.roomNumber ?? null,
  physicalCapacity: d.physicalCapacity ?? null,
  academicCapacity: d.academicCapacity ?? null,
  examCapacity: d.examCapacity ?? null,
  schedulableOverride: d.schedulableOverride ?? null,
  homeClassroomEligibleOverride: d.homeClassroomEligibleOverride ?? null,
  features: d.features ?? [],
  suitabilityOverrides: d.suitabilityOverrides ?? null,
  status: d.status,
});

/**
 * Creates rooms inside the caller's transaction (also used by the generator, the import and copy-campus). Indoor rooms need a building
 * and floor at the same location; outdoor types must have none. Codes are made when missing; a typed code that is taken is refused.
 */
export async function insertSpaces(ctx: ServiceContext, db: ClientSession, rows: SpaceInsert[], source: string): Promise<PhysicalSpaceDoc[]> {
  if (rows.length === 0) return [];
  const school = await requireSchool(ctx);
  const locationIds = [...new Set(rows.map((r) => r.locationId))];
  // One transaction runs one command at a time, so these reads go in turn.
  const types = await SpaceType.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(rows.map((r) => r.spaceTypeId))] } }).session(db).lean<SpaceTypeDoc[]>();
  const buildings = await Building.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(rows.map((r) => r.buildingId).filter(Boolean) as string[])] } }).session(db).lean<BuildingDoc[]>();
  const floors = await Floor.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(rows.map((r) => r.floorId).filter(Boolean) as string[])] } }).session(db).lean<FloorDoc[]>();
  const taken: (readonly [string, Set<string>])[] = [];
  for (const l of locationIds) taken.push([l, new Set((await PhysicalSpace.find({ tenantId: ctx.tenantId, locationId: l }).session(db).select('spaceCode').lean<{ spaceCode: string }[]>()).map((s) => s.spaceCode))] as const);
  const typeOf = new Map(types.map((t) => [t._id, t]));
  const buildingOf = new Map(buildings.map((b) => [b._id, b]));
  const floorOf = new Map(floors.map((f) => [f._id, f]));
  const takenBy = new Map(taken);
  const scope = await spaceScope(ctx);
  for (const l of locationIds) {
    await assertInScope(ctx, scope, l, 'location', l);
    assertLocationWritable(await loadLocation(ctx, l, db));
  }

  const docs: PhysicalSpaceDoc[] = [];
  for (const r of rows) {
    const type = typeOf.get(r.spaceTypeId);
    if (!type) throw AppError.notFound('Room type not found.');
    if (type.status !== 'ACTIVE') throw AppError.validation({ spaceTypeId: 'This room type is inactive. Choose another one.' });
    assertCapacities({ physicalCapacity: r.physicalCapacity, academicCapacity: r.academicCapacity, examCapacity: r.examCapacity });
    const building = r.buildingId ? buildingOf.get(r.buildingId) : undefined;
    const floor = r.floorId ? floorOf.get(r.floorId) : undefined;
    if (type.isOutdoor) {
      if (r.buildingId || r.floorId) throw new AppError('OUTDOOR_SPACE_NO_FLOOR');
    } else {
      if (!r.buildingId || !r.floorId) throw new AppError('INDOOR_SPACE_NEEDS_FLOOR');
      if (!building || !floor) throw AppError.notFound('Building or floor not found.');
      if (building.locationId !== r.locationId || floor.locationId !== r.locationId || floor.buildingId !== building._id) throw new AppError('SPACE_LOCATION_MISMATCH');
      if (building.status === 'ARCHIVED' || floor.status === 'ARCHIVED') throw new AppError('STRUCTURE_ARCHIVED');
    }
    const used = takenBy.get(r.locationId)!;
    if (r.spaceCode && used.has(r.spaceCode)) throw new AppError('SPACE_CODE_TAKEN', undefined, { fields: { spaceCode: 'Another room at this campus already uses this code.' } });
    const code = r.spaceCode ?? spaceCodeFrom({ roomNumber: r.roomNumber, spaceName: r.spaceName, buildingCode: building?.buildingCode ?? null }, used);
    used.add(code);
    docs.push({ tenantId: ctx.tenantId, schoolId: school._id, locationId: r.locationId, buildingId: r.buildingId, floorId: r.floorId, spaceCode: code, spaceName: r.spaceName, roomNumber: r.roomNumber, spaceTypeId: r.spaceTypeId, physicalCapacity: r.physicalCapacity, academicCapacity: r.academicCapacity, examCapacity: r.examCapacity, schedulableOverride: r.schedulableOverride, homeClassroomEligibleOverride: r.homeClassroomEligibleOverride, features: [...new Set(r.features)], suitabilityOverrides: r.suitabilityOverrides, operationalStatus: r.status, createdBy: ctx.userId, updatedBy: ctx.userId } as unknown as PhysicalSpaceDoc);
  }
  const created = ((await PhysicalSpace.create(docs, { session: db, ordered: true })) as unknown as { toObject(): PhysicalSpaceDoc }[]).map((c) => c.toObject());
  for (const d of created) {
    await recordSpaceAudit(ctx, db, { entityType: 'physical_space', entityId: d._id, action: 'physical_space.created', locationId: d.locationId, metadata: { spaceCode: d.spaceCode, source } });
    await emitSpaceEvent(db, ctx.tenantId, 'physical_space.created', { spaceId: d._id, locationId: d.locationId, spaceTypeId: d.spaceTypeId });
  }
  return created;
}

const mapDuplicate = (err: unknown): never => {
  if (duplicateKeyFields(err)?.includes('spaceCode')) throw new AppError('SPACE_CODE_TAKEN');
  throw err;
};

export async function createSpace(ctx: ServiceContext, data: CreateSpaceData): Promise<SpaceDTO> {
  await ensureSystemTypes(ctx);
  const [doc] = await withTransaction((db) => insertSpaces(ctx, db, [toInsert(data)], 'single')).catch(mapDuplicate);
  return toSpaceDTOOne(ctx, doc!, await todayFor(ctx));
}

export async function createSpacesBulk(ctx: ServiceContext, data: BulkCreateSpacesData): Promise<BulkCreateResultDTO> {
  await ensureSystemTypes(ctx);
  const docs = await withTransaction((db) => insertSpaces(ctx, db, data.spaces.map(toInsert), 'bulk')).catch(mapDuplicate);
  return { created: await toSpaceDTOs(ctx, docs, await todayFor(ctx)) };
}

// ───────────────────────────────────────────────────────────── list and read

/** The visible ids that have no academic capacity but should: worked out in code, because the answer depends on the type and the overrides. */
async function missingCapacityIds(base: Record<string, unknown>, types: SpaceTypeDoc[]): Promise<string[]> {
  const indoorNoCap = types.filter((t) => !t.isOutdoor && t.defaultAcademicCapacity === null).map((t) => t._id);
  const rows = await PhysicalSpace.find({ ...base, academicCapacity: null, spaceTypeId: { $in: indoorNoCap }, operationalStatus: { $ne: 'ARCHIVED' } }).lean<PhysicalSpaceDoc[]>();
  const typeOf = new Map(types.map((t) => [t._id, t]));
  return rows.filter((r) => isMissingCapacity(typeOf.get(r.spaceTypeId)!, resolveSpace(r, typeOf.get(r.spaceTypeId)!))).map((r) => r._id);
}

export async function buildSpaceFilter(ctx: ServiceContext, scope: SpaceScope, query: Partial<ListSpacesQuery>): Promise<Record<string, unknown>> {
  await ensureSystemTypes(ctx);
  const types = await SpaceType.find({ tenantId: ctx.tenantId }).lean<SpaceTypeDoc[]>();
  const idsOf = (pred: (t: SpaceTypeDoc) => boolean) => types.filter(pred).map((t) => t._id);
  const excluded = idsOf((t) => SCHEDULING_EXCLUDED_TYPE_CODES.includes(t.code));
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
  const and: Record<string, unknown>[] = [];

  if (query.locationId) {
    await assertInScope(ctx, scope, query.locationId, 'location', query.locationId);
    filter.locationId = query.locationId;
  } else if (!scope.all) filter.locationId = { $in: scope.locationIds };

  if (query.buildingId) filter.buildingId = query.buildingId;
  if (query.floorId) filter.floorId = query.floorId;
  if (query.spaceTypeId) filter.spaceTypeId = query.spaceTypeId;
  if (query.outdoor !== undefined && !query.buildingId) filter.buildingId = query.outdoor ? null : { $ne: null };
  if (query.status?.length) filter.operationalStatus = { $in: query.status };
  if (query.feature) filter.features = query.feature;
  if (query.q) {
    const rx = new RegExp(escapeRegex(query.q), 'i');
    and.push({ $or: [{ spaceName: rx }, { spaceCode: rx }, { roomNumber: rx }] });
  }

  // A teacher sees only rooms that can be scheduled, are active and are not under an inactive floor or building.
  const schedulable = scope.all ? query.schedulable : true;
  if (schedulable !== undefined) {
    const yes = idsOf((t) => t.isSchedulable && !excluded.includes(t._id));
    const no = idsOf((t) => !t.isSchedulable);
    and.push(
      schedulable
        ? { spaceTypeId: { $nin: excluded }, $or: [{ schedulableOverride: true }, { schedulableOverride: null, spaceTypeId: { $in: yes } }] }
        : { $or: [{ spaceTypeId: { $in: [...excluded, ...no] }, schedulableOverride: { $ne: true } }, { schedulableOverride: false }, { spaceTypeId: { $in: excluded } }] },
    );
  }
  if (!scope.all) {
    filter.operationalStatus = 'ACTIVE';
    const [floors, buildings] = await Promise.all([Floor.find({ tenantId: ctx.tenantId, status: { $ne: 'ACTIVE' } }).select('_id').lean<{ _id: string }[]>(), Building.find({ tenantId: ctx.tenantId, status: { $ne: 'ACTIVE' } }).select('_id').lean<{ _id: string }[]>()]);
    and.push({ floorId: { $nin: floors.map((f) => f._id) }, buildingId: { $nin: buildings.map((b) => b._id) } });
  }
  if (query.homeClassroomEligible !== undefined) {
    const yes = idsOf((t) => t.isHomeClassroomEligible);
    and.push(
      query.homeClassroomEligible
        ? { $or: [{ homeClassroomEligibleOverride: true }, { homeClassroomEligibleOverride: null, spaceTypeId: { $in: yes } }] }
        : { $or: [{ homeClassroomEligibleOverride: false }, { homeClassroomEligibleOverride: null, spaceTypeId: { $nin: yes } }] },
    );
  }
  if (query.tag) {
    const withTag = idsOf((t) => t.defaultSuitabilityTags.includes(query.tag!));
    and.push({ $or: [{ suitabilityOverrides: query.tag }, { suitabilityOverrides: null, spaceTypeId: { $in: withTag } }] });
  }
  if (query.missingCapacity !== undefined) {
    const ids = await missingCapacityIds({ ...filter, ...(and.length ? { $and: and } : {}) }, types);
    and.push(query.missingCapacity ? { _id: { $in: ids } } : { _id: { $nin: ids } });
  }
  if (and.length > 0) filter.$and = and;
  return filter;
}

export async function listSpaces(ctx: ServiceContext, query: ListSpacesQuery): Promise<SpaceListDTO> {
  const scope = await spaceScope(ctx);
  const filter = await buildSpaceFilter(ctx, scope, query);
  const [docs, total, today] = await Promise.all([
    PhysicalSpace.find(filter).sort({ spaceCode: 1 }).collation({ locale: 'en', numericOrdering: true }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<PhysicalSpaceDoc[]>(),
    PhysicalSpace.countDocuments(filter),
    todayFor(ctx),
  ]);
  return { items: await toSpaceDTOs(ctx, docs, today), total, page: query.page, pageSize: query.pageSize };
}

/** Loads a room the caller may see. A teacher is refused (404) for a room they could not schedule; another campus is a 403. */
export async function loadVisibleSpace(ctx: ServiceContext, id: string, db?: ClientSession): Promise<PhysicalSpaceDoc> {
  const doc = await loadSpace(ctx, id, db);
  const scope = await spaceScope(ctx);
  await assertInScope(ctx, scope, doc.locationId, 'space', id);
  if (!scope.all) {
    const type = await loadSpaceType(ctx, doc.spaceTypeId, db);
    if (!resolveSpace(doc, type).schedulable.value) throw AppError.notFound('Room not found.');
  }
  return doc;
}

/** The room as other modules see it: where it is, its final settings, whether it is open, and what blocks it. */
export async function getSpaceContext(ctx: ServiceContext, id: string): Promise<SpaceContextDTO> {
  const doc = await loadVisibleSpace(ctx, id);
  const today = await todayFor(ctx);
  const [dto, location, blocks] = await Promise.all([
    toSpaceDTOOne(ctx, doc, today),
    loadLocation(ctx, doc.locationId),
    SpaceAvailabilityBlock.find({ tenantId: ctx.tenantId, physicalSpaceId: id, status: 'ACTIVE', endDatetime: { $gt: new Date() } }).sort({ startDatetime: 1 }).limit(10).lean<SpaceAvailabilityBlockDoc[]>(),
  ]);
  const now = new Date();
  const dtos = blocks.map((b) => toBlockDTO(b, now));
  return { ...dto, locationName: location.displayName, path: pathOf(dto), activeBlock: dtos.find((b) => b.phase === 'NOW') ?? null, upcomingBlocks: dtos.filter((b) => b.phase === 'UPCOMING'), homeClassroom: null };
}

// ───────────────────────────────────────────────────────────── change one room

export interface SpaceChanges {
  spaceName?: string;
  roomNumber?: string | null;
  spaceTypeId?: string;
  physicalCapacity?: number | null;
  academicCapacity?: number | null;
  examCapacity?: number | null;
  schedulableOverride?: boolean | null;
  homeClassroomEligibleOverride?: boolean | null;
  suitabilityOverrides?: SuitabilityTagCode[] | null;
  features?: SpaceFeatureCode[];
  addFeatures?: SpaceFeatureCode[];
  removeFeatures?: SpaceFeatureCode[];
  addTags?: SuitabilityTagCode[];
  removeTags?: SuitabilityTagCode[];
  status?: SpaceTargetStatus;
}

const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** What a type change will do, in words: the final values before and after, and what gets looked at again. */
export async function previewConversionFor(ctx: ServiceContext, room: PhysicalSpaceDoc, from: SpaceTypeDoc, to: SpaceTypeDoc, db?: ClientSession): Promise<TypeConversionPreviewDTO> {
  const before = resolveSpace(room, from);
  const after = resolveSpace(room, to);
  const changes: TypeConversionPreviewDTO['changes'] = [];
  const push = (field: TypeConversionPreviewDTO['changes'][number]['field'], label: string, a: unknown, b: unknown) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) changes.push({ field, label, from: a, to: b });
  };
  push('schedulable', 'Can be scheduled', before.schedulable.value, after.schedulable.value);
  push('homeClassroomEligible', 'Can be a Home Classroom', before.homeClassroomEligible.value, after.homeClassroomEligible.value);
  push('academicCapacity', 'Seats for classes', before.academicCapacity.value, after.academicCapacity.value);
  push('suitabilityTags', 'Suitable for', before.suitabilityTags.value, after.suitabilityTags.value);
  const rechecks = ['The room is marked for a scheduling-readiness check, so the Timetable looks at it again.'];
  rechecks.push(...(await conversionWarnings({ tenantId: ctx.tenantId, physicalSpaceId: room._id, session: db, homeClassroomEligibleAfter: after.homeClassroomEligible.value })));
  return { from: { spaceTypeId: from._id, name: from.name }, to: { spaceTypeId: to._id, name: to.name }, changes, rechecks };
}

export async function previewConversion(ctx: ServiceContext, id: string, spaceTypeId: string): Promise<TypeConversionPreviewDTO> {
  const room = await loadVisibleSpace(ctx, id);
  const [from, to] = await Promise.all([loadSpaceType(ctx, room.spaceTypeId), loadSpaceType(ctx, spaceTypeId)]);
  return previewConversionFor(ctx, room, from, to);
}

/**
 * The one place a room changes (single edit, status change, feature and tag changes, bulk edit). It checks the rules, writes the row
 * (with the `version` guard when one is given), the history rows, the audit event and the domain events — all in the caller's transaction.
 * Returns true when something changed.
 */
export async function applySpaceChanges(ctx: ServiceContext, db: ClientSession, before: PhysicalSpaceDoc, changes: SpaceChanges, opts: { version?: number; confirm?: boolean; reason?: string | null } = {}): Promise<boolean> {
  assertSpaceWritable(before);
  if (opts.version !== undefined) assertVersion(before.version, opts.version);
  const touchesCapacity = ['physicalCapacity', 'academicCapacity', 'examCapacity'].some((k) => (changes as Record<string, unknown>)[k] !== undefined);
  if (touchesCapacity) requireCan(ctx, 'space:capacity:manage');
  if (changes.features || changes.addFeatures || changes.removeFeatures || changes.addTags || changes.removeTags || changes.suitabilityOverrides !== undefined) requireCan(ctx, 'space:features:manage');
  assertCapacities({ physicalCapacity: changes.physicalCapacity, academicCapacity: changes.academicCapacity, examCapacity: changes.examCapacity });

  const set: Partial<PhysicalSpaceDoc> = {};
  const currentType = await loadSpaceType(ctx, before.spaceTypeId, db);
  let type = currentType;
  const log: { type: 'RENAME' | 'TYPE_CONVERSION'; from: string; to: string }[] = [];

  if (changes.spaceName !== undefined && changes.spaceName !== before.spaceName) {
    set.spaceName = changes.spaceName;
    log.push({ type: 'RENAME', from: before.spaceName, to: changes.spaceName });
  }
  if (changes.roomNumber !== undefined) set.roomNumber = changes.roomNumber;
  for (const k of ['physicalCapacity', 'academicCapacity', 'examCapacity', 'schedulableOverride', 'homeClassroomEligibleOverride'] as const) {
    if (changes[k] !== undefined) (set as Record<string, unknown>)[k] = changes[k];
  }

  if (changes.spaceTypeId && changes.spaceTypeId !== before.spaceTypeId) {
    type = await loadSpaceType(ctx, changes.spaceTypeId, db);
    if (type.status !== 'ACTIVE') throw AppError.validation({ spaceTypeId: 'This room type is inactive. Choose another one.' });
    if (type.isOutdoor !== currentType.isOutdoor) throw AppError.validation({ spaceTypeId: type.isOutdoor ? 'A room inside a building cannot become an outdoor space. Archive it and add a new one.' : 'An outdoor space cannot become a room inside a building. Archive it and add a new one.' });
    const preview = await previewConversionFor(ctx, before, currentType, type, db);
    if (!opts.confirm) throw new AppError('CONFIRMATION_REQUIRED', undefined, { kind: 'TYPE_CONVERSION', preview });
    set.spaceTypeId = type._id;
    set.readinessRecheckAt = new Date();
    log.push({ type: 'TYPE_CONVERSION', from: currentType.name, to: type.name });
  }

  if (changes.features) set.features = [...new Set(changes.features)];
  if (changes.addFeatures || changes.removeFeatures) {
    const next = new Set(set.features ?? before.features);
    changes.addFeatures?.forEach((f) => next.add(f));
    changes.removeFeatures?.forEach((f) => next.delete(f));
    set.features = [...next];
  }
  if (changes.suitabilityOverrides !== undefined) set.suitabilityOverrides = changes.suitabilityOverrides;
  if (changes.addTags || changes.removeTags) {
    const next = new Set(resolveSpace({ ...before, ...set } as PhysicalSpaceDoc, type).suitabilityTags.value);
    changes.addTags?.forEach((t) => next.add(t));
    changes.removeTags?.forEach((t) => next.delete(t));
    // Only exceptions are stored: a list that matches the type's own is the same as following the type.
    set.suitabilityOverrides = same([...next], type.defaultSuitabilityTags) ? null : ([...next] as SuitabilityTagCode[]);
  }
  if (changes.status) set.operationalStatus = assertSpaceTransition(before.operationalStatus, changes.status);

  const after = { ...before, ...set } as PhysicalSpaceDoc;
  const auditChanges = diffFields(before, after, AUDITED);
  if (auditChanges.length === 0) return false;

  const updated = await PhysicalSpace.findOneAndUpdate({ _id: before._id, tenantId: ctx.tenantId, version: before.version }, { $set: { ...set, updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean();
  if (!updated) throw new AppError('VERSION_CONFLICT');
  if (log.length > 0) await SpaceChangeLog.create(log.map((l) => ({ tenantId: ctx.tenantId, physicalSpaceId: before._id, type: l.type, from: l.from, to: l.to, reason: opts.reason ?? null, actorId: ctx.userId })), { session: db, ordered: true });

  const action = set.operationalStatus ? 'physical_space.status_changed' : log.some((l) => l.type === 'TYPE_CONVERSION') ? 'physical_space.type_converted' : 'physical_space.updated';
  await recordSpaceAudit(ctx, db, { entityType: 'physical_space', entityId: before._id, action, changes: auditChanges, locationId: before.locationId, metadata: opts.reason ? { reason: opts.reason } : undefined });

  const events: [SpaceEventType, Record<string, unknown>][] = [];
  const fields = auditChanges.map((c) => c.field).filter((f) => f !== 'operationalStatus');
  const base = { spaceId: before._id, locationId: before.locationId };
  if (fields.length > 0) events.push(['physical_space.updated', { ...base, fields }]);
  if (fields.some((f) => ['physicalCapacity', 'academicCapacity', 'examCapacity', 'spaceTypeId'].includes(f))) events.push(['physical_space.capacity.changed', base]);
  if (set.operationalStatus) {
    events.push(['physical_space.status.changed', { ...base, from: before.operationalStatus, to: set.operationalStatus }]);
    if (before.operationalStatus === 'ACTIVE') events.push(['physical_space.unavailable', base]);
    else if (set.operationalStatus === 'ACTIVE') events.push(['physical_space.available', base]);
  }
  for (const [type2, payload] of events) await emitSpaceEvent(db, ctx.tenantId, type2, payload);
  return true;
}

async function changeOne(ctx: ServiceContext, id: string, changes: SpaceChanges, opts: Parameters<typeof applySpaceChanges>[4] = {}): Promise<SpaceDTO> {
  const before = await loadVisibleSpace(ctx, id);
  await withTransaction((db) => applySpaceChanges(ctx, db, before, changes, opts));
  return toSpaceDTOOne(ctx, await loadSpace(ctx, id), await todayFor(ctx));
}

export async function updateSpace(ctx: ServiceContext, id: string, data: UpdateSpaceData): Promise<SpaceDTO> {
  const { version, confirm, ...changes } = data;
  return changeOne(ctx, id, changes as SpaceChanges, { version, confirm });
}

export async function changeSpaceStatus(ctx: ServiceContext, id: string, to: SpaceTargetStatus, reason: string | null): Promise<SpaceDTO> {
  return changeOne(ctx, id, { status: to }, { reason });
}

export async function changeFeatures(ctx: ServiceContext, id: string, data: FeatureChangeData): Promise<SpaceDTO> {
  return changeOne(ctx, id, { addFeatures: data.add, removeFeatures: data.remove });
}

export async function changeTags(ctx: ServiceContext, id: string, data: TagChangeData): Promise<SpaceDTO> {
  return changeOne(ctx, id, { addTags: data.add, removeTags: data.remove });
}

// ───────────────────────────────────────────────────────────── bulk edit

class DryRunDone extends Error {}

/** Applies the same change to many rooms. Each room is its own transaction, so one that cannot change never stops the others. */
export async function bulkEditSpaces(ctx: ServiceContext, data: BulkEditData): Promise<BulkEditResultDTO> {
  const c = data.changes;
  if (c.spaceTypeId && !data.confirm && !data.dryRun) throw new AppError('CONFIRMATION_REQUIRED', undefined, { kind: 'TYPE_CONVERSION' });
  if (c.physicalCapacity !== undefined || c.academicCapacity !== undefined || c.examCapacity !== undefined) requireCan(ctx, 'space:capacity:manage');
  if (c.addFeatures || c.removeFeatures || c.addTags || c.removeTags) requireCan(ctx, 'space:features:manage');
  const scope = await spaceScope(ctx);
  const found = await PhysicalSpace.find({ tenantId: ctx.tenantId, _id: { $in: data.ids } }).lean<PhysicalSpaceDoc[]>();
  const byId = new Map(found.map((r) => [r._id, r]));
  const done: BulkEditResultDTO['done'] = [];
  const skipped: BulkEditResultDTO['skipped'] = [];
  const changes: SpaceChanges = { ...c };

  for (const id of data.ids) {
    const room = byId.get(id);
    if (!room) {
      skipped.push({ spaceId: id, spaceCode: null, reason: 'Room not found.' });
      continue;
    }
    try {
      if (!scope.all && !scope.locationIds.includes(room.locationId)) throw new AppError('FORBIDDEN', "You don't have access to this campus.");
      const changed = await withTransaction(async (db) => {
        const result = await applySpaceChanges(ctx, db, room, changes, { confirm: data.confirm || data.dryRun });
        if (data.dryRun) throw Object.assign(new DryRunDone(), { changed: result });
        return result;
      }).catch((err: unknown) => {
        if (err instanceof DryRunDone) return (err as unknown as { changed: boolean }).changed;
        throw err;
      });
      if (changed) done.push({ spaceId: id, spaceCode: room.spaceCode });
      else skipped.push({ spaceId: id, spaceCode: room.spaceCode, reason: 'Nothing to change. It already looks like this.' });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      skipped.push({ spaceId: id, spaceCode: room.spaceCode, reason: err.message });
    }
  }
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;
  const message = data.dryRun
    ? `${n(done.length, 'room will change', 'rooms will change')}${skipped.length ? `, ${n(skipped.length, 'will be skipped', 'will be skipped')}` : ''}.`
    : `${n(done.length, 'room changed', 'rooms changed')}${skipped.length ? `, ${n(skipped.length, 'skipped', 'skipped')}` : ''}.`;
  return { dryRun: Boolean(data.dryRun), done, skipped, message };
}

export const bulkFeatures = (ctx: ServiceContext, data: BulkFeatureChangeData) => bulkEditSpaces(ctx, { ids: data.ids, changes: { addFeatures: data.add, removeFeatures: data.remove } });
export const bulkTags = (ctx: ServiceContext, data: BulkTagChangeData) => bulkEditSpaces(ctx, { ids: data.ids, changes: { addTags: data.add, removeTags: data.remove } });

export type { SpaceLookups, SpaceStatus };
export { loadLookups, toSpaceDTO };
