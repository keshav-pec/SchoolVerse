import type { AlternativeDTO, OneDayRoomChoiceDTO, SubstituteChoiceDTO } from '@shared';
import { OverrideFaculty } from '../models';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { neededTags } from '../engine/check';
import { listWords, namerOf, plural, tagLabel } from '../engine/messages';
import type { EntryRec, Snapshot } from '../engine/types';
import { limitsOf } from '../engine/workload';
import { checkDay, type DayState } from './day';

/**
 * Who can stand in, and which room can take a lesson, on one real date. Every candidate is asked of the same checker as a real change, so
 * a suggestion always passes. Among those that pass, plain and stable rules decide the order, so the same day gives the same answer.
 */

const monthOf = (date: string) => ({ from: `${date.slice(0, 7)}-01`, to: `${date.slice(0, 7)}-31` });

/** How many times each teacher stood in during the month of `date`. */
export async function coversThisMonth(ctx: ServiceContext, planId: string, date: string): Promise<Map<string, number>> {
  const { from, to } = monthOf(date);
  const rows = await OverrideFaculty.aggregate<{ _id: string; n: number }>([{ $match: { tenantId: ctx.tenantId, planId, role: 'SUBSTITUTE', status: 'ACTIVE', date: { $gte: from, $lte: to } } }, { $group: { _id: '$employeeId', n: { $sum: 1 } } }]);
  return new Map(rows.map((r) => [r._id, r.n]));
}

type Match = SubstituteChoiceDTO['match'];
const MATCH_RANK: Record<Match, number> = { SUBJECT: 3, CLASS: 2, SECTION: 1, OTHER: 0 };

/** Does the teacher teach this subject, this class, or this section, according to Assign Classes? Subject first, then class, then section. */
function matchOf(snap: Snapshot, employeeId: string, rec: EntryRec): { match: Match; text: string } {
  const n = namerOf(snap);
  const mine = snap.assignments.filter((a) => a.employeeId === employeeId);
  const subjectId = rec.subjectOfferingId ? snap.facts.offeringOf.get(rec.subjectOfferingId)?.subjectId : undefined;
  if (subjectId && mine.some((a) => a.subjectOfferingId && snap.facts.offeringOf.get(a.subjectOfferingId)?.subjectId === subjectId)) return { match: 'SUBJECT', text: `Teaches ${n.subject(rec.subjectOfferingId)}` };
  const classIds = new Set(rec.sectionIds.map((s) => snap.facts.sectionOf.get(s)?.classOfferingId).filter(Boolean));
  if (mine.some((a) => a.classOfferingId && classIds.has(a.classOfferingId))) return { match: 'CLASS', text: 'Teaches this class' };
  if (mine.some((a) => a.sectionId && rec.sectionIds.includes(a.sectionId))) return { match: 'SECTION', text: 'Teaches this section' };
  return { match: 'OTHER', text: 'Other teacher' };
}

export interface RankedSubstitute extends SubstituteChoiceDTO {
  score: number;
}

/** Teachers who can take the lesson on this date, best first. A teacher who clashes is simply not listed. */
export function rankSubstitutes(day: DayState, rec: EntryRec, covers: Map<string, number>, options: { exclude?: string[] } = {}): RankedSubstitute[] {
  const { snap } = day;
  const n = namerOf(snap);
  const out: RankedSubstitute[] = [];
  const stay = new Set([...rec.teachers.map((t) => t.employeeId), ...(options.exclude ?? [])]);
  for (const employeeId of [...snap.campusTeachers].sort()) {
    if (stay.has(employeeId)) continue;
    const check = checkDay(day, [{ type: 'update', id: rec.id, patch: { teachers: [{ employeeId, role: 'MAIN' }] } }], rec.id);
    if (check.blockers.length > 0) continue;
    const m = matchOf(snap, employeeId, rec);
    const periods = snap.board.ofTeacher(employeeId, day.weekday).length;
    const monthly = covers.get(employeeId) ?? 0;
    const lim = limitsOf(snap, employeeId);
    const headroom = lim.maxPerDay !== null ? lim.maxPerDay - periods : 99;
    const score = MATCH_RANK[m.match] * 1000 - periods * 20 - monthly * 10 - check.warnings.length * 30 - (headroom <= 0 ? 50 : 0);
    out.push({
      employeeId,
      fullName: n.teacher(employeeId),
      match: m.match,
      periodsThatDay: periods,
      coversThisMonth: monthly,
      why: [m.text, 'free at that time', periods === 0 ? 'no other periods that day' : plural(periods, 'other period') + ' that day', monthly > 0 ? `${plural(monthly, 'cover')} this month` : null].filter(Boolean).join(' · '),
      warnings: check.warnings.map((w) => w.message),
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));
}

export interface RankedRoom extends OneDayRoomChoiceDTO {
  score: number;
}

/** Rooms that can take the lesson on this date, best first: seats enough, right kind, and not a special room that is not needed. */
export function rankRooms(day: DayState, rec: EntryRec, options: { exclude?: string[] } = {}): RankedRoom[] {
  const { snap } = day;
  const students = rec.groupId ? (snap.groups.get(rec.groupId)?.members.size ?? 0) : rec.sectionIds.reduce((c, s) => c + (snap.sectionSize.get(s) ?? 0), 0);
  const needs = neededTags(snap, rec);
  const out: RankedRoom[] = [];
  for (const room of [...snap.rooms.values()].sort((a, b) => a.spaceName.localeCompare(b.spaceName, 'en', { numeric: true }))) {
    if (room.spaceId === rec.spaceId || (options.exclude ?? []).includes(room.spaceId) || !room.usable) continue;
    const check = checkDay(day, [{ type: 'update', id: rec.id, patch: { spaceId: room.spaceId } }], rec.id);
    if (check.blockers.length > 0) continue;
    const extra = room.tags.filter((t) => t !== 'GENERAL_TEACHING' && !needs.includes(t)).length;
    const spare = room.capacity === null ? 0 : room.capacity - students;
    const score = 100 - check.warnings.length * 25 - extra * 8 - Math.max(0, spare) * 0.1;
    out.push({
      physicalSpaceId: room.spaceId,
      name: room.spaceName,
      capacity: room.capacity,
      tags: room.tags,
      why: ['free at that time', needs.length > 0 ? `suits ${listWords(needs.map(tagLabel))}` : null, room.capacity !== null && students > 0 ? `seats ${room.capacity} for ${students} students` : null].filter(Boolean).join(' · '),
      warnings: check.warnings.map((w) => w.message),
      score,
    });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'en', { numeric: true }));
}

/** The first few options as plain alternatives, for a refused change. */
export const teacherAlternatives = (list: RankedSubstitute[]): AlternativeDTO[] => list.slice(0, 3).map((c) => ({ kind: 'TEACHER', label: `${c.fullName} (${c.why})`, weekday: null, periodId: null, physicalSpaceId: null, employeeId: c.employeeId }));
export const roomAlternatives = (list: RankedRoom[]): AlternativeDTO[] => list.slice(0, 3).map((c) => ({ kind: 'ROOM', label: `${c.name} (${c.why})`, weekday: null, periodId: null, physicalSpaceId: c.physicalSpaceId, employeeId: null }));
