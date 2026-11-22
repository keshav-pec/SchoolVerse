import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type {
  AssignmentChangeResultDTO,
  AssignmentSource,
  AssignmentWarningDTO,
  BulkAssignmentResultDTO,
  BulkAssignmentsData,
  CreateAssignmentData,
  EndHomeClassroomData,
  HomeClassroomDTO,
  HomeClassroomListDTO,
  ListAssignmentsQuery,
  ReplaceAssignmentData,
  SectionHomeClassroomDTO,
  SpaceEventType,
  UpdateAssignmentData,
} from '@shared';
import { addDays } from '../../core/dates';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { SectionOffering } from '../academic/offering.model';
import { overlapping, todayFor } from '../staff/status';
import { emitSpaceEvent, recordSpaceAudit } from './audit';
import { endOf, niceDate, periodsOverlap, runsOn, shiftsClash } from './assignment.rules';
import { loadCandidatePool, smallestFit } from './candidates';
import { assertInScope, assertLocationAccess, assertVersion, loadSpace, spaceScope } from './guards';
import { toHomeClassroomDTOs } from './home-classroom.mappers';
import { blocksInPeriod, loadRoomFactsFor, toRoomRef, type RoomFacts } from './rooms';
import { assertSessionWritable, clampDate, loadSectionFacts, requireSectionFacts, strengthOf, type SectionFacts } from './sections';
import { PhysicalSpace, SectionSpaceAssignment, SpaceAssignmentLock, type CapacityOverrideDoc, type SectionSpaceAssignmentDoc } from './space.models';

/**
 * SPACE-32 to 34, 37, 38 — Home Classroom assignments. A section's room for a period, effective-dated:
 *   - changing a room ends the old row the day before and starts a new one (nothing is overwritten);
 *   - every rule in `validateAssignment` runs inside the same transaction that saves the row;
 *   - two requests for one room (or one section) at once cannot both win: each transaction first bumps a lock row, the database makes
 *     the second one retry, and the retry sees what the first one saved.
 */

const AUDITED = ['physicalSpaceId', 'effectiveFrom', 'effectiveTo', 'shiftId', 'status', 'reason', 'assignmentSource'] as const;

export interface AssignInput {
  sectionOfferingId: string;
  physicalSpaceId: string;
  academicSessionId?: string;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  shiftId?: string | null;
  reason?: string | null;
  capacityOverride?: { reason: string };
  replaceExisting?: boolean;
  source: AssignmentSource;
}

// ───────────────────────────────────────────────────────────── locks

export const roomLock = (id: string) => `ROOM:${id}`;
export const sectionLock = (id: string) => `SECTION:${id}`;

/** Makes sure each lock row exists. Done before the transaction, so the transaction itself only ever updates. */
async function ensureLocks(ctx: ServiceContext, keys: string[]) {
  for (const key of keys) {
    try {
      await SpaceAssignmentLock.updateOne({ tenantId: ctx.tenantId, key }, { $setOnInsert: { _id: randomUUID(), counter: 0 } }, { upsert: true });
    } catch (err) {
      // Another request made it first: that is all we wanted.
      if (!duplicateKeyFields(err)) throw err;
    }
  }
}

/** Inside the transaction: touch every lock row, in a fixed order. A second transaction touching the same row is retried by the driver. */
export async function takeLocks(ctx: ServiceContext, db: ClientSession, keys: string[]) {
  const sorted = [...new Set(keys)].sort();
  for (const key of sorted) await SpaceAssignmentLock.updateOne({ tenantId: ctx.tenantId, key }, { $inc: { counter: 1 } }, { session: db });
}

/** Locks exist for rooms and sections that exist, nothing else: an unknown id is a 404 before any lock row is made. */
export async function prepareLocks(ctx: ServiceContext, input: { sectionIds: string[]; roomIds: string[] }): Promise<string[]> {
  const sectionIds = [...new Set(input.sectionIds)];
  const roomIds = [...new Set(input.roomIds)];
  const [sections, rooms] = await Promise.all([SectionOffering.countDocuments({ tenantId: ctx.tenantId, _id: { $in: sectionIds } }), PhysicalSpace.countDocuments({ tenantId: ctx.tenantId, _id: { $in: roomIds } })]);
  if (sections !== sectionIds.length) throw AppError.notFound('Section not found.');
  if (rooms !== roomIds.length) throw AppError.notFound('Room not found.');
  const keys = [...sectionIds.map(sectionLock), ...roomIds.map(roomLock)];
  await ensureLocks(ctx, keys);
  return keys;
}

