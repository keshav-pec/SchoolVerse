import { clockToMinutes, minutesToClock, WEEKDAY_LABELS, type AbsenceDTO, type AbsenceImpactDTO, type AbsenceImpactData, type AffectedLessonDTO, type ListAbsencesQuery, type OneDayRoomChoiceDTO, type OneDayRoomRecommendationDTO, type RecommendDayRoomsData, type RecommendSubstitutesData, type RecordAbsenceData, type RoomImpactData, type RoomImpactDTO, type RoomImpactItemDTO, type SubstituteRecommendationDTO } from '@shared';
import { MAX_RANGE_DAYS } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { spaceService } from '../../spaces/spaceService';
import { todayFor } from '../../staff/status';
import { emitTimetableEvent, recordTimetableAudit } from '../audit';
import { addDays, daysBetween } from '../engine/effective';
import { namerOf, plural } from '../engine/messages';
import { loadPlanTeachers, requirePlanTeacher } from '../facts';
import { readablePlan, writablePlan } from '../guards';
import { AvailabilityException, type AvailabilityExceptionDoc, type TimetablePlanDoc } from '../models';
import { loadDay } from './day';
import { assertChangeDate, runningVersion } from './override.service';
import { coversThisMonth, rankRooms, rankSubstitutes } from './pick';
import { readRange, type RangeRead } from './effective.service';

/** TT-38 to 42 — a teacher's absence, who is affected, who can stand in, and which room can take a lesson when one is closed. Nothing here edits the weekly timetable. */

const lessonItem = (r: RangeRead, date: string, e: RangeRead['days'][number]['eff'][number], employeeId?: string): AffectedLessonDTO => {
  const n = namerOf(r.book);
  const away = employeeId ? !e.teachers.some((t) => t.employeeId === employeeId) : false;
  return {
    entryId: e.id,
    date,
    weekday: r.days.find((d) => d.date === date)!.weekday,
    label: n.lesson(e.origin),
    periodName: n.periodName(e.periodId),
    start: minutesToClock(e.startMin),
    end: minutesToClock(e.endMin),
    startMin: e.startMin,
    endMin: e.endMin,
    sections: e.sectionIds.map((s) => n.section(s)),
    subjectName: e.subjectOfferingId ? n.subject(e.subjectOfferingId) : null,
    roomName: e.spaceId ? n.room(e.spaceId) : null,
    state: e.state,
    covered: e.cancelled || e.state === 'CANCELLED' || away,
    coveredBy: !e.cancelled && away && e.teachers.length > 0 ? e.teachers.map((t) => n.teacher(t.employeeId)).join(', ') : null,
  };
};

function checkRange(from: string, to: string) {
  if (to < from) throw new AppError('OVERRIDE_INVALID', 'The end date is before the start date.');
  if (daysBetween(from, to).length > MAX_RANGE_DAYS) throw new AppError('OVERRIDE_INVALID', `Choose at most ${MAX_RANGE_DAYS} days at a time.`);
}

function timeWindow(start?: string, end?: string): { startMin: number | null; endMin: number | null } {
  if (!start && !end) return { startMin: null, endMin: null };
  const a = start ? clockToMinutes(start) : null;
  const b = end ? clockToMinutes(end) : null;
  if (a === null || b === null || a >= b) throw new AppError('OVERRIDE_INVALID', 'Give both a start and an end time, with the end after the start.');
  return { startMin: a, endMin: b };
}

// ───────────────────────────────────────────────────────────── impact

/** The lessons a teacher's absence touches, with whether someone already covers them. Writes nothing. */
export async function absenceImpact(ctx: ServiceContext, data: AbsenceImpactData): Promise<AbsenceImpactDTO> {
  const plan = await readablePlan(ctx, data.planId);
  const teacher = await requirePlanTeacher(ctx, plan, data.employeeId);
  const to = data.dateTo ?? data.dateFrom;
  checkRange(data.dateFrom, to);
  return impactFor(ctx, plan, data.employeeId, teacher.fullName, data.dateFrom, to, timeWindow(data.start, data.end));
}

