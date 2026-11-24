import type { EntrySource, RequirementValuesDTO, Weekday } from '@shared';
import { resolveBell } from '../bell.resolve';
import { sectionLabelOf, subjectNameOf } from '../facts';
import { overlaps } from './board';
import { makeEntry, type EntryInput } from './build';
import { allowedTeachers, checkChange } from './check';
import { lessonsFor, type NeedItem } from './coverage';
import { namerOf } from './messages';
import type { EntryRec, Issue, PeriodRec, Snapshot } from './types';
import { weekLessons } from './workload';

/**
 * Which slots can take a lesson, and which is best. The same ranking serves "recommend slots", Smart Draft, the slot map, fix suggestions
 * and Needs Attention, so they never disagree. A slot is valid when the one clash checker finds no clash. Among valid slots the order is
 * decided by plain, stable rules, so the same input always gives the same answer.
 */

export interface Target {
  kind: 'SECTION' | 'GROUP';
  sectionIds: string[];
  groupId: string | null;
  subjectOfferingId: string;
  classOfferingId: string;
  values: RequirementValuesDTO | null;
  label: string;
  /** The section whose Daily Periods decide which slots exist. */
  bellSectionId: string;
}

export interface Slot {
  weekday: Weekday;
  period: PeriodRec;
}

export function targetOfItem(snap: Snapshot, item: NeedItem): Target {
  if (item.kind === 'GROUP') {
    const g = snap.groups.get(item.groupId!)!;
    return { kind: 'GROUP', sectionIds: [], groupId: g.id, subjectOfferingId: item.subjectOfferingId, classOfferingId: item.classOfferingId, values: item.values, label: g.name, bellSectionId: g.sectionPool[0] ?? '' };
  }
  return { kind: 'SECTION', sectionIds: [item.sectionId!], groupId: null, subjectOfferingId: item.subjectOfferingId, classOfferingId: item.classOfferingId, values: item.values, label: `${sectionLabelOf(snap.facts, item.sectionId!)} ${subjectNameOf(snap.facts, item.subjectOfferingId)}`, bellSectionId: item.sectionId! };
}

/** A target for "this section and subject" or "this group", whether or not Subject Needs are set for it. Null when it is not part of the plan. */
export function targetOf(snap: Snapshot, input: { sectionId?: string | null; groupId?: string | null; subjectOfferingId?: string | null }): Target | null {
  if (input.groupId) {
    const g = snap.groups.get(input.groupId);
    if (!g || !g.subjectOfferingId || !g.classOfferingId) return null;
    return { kind: 'GROUP', sectionIds: [], groupId: g.id, subjectOfferingId: g.subjectOfferingId, classOfferingId: g.classOfferingId, values: snap.requirements.forGroup(g.id), label: g.name, bellSectionId: g.sectionPool[0] ?? '' };
  }
  const section = input.sectionId ? snap.facts.sectionOf.get(input.sectionId) : undefined;
  if (!section || !input.subjectOfferingId) return null;
  return { kind: 'SECTION', sectionIds: [section._id], groupId: null, subjectOfferingId: input.subjectOfferingId, classOfferingId: section.classOfferingId, values: snap.requirements.forSection(section._id, input.subjectOfferingId), label: `${sectionLabelOf(snap.facts, section._id)} ${subjectNameOf(snap.facts, input.subjectOfferingId)}`, bellSectionId: section._id };
}

/** Every lesson period of the week for a target's Daily Periods, in week order. */
export function slotsFor(snap: Snapshot, target: Pick<Target, 'classOfferingId' | 'bellSectionId'>): Slot[] {
  const out: Slot[] = [];
  for (const weekday of snap.plan.operatingDays) {
    const choice = target.bellSectionId ? resolveBell(snap.bell, target.classOfferingId, target.bellSectionId, weekday) : null;
    if (!choice) continue;
    const periods = [...snap.periods.values()].filter((p) => p.templateId === choice.templateId && p.schedulable).sort((a, b) => a.startMin - b.startMin);
    for (const period of periods) out.push({ weekday, period });
  }
  return out;
}

export function teachersOf(snap: Snapshot, target: Target): string[] {
  return allowedTeachers(snap, { groupId: target.groupId, sectionIds: target.sectionIds, subjectOfferingId: target.subjectOfferingId });
}

export interface Candidate {
  weekday: Weekday;
  period: PeriodRec;
  second: PeriodRec | null;
  entries: EntryRec[];
  blockers: Issue[];
  warnings: Issue[];
  info: Issue[];
  score: number;
  why: string[];
}

export interface EvaluateOptions {
  teacherIds?: string[];
  spaceId?: string | null;
  double?: boolean;
  source?: EntrySource;
  /** Skip the full check when a teacher or section is plainly busy. For Smart Draft, which asks about thousands of slots. */
  fast?: boolean;
}

const PENALTY: Partial<Record<string, number>> = { TEACHER_NOT_PREFERRED: 12, TEACHER_LOAD: 15, MAX_PER_DAY: 25, WEEK_COUNT: 30, ROOM_TOO_SMALL: 8, BAND_NOT_PREFERRED: 6, DOUBLE_PERIOD: 5, TRAVEL_TIME: 15, TEACHER_UNAVAILABLE: 40 };

function nextPeriod(snap: Snapshot, period: PeriodRec): PeriodRec | null {
  if (period.lessonIndex < 0) return null;
  return [...snap.periods.values()].find((p) => p.templateId === period.templateId && p.lessonIndex === period.lessonIndex + 1) ?? null;
}

const plainlyBusy = (snap: Snapshot, e: EntryRec) =>
  e.sectionIds.some((s) => snap.board.ofSection(s, e.weekday).some((o) => o.id !== e.id && overlaps(e, o))) || e.teachers.some((t) => snap.board.ofTeacher(t.employeeId, e.weekday).some((o) => o.id !== e.id && overlaps(e, o)));

