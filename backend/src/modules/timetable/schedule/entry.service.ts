import type { AlternativeDTO, BulkData, BulkResultDTO, CheckData, CheckResultDTO, CreateEntryData, DeleteEntryData, MoveEntryData, TimetableEntryDTO, UpdateEntryData, WriteResultDTO } from '@shared';
import { WEEKDAYS } from '@shared';
import { AppError } from '../../../core/errors';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { alternativesFor } from '../engine/alternatives';
import { withContent } from '../engine/board';
import { makeEntry } from '../engine/build';
import { checkChange, issuesFor } from '../engine/check';
import { fromStored } from '../engine/entries';
import { namerOf } from '../engine/messages';
import { loadSnapshot } from '../engine/snapshot';
import type { EntryRec, Issue, Op, Snapshot } from '../engine/types';
import { ChangeSet, TimetableEntry, type ChangeSetDoc } from '../models';
import { copySection } from '../requirement.service';
import { entryDTO, issueDTO } from './mappers';
import { assertShape, assertUnlocked, createFrom, freshEntry, patchFrom, toOps, validateRefs, withOverride } from './ops';
import { proposedOf, runChange, type PlannedItem } from './pipeline';
import { readableVersion } from './version.service';

/** TT-13 to 17, 20, 21 and TT-UX-17 to 19 — adding, changing, moving, swapping, removing and undoing lessons. Every write goes through `runChange`. */

async function versionOfEntry(ctx: ServiceContext, entryId: string): Promise<string> {
  const doc = await TimetableEntry.findOne({ _id: entryId, tenantId: ctx.tenantId }).select('versionId').lean<{ versionId: string }>();
  if (!doc) throw AppError.notFound('Lesson not found.');
  return doc.versionId;
}

const item = (rec: EntryRec, snap: Snapshot, ops: Op[]): PlannedItem => ({ ref: rec.id, label: namerOf(snap).lesson(rec), ops });

export async function createEntry(ctx: ServiceContext, versionId: string, data: CreateEntryData): Promise<WriteResultDTO> {
  const { result } = await runChange(ctx, versionId, {
    kind: 'CREATE',
    requestId: data.requestId,
    build: async (snap) => {
      assertShape(data);
      await validateRefs(ctx, snap, { periodId: data.periodId, sectionIds: data.sectionOfferingIds, teacherIds: data.teacherIds, spaceId: data.physicalSpaceId, groupId: data.teachingGroupId });
      const rec = createFrom(snap, data);
      const overrides = withOverride(ctx, rec, rec, data.override);
      const n = namerOf(snap);
      return { items: [item(rec, snap, [{ type: 'create', entry: rec }])], label: `Added ${n.lesson(rec)} on ${n.when(rec.weekday, rec.periodId)}`, overrides };
    },
  });
  return result;
}

export async function updateEntry(ctx: ServiceContext, entryId: string, data: UpdateEntryData): Promise<WriteResultDTO> {
  const versionId = await versionOfEntry(ctx, entryId);
  const { result } = await runChange(ctx, versionId, {
    kind: 'UPDATE',
    requestId: data.requestId,
    build: async (snap) => {
      const cur = freshEntry(snap, entryId, data.expectedVersion);
      await validateRefs(ctx, snap, { periodId: data.periodId, sectionIds: data.sectionOfferingIds, teacherIds: data.teacherIds, spaceId: data.physicalSpaceId });
      const patch = patchFrom(snap, cur, data);
      assertUnlocked(snap, cur, data.confirmUnlock, patch);
      const next = withContent(cur, patch, snap.periods);
      const overrides = withOverride(ctx, cur, next, data.override);
      const n = namerOf(snap);
      return { items: [item(cur, snap, [{ type: 'update', id: cur.id, patch }])], label: `Changed ${n.lesson(next)} on ${n.when(next.weekday, next.periodId)}`, overrides };
    },
  });
  return result;
}

