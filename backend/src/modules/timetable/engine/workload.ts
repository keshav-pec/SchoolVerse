import type { Weekday, WorkloadDTO } from '@shared';
import { resolveBell } from '../bell.resolve';
import type { EntryRec, Snapshot, WorkloadLimits } from './types';

/** A teacher's own limits, else the school default. */
export function limitsOf(snap: Snapshot, employeeId: string): WorkloadLimits {
  const own = snap.workload.get(employeeId);
  const d = snap.workloadDefault;
  return { maxPerDay: own?.maxPerDay ?? d.maxPerDay, maxConsecutive: own?.maxConsecutive ?? d.maxConsecutive, maxPerWeek: own?.maxPerWeek ?? d.maxPerWeek };
}

/** True when `b` is the lesson period right after `a` on the same Daily Periods. */
export function followsOn(snap: Snapshot, a: EntryRec, b: EntryRec): boolean {
  if (a.weekday !== b.weekday || a.templateId !== b.templateId) return false;
  const pa = snap.periods.get(a.periodId);
  const pb = snap.periods.get(b.periodId);
  return Boolean(pa && pb && pa.lessonIndex >= 0 && pb.lessonIndex === pa.lessonIndex + 1);
}

/** The longest unbroken run of lessons on a day that includes `target` (or the longest run when no target is given). */
export function runOf(snap: Snapshot, lessons: EntryRec[], target?: EntryRec): number {
  const sorted = [...lessons].sort((a, b) => a.startMin - b.startMin);
  const runs: EntryRec[][] = [];
  for (const e of sorted) {
    const last = runs[runs.length - 1];
    if (last && followsOn(snap, last[last.length - 1]!, e)) last.push(e);
    else runs.push([e]);
  }
  const pool = target ? runs.filter((r) => r.some((x) => x.id === target.id)) : runs;
  return Math.max(0, ...pool.map((r) => r.length));
}

export function weekLessons(snap: Snapshot, employeeId: string): EntryRec[] {
  return snap.plan.operatingDays.flatMap((day) => snap.board.ofTeacher(employeeId, day));
}

export function teacherWorkload(snap: Snapshot, employeeId: string): WorkloadDTO {
  const perDay: Partial<Record<Weekday, number>> = {};
  const free: Partial<Record<Weekday, number>> = {};
  let longest = 0;
  let gaps = 0;
  let week = 0;
  for (const day of snap.plan.operatingDays) {
    const lessons = snap.board.ofTeacher(employeeId, day);
    perDay[day] = lessons.length;
    week += lessons.length;
    longest = Math.max(longest, runOf(snap, lessons));
    const first = lessons[0];
    const choice = first ? { templateId: first.templateId } : resolveBell(snap.bell, snap.facts.classes[0]?._id ?? '', null, day);
    const periods = [...snap.periods.values()].filter((p) => p.templateId === choice?.templateId && p.schedulable);
    free[day] = Math.max(0, periods.length - lessons.length);
    if (lessons.length > 1) {
      const idx = lessons.map((l) => snap.periods.get(l.periodId)?.lessonIndex ?? -1).filter((i) => i >= 0).sort((a, b) => a - b);
      if (idx.length > 1) gaps += idx[idx.length - 1]! - idx[0]! + 1 - new Set(idx).size;
    }
  }
  return { employeeId, fullName: snap.teacherNames.get(employeeId) ?? 'A teacher', perDay, week, longestRun: longest, freePeriodsPerDay: free, gaps, limits: limitsOf(snap, employeeId) };
}
