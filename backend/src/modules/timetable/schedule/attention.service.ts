import { SCHEDULE_ATTENTION_LABELS, SCHEDULE_ATTENTION_GROUPS, type RuleCode, type ScheduleAttentionDTO, type ScheduleAttentionGroup, type ScheduleAttentionGroupDTO, type ScheduleAttentionRowDTO } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { explainUnplaced } from '../engine/alternatives';
import { issuesFor, neededTags } from '../engine/check';
import { coverageRows, itemLabel, needItems } from '../engine/coverage';
import { listWords, namerOf, plural, tagLabel } from '../engine/messages';
import { rankSlots, targetOfItem, validOnly } from '../engine/rank';
import { loadSnapshot } from '../engine/snapshot';
import type { Issue } from '../engine/types';
import { RunItem, type RunItemDoc } from '../models';
import { moveSuggestions } from './slots.service';
import { readableVersion } from './version.service';

/** TT-UX-12 — the short list of what is still to fix, worked out live from the draft, so it never goes stale. Row ids are stable. */

const fmt = (n: number) => n.toLocaleString('en-US');
const MAX_SLOT_LOOKUPS = 200;

const TEACHER_HEALTH = new Set<RuleCode>(['NOT_THIS_TEACHER', 'TEACHER_UNAVAILABLE']);
const ROOM_HEALTH = new Set<RuleCode>(['ROOM_UNAVAILABLE', 'ROOM_NOT_SUITABLE', 'ROOM_TOO_SMALL']);
const COVERAGE_WARNINGS = new Set<RuleCode>(['MAX_PER_DAY', 'DOUBLE_PERIOD', 'WEEK_COUNT']);
const WORKLOAD_WARNINGS = new Set<RuleCode>(['TEACHER_LOAD', 'TRAVEL_TIME']);

const blank = (row: Partial<ScheduleAttentionRowDTO> & Pick<ScheduleAttentionRowDTO, 'rowId' | 'title' | 'message' | 'fix' | 'fixLabel'>): ScheduleAttentionRowDTO => ({ entryId: null, sectionOfferingId: null, subjectOfferingId: null, teachingGroupId: null, employeeId: null, runItemId: null, slot: null, suggestionToken: null, ...row });