export async function moveEntry(ctx: ServiceContext, entryId: string, data: MoveEntryData): Promise<WriteResultDTO> {
  const versionId = await versionOfEntry(ctx, entryId);
  const labels = new Map<string, string>();
  const { result } = await runChange(ctx, versionId, {
    kind: data.swapWith ? 'SWAP' : 'MOVE',
    requestId: data.requestId,
    verb: 'move',
    clashError: data.swapWith
      ? (blockers) => new AppError('TIMETABLE_CLASH', `The swap does not work. ${blockers[0] ? `${(blockers[0].entryId && labels.get(blockers[0].entryId)) ?? 'A lesson'}: ${blockers[0].message}` : ''}`.trim(), { blockers: blockers.map((b) => ({ ...issueDTO(b), message: `${(b.entryId && labels.get(b.entryId)) ?? 'A lesson'}: ${b.message}` })), alternatives: [] as AlternativeDTO[], swap: true })
      : undefined,
    build: async (snap) => {
      const a = freshEntry(snap, entryId, data.expectedVersion);
      const n = namerOf(snap);
      if (data.swapWith) {
        const b = snap.board.get(data.swapWith);
        if (!b) throw AppError.notFound('The other lesson was not found.');
        assertUnlocked(snap, a, data.confirmUnlock);
        assertUnlocked(snap, b, data.confirmUnlock);
        labels.set(a.id, n.lesson(a));
        labels.set(b.id, n.lesson(b));
        const ops: Op[] = [{ type: 'update', id: a.id, patch: { weekday: b.weekday, periodId: b.periodId } }, { type: 'update', id: b.id, patch: { weekday: a.weekday, periodId: a.periodId } }];
        return { items: [{ ref: a.id, label: `${n.lesson(a)} and ${n.lesson(b)}`, ops }], label: `Swapped ${n.lesson(a)} and ${n.lesson(b)}` };
      }
      if (!data.weekday || !data.periodId) throw AppError.validation({ periodId: 'Choose where to move it.' });
      await validateRefs(ctx, snap, { periodId: data.periodId });
      assertUnlocked(snap, a, data.confirmUnlock);
      const patch = { weekday: data.weekday, periodId: data.periodId };
      const next = withContent(a, patch, snap.periods);
      const overrides = withOverride(ctx, a, next, data.override);
      return { items: [item(a, snap, [{ type: 'update', id: a.id, patch }])], label: `Moved ${n.lesson(a)} from ${n.when(a.weekday, a.periodId)} to ${n.when(next.weekday, next.periodId)}`, overrides };
    },
  });
  return result;
}

export async function deleteEntry(ctx: ServiceContext, entryId: string, data: DeleteEntryData): Promise<WriteResultDTO> {
  const versionId = await versionOfEntry(ctx, entryId);
  const { result } = await runChange(ctx, versionId, {
    kind: 'DELETE',
    requestId: data.requestId,
    build: (snap) => {
      const cur = freshEntry(snap, entryId, data.expectedVersion);
      assertUnlocked(snap, cur, data.confirmUnlock);
      const n = namerOf(snap);
      return { items: [item(cur, snap, [{ type: 'delete', id: cur.id }])], label: `Removed ${n.lesson(cur)} on ${n.when(cur.weekday, cur.periodId)}` };
    },
  });
  return result;
}

/** One lesson with its own problems, for a screen that refreshes after "Someone just changed this period". */
export async function getEntry(ctx: ServiceContext, entryId: string): Promise<TimetableEntryDTO> {
  const versionId = await versionOfEntry(ctx, entryId);
  const { version, plan } = await readableVersion(ctx, versionId);
  const snap = await loadSnapshot(ctx, plan, version);
  const rec = freshEntry(snap, entryId);
  return entryDTO(snap, rec, issuesFor(snap, rec));
}

// ───────────────────────────────────────────────────────────── Undo

