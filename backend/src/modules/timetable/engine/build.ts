import { randomUUID } from 'node:crypto';
import type { EntrySource, EntryType, SuitabilityTagCode, Weekday } from '@shared';
import { overlaps } from './board';
import { allowedTeachers, neededTags, studentsIn } from './check';
import type { EntryRec, RoomRec, Snapshot } from './types';

/** What a person (or Smart Draft) asks for. Anything left out is worked out here, the same way for every caller. */
export interface EntryInput {
  weekday: Weekday;
  periodId: string;
  entryType: EntryType;
  subjectOfferingId?: string | null;
  activityName?: string | null;
  groupId?: string | null;
  sectionIds: string[];
  /** Left out: the teacher from Assign Classes. An empty list means none. */
  teacherIds?: string[];
  /** Left out: the Home Classroom, or the best suitable free room. `null` means no room. */
  spaceId?: string | null;
  isFixed?: boolean;
  notes?: string | null;
  source?: EntrySource;
  copiedFromEntryId?: string | null;
}

const byName = (a: RoomRec, b: RoomRec) => a.spaceName.localeCompare(b.spaceName, 'en', { numeric: true, sensitivity: 'base' });

const busyAt = (snap: Snapshot, spaceId: string, e: Pick<EntryRec, 'id' | 'weekday' | 'startMin' | 'endMin'>) => snap.board.ofRoom(spaceId, e.weekday).some((o) => o.id !== e.id && overlaps(e, o));

export interface RoomOption {
  room: RoomRec;
  ok: boolean;
  reason: string | null;
  /** Fits the students (or the seat count is not known). */
  fits: boolean;
}

/** Every room at the campus, judged for this lesson's slot: open, suitable, free, big enough. */
export function roomOptions(snap: Snapshot, e: EntryRec, needs: SuitabilityTagCode[] = neededTags(snap, e)): RoomOption[] {
  const students = studentsIn(snap, e);
  return [...snap.rooms.values()]
    .sort(byName)
    .map((room) => {
      const fits = room.capacity === null || room.capacity >= students;
      let reason: string | null = null;
      if (!room.usable) reason = room.reason ?? `${room.spaceName} is not open.`;
      else if (snap.closures.has(room.spaceId)) reason = `${room.spaceName} is closed for a long time.`;
      else if (needs.some((t) => !room.tags.includes(t))) reason = `${room.spaceName} is not set up for what this subject needs.`;
      else if (busyAt(snap, room.spaceId, e)) reason = `${room.spaceName} is already used at this time.`;
      return { room, ok: reason === null, reason, fits };
    });
}

/** The best free room: one that fits and is the smallest that does, so big rooms stay free. */
export function bestRoom(snap: Snapshot, e: EntryRec, needs: SuitabilityTagCode[] = neededTags(snap, e)): RoomRec | null {
  const free = roomOptions(snap, e, needs).filter((o) => o.ok);
  const fitting = free.filter((o) => o.fits);
  const pool = fitting.length > 0 ? fitting : [];
  pool.sort((a, b) => (a.room.capacity ?? Number.MAX_SAFE_INTEGER) - (b.room.capacity ?? Number.MAX_SAFE_INTEGER) || byName(a.room, b.room));
  return pool[0]?.room ?? null;
}

/** The room a lesson gets when nobody picked one. */
export function autoRoom(snap: Snapshot, e: EntryRec): string | null {
  if (e.entryType !== 'SUBJECT' && !e.groupId) return null;
  const needs = neededTags(snap, e);
  if (needs.length > 0 || e.groupId) return bestRoom(snap, e, needs)?.spaceId ?? null;
  const homes = [...new Set(e.sectionIds.map((s) => snap.homeRoom.get(s) ?? ''))];
  const home = homes.length === 1 && homes[0] ? homes[0] : null;
  const room = home ? snap.rooms.get(home) : undefined;
  if (room && room.usable && !snap.closures.has(room.spaceId) && !busyAt(snap, room.spaceId, e)) return room.spaceId;
  // Several sections together, or the Home Classroom is not free: only a room that fits is better than none.
  if (e.sectionIds.length > 1) return bestRoom(snap, e, needs)?.spaceId ?? null;
  return null;
}

export function makeEntry(snap: Snapshot, input: EntryInput, id: string = randomUUID()): EntryRec {
  const period = snap.periods.get(input.periodId);
  const group = input.groupId ? snap.groups.get(input.groupId) : undefined;
  const rec: EntryRec = {
    id,
    weekday: input.weekday,
    periodId: input.periodId,
    startMin: period?.startMin ?? 0,
    endMin: period?.endMin ?? 0,
    templateId: period?.templateId ?? '',
    entryType: input.entryType,
    subjectOfferingId: group ? group.subjectOfferingId : (input.subjectOfferingId ?? null),
    activityName: input.entryType === 'SUBJECT' ? null : (input.activityName ?? null),
    groupId: input.groupId ?? null,
    spaceId: null,
    isFixed: input.isFixed ?? false,
    source: input.source ?? 'MANUAL',
    notes: input.notes ?? null,
    version: 1,
    rev: 0,
    copiedFromEntryId: input.copiedFromEntryId ?? null,
    sectionIds: input.groupId ? [] : [...new Set(input.sectionIds)].sort(),
    teachers: [],
  };
  const teacherIds = input.teacherIds ?? (rec.entryType === 'SUBJECT' ? (() => { const allowed = allowedTeachers(snap, rec); return allowed.length === 1 ? allowed : []; })() : []);
  rec.teachers = [...new Set(teacherIds)].map((employeeId, i) => ({ employeeId, role: i === 0 ? ('MAIN' as const) : ('CO_TEACHER' as const) }));
  rec.spaceId = input.spaceId === undefined ? autoRoom(snap, rec) : input.spaceId;
  return rec;
}