export async function getAttention(ctx: ServiceContext, versionId: string): Promise<ScheduleAttentionDTO> {
  const { version, plan } = await readableVersion(ctx, versionId);
  const snap = await loadSnapshot(ctx, plan, version);
  const n = namerOf(snap);
  const rows: Record<ScheduleAttentionGroup, ScheduleAttentionRowDTO[]> = { NOT_PLACED: [], TEACHERS: [], ROOMS: [], COVERAGE: [], WORKLOAD: [], CHANGED: [], LAST_YEAR: [] };

  // ── What is still to place, and why
  const items = needItems(snap);
  const coverage = coverageRows(snap, items);
  let lookups = 0;
  items.forEach((item, i) => {
    const row = coverage[i]!;
    if (row.left <= 0) return;
    const target = targetOfItem(snap, item);
    const why = explainUnplaced(snap, target, row.needed, row.placed);
    const label = itemLabel(snap, item);
    const base = { sectionOfferingId: item.sectionId, subjectOfferingId: item.subjectOfferingId, teachingGroupId: item.groupId };
    const head = `${row.left} of ${row.needed} periods not placed.`;
    if (why.reasonCode === 'NO_TEACHER' || why.reasonCode === 'PICK_TEACHER') {
      rows.TEACHERS.push(blank({ ...base, rowId: `unplaced:${item.key}`, title: label, message: `${head} ${why.message}`, fix: why.reasonCode === 'NO_TEACHER' ? 'ASSIGN_CLASSES' : 'PICK_TEACHER', fixLabel: why.bestFix?.label ?? 'Pick A Teacher' }));
      return;
    }
    if (why.reasonCode === 'NO_ROOM_KIND') {
      rows.ROOMS.push(blank({ ...base, rowId: `unplaced:${item.key}`, title: label, message: `${head} ${why.message}`, fix: 'SPACE_SETUP', fixLabel: 'Go To Space Setup' }));
      return;
    }
    const best = lookups < MAX_SLOT_LOOKUPS ? validOnly(rankSlots(snap, target))[0] : undefined;
    lookups += 1;
    rows.NOT_PLACED.push(blank({
      ...base,
      rowId: `unplaced:${item.key}`,
      title: label,
      message: best ? `${head} ${best.why[0] ?? ''}`.trim() : `${head} ${why.message}`,
      fix: best || !why.bestFix?.entryId ? 'PLACE_SLOT' : 'MOVE_ENTRY',
      fixLabel: best ? 'Place It There' : (why.bestFix?.label ?? 'Place It'),
      entryId: why.bestFix?.entryId ?? null,
      slot: best ? { weekday: best.weekday, periodId: best.period.id, label: n.when(best.weekday, best.period.id) } : null,
    }));
  });

  // ── Lessons that no longer fit, and soft problems worth a look
  const seenWorkload = new Set<string>();
  for (const e of snap.board.all().sort((a, b) => a.id.localeCompare(b.id))) {
    const issues: Issue[] = issuesFor(snap, e);
    const title = `${n.lesson(e)}, ${n.when(e.weekday, e.periodId)}`;
    const common = { entryId: e.id, sectionOfferingId: e.sectionIds[0] ?? null, subjectOfferingId: e.subjectOfferingId, teachingGroupId: e.groupId };
    for (const i of issues.filter((x) => x.severity === 'CLASH')) {
      const rowId = `health:${e.id}:${i.rule}`;
      const teacherRelated = TEACHER_HEALTH.has(i.rule) || (i.rule === 'WRONG_CAMPUS' && i.culprit?.kind === 'TEACHER');
      const roomRelated = ROOM_HEALTH.has(i.rule) || (i.rule === 'WRONG_CAMPUS' && i.culprit?.kind === 'ROOM');
      if (teacherRelated) rows.TEACHERS.push(blank({ ...common, rowId, title, message: i.message, fix: i.rule === 'TEACHER_UNAVAILABLE' ? 'MOVE_ENTRY' : 'PICK_TEACHER', fixLabel: i.rule === 'TEACHER_UNAVAILABLE' ? 'Move It' : 'Pick A Teacher', employeeId: i.culprit?.kind === 'TEACHER' ? i.culprit.id : null }));
      else if (roomRelated) rows.ROOMS.push(blank({ ...common, rowId, title, message: i.message, fix: 'PICK_ROOM', fixLabel: 'Pick A Room' }));
      else rows.CHANGED.push(blank({ ...common, rowId, title, message: i.message, fix: 'MOVE_ENTRY', fixLabel: 'Move It' }));
    }
    if (e.entryType === 'SUBJECT' && !e.spaceId) {
      const needs = neededTags(snap, e);
      if (needs.length > 0) rows.ROOMS.push(blank({ ...common, rowId: `health:${e.id}:NO_ROOM`, title, message: `No room yet. This lesson needs ${listWords(needs.map(tagLabel))}.`, fix: 'PICK_ROOM', fixLabel: 'Pick A Room' }));
    }
    for (const i of issues.filter((x) => x.severity === 'WARNING')) {
      const rowId = `health:${e.id}:${i.rule}`;
      if (i.rule === 'ROOM_TOO_SMALL') rows.ROOMS.push(blank({ ...common, rowId, title, message: i.message, fix: 'PICK_ROOM', fixLabel: 'Pick A Room' }));
      else if (COVERAGE_WARNINGS.has(i.rule)) rows.COVERAGE.push(blank({ ...common, rowId, title, message: i.message, fix: 'MOVE_ENTRY', fixLabel: 'Move It' }));
      else if (WORKLOAD_WARNINGS.has(i.rule)) {
        const teacher = e.teachers[0]?.employeeId ?? null;
        const key = `${teacher}:${i.rule}`;
        if (seenWorkload.has(key)) continue;
        seenWorkload.add(key);
        const fix = i.rule === 'TEACHER_LOAD' ? moveSuggestions(snap, e, 'TEACHER_LOAD', 1)[0] : undefined;
        rows.WORKLOAD.push(blank({ ...common, rowId: `workload:${key}`, title: teacher ? n.teacher(teacher) : title, message: i.message, fix: fix ? 'APPLY_FIX' : 'MOVE_ENTRY', fixLabel: fix ? fix.label : 'Move It', employeeId: teacher, suggestionToken: fix?.suggestionToken ?? null }));
      }
    }
  }
  for (const r of coverage.filter((c) => c.over > 0)) rows.COVERAGE.push(blank({ rowId: `over:${r.key}`, title: r.kind === 'GROUP' ? (r.groupName ?? 'Teaching Group') : `${r.sectionLabel} ${r.subjectName}`, message: `${plural(r.over, 'period')} more than the ${r.needed} needed. Remove ${r.over === 1 ? 'one' : 'some'}.`, fix: 'MOVE_ENTRY', fixLabel: 'Review Lessons', sectionOfferingId: r.sectionOfferingId, subjectOfferingId: r.subjectOfferingId, teachingGroupId: r.teachingGroupId }));
  const withLessons = new Set(snap.board.all().flatMap((e) => e.sectionIds));
  for (const s of snap.facts.sections) if (withLessons.has(s._id) && !snap.homeRoom.has(s._id)) rows.ROOMS.push(blank({ rowId: `home:${s._id}`, title: n.section(s._id), message: `${n.section(s._id)} has no Home Classroom, so its lessons have no room.`, fix: 'CLASSROOM_ALLOCATION', fixLabel: 'Go To Classroom Allocation', sectionOfferingId: s._id }));

  // ── Last year's items
  const open = await RunItem.find({ tenantId: ctx.tenantId, versionId, status: 'OPEN' }).sort({ createdAt: 1, _id: 1 }).lean<RunItemDoc[]>();
  for (const item of open) {
    const p = item.payload as { label?: string; message?: string; suggestionText?: string | null };
    rows.LAST_YEAR.push(blank({ rowId: `item:${item._id}`, title: p.label ?? 'A lesson', message: [p.message, p.suggestionText].filter(Boolean).join(' '), fix: 'ACCEPT_MAPPING', fixLabel: item.suggestion ? 'Accept' : 'Decide', runItemId: item._id }));
  }

  const groups: ScheduleAttentionGroupDTO[] = SCHEDULE_ATTENTION_GROUPS.map((group) => {
    const list = rows[group].sort((a, b) => a.title.localeCompare(b.title, 'en', { numeric: true }) || a.rowId.localeCompare(b.rowId));
    return { group, label: SCHEDULE_ATTENTION_LABELS[group], count: list.length, rows: list };
  });
  const total = groups.reduce((c, g) => c + g.count, 0);
  const needed = coverage.reduce((c, r) => c + r.needed, 0);
  const placed = coverage.reduce((c, r) => c + Math.min(r.placed, r.needed), 0);
  return { versionId, rev: version.rev, groups, total, needed, placed, progress: `${fmt(placed)} / ${fmt(needed)} placed · ${fmt(total)} need attention` };
}
