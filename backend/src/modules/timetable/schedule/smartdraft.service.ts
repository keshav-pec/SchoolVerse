import { createHash } from 'node:crypto';
import type { GenerationRunDTO, SmartDraftData, UnresolvedDTO, UnplacedReason } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { overlaps } from '../engine/board';
import { checkChange, neededTags } from '../engine/check';
import { itemLabel, lessonsFor, needItems, type NeedItem } from '../engine/coverage';
import { explainUnplaced, moveOutcomes } from '../engine/alternatives';
import { evaluate, rankSlots, slotsFor, targetOfItem, teachersOf, validOnly, type Target } from '../engine/rank';
import { loadSnapshot } from '../engine/snapshot';
import type { EntryRec, Snapshot } from '../engine/types';
import { readablePlan, writablePlan } from '../guards';
import { ChangeSet, GenerationRun, type GenerationRunDoc } from '../models';
import { planReadiness } from '../readiness.service';
import { recordTimetableAudit } from '../audit';
import { assertEditable, loadVersion } from './version.service';
import { runChange, type PlannedItem } from './pipeline';

/**
 * TT-UX-08 to 11 — Smart Draft. A step-by-step method with no chance in it: the same input always gives the same timetable. It asks the
 * same clash checker and the same slot ranking as everything else, so it can only place what is valid. It works on a copy in memory, then
 * saves everything in one transaction, checking again at the last moment. If someone edited meanwhile, it starts again on the new state.
 */

const TIME_LIMIT_MS = 30_000;
const MAX_ATTEMPTS = 3;

/** Lets a test change the draft between planning and saving, to prove that a busy draft is re-planned. */
export const smartDraftHooks: { afterPlan?: () => Promise<void> } = {};

const ACTIVITY_CATEGORIES = new Set(['PHYSICAL_EDUCATION', 'ARTS', 'SKILL']);

interface Planned {
  entries: EntryRec[];
  removedIds: string[];
  unresolved: UnresolvedDTO[];
  needed: number;
  itemCount: number;
  timedOut: boolean;
  rev: number;
}

const doublesFormed = (snap: Snapshot, lessons: EntryRec[]) =>
  lessons.filter((a) => lessons.some((b) => b.id !== a.id && a.weekday === b.weekday && a.templateId === b.templateId && (snap.periods.get(b.periodId)?.lessonIndex ?? -9) === (snap.periods.get(a.periodId)?.lessonIndex ?? -99) + 1)).length;

function teacherFreeSlots(snap: Snapshot, teacherId: string, target: Target): number {
  return slotsFor(snap, target).filter((s) => {
    const slot = { weekday: s.weekday, startMin: s.period.startMin, endMin: s.period.endMin };
    if (snap.board.ofTeacher(teacherId, s.weekday).some((o) => overlaps(o, slot))) return false;
    return !(snap.availability.get(teacherId) ?? []).some((a) => a.kind === 'UNAVAILABLE' && a.weekday === s.weekday && a.startMin < slot.endMin && slot.startMin < a.endMin);
  }).length;
}

const unresolvedOf = (snap: Snapshot, item: NeedItem, remaining: number, reason: UnplacedReason, message: string): UnresolvedDTO => ({ key: item.key, label: itemLabel(snap, item), remaining, reason, message });

