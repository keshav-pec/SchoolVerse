import type { AssignmentWarningDTO, HomeClassroomDTO } from '@shared';
import { toIso } from '../../core/objects';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { isLive, niceDate, phaseOf, startOfDay } from './assignment.rules';
import { blocksInPeriod, loadRoomFacts, toRoomRef, type RoomFacts } from './rooms';
import { loadSectionFacts, strengthOf, toSectionRef, type SectionFacts } from './sections';
import type { SectionSpaceAssignmentDoc, SpaceAvailabilityBlockDoc } from './space.models';
import { addDays } from '../../core/dates';

/** How far ahead a closure is worth a warning on a Home Classroom. */
const LOOKAHEAD_DAYS = 30;

/**
 * Checks that are worked out each time a row is shown, because they change without anyone touching the row: the room closed, the
 * section grew, a repair was planned. A warning NEVER ends or edits the assignment.
 */
export function liveWarnings(input: {
  row: SectionSpaceAssignmentDoc;
  room: RoomFacts | undefined;
  strength: number;
  blocks: SpaceAvailabilityBlockDoc[];
}): AssignmentWarningDTO[] {
  const { row, room, strength, blocks } = input;
  const out: AssignmentWarningDTO[] = [];
  if (!room) return out;
  if (!room.effective.available) out.push({ code: 'ROOM_UNAVAILABLE', message: room.effective.reason ?? `${room.space.spaceName} is not open.` });
  else if (room.type.isOutdoor || !room.resolved.homeClassroomEligible.value) out.push({ code: 'ROOM_NOT_ELIGIBLE', message: `${room.space.spaceName} is now a ${room.type.name}, which cannot be a Home Classroom.` });
  const capacity = room.resolved.academicCapacity.value;
  if (capacity === null) out.push({ code: 'CAPACITY_UNKNOWN', message: `${room.space.spaceName} has no seat count yet, so the fit cannot be checked.` });
  else if (strength > capacity) {
    const kept = row.capacityOverride;
    // "Keep Room Anyway" is accepted for the numbers the admin saw; a section that has grown since is flagged again.
    if (!kept || (kept.strength !== null && strength > kept.strength) || (kept.capacity !== null && capacity < kept.capacity)) {
      out.push({ code: 'ROOM_TOO_SMALL', message: `${strength} students, but ${room.space.spaceName} holds ${capacity}.` });
    }
  }
  for (const b of blocks) {
    out.push({ code: 'BLOCK_IN_PERIOD', message: `${room.space.spaceName} is marked ${b.blockType === 'RESTRICTED' ? 'restricted' : 'unavailable'} from ${niceDate(toIso(b.startDatetime)!.slice(0, 10))} to ${niceDate(toIso(b.endDatetime)!.slice(0, 10))}${b.reason ? ` (${b.reason})` : ''}. The Home Classroom stays.` });
  }
  return out;
}

/** Turns rows into DTOs for a whole page at once: sections, strength, rooms and closures are each loaded once. */
export async function toHomeClassroomDTOs(ctx: ServiceContext, rows: SectionSpaceAssignmentDoc[], today: string, preloaded?: { sections?: Map<string, SectionFacts> }): Promise<HomeClassroomDTO[]> {
  if (rows.length === 0) return [];
  const sections = preloaded?.sections ?? (await loadSectionFacts(ctx, rows.map((r) => r.sectionOfferingId), today));
  const [strengths, rooms] = await Promise.all([strengthOf(ctx, sections.values()), loadRoomFacts(ctx, rows.map((r) => r.physicalSpaceId), today)]);
  const horizon = addDays(today, LOOKAHEAD_DAYS);
  const liveRoomIds = rows.filter((r) => sections.has(r.sectionOfferingId) && isLive(r, sections.get(r.sectionOfferingId)!.session.endDate, today)).map((r) => r.physicalSpaceId);
  const blocks = await blocksInPeriod(ctx, [...new Set(liveRoomIds)], today, horizon);
  const out: HomeClassroomDTO[] = [];
  for (const row of rows) {
    const facts = sections.get(row.sectionOfferingId);
    const room = rooms.get(row.physicalSpaceId);
    if (!facts || !room) continue;
    const phase = phaseOf(row, facts.session.endDate, today);
    const strength = strengths.get(row.sectionOfferingId) ?? 0;
    const live = phase === 'ACTIVE' || phase === 'PLANNED';
    const relevantBlocks = live ? (blocks.get(row.physicalSpaceId) ?? []).filter((b) => b.startDatetime <= startOfDay(addDays(row.effectiveTo ?? facts.session.endDate, 1)) && b.endDatetime >= startOfDay(row.effectiveFrom)) : [];
    out.push({
      assignmentId: row._id,
      academicSessionId: row.academicSessionId,
      section: toSectionRef(facts, strength),
      room: toRoomRef(room),
      shiftId: row.shiftId ?? null,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo ?? null,
      phase,
      status: row.status,
      source: row.assignmentSource,
      reason: row.reason ?? null,
      capacityOverride: row.capacityOverride ? { reason: row.capacityOverride.reason, byUserId: row.capacityOverride.byUserId, at: toIso(row.capacityOverride.at)!, strength: row.capacityOverride.strength ?? null, capacity: row.capacityOverride.capacity ?? null } : null,
      assignedBy: row.assignedBy ?? null,
      warnings: live ? liveWarnings({ row, room, strength, blocks: relevantBlocks }) : [],
      version: row.version,
    });
  }
  return out;
}
