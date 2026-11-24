import type { Weekday } from '@shared';
import type { EntryContent, EntryRec, Op, PeriodRec } from './types';

const key = (id: string, day: Weekday) => `${id}|${day}`;
const pull = (list: EntryRec[] | undefined, id: string) => (list ? list.filter((e) => e.id !== id) : []);

export const overlaps = (a: Pick<EntryRec, 'weekday' | 'startMin' | 'endMin'>, b: Pick<EntryRec, 'weekday' | 'startMin' | 'endMin'>) => a.weekday === b.weekday && a.startMin < b.endMin && b.startMin < a.endMin;

/**
 * The lessons of one version, indexed by section, teacher and room per weekday. It is the working state of the clash checker: ops are
 * applied to it, the touched lessons are checked, and the ops are taken back. Smart Draft keeps adding to it.
 */
export class Board {
  readonly entries = new Map<string, EntryRec>();
  private bySection = new Map<string, EntryRec[]>();
  private byTeacher = new Map<string, EntryRec[]>();
  private byRoom = new Map<string, EntryRec[]>();
  private groupDay = new Map<Weekday, EntryRec[]>();
  private byDay = new Map<Weekday, EntryRec[]>();

  constructor(entries: EntryRec[] = []) {
    for (const e of entries) this.add(e);
  }

  get size() {
    return this.entries.size;
  }

  add(e: EntryRec) {
    if (this.entries.has(e.id)) this.remove(e.id);
    this.entries.set(e.id, e);
    for (const s of e.sectionIds) this.push(this.bySection, key(s, e.weekday), e);
    for (const t of e.teachers) this.push(this.byTeacher, key(t.employeeId, e.weekday), e);
    if (e.spaceId) this.push(this.byRoom, key(e.spaceId, e.weekday), e);
    if (e.groupId) this.push(this.groupDay, e.weekday, e);
    this.push(this.byDay, e.weekday, e);
  }

  remove(id: string): EntryRec | undefined {
    const e = this.entries.get(id);
    if (!e) return undefined;
    this.entries.delete(id);
    for (const s of e.sectionIds) this.bySection.set(key(s, e.weekday), pull(this.bySection.get(key(s, e.weekday)), id));
    for (const t of e.teachers) this.byTeacher.set(key(t.employeeId, e.weekday), pull(this.byTeacher.get(key(t.employeeId, e.weekday)), id));
    if (e.spaceId) this.byRoom.set(key(e.spaceId, e.weekday), pull(this.byRoom.get(key(e.spaceId, e.weekday)), id));
    if (e.groupId) this.groupDay.set(e.weekday, pull(this.groupDay.get(e.weekday), id));
    this.byDay.set(e.weekday, pull(this.byDay.get(e.weekday), id));
    return e;
  }

  private push<K>(map: Map<K, EntryRec[]>, k: K, e: EntryRec) {
    const list = map.get(k);
    if (list) list.push(e);
    else map.set(k, [e]);
  }

  get(id: string) {
    return this.entries.get(id);
  }

  ofSection(sectionId: string, day: Weekday): EntryRec[] {
    return this.bySection.get(key(sectionId, day)) ?? [];
  }

  ofTeacher(employeeId: string, day: Weekday): EntryRec[] {
    return this.byTeacher.get(key(employeeId, day)) ?? [];
  }

  ofRoom(spaceId: string, day: Weekday): EntryRec[] {
    return this.byRoom.get(key(spaceId, day)) ?? [];
  }

  groupLessons(day: Weekday): EntryRec[] {
    return this.groupDay.get(day) ?? [];
  }

  onDay(day: Weekday): EntryRec[] {
    return this.byDay.get(day) ?? [];
  }

  all(): EntryRec[] {
    return [...this.entries.values()];
  }

  /** Applies the steps and returns a function that puts everything back exactly as it was. */
  apply(ops: Op[], periods: Map<string, PeriodRec>): () => void {
    const undo: { id: string; before: EntryRec | undefined }[] = [];
    for (const op of ops) {
      const id = op.type === 'create' ? op.entry.id : op.id;
      undo.push({ id, before: this.entries.get(id) });
      if (op.type === 'create') this.add(op.entry);
      else if (op.type === 'delete') this.remove(op.id);
      else {
        const current = this.entries.get(op.id);
        if (current) this.add(withContent(current, op.patch, periods));
      }
    }
    return () => {
      for (const { id, before } of undo.reverse()) {
        if (before) this.add(before);
        else this.remove(id);
      }
    };
  }
}

/** A copy of the lesson with the changes applied. A new slot brings the period's real times. */
export function withContent(e: EntryRec, patch: Partial<EntryContent>, periods: Map<string, PeriodRec>): EntryRec {
  const next: EntryRec = { ...e, ...patch, sectionIds: patch.sectionIds ?? e.sectionIds, teachers: patch.teachers ?? e.teachers };
  if (patch.periodId !== undefined || patch.weekday !== undefined) {
    const period = periods.get(next.periodId);
    if (period) {
      next.startMin = period.startMin;
      next.endMin = period.endMin;
      next.templateId = period.templateId;
    }
  }
  return next;
}