/** One repair step: if the best slots are blocked by exactly one earlier Smart Draft lesson that can go elsewhere, move it and use the slot. */
function repair(snap: Snapshot, target: Target, teachers: string[], mine: Set<string>): EntryRec[] | null {
  let tried = 0;
  for (const slot of slotsFor(snap, target)) {
    if (tried >= 8) return null;
    const c = evaluate(snap, target, slot, { teacherIds: teachers, source: 'SMART_DRAFT' });
    if (!c || c.blockers.length === 0) continue;
    const blockedBy = new Set(c.blockers.flatMap((b) => b.blockedBy));
    const onlyBusy = c.blockers.every((b) => ['TEACHER_BUSY', 'SECTION_BUSY', 'ROOM_BUSY'].includes(b.rule) && b.blockedBy.length > 0);
    if (!onlyBusy || blockedBy.size !== 1) continue;
    const blocker = snap.board.get([...blockedBy][0]!);
    if (!blocker || blocker.isFixed || !mine.has(blocker.id) || blocker.groupId) continue;
    tried += 1;
    for (const alt of moveOutcomes(snap, blocker).filter((m) => m.outcome.blockers.length === 0 && !(m.slot.weekday === blocker.weekday && m.slot.period.id === blocker.periodId)).slice(0, 12)) {
      const op = { type: 'update' as const, id: blocker.id, patch: { weekday: alt.slot.weekday, periodId: alt.slot.period.id } };
      const outcome = checkChange(snap, [op, ...c.entries.map((entry) => ({ type: 'create' as const, entry }))]);
      if (outcome.blockers.length > 0) continue;
      snap.board.apply([op], snap.periods);
      for (const entry of c.entries) snap.board.add(entry);
      return c.entries;
    }
  }
  return null;
}

function plan(snap: Snapshot, mode: SmartDraftData['mode'], deadline: number): Planned {
  const removedIds: string[] = [];
  if (mode === 'START_FRESH') for (const e of snap.board.all()) if (!e.isFixed) removedIds.push(snap.board.remove(e.id)!.id);
  const items = needItems(snap);
  const unresolved: UnresolvedDTO[] = [];
  const created = new Set<string>();
  const order: { item: NeedItem; target: Target; teachers: string[]; key: (string | number)[] }[] = [];
  for (const item of items) {
    const target = targetOfItem(snap, item);
    const have = lessonsFor(snap, item).length;
    const remaining = item.needed - have;
    if (remaining <= 0) continue;
    const teachers = teachersOf(snap, target);
    const needs = neededTags(snap, { groupId: target.groupId, sectionIds: target.sectionIds, subjectOfferingId: target.subjectOfferingId, entryType: 'SUBJECT' } as EntryRec);
    if (slotsFor(snap, target).length === 0) unresolved.push(unresolvedOf(snap, item, remaining, 'NO_PERIODS', `${itemLabel(snap, item)} has no Daily Periods.`));
    else if (teachers.length === 0) unresolved.push(unresolvedOf(snap, item, remaining, 'NO_TEACHER', 'No teacher is assigned. Assign one in Assign Classes.'));
    else if (teachers.length > 1) unresolved.push(unresolvedOf(snap, item, remaining, 'PICK_TEACHER', 'There are two teachers. Pick one.'));
    else if (needs.length > 0 && ![...snap.rooms.values()].some((r) => r.usable && needs.every((t) => r.tags.includes(t)))) unresolved.push(unresolvedOf(snap, item, remaining, 'NO_ROOM_KIND', 'No open room is set up for what this subject needs.'));
    else {
      const subject = snap.facts.offeringOf.get(item.subjectOfferingId);
      const category = subject ? snap.facts.subjectOf.get(subject.subjectId)?.category : undefined;
      order.push({ item, target, teachers, key: [needs.length > 0 ? 0 : 1, item.values.doubleMode !== 'NONE' ? 0 : 1, teacherFreeSlots(snap, teachers[0]!, target), item.kind === 'GROUP' ? 0 : 1, -item.needed, category && ACTIVITY_CATEGORIES.has(category) ? 1 : 0, itemLabel(snap, item), item.key] });
    }
  }
  order.sort((a, b) => {
    for (let i = 0; i < a.key.length; i += 1) {
      const x = a.key[i]!;
      const y = b.key[i]!;
      if (x !== y) return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true });
    }
    return 0;
  });

  let timedOut = false;
  for (const { item, target, teachers } of order) {
    let remaining = item.needed - lessonsFor(snap, item).length;
    const reasonLeft = (reason: UnplacedReason, message: string) => unresolved.push(unresolvedOf(snap, item, remaining, reason, message));
    const wantDoubles = item.values.doubleMode === 'NONE' ? 0 : Math.max(0, Math.min(item.values.doublesPerWeek - doublesFormed(snap, lessonsFor(snap, item)), Math.floor(remaining / 2)));
    for (let step = 0; remaining > 0; step += 1) {
      if (Date.now() > deadline) {
        timedOut = true;
        reasonLeft('TIME_UP', 'Smart Draft ran out of time. Run it again to continue.');
        break;
      }
      const double = step < wantDoubles;
      let best = validOnly(rankSlots(snap, target, { teacherIds: teachers, double, fast: true, source: 'SMART_DRAFT' }))[0];
      if (!best && double) {
        // A double that cannot be found is not worth failing for: the subject still needs its periods.
        best = validOnly(rankSlots(snap, target, { teacherIds: teachers, fast: true, source: 'SMART_DRAFT' }))[0];
      }
      if (best) for (const e of best.entries) snap.board.add(e);
      const placed: EntryRec[] | null = best ? best.entries : repair(snap, target, teachers, created);
      if (!placed) {
        const why = explainUnplaced(snap, target, item.needed, item.needed - remaining);
        reasonLeft(why.reasonCode, why.message);
        break;
      }
      for (const e of placed) created.add(e.id);
      remaining -= placed.length;
    }
    if (timedOut) break;
  }
  if (timedOut) {
    const done = new Set(unresolved.map((u) => u.key));
    for (const { item } of order) {
      const remaining = item.needed - lessonsFor(snap, item).length;
      if (remaining > 0 && !done.has(item.key)) unresolved.push(unresolvedOf(snap, item, remaining, 'TIME_UP', 'Smart Draft ran out of time. Run it again to continue.'));
    }
  }
  const entries = [...created].map((id) => snap.board.get(id)).filter((e): e is EntryRec => Boolean(e));
  return { entries, removedIds, unresolved, needed: items.reduce((n, i) => n + i.needed, 0), itemCount: items.length, timedOut, rev: snap.rev };
}

