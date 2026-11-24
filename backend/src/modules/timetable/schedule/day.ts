import type { OverrideRole, OverrideType, RuleCode, Weekday } from '@shared';
import type { ClientSession } from 'mongoose';
import { AppError } from '../../../core/errors';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { Board, withContent } from '../engine/board';
import { checkChange, issuesFor } from '../engine/check';
import { applyOverrides, weekdayOf, type EffectiveRec, type OverrideRec } from '../engine/effective';
import { namerOf } from '../engine/messages';
import { loadSnapshot } from '../engine/snapshot';
import type { EntryRec, Issue, Op, Snapshot } from '../engine/types';
import { Override, OverrideFaculty, type OverrideDoc, type OverrideFacultyDoc, type TimetablePlanDoc, type TimetableVersionDoc } from '../models';

/**
 * One real date, judged by the one clash checker. The published lessons of that weekday get the day's one-day changes put on top
 * (`applyOverrides`), and the result is the board the checker works on. A new one-day change is a step on that board, so a substitute is
 * refused when they are teaching, away or not available at that time, and a room is refused when it is taken, closed or unsuitable.
 */

export interface DayState {
  date: string;
  weekday: Weekday;
  plan: TimetablePlanDoc;
  version: TimetableVersionDoc;
  snap: Snapshot;
  /** Every lesson of the day with its one-day changes, cancelled ones included. */
  eff: Map<string, EffectiveRec>;
  docs: OverrideDoc[];
}

export const toOverrideRec = (doc: OverrideDoc, faculty: OverrideFacultyDoc[]): OverrideRec => ({
  id: doc._id,
  entryId: doc.entryId,
  type: doc.type,
  payload: doc.payload ?? {},
  reason: doc.reason,
  faculty: faculty.filter((f) => f.overrideId === doc._id && f.status === 'ACTIVE').map((f) => ({ employeeId: f.employeeId, role: f.role })),
  acknowledged: doc.acknowledged ?? [],
  createdAt: doc.createdAt.getTime(),
});

/** Active one-day changes of a plan on some dates, with who is replaced and who covers. */
export async function loadOverrides(ctx: ServiceContext, filter: { planId: string; versionId?: string; dates?: string[]; from?: string; to?: string; ignore?: string[] }, db?: ClientSession): Promise<{ docs: OverrideDoc[]; recs: OverrideRec[] }> {
  const docs = await Override.find({
    tenantId: ctx.tenantId,
    planId: filter.planId,
    status: 'ACTIVE',
    ...(filter.versionId ? { versionId: filter.versionId } : {}),
    ...(filter.dates ? { date: { $in: filter.dates } } : filter.from && filter.to ? { date: { $gte: filter.from, $lte: filter.to } } : {}),
    ...(filter.ignore?.length ? { _id: { $nin: filter.ignore } } : {}),
  })
    .session(db ?? null)
    .lean<OverrideDoc[]>();
  const faculty = docs.length > 0 ? await OverrideFaculty.find({ tenantId: ctx.tenantId, overrideId: { $in: docs.map((d) => d._id) } }).session(db ?? null).lean<OverrideFacultyDoc[]>() : [];
  return { docs, recs: docs.map((d) => toOverrideRec(d, faculty)) };
}

/** Builds the real board of one date for a published version. `ignore` leaves some one-day changes out (the one being replaced). */
export async function loadDay(ctx: ServiceContext, plan: TimetablePlanDoc, version: TimetableVersionDoc, date: string, db?: ClientSession, ignore: string[] = []): Promise<DayState> {
  const snap = await loadSnapshot(ctx, plan, version, db, { asOf: date });
  const weekday = weekdayOf(date);
  const { docs, recs } = await loadOverrides(ctx, { planId: plan._id, versionId: version._id, dates: [date], ignore }, db);
  const eff = applyOverrides(snap.board.all().filter((e) => e.weekday === weekday), recs, snap.periods);
  snap.board = new Board(eff.filter((e) => !e.cancelled));
  const known = new Set(snap.teacherNames.keys());
  const extra = recs.flatMap((r) => r.faculty.map((f) => f.employeeId)).filter((id) => !known.has(id));
  if (extra.length > 0) {
    const { employeeNames } = await import('../facts');
    for (const [id, name] of await employeeNames(ctx, extra, db)) snap.teacherNames.set(id, name);
  }
  return { date, weekday, plan, version, snap, eff: new Map(eff.map((e) => [e.id, e])), docs };
}

// ───────────────────────────────────────────────────────────── proposing a change

