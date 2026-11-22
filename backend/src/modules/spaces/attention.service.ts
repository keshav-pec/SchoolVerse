import { ATTENTION_BLOCK_DAYS, ATTENTION_GROUP_LABELS, ATTENTION_GROUPS, type AttentionQuery, type SpaceAttentionDTO, type SpaceAttentionGroup, type SpaceAttentionGroupDTO, type SpaceAttentionRowDTO } from '@shared';
import { addDays } from '../../core/dates';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { SectionOffering, type SectionOfferingDoc } from '../academic/offering.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { todayFor } from '../staff/status';
import { endOf, niceDate, runsOn } from './assignment.rules';
import { closestRoom, loadCandidatePool, smallestFit, type CandidatePool } from './candidates';
import { liveWarnings } from './home-classroom.mappers';
import { assertLocationAccess, spaceScope } from './guards';
import { isMissingCapacity } from './resolve';
import { blocksInPeriod, homeClassroomBlocker, loadLocationRoomFacts, loadRoomFacts, naturalCompare, toRoomRef, type RoomFacts } from './rooms';
import { clampDate, loadSectionFacts, strengthOf } from './sections';
import { PhysicalSpace, SectionSpaceAssignment, type SectionSpaceAssignmentDoc } from './space.models';

/**
 * SPACE-60 — Needs Attention for rooms and Home Classrooms. Exceptions only: a section whose room is fine never appears here.
 * Everything is worked out when asked, from the live data (strength, room status, closures); nothing is stored.
 *
 *   Classroom Allocation  a section with no usable Home Classroom (none, or its room closed, archived or no longer a classroom)
 *   Capacity              more students than the room's seats for classes (unless someone chose to keep the room and it has not got worse)
 *   Space Setup           a room that should have seats for classes and has none
 *   Availability          a closure in the next 7 days on a room that holds a Home Classroom
 *   Hierarchy             an active room under an inactive floor or building
 */

const ROW_LIMIT = 200;

export async function currentSession(ctx: ServiceContext, sessionId?: string): Promise<AcademicSessionDoc | null> {
  if (sessionId) {
    const doc = await AcademicSession.findOne({ _id: sessionId, tenantId: ctx.tenantId }).lean<AcademicSessionDoc>();
    if (!doc) throw AppError.notFound('Academic session not found.');
    return doc;
  }
  return AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'ACTIVE' }).lean<AcademicSessionDoc>();
}

interface LocationResult {
  rows: Record<SpaceAttentionGroup, SpaceAttentionRowDTO[]>;
  rooms: RoomFacts[];
}

const emptyRows = (): Record<SpaceAttentionGroup, SpaceAttentionRowDTO[]> => ({ CLASSROOM_ALLOCATION: [], CAPACITY: [], SPACE_SETUP: [], AVAILABILITY: [], HIERARCHY: [] });