// ───────────────────────────────────────────────────────────── validation

export interface Validated {
  facts: SectionFacts;
  room: RoomFacts;
  from: string;
  to: string | null;
  strength: number;
  warnings: AssignmentWarningDTO[];
  override: CapacityOverrideDoc | null;
  /** The section's own rows this one replaces (ended the day before, or cancelled when they had not started). */
  replaces: SectionSpaceAssignmentDoc[];
}

const period = (from: string, to: string | null, sessionEnd: string) => `${niceDate(from)} to ${niceDate(to ?? sessionEnd)}`;

/**
 * Every rule for giving a room to a section, in one place and in the order the plan lists them. The first rule that fails throws its own
 * error code, with the numbers or names the screen needs. Run it inside the transaction that saves the row.
 */
export async function validateAssignment(ctx: ServiceContext, db: ClientSession, input: AssignInput, opts: { ignoreId?: string; today?: string } = {}): Promise<Validated> {
  const today = opts.today ?? (await todayFor(ctx, db));
  const facts = await requireSectionFacts(ctx, input.sectionOfferingId, today, db);
  const { section, session } = facts;
  if (input.academicSessionId && input.academicSessionId !== session._id) throw new AppError('SECTION_NOT_IN_SESSION');
  assertSessionWritable(session);
  if (section.status !== 'ACTIVE') throw new AppError('SECTION_NOT_ACTIVE');
  await assertInScope(ctx, await spaceScope(ctx), section.locationId, 'space', input.physicalSpaceId);

  const roomDoc = await loadSpace(ctx, input.physicalSpaceId, db);
  const room = (await loadRoomFactsFor(ctx, [roomDoc], today, db)).get(roomDoc._id);
  if (!room) throw AppError.notFound('Room not found.');

  // Dates: inside the session, and the end not before the start.
  const from = input.effectiveFrom ?? clampDate(today, session.startDate, session.endDate);
  const to = input.effectiveTo ?? null;
  const dateProblems: Record<string, string> = {};
  if (from < session.startDate || from > session.endDate) dateProblems.effectiveFrom = `Choose a start date inside ${session.name} (${niceDate(session.startDate)} to ${niceDate(session.endDate)}).`;
  if (to !== null && to < from) dateProblems.effectiveTo = 'The last day cannot be before the first day.';
  else if (to !== null && to > session.endDate) dateProblems.effectiveTo = `The last day must be inside ${session.name}, which ends on ${niceDate(session.endDate)}.`;
  if (Object.keys(dateProblems).length > 0) throw new AppError('ASSIGNMENT_DATES_INVALID', Object.values(dateProblems)[0], { fields: dateProblems });

  // The room: open, at the same campus, allowed to be a Home Classroom.
  if (!room.effective.available) throw new AppError(roomDoc.operationalStatus === 'ACTIVE' && room.effective.status === 'ACTIVE' ? 'ROOM_PARENT_INACTIVE' : 'ROOM_NOT_ACTIVE', room.effective.reason ?? undefined, { physicalSpaceId: roomDoc._id });
  if (roomDoc.locationId !== section.locationId) throw new AppError('ROOM_OTHER_CAMPUS', undefined, { physicalSpaceId: roomDoc._id });
  if (room.type.isOutdoor || !room.resolved.homeClassroomEligible.value) throw new AppError('ROOM_NOT_ELIGIBLE', `${roomDoc.spaceName} is a ${room.type.name}, which cannot be a Home Classroom.`, { physicalSpaceId: roomDoc._id });
  if (roomDoc.archiveAfterDate && endOf({ effectiveTo: to }, session.endDate) >= roomDoc.archiveAfterDate) throw new AppError('ROOM_ARCHIVING', `${roomDoc.spaceName} is due to be archived on ${niceDate(roomDoc.archiveAfterDate)}, before these dates end.`, { physicalSpaceId: roomDoc._id });

  // Nobody else has the room for these dates (no shift = any overlap is a clash; two different named shifts may share it).
  const roomRows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, physicalSpaceId: roomDoc._id, academicSessionId: session._id, status: { $ne: 'CANCELLED' }, ...(opts.ignoreId ? { _id: { $ne: opts.ignoreId } } : {}), ...overlapping(from, to) }).session(db).lean<SectionSpaceAssignmentDoc[]>();
  const clash = roomRows.find((r) => r.sectionOfferingId !== section._id && shiftsClash(r.shiftId, input.shiftId ?? null) && periodsOverlap(r, { effectiveFrom: from, effectiveTo: to }, session.endDate));
  if (clash) {
    const other = (await loadSectionFacts(ctx, [clash.sectionOfferingId], today, db)).get(clash.sectionOfferingId);
    throw new AppError('ROOM_ALREADY_ASSIGNED', `${other?.label ?? 'Another section'} already uses ${roomDoc.spaceName} from ${period(clash.effectiveFrom, clash.effectiveTo, session.endDate)}.`, { physicalSpaceId: roomDoc._id, takenBy: other?.label ?? null, assignmentId: clash._id, hint: 'Pick another room, or give the sections different shifts.' });
  }

  // One Home Classroom per section at a time.
  const sectionRows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, sectionOfferingId: section._id, academicSessionId: session._id, status: { $ne: 'CANCELLED' }, ...(opts.ignoreId ? { _id: { $ne: opts.ignoreId } } : {}), ...overlapping(from, to) }).session(db).lean<SectionSpaceAssignmentDoc[]>();
  const replaces = sectionRows.filter((r) => periodsOverlap(r, { effectiveFrom: from, effectiveTo: to }, session.endDate));
  if (replaces.length > 0) {
    const sameRoom = replaces.find((r) => r.physicalSpaceId === roomDoc._id);
    if (sameRoom) throw new AppError('HOME_CLASSROOM_EXISTS', `${facts.label} already uses ${roomDoc.spaceName} for these dates.`, { assignmentId: sameRoom._id, sameRoom: true });
    if (!input.replaceExisting) {
      const current = replaces[0]!;
      throw new AppError('HOME_CLASSROOM_EXISTS', undefined, { assignmentId: current._id, physicalSpaceId: current.physicalSpaceId, sameRoom: false, actions: ['REPLACE_ROOM'] });
    }
    if (to !== null && replaces.some((r) => endOf(r, session.endDate) > to)) {
      throw new AppError('ASSIGNMENT_DATES_INVALID', 'To change the room for only part of the year, leave the last day empty. Otherwise the section would be left without a room afterwards.', { fields: { effectiveTo: 'Leave this empty to keep the new room until the session ends.' } });
    }
  }

  // Seats: a short room needs a reason from someone allowed to override; the numbers are counted live, never typed.
  const strength = (await strengthOf(ctx, [facts], db)).get(section._id) ?? 0;
  const capacity = room.resolved.academicCapacity.value;
  const warnings: AssignmentWarningDTO[] = [];
  let override: CapacityOverrideDoc | null = null;
  if (capacity === null) warnings.push({ code: 'CAPACITY_UNKNOWN', message: `${roomDoc.spaceName} has no seat count yet, so the fit could not be checked. Set its seats for classes.` });
  else if (strength > capacity) {
    if (!input.capacityOverride) {
      const pool = await loadCandidatePool(ctx, { locationId: section.locationId, sessionId: session._id, from, to: to ?? session.endDate }, today, { db, ignoreSectionIds: new Set([section._id]) });
      const larger = smallestFit(pool.free, strength);
      throw new AppError('ROOM_TOO_SMALL', `${facts.label} has ${strength} students, but ${roomDoc.spaceName} holds ${capacity}.`, {
        sectionStrength: strength,
        roomCapacity: capacity,
        shortBy: strength - capacity,
        actions: ['CHOOSE_LARGER_ROOM', 'KEEP_ROOM_ANYWAY'],
        suggestedRoom: larger ? toRoomRef(larger) : null,
      });
    }
    override = { reason: input.capacityOverride.reason, byUserId: ctx.userId, at: new Date(), strength, capacity };
    warnings.push({ code: 'ROOM_TOO_SMALL', message: `${strength} students in a room for ${capacity}. Kept on purpose: ${input.capacityOverride.reason}` });
  }

  // A closure during the period is a warning only: the Home Classroom stays.
  const blocks = (await blocksInPeriod(ctx, [roomDoc._id], from, to ?? session.endDate, db)).get(roomDoc._id) ?? [];
  for (const b of blocks) warnings.push({ code: 'BLOCK_IN_PERIOD', message: `${roomDoc.spaceName} is marked ${b.blockType === 'RESTRICTED' ? 'restricted' : 'unavailable'} from ${niceDate(toIso(b.startDatetime)!.slice(0, 10))} to ${niceDate(toIso(b.endDatetime)!.slice(0, 10))}. The assignment is kept.` });

  return { facts, room, from, to, strength, warnings, override, replaces };
}

