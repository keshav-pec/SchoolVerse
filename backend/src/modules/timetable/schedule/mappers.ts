import { minutesToClock, type TimetableEntryDTO, type TimetableIssueDTO } from '@shared';
import { namerOf } from '../engine/messages';
import type { EntryRec, Issue, Snapshot } from '../engine/types';

export function issueDTO(i: Issue): TimetableIssueDTO {
  return { rule: i.rule, severity: i.severity, message: i.message, who: i.who, when: i.when, overridable: i.overridable, overriddenReason: i.overriddenReason, entryId: i.entryId, blockedBy: i.blockedBy, fix: i.fix };
}

export function entryDTO(snap: Snapshot, e: EntryRec, issues: Issue[] = []): TimetableEntryDTO {
  const n = namerOf(snap);
  const period = snap.periods.get(e.periodId);
  const mine = issues.filter((i) => i.entryId === e.id);
  return {
    entryId: e.id,
    versionId: snap.versionId,
    weekday: e.weekday,
    periodId: e.periodId,
    periodCode: period?.code ?? '',
    periodName: period?.name ?? '',
    startMin: e.startMin,
    endMin: e.endMin,
    start: minutesToClock(e.startMin),
    end: minutesToClock(e.endMin),
    entryType: e.entryType,
    subjectOfferingId: e.subjectOfferingId,
    subjectName: e.subjectOfferingId ? n.subject(e.subjectOfferingId) : null,
    activityName: e.activityName,
    teachingGroupId: e.groupId,
    groupName: e.groupId ? n.group(e.groupId) : null,
    physicalSpaceId: e.spaceId,
    roomName: e.spaceId ? n.room(e.spaceId) : null,
    sections: e.sectionIds.map((id) => ({ sectionOfferingId: id, label: n.section(id) })).sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })),
    teachers: e.teachers.map((t) => ({ employeeId: t.employeeId, fullName: n.teacher(t.employeeId), role: t.role })),
    isFixed: e.isFixed,
    source: e.source,
    notes: e.notes,
    version: e.version,
    rev: e.rev,
    issues: { clash: mine.filter((i) => i.severity === 'CLASH').length, warning: mine.filter((i) => i.severity === 'WARNING').length, info: mine.filter((i) => i.severity === 'INFO').length },
  };
}
