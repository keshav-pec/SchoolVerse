import { minutesToClock, WEEKDAY_LABELS, type ChangeSetDTO, type GridCellDTO, type GridDTO, type GridPeriodDTO, type GridQuery, type VersionChangesDTO, type VersionHealthDTO, type Weekday } from '@shared';
import { AppError } from '../../../core/errors';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { resolveBell } from '../bell.resolve';
import { coverageOf, coverageRows } from '../engine/coverage';
import { issuesFor } from '../engine/check';
import { namerOf } from '../engine/messages';
import { loadSnapshot } from '../engine/snapshot';
import type { EntryRec, PeriodRec, Snapshot } from '../engine/types';
import { teacherWorkload } from '../engine/workload';
import { ChangeSet, type ChangeSetDoc } from '../models';
import { entryDTO, issueDTO } from './mappers';
import { readableVersion } from './version.service';

/** The weekly grid for one section, teacher, room or Teaching Group, and the reads that keep it fresh: changes since a revision, history, health. */

const periodDTO = (p: PeriodRec): GridPeriodDTO => ({ periodId: p.id, periodCode: p.code, periodName: p.name, start: minutesToClock(p.startMin), end: minutesToClock(p.endMin), startMin: p.startMin, endMin: p.endMin, schedulable: p.schedulable });

function periodsOf(snap: Snapshot, templateIds: Set<string>): GridPeriodDTO[] {
  return [...snap.periods.values()]
    .filter((p) => templateIds.has(p.templateId))
    .sort((a, b) => a.startMin - b.startMin || a.code.localeCompare(b.code))
    .map(periodDTO);
}

export async function getGrid(ctx: ServiceContext, versionId: string, query: GridQuery): Promise<GridDTO> {
  const { version, plan } = await readableVersion(ctx, versionId);
  const snap = await loadSnapshot(ctx, plan, version);
  const n = namerOf(snap);
  const defaultTemplate = plan.defaultBellScheduleId ?? [...snap.bell.templates.keys()][0] ?? '';
  const days = snap.plan.operatingDays;
  const lessonsOn = (day: Weekday): EntryRec[] => {
    if (query.view === 'section') return [...snap.board.ofSection(query.id, day), ...snap.board.groupLessons(day).filter((g) => snap.groups.get(g.groupId ?? '')?.sectionPool.includes(query.id))];
    if (query.view === 'teacher') return snap.board.ofTeacher(query.id, day);
    if (query.view === 'room') return snap.board.ofRoom(query.id, day);
    return snap.board.groupLessons(day).filter((g) => g.groupId === query.id);
  };

  let label: string;
  let coverage: GridDTO['coverage'] = null;
  let workload: GridDTO['workload'] = null;
  let bellFor: (day: Weekday) => string | undefined = () => defaultTemplate;
  if (query.view === 'section') {
    const section = snap.facts.sectionOf.get(query.id);
    if (!section) throw AppError.notFound('Section not found.');
    label = n.section(query.id);
    bellFor = (day) => resolveBell(snap.bell, section.classOfferingId, section._id, day)?.templateId;
    coverage = coverageOf(coverageRows(snap).filter((r) => r.sectionOfferingId === query.id || (r.teachingGroupId && snap.groups.get(r.teachingGroupId)?.sectionPool.includes(query.id))));
  } else if (query.view === 'teacher') {
    if (!snap.campusTeachers.has(query.id)) throw AppError.notFound('Teacher not found.');
    label = n.teacher(query.id);
    workload = teacherWorkload(snap, query.id);
  } else if (query.view === 'room') {
    if (!snap.rooms.has(query.id)) throw AppError.notFound('Room not found.');
    label = n.room(query.id);
  } else {
    const group = snap.groups.get(query.id);
    if (!group) throw AppError.notFound('Teaching Group not found.');
    label = group.name;
    const first = group.sectionPool[0] ? snap.facts.sectionOf.get(group.sectionPool[0]) : undefined;
    if (first) bellFor = (day) => resolveBell(snap.bell, first.classOfferingId, first._id, day)?.templateId;
    coverage = coverageOf(coverageRows(snap).filter((r) => r.teachingGroupId === query.id));
  }

  const cells: GridCellDTO[] = [];
  const dayRows = days.map((weekday) => {
    const lessons = [...new Set(lessonsOn(weekday))];
    const templates = new Set<string>([...lessons.map((l) => l.templateId), bellFor(weekday) ?? ''].filter(Boolean));
    for (const l of lessons.sort((a, b) => a.startMin - b.startMin || a.id.localeCompare(b.id))) {
      const issues = issuesFor(snap, l);
      cells.push({ ...entryDTO(snap, l, issues), issueList: issues.map(issueDTO) });
    }
    return { weekday, label: WEEKDAY_LABELS[weekday], periods: periodsOf(snap, templates) };
  });
  return { versionId, rev: version.rev, view: query.view, targetId: query.id, label, status: version.status, days: dayRows, cells, coverage, workload };
}

/** Lessons written after revision `since`, and the ones that went away. The grid asks on focus and every 20 seconds. */
export async function getChanges(ctx: ServiceContext, versionId: string, since: number): Promise<VersionChangesDTO> {
  const { version, plan } = await readableVersion(ctx, versionId);
  if (since >= version.rev) return { rev: version.rev, changed: [], deletedIds: [] };
  const snap = await loadSnapshot(ctx, plan, version);
  const changed = snap.board.all().filter((e) => e.rev > since);
  const sets = await ChangeSet.find({ tenantId: ctx.tenantId, versionId, rev: { $gt: since } }).select('before after').lean<Pick<ChangeSetDoc, 'before' | 'after'>[]>();
  const gone = new Set(sets.flatMap((s) => s.before.map((b) => b.id)).filter((id) => !snap.board.get(id)));
  return { rev: version.rev, changed: changed.map((e) => entryDTO(snap, e)), deletedIds: [...gone] };
}

export async function getHistory(ctx: ServiceContext, versionId: string, limit: number): Promise<ChangeSetDTO[]> {
  await readableVersion(ctx, versionId);
  const sets = await ChangeSet.find({ tenantId: ctx.tenantId, versionId }).sort({ rev: -1, createdAt: -1 }).limit(limit).lean<ChangeSetDoc[]>();
  return sets.map((s) => ({ changeSetId: s._id, versionId: s.versionId, rev: s.rev, kind: s.kind, label: s.label, actorId: s.actorId, createdAt: s.createdAt.toISOString(), entryCount: s.after.length + s.before.filter((b) => !s.after.some((a) => a.id === b.id)).length, undone: Boolean(s.undoneAt), canUndo: !s.undoneAt && s.kind !== 'UNDO' }));
}

/** Runs the checker on every lesson and lists the ones that are no longer valid (an assignment ended, a room was archived, a section was switched off). */
export async function getHealth(ctx: ServiceContext, versionId: string): Promise<VersionHealthDTO> {
  const { version, plan } = await readableVersion(ctx, versionId);
  const snap = await loadSnapshot(ctx, plan, version);
  const n = namerOf(snap);
  const items = [];
  for (const e of snap.board.all().sort((a, b) => a.id.localeCompare(b.id))) {
    const blockers = issuesFor(snap, e).filter((i) => i.severity === 'CLASH');
    if (blockers.length > 0) items.push({ entryId: e.id, label: `${n.lesson(e)} on ${n.when(e.weekday, e.periodId)}`, issues: blockers.map(issueDTO) });
  }
  return { versionId, rev: version.rev, healthy: items.length === 0, items };
}
