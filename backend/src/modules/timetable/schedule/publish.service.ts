import { randomUUID } from 'node:crypto';
import { RULE_LABELS, WEEKDAYS, type CloneVersionData, type CompareChangeDTO, type CompareDTO, type PublishData, type PublishResultDTO, type RuleCode, type TimetableVersionDTO, type ValidationClashDTO, type ValidationSectionDTO, type ValidationWarningDTO, type ValidationWarningGroupDTO, type VersionValidationDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { emitTimetableEvent, recordTimetableAudit } from '../audit';
import { coverageRows } from '../engine/coverage';
import { issuesFor } from '../engine/check';
import { addDays } from '../engine/effective';
import { loadLite } from '../engine/lite';
import { namerOf, plural } from '../engine/messages';
import { loadSnapshot } from '../engine/snapshot';
import type { EntryRec, Snapshot } from '../engine/types';
import { writablePlan } from '../guards';
import { ConflictOverride, EntryFaculty, EntrySection, Override, OverrideFaculty, TimetableEntry, TimetablePlan, TimetableVersion, type ConflictOverrideDoc, type EntryFacultyDoc, type EntrySectionDoc, type TimetableEntryDoc, type TimetableVersionDoc } from '../models';
import { issueDTO } from './mappers';
import { assertEditable, loadVersion, readableVersion, versionDTOs } from './version.service';

/**
 * TT-34 to 37 — checking a whole version, marking it ready, publishing it (now or on a future date), making a revision, discarding a draft
 * and comparing two versions. A published version never changes. Publishing and revising run in one transaction on the plan's one open
 * version, so two people doing it at once get one success.
 */

const weekOrder = (e: Pick<EntryRec, 'weekday' | 'startMin' | 'id'>) => WEEKDAYS.indexOf(e.weekday) * 100_000 + e.startMin;

/** Every lesson through the one checker, plus how complete each section is. Pure on the snapshot. */
export function validateSnapshot(snap: Snapshot, rev: number): VersionValidationDTO {
  const n = namerOf(snap);
  const lessons = snap.board.all().sort((a, b) => weekOrder(a) - weekOrder(b) || a.id.localeCompare(b.id));
  const clashes: ValidationClashDTO[] = [];
  const groups = new Map<RuleCode, Map<string, ValidationWarningDTO>>();
  let clashCount = 0;
  for (const e of lessons) {
    const issues = issuesFor(snap, e);
    const blockers = issues.filter((i) => i.severity === 'CLASH');
    if (blockers.length > 0) {
      clashCount += blockers.length;
      clashes.push({ entryId: e.id, label: `${n.lesson(e)} on ${n.when(e.weekday, e.periodId)}`, issues: blockers.map(issueDTO), sectionOfferingId: e.sectionIds[0] ?? null, teachingGroupId: e.groupId });
    }
    for (const w of issues.filter((i) => i.severity === 'WARNING')) {
      const byKey = groups.get(w.rule) ?? new Map();
      const key = `${w.rule}|${w.message}`;
      if (!byKey.has(key)) byKey.set(key, { entryId: e.id, label: `${n.lesson(e)} on ${n.when(e.weekday, e.periodId)}`, message: w.message, when: w.when, rule: w.rule, sectionOfferingId: e.sectionIds[0] ?? null, teachingGroupId: e.groupId });
      groups.set(w.rule, byKey);
    }
  }
  const warnings: ValidationWarningGroupDTO[] = [...groups.entries()]
    .map(([rule, items]) => ({ rule, label: RULE_LABELS[rule], count: items.size, items: [...items.values()].slice(0, 25) }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
  const warningCount = warnings.reduce((c, g) => c + g.count, 0);

  const rows = coverageRows(snap);
  const sections: ValidationSectionDTO[] = snap.facts.sections.map((section) => {
    const mine = rows.filter((r) => r.sectionOfferingId === section._id);
    const placedLessons = WEEKDAYS.reduce((c, d) => c + snap.board.ofSection(section._id, d).length, 0);
    return {
      sectionOfferingId: section._id,
      label: n.section(section._id),
      needed: mine.reduce((c, r) => c + r.needed, 0),
      placed: mine.reduce((c, r) => c + Math.min(r.placed, r.needed), 0),
      left: mine.reduce((c, r) => c + r.left, 0),
      over: mine.reduce((c, r) => c + r.over, 0),
      empty: placedLessons === 0,
    };
  });
  // Incomplete sections first, the emptiest at the top.
  sections.sort((a, b) => Number(b.empty) - Number(a.empty) || b.left - a.left || a.label.localeCompare(b.label, 'en', { numeric: true }));
  const complete = sections.filter((s) => s.left === 0 && !s.empty).length;
  const unplacedCount = rows.reduce((c, r) => c + r.left, 0);
  const entryCount = lessons.length;
  const summary = `${complete === sections.length ? `All ${sections.length} sections complete.` : `${complete} of ${sections.length} sections complete.`} ${plural(clashCount, 'clash', 'clashes')}. ${plural(warningCount, 'warning')}.`;
  return {
    versionId: snap.versionId,
    rev,
    entryCount,
    clashCount,
    clashes: clashes.slice(0, 50),
    warningCount,
    warnings,
    sections,
    sectionsTotal: sections.length,
    sectionsComplete: complete,
    emptySections: sections.filter((s) => s.empty).map((s) => s.label),
    unplacedCount,
    canPublish: clashCount === 0 && entryCount > 0,
    needsAcknowledge: unplacedCount > 0 || warningCount > 0,
    summary,
  };
}

export async function validateVersion(ctx: ServiceContext, versionId: string): Promise<VersionValidationDTO> {
  const { version, plan } = await readableVersion(ctx, versionId);
  return validateSnapshot(await loadSnapshot(ctx, plan, version), version.rev);
}

const blocked = (v: VersionValidationDTO, doing: string) => {
  const first = v.clashes[0];
  return new AppError('PUBLISH_BLOCKED', v.entryCount === 0 ? `Nothing is placed yet, so there is nothing to ${doing}.` : `${plural(v.clashCount, 'clash', 'clashes')} must be fixed before you ${doing}.${first ? ` First: ${first.issues[0]?.message ?? first.label}` : ''}`, {
    clashCount: v.clashCount,
    clashes: v.clashes.slice(0, 20),
    entryCount: v.entryCount,
  });
};

// ───────────────────────────────────────────────────────────── ready, discard

/** Marks a draft ready for review. The whole version is checked first. Any later edit sends it back to Draft. */
export async function markReady(ctx: ServiceContext, versionId: string): Promise<TimetableVersionDTO> {
  const version = await loadVersion(ctx, versionId);
  const plan = await writablePlan(ctx, version.planId);
  assertEditable(version);
  const check = validateSnapshot(await loadSnapshot(ctx, plan, version), version.rev);
  if (!check.canPublish) throw blocked(check, 'mark it ready');
  await withTransaction(async (db) => {
    const done = await TimetableVersion.findOneAndUpdate({ _id: versionId, tenantId: ctx.tenantId, isOpen: true, rev: version.rev }, { $set: { status: 'READY', updatedBy: ctx.userId } }, { session: db });
    if (!done) throw new AppError('VERSION_CONFLICT', 'Someone changed this timetable while it was being checked. Check it again.');
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_version', entityId: versionId, action: 'timetable_version.marked_ready', planId: plan._id, locationId: plan.locationId, changes: [{ field: 'status', from: version.status, to: 'READY' }], metadata: { warnings: check.warningCount, unplaced: check.unplacedCount } });
  });
  return (await versionDTOs(ctx, [await loadVersion(ctx, versionId)]))[0]!;
}

/** Throws a draft away. It stays in the list as history. Published versions cannot be discarded. */
export async function discardVersion(ctx: ServiceContext, versionId: string): Promise<TimetableVersionDTO> {
  const version = await loadVersion(ctx, versionId);
  const plan = await writablePlan(ctx, version.planId);
  if (version.status === 'DISCARDED') return (await versionDTOs(ctx, [version]))[0]!;
  assertEditable(version);
  await withTransaction(async (db) => {
    const done = await TimetableVersion.findOneAndUpdate({ _id: versionId, tenantId: ctx.tenantId, isOpen: true }, { $set: { status: 'DISCARDED', isOpen: false, updatedBy: ctx.userId }, $inc: { rev: 1 } }, { session: db });
    if (!done) throw new AppError('VERSION_PUBLISHED', 'This timetable was just published, so it cannot be discarded.', { versionId });
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_version', entityId: versionId, action: 'timetable_version.discarded', planId: plan._id, locationId: plan.locationId, changes: [{ field: 'status', from: version.status, to: 'DISCARDED' }] });
    await emitTimetableEvent(db, ctx.tenantId, 'timetable.version.discarded', { versionId, planId: plan._id });
  });
  return (await versionDTOs(ctx, [await loadVersion(ctx, versionId)]))[0]!;
}

// ───────────────────────────────────────────────────────────── publish

/**
 * One-day changes on the timetable that is being replaced, from the new start date on, move to the same lesson of the new version when
 * that lesson is unchanged (same day, period and sections). If the lesson changed, the one-day change is cancelled, because it was made for
 * a lesson that no longer exists in that form. Returns how many moved and how many were cancelled.
 */
async function carryOverrides(ctx: ServiceContext, db: import('mongoose').ClientSession, oldVersionId: string, newVersionId: string, from: string): Promise<{ moved: number; cancelled: number }> {
  const open = await Override.find({ tenantId: ctx.tenantId, versionId: oldVersionId, status: 'ACTIVE', date: { $gte: from } }).session(db).lean();
  if (open.length === 0) return { moved: 0, cancelled: 0 };
  const lineage = await TimetableEntry.find({ tenantId: ctx.tenantId, versionId: newVersionId, copiedFromEntryId: { $in: open.flatMap((o) => [o.entryId, ...(typeof o.payload.otherEntryId === 'string' ? [o.payload.otherEntryId] : []), ...(typeof o.payload.withEntryId === 'string' ? [o.payload.withEntryId] : [])]) } }).session(db).lean<TimetableEntryDoc[]>();
  const oldIds = [...new Set(lineage.map((e) => e.copiedFromEntryId!))];
  const oldDocs = await TimetableEntry.find({ tenantId: ctx.tenantId, _id: { $in: oldIds } }).session(db).lean<TimetableEntryDoc[]>();
  const sections = await EntrySection.find({ tenantId: ctx.tenantId, entryId: { $in: [...lineage.map((e) => e._id), ...oldIds] } }).session(db).lean<EntrySectionDoc[]>();
  const secKey = (id: string) => sections.filter((s) => s.entryId === id).map((s) => s.sectionOfferingId).sort().join(',');
  const newOf = new Map<string, TimetableEntryDoc>();
  for (const e of lineage) {
    const old = oldDocs.find((o) => o._id === e.copiedFromEntryId);
    if (old && old.weekday === e.weekday && old.periodId === e.periodId && secKey(old._id) === secKey(e._id)) newOf.set(old._id, e);
  }
  let moved = 0;
  let cancelled = 0;
  for (const o of open) {
    const target = newOf.get(o.entryId);
    const payload: Record<string, unknown> = { ...o.payload };
    let ok = Boolean(target);
    for (const key of ['otherEntryId', 'withEntryId'] as const) {
      if (typeof payload[key] === 'string') {
        const mapped = newOf.get(payload[key] as string);
        if (mapped) payload[key] = mapped._id;
        else ok = false;
      }
    }
    if (ok && target) {
      await Override.updateOne({ _id: o._id, tenantId: ctx.tenantId }, { $set: { versionId: newVersionId, entryId: target._id, payload, updatedBy: ctx.userId } }, { session: db });
      moved += 1;
    } else {
      await Override.updateOne({ _id: o._id, tenantId: ctx.tenantId }, { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: ctx.userId, reason: `${o.reason ?? 'One-day change'} (cancelled: the lesson changed in the new timetable)`, updatedBy: ctx.userId } }, { session: db });
      await OverrideFaculty.updateMany({ tenantId: ctx.tenantId, overrideId: o._id }, { $set: { status: 'CANCELLED' } }, { session: db });
      cancelled += 1;
    }
  }
  return { moved, cancelled };
}

export async function publishVersion(ctx: ServiceContext, versionId: string, data: PublishData): Promise<PublishResultDTO> {
  const first = await loadVersion(ctx, versionId);
  const plan = await writablePlan(ctx, first.planId);
  if (first.status === 'PUBLISHED') throw new AppError('VERSION_PUBLISHED', 'This timetable is already published.', { versionId });
  assertEditable(first);
  const today = await todayFor(ctx);
  const earliest = today > plan.effectiveFrom ? today : plan.effectiveFrom;
  const from = data.effectiveFrom ?? earliest;
  if (from < earliest) throw new AppError('EFFECTIVE_DATE_INVALID', today > plan.effectiveFrom ? 'A timetable cannot start on a day that has passed. Choose today or a later day.' : `The timetable cannot start before the plan does (${plan.effectiveFrom}).`, { earliest });
  if (from > plan.effectiveTo) throw new AppError('EFFECTIVE_DATE_INVALID', `The timetable cannot start after the plan ends (${plan.effectiveTo}).`, { latest: plan.effectiveTo });

  const out = await withTransaction(async (db) => {
    // Lock the plan's one open version. A second publisher waits here, then finds it already published.
    const locked = await TimetableVersion.findOneAndUpdate({ _id: versionId, tenantId: ctx.tenantId, isOpen: true }, { $set: { updatedBy: ctx.userId } }, { returnDocument: 'after', session: db }).lean<TimetableVersionDoc>();
    if (!locked) {
      const now = await loadVersion(ctx, versionId, db);
      throw new AppError('VERSION_PUBLISHED', now.status === 'PUBLISHED' ? 'Someone just published this timetable.' : undefined, { versionId, status: now.status });
    }
    const snap = await loadSnapshot(ctx, plan, locked, db);
    const check = validateSnapshot(snap, locked.rev);
    if (!check.canPublish) throw blocked(check, 'publish');
    if (check.needsAcknowledge && !data.acknowledgeWarnings) {
      const what = [check.unplacedCount > 0 && `${plural(check.unplacedCount, 'period')} still not placed`, check.warningCount > 0 && plural(check.warningCount, 'warning')].filter(Boolean).join(' and ');
      throw new AppError('ACKNOWLEDGE_REQUIRED', `${what}. Tick the box to publish anyway.`, { unplacedCount: check.unplacedCount, warningCount: check.warningCount });
    }

    // The timetable now running (the latest published) stops the day before the new one starts.
    const tail = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId: plan._id, status: 'PUBLISHED' }).sort({ effectiveFrom: -1, versionNumber: -1 }).session(db).lean<TimetableVersionDoc>();
    if (tail?.effectiveFrom && from < tail.effectiveFrom) throw new AppError('EFFECTIVE_DATE_INVALID', `The timetable that is published now starts on ${tail.effectiveFrom}. The new one cannot start before that day.`, { earliest: tail.effectiveFrom });
    const before = addDays(from, -1);
    let carried = { moved: 0, cancelled: 0 };
    if (tail) {
      await TimetableVersion.updateOne({ _id: tail._id, tenantId: ctx.tenantId }, { $set: { effectiveTo: before, updatedBy: ctx.userId }, $inc: { rev: 1 } }, { session: db });
      carried = await carryOverrides(ctx, db, tail._id, versionId, from);
    }

    await TimetableVersion.updateOne(
      { _id: versionId, tenantId: ctx.tenantId },
      { $set: { status: 'PUBLISHED', isOpen: false, ...(/^Draft \d+$/.test(locked.versionName) ? { versionName: `Version ${locked.versionNumber}` } : {}), effectiveFrom: from, effectiveTo: plan.effectiveTo, publishedAt: new Date(), publishedBy: ctx.userId, publishedWarningCount: check.warningCount, publishedUnplacedCount: check.unplacedCount, updatedBy: ctx.userId }, $inc: { rev: 1 } },
      { session: db },
    );
    if (plan.status === 'DRAFT') await TimetablePlan.updateOne({ _id: plan._id, tenantId: ctx.tenantId }, { $set: { status: 'ACTIVE', updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });

    const meta = { planId: plan._id, locationId: plan.locationId };
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_version', entityId: versionId, action: 'timetable_version.published', ...meta, changes: [{ field: 'status', from: locked.status, to: 'PUBLISHED' }], metadata: { effectiveFrom: from, effectiveTo: plan.effectiveTo, warnings: check.warningCount, unplaced: check.unplacedCount, lessons: check.entryCount, supersedes: tail?._id ?? null } });
    await emitTimetableEvent(db, ctx.tenantId, 'timetable.published', { versionId, planId: plan._id, effectiveFrom: from });
    if (tail) {
      await recordTimetableAudit(ctx, db, { entityType: 'timetable_version', entityId: tail._id, action: 'timetable_version.superseded', ...meta, changes: [{ field: 'effectiveTo', from: tail.effectiveTo, to: before }], metadata: { by: versionId } });
      await emitTimetableEvent(db, ctx.tenantId, 'timetable.version.superseded', { versionId: tail._id, planId: plan._id, by: versionId, effectiveTo: before });
    }
    return { check, tail, before, carried };
  });

  const version = (await versionDTOs(ctx, [await loadVersion(ctx, versionId)]))[0]!;
  const startsLater = from > today;
  return {
    version,
    warningCount: out.check.warningCount,
    unplacedCount: out.check.unplacedCount,
    supersededVersionId: out.tail?._id ?? null,
    previousRunsUntil: out.tail ? out.before : null,
    movedOverrides: out.carried.moved,
    cancelledOverrides: out.carried.cancelled,
    message: startsLater ? `Published. It starts on ${from}.${out.tail ? ` The current timetable runs until ${out.before}.` : ''}` : 'Published. It is the timetable in use from today.',
  };
}

// ───────────────────────────────────────────────────────────── revision

/** Copies a published version into a new Draft with new lesson ids. Refused while the plan has a draft. */
export async function cloneVersion(ctx: ServiceContext, versionId: string, data: CloneVersionData): Promise<TimetableVersionDTO> {
  const source = await loadVersion(ctx, versionId);
  const plan = await writablePlan(ctx, source.planId);
  if (source.status !== 'PUBLISHED') throw new AppError('VALIDATION_FAILED', 'Only a published timetable can be revised. Open the draft instead.', { fields: { versionId: 'Choose a published timetable.' } });
  const open = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId: plan._id, isOpen: true }).select('_id').lean<{ _id: string }>();
  if (open) throw new AppError('DRAFT_EXISTS', undefined, { versionId: open._id });

  const id = await withTransaction(async (db) => {
    const again = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId: plan._id, isOpen: true }).select('_id').session(db).lean<{ _id: string }>();
    if (again) throw new AppError('DRAFT_EXISTS', undefined, { versionId: again._id });
    const last = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId: plan._id }).sort({ versionNumber: -1 }).select('versionNumber').session(db).lean<{ versionNumber: number }>();
    const number = (last?.versionNumber ?? 0) + 1;
    const common = { tenantId: ctx.tenantId, schoolId: plan.schoolId, createdBy: ctx.userId, updatedBy: ctx.userId };
    const [created] = await TimetableVersion.create([{ ...common, planId: plan._id, versionNumber: number, versionName: data.versionName ?? `Revision of ${source.versionName}`, sourceVersionId: source._id, status: 'DRAFT', isOpen: true, rev: 0 }], { session: db });
    const newId = created!._id;

    const [entries, sections, faculty, overrides] = await Promise.all([
      TimetableEntry.find({ tenantId: ctx.tenantId, versionId: source._id }).session(db).lean<TimetableEntryDoc[]>(),
      EntrySection.find({ tenantId: ctx.tenantId, versionId: source._id }).session(db).lean<EntrySectionDoc[]>(),
      EntryFaculty.find({ tenantId: ctx.tenantId, versionId: source._id }).session(db).lean<EntryFacultyDoc[]>(),
      ConflictOverride.find({ tenantId: ctx.tenantId, versionId: source._id }).session(db).lean<ConflictOverrideDoc[]>(),
    ]);
    const idMap = new Map(entries.map((e) => [e._id, randomUUID()]));
    if (entries.length > 0) {
      await TimetableEntry.create(
        entries.map((e) => ({ _id: idMap.get(e._id)!, ...common, versionId: newId, planId: plan._id, weekday: e.weekday, periodId: e.periodId, startMin: e.startMin, endMin: e.endMin, entryType: e.entryType, subjectOfferingId: e.subjectOfferingId, activityName: e.activityName, teachingGroupId: e.teachingGroupId, physicalSpaceId: e.physicalSpaceId, isFixed: e.isFixed, source: e.source, copiedFromEntryId: e._id, notes: e.notes, version: 1, rev: 0 })),
        { session: db, ordered: true },
      );
      if (sections.length > 0) await EntrySection.create(sections.map((s) => ({ ...common, entryId: idMap.get(s.entryId)!, versionId: newId, sectionOfferingId: s.sectionOfferingId, weekday: s.weekday, periodId: s.periodId })), { session: db, ordered: true });
      if (faculty.length > 0) await EntryFaculty.create(faculty.map((f) => ({ ...common, entryId: idMap.get(f.entryId)!, versionId: newId, employeeId: f.employeeId, role: f.role, weekday: f.weekday, periodId: f.periodId })), { session: db, ordered: true });
      if (overrides.length > 0) await ConflictOverride.create(overrides.map((o) => ({ ...common, entryId: idMap.get(o.entryId)!, versionId: newId, rule: o.rule, reason: o.reason, byUserId: o.byUserId, at: o.at, signature: o.signature })), { session: db, ordered: true });
    }
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_version', entityId: newId, action: 'timetable_version.revision_created', planId: plan._id, locationId: plan.locationId, metadata: { sourceVersionId: source._id, versionNumber: number, lessons: entries.length } });
    await emitTimetableEvent(db, ctx.tenantId, 'timetable.version.created', { versionId: newId, planId: plan._id, sourceVersionId: source._id });
    return newId;
  });
  return (await versionDTOs(ctx, [await loadVersion(ctx, id)]))[0]!;
}