export function evaluate(snap: Snapshot, target: Target, slot: Slot, opts: EvaluateOptions = {}): Candidate | null {
  const n = namerOf(snap);
  const base: Omit<EntryInput, 'periodId'> = { weekday: slot.weekday, entryType: 'SUBJECT', subjectOfferingId: target.subjectOfferingId, groupId: target.groupId, sectionIds: target.sectionIds, teacherIds: opts.teacherIds, spaceId: opts.spaceId, source: opts.source ?? 'MANUAL' };
  const entries = [makeEntry(snap, { ...base, periodId: slot.period.id })];
  let second: PeriodRec | null = null;
  if (opts.double) {
    second = nextPeriod(snap, slot.period);
    if (!second) return null;
    entries.push(makeEntry(snap, { ...base, periodId: second.id }));
  }
  const blank = { weekday: slot.weekday, period: slot.period, second, entries };
  if (opts.fast && entries.some((e) => plainlyBusy(snap, e))) return { ...blank, blockers: [{ rule: 'TEACHER_BUSY', severity: 'CLASH', message: 'Busy.', who: [], when: null, overridable: false, overriddenReason: null, entryId: null, blockedBy: [], fix: null, culprit: null }], warnings: [], info: [], score: Number.NEGATIVE_INFINITY, why: [] };
  const outcome = checkChange(snap, entries.map((entry) => ({ type: 'create' as const, entry })));
  if (outcome.blockers.length > 0) return { ...blank, blockers: outcome.blockers, warnings: outcome.warnings, info: outcome.info, score: Number.NEGATIVE_INFINITY, why: [] };

  // ── ranking
  const why: string[] = [];
  let score = 100;
  for (const w of outcome.warnings) score -= PENALTY[w.rule] ?? 5;
  const first = entries[0]!;
  const teacher = first.teachers[0];
  const teacherName = teacher ? n.teacher(teacher.employeeId) : null;
  why.push(`${[teacherName, target.kind === 'SECTION' ? n.section(target.sectionIds[0]!) : null].filter(Boolean).join(' and ') || 'The class'} ${teacherName && target.kind === 'SECTION' ? 'are' : 'is'} free`);
  if (teacher) {
    if ((snap.availability.get(teacher.employeeId) ?? []).some((a) => a.kind === 'PREFERRED' && a.weekday === slot.weekday && a.startMin < first.endMin && first.startMin < a.endMin)) {
      score += 8;
      why.push(`${teacherName} prefers this time`);
    }
    const dayLoad = snap.board.ofTeacher(teacher.employeeId, slot.weekday).length;
    score -= 2 * dayLoad;
    if (dayLoad === 0) why.push(`Keeps ${teacherName}'s other days lighter`);
    else if (weekLessons(snap, teacher.employeeId).length > 0 && dayLoad <= 2) why.push(`Balances ${teacherName}'s load`);
  }
  const mine = lessonsFor(snap, { kind: target.kind, sectionId: target.sectionIds[0] ?? null, groupId: target.groupId, subjectOfferingId: target.subjectOfferingId });
  const sameDay = mine.filter((l) => l.weekday === slot.weekday);
  const adjacent = sameDay.some((l) => Math.abs((snap.periods.get(l.periodId)?.lessonIndex ?? -9) - slot.period.lessonIndex) === 1 && l.templateId === slot.period.templateId);
  const wantsDouble = Boolean(target.values && target.values.doubleMode !== 'NONE');
  if (opts.double || (wantsDouble && adjacent)) {
    score += target.values?.doubleMode === 'REQUIRED' ? 25 : 15;
    why.push('Makes a double period');
  } else if (sameDay.length === 0) {
    score += 6;
    if (mine.length > 0) why.push(`Spreads ${n.subject(target.subjectOfferingId)} over the week`);
  } else score -= 12 * sameDay.length;
  if (first.spaceId) {
    const home = target.sectionIds.length === 1 ? snap.homeRoom.get(target.sectionIds[0]!) : undefined;
    if (home && home === first.spaceId) {
      score += 4;
      why.push('In the Home Classroom');
    } else if (!home || home !== first.spaceId) {
      score += 2;
      why.push(`In ${n.room(first.spaceId)}`);
    }
  }
  const band = target.values?.preferredBand ?? 'ANY';
  if (band === 'MORNING' && slot.period.lessonIndex < Math.ceil(slot.period.lessonCount / 2)) {
    score += 5;
    why.push('Matches the morning wish');
  }
  if (band === 'AFTERNOON' && slot.period.lessonIndex >= Math.floor(slot.period.lessonCount / 2)) {
    score += 5;
    why.push('Matches the afternoon wish');
  }
  // A tiny, stable preference for earlier days and periods, so ties never depend on chance.
  score -= snap.plan.operatingDays.indexOf(slot.weekday) * 0.01 + slot.period.lessonIndex * 0.001;
  return { ...blank, blockers: [], warnings: outcome.warnings, info: outcome.info, score, why };
}

/** Every slot, judged. Valid ones come first, best first; blocked ones follow in week order. */
export function rankSlots(snap: Snapshot, target: Target, opts: EvaluateOptions = {}): Candidate[] {
  const all = slotsFor(snap, target)
    .map((slot) => evaluate(snap, target, slot, opts))
    .filter((c): c is Candidate => c !== null);
  const valid = all.filter((c) => c.blockers.length === 0).sort((a, b) => b.score - a.score);
  return [...valid, ...all.filter((c) => c.blockers.length > 0)];
}

export const validOnly = (list: Candidate[]) => list.filter((c) => c.blockers.length === 0);
