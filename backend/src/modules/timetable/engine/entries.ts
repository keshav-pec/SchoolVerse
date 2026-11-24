import { createHash } from 'node:crypto';
import type { EntryFacultyDoc, EntrySectionDoc, StoredEntry, TimetableEntryDoc } from '../models';
import type { EntryRec, PeriodRec } from './types';

/** Conversions between a lesson in the database, in the checker and inside a change set. */

export function toRec(doc: TimetableEntryDoc, sections: EntrySectionDoc[], faculty: EntryFacultyDoc[]): EntryRec {
  return {
    id: doc._id,
    weekday: doc.weekday,
    periodId: doc.periodId,
    startMin: doc.startMin,
    endMin: doc.endMin,
    templateId: '',
    entryType: doc.entryType,
    subjectOfferingId: doc.subjectOfferingId,
    activityName: doc.activityName,
    groupId: doc.teachingGroupId,
    spaceId: doc.physicalSpaceId,
    isFixed: doc.isFixed,
    source: doc.source,
    notes: doc.notes,
    version: doc.version,
    rev: doc.rev,
    copiedFromEntryId: doc.copiedFromEntryId,
    sectionIds: sections.filter((s) => s.entryId === doc._id).map((s) => s.sectionOfferingId).sort(),
    teachers: faculty.filter((f) => f.entryId === doc._id).sort((a, b) => (a.role === b.role ? a.employeeId.localeCompare(b.employeeId) : a.role === 'MAIN' ? -1 : 1)).map((f) => ({ employeeId: f.employeeId, role: f.role })),
  };
}

export function toStored(e: EntryRec): StoredEntry {
  return {
    id: e.id,
    weekday: e.weekday,
    periodId: e.periodId,
    entryType: e.entryType,
    subjectOfferingId: e.subjectOfferingId,
    activityName: e.activityName,
    groupId: e.groupId,
    spaceId: e.spaceId,
    isFixed: e.isFixed,
    source: e.source,
    notes: e.notes,
    version: e.version,
    copiedFromEntryId: e.copiedFromEntryId,
    sectionIds: [...e.sectionIds],
    teachers: e.teachers.map((t) => ({ ...t })),
  };
}

export function fromStored(s: StoredEntry, periods: Map<string, PeriodRec>, rev = 0): EntryRec {
  const period = periods.get(s.periodId);
  return { ...s, startMin: period?.startMin ?? 0, endMin: period?.endMin ?? 0, templateId: period?.templateId ?? '', rev, sectionIds: [...s.sectionIds], teachers: s.teachers.map((t) => ({ ...t })) };
}

/** What an override covered. If the lesson changes in any of these ways the override stops counting. */
export function signatureOf(e: EntryRec, rule: string): string {
  const parts = [rule, e.weekday, e.periodId, e.subjectOfferingId ?? '', e.spaceId ?? '', e.groupId ?? '', [...e.sectionIds].sort().join(','), e.teachers.map((t) => t.employeeId).sort().join(',')];
  return createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 24);
}

/** True when two copies of a lesson differ in anything a change can touch. */
export function sameContent(a: EntryRec, b: EntryRec): boolean {
  return (
    a.weekday === b.weekday &&
    a.periodId === b.periodId &&
    a.entryType === b.entryType &&
    a.subjectOfferingId === b.subjectOfferingId &&
    a.activityName === b.activityName &&
    a.groupId === b.groupId &&
    a.spaceId === b.spaceId &&
    a.isFixed === b.isFixed &&
    a.notes === b.notes &&
    [...a.sectionIds].sort().join() === [...b.sectionIds].sort().join() &&
    JSON.stringify(a.teachers) === JSON.stringify(b.teachers)
  );
}
