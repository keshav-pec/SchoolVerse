import type { AvailableRoomsDTO, AvailableRoomsQuery, ReadinessDTO, ReadinessItemDTO, RecommendRoomsData, RoomRecommendationListDTO } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { SCHEDULING_EXCLUDED_TYPE_CODES } from '@shared';
import { todayFor } from '../staff/status';
import { assertLocationAccess } from './guards';
import { toSpaceDTOs } from './mappers';
import { isMissingCapacity } from './resolve';
import { loadLocationRoomFacts, naturalCompare, type RoomFacts } from './rooms';
import { SpaceAvailabilityBlock } from './space.models';

/**
 * SPACE-63 to 72 — the answers other modules ask: "which rooms can I use?" and "is this room ready for scheduling?". Only schedulable,
 * active, effectively open rooms come back; an Office or staff room is never offered. This module says which rooms are usable in
 * theory: whether a room is already booked for a period is the Timetable's job, never checked here.
 */

const BOUNDARY = 'This list says which rooms can be used. It does not check whether a room is already booked for a period: the Timetable does that.';

/** Rooms with an active closure that touches `[start, end]`. */
async function blockedRoomIds(ctx: ServiceContext, roomIds: string[], start: Date, end: Date): Promise<Set<string>> {
  if (roomIds.length === 0) return new Set();
  const ids = await SpaceAvailabilityBlock.distinct('physicalSpaceId', { tenantId: ctx.tenantId, physicalSpaceId: { $in: roomIds }, status: 'ACTIVE', startDatetime: { $lt: end }, endDatetime: { $gt: start } });
  return new Set(ids as string[]);
}

const usable = (r: RoomFacts) => r.space.operationalStatus === 'ACTIVE' && r.effective.available && r.resolved.schedulable.value;

const capacityOf = (r: RoomFacts, exam = false) => (exam ? (r.space.examCapacity ?? r.resolved.academicCapacity.value) : r.resolved.academicCapacity.value);

export async function findAvailable(ctx: ServiceContext, q: Pick<AvailableRoomsQuery, 'locationId' | 'start' | 'end'> & Partial<Pick<AvailableRoomsQuery, 'minCapacity' | 'suitability' | 'spaceTypeId' | 'limit'>>): Promise<AvailableRoomsDTO> {
  await assertLocationAccess(ctx, q.locationId);
  const today = await todayFor(ctx);
  const rooms = (await loadLocationRoomFacts(ctx, q.locationId, today)).filter(usable);
  const blocked = await blockedRoomIds(ctx, rooms.map((r) => r.space._id), new Date(q.start), new Date(q.end));
  const matches = rooms
    .filter((r) => !blocked.has(r.space._id))
    .filter((r) => q.minCapacity === undefined || ((capacityOf(r) ?? 0) >= q.minCapacity))
    .filter((r) => !q.suitability?.length || q.suitability.every((t) => r.resolved.suitabilityTags.value.includes(t)))
    .filter((r) => !q.spaceTypeId || r.type._id === q.spaceTypeId)
    .sort((a, b) => (capacityOf(a) ?? Number.MAX_SAFE_INTEGER) - (capacityOf(b) ?? Number.MAX_SAFE_INTEGER) || naturalCompare(a.space.spaceCode, b.space.spaceCode));
  const page = matches.slice(0, q.limit ?? 100);
  return { items: await toSpaceDTOs(ctx, page.map((r) => r.space), today), total: matches.length };
}

/** Ranks rooms for another purpose (a Home Classroom, a timetable period, an exam). Best score first, with the reasons in words. */
export async function recommendRooms(ctx: ServiceContext, data: RecommendRoomsData): Promise<RoomRecommendationListDTO> {
  await assertLocationAccess(ctx, data.locationId);
  const today = await todayFor(ctx);
  const all = (await loadLocationRoomFacts(ctx, data.locationId, today)).filter((r) => r.space.operationalStatus === 'ACTIVE' && r.effective.available);
  const exam = data.purpose === 'EXAM';
  let pool = data.purpose === 'HOME_CLASSROOM' ? all.filter((r) => !r.type.isOutdoor && r.resolved.homeClassroomEligible.value) : all.filter((r) => r.resolved.schedulable.value);
  if (data.start && data.end) {
    const blocked = await blockedRoomIds(ctx, pool.map((r) => r.space._id), new Date(data.start), new Date(data.end));
    pool = pool.filter((r) => !blocked.has(r.space._id));
  }
  pool = pool
    .filter((r) => data.minCapacity === undefined || (capacityOf(r, exam) ?? 0) >= data.minCapacity)
    .filter((r) => !data.suitability?.length || data.suitability.every((t) => r.resolved.suitabilityTags.value.includes(t)))
    .filter((r) => !data.spaceTypeId || r.type._id === data.spaceTypeId);

  const scored = pool.map((r) => {
    const reasons: string[] = [];
    let score = 50;
    const cap = capacityOf(r, exam);
    if (data.minCapacity !== undefined && cap) {
      score += Math.round(35 * (data.minCapacity / cap));
      reasons.push(`Holds ${cap}, you need ${data.minCapacity}`);
    }
    if (data.suitability?.length) {
      score += 10;
      reasons.push('Suits what you asked for');
    }
    if (exam && r.resolved.suitabilityTags.value.includes('EXAMINATION')) {
      score += 5;
      reasons.push('Set up for examinations');
    }
    if (reasons.length === 0) reasons.push('Open and available');
    return { r, score: Math.min(100, score), reasons };
  });
  scored.sort((a, b) => b.score - a.score || naturalCompare(a.r.space.spaceCode, b.r.space.spaceCode));
  const top = scored.slice(0, data.limit);
  const dtos = await toSpaceDTOs(ctx, top.map((t) => t.r.space), today);
  return { purpose: data.purpose, items: top.map((t, i) => ({ room: dtos[i]!, score: t.score, reasons: t.reasons })) };
}

/** SPACE-69 — for each room: is it ready for the Timetable, and what is missing? Offices are left out: they are never scheduled. */
export async function readiness(ctx: ServiceContext, locationId: string): Promise<ReadinessDTO> {
  await assertLocationAccess(ctx, locationId);
  const today = await todayFor(ctx);
  const rooms = (await loadLocationRoomFacts(ctx, locationId, today)).filter((r) => !SCHEDULING_EXCLUDED_TYPE_CODES.includes(r.type.code));
  rooms.sort((a, b) => naturalCompare(a.space.spaceCode, b.space.spaceCode));
  const items: ReadinessItemDTO[] = rooms.map((r) => {
    const missing: ReadinessItemDTO['missing'] = [];
    if (!r.effective.available) missing.push({ code: 'NOT_ACTIVE', message: r.effective.reason ?? 'The room is not open.' });
    if (!r.resolved.schedulable.value) missing.push({ code: 'NOT_SCHEDULABLE', message: `${r.type.name} rooms are not set to be scheduled. Turn on "Can be scheduled" for this room, or change its type.` });
    if (isMissingCapacity(r.type, r.resolved)) missing.push({ code: 'ACADEMIC_CAPACITY', message: 'Add how many students the room can hold for classes.' });
    return { spaceId: r.space._id, spaceCode: r.space.spaceCode, spaceName: r.space.spaceName, path: r.path, ready: missing.length === 0, missing, needsRecheck: Boolean(r.space.readinessRecheckAt) };
  });
  const ready = items.filter((i) => i.ready).length;
  return { locationId, totals: { rooms: items.length, ready, notReady: items.length - ready }, items, boundary: BOUNDARY };
}

