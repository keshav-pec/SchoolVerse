import { WEEKDAY_LABELS, type DailyExceptionDTO, type DailyScheduleDTO, type DailySummaryDTO, type DailyQuery, type EffectiveItemDTO, type EffectiveScheduleDTO, type ScheduleTarget, type ViewQuery } from '@shared';
import { AppError } from '../../../core/errors';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { spaceService } from '../../spaces/spaceService';
import { todayFor } from '../../staff/status';
import { addDays, applyOverrides, daysBetween, mondayOf, weekdayOf } from '../engine/effective';
import { loadLite } from '../engine/lite';
import { namerOf, plural } from '../engine/messages';
import { readablePlan } from '../guards';
import { TimetablePlan, type TimetablePlanDoc } from '../models';
import { itemOf, readEffective, readRange } from './effective.service';
import { canReadDrafts, readableVersion } from './version.service';

/** TT-UX-20 — the day as Daily Operations needs it: every lesson with its state, the periods nobody covers, and the exceptions (absences, closed rooms, cancellations). */

/** The plan of a campus that holds a date. A campus the caller may not reach is refused like any other plan. */
async function planOfCampus(ctx: ServiceContext, locationId: string, date: string) {
  const plans = await TimetablePlan.find({ tenantId: ctx.tenantId, locationId, status: { $ne: 'ARCHIVED' } }).sort({ effectiveFrom: -1 }).lean<TimetablePlanDoc[]>();
  const plan = plans.find((p) => p.effectiveFrom <= date && date <= p.effectiveTo) ?? plans[0];
  if (!plan) throw AppError.notFound('This campus has no timetable plan yet.');
  return readablePlan(ctx, plan._id);
}

export async function dailySchedule(ctx: ServiceContext, query: DailyQuery): Promise<DailyScheduleDTO> {
  const date = query.date ?? (await todayFor(ctx));
  const plan = query.planId ? await readablePlan(ctx, query.planId) : await planOfCampus(ctx, query.locationId!, date);
  const range = await readRange(ctx, plan, date, date);
  const day = range.days[0]!;
  const base = { date, weekday: day.weekday, planId: plan._id, locationId: plan.locationId, isSchoolDay: day.isSchoolDay, versionId: day.version?._id ?? null, versionName: day.version?.versionName ?? null };
  const empty: DailySummaryDTO = { lessons: 0, uncovered: 0, substituted: 0, roomChanged: 0, cancelled: 0, swapped: 0, changed: 0 };
  if (!day.isSchoolDay) return { ...base, message: `${WEEKDAY_LABELS[day.weekday]} is not a school day in this plan.`, summary: empty, line: 'Not a school day', exceptions: [], uncovered: [], lessons: [] };
  if (!day.version) return { ...base, message: `There is no published timetable on ${date}. Publish one to see the day.`, summary: empty, line: 'No published timetable', exceptions: [], uncovered: [], lessons: [] };

  const n = namerOf(range.book);
  const lessons: EffectiveItemDTO[] = day.eff.map((e) => itemOf(range.book, date, day.version!, e, range.absences)).sort((a, b) => a.startMin - b.startMin || a.entryId.localeCompare(b.entryId));
  const live = lessons.filter((l) => l.state !== 'CANCELLED');
  const uncovered = live.filter((l) => l.uncovered);
  const count = (state: string) => lessons.filter((l) => l.state === state).length;
  const summary: DailySummaryDTO = { lessons: lessons.length, uncovered: uncovered.length, substituted: count('SUBSTITUTED'), roomChanged: count('ROOM_CHANGED'), cancelled: count('CANCELLED'), swapped: count('SWAPPED'), changed: count('CHANGED') };

  const exceptions: DailyExceptionDTO[] = [];
  const absentIds = new Set(range.absences.filter((a) => a.kind === 'ABSENT').map((a) => a.employeeId));
  for (const employeeId of [...absentIds].sort((a, b) => n.teacher(a).localeCompare(n.teacher(b)))) {
    const theirs = lessons.filter((l) => l.original?.teachers.some((t) => t.employeeId === employeeId) || l.teachers.some((t) => t.employeeId === employeeId));
    if (theirs.length === 0) continue;
    const open = theirs.filter((l) => l.uncovered && l.teachers.some((t) => t.employeeId === employeeId)).length;
    exceptions.push({ kind: 'ABSENT', title: `${n.teacher(employeeId)} is away`, message: open === 0 ? `All ${plural(theirs.length, 'period')} are covered or cancelled.` : `${plural(open, 'period')} of ${theirs.length} still need a teacher.`, affected: theirs.length, uncovered: open, employeeId, physicalSpaceId: null });
  }
  const roomIds = [...new Set(live.map((l) => l.physicalSpaceId).filter((id): id is string => Boolean(id)))];
  const closed = await spaceService.longClosures(ctx, roomIds, date, date, 1);
  for (const roomId of roomIds.filter((id) => closed.has(id))) {
    const affected = live.filter((l) => l.physicalSpaceId === roomId).length;
    exceptions.push({ kind: 'ROOM', title: `${n.room(roomId)} is closed`, message: `${plural(affected, 'lesson')} are still in this room. Move them to another room.`, affected, uncovered: affected, employeeId: null, physicalSpaceId: roomId });
  }
  if (summary.cancelled > 0) exceptions.push({ kind: 'CANCELLED', title: `${plural(summary.cancelled, 'lesson')} cancelled`, message: 'These lessons are not held today.', affected: summary.cancelled, uncovered: 0, employeeId: null, physicalSpaceId: null });

  const open = uncovered.length + exceptions.filter((e) => e.kind === 'ROOM').reduce((c, e) => c + e.uncovered, 0);
  const line = uncovered.length > 0 ? `${plural(uncovered.length, 'period')} ${uncovered.length === 1 ? 'has' : 'have'} no teacher` : open > 0 ? `${plural(open, 'lesson')} need a new room` : exceptions.length > 0 ? 'Everything is covered' : 'Nothing unusual today';
  return { ...base, message: null, summary, line, exceptions, uncovered, lessons };
}

