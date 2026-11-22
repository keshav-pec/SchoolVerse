import type { AssignmentWarningDTO, HomeClassroomRecommendationsData, RecommendationDTO, RecommendationSetDTO, RoomChoiceDTO, UnresolvedSectionDTO } from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { SectionOffering, type SectionOfferingDoc } from '../academic/offering.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { visibleSessionStatuses } from '../academic/session.service';
import { todayFor } from '../staff/status';
import { endOf, niceDate } from './assignment.rules';
import { closestRoom, loadCandidatePool, type CandidatePool } from './candidates';
import { assertLocationAccess } from './guards';
import { homeClassroomBlocker, loadRoomFactsFor, naturalCompare, toRoomRef, type RoomFacts } from './rooms';
import { pairSections } from './session-map';
import { clampDate, loadSectionFacts, strengthOf, toSectionRef, type SectionFacts } from './sections';
import { PhysicalSpace, SectionSpaceAssignment, type PhysicalSpaceDoc, type SectionSpaceAssignmentDoc } from './space.models';

/**
 * SPACE-35, 36, 61 — "which room should each section get?". The engine works on the whole list at once.
 *
 *   Filters first   same campus · open (room, floor, building) · allowed to be a Home Classroom · not used by someone else in the
 *                   same period · seats for classes at least as many as the section's students
 *   Then sorting    1. the same room as last session, when it still fits (continuity)
 *                   2. the smallest room that fits (best fit: no 60-seat room for 35 students)
 *                   3. the same building as the class's other sections (tie-breaker only)
 *
 * Biggest sections choose first, and a room is never given to two sections. A section bigger than every free room is not given a
 * wrong room: it comes back as NEEDS_REVIEW with the closest room as a suggestion.
 */

export const choice = (room: RoomFacts, strength: number): RoomChoiceDTO => {
  const cap = room.resolved.academicCapacity.value;
  return { ...toRoomRef(room), seatsLeft: cap === null ? null : cap - strength };
};

const SCORE = { base: 40, fit: 40, continuity: 15, building: 5 } as const;

interface Pick {
  room: RoomFacts;
  continuity: boolean;
  sameBuilding: string | null;
}