export async function undoChange(ctx: ServiceContext, changeSetId: string, requestId?: string): Promise<WriteResultDTO> {
  const found = await ChangeSet.findOne({ _id: changeSetId, tenantId: ctx.tenantId }).select('versionId').lean<{ versionId: string }>();
  if (!found) throw AppError.notFound('Change not found.');
  const cannot = (message: string, extra?: Record<string, unknown>) => new AppError('UNDO_NOT_POSSIBLE', message, extra);
  const { result } = await runChange(ctx, found.versionId, {
    kind: 'UNDO',
    requestId,
    clashError: (blockers: Issue[]) => cannot(`This cannot be undone: ${blockers[0]?.message ?? 'the slot has been taken.'}`, { blockers: blockers.map(issueDTO) }),
    build: async (snap, db) => {
      const cs = await ChangeSet.findOne({ _id: changeSetId, tenantId: ctx.tenantId }).session(db).lean<ChangeSetDoc>();
      if (!cs) throw AppError.notFound('Change not found.');
      if (cs.undoneAt) throw cannot('This change was already undone.');
      if (cs.kind === 'UNDO') throw cannot('An undo cannot be undone. Make the change again instead.');
      const afterIds = new Set(cs.after.map((s) => s.id));
      const ops: Op[] = [];
      for (const s of cs.after) {
        const cur = snap.board.get(s.id);
        if (!cur || cur.version !== s.version) throw cannot('This lesson was changed again after that. Undo the newer change first.', { entryId: s.id });
        const before = cs.before.find((b) => b.id === s.id);
        if (!before) ops.push({ type: 'delete', id: s.id });
        else ops.push({ type: 'update', id: s.id, patch: { weekday: before.weekday, periodId: before.periodId, entryType: before.entryType, subjectOfferingId: before.subjectOfferingId, activityName: before.activityName, groupId: before.groupId, spaceId: before.spaceId, isFixed: before.isFixed, notes: before.notes, sectionIds: before.sectionIds, teachers: before.teachers } });
      }
      for (const b of cs.before.filter((x) => !afterIds.has(x.id))) {
        if (snap.board.get(b.id)) throw cannot('This lesson is already back.', { entryId: b.id });
        ops.push({ type: 'create', entry: fromStored(b, snap.periods) });
      }
      return {
        items: [{ ref: changeSetId, label: cs.label, ops }],
        label: `Undid: ${cs.label}`,
        extra: async (session) => {
          await ChangeSet.updateOne({ _id: changeSetId, tenantId: ctx.tenantId }, { $set: { undoneAt: new Date(), undoneBy: ctx.userId } }, { session });
        },
      };
    },
  });
  return result;
}

// ───────────────────────────────────────────────────────────── bulk

const PAST: Record<string, string> = { MOVE: 'moved', CLEAR: 'cleared', MARK_FIXED: 'marked fixed', UNLOCK: 'unlocked', SET_ROOM: 'given the room', DUPLICATE_TO: 'copied' };