// ───────────────────────────────────────────────────────────── compare

const lessonKey = (e: EntryRec) => `${e.groupId ?? [...e.sectionIds].sort().join(',')}|${e.entryType === 'SUBJECT' ? (e.subjectOfferingId ?? '') : (e.activityName ?? e.entryType)}`;
const slotKey = (e: EntryRec) => `${lessonKey(e)}|${e.weekday}|${e.periodId}`;

/** What changed going from `to` (the earlier version) to this one. Lessons are matched by where they were copied from, then by place, then by what they are. */
export async function compareVersions(ctx: ServiceContext, versionId: string, toVersionId?: string): Promise<CompareDTO> {
  const { version, plan } = await readableVersion(ctx, versionId);
  const baseId = toVersionId ?? version.sourceVersionId;
  const base = baseId ? await readableVersion(ctx, baseId) : null;
  if (base && base.plan._id !== plan._id) throw AppError.notFound('Timetable version not found.');
  const book = await loadLite(ctx, plan, [versionId, ...(baseId ? [baseId] : [])]);
  await book.addTeachers([...book.recs.values()].flatMap((list) => list.flatMap((e) => e.teachers.map((t) => t.employeeId))));
  const n = namerOf(book);
  const now = book.recs.get(versionId) ?? [];
  const was = baseId ? (book.recs.get(baseId) ?? []) : [];

  const pairs: { a: EntryRec; b: EntryRec }[] = [];
  const freeA = new Map(was.map((e) => [e.id, e]));
  const freeB = new Map(now.map((e) => [e.id, e]));
  const pair = (a: EntryRec, b: EntryRec) => {
    pairs.push({ a, b });
    freeA.delete(a.id);
    freeB.delete(b.id);
  };
  for (const b of now) {
    const a = b.copiedFromEntryId ? freeA.get(b.copiedFromEntryId) : undefined;
    if (a) pair(a, b);
  }
  const bySlot = new Map<string, EntryRec[]>();
  for (const a of freeA.values()) bySlot.set(slotKey(a), [...(bySlot.get(slotKey(a)) ?? []), a]);
  for (const b of [...freeB.values()]) {
    const a = bySlot.get(slotKey(b))?.shift();
    if (a) pair(a, b);
  }
  const byLesson = new Map<string, EntryRec[]>();
  for (const a of freeA.values()) byLesson.set(lessonKey(a), [...(byLesson.get(lessonKey(a)) ?? []), a]);
  for (const b of [...freeB.values()]) {
    const a = byLesson.get(lessonKey(b))?.shift();
    if (a) pair(a, b);
  }

  const changes: CompareChangeDTO[] = [];
  let moved = 0;
  let changed = 0;
  let unchanged = 0;
  const place = (e: EntryRec) => n.when(e.weekday, e.periodId);
  const people = (e: EntryRec) => e.teachers.map((t) => n.teacher(t.employeeId)).join(', ') || 'no teacher';
  for (const { a, b } of pairs.sort((x, y) => weekOrder(x.b) - weekOrder(y.b))) {
    const label = n.lesson(b);
    if (a.weekday !== b.weekday || a.periodId !== b.periodId) {
      moved += 1;
      changes.push({ kind: 'MOVED', label, was: place(a), now: place(b), entryId: b.id });
    } else if (people(a) !== people(b) || (a.spaceId ?? '') !== (b.spaceId ?? '')) {
      changed += 1;
      const parts: string[] = [];
      if (people(a) !== people(b)) parts.push(`teacher ${people(a)} → ${people(b)}`);
      if ((a.spaceId ?? '') !== (b.spaceId ?? '')) parts.push(`room ${n.room(a.spaceId)} → ${n.room(b.spaceId)}`);
      changes.push({ kind: 'CHANGED', label, was: place(a), now: `${place(b)}: ${parts.join(', ')}`, entryId: b.id });
    } else unchanged += 1;
  }
  for (const b of [...freeB.values()].sort((x, y) => weekOrder(x) - weekOrder(y))) changes.push({ kind: 'ADDED', label: n.lesson(b), was: null, now: place(b), entryId: b.id });
  for (const a of [...freeA.values()].sort((x, y) => weekOrder(x) - weekOrder(y))) changes.push({ kind: 'REMOVED', label: n.lesson(a), was: place(a), now: null, entryId: null });
  const added = freeB.size;
  const removed = freeA.size;
  const parts = [added && `${added} added`, removed && `${removed} removed`, moved && `${moved} moved`, changed && `${changed} changed`].filter(Boolean);
  const names = await TimetableVersion.find({ tenantId: ctx.tenantId, _id: { $in: baseId ? [baseId] : [] } }).select('versionName').lean<{ _id: string; versionName: string }[]>();
  return {
    versionId,
    versionName: version.versionName,
    toVersionId: baseId ?? null,
    toVersionName: names[0]?.versionName ?? null,
    added,
    removed,
    moved,
    changed,
    unchanged,
    changes,
    summary: parts.length > 0 ? `${parts.join(', ')}. ${plural(unchanged, 'lesson')} stay${unchanged === 1 ? 's' : ''} the same.` : baseId ? 'Nothing changed.' : `${plural(now.length, 'lesson')}, all new.`,
  };
}
