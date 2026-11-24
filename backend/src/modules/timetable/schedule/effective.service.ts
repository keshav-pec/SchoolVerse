import { minutesToClock, MAX_RANGE_DAYS, type EffectiveDayDTO, type EffectiveItemDTO, type EffectiveQuery, type EffectiveScheduleDTO, type FreeSlotDTO, type ScheduleTarget } from '@shared';
import { AppError } from '../../../core/errors';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { SectionOffering } from '../../academic/offering.model';
import { PhysicalSpace } from '../../spaces/space.models';
import { findCallerEmployee } from '../../staff/access';
import { todayFor } from '../../staff/status';
import { StudentSectionAssignment } from '../../students/student.models';
import { applyOverrides, daysBetween, weekdayOf, type EffectiveRec } from '../engine/effective';
import { loadLite, type LiteBook } from '../engine/lite';
import { namerOf } from '../engine/messages';
import { loadGroupFacts } from '../group.service';
import { readablePlan } from '../guards';
import { AvailabilityException, TeachingGroup, TimetablePlan, TimetableVersion, type AvailabilityExceptionDoc, type TimetablePlanDoc, type TimetableVersionDoc } from '../models';
import { loadOverrides } from './day';

/**
 * The one way to read what is on today. The weekly timetable of the published version that runs on a date, with that date's one-day
 * changes put on top, and teachers' absences marked. Attendance, Homework, Daily Operations, the views and the reports all read it here,
 * so nobody has to rebuild versions and overrides themselves.
 */

export interface DayRec {
  date: string;
  weekday: ReturnType<typeof weekdayOf>;
  isSchoolDay: boolean;
  version: TimetableVersionDoc | null;
  eff: EffectiveRec[];
}

export interface RangeRead {
  plan: TimetablePlanDoc;
  book: LiteBook;
  days: DayRec[];
  absences: AvailabilityExceptionDoc[];
}

/** Reads a plan's effective lessons for a run of dates (at most 31 days). */
export async function readRange(ctx: ServiceContext, plan: TimetablePlanDoc, from: string, to: string): Promise<RangeRead> {
  if (to < from) throw AppError.validation({ to: 'The end date is before the start date.' });
  const dates = daysBetween(from, to);
  if (dates.length > MAX_RANGE_DAYS) throw AppError.validation({ to: `Choose at most ${MAX_RANGE_DAYS} days at a time.` });
  const versions = await TimetableVersion.find({ tenantId: ctx.tenantId, planId: plan._id, status: 'PUBLISHED', effectiveFrom: { $lte: to }, effectiveTo: { $gte: from } }).lean<TimetableVersionDoc[]>();
  const weekdays = [...new Set(dates.map(weekdayOf))];
  const book = await loadLite(ctx, plan, versions.map((v) => v._id), undefined, { weekdays });
  const { docs, recs: overrides } = await loadOverrides(ctx, { planId: plan._id, from, to });
  const absences = await AvailabilityException.find({ tenantId: ctx.tenantId, status: 'ACTIVE', dateFrom: { $lte: to }, dateTo: { $gte: from } }).lean<AvailabilityExceptionDoc[]>();
  await book.addTeachers([...overrides.flatMap((o) => o.faculty.map((f) => f.employeeId)), ...absences.map((a) => a.employeeId)]);
  await book.addRooms(overrides.map((o) => o.payload.physicalSpaceId).filter((id): id is string => typeof id === 'string'));
  const dateOfOverride = new Map(docs.map((d) => [d._id, d.date]));
  const days: DayRec[] = dates.map((date) => {
    const weekday = weekdayOf(date);
    const version = versions.find((v) => (v.effectiveFrom ?? '') <= date && date <= (v.effectiveTo ?? '9999-12-31')) ?? null;
    const base = version ? (book.recs.get(version._id) ?? []).filter((e) => e.weekday === weekday) : [];
    const mine = overrides.filter((o) => dateOfOverride.get(o.id) === date);
    return { date, weekday, isSchoolDay: plan.operatingDays.includes(weekday), version, eff: version ? applyOverrides(base, mine, book.periods) : [] };
  });
  return { plan, book, days, absences };
}

/** The teacher is away (or not available) at that time on that date. */
export function isAway(absences: AvailabilityExceptionDoc[], employeeId: string, date: string, startMin: number, endMin: number): boolean {
  return absences.some((x) => x.employeeId === employeeId && x.dateFrom <= date && date <= x.dateTo && (x.startMin === null || x.endMin === null || (x.startMin < endMin && startMin < x.endMin)));
}