export const runDTO = (r: GenerationRunDoc): GenerationRunDTO => ({
  runId: r._id,
  versionId: r.versionId,
  runType: r.runType,
  mode: r.mode,
  status: r.status,
  startedAt: r.startedAt.toISOString(),
  completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  totalRequirements: r.totalRequirements,
  totalPeriods: r.totalPeriods,
  entriesCreated: r.entriesCreated,
  unresolvedCount: r.unresolvedCount,
  warningCount: r.warningCount,
  summary: (r.configurationSnapshot as { summary?: string }).summary ?? '',
  unresolved: r.unresolved.map((u) => ({ key: u.key, label: u.label, remaining: u.remaining, reason: u.reason as UnplacedReason, message: u.message })),
  rev: r.rev,
  changeSetId: r.changeSetId,
});

export async function getRun(ctx: ServiceContext, runId: string): Promise<GenerationRunDTO> {
  const run = await GenerationRun.findOne({ _id: runId, tenantId: ctx.tenantId }).lean<GenerationRunDoc>();
  if (!run) throw AppError.notFound('Run not found.');
  const version = await loadVersion(ctx, run.versionId);
  await readablePlan(ctx, version.planId);
  return runDTO(run);
}

const fmt = (n: number) => n.toLocaleString('en-US');