// ───────────────────────────────────────────────────────────── views

const asQuery = (kind: ScheduleTarget, id: string) => ({ section: { sectionId: id }, employee: { employeeId: id }, space: { physicalSpaceId: id }, group: { groupId: id }, student: { studentId: id } })[kind];

/** The Monday-to-last-school-day week that holds a date. */
async function weekAround(ctx: ServiceContext, query: ViewQuery) {
  const today = await todayFor(ctx);
  if (query.from || query.to) return { from: query.from ?? query.to!, to: query.to ?? query.from! };
  const date = query.date ?? today;
  if (!query.week) return { from: date, to: date };
  const from = mondayOf(date);
  return { from, to: addDays(from, 5) };
}

/**
 * A section's, teacher's, room's or Teaching Group's timetable as it really is: the weekly lessons with the one-day changes marked.
 * With `versionId` the draft's weekly lessons are shown instead (for people who work on the timetable).
 */
export async function viewSchedule(ctx: ServiceContext, kind: Exclude<ScheduleTarget, 'student'>, id: string, query: ViewQuery): Promise<EffectiveScheduleDTO> {
  const { from, to } = await weekAround(ctx, query);
  if (!query.versionId) return readEffective(ctx, { ...asQuery(kind, id), from, to });

  if (!canReadDrafts(ctx)) throw AppError.notFound('Timetable version not found.');
  const { version, plan } = await readableVersion(ctx, query.versionId);
  const book = await loadLite(ctx, plan, [version._id]);
  const n = namerOf(book);
  const recs = book.recs.get(version._id) ?? [];
  const matches = (e: (typeof recs)[number]) =>
    kind === 'section' ? e.sectionIds.includes(id) || Boolean(e.groupId && book.groups.get(e.groupId)?.sectionPool.includes(id)) : kind === 'employee' ? e.teachers.some((t) => t.employeeId === id) : kind === 'space' ? e.spaceId === id : e.groupId === id;
  const days = daysBetween(from, to).map((date) => {
    const weekday = weekdayOf(date);
    const eff = applyOverrides(recs.filter((e) => e.weekday === weekday && matches(e)), [], book.periods);
    return { date, weekday, isSchoolDay: plan.operatingDays.includes(weekday), versionId: version._id, versionName: version.versionName, items: eff.map((e) => itemOf(book, date, version, e, [])).sort((a, b) => a.startMin - b.startMin), free: [] };
  });
  const label = kind === 'section' ? n.section(id) : kind === 'employee' ? n.teacher(id) : kind === 'space' ? n.room(id) : n.group(id);
  return { from, to, target: { kind, id, label }, planId: plan._id, days };
}