const subjectLabel = (book: LiteBook, e: EffectiveRec) => (e.entryType === 'SUBJECT' && e.subjectOfferingId ? namerOf(book).subject(e.subjectOfferingId) : (e.activityName ?? 'The lesson'));

export function itemOf(book: LiteBook, date: string, version: TimetableVersionDoc, e: EffectiveRec, absences: AvailabilityExceptionDoc[]): EffectiveItemDTO {
  const n = namerOf(book);
  const period = book.periods.get(e.periodId);
  const originPeriod = book.periods.get(e.origin.periodId);
  const teachersOf = (list: { employeeId: string; role: 'MAIN' | 'CO_TEACHER' }[]) => list.map((t) => ({ employeeId: t.employeeId, fullName: n.teacher(t.employeeId), role: t.role }));
  const changed = e.state !== 'NORMAL';
  const names = e.teachers.map((t) => n.teacher(t.employeeId)).join(', ');
  const host = e.joinedInto ? book.recs.get(version._id)?.find((r) => r.id === e.joinedInto) : undefined;
  const note = !changed
    ? null
    : e.state === 'CANCELLED'
      ? `${subjectLabel(book, e.origin as EffectiveRec)} is cancelled${e.reason ? `: ${e.reason}` : ''}`
      : e.joinedInto
        ? `Joins ${host ? n.lesson(host) : 'another lesson'}${host?.spaceId ? ` in ${n.room(host.spaceId)}` : ''}`
        : e.state === 'SUBSTITUTED'
          ? `${subjectLabel(book, e)} today is taken by ${names || 'another teacher'}`
          : e.state === 'ROOM_CHANGED'
            ? `Today in ${e.spaceId ? n.room(e.spaceId) : 'no room'}`
            : e.state === 'SWAPPED'
              ? `Swapped with another period: now ${period?.name ?? 'a different period'}`
              : e.overrideType === 'SPECIAL_ACTIVITY'
                ? `Today: ${e.activityName}`
                : e.overrideType === 'COMBINED_CLASS'
                  ? `Combined with another section: ${n.sections(e.sectionIds)}`
                  : `Today taught as ${subjectLabel(book, e)}`;
  return {
    date,
    weekday: weekdayOf(date),
    entryId: e.id,
    versionId: version._id,
    periodId: e.periodId,
    periodCode: period?.code ?? '',
    periodName: period?.name ?? '',
    start: minutesToClock(e.startMin),
    end: minutesToClock(e.endMin),
    startMin: e.startMin,
    endMin: e.endMin,
    state: e.joinedInto ? 'CHANGED' : e.state,
    entryType: e.entryType,
    subjectOfferingId: e.subjectOfferingId,
    subjectName: e.subjectOfferingId ? n.subject(e.subjectOfferingId) : null,
    activityName: e.activityName,
    teachingGroupId: e.groupId,
    groupName: e.groupId ? n.group(e.groupId) : null,
    sections: e.sectionIds.map((id) => ({ sectionOfferingId: id, label: n.section(id) })).sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })),
    teachers: teachersOf(e.teachers),
    physicalSpaceId: e.spaceId,
    roomName: e.spaceId ? n.room(e.spaceId) : null,
    original: changed
      ? {
          teachers: teachersOf(e.origin.teachers),
          roomName: e.origin.spaceId ? n.room(e.origin.spaceId) : null,
          subjectName: e.origin.subjectOfferingId ? n.subject(e.origin.subjectOfferingId) : null,
          activityName: e.origin.activityName,
          periodName: originPeriod?.name ?? '',
          start: minutesToClock(e.origin.startMin),
          end: minutesToClock(e.origin.endMin),
        }
      : null,
    overrideId: e.overrideId,
    overrideType: e.overrideType,
    reason: e.reason,
    uncovered: !e.cancelled && e.state !== 'CANCELLED' && e.teachers.some((t) => isAway(absences, t.employeeId, date, e.startMin, e.endMin)),
    note,
  };
}

// ───────────────────────────────────────────────────────────── targets

interface Resolved {
  kind: ScheduleTarget;
  id: string;
  label: string;
  plans: TimetablePlanDoc[];
  /** Does this lesson belong to the target on this date? */
  matches: (e: EffectiveRec, date: string, book: LiteBook) => boolean;
}

const plansOverlapping = (ctx: ServiceContext, from: string, to: string, where: Record<string, unknown>) =>
  TimetablePlan.find({ tenantId: ctx.tenantId, status: { $ne: 'ARCHIVED' }, effectiveFrom: { $lte: to }, effectiveTo: { $gte: from }, ...where }).lean<TimetablePlanDoc[]>();