export async function runSmartDraft(ctx: ServiceContext, versionId: string, data: SmartDraftData): Promise<GenerationRunDTO> {
  const first = await loadVersion(ctx, versionId);
  const planDoc = await writablePlan(ctx, first.planId);
  assertEditable(first);
  if (data.requestId) {
    const prior = await ChangeSet.findOne({ tenantId: ctx.tenantId, versionId, requestId: data.requestId, kind: 'SMART_DRAFT' }).select('_id').lean<{ _id: string }>();
    const run = prior ? await GenerationRun.findOne({ tenantId: ctx.tenantId, changeSetId: prior._id }).lean<GenerationRunDoc>() : null;
    if (run) return runDTO(run);
  }
  if (data.mode === 'START_FRESH' && !data.confirm) throw AppError.validation({ confirm: 'Starting fresh removes every lesson that is not fixed. Confirm to continue.' });
  const readiness = await planReadiness(ctx, planDoc._id);
  if (!readiness.canSmartDraft) throw new AppError('NOT_READY', readiness.smartDraftBlockedBy.join(' '), { blockedBy: readiness.smartDraftBlockedBy, areas: readiness.areas.filter((a) => a.status !== 'READY').map((a) => a.area) });

  const startedAt = new Date();
  const limit = Number(process.env.SMART_DRAFT_TIME_LIMIT_MS) || TIME_LIMIT_MS;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const version = await loadVersion(ctx, versionId);
    const snap = await loadSnapshot(ctx, planDoc, version);
    const planned = plan(snap, data.mode, Date.now() + limit);
    await smartDraftHooks.afterPlan?.();

    const items: PlannedItem[] = [];
    if (planned.removedIds.length > 0) items.push({ ref: 'fresh', label: 'Lessons cleared before the draft', ops: planned.removedIds.map((id) => ({ type: 'delete' as const, id })) });
    for (const entry of planned.entries) items.push({ ref: entry.id, label: entry.id, ops: [{ type: 'create', entry }] });
    try {
      const outcome = await runChange(ctx, versionId, {
        kind: 'SMART_DRAFT',
        requestId: data.requestId,
        mode: 'APPLY_VALID',
        build: (fresh) => {
          if (fresh.rev !== planned.rev) throw new AppError('SMART_DRAFT_BUSY');
          return { items, label: `Smart Draft placed ${fmt(planned.entries.length)} lesson${planned.entries.length === 1 ? '' : 's'}` };
        },
      });
      return await recordRun(ctx, planDoc, versionId, data, startedAt, planned, outcome.result.entries.length, outcome.failed.length, outcome.result.issues.filter((i) => i.severity === 'WARNING').length, outcome.result.rev, outcome.result.changeSetId || null, snap);
    } catch (err) {
      if (err instanceof AppError && err.code === 'SMART_DRAFT_BUSY' && attempt < MAX_ATTEMPTS) continue;
      throw err;
    }
  }
  throw new AppError('SMART_DRAFT_BUSY');
}

async function recordRun(ctx: ServiceContext, plan: Awaited<ReturnType<typeof writablePlan>>, versionId: string, data: SmartDraftData, startedAt: Date, planned: Planned, created: number, pruned: number, warnings: number, rev: number, changeSetId: string | null, snap: Snapshot): Promise<GenerationRunDTO> {
  const unresolved = [...planned.unresolved];
  if (pruned > 0) unresolved.push({ key: 'saved-late', label: 'Some lessons', remaining: pruned, reason: 'NO_SLOT', message: `${pruned} lesson${pruned === 1 ? '' : 's'} no longer fitted when saving, because something changed. Run Smart Draft again.` });
  const left = unresolved.reduce((n, u) => n + u.remaining, 0);
  const placed = Math.max(0, planned.needed - left);
  const summary = `${fmt(placed)} of ${fmt(planned.needed)} placed · ${fmt(left)} left · 0 clashes · ${fmt(warnings)} warning${warnings === 1 ? '' : 's'}`;
  const hash = createHash('sha1').update(needItems(snap).map((i) => `${i.key}:${i.needed}`).join('|')).digest('hex').slice(0, 16);
  return withTransaction(async (db) => {
    const [run] = await GenerationRun.create(
      [
        {
          tenantId: ctx.tenantId,
          schoolId: plan.schoolId,
          versionId,
          planId: plan._id,
          runType: 'SMART_DRAFT',
          mode: data.mode,
          requestedBy: ctx.userId,
          startedAt,
          completedAt: new Date(),
          totalRequirements: planned.itemCount,
          totalPeriods: planned.needed,
          entriesCreated: created,
          unresolvedCount: unresolved.length,
          warningCount: warnings,
          status: planned.timedOut ? 'PARTIAL' : 'DONE',
          configurationSnapshot: { summary, hash, rev, sections: snap.facts.sections.length, teachers: snap.campusTeachers.size, rooms: snap.rooms.size, groups: snap.groups.size },
          unresolved,
          rev,
          changeSetId,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    await recordTimetableAudit(ctx, db, { entityType: 'generation_run', entityId: run!._id, action: 'generation_run.smart_draft', planId: plan._id, locationId: plan.locationId, metadata: { versionId, mode: data.mode, created, left, warnings, status: run!.status } });
    return runDTO(run!.toObject() as GenerationRunDoc);
  });
}