export async function bulkChange(ctx: ServiceContext, data: BulkData): Promise<BulkResultDTO> {
  if (data.op === 'COPY_REQUIREMENTS') {
    const { plan } = await readableVersion(ctx, data.versionId);
    if (!data.fromSectionId || !data.toSectionIds?.length) throw AppError.validation({ toSectionIds: 'Choose the section to copy from and the sections to copy to.' });
    const copied = await copySection(ctx, { planId: plan._id, fromSectionId: data.fromSectionId, toSectionIds: data.toSectionIds });
    return { op: data.op, mode: data.mode, requested: data.toSectionIds.length, done: copied.copied, failed: [], rev: 0, changeSetId: null, issues: [], entries: [], deletedIds: [], message: copied.message };
  }
  const pre: BulkResultDTO['failed'] = [];
  const { result, requested, done, failed } = await runChange(ctx, data.versionId, {
    kind: 'BULK',
    requestId: data.requestId,
    mode: data.mode,
    verb: data.op === 'MOVE' ? 'move' : data.op === 'DUPLICATE_TO' ? 'be copied' : 'be changed',
    build: async (snap) => {
      const n = namerOf(snap);
      const items: PlannedItem[] = [];
      const skip = (entryId: string | null, label: string, message: string) => pre.push({ entryId, label, message });
      const lessonsOf = (): { rec: EntryRec; weekday?: BulkData['items'][number]['weekday']; periodId?: string }[] =>
        data.items.map((i) => ({ rec: freshEntry(snap, i.entryId), weekday: i.weekday, periodId: i.periodId }));

      if (data.op === 'DUPLICATE_TO') {
        const copies: { rec: EntryRec; label: string }[] = [];
        if (data.fromSectionId && data.toSectionIds?.length) {
          await validateRefs(ctx, snap, { sectionIds: [data.fromSectionId, ...data.toSectionIds] });
          const from = snap.facts.sectionOf.get(data.fromSectionId)!;
          const source = WEEKDAYS.flatMap((d) => snap.board.ofSection(from._id, d)).filter((l) => l.sectionIds.length === 1 && !l.groupId).sort((a, b) => a.id.localeCompare(b.id));
          for (const targetId of new Set(data.toSectionIds)) {
            if (targetId === from._id) continue;
            const target = snap.facts.sectionOf.get(targetId)!;
            for (const l of source) {
              let subjectOfferingId = l.subjectOfferingId;
              if (l.entryType === 'SUBJECT' && l.subjectOfferingId && target.classOfferingId !== from.classOfferingId) {
                const subjectId = snap.facts.offeringOf.get(l.subjectOfferingId)?.subjectId;
                subjectOfferingId = snap.facts.subjectOfferings.find((o) => o.classOfferingId === target.classOfferingId && o.subjectId === subjectId)?._id ?? null;
                if (!subjectOfferingId) {
                  skip(null, `${n.section(targetId)} ${n.lesson(l)}`, `${n.subject(l.subjectOfferingId)} is not offered to ${n.section(targetId)}.`);
                  continue;
                }
              }
              const rec = makeEntry(snap, { weekday: l.weekday, periodId: l.periodId, entryType: l.entryType, subjectOfferingId, activityName: l.activityName, sectionIds: [targetId], teacherIds: l.entryType === 'SUBJECT' ? undefined : l.teachers.map((t) => t.employeeId), spaceId: l.entryType === 'SUBJECT' ? undefined : null, isFixed: l.isFixed, source: 'BULK' });
              copies.push({ rec, label: `${n.lesson(rec)} on ${n.when(rec.weekday, rec.periodId)}` });
            }
          }
        } else if (data.fromWeekday && data.toWeekdays?.length) {
          const source = snap.board.onDay(data.fromWeekday).filter((l) => !data.sectionId || l.sectionIds.includes(data.sectionId)).sort((a, b) => a.id.localeCompare(b.id));
          for (const day of new Set(data.toWeekdays)) {
            if (day === data.fromWeekday) continue;
            for (const l of source) {
              const rec = makeEntry(snap, { weekday: day, periodId: l.periodId, entryType: l.entryType, subjectOfferingId: l.subjectOfferingId, activityName: l.activityName, groupId: l.groupId, sectionIds: l.sectionIds, teacherIds: l.teachers.map((t) => t.employeeId), spaceId: l.spaceId, isFixed: l.isFixed, source: 'BULK' });
              copies.push({ rec, label: `${n.lesson(rec)} on ${n.when(rec.weekday, rec.periodId)}` });
            }
          }
        } else throw AppError.validation({ fromSectionId: 'Choose what to copy and where to copy it.' });
        for (const c of copies) items.push({ ref: c.rec.id, label: c.label, ops: [{ type: 'create', entry: c.rec }] });
        return { items, label: `Copied ${copies.length} lesson${copies.length === 1 ? '' : 's'}` };
      }

      if (data.items.length === 0) throw AppError.validation({ items: 'Choose at least one lesson.' });
      const lessons = lessonsOf();
      if (data.op === 'SET_ROOM') await validateRefs(ctx, snap, { spaceId: data.physicalSpaceId ?? null });
      for (const { rec, weekday, periodId } of lessons) {
        const label = `${n.lesson(rec)} on ${n.when(rec.weekday, rec.periodId)}`;
        const changesLock = data.op === 'UNLOCK';
        if (rec.isFixed && !data.confirmUnlock && !changesLock && data.op !== 'MARK_FIXED') {
          skip(rec.id, label, 'This is a fixed period. Unlock it first.');
          continue;
        }
        if (data.op === 'MOVE') {
          if (!weekday || !periodId) {
            skip(rec.id, label, 'Choose where to move it.');
            continue;
          }
          await validateRefs(ctx, snap, { periodId });
          items.push({ ref: rec.id, label, ops: [{ type: 'update', id: rec.id, patch: { weekday, periodId } }] });
        } else if (data.op === 'CLEAR') items.push({ ref: rec.id, label, ops: [{ type: 'delete', id: rec.id }] });
        else if (data.op === 'MARK_FIXED') items.push({ ref: rec.id, label, ops: [{ type: 'update', id: rec.id, patch: { isFixed: true } }] });
        else if (data.op === 'UNLOCK') items.push({ ref: rec.id, label, ops: [{ type: 'update', id: rec.id, patch: { isFixed: false } }] });
        else if (data.op === 'SET_ROOM') items.push({ ref: rec.id, label, ops: [{ type: 'update', id: rec.id, patch: { spaceId: data.physicalSpaceId ?? null } }] });
      }
      if (pre.length > 0 && data.mode === 'ALL_OR_NOTHING') throw new AppError('ENTRY_FIXED', `${pre.length} of ${lessons.length} lessons cannot be changed: ${pre[0]!.message}`, { failed: pre });
      return { items, label: `${data.op === 'CLEAR' ? 'Cleared' : data.op === 'MOVE' ? 'Moved' : data.op === 'MARK_FIXED' ? 'Fixed' : data.op === 'UNLOCK' ? 'Unlocked' : 'Set the room of'} ${items.length} lesson${items.length === 1 ? '' : 's'}` };
    },
  });
  const all = [...pre, ...failed];
  const total = requested + pre.length;
  return {
    op: data.op,
    mode: data.mode,
    requested: total,
    done,
    failed: all,
    rev: result.rev,
    changeSetId: result.changeSetId || null,
    issues: result.issues,
    entries: result.entries,
    deletedIds: result.deletedIds,
    message: all.length === 0 ? `${done} ${PAST[data.op] ?? 'changed'}.` : `${done} of ${total} ${PAST[data.op] ?? 'changed'}. ${all.length} did not: ${all[0]!.message}`,
  };
}

