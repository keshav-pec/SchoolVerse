import { WEEKDAYS, type CoverageDTO, type CoverageRowDTO, type RequirementValuesDTO } from '@shared';
import { sectionLabelOf, subjectNameOf } from '../facts';
import type { EntryRec, Snapshot } from './types';

/** One thing the plan asks for: a subject in a section, or a Teaching Group's lessons. */
export interface NeedItem {
  key: string;
  kind: 'SECTION' | 'GROUP';
  sectionId: string | null;
  groupId: string | null;
  classOfferingId: string;
  subjectOfferingId: string;
  needed: number;
  values: RequirementValuesDTO;
}

/**
 * The lessons the plan needs, worked out from the effective Subject Needs. A subject that a Teaching Group covers is asked of the group,
 * not of each section, because the section's students go to the group's lessons.
 */
export function needItems(snap: Snapshot): NeedItem[] {
  const items: NeedItem[] = [];
  const groups = [...snap.groups.values()].filter((g) => g.subjectOfferingId && g.classOfferingId);
  for (const section of snap.facts.sections) {
    for (const offering of snap.facts.subjectOfferings.filter((o) => o.classOfferingId === section.classOfferingId)) {
      if (groups.some((g) => g.subjectOfferingId === offering._id && g.sectionPool.includes(section._id))) continue;
      const values = snap.requirements.forSection(section._id, offering._id);
      if (!values || values.periodsPerWeek <= 0) continue;
      items.push({ key: `sec:${section._id}:${offering._id}`, kind: 'SECTION', sectionId: section._id, groupId: null, classOfferingId: section.classOfferingId, subjectOfferingId: offering._id, needed: values.periodsPerWeek, values });
    }
  }
  for (const g of groups) {
    const values = snap.requirements.forGroup(g.id);
    if (!values || values.periodsPerWeek <= 0) continue;
    items.push({ key: `grp:${g.id}`, kind: 'GROUP', sectionId: null, groupId: g.id, classOfferingId: g.classOfferingId!, subjectOfferingId: g.subjectOfferingId!, needed: values.periodsPerWeek, values });
  }
  return items;
}

/** The lessons on the board that count toward an item. */
export function lessonsFor(snap: Snapshot, item: Pick<NeedItem, 'kind' | 'sectionId' | 'groupId' | 'subjectOfferingId'>): EntryRec[] {
  const out: EntryRec[] = [];
  for (const day of WEEKDAYS) {
    if (item.kind === 'GROUP') out.push(...snap.board.groupLessons(day).filter((o) => o.groupId === item.groupId));
    else out.push(...snap.board.ofSection(item.sectionId!, day).filter((o) => o.entryType === 'SUBJECT' && !o.groupId && o.subjectOfferingId === item.subjectOfferingId));
  }
  return out;
}

export function itemLabel(snap: Snapshot, item: NeedItem): string {
  return item.kind === 'GROUP' ? `${snap.groups.get(item.groupId!)?.name ?? 'Teaching Group'}` : `${sectionLabelOf(snap.facts, item.sectionId!)} ${subjectNameOf(snap.facts, item.subjectOfferingId)}`;
}

export function coverageRows(snap: Snapshot, items: NeedItem[] = needItems(snap)): CoverageRowDTO[] {
  return items.map((item) => {
    const placed = lessonsFor(snap, item).length;
    return {
      key: item.key,
      kind: item.kind,
      sectionOfferingId: item.sectionId,
      sectionLabel: item.sectionId ? sectionLabelOf(snap.facts, item.sectionId) : null,
      teachingGroupId: item.groupId,
      groupName: item.groupId ? (snap.groups.get(item.groupId)?.name ?? null) : null,
      subjectOfferingId: item.subjectOfferingId,
      subjectName: subjectNameOf(snap.facts, item.subjectOfferingId),
      needed: item.needed,
      placed,
      left: Math.max(0, item.needed - placed),
      over: Math.max(0, placed - item.needed),
    };
  });
}

export function coverageOf(rows: CoverageRowDTO[]): CoverageDTO {
  const needed = rows.reduce((n, r) => n + r.needed, 0);
  const placed = rows.reduce((n, r) => n + Math.min(r.placed, r.needed), 0);
  const left = rows.reduce((n, r) => n + r.left, 0);
  return { needed, placed, left, line: `Needs ${needed} · Placed ${placed} · Left ${left}`, rows };
}