// ───────────────────────────────────────────────────────────── create

const ACTION_FOR_SOURCE: Partial<Record<AssignmentSource, string>> = {
  SYSTEM_RECOMMENDED: 'section_space_assignment.recommendation_accepted',
  PREVIOUS_SESSION_COPY: 'section_space_assignment.previous_session_copy',
};

function eventPayload(row: SectionSpaceAssignmentDoc, extra: Record<string, unknown> = {}) {
  return { assignmentId: row._id, sectionOfferingId: row.sectionOfferingId, physicalSpaceId: row.physicalSpaceId, academicSessionId: row.academicSessionId, locationId: row.locationId, ...extra };
}

/** Ends a replaced row the day before the new one starts, or cancels it when it never started. */
async function retire(ctx: ServiceContext, db: ClientSession, old: SectionSpaceAssignmentDoc, newFrom: string, replacedBy: string) {
  const cancel = old.effectiveFrom >= newFrom;
  const set = cancel ? { status: 'CANCELLED' as const } : { status: 'ENDED' as const, effectiveTo: addDays(newFrom, -1) };
  const after = await SectionSpaceAssignment.findOneAndUpdate({ _id: old._id, tenantId: ctx.tenantId, version: old.version }, { $set: { ...set, updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean<SectionSpaceAssignmentDoc>();
  if (!after) throw new AppError('VERSION_CONFLICT');
  await recordSpaceAudit(ctx, db, { entityType: 'section_space_assignment', entityId: old._id, action: 'section_space_assignment.replaced', changes: diffFields(old, after, AUDITED), locationId: old.locationId, metadata: { replacedBy, sectionOfferingId: old.sectionOfferingId } });
  return after;
}

/** Saves one assignment inside the caller's transaction (locks already taken). Used by the single, bulk, rollover and replace flows. */
export async function insertAssignment(ctx: ServiceContext, db: ClientSession, input: AssignInput, opts: { today?: string } = {}): Promise<{ row: SectionSpaceAssignmentDoc; retired: SectionSpaceAssignmentDoc[]; validated: Validated }> {
  const validated = await validateAssignment(ctx, db, input, opts);
  const { facts, room, from, to, override } = validated;
  const id = randomUUID();
  const [created] = await SectionSpaceAssignment.create(
    [
      {
        _id: id,
        tenantId: ctx.tenantId,
        academicSessionId: facts.session._id,
        sectionOfferingId: facts.section._id,
        physicalSpaceId: room.space._id,
        locationId: facts.section.locationId,
        shiftId: input.shiftId ?? null,
        effectiveFrom: from,
        effectiveTo: to,
        assignmentSource: input.source,
        status: 'ACTIVE',
        capacityOverride: override,
        assignedBy: ctx.userId,
        reason: input.reason ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ],
    { session: db },
  );
  const row = created!.toObject() as SectionSpaceAssignmentDoc;
  const retired: SectionSpaceAssignmentDoc[] = [];
  for (const old of validated.replaces) retired.push(await retire(ctx, db, old, from, id));

  const replaced = retired.length > 0;
  await recordSpaceAudit(ctx, db, {
    entityType: 'section_space_assignment',
    entityId: id,
    action: ACTION_FOR_SOURCE[input.source] ?? (replaced ? 'section_space_assignment.replaced_room' : 'section_space_assignment.created'),
    changes: diffFields({}, row, AUDITED),
    locationId: row.locationId,
    metadata: { sectionOfferingId: row.sectionOfferingId, physicalSpaceId: row.physicalSpaceId, academicSessionId: row.academicSessionId, source: input.source, replacedAssignmentIds: retired.map((r) => r._id), label: facts.label },
  });
  if (override) {
    await recordSpaceAudit(ctx, db, { entityType: 'section_space_assignment', entityId: id, action: 'section_space_assignment.capacity_override', locationId: row.locationId, metadata: { reason: override.reason, strength: override.strength, capacity: override.capacity, label: facts.label, roomName: room.space.spaceName } });
  }
  await emitSpaceEvent(db, ctx.tenantId, (replaced ? 'section.home_classroom.changed' : 'section.home_classroom.assigned') as SpaceEventType, eventPayload(row, replaced ? { previousPhysicalSpaceId: retired[0]!.physicalSpaceId } : {}));
  return { row, retired, validated };
}

async function loadRow(ctx: ServiceContext, id: string, db?: ClientSession): Promise<SectionSpaceAssignmentDoc> {
  const row = await SectionSpaceAssignment.findOne({ _id: id, tenantId: ctx.tenantId }).session(db ?? null).lean<SectionSpaceAssignmentDoc>();
  if (!row) throw AppError.notFound('Home Classroom assignment not found.');
  return row;
}

async function visibleRow(ctx: ServiceContext, id: string): Promise<SectionSpaceAssignmentDoc> {
  const row = await loadRow(ctx, id);
  await assertInScope(ctx, await spaceScope(ctx), row.locationId, 'space', row.physicalSpaceId);
  return row;
}

async function toResult(ctx: ServiceContext, row: SectionSpaceAssignmentDoc, retired: SectionSpaceAssignmentDoc[], warnings: AssignmentWarningDTO[], today: string): Promise<AssignmentChangeResultDTO> {
  const [assignment, replaced] = await toHomeClassroomDTOs(ctx, [row, ...retired.slice(0, 1)], today);
  return { assignment: assignment!, replaced: retired.length > 0 ? (replaced ?? null) : null, warnings };
}

export async function assignRoom(ctx: ServiceContext, data: CreateAssignmentData | (AssignInput & { source: AssignmentSource })): Promise<AssignmentChangeResultDTO> {
  const input: AssignInput = { ...data, source: 'source' in data ? data.source : 'MANUAL' };
  const keys = await prepareLocks(ctx, { sectionIds: [input.sectionOfferingId], roomIds: [input.physicalSpaceId] });
  const { row, retired, validated } = await withTransaction(async (db) => {
    await takeLocks(ctx, db, keys);
    return insertAssignment(ctx, db, input);
  });
  return toResult(ctx, row, retired, validated.warnings, await todayFor(ctx));
}

/** "Replace Room" on a current row: the same section, another room, from a date (default today). */
export async function replaceRoomOfAssignment(ctx: ServiceContext, id: string, data: ReplaceAssignmentData): Promise<AssignmentChangeResultDTO> {
  const old = await visibleRow(ctx, id);
  if (old.status === 'CANCELLED') throw new AppError('ASSIGNMENT_NOT_ACTIVE');
  const today = await todayFor(ctx);
  // The new room starts when asked, or today; a row that has not started yet is simply swapped.
  const from = data.effectiveFrom ?? (old.effectiveFrom > today ? old.effectiveFrom : today);
  return assignRoom(ctx, { sectionOfferingId: old.sectionOfferingId, physicalSpaceId: data.physicalSpaceId, effectiveFrom: from, effectiveTo: old.effectiveTo, shiftId: data.shiftId ?? old.shiftId, reason: data.reason ?? null, capacityOverride: data.capacityOverride, replaceExisting: true, source: 'MANUAL' });
}

// ───────────────────────────────────────────────────────────── change, end, cancel

export async function updateAssignment(ctx: ServiceContext, id: string, data: UpdateAssignmentData): Promise<AssignmentChangeResultDTO> {
  const before = await visibleRow(ctx, id);
  const keys = await prepareLocks(ctx, { sectionIds: [before.sectionOfferingId], roomIds: [before.physicalSpaceId] });
  const today = await todayFor(ctx);
  const { after, validated } = await withTransaction(async (db) => {
    await takeLocks(ctx, db, keys);
    const current = await loadRow(ctx, id, db);
    if (current.status !== 'ACTIVE') throw new AppError('ASSIGNMENT_NOT_ACTIVE');
    assertVersion(current.version, data.version);
    // A row that has started keeps its first day: it is the record of when the room began to be used.
    if (data.effectiveFrom !== undefined && data.effectiveFrom !== current.effectiveFrom && current.effectiveFrom <= today) {
      throw new AppError('ASSIGNMENT_DATES_INVALID', 'This Home Classroom has already started, so its first day cannot change. End it and add a new one instead.', { fields: { effectiveFrom: 'The first day of a running assignment cannot change.' } });
    }
    const next = { effectiveFrom: data.effectiveFrom ?? current.effectiveFrom, effectiveTo: data.effectiveTo === undefined ? current.effectiveTo : data.effectiveTo, shiftId: data.shiftId === undefined ? current.shiftId : data.shiftId, reason: data.reason === undefined ? current.reason : data.reason };
    const validated = await validateAssignment(ctx, db, { sectionOfferingId: current.sectionOfferingId, physicalSpaceId: current.physicalSpaceId, ...next, capacityOverride: data.capacityOverride ?? undefined, source: current.assignmentSource }, { ignoreId: id, today });
    const set: Record<string, unknown> = { ...next, updatedBy: ctx.userId };
    if (validated.override) set.capacityOverride = validated.override;
    const updated = await SectionSpaceAssignment.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, version: current.version }, { $set: set, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean<SectionSpaceAssignmentDoc>();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    await recordSpaceAudit(ctx, db, { entityType: 'section_space_assignment', entityId: id, action: 'section_space_assignment.updated', changes: diffFields(current, updated, AUDITED), locationId: current.locationId, metadata: { sectionOfferingId: current.sectionOfferingId } });
    if (validated.override) await recordSpaceAudit(ctx, db, { entityType: 'section_space_assignment', entityId: id, action: 'section_space_assignment.capacity_override', locationId: current.locationId, metadata: { reason: validated.override.reason, strength: validated.override.strength, capacity: validated.override.capacity } });
    await emitSpaceEvent(db, ctx.tenantId, 'section.home_classroom.changed', eventPayload(updated, { fields: diffFields(current, updated, AUDITED).map((c) => c.field) }));
    return { after: updated, validated };
  });
  return toResult(ctx, after, [], validated.warnings, today);
}

/** Ends a running (or planned) Home Classroom on a last day. The row stays as history. */
export async function endAssignment(ctx: ServiceContext, id: string, data: EndHomeClassroomData): Promise<AssignmentChangeResultDTO> {
  const before = await visibleRow(ctx, id);
  const keys = await prepareLocks(ctx, { sectionIds: [before.sectionOfferingId], roomIds: [before.physicalSpaceId] });
  const today = await todayFor(ctx);
  const after = await withTransaction(async (db) => {
    await takeLocks(ctx, db, keys);
    const row = await loadRow(ctx, id, db);
    if (row.status !== 'ACTIVE') throw new AppError('ASSIGNMENT_NOT_ACTIVE');
    const session = await AcademicSession.findOne({ _id: row.academicSessionId, tenantId: ctx.tenantId }).session(db).lean<AcademicSessionDoc>();
    const sessionEnd = session?.endDate ?? row.effectiveTo ?? data.effectiveTo;
    if (data.effectiveTo < row.effectiveFrom) throw new AppError('ASSIGNMENT_DATES_INVALID', `The last day cannot be before the first day (${niceDate(row.effectiveFrom)}). To undo a Home Classroom that has not started, cancel it.`, { fields: { effectiveTo: 'Choose a day on or after the first day.' } });
    if (data.effectiveTo > endOf(row, sessionEnd)) throw new AppError('ASSIGNMENT_DATES_INVALID', 'Ending can only make the period shorter.', { fields: { effectiveTo: `Choose a day on or before ${niceDate(endOf(row, sessionEnd))}.` } });
    const updated = await SectionSpaceAssignment.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, version: row.version }, { $set: { status: 'ENDED', effectiveTo: data.effectiveTo, ...(data.reason ? { reason: data.reason } : {}), updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean<SectionSpaceAssignmentDoc>();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    await recordSpaceAudit(ctx, db, { entityType: 'section_space_assignment', entityId: id, action: 'section_space_assignment.ended', changes: diffFields(row, updated, AUDITED), locationId: row.locationId, metadata: { sectionOfferingId: row.sectionOfferingId, reason: data.reason ?? null } });
    await emitSpaceEvent(db, ctx.tenantId, 'section.home_classroom.ended', eventPayload(updated, { effectiveTo: data.effectiveTo }));
    return updated;
  });
  return toResult(ctx, after, [], [], today);
}

/** Undoes a Home Classroom that has not started yet (a mistake, or a rollover row nobody wants). One that has started is ended instead. */
export async function cancelAssignment(ctx: ServiceContext, id: string, reason: string | null): Promise<AssignmentChangeResultDTO> {
  const before = await visibleRow(ctx, id);
  const keys = await prepareLocks(ctx, { sectionIds: [before.sectionOfferingId], roomIds: [before.physicalSpaceId] });
  const today = await todayFor(ctx);
  const after = await withTransaction(async (db) => {
    await takeLocks(ctx, db, keys);
    const row = await loadRow(ctx, id, db);
    if (row.status === 'CANCELLED') throw new AppError('ASSIGNMENT_NOT_ACTIVE');
    if (row.effectiveFrom <= today) throw new AppError('ASSIGNMENT_NOT_ACTIVE', 'This Home Classroom has already started. End it on a last day instead, so the history stays.');
    const updated = await SectionSpaceAssignment.findOneAndUpdate({ _id: id, tenantId: ctx.tenantId, version: row.version }, { $set: { status: 'CANCELLED', ...(reason ? { reason } : {}), updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean<SectionSpaceAssignmentDoc>();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    await recordSpaceAudit(ctx, db, { entityType: 'section_space_assignment', entityId: id, action: 'section_space_assignment.cancelled', changes: diffFields(row, updated, AUDITED), locationId: row.locationId, metadata: { sectionOfferingId: row.sectionOfferingId, reason } });
    await emitSpaceEvent(db, ctx.tenantId, 'section.home_classroom.ended', eventPayload(updated, { cancelled: true }));
    return updated;
  });
  return toResult(ctx, after, [], [], today);
}

// ───────────────────────────────────────────────────────────── bulk

/**
 * Saves many assignments, each on its own: the ones that pass are kept, the ones that fail come back with their reason and the rest
 * still succeed. Sending the same list again is safe (a section that already has that room is reported as `alreadyDone`). Accepting
 * recommendations uses `source: SYSTEM_RECOMMENDED`.
 */
export async function bulkAssign(ctx: ServiceContext, data: BulkAssignmentsData): Promise<BulkAssignmentResultDTO> {
  const today = await todayFor(ctx);
  const labels = await loadSectionFacts(ctx, data.items.map((i) => i.sectionOfferingId), today);
  const out: BulkAssignmentResultDTO = { source: data.source, done: [], alreadyDone: [], failed: [], message: '' };
  for (const item of data.items) {
    const label = labels.get(item.sectionOfferingId)?.label ?? null;
    try {
      const { assignment } = await assignRoom(ctx, { ...item, source: data.source });
      out.done.push({ sectionOfferingId: item.sectionOfferingId, label: label ?? assignment.section.label, assignmentId: assignment.assignmentId, roomName: assignment.room.spaceName });
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      if (err.code === 'HOME_CLASSROOM_EXISTS' && err.details?.sameRoom === true) {
        const room = await loadSpace(ctx, item.physicalSpaceId).catch(() => null);
        out.alreadyDone.push({ sectionOfferingId: item.sectionOfferingId, label: label ?? '', roomName: room?.spaceName ?? '' });
      } else out.failed.push({ sectionOfferingId: item.sectionOfferingId, label, physicalSpaceId: item.physicalSpaceId, code: err.code, message: err.message });
    }
  }
  const n = (k: number) => `${k} section${k === 1 ? '' : 's'}`;
  out.message = `${n(out.done.length)} saved${out.alreadyDone.length ? `, ${out.alreadyDone.length} already had that room` : ''}${out.failed.length ? `, ${out.failed.length} could not be saved` : ''}.`;
  if (data.source === 'SYSTEM_RECOMMENDED' && out.done.length > 0) {
    await withTransaction((db) => recordSpaceAudit(ctx, db, { entityType: 'section_space_assignment', entityId: randomUUID(), action: 'section_space_assignment.recommendations_accepted', metadata: { accepted: out.done.length, failed: out.failed.length, alreadyDone: out.alreadyDone.length } }));
  }
  return out;
}

// ───────────────────────────────────────────────────────────── read

export async function getAssignment(ctx: ServiceContext, id: string): Promise<HomeClassroomDTO> {
  const row = await visibleRow(ctx, id);
  return (await toHomeClassroomDTOs(ctx, [row], await todayFor(ctx)))[0]!;
}

export async function listAssignments(ctx: ServiceContext, query: ListAssignmentsQuery): Promise<HomeClassroomListDTO> {
  const scope = await spaceScope(ctx);
  const today = await todayFor(ctx);
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (query.locationId) {
    await assertLocationAccess(ctx, query.locationId);
    filter.locationId = query.locationId;
  } else if (!scope.all) filter.locationId = { $in: scope.locationIds };
  if (query.academicSessionId) filter.academicSessionId = query.academicSessionId;
  if (query.sectionOfferingId) filter.sectionOfferingId = query.sectionOfferingId;
  if (query.physicalSpaceId) filter.physicalSpaceId = query.physicalSpaceId;
  if (query.source) filter.assignmentSource = query.source;

  const and: Record<string, unknown>[] = [];
  if (query.phase) {
    // Phases come from the dates; a row with no last day runs to the end of its session, so the sessions are looked at too.
    const sessions = await AcademicSession.find({ tenantId: ctx.tenantId }).select('_id endDate').lean<{ _id: string; endDate: string }[]>();
    const open = sessions.filter((s) => s.endDate >= today).map((s) => s._id);
    const over = sessions.filter((s) => s.endDate < today).map((s) => s._id);
    if (query.phase === 'cancelled') and.push({ status: 'CANCELLED' });
    else {
      and.push({ status: { $ne: 'CANCELLED' } });
      if (query.phase === 'planned') and.push({ effectiveFrom: { $gt: today } });
      if (query.phase === 'current') and.push({ effectiveFrom: { $lte: today } }, { $or: [{ effectiveTo: { $gte: today } }, { effectiveTo: null, academicSessionId: { $in: open } }] });
      if (query.phase === 'ended') and.push({ $or: [{ effectiveTo: { $lt: today } }, { effectiveTo: null, academicSessionId: { $in: over } }] });
    }
  }
  if (and.length > 0) filter.$and = and;
  const [rows, total] = await Promise.all([
    SectionSpaceAssignment.find(filter).sort({ effectiveFrom: -1, createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<SectionSpaceAssignmentDoc[]>(),
    SectionSpaceAssignment.countDocuments(filter),
  ]);
  return { items: await toHomeClassroomDTOs(ctx, rows, today), total, page: query.page, pageSize: query.pageSize };
}

/** The Home Classroom in force on a date (default today), for a section. Only the campus the caller may see. */
export async function getSectionHomeClassroom(ctx: ServiceContext, sectionOfferingId: string, date?: string): Promise<SectionHomeClassroomDTO> {
  const today = await todayFor(ctx);
  const facts = await requireSectionFacts(ctx, sectionOfferingId, today);
  await assertInScope(ctx, await spaceScope(ctx), facts.section.locationId, 'space', sectionOfferingId);
  const day = date ?? today;
  const rows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, sectionOfferingId, status: { $ne: 'CANCELLED' }, effectiveFrom: { $lte: day }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: day } }] }).sort({ effectiveFrom: -1 }).lean<SectionSpaceAssignmentDoc[]>();
  const row = rows.find((r) => runsOn(r, day, facts.session.endDate)) ?? null;
  return { sectionOfferingId, date: day, homeClassroom: row ? ((await toHomeClassroomDTOs(ctx, [row], today, { sections: new Map([[sectionOfferingId, facts]]) }))[0] ?? null) : null };
}