async function resolveTarget(ctx: ServiceContext, q: EffectiveQuery, from: string, to: string, options: { employeeId?: string }): Promise<Resolved> {
  if (q.sectionId) {
    const section = await SectionOffering.findOne({ _id: q.sectionId, tenantId: ctx.tenantId }).lean();
    if (!section) throw AppError.notFound('Section not found.');
    const plans = await plansOverlapping(ctx, from, to, { locationId: section.locationId, academicSessionId: section.sessionId });
    const id = q.sectionId;
    return { kind: 'section', id, label: '', plans, matches: (e, _d, book) => e.sectionIds.includes(id) || Boolean(e.groupId && book.groups.get(e.groupId)?.sectionPool.includes(id)) };
  }
  if (q.employeeId) {
    const id = options.employeeId!;
    return { kind: 'employee', id, label: '', plans: await plansOverlapping(ctx, from, to, {}), matches: (e) => e.teachers.some((t) => t.employeeId === id) || e.origin.teachers.some((t) => t.employeeId === id) };
  }
  if (q.physicalSpaceId) {
    const space = await PhysicalSpace.findOne({ _id: q.physicalSpaceId, tenantId: ctx.tenantId }).select('locationId spaceName').lean<{ locationId: string; spaceName: string }>();
    if (!space) throw AppError.notFound('Room not found.');
    const id = q.physicalSpaceId;
    return { kind: 'space', id, label: space.spaceName, plans: await plansOverlapping(ctx, from, to, { locationId: space.locationId }), matches: (e) => e.spaceId === id || e.origin.spaceId === id };
  }
  if (q.groupId) {
    const group = await TeachingGroup.findOne({ _id: q.groupId, tenantId: ctx.tenantId }).select('planId name').lean<{ planId: string; name: string }>();
    if (!group) throw AppError.notFound('Teaching Group not found.');
    const plan = await TimetablePlan.findOne({ _id: group.planId, tenantId: ctx.tenantId }).lean<TimetablePlanDoc>();
    const id = q.groupId;
    return { kind: 'group', id, label: group.name, plans: plan ? [plan] : [], matches: (e) => e.groupId === id };
  }
  // A student: their section on the date, plus the Teaching Groups they are in.
  const studentId = q.studentId!;
  const rows = await StudentSectionAssignment.find({ tenantId: ctx.tenantId, studentId, effectiveFrom: { $lte: to }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }] }).select('sectionId classOfferingId effectiveFrom effectiveTo').lean<{ sectionId: string; effectiveFrom: string; effectiveTo: string | null }[]>();
  if (rows.length === 0) throw AppError.notFound('Student not found.');
  const sections = await SectionOffering.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.sectionId) } }).select('locationId sessionId').lean();
  const plans = (await Promise.all(sections.map((s) => plansOverlapping(ctx, from, to, { locationId: s.locationId, academicSessionId: s.sessionId })))).flat();
  const sectionOn = (date: string) => rows.find((r) => r.effectiveFrom <= date && (!r.effectiveTo || r.effectiveTo >= date))?.sectionId;
  const memberOf = new Map<string, Set<string>>();
  for (const p of plans) for (const [gid, g] of await loadGroupFacts(ctx, p)) if (g.members.has(studentId)) memberOf.set(gid, g.members);
  return { kind: 'student', id: studentId, label: '', plans, matches: (e, date) => (e.groupId ? memberOf.has(e.groupId) : e.sectionIds.includes(sectionOn(date) ?? '')) };
}

const freeSlots = (book: LiteBook, plan: TimetablePlanDoc, items: EffectiveItemDTO[]): FreeSlotDTO[] => {
  const template = plan.defaultBellScheduleId ?? [...book.bell.templates.keys()][0];
  const periods = [...book.periods.values()].filter((p) => p.templateId === template && p.schedulable).sort((a, b) => a.startMin - b.startMin);
  return periods
    .filter((p) => !items.some((i) => i.state !== 'CANCELLED' && i.startMin < p.endMin && p.startMin < i.endMin))
    .map((p) => ({ periodId: p.id, periodName: p.name, start: minutesToClock(p.startMin), end: minutesToClock(p.endMin), startMin: p.startMin, endMin: p.endMin }));
};

export interface ReadOptions {
  /** Skip the campus check (a parent was already checked through their guardian link; another module is calling). */
  trusted?: boolean;
}

