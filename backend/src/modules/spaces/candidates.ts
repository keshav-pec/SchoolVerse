import type { ClientSession } from 'mongoose';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { startOfDay, endOfDay } from './assignment.rules';
import { assignmentsInPeriod, blocksInPeriod, homeClassroomBlocker, loadLocationRoomFacts, naturalCompare, type RoomFacts } from './rooms';
import type { SectionSpaceAssignmentDoc, SpaceAvailabilityBlockDoc } from './space.models';

/**
 * The rooms that could be a Home Classroom for a period, and which of them are still free. Filters come first (campus, open,
 * allowed to be a Home Classroom, not taken); ranking is done by the caller.
 */
export interface CandidatePool {
  /** Every room that is allowed and open for the period, taken or not. */
  eligible: RoomFacts[];
  /** Eligible rooms nobody uses during the period. */
  free: RoomFacts[];
  /** Rooms in use, with the rows that use them. */
  used: Map<string, SectionSpaceAssignmentDoc[]>;
  /** Closures that touch the period, for warnings. */
  blocks: Map<string, SpaceAvailabilityBlockDoc[]>;
}

export async function loadCandidatePool(
  ctx: ServiceContext,
  input: { locationId: string; sessionId: string; from: string; to: string },
  today: string,
  opts: { db?: ClientSession; ignoreSectionIds?: ReadonlySet<string> } = {},
): Promise<CandidatePool> {
  const rooms = await loadLocationRoomFacts(ctx, input.locationId, today, opts.db);
  const rows = (await assignmentsInPeriod(ctx, { locationId: input.locationId, sessionId: input.sessionId, from: input.from, to: input.to }, opts.db)).filter((r) => !opts.ignoreSectionIds?.has(r.sectionOfferingId));
  const used = new Map<string, SectionSpaceAssignmentDoc[]>();
  for (const r of rows) used.set(r.physicalSpaceId, [...(used.get(r.physicalSpaceId) ?? []), r]);
  const blocks = await blocksInPeriod(ctx, rooms.map((r) => r.space._id), input.from, input.to, opts.db);
  // A room that is closed on the first day cannot start the period as a classroom; a closure later on only warns.
  const closedAtStart = (id: string) => (blocks.get(id) ?? []).some((b) => b.startDatetime <= endOfDay(input.from) && b.endDatetime >= startOfDay(input.from));
  const eligible = rooms.filter((r) => homeClassroomBlocker(r, input.to) === null && !closedAtStart(r.space._id)).sort((a, b) => naturalCompare(a.space.spaceCode, b.space.spaceCode));
  return { eligible, free: eligible.filter((r) => !used.has(r.space._id)), used, blocks };
}

/** The smallest free room that holds `strength` students; `null` when none does. */
export function smallestFit(rooms: readonly RoomFacts[], strength: number): RoomFacts | null {
  const fits = rooms.filter((r) => r.resolved.academicCapacity.value !== null && r.resolved.academicCapacity.value >= strength);
  fits.sort((a, b) => a.resolved.academicCapacity.value! - b.resolved.academicCapacity.value! || naturalCompare(a.space.spaceCode, b.space.spaceCode));
  return fits[0] ?? null;
}

/** The free room that comes closest to holding `strength` students (the biggest one), for "the closest room holds 40". */
export function closestRoom(rooms: readonly RoomFacts[]): RoomFacts | null {
  const known = rooms.filter((r) => r.resolved.academicCapacity.value !== null);
  known.sort((a, b) => b.resolved.academicCapacity.value! - a.resolved.academicCapacity.value! || naturalCompare(a.space.spaceCode, b.space.spaceCode));
  return known[0] ?? null;
}