export type OverrideSpec =
  | { type: 'SUBSTITUTE_FACULTY'; entryId: string; substituteEmployeeId: string; originalEmployeeId?: string }
  | { type: 'ROOM_CHANGE'; entryId: string; physicalSpaceId: string | null }
  | { type: 'CLASS_CANCELLED'; entryId: string }
  | { type: 'PERIOD_SWAP'; entryId: string; otherEntryId: string }
  | { type: 'SUBJECT_CHANGE'; entryId: string; subjectOfferingId: string; substituteEmployeeId?: string }
  | { type: 'SPECIAL_ACTIVITY'; entryId: string; activityName: string }
  | { type: 'COMBINED_CLASS'; entryId: string; withEntryId: string };

export interface Proposal {
  spec: OverrideSpec;
  ops: Op[];
  payload: Record<string, unknown>;
  faculty: { employeeId: string; role: OverrideRole }[];
  /** The lesson the person chose. The checker's issues about it are the ones that matter. */
  entryId: string;
}

const invalid = (message: string) => new AppError('OVERRIDE_INVALID', message);

/** Turns a request into steps on the day's board, or says in plain words why it makes no sense. */
export function propose(day: DayState, spec: OverrideSpec): Proposal {
  const { snap } = day;
  const n = namerOf(snap);
  const cur = snap.board.get(spec.entryId);
  if (!cur) {
    const gone = day.eff.get(spec.entryId);
    if (gone?.cancelled) throw invalid(`${n.lesson(gone)} on ${day.date} is already ${gone.joinedInto ? 'joined to another lesson' : 'cancelled'}.`);
    throw AppError.notFound('This lesson is not in the timetable on that date.');
  }
  const base = { spec, entryId: cur.id, payload: {} as Record<string, unknown>, faculty: [] as Proposal['faculty'] };
  const mainRole = (employeeId: string) => ({ employeeId, role: 'MAIN' as const });
  const withTeachers = (original: string[], substitute: string | undefined) => {
    const stay = cur.teachers.filter((t) => !original.includes(t.employeeId));
    return substitute ? [...stay, mainRole(substitute)] : stay;
  };

  switch (spec.type) {
    case 'SUBSTITUTE_FACULTY': {
      const original = spec.originalEmployeeId ? [spec.originalEmployeeId] : cur.teachers.map((t) => t.employeeId);
      if (spec.originalEmployeeId && !cur.teachers.some((t) => t.employeeId === spec.originalEmployeeId)) throw invalid(`${n.teacher(spec.originalEmployeeId)} does not teach ${n.lesson(cur)} on ${day.date}.`);
      if (cur.teachers.some((t) => t.employeeId === spec.substituteEmployeeId)) throw invalid(`${n.teacher(spec.substituteEmployeeId)} already teaches ${n.lesson(cur)}.`);
      return { ...base, ops: [{ type: 'update', id: cur.id, patch: { teachers: withTeachers(original, spec.substituteEmployeeId) } }], faculty: [...original.map((employeeId) => ({ employeeId, role: 'ORIGINAL' as const })), { employeeId: spec.substituteEmployeeId, role: 'SUBSTITUTE' as const }] };
    }
    case 'ROOM_CHANGE': {
      if ((cur.spaceId ?? null) === spec.physicalSpaceId) throw invalid(`${n.lesson(cur)} is already in ${n.room(spec.physicalSpaceId)}.`);
      return { ...base, ops: [{ type: 'update', id: cur.id, patch: { spaceId: spec.physicalSpaceId } }], payload: { physicalSpaceId: spec.physicalSpaceId } };
    }
    case 'CLASS_CANCELLED':
      return { ...base, ops: [{ type: 'delete', id: cur.id }] };
    case 'PERIOD_SWAP': {
      const other = snap.board.get(spec.otherEntryId);
      if (!other) throw invalid('The other lesson of the swap is not in the timetable on that date.');
      if (other.id === cur.id) throw invalid('Choose two different periods to swap.');
      if (cur.groupId || other.groupId || !cur.sectionIds.some((s) => other.sectionIds.includes(s))) throw invalid('Only two periods of the same section can be swapped.');
      if (day.docs.some((d) => d.type === 'PERIOD_SWAP' && [d.entryId, d.payload.otherEntryId as string].some((id) => id === cur.id || id === other.id))) throw invalid('One of these periods is already swapped on this date. Cancel that swap first.');
      return { ...base, ops: [{ type: 'update', id: cur.id, patch: { weekday: cur.weekday, periodId: other.periodId } }, { type: 'update', id: other.id, patch: { weekday: other.weekday, periodId: cur.periodId } }], payload: { otherEntryId: other.id } };
    }
    case 'SUBJECT_CHANGE': {
      if (cur.entryType !== 'SUBJECT') throw invalid('Only a subject lesson can change its subject.');
      if (cur.subjectOfferingId === spec.subjectOfferingId) throw invalid(`${n.lesson(cur)} is already ${n.subject(spec.subjectOfferingId)}.`);
      const original = spec.substituteEmployeeId ? cur.teachers.map((t) => t.employeeId) : [];
      return {
        ...base,
        ops: [{ type: 'update', id: cur.id, patch: { subjectOfferingId: spec.subjectOfferingId, ...(spec.substituteEmployeeId ? { teachers: withTeachers(original, spec.substituteEmployeeId) } : {}) } }],
        payload: { subjectOfferingId: spec.subjectOfferingId },
        faculty: spec.substituteEmployeeId ? [...original.map((employeeId) => ({ employeeId, role: 'ORIGINAL' as const })), { employeeId: spec.substituteEmployeeId, role: 'SUBSTITUTE' as const }] : [],
      };
    }
    case 'SPECIAL_ACTIVITY':
      return { ...base, ops: [{ type: 'update', id: cur.id, patch: { entryType: 'ACTIVITY', subjectOfferingId: null, activityName: spec.activityName } }], payload: { activityName: spec.activityName } };
    case 'COMBINED_CLASS': {
      const host = snap.board.get(spec.withEntryId);
      if (!host) throw invalid('The lesson to join is not in the timetable on that date.');
      if (host.id === cur.id) throw invalid('Choose a different lesson to join.');
      if (cur.groupId || host.groupId) throw invalid('Teaching Group lessons cannot be combined this way.');
      if (!(cur.startMin < host.endMin && host.startMin < cur.endMin)) throw invalid('The two lessons must be at the same time to be combined.');
      return { ...base, ops: [{ type: 'update', id: host.id, patch: { sectionIds: [...new Set([...host.sectionIds, ...cur.sectionIds])].sort() } }, { type: 'delete', id: cur.id }], payload: { withEntryId: host.id } };
    }
  }
}

