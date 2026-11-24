import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { BulkFailureDTO, ChangeKind, RuleCode, WriteResultDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { diffFields } from '../../audit/diff';
import { recordTimetableAudit, emitTimetableEvent } from '../audit';
import { alternativesFor } from '../engine/alternatives';
import { withContent } from '../engine/board';
import { checkChange } from '../engine/check';
import { fromStored, sameContent, signatureOf, toStored } from '../engine/entries';
import { namerOf } from '../engine/messages';
import { loadSnapshot } from '../engine/snapshot';
import type { EntryRec, Issue, Op, Snapshot } from '../engine/types';
import { writablePlan } from '../guards';
import { ChangeSet, ConflictOverride, EntryFaculty, EntrySection, TimetableEntry, TimetableVersion, type ChangeSetDoc, type TimetablePlanDoc } from '../models';
import { entryDTO, issueDTO } from './mappers';
import { assertEditable, loadVersion } from './version.service';

/**
 * The one way a lesson is changed. Every screen and every bulk action ends up here:
 *
 *   1. lock the version (two writers to one draft take turns)
 *   2. read the newest data, so a stale screen can never hide a clash
 *   3. build the steps, check them as a set with the one clash checker
 *   4. a clash saves nothing and answers with reasons and options; warnings are saved and listed
 *   5. write the lessons, one change set (for Undo), one audit event and one domain event, in the same transaction
 */

export interface PlannedItem {
  /** The lesson this item is about (an existing lesson, or the id of the one being made). */
  ref: string;
  label: string;
  ops: Op[];
}

export interface Planned {
  items: PlannedItem[];
  label: string;
  overrides?: { entryId: string; rule: RuleCode; reason: string }[];
  /** More writes that must commit with the change (a run record, an accepted item…). */
  extra?: (db: ClientSession, info: { rev: number; changeSetId: string; failed: BulkFailureDTO[] }) => Promise<void>;
}

export interface ChangeSpec {
  kind: ChangeKind;
  requestId?: string;
  mode?: 'ALL_OR_NOTHING' | 'APPLY_VALID';
  /** For the summary: "9 of 10 can move". */
  verb?: string;
  build: (snap: Snapshot, db: ClientSession) => Promise<Planned> | Planned;
  /** Turns a clash into another error (Undo says "cannot be undone"). */
  clashError?: (blockers: Issue[]) => AppError;
}

export interface ChangeOutcome {
  result: WriteResultDTO;
  requested: number;
  done: number;
  failed: BulkFailureDTO[];
}

const AUDIT_ACTION: Record<ChangeKind, string> = {
  CREATE: 'timetable_entry.created',
  UPDATE: 'timetable_entry.updated',
  MOVE: 'timetable_entry.moved',
  SWAP: 'timetable_entry.swapped',
  DELETE: 'timetable_entry.deleted',
  BULK: 'timetable_entry.bulk_changed',
  UNDO: 'timetable_entry.change_undone',
  SMART_DRAFT: 'timetable_entry.smart_draft_saved',
  PREVIOUS_COPY: 'timetable_entry.previous_copy_saved',
  RUN_ITEM: 'timetable_entry.last_year_item_accepted',
  FIX: 'timetable_entry.fix_applied',
};

const idOf = (op: Op) => (op.type === 'create' ? op.entry.id : op.id);
const touchedIds = (ops: Op[]) => [...new Set(ops.map(idOf))];

/** The lesson as it would be after the step, for options and messages. */
export function proposedOf(snap: Snapshot, op: Op): EntryRec | undefined {
  if (op.type === 'create') return op.entry;
  const current = snap.board.get(op.id);
  if (!current) return undefined;
  return op.type === 'update' ? withContent(current, op.patch, snap.periods) : current;
}

function clashError(snap: Snapshot, items: PlannedItem[], outcome: ReturnType<typeof checkChange>, failed: BulkFailureDTO[], verb: string): AppError {
  const first = outcome.blockers[0]!;
  const total = items.length;
  const ok = total - failed.length;
  const message = total === 1 ? first.message : `${ok} of ${total} can ${verb}. ${failed.length} clash${failed.length === 1 ? 'es' : ''}: ${failed[0]?.message ?? first.message}`;
  const single = total === 1 && items[0]!.ops.length === 1 ? proposedOf(snap, items[0]!.ops[0]!) : undefined;
  return new AppError('TIMETABLE_CLASH', message, {
    blockers: outcome.blockers.map(issueDTO),
    warnings: outcome.warnings.map(issueDTO),
    alternatives: single ? alternativesFor(snap, single, outcome.blockers) : [],
    failed,
    canApply: ok,
  });
}

/** Items that have a clash in one of the lessons they touch, with the first reason. */
function failingItems(items: PlannedItem[], outcome: ReturnType<typeof checkChange>): { item: PlannedItem; failure: BulkFailureDTO }[] {
  const byEntry = new Map<string, Issue>();
  for (const b of outcome.blockers) if (b.entryId && !byEntry.has(b.entryId)) byEntry.set(b.entryId, b);
  const out: { item: PlannedItem; failure: BulkFailureDTO }[] = [];
  for (const item of items) {
    const hit = touchedIds(item.ops).map((id) => byEntry.get(id)).find(Boolean);
    if (hit) out.push({ item, failure: { entryId: item.ref, label: item.label, message: hit.message } });
  }
  return out;
}

async function priorChange(ctx: ServiceContext, versionId: string, requestId: string | undefined, db?: ClientSession): Promise<ChangeSetDoc | null> {
  if (!requestId) return null;
  return ChangeSet.findOne({ tenantId: ctx.tenantId, versionId, requestId }).session(db ?? null).lean<ChangeSetDoc>();
}

/** The first answer again, for a repeated request. */
async function replay(ctx: ServiceContext, plan: TimetablePlanDoc, versionId: string, prior: ChangeSetDoc): Promise<ChangeOutcome> {
  const version = await loadVersion(ctx, versionId);
  const snap = await loadSnapshot(ctx, plan, version);
  const after = prior.after.map((s) => snap.board.get(s.id) ?? fromStored(s, snap.periods, prior.rev));
  const keep = new Set(prior.after.map((s) => s.id));
  return {
    result: { rev: prior.rev, changeSetId: prior._id, label: prior.label, issues: [], entries: after.map((e) => entryDTO(snap, e)), deletedIds: prior.before.filter((s) => !keep.has(s.id)).map((s) => s.id), repeated: true },
    requested: after.length,
    done: after.length,
    failed: [],
  };
}

export async function runChange(ctx: ServiceContext, versionId: string, spec: ChangeSpec): Promise<ChangeOutcome> {
  const first = await loadVersion(ctx, versionId);
  const plan = await writablePlan(ctx, first.planId);
  assertEditable(first);
  const prior = await priorChange(ctx, versionId, spec.requestId);
  if (prior) return replay(ctx, plan, versionId, prior);
  try {
    return await withTransaction((db) => attempt(ctx, plan, versionId, spec, db));
  } catch (err) {
    if (spec.requestId && duplicateKeyFields(err)?.includes('requestId')) {
      const again = await priorChange(ctx, versionId, spec.requestId);
      if (again) return replay(ctx, plan, versionId, again);
    }
    throw err;
  }
}

async function attempt(ctx: ServiceContext, plan: TimetablePlanDoc, versionId: string, spec: ChangeSpec, db: ClientSession): Promise<ChangeOutcome> {
  // 1. Lock the version. A second writer waits here (or retries) and then reads what the first one saved.
  const locked = await TimetableVersion.findOneAndUpdate({ _id: versionId, tenantId: ctx.tenantId, isOpen: true }, { $set: { updatedBy: ctx.userId } }, { returnDocument: 'after', session: db }).lean();
  if (!locked) {
    assertEditable(await loadVersion(ctx, versionId, db));
    throw AppError.notFound('Timetable version not found.');
  }
  const version = locked;
  const prior = await priorChange(ctx, versionId, spec.requestId, db);
  if (prior) return replay(ctx, plan, versionId, prior);

  // 2 and 3. Fresh data, then the steps, checked as a set.
  const snap = await loadSnapshot(ctx, plan, version, db);
  const planned = await spec.build(snap, db);
  let items = planned.items.filter((i) => i.ops.length > 0);
  const requested = items.length;
  const failed: BulkFailureDTO[] = [];
  let outcome = checkChange(snap, items.flatMap((i) => i.ops));
  while (outcome.blockers.length > 0) {
    const bad = failingItems(items, outcome);
    if (spec.mode !== 'APPLY_VALID' || bad.length === 0) throw spec.clashError ? spec.clashError(outcome.blockers) : clashError(snap, items, outcome, bad.map((b) => b.failure), spec.verb ?? 'be saved');
    failed.push(...bad.map((b) => b.failure));
    const dropped = new Set(bad.map((b) => b.item));
    items = items.filter((i) => !dropped.has(i));
    outcome = items.length > 0 ? checkChange(snap, items.flatMap((i) => i.ops)) : { issues: [], blockers: [], warnings: [], info: [], perOp: [] };
  }

  const ops = items.flatMap((i) => i.ops);
  const ids = touchedIds(ops);
  const before = new Map<string, EntryRec | undefined>(ids.map((id) => [id, snap.board.get(id)]));
  snap.board.apply(ops, snap.periods);
  const after = new Map<string, EntryRec | undefined>(ids.map((id) => [id, snap.board.get(id)]));
  const createdIds = ids.filter((id) => !before.get(id) && after.get(id));
  const deletedIds = ids.filter((id) => before.get(id) && !after.get(id));
  const updatedIds = ids.filter((id) => before.get(id) && after.get(id) && !sameContent(before.get(id)!, after.get(id)!));
  const warnings = [...outcome.warnings, ...outcome.info];

  if (createdIds.length + deletedIds.length + updatedIds.length === 0) {
    const same = ids.map((id) => after.get(id)).filter((e): e is EntryRec => Boolean(e));
    return { result: { rev: version.rev, changeSetId: '', label: planned.label, issues: warnings.map(issueDTO), entries: same.map((e) => entryDTO(snap, e, warnings)), deletedIds: [], repeated: false }, requested, done: 0, failed };
  }

  // 5. Write.
  const rev = version.rev + 1;
  const changeSetId = randomUUID();
  for (const id of createdIds) {
    const rec = after.get(id)!;
    rec.version = 1;
    rec.rev = rev;
  }
  for (const id of updatedIds) {
    const rec = after.get(id)!;
    rec.version = before.get(id)!.version + 1;
    rec.rev = rev;
  }
  const writeIds = [...createdIds, ...updatedIds];
  const common = { tenantId: ctx.tenantId, schoolId: plan.schoolId, createdBy: ctx.userId, updatedBy: ctx.userId };
  const existing = [...updatedIds, ...deletedIds];

  if (existing.length > 0) {
    await Promise.all([EntrySection.deleteMany({ tenantId: ctx.tenantId, entryId: { $in: existing } }, { session: db }), EntryFaculty.deleteMany({ tenantId: ctx.tenantId, entryId: { $in: existing } }, { session: db })]);
    // A swap puts two lessons into each other's rooms for a moment; letting go of the rooms first keeps the unique index happy.
    if (updatedIds.length > 1) await TimetableEntry.updateMany({ tenantId: ctx.tenantId, _id: { $in: updatedIds } }, { $set: { physicalSpaceId: null } }, { session: db });
  }
  if (deletedIds.length > 0) {
    await TimetableEntry.deleteMany({ tenantId: ctx.tenantId, _id: { $in: deletedIds } }, { session: db });
    await ConflictOverride.deleteMany({ tenantId: ctx.tenantId, entryId: { $in: deletedIds } }, { session: db });
  }
  const fields = (rec: EntryRec) => ({ weekday: rec.weekday, periodId: rec.periodId, startMin: rec.startMin, endMin: rec.endMin, entryType: rec.entryType, subjectOfferingId: rec.subjectOfferingId, activityName: rec.activityName, teachingGroupId: rec.groupId, physicalSpaceId: rec.spaceId, isFixed: rec.isFixed, source: rec.source, copiedFromEntryId: rec.copiedFromEntryId, notes: rec.notes, version: rec.version, rev: rec.rev });
  for (const id of updatedIds) await TimetableEntry.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { ...fields(after.get(id)!), updatedBy: ctx.userId } }, { session: db });
  if (createdIds.length > 0) await TimetableEntry.create(createdIds.map((id) => ({ _id: id, ...common, versionId, planId: plan._id, ...fields(after.get(id)!) })), { session: db, ordered: true });
  const sectionRows = writeIds.flatMap((id) => after.get(id)!.sectionIds.map((sectionOfferingId) => ({ ...common, entryId: id, versionId, sectionOfferingId, weekday: after.get(id)!.weekday, periodId: after.get(id)!.periodId })));
  const facultyRows = writeIds.flatMap((id) => after.get(id)!.teachers.map((t) => ({ ...common, entryId: id, versionId, employeeId: t.employeeId, role: t.role, weekday: after.get(id)!.weekday, periodId: after.get(id)!.periodId })));
  if (sectionRows.length > 0) await EntrySection.create(sectionRows, { session: db, ordered: true });
  if (facultyRows.length > 0) await EntryFaculty.create(facultyRows, { session: db, ordered: true });

  // Overrides: one that no longer fits the lesson stops counting; a new one is kept only if its clash really showed up.
  if (updatedIds.length > 0) {
    const stale = (await ConflictOverride.find({ tenantId: ctx.tenantId, entryId: { $in: updatedIds } }).session(db).lean()).filter((o) => o.signature !== signatureOf(after.get(o.entryId)!, o.rule));
    if (stale.length > 0) await ConflictOverride.deleteMany({ tenantId: ctx.tenantId, _id: { $in: stale.map((o) => o._id) } }, { session: db });
  }
  for (const o of planned.overrides ?? []) {
    const rec = after.get(o.entryId);
    if (!rec || !outcome.issues.some((i) => i.entryId === o.entryId && i.rule === o.rule && i.overriddenReason)) continue;
    await ConflictOverride.updateOne({ tenantId: ctx.tenantId, versionId, entryId: o.entryId, rule: o.rule }, { $set: { reason: o.reason, byUserId: ctx.userId, at: new Date(), signature: signatureOf(rec, o.rule), schoolId: plan.schoolId, updatedBy: ctx.userId }, $setOnInsert: { createdBy: ctx.userId } }, { upsert: true, session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'conflict_override', entityId: o.entryId, action: 'conflict_override.created', planId: plan._id, locationId: plan.locationId, metadata: { rule: o.rule, reason: o.reason, versionId } });
  }

  await ChangeSet.create([{ _id: changeSetId, ...common, versionId, planId: plan._id, requestId: spec.requestId ?? null, actorId: ctx.userId, kind: spec.kind, label: planned.label, rev, before: ids.map((id) => before.get(id)).filter((e): e is EntryRec => Boolean(e)).map(toStored), after: ids.map((id) => after.get(id)).filter((e): e is EntryRec => Boolean(e)).map(toStored) }], { session: db });
  await TimetableVersion.updateOne({ _id: versionId, tenantId: ctx.tenantId }, { $inc: { rev: 1 }, $set: { status: 'DRAFT' } }, { session: db });

  const single = ids.length === 1 ? ids[0]! : null;
  const moved = single && before.get(single) && after.get(single) && (before.get(single)!.weekday !== after.get(single)!.weekday || before.get(single)!.periodId !== after.get(single)!.periodId);
  const n = namerOf(snap);
  await recordTimetableAudit(ctx, db, {
    entityType: 'timetable_entry',
    entityId: single ?? versionId,
    action: AUDIT_ACTION[spec.kind],
    changes: single && before.get(single) && after.get(single) ? diffFields(before.get(single)!, after.get(single)!, ['weekday', 'periodId', 'subjectOfferingId', 'groupId', 'spaceId', 'isFixed', 'notes'] as const) : [],
    planId: plan._id,
    locationId: plan.locationId,
    metadata: { versionId, rev, changeSetId, created: createdIds.length, updated: updatedIds.length, deleted: deletedIds.length, ...(moved ? { from: n.when(before.get(single!)!.weekday, before.get(single!)!.periodId), to: n.when(after.get(single!)!.weekday, after.get(single!)!.periodId) } : {}) },
  });
  await emitTimetableEvent(db, ctx.tenantId, 'timetable.entry.changed', { versionId, planId: plan._id, rev, changeSetId, entryIds: ids });
  await planned.extra?.(db, { rev, changeSetId, failed });

  const changed = writeIds.map((id) => after.get(id)!);
  return {
    result: { rev, changeSetId, label: planned.label, issues: warnings.map(issueDTO), entries: changed.map((e) => entryDTO(snap, e, warnings)), deletedIds, repeated: false },
    requested,
    done: items.length,
    failed,
  };
}