/** The effective schedule of a section, teacher, room, student or group for one date or a run of dates. */
export async function readEffective(ctx: ServiceContext, q: EffectiveQuery, options: ReadOptions = {}): Promise<EffectiveScheduleDTO> {
  const today = await todayFor(ctx);
  const from = q.from ?? q.date ?? today;
  const to = q.to ?? q.date ?? from;
  let employeeId = q.employeeId === 'me' ? undefined : q.employeeId;
  if (q.employeeId === 'me') {
    const me = await findCallerEmployee(ctx);
    if (!me) throw AppError.notFound('Your login is not linked to a teacher record.');
    employeeId = me._id;
  }
  const target = await resolveTarget(ctx, q, from, to, { employeeId });
  const plans: TimetablePlanDoc[] = [];
  for (const p of target.plans) {
    if (options.trusted) plans.push(p);
    else
      try {
        plans.push(await readablePlan(ctx, p._id));
      } catch (err) {
        // A teacher reading their own week across campuses only sees the campuses they may read.
        if (target.kind !== 'employee') throw err;
      }
  }
  if (plans.length === 0 && target.kind !== 'employee') throw AppError.notFound('Nothing to show for this.');
  if (target.kind === 'employee' && plans.length === 0 && !options.trusted) {
    // A teacher with no readable campus: only themselves may ask.
    const me = await findCallerEmployee(ctx);
    if (!me || me._id !== employeeId) throw new AppError('FORBIDDEN', "You don't have access to this teacher's timetable.");
  }

  const dates = daysBetween(from, to);
  const merged = new Map<string, EffectiveDayDTO>(dates.map((date) => [date, { date, weekday: weekdayOf(date), isSchoolDay: false, versionId: null, versionName: null, items: [], free: [] }]));
  let label = target.label;
  for (const plan of plans) {
    const range = await readRange(ctx, plan, from, to);
    const n = namerOf(range.book);
    if (!label) label = target.kind === 'section' ? n.section(target.id) : target.kind === 'employee' ? (range.book.teacherNames.get(target.id) ?? n.teacher(target.id)) : target.kind === 'group' ? n.group(target.id) : label;
    for (const day of range.days) {
      const out = merged.get(day.date)!;
      if (!day.version) continue;
      out.isSchoolDay = out.isSchoolDay || day.isSchoolDay;
      out.versionId = out.versionId ?? day.version._id;
      out.versionName = out.versionName ?? day.version.versionName;
      const items = day.eff.filter((e) => target.matches(e, day.date, range.book)).map((e) => itemOf(range.book, day.date, day.version!, e, range.absences));
      out.items.push(...items);
      if ((target.kind === 'employee' || target.kind === 'space') && day.isSchoolDay) out.free = freeSlots(range.book, plan, items);
    }
  }
  if (!label && target.kind === 'student') label = 'Student';
  for (const day of merged.values()) day.items.sort((a, b) => a.startMin - b.startMin || a.entryId.localeCompare(b.entryId));
  return { from, to, target: { kind: target.kind, id: target.id, label }, planId: plans.length === 1 ? plans[0]!._id : null, days: [...merged.values()] };
}

// ───────────────────────────────────────────────────────────── for other modules

/**
 * The only way other modules (Attendance, Homework, Communication) read the schedule. Do not rebuild versions and overrides yourself. Store
 * `timetableEntryId` and `date` and ask here what was on.
 */
export const timetableService = {
  /** What is on, for a section, teacher, room, student or group, on one date or up to 31 days. */
  getEffectiveSchedule: (ctx: ServiceContext, query: EffectiveQuery) => readEffective(ctx, query, { trusted: true }),

  /** One lesson as it is on a date, or null when the weekly lesson does not fall on that date. */
  async getEntryContext(ctx: ServiceContext, entryId: string, date: string): Promise<EffectiveItemDTO | null> {
    const { TimetableEntry } = await import('../models');
    const entry = await TimetableEntry.findOne({ _id: entryId, tenantId: ctx.tenantId }).select('planId versionId weekday').lean<{ planId: string; versionId: string; weekday: string }>();
    if (!entry || entry.weekday !== weekdayOf(date)) return null;
    const plan = await TimetablePlan.findOne({ _id: entry.planId, tenantId: ctx.tenantId }).lean<TimetablePlanDoc>();
    if (!plan) return null;
    const range = await readRange(ctx, plan, date, date);
    const day = range.days[0]!;
    if (!day.version || day.version._id !== entry.versionId) return null;
    const rec = day.eff.find((e) => e.id === entryId || e.origin.id === entryId);
    return rec ? itemOf(range.book, date, day.version, rec, range.absences) : null;
  },

  /** Was this period of this section taught on that date? False when it was cancelled or there was no lesson. */
  async isClassHeld(ctx: ServiceContext, sectionId: string, periodId: string, date: string): Promise<boolean> {
    const schedule = await readEffective(ctx, { sectionId, date }, { trusted: true });
    return schedule.days[0]!.items.some((i) => i.periodId === periodId && i.state !== 'CANCELLED');
  },
};