async function forLocation(ctx: ServiceContext, locationId: string, session: AcademicSessionDoc | null, today: string): Promise<LocationResult> {
  const rows = emptyRows();
  const rooms = await loadLocationRoomFacts(ctx, locationId, today);
  const roomOf = new Map(rooms.map((r) => [r.space._id, r]));

  // Rooms: setup and hierarchy do not depend on a session.
  for (const r of [...rooms].sort((a, b) => naturalCompare(a.space.spaceCode, b.space.spaceCode))) {
    if (r.space.operationalStatus === 'DRAFT') continue;
    if (isMissingCapacity(r.type, r.resolved)) rows.SPACE_SETUP.push({ rowId: `setup:${r.space._id}`, title: `${r.space.spaceName} has no seat count`, detail: 'Add how many students the room can hold, so classes can be matched to it.', fix: 'SET_CAPACITY', sectionOfferingId: null, physicalSpaceId: r.space._id, assignmentId: null, suggestedRoom: null });
    if (r.space.operationalStatus === 'ACTIVE' && !r.effective.available) rows.HIERARCHY.push({ rowId: `hierarchy:${r.space._id}`, title: `${r.space.spaceName} is active but its floor or building is not`, detail: r.effective.reason ?? 'Turn the floor or building back on, or move the room.', fix: 'FIX_HIERARCHY', sectionOfferingId: null, physicalSpaceId: r.space._id, assignmentId: null, suggestedRoom: null });
  }
  if (!session) return { rows, rooms };

  const asOf = clampDate(today, session.startDate, session.endDate);
  const sections = await SectionOffering.find({ tenantId: ctx.tenantId, sessionId: session._id, locationId, status: 'ACTIVE' }).lean<SectionOfferingDoc[]>();
  const facts = await loadSectionFacts(ctx, sections.map((s) => s._id), today);
  const strengths = await strengthOf(ctx, facts.values());
  const assignments = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, academicSessionId: session._id, locationId, status: { $ne: 'CANCELLED' } }).lean<SectionSpaceAssignmentDoc[]>();
  // A row can point at a room that is archived (so it is not in the list above): load those too.
  const missingRoomIds = [...new Set(assignments.map((a) => a.physicalSpaceId))].filter((id) => !roomOf.has(id));
  for (const [id, f] of await loadRoomFacts(ctx, missingRoomIds, today)) roomOf.set(id, f);

  const pool: CandidatePool = await loadCandidatePool(ctx, { locationId, sessionId: session._id, from: asOf, to: session.endDate }, today);
  const ordered = [...facts.values()].sort((a, b) => naturalCompare(a.label, b.label));
  const suggestFor = (strength: number) => {
    const fit = smallestFit(pool.free, strength) ?? closestRoom(pool.free);
    return fit ? toRoomRef(fit) : null;
  };

  for (const f of ordered) {
    const strength = strengths.get(f.section._id) ?? 0;
    const mine = assignments.filter((a) => a.sectionOfferingId === f.section._id);
    const covering = mine.find((a) => runsOn(a, asOf, session.endDate)) ?? mine.find((a) => a.effectiveFrom > asOf) ?? null;
    const room = covering ? roomOf.get(covering.physicalSpaceId) : undefined;
    const blocker = room ? homeClassroomBlocker(room, endOf(covering!, session.endDate)) : null;
    if (!covering || !room || (blocker && blocker.code !== 'ROOM_ARCHIVING')) {
      rows.CLASSROOM_ALLOCATION.push({
        rowId: `allocation:${f.section._id}`,
        title: covering && room ? `${f.label}'s room cannot be used` : `${f.label} has no Home Classroom`,
        detail: covering && room ? `${room.space.spaceName}: ${blocker?.message ?? 'not available'} Choose another room.` : strength > 0 ? `${strength} students and no room yet.` : 'No room has been chosen yet.',
        fix: 'ASSIGN_ROOM',
        sectionOfferingId: f.section._id,
        physicalSpaceId: room?.space._id ?? null,
        assignmentId: covering?._id ?? null,
        suggestedRoom: suggestFor(strength),
      });
      continue;
    }
    const tooSmall = liveWarnings({ row: covering, room, strength, blocks: [] }).find((w) => w.code === 'ROOM_TOO_SMALL');
    if (tooSmall) {
      rows.CAPACITY.push({ rowId: `capacity:${covering._id}`, title: `${f.label} is bigger than its room`, detail: tooSmall.message, fix: 'CHOOSE_LARGER_ROOM', sectionOfferingId: f.section._id, physicalSpaceId: room.space._id, assignmentId: covering._id, suggestedRoom: suggestFor(strength) });
    }
  }

  // Availability: a closure in the next days on a room that holds a Home Classroom.
  const horizon = addDays(today, ATTENTION_BLOCK_DAYS);
  const held = new Set(assignments.filter((a) => a.effectiveFrom <= horizon && endOf(a, session.endDate) >= today).map((a) => a.physicalSpaceId));
  const blocks = await blocksInPeriod(ctx, [...held], today, horizon);
  for (const [roomId, list] of [...blocks.entries()].sort((a, b) => naturalCompare(roomOf.get(a[0])?.space.spaceCode ?? '', roomOf.get(b[0])?.space.spaceCode ?? ''))) {
    const room = roomOf.get(roomId);
    if (!room) continue;
    for (const b of list) {
      const users = assignments.filter((a) => a.physicalSpaceId === roomId && a.effectiveFrom <= b.endDatetime.toISOString().slice(0, 10) && endOf(a, session.endDate) >= b.startDatetime.toISOString().slice(0, 10));
      if (users.length === 0) continue;
      const labels = users.map((u) => facts.get(u.sectionOfferingId)?.label).filter(Boolean) as string[];
      rows.AVAILABILITY.push({
        rowId: `availability:${b._id}`,
        title: `${room.space.spaceName} will be ${b.blockType === 'RESTRICTED' ? 'restricted' : 'unavailable'}`,
        detail: `From ${niceDate(b.startDatetime.toISOString().slice(0, 10))} to ${niceDate(b.endDatetime.toISOString().slice(0, 10))}${b.reason ? ` (${b.reason})` : ''}. ${labels.join(', ')} ${labels.length === 1 ? 'uses' : 'use'} it. The Home Classroom stays; plan where the class sits meanwhile.`,
        fix: 'REVIEW_BLOCK',
        sectionOfferingId: users[0]!.sectionOfferingId,
        physicalSpaceId: roomId,
        assignmentId: users[0]!._id,
        suggestedRoom: null,
      });
    }
  }
  return { rows, rooms };
}

