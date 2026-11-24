import type { EffectiveState, OverrideRole, OverrideType, Weekday } from '@shared';
import { WEEKDAYS } from '@shared';
import type { EntryRec, PeriodRec } from './types';

/**
 * How a published lesson looks on one date: the weekly lesson with that day's one-day changes put on top. A pure function, used by the
 * clash checker (to build the real day), the effective schedule, Daily Operations and the reports, so they can never disagree.
 */

export interface OverrideRec {
  id: string;
  entryId: string;
  type: OverrideType;
  payload: Record<string, unknown>;
  reason: string | null;
  faculty: { employeeId: string; role: OverrideRole }[];
  acknowledged: { rule: string; reason: string }[];
  createdAt: number;
}

export interface EffectiveRec extends EntryRec {
  state: EffectiveState;
  overrideId: string | null;
  overrideType: OverrideType | null;
  reason: string | null;
  cancelled: boolean;
  /** The lesson as published. */
  origin: EntryRec;
  /** For a lesson that joined another: the host lesson. */
  joinedInto: string | null;
}

const copy = (e: EntryRec): EntryRec => ({ ...e, sectionIds: [...e.sectionIds], teachers: e.teachers.map((t) => ({ ...t })), overridden: e.overridden ? { ...e.overridden } : undefined });

const order: OverrideType[] = ['SUBSTITUTE_FACULTY', 'ROOM_CHANGE', 'SUBJECT_CHANGE', 'SPECIAL_ACTIVITY', 'PERIOD_SWAP', 'COMBINED_CLASS', 'CLASS_CANCELLED'];

/** `NORMAL` gives way to a change. A cancelled lesson stays cancelled. */
function mark(rec: EffectiveRec, state: EffectiveState, o: OverrideRec) {
  if (rec.state === 'CANCELLED') return;
  rec.state = rec.state === 'NORMAL' || state === 'CANCELLED' ? state : rec.state === state ? state : 'CHANGED';
  rec.overrideId = o.id;
  rec.overrideType = o.type;
  rec.reason = o.reason;
}

export function applyOverrides(base: EntryRec[], overrides: OverrideRec[], _periods?: Map<string, PeriodRec>): EffectiveRec[] {
  const out = new Map<string, EffectiveRec>(base.map((e) => [e.id, { ...copy(e), state: 'NORMAL' as const, overrideId: null, overrideType: null, reason: null, cancelled: false, origin: e, joinedInto: null }]));
  const sorted = [...overrides].sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || a.createdAt - b.createdAt);
  for (const o of sorted) {
    const rec = out.get(o.entryId);
    if (!rec) continue;
    const subs = o.faculty.filter((f) => f.role === 'SUBSTITUTE').map((f) => f.employeeId);
    const originals = o.faculty.filter((f) => f.role === 'ORIGINAL').map((f) => f.employeeId);
    if (o.type === 'SUBSTITUTE_FACULTY' || (o.type === 'SUBJECT_CHANGE' && subs.length > 0)) {
      const gone = originals.length > 0 ? originals : rec.teachers.map((t) => t.employeeId);
      rec.teachers = [...rec.teachers.filter((t) => !gone.includes(t.employeeId)), ...subs.filter((id) => !rec.teachers.some((t) => t.employeeId === id)).map((employeeId) => ({ employeeId, role: 'MAIN' as const }))];
    }
    if (o.type === 'SUBSTITUTE_FACULTY') mark(rec, 'SUBSTITUTED', o);
    else if (o.type === 'ROOM_CHANGE') {
      rec.spaceId = (o.payload.physicalSpaceId as string | null | undefined) ?? null;
      mark(rec, 'ROOM_CHANGED', o);
    } else if (o.type === 'SUBJECT_CHANGE') {
      rec.subjectOfferingId = (o.payload.subjectOfferingId as string | undefined) ?? rec.subjectOfferingId;
      mark(rec, 'CHANGED', o);
    } else if (o.type === 'SPECIAL_ACTIVITY') {
      rec.entryType = 'ACTIVITY';
      rec.subjectOfferingId = null;
      rec.activityName = (o.payload.activityName as string | undefined) ?? 'Special activity';
      mark(rec, 'CHANGED', o);
    } else if (o.type === 'PERIOD_SWAP') {
      const other = out.get(o.payload.otherEntryId as string);
      if (other && other.id !== rec.id) {
        for (const key of ['periodId', 'startMin', 'endMin', 'templateId'] as const) [rec[key], other[key]] = [other[key] as never, rec[key] as never];
        mark(rec, 'SWAPPED', o);
        mark(other, 'SWAPPED', o);
      }
    } else if (o.type === 'COMBINED_CLASS') {
      const host = out.get(o.payload.withEntryId as string);
      if (host && host.id !== rec.id) {
        host.sectionIds = [...new Set([...host.sectionIds, ...rec.sectionIds])].sort();
        mark(host, 'CHANGED', o);
        rec.cancelled = true;
        rec.joinedInto = host.id;
        mark(rec, 'CHANGED', o);
      }
    } else if (o.type === 'CLASS_CANCELLED') {
      rec.cancelled = true;
      mark(rec, 'CANCELLED', o);
    }
  }
  return [...out.values()];
}

/** Lessons of a published version on a weekday, as a plain list. */
export const onWeekday = (recs: EntryRec[], weekday: Weekday) => recs.filter((e) => e.weekday === weekday);

const DAY_INDEX: Record<number, Weekday> = { 0: 'SUN', 1: 'MON', 2: 'TUE', 3: 'WED', 4: 'THU', 5: 'FRI', 6: 'SAT' };
/** The weekday of a `YYYY-MM-DD` date. Dates are calendar dates, so no time zone is involved. */
export const weekdayOf = (date: string): Weekday => DAY_INDEX[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
export const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): string[] => {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
};
export const weekdayIndex = (day: Weekday) => WEEKDAYS.indexOf(day);

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** "2026-07-01" → "1 Jul 2026". */
export const niceDate = (date: string): string => `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
/** The Monday of the week that holds a date. */
export const mondayOf = (date: string): string => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));