async function impactFor(ctx: ServiceContext, plan: TimetablePlanDoc, employeeId: string, name: string, from: string, to: string, window: { startMin: number | null; endMin: number | null }): Promise<AbsenceImpactDTO> {
  const range = await readRange(ctx, plan, from, to);
  const items: AffectedLessonDTO[] = [];
  for (const day of range.days) {
    if (!day.version || !day.isSchoolDay) continue;
    for (const e of day.eff) {
      if (e.joinedInto) continue;
      const mine = e.origin.teachers.some((t) => t.employeeId === employeeId) || e.teachers.some((t) => t.employeeId === employeeId);
      if (!mine) continue;
      if (window.startMin !== null && window.endMin !== null && !(window.startMin < e.endMin && e.startMin < window.endMin)) continue;
      items.push(lessonItem(range, day.date, e, employeeId));
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin || a.entryId.localeCompare(b.entryId));
  const uncovered = items.filter((i) => !i.covered).length;
  return { employeeId, employeeName: name, items, uncovered, summary: items.length === 0 ? `${name} has no lessons in these days.` : `${plural(items.length, 'period')} affected. ${uncovered === 0 ? 'All are covered.' : `${plural(uncovered, 'period')} still need a teacher.`}` };
}

// ───────────────────────────────────────────────────────────── absence

const dtoOf = (doc: AvailabilityExceptionDoc, name: string, affected: number, uncovered: number): AbsenceDTO => ({
  absenceId: doc._id,
  employeeId: doc.employeeId,
  employeeName: name,
  dateFrom: doc.dateFrom,
  dateTo: doc.dateTo,
  startMin: doc.startMin,
  endMin: doc.endMin,
  kind: doc.kind,
  reason: doc.reason,
  status: doc.status,
  affected,
  uncovered,
});

/** Records that a teacher is away. From then on the teacher is not suggested or accepted for any lesson in those hours. */
export async function recordAbsence(ctx: ServiceContext, data: RecordAbsenceData): Promise<AbsenceDTO> {
  const plan = await writablePlan(ctx, data.planId);
  const teacher = await requirePlanTeacher(ctx, plan, data.employeeId);
  const to = data.dateTo ?? data.dateFrom;
  checkRange(data.dateFrom, to);
  const today = await todayFor(ctx);
  if (to < today) throw new AppError('OVERRIDE_INVALID', 'That day has passed. An absence can be recorded for today or a later day.');
  const window = timeWindow(data.start, data.end);
  const existing = await AvailabilityException.findOne({ tenantId: ctx.tenantId, employeeId: data.employeeId, status: 'ACTIVE', kind: 'ABSENT', dateFrom: data.dateFrom, dateTo: to, startMin: window.startMin, endMin: window.endMin }).lean<AvailabilityExceptionDoc>();
  const doc =
    existing ??
    (await withTransaction(async (db) => {
      const [created] = await AvailabilityException.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, employeeId: data.employeeId, dateFrom: data.dateFrom, dateTo: to, startMin: window.startMin, endMin: window.endMin, kind: 'ABSENT', reason: data.reason?.trim() || null, status: 'ACTIVE', createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
      await recordTimetableAudit(ctx, db, { entityType: 'timetable_absence', entityId: created!._id, action: 'timetable_absence.recorded', planId: plan._id, locationId: plan.locationId, metadata: { employeeId: data.employeeId, dateFrom: data.dateFrom, dateTo: to, startMin: window.startMin, endMin: window.endMin } });
      await emitTimetableEvent(db, ctx.tenantId, 'timetable.absence.recorded', { absenceId: created!._id, employeeId: data.employeeId, planId: plan._id, dateFrom: data.dateFrom, dateTo: to });
      return created!.toObject() as AvailabilityExceptionDoc;
    }));
  const impact = await impactFor(ctx, plan, data.employeeId, teacher.fullName, doc.dateFrom < today ? today : doc.dateFrom, doc.dateTo, { startMin: doc.startMin, endMin: doc.endMin });
  return dtoOf(doc, teacher.fullName, impact.items.length, impact.uncovered);
}

export async function cancelAbsence(ctx: ServiceContext, absenceId: string): Promise<AbsenceDTO> {
  const doc = await AvailabilityException.findOne({ _id: absenceId, tenantId: ctx.tenantId }).lean<AvailabilityExceptionDoc>();
  if (!doc) throw AppError.notFound('Absence not found.');
  const plans = (await import('../models')).TimetablePlan;
  const candidates = await plans.find({ tenantId: ctx.tenantId, status: { $ne: 'ARCHIVED' }, effectiveFrom: { $lte: doc.dateTo }, effectiveTo: { $gte: doc.dateFrom } }).lean<TimetablePlanDoc[]>();
  let home: TimetablePlanDoc | undefined;
  for (const p of candidates) if ((await loadPlanTeachers(ctx, p, { employeeIds: [doc.employeeId] })).length > 0 && (await readablePlan(ctx, p._id).then(() => true, () => false))) home = p;
  if (!home) throw AppError.notFound('Absence not found.');
  if (doc.status === 'ACTIVE') {
    await withTransaction(async (db) => {
      await AvailabilityException.updateOne({ _id: absenceId, tenantId: ctx.tenantId }, { $set: { status: 'CANCELLED', updatedBy: ctx.userId } }, { session: db });
      await recordTimetableAudit(ctx, db, { entityType: 'timetable_absence', entityId: absenceId, action: 'timetable_absence.cancelled', planId: home!._id, locationId: home!.locationId, changes: [{ field: 'status', from: 'ACTIVE', to: 'CANCELLED' }] });
    });
  }
  const name = (await requirePlanTeacher(ctx, home, doc.employeeId)).fullName;
  return dtoOf({ ...doc, status: 'CANCELLED' }, name, 0, 0);
}

/** The absences that touch a day (or all that are still to come), with how many lessons each affects and how many still need someone. */
export async function listAbsences(ctx: ServiceContext, query: ListAbsencesQuery): Promise<AbsenceDTO[]> {
  const plan = await readablePlan(ctx, query.planId);
  const today = await todayFor(ctx);
  const teachers = await loadPlanTeachers(ctx, plan, query.employeeId ? { employeeIds: [query.employeeId] } : {});
  const nameOf = new Map(teachers.map((t) => [t.employee._id, t.fullName]));
  const docs = await AvailabilityException.find({
    tenantId: ctx.tenantId,
    employeeId: { $in: [...nameOf.keys()] },
    kind: 'ABSENT',
    ...(query.includeCancelled ? {} : { status: 'ACTIVE' }),
    ...(query.date ? { dateFrom: { $lte: query.date }, dateTo: { $gte: query.date } } : { dateTo: { $gte: today } }),
  })
    .sort({ dateFrom: 1 })
    .limit(200)
    .lean<AvailabilityExceptionDoc[]>();
  const out: AbsenceDTO[] = [];
  for (const doc of docs) {
    const from = query.date ?? (doc.dateFrom < today ? today : doc.dateFrom);
    const to = query.date ?? (addDays(from, MAX_RANGE_DAYS - 1) < doc.dateTo ? addDays(from, MAX_RANGE_DAYS - 1) : doc.dateTo);
    const impact = doc.status === 'ACTIVE' ? await impactFor(ctx, plan, doc.employeeId, nameOf.get(doc.employeeId) ?? 'A teacher', from, to, { startMin: doc.startMin, endMin: doc.endMin }) : { items: [], uncovered: 0 };
    out.push(dtoOf(doc, nameOf.get(doc.employeeId) ?? 'A teacher', impact.items.length, impact.uncovered));
  }
  return out;
}

// ───────────────────────────────────────────────────────────── recommendations

/**
 * The best teacher for each period, with the reasons, and two others. A period nobody can take says why. Picks made earlier in the list
 * count as busy for the next, so two periods at one time never get the same teacher.
 */
export async function recommendSubstitutes(ctx: ServiceContext, data: RecommendSubstitutesData): Promise<SubstituteRecommendationDTO[]> {
  const plan = await readablePlan(ctx, data.planId);
  const out = new Map<string, SubstituteRecommendationDTO>();
  const key = (i: { entryId: string; date: string }) => `${i.entryId}|${i.date}`;
  for (const date of [...new Set(data.items.map((i) => i.date))].sort()) {
    await assertChangeDate(ctx, plan, date);
    const version = await runningVersion(ctx, plan._id, date);
    const day = await loadDay(ctx, plan, version, date);
    const covers = await coversThisMonth(ctx, plan._id, date);
    const n = namerOf(day.snap);
    const items = data.items.filter((i) => i.date === date);
    const recs = items.map((i) => ({ item: i, rec: day.snap.board.get(i.entryId) })).sort((a, b) => (a.rec?.startMin ?? 0) - (b.rec?.startMin ?? 0));
    for (const { item, rec } of recs) {
      if (!rec) {
        const gone = day.eff.get(item.entryId);
        out.set(key(item), { entryId: item.entryId, date, label: gone ? n.lesson(gone) : 'A lesson', when: gone ? n.periodName(gone.periodId) : '', recommended: null, alternatives: [], message: gone ? 'This lesson is cancelled, so nobody is needed.' : 'This lesson is not in the timetable on that date.' });
        continue;
      }
      const ranked = rankSubstitutes(day, rec, covers);
      const strip = ({ score: _score, ...choice }: (typeof ranked)[number]) => choice;
      const label = n.lesson(rec);
      const when = `${n.periodName(rec.periodId)}, ${minutesToClock(rec.startMin)}-${minutesToClock(rec.endMin)}`;
      const best = ranked[0];
      out.set(key(item), { entryId: rec.id, date, label, when, recommended: best ? strip(best) : null, alternatives: ranked.slice(1, 3).map(strip), message: best ? null : `Nobody is free to take ${label} on ${WEEKDAY_LABELS[day.weekday]}, ${n.periodName(rec.periodId)}. Cancel the lesson or ask a teacher to cover it.` });
      if (best) {
        day.snap.board.apply([{ type: 'update', id: rec.id, patch: { teachers: [{ employeeId: best.employeeId, role: 'MAIN' }] } }], day.snap.periods);
        covers.set(best.employeeId, (covers.get(best.employeeId) ?? 0) + 1);
      }
    }
  }
  return data.items.map((i) => out.get(key(i))!);
}

// ───────────────────────────────────────────────────────────── room changes

async function roomOf(ctx: ServiceContext, plan: TimetablePlanDoc, physicalSpaceId: string) {
  const found = (await spaceService.roomCampuses(ctx, [physicalSpaceId])).get(physicalSpaceId);
  if (!found) throw AppError.notFound('Room not found.');
  if (found.locationId !== plan.locationId) throw new AppError('WRONG_CAMPUS', 'This room is at another campus than the timetable plan.');
  return found;
}

/** Which lessons use a room on these days. Writes nothing. */
export async function roomImpact(ctx: ServiceContext, data: RoomImpactData): Promise<RoomImpactDTO> {
  const plan = await readablePlan(ctx, data.planId);
  const room = await roomOf(ctx, plan, data.physicalSpaceId);
  const to = data.dateTo ?? data.dateFrom;
  checkRange(data.dateFrom, to);
  const range = await readRange(ctx, plan, data.dateFrom, to);
  const items: RoomImpactItemDTO[] = [];
  for (const day of range.days) {
    if (!day.version || !day.isSchoolDay) continue;
    for (const e of day.eff) {
      if (e.cancelled || e.state === 'CANCELLED' || e.spaceId !== data.physicalSpaceId) continue;
      items.push({ ...lessonItem(range, day.date, e), covered: false, coveredBy: null, currentRoomId: e.spaceId, currentRoomName: room.spaceName });
    }
  }
  items.sort((a, b) => a.date.localeCompare(b.date) || a.startMin - b.startMin || a.entryId.localeCompare(b.entryId));
  return { physicalSpaceId: data.physicalSpaceId, roomName: room.spaceName, items, summary: items.length === 0 ? `${room.spaceName} is not used by any lesson in these days.` : `${plural(items.length, 'lesson')} use ${room.spaceName} in these days.` };
}

/** The best room for each lesson, with reasons and two others. Rooms picked earlier count as taken for the next lesson. */
export async function recommendRooms(ctx: ServiceContext, data: RecommendDayRoomsData): Promise<OneDayRoomRecommendationDTO[]> {
  const plan = await readablePlan(ctx, data.planId);
  const out = new Map<string, OneDayRoomRecommendationDTO>();
  const key = (i: { entryId: string; date: string }) => `${i.entryId}|${i.date}`;
  for (const date of [...new Set(data.items.map((i) => i.date))].sort()) {
    await assertChangeDate(ctx, plan, date);
    const version = await runningVersion(ctx, plan._id, date);
    const day = await loadDay(ctx, plan, version, date);
    const n = namerOf(day.snap);
    const recs = data.items.filter((i) => i.date === date).map((i) => ({ item: i, rec: day.snap.board.get(i.entryId) })).sort((a, b) => (a.rec?.startMin ?? 0) - (b.rec?.startMin ?? 0));
    for (const { item, rec } of recs) {
      if (!rec) {
        out.set(key(item), { entryId: item.entryId, date, label: 'A lesson', when: '', currentRoomName: null, recommended: null, alternatives: [], message: 'This lesson is cancelled or not in the timetable on that date.' });
        continue;
      }
      const ranked = rankRooms(day, rec, { exclude: data.avoidRoomId ? [data.avoidRoomId] : [] });
      const strip = ({ score: _score, ...choice }: (typeof ranked)[number]): OneDayRoomChoiceDTO => choice;
      const label = n.lesson(rec);
      const best = ranked[0];
      out.set(key(item), { entryId: rec.id, date, label, when: `${n.periodName(rec.periodId)}, ${minutesToClock(rec.startMin)}-${minutesToClock(rec.endMin)}`, currentRoomName: rec.spaceId ? n.room(rec.spaceId) : null, recommended: best ? strip(best) : null, alternatives: ranked.slice(1, 3).map(strip), message: best ? null : `No other room is free and suitable for ${label} at that time.` });
      if (best) day.snap.board.apply([{ type: 'update', id: rec.id, patch: { spaceId: best.physicalSpaceId } }], day.snap.periods);
    }
  }
  return data.items.map((i) => out.get(key(i))!);
}