export async function spaceAttention(ctx: ServiceContext, query: AttentionQuery): Promise<SpaceAttentionDTO> {
  const scope = await spaceScope(ctx);
  const today = await todayFor(ctx);
  const session = await currentSession(ctx, query.sessionId);
  let locationIds: string[];
  if (query.locationId) {
    await assertLocationAccess(ctx, query.locationId);
    locationIds = [query.locationId];
  } else {
    const ids = await PhysicalSpace.distinct('locationId', { tenantId: ctx.tenantId, operationalStatus: { $ne: 'ARCHIVED' } });
    locationIds = (ids as string[]).filter((id) => scope.all || scope.locationIds.includes(id)).sort();
  }

  const merged = emptyRows();
  const allRooms: RoomFacts[] = [];
  for (const id of locationIds) {
    const result = await forLocation(ctx, id, session, today);
    for (const g of ATTENTION_GROUPS) merged[g].push(...result.rows[g]);
    allRooms.push(...result.rooms);
  }

  const groups: SpaceAttentionGroupDTO[] = ATTENTION_GROUPS.map((group) => ({ group, title: ATTENTION_GROUP_LABELS[group], count: merged[group].length, rows: merged[group].slice(0, ROW_LIMIT) }));
  const byGroup = Object.fromEntries(groups.map((g) => [g.group, g.count])) as Record<SpaceAttentionGroup, number>;

  // The numbers that say whether the system is doing the work.
  const live = session ? await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, academicSessionId: session._id, status: { $ne: 'CANCELLED' }, locationId: { $in: locationIds } }).select('assignmentSource').lean<Pick<SectionSpaceAssignmentDoc, 'assignmentSource'>[]>() : [];
  const share = (n: number, of: number) => (of === 0 ? null : Math.round((n / of) * 100));
  const properties = allRooms.flatMap((r) => [r.resolved.schedulable.source, r.resolved.homeClassroomEligible.source, r.resolved.suitabilityTags.source, r.resolved.academicCapacity.source]);
  const setupRooms = allRooms.filter((r) => r.space.operationalStatus !== 'DRAFT');
  return {
    academicSessionId: session?._id ?? null,
    locationId: query.locationId ?? null,
    groups,
    counts: { needsAttention: groups.reduce((n, g) => n + g.count, 0), byGroup },
    kpis: {
      recommendedAutomaticallyPercent: share(live.filter((r) => r.assignmentSource === 'SYSTEM_RECOMMENDED').length, live.length),
      rolloverReusePercent: share(live.filter((r) => r.assignmentSource === 'PREVIOUS_SESSION_COPY').length, live.length),
      inheritedPropertyPercent: share(properties.filter((s) => s === 'TYPE_DEFAULT').length, properties.length),
      setupCompletenessPercent: share(setupRooms.filter((r) => !isMissingCapacity(r.type, r.resolved)).length, setupRooms.length),
    },
  };
}