// ───────────────────────────────────────────────────────────── checking

const keyOf = (i: Issue) => `${i.rule}|${i.message}`;

export interface DayCheck {
  /** Clashes the change causes. Problems the lesson already had are not counted: a closed room should not stop a substitute being named. */
  blockers: Issue[];
  warnings: Issue[];
  info: Issue[];
  /** Overridable clashes someone accepted for this lesson. */
  accepted: { rule: RuleCode; reason: string }[];
}

/** The steps judged on the day's board, minus what was already wrong before the change. */
export function checkDay(day: DayState, ops: Op[], entryId: string): DayCheck {
  const { snap } = day;
  const ids = [...new Set(ops.flatMap((o) => (o.type === 'create' ? [] : [o.id])))];
  const before = new Set(ids.flatMap((id) => (snap.board.get(id) ? issuesFor(snap, snap.board.get(id)!) : [])).filter((i) => i.severity === 'CLASH').map(keyOf));
  const outcome = checkChange(snap, ops);
  return {
    blockers: outcome.blockers.filter((b) => !before.has(keyOf(b))),
    warnings: outcome.warnings,
    info: outcome.info,
    accepted: outcome.issues.filter((i) => i.entryId === entryId && i.overriddenReason).map((i) => ({ rule: i.rule, reason: i.overriddenReason! })),
  };
}

/** Puts an accepted change on the board, so the next change of the same batch sees it. */
export function applyToDay(day: DayState, p: Proposal) {
  day.snap.board.apply(p.ops, day.snap.periods);
}

/** The lesson as it will look after the step, to sign an override against. */
export const afterStep = (day: DayState, p: Proposal): EntryRec => {
  const cur = day.snap.board.get(p.entryId)!;
  const op = p.ops.find((o) => o.type === 'update' && o.id === p.entryId);
  return op && op.type === 'update' ? withContent(cur, op.patch, day.snap.periods) : cur;
};

export const OVERRIDE_EVENT: Record<OverrideType, string> = {
  SUBSTITUTE_FACULTY: 'timetable.substitution.created',
  ROOM_CHANGE: 'timetable.room.changed',
  CLASS_CANCELLED: 'timetable.class.cancelled',
  PERIOD_SWAP: 'timetable.override.created',
  SUBJECT_CHANGE: 'timetable.override.created',
  SPECIAL_ACTIVITY: 'timetable.override.created',
  COMBINED_CLASS: 'timetable.override.created',
};