// ───────────────────────────────────────────────────────────── dry run

export async function checkOps(ctx: ServiceContext, data: CheckData): Promise<CheckResultDTO> {
  const { version, plan } = await readableVersion(ctx, data.versionId);
  const snap = await loadSnapshot(ctx, plan, version);
  for (const op of data.ops) {
    if (op.op === 'create') await validateRefs(ctx, snap, { periodId: op.periodId, sectionIds: op.sectionOfferingIds, teacherIds: op.teacherIds, spaceId: op.physicalSpaceId, groupId: op.teachingGroupId });
    else if (op.op === 'move') await validateRefs(ctx, snap, { periodId: op.periodId });
    else if (op.op === 'update') await validateRefs(ctx, snap, { periodId: op.patch.periodId, sectionIds: op.patch.sectionOfferingIds, teacherIds: op.patch.teacherIds, spaceId: op.patch.physicalSpaceId });
  }
  const ops = toOps(snap, data.ops);
  const outcome = checkChange(snap, ops);
  const single = ops.length === 1 ? proposedOf(snap, ops[0]!) : undefined;
  const okOps = outcome.perOp.filter((p) => p.blockers === 0).length;
  const failedOps = outcome.perOp.length - okOps;
  const summary =
    ops.length === 1
      ? outcome.blockers[0]?.message ?? (outcome.warnings.length > 0 ? `It can be saved with ${outcome.warnings.length} warning${outcome.warnings.length === 1 ? '' : 's'}.` : 'No clashes.')
      : failedOps === 0
        ? `All ${ops.length} can be saved.`
        : `${okOps} of ${ops.length} can be saved. ${failedOps} clash${failedOps === 1 ? 'es' : ''}: ${outcome.blockers[0]!.message}`;
  return {
    ok: outcome.blockers.length === 0,
    blockers: outcome.blockers.map(issueDTO),
    warnings: outcome.warnings.map(issueDTO),
    info: outcome.info.map(issueDTO),
    alternatives: single && outcome.blockers.length > 0 ? alternativesFor(snap, single, outcome.blockers) : [],
    perOp: outcome.perOp,
    summary,
  };
}
