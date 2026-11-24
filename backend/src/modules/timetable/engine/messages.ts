import { ENTRY_TYPE_LABELS, SPACE_SUITABILITY_TAGS, WEEKDAY_LABELS, minutesToClock, type Weekday } from '@shared';
import { sectionLabelOf, subjectNameOf } from '../facts';
import type { EntryRec, Snapshot } from './types';

/**
 * Every name and every sentence the checker says. All wording lives here, so the grid, the inspector, Needs Attention and the publish
 * review say the same thing. Names are looked up each time; nothing is stored.
 */

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
export const listWords = (items: string[]) => (items.length <= 1 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);
export const tagLabel = (code: string) => SPACE_SUITABILITY_TAGS.find((t) => t.code === code)?.label ?? code;

/** What the Namer needs. The full snapshot has it, and so does the light loader used for reading a day. */
export type NamerSource = Pick<Snapshot, 'facts' | 'teacherNames' | 'rooms' | 'strangerRooms' | 'groups' | 'periods'>;

export class Namer {
  constructor(readonly snap: NamerSource) {}

  teacher(id: string) {
    return this.snap.teacherNames.get(id) ?? 'A teacher';
  }

  section(id: string) {
    return sectionLabelOf(this.snap.facts, id);
  }

  sections(ids: string[]) {
    return ids.map((id) => this.section(id)).join(' + ');
  }

  subject(offeringId: string | null) {
    return offeringId ? subjectNameOf(this.snap.facts, offeringId) : 'a lesson';
  }

  room(id: string | null) {
    if (!id) return 'no room';
    return this.snap.rooms.get(id)?.spaceName ?? this.snap.strangerRooms.get(id)?.spaceName ?? 'A room';
  }

  group(id: string | null) {
    return (id && this.snap.groups.get(id)?.name) || 'a Teaching Group';
  }

  periodName(periodId: string) {
    return this.snap.periods.get(periodId)?.name ?? 'a period';
  }

  weekday(day: Weekday) {
    return WEEKDAY_LABELS[day];
  }

  /** "Monday, Period 3". */
  when(day: Weekday, periodId: string) {
    return `${WEEKDAY_LABELS[day]}, ${this.periodName(periodId)}`;
  }

  time(startMin: number, endMin: number) {
    return `${minutesToClock(startMin)}-${minutesToClock(endMin)}`;
  }

  /** "8-A Maths", "French 8", "8-A Library". */
  lesson(e: Pick<EntryRec, 'entryType' | 'groupId' | 'sectionIds' | 'subjectOfferingId' | 'activityName'>) {
    if (e.groupId) return this.group(e.groupId);
    const what = e.entryType === 'SUBJECT' ? this.subject(e.subjectOfferingId) : (e.activityName ?? ENTRY_TYPE_LABELS[e.entryType]);
    return `${this.sections(e.sectionIds)} ${what}`.trim();
  }
}

const cache = new WeakMap<NamerSource, Namer>();
export const namerOf = (snap: NamerSource): Namer => {
  let n = cache.get(snap);
  if (!n) {
    n = new Namer(snap);
    cache.set(snap, n);
  }
  return n;
};