export async function recommendHomeClassrooms(ctx: ServiceContext, data: HomeClassroomRecommendationsData): Promise<RecommendationSetDTO> {
  const today = await todayFor(ctx);
  const allowed = visibleSessionStatuses(ctx);
  const session = await AcademicSession.findOne({ _id: data.sessionId, tenantId: ctx.tenantId, ...(allowed ? { status: { $in: allowed } } : {}) }).lean<AcademicSessionDoc>();
  if (!session) throw AppError.notFound('Academic session not found.');
  await assertLocationAccess(ctx, data.locationId);

  const from = clampDate(today, session.startDate, session.endDate);
  const to = session.endDate;
  const sections = await SectionOffering.find({ tenantId: ctx.tenantId, sessionId: session._id, locationId: data.locationId, status: 'ACTIVE', ...(data.sectionOfferingIds ? { _id: { $in: data.sectionOfferingIds } } : {}) }).lean<SectionOfferingDoc[]>();
  const facts = await loadSectionFacts(ctx, sections.map((s) => s._id), today);
  const strengths = await strengthOf(ctx, facts.values());
  const list = [...facts.values()];

  // Sections that already have a usable room are left alone; one whose room can no longer be used is offered a replacement.
  const existing = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, academicSessionId: session._id, locationId: data.locationId, status: { $ne: 'CANCELLED' }, sectionOfferingId: { $in: list.map((f) => f.section._id) }, effectiveFrom: { $lte: to }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }] }).lean<SectionSpaceAssignmentDoc[]>();
  const roomIdsInUse = [...new Set(existing.map((r) => r.physicalSpaceId))];
  const usedDocs = await PhysicalSpace.find({ tenantId: ctx.tenantId, _id: { $in: roomIdsInUse } }).lean<PhysicalSpaceDoc[]>();
  const usedFacts = await loadRoomFactsFor(ctx, usedDocs, today);

  const alreadyAssigned: RecommendationSetDTO['alreadyAssigned'] = [];
  const replaces = new Map<string, string>();
  const needing: SectionFacts[] = [];
  const staleSections = new Set<string>();
  for (const f of list) {
    const rows = existing.filter((r) => r.sectionOfferingId === f.section._id);
    const good = rows.find((r) => {
      const room = usedFacts.get(r.physicalSpaceId);
      return room && homeClassroomBlocker(room, endOf(r, to)) === null;
    });
    if (good) alreadyAssigned.push({ section: toSectionRef(f, strengths.get(f.section._id) ?? 0), room: toRoomRef(usedFacts.get(good.physicalSpaceId)!), assignmentId: good._id });
    else {
      needing.push(f);
      if (rows[0]) {
        replaces.set(f.section._id, rows[rows.length - 1]!._id);
        staleSections.add(f.section._id);
      }
    }
  }

  // Rooms taken by other sections stay out; rooms of sections that are being replaced are not usable anyway.
  const pool: CandidatePool = await loadCandidatePool(ctx, { locationId: data.locationId, sessionId: session._id, from, to }, today, { ignoreSectionIds: staleSections });
  const lastYear = await roomsFromLastSession(ctx, session, data.locationId, needing);

  const free = new Map(pool.free.map((r) => [r.space._id, r]));
  const chosen = new Map<string, RoomFacts>();
  const buildingsByClass = new Map<string, Set<string>>();
  for (const a of alreadyAssigned) {
    const b = usedFacts.get(a.room.spaceId)?.space.buildingId;
    if (b) buildingsByClass.set(a.section.classOfferingId, (buildingsByClass.get(a.section.classOfferingId) ?? new Set()).add(b));
  }
  const picks = new Map<string, Pick>();
  const take = (f: SectionFacts, pick: Pick) => {
    picks.set(f.section._id, pick);
    free.delete(pick.room.space._id);
    chosen.set(f.section._id, pick.room);
    if (pick.room.space.buildingId) buildingsByClass.set(f.klass._id, (buildingsByClass.get(f.klass._id) ?? new Set()).add(pick.room.space.buildingId));
  };
  const strengthOfSection = (f: SectionFacts) => strengths.get(f.section._id) ?? 0;
  const fits = (r: RoomFacts, need: number) => r.resolved.academicCapacity.value !== null && r.resolved.academicCapacity.value >= need;
  // Biggest sections choose first; ties by class order and section code.
  const order = [...needing].sort((a, b) => strengthOfSection(b) - strengthOfSection(a) || a.klass.sequenceOrder - b.klass.sequenceOrder || a.section.sequenceOrder - b.section.sequenceOrder || naturalCompare(a.label, b.label));

  // Pass 1: keep last year's room where it is still free and big enough, so a big section does not take it by "best fit" first.
  for (const f of order) {
    const roomId = lastYear.get(f.section._id);
    const room = roomId ? free.get(roomId) : undefined;
    if (room && fits(room, strengthOfSection(f))) take(f, { room, continuity: true, sameBuilding: null });
  }
  // Pass 2: the smallest room that fits; the building of the class's other sections breaks a tie.
  for (const f of order) {
    if (picks.has(f.section._id)) continue;
    const need = strengthOfSection(f);
    const candidates = [...free.values()].filter((r) => fits(r, need));
    if (candidates.length === 0) continue;
    const buildings = buildingsByClass.get(f.klass._id) ?? new Set<string>();
    const sameBuilding = (r: RoomFacts) => (r.space.buildingId && buildings.has(r.space.buildingId) ? 0 : 1);
    candidates.sort((a, b) => a.resolved.academicCapacity.value! - b.resolved.academicCapacity.value! || sameBuilding(a) - sameBuilding(b) || naturalCompare(a.space.spaceCode, b.space.spaceCode));
    const room = candidates[0]!;
    take(f, { room, continuity: false, sameBuilding: sameBuilding(room) === 0 ? 'yes' : null });
  }

  const recommendations: RecommendationDTO[] = [];
  const unresolved: UnresolvedSectionDTO[] = [];
  for (const f of needing) {
    const need = strengthOfSection(f);
    const pick = picks.get(f.section._id);
    const ref = toSectionRef(f, need);
    if (!pick) {
      // Too small is about the rooms themselves; taken is about rooms that would have fitted.
      const reason = pool.eligible.length === 0 ? 'NO_ELIGIBLE_ROOM' : pool.eligible.some((r) => fits(r, need)) ? 'ALL_TAKEN' : 'ALL_TOO_SMALL';
      const closest = reason === 'ALL_TOO_SMALL' ? closestRoom(pool.eligible) : null;
      const cap = closest?.resolved.academicCapacity.value ?? null;
      unresolved.push({
        section: ref,
        reason,
        status: 'NEEDS_REVIEW',
        message:
          reason === 'NO_ELIGIBLE_ROOM'
            ? `There is no room at this campus that can be a Home Classroom. Add one, or make a room eligible.`
            : reason === 'ALL_TAKEN'
              ? `Every room that can be a Home Classroom is already taken.`
              : closest && cap !== null
                ? `${need} students, but the closest room holds ${cap}.`
                : `${need} students, and no room has a seat count yet.`,
        closestRoom: closest ? choice(closest, need) : null,
      });
      continue;
    }
    const cap = pick.room.resolved.academicCapacity.value!;
    const reasons: string[] = [];
    if (pick.continuity) reasons.push('Same room as last year');
    reasons.push(need > 0 ? `Best fit: ${need} students in a ${cap}-seat room` : `${cap}-seat room`);
    if (pick.sameBuilding) reasons.push('Same building as the rest of the class');
    const warnings: AssignmentWarningDTO[] = [];
    if (need === 0) warnings.push({ code: 'NO_STUDENTS_YET', message: `No students are placed in ${f.label} yet, so seats could not be matched. Check again once students are placed.` });
    for (const b of pool.blocks.get(pick.room.space._id) ?? []) warnings.push({ code: 'BLOCK_IN_PERIOD', message: `${pick.room.space.spaceName} has a closure from ${niceDate(b.startDatetime.toISOString().slice(0, 10))} to ${niceDate(b.endDatetime.toISOString().slice(0, 10))}. The Home Classroom would stay.` });
    const score = Math.min(100, SCORE.base + (need > 0 ? Math.round(SCORE.fit * (need / cap)) : 0) + (pick.continuity ? SCORE.continuity : 0) + (pick.sameBuilding ? SCORE.building : 0));
    recommendations.push({ section: ref, room: choice(pick.room, need), score, reasons, warnings, replacesAssignmentId: replaces.get(f.section._id) ?? null });
  }
  recommendations.sort((a, b) => naturalCompare(a.section.label, b.section.label));
  unresolved.sort((a, b) => b.section.strength - a.section.strength || naturalCompare(a.section.label, b.section.label));

  const summary = { sections: list.length, eligibleRooms: pool.eligible.length, ready: recommendations.length, needsReview: unresolved.length, alreadyAssigned: alreadyAssigned.length };
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  const message = `We found ${plural(summary.sections, 'section', 'sections')} and ${plural(summary.eligibleRooms, 'eligible room', 'eligible rooms')}. ${summary.ready} ${summary.ready === 1 ? 'is' : 'are'} ready.${summary.needsReview ? ` ${summary.needsReview} need${summary.needsReview === 1 ? 's' : ''} your attention.` : ''}${summary.alreadyAssigned ? ` ${summary.alreadyAssigned} already ${summary.alreadyAssigned === 1 ? 'has' : 'have'} a room.` : ''}`;
  return { academicSessionId: session._id, locationId: data.locationId, from, to, summary, recommendations, unresolved, alreadyAssigned, message };
}

/** Last session's room for each section (by class and section code), if that section had one. */
async function roomsFromLastSession(ctx: ServiceContext, session: AcademicSessionDoc, locationId: string, sections: SectionFacts[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!session.previousSessionId || sections.length === 0) return out;
  const pairs = await pairSections(ctx, { fromSessionId: session.previousSessionId, toSessionId: session._id, locationId });
  const oldToNew = new Map(pairs.filter((p) => p.to).map((p) => [p.from.section._id, p.to!.section._id]));
  const rows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, academicSessionId: session.previousSessionId, locationId, status: { $ne: 'CANCELLED' }, sectionOfferingId: { $in: [...oldToNew.keys()] } }).sort({ effectiveFrom: 1 }).lean<SectionSpaceAssignmentDoc[]>();
  // The last row a section had is the room it ended the year in.
  for (const row of rows) {
    const next = oldToNew.get(row.sectionOfferingId);
    if (next) out.set(next, row.physicalSpaceId);
  }
  return out;
}
