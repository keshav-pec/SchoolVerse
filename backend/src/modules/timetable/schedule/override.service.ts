import { randomUUID } from 'node:crypto';
import { minutesToClock, OVERRIDE_TYPE_LABELS, WEEKDAY_LABELS, type ApplyRoomChangesData, type BulkSubstitutionsData, type CancelLessonsData, type CreateOverrideData, type ListOverridesQuery, type OverrideBulkResultDTO, type OverrideDTO, type OverrideFailureDTO, type OverrideResultDTO, type UpdateOverrideData } from '@shared';
import type { ClientSession } from 'mongoose';
import { AppError } from '../../../core/errors';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { User } from '../../../platform/users/user.model';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { emitTimetableEvent, recordTimetableAudit } from '../audit';
import { namerOf, plural } from '../engine/messages';
import { weekdayOf } from '../engine/effective';
import { loadLite } from '../engine/lite';
import { readablePlan, writablePlan } from '../guards';
import { Override, OverrideFaculty, TimetableEntry, TimetablePlan, TimetableVersion, type OverrideDoc, type OverrideFacultyDoc, type TimetablePlanDoc, type TimetableVersionDoc } from '../models';
import { afterStep, applyToDay, checkDay, loadDay, OVERRIDE_EVENT, propose, type DayState, type OverrideSpec, type Proposal } from './day';
import { issueDTO } from './mappers';
import { withOverride, validateRefs } from './ops';
import { rankRooms, rankSubstitutes, coversThisMonth, roomAlternatives, teacherAlternatives } from './pick';

/**
 * TT-38 to 42 — one-day changes. Each is a row with a date that points at a lesson of a published version. It never edits the weekly
 * lesson, and cancelling it brings the lesson back. Every change is judged by the one clash checker on the real date, in one
 * transaction that first locks the plan, so two people taking one teacher or one room get one success and one refusal.
 */

const REPLACEABLE = new Set(['SUBSTITUTE_FACULTY', 'ROOM_CHANGE', 'SUBJECT_CHANGE', 'SPECIAL_ACTIVITY']);

// ───────────────────────────────────────────────────────────── dates and versions

/** One-day changes are for today or later, on a school day, inside the plan's dates. */
export async function assertChangeDate(ctx: ServiceContext, plan: TimetablePlanDoc, date: string) {
  const today = await todayFor(ctx);
  if (date < today) throw new AppError('OVERRIDE_INVALID', 'That day has passed. One-day changes can be made for today or a later day.', { date });
  if (date < plan.effectiveFrom || date > plan.effectiveTo) throw new AppError('OVERRIDE_INVALID', `${date} is outside the plan (${plan.effectiveFrom} to ${plan.effectiveTo}).`, { date });
  if (!plan.operatingDays.includes(weekdayOf(date))) throw new AppError('OVERRIDE_INVALID', `${WEEKDAY_LABELS[weekdayOf(date)]} is not a school day in this plan.`, { date });
}

/** The published version running on a date. */
export async function runningVersion(ctx: ServiceContext, planId: string, date: string, db?: ClientSession): Promise<TimetableVersionDoc> {
  const version = await TimetableVersion.findOne({ tenantId: ctx.tenantId, planId, status: 'PUBLISHED', effectiveFrom: { $lte: date }, effectiveTo: { $gte: date } }).session(db ?? null).lean<TimetableVersionDoc>();
  if (!version) throw new AppError('NO_PUBLISHED_TIMETABLE', `There is no published timetable on ${date}. Publish one first.`, { date });
  return version;
}

/** Serialises everyone who changes one day of this plan. */
const lockPlan = (ctx: ServiceContext, planId: string, db: ClientSession) => TimetablePlan.updateOne({ _id: planId, tenantId: ctx.tenantId }, { $set: { updatedBy: ctx.userId } }, { session: db });

// ───────────────────────────────────────────────────────────── writing

interface WriteOptions {
  reason: string | null;
  override?: { rule: import('@shared').RuleCode; reason: string };
  requestId?: string | null;
  batchId?: string | null;
}

/** Everything one accepted change writes. Returns the row. */
async function save(ctx: ServiceContext, db: ClientSession, day: DayState, proposal: Proposal, check: ReturnType<typeof checkDay>, opts: WriteOptions, existing?: OverrideDoc): Promise<OverrideDoc> {
  const { plan, version, date } = day;
  const common = { tenantId: ctx.tenantId, schoolId: plan.schoolId, createdBy: ctx.userId, updatedBy: ctx.userId };
  const acknowledged = check.accepted.map((a) => ({ ...a, by: ctx.userId }));
  const type = proposal.spec.type;
  let doc: OverrideDoc;
  if (existing) {
    await Override.updateOne({ _id: existing._id, tenantId: ctx.tenantId }, { $set: { payload: proposal.payload, reason: opts.reason, acknowledged, updatedBy: ctx.userId } }, { session: db });
    await OverrideFaculty.deleteMany({ tenantId: ctx.tenantId, overrideId: existing._id }, { session: db });
    doc = { ...existing, payload: proposal.payload, reason: opts.reason, acknowledged };
  } else {
    const [created] = await Override.create([{ _id: randomUUID(), ...common, planId: plan._id, versionId: version._id, entryId: proposal.entryId, date, weekday: day.weekday, type, payload: proposal.payload, reason: opts.reason, status: 'ACTIVE', acknowledged, batchId: opts.batchId ?? null, requestId: opts.requestId ?? null }], { session: db });
    doc = created!.toObject() as OverrideDoc;
  }
  if (proposal.faculty.length > 0) await OverrideFaculty.create(proposal.faculty.map((f) => ({ ...common, overrideId: doc._id, planId: plan._id, date, employeeId: f.employeeId, role: f.role, status: 'ACTIVE' })), { session: db, ordered: true });
  const meta = { planId: plan._id, locationId: plan.locationId };
  await recordTimetableAudit(ctx, db, { entityType: 'timetable_override', entityId: doc._id, action: existing ? 'timetable_override.updated' : 'timetable_override.created', ...meta, metadata: { type, date, entryId: proposal.entryId, versionId: version._id, reason: opts.reason, ...(acknowledged.length > 0 ? { acknowledged } : {}), ...(proposal.faculty.length > 0 ? { faculty: proposal.faculty } : {}) } });
  for (const a of acknowledged) await recordTimetableAudit(ctx, db, { entityType: 'conflict_override', entityId: proposal.entryId, action: 'conflict_override.created', ...meta, metadata: { rule: a.rule, reason: a.reason, date, overrideId: doc._id } });
  await emitTimetableEvent(db, ctx.tenantId, OVERRIDE_EVENT[type], { overrideId: doc._id, planId: plan._id, versionId: version._id, entryId: proposal.entryId, date, type, ...(proposal.faculty.length > 0 ? { employeeIds: proposal.faculty.map((f) => f.employeeId) } : {}) });
  return doc;
}

/** The refusal for a clash: the reasons and a few better options, in the same shape as the weekly editor. */
function clash(day: DayState, spec: OverrideSpec, check: ReturnType<typeof checkDay>, covers: Map<string, number>, rec: import('../engine/types').EntryRec | undefined): AppError {
  const alternatives = !rec ? [] : spec.type === 'SUBSTITUTE_FACULTY' ? teacherAlternatives(rankSubstitutes(day, rec, covers, { exclude: [spec.substituteEmployeeId] })) : spec.type === 'ROOM_CHANGE' ? roomAlternatives(rankRooms(day, rec, { exclude: spec.physicalSpaceId ? [spec.physicalSpaceId] : [] })) : [];
  return new AppError('TIMETABLE_CLASH', check.blockers[0]!.message, { blockers: check.blockers.map(issueDTO), warnings: check.warnings.map(issueDTO), alternatives, failed: [], canApply: 0 });
}

function specFromCreate(data: CreateOverrideData): OverrideSpec {
  switch (data.type) {
    case 'SUBSTITUTE_FACULTY':
      return { type: data.type, entryId: data.entryId, substituteEmployeeId: data.substituteEmployeeId, originalEmployeeId: data.originalEmployeeId };
    case 'ROOM_CHANGE':
      return { type: data.type, entryId: data.entryId, physicalSpaceId: data.physicalSpaceId };
    case 'CLASS_CANCELLED':
      return { type: data.type, entryId: data.entryId };
    case 'PERIOD_SWAP':
      return { type: data.type, entryId: data.entryId, otherEntryId: data.otherEntryId };
    case 'SUBJECT_CHANGE':
      return { type: data.type, entryId: data.entryId, subjectOfferingId: data.subjectOfferingId, substituteEmployeeId: data.substituteEmployeeId };
    case 'SPECIAL_ACTIVITY':
      return { type: data.type, entryId: data.entryId, activityName: data.activityName };
    case 'COMBINED_CLASS':
      return { type: data.type, entryId: data.entryId, withEntryId: data.withEntryId };
  }
}

/** The published lesson a one-day change is for. Another school's id is a 404; a draft's lesson is not allowed. */
async function lessonOf(ctx: ServiceContext, entryId: string): Promise<{ versionId: string; planId: string }> {
  const entry = await TimetableEntry.findOne({ _id: entryId, tenantId: ctx.tenantId }).select('versionId planId').lean<{ versionId: string; planId: string }>();
  if (!entry) throw AppError.notFound('Lesson not found.');
  return entry;
}

export async function createOverride(ctx: ServiceContext, data: CreateOverrideData): Promise<OverrideResultDTO> {
  const entry = await lessonOf(ctx, data.entryId);
  const plan = await writablePlan(ctx, entry.planId);
  const version = await TimetableVersion.findOne({ _id: entry.versionId, tenantId: ctx.tenantId }).lean<TimetableVersionDoc>();
  if (!version || version.status !== 'PUBLISHED') throw new AppError('OVERRIDE_INVALID', 'One-day changes are for a published timetable. To change a draft, edit its lessons.');
  await assertChangeDate(ctx, plan, data.date);
  const running = await runningVersion(ctx, plan._id, data.date);
  if (running._id !== version._id) throw new AppError('OVERRIDE_INVALID', `On ${data.date} the timetable in use is "${running.versionName}", not the one this lesson belongs to. Choose the lesson from that timetable.`, { runningVersionId: running._id });
  const dayOfLesson = await TimetableEntry.findOne({ _id: data.entryId, tenantId: ctx.tenantId }).select('weekday').lean<{ weekday: string }>();
  if (dayOfLesson && dayOfLesson.weekday !== weekdayOf(data.date)) throw new AppError('OVERRIDE_INVALID', `This lesson is on ${WEEKDAY_LABELS[dayOfLesson.weekday as keyof typeof WEEKDAY_LABELS]}s, and ${data.date} is a ${WEEKDAY_LABELS[weekdayOf(data.date)]}.`, { date: data.date });

  const spec = specFromCreate(data);
  const reason = ('reason' in data ? data.reason : undefined)?.trim() || null;
  const run = () =>
    withTransaction(async (db) => {
      await lockPlan(ctx, plan._id, db);
      if (data.requestId) {
        const prior = await Override.findOne({ tenantId: ctx.tenantId, requestId: data.requestId }).session(db).lean<OverrideDoc>();
        if (prior) return { doc: prior, check: null, repeated: true as const };
      }
      const replaced = REPLACEABLE.has(spec.type) ? await Override.findOne({ tenantId: ctx.tenantId, entryId: data.entryId, date: data.date, type: spec.type, status: 'ACTIVE' }).session(db).lean<OverrideDoc>() : null;
      const day = await loadDay(ctx, plan, running, data.date, db, replaced ? [replaced._id] : []);
      await validateRefs(ctx, day.snap, { teacherIds: [...(spec.type === 'SUBSTITUTE_FACULTY' || spec.type === 'SUBJECT_CHANGE' ? (spec.substituteEmployeeId ? [spec.substituteEmployeeId] : []) : [])], spaceId: spec.type === 'ROOM_CHANGE' ? spec.physicalSpaceId : undefined });
      if (spec.type === 'SUBJECT_CHANGE' && !day.snap.facts.offeringOf.has(spec.subjectOfferingId)) throw AppError.notFound('Subject not found.');
      const proposal = propose(day, spec);
      const rec = day.snap.board.get(proposal.entryId)!;
      if (data.override) withOverride(ctx, rec, afterStep(day, proposal), data.override);
      const check = checkDay(day, proposal.ops, proposal.entryId);
      if (check.blockers.length > 0) throw clash(day, spec, check, await coversThisMonth(ctx, plan._id, data.date), rec);
      if (replaced) await cancelRow(ctx, db, replaced, 'Replaced by a newer change.', plan);
      const doc = await save(ctx, db, day, proposal, check, { reason, override: data.override, requestId: data.requestId }, undefined);
      return { doc, check, repeated: false as const };
    });
  let out: Awaited<ReturnType<typeof run>>;
  try {
    out = await run();
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('entryId')) throw new AppError('OVERRIDE_INVALID', 'This lesson already has this kind of change on that date. Change or cancel it first.');
    if (data.requestId && duplicateKeyFields(err)?.includes('requestId')) {
      const prior = await Override.findOne({ tenantId: ctx.tenantId, requestId: data.requestId }).lean<OverrideDoc>();
      if (prior) out = { doc: prior, check: null, repeated: true };
      else throw err;
    } else throw err;
  }
  const [dto] = await overrideDTOs(ctx, plan, [out.doc]);
  return { override: dto!, issues: out.check ? [...out.check.warnings, ...out.check.info].map(issueDTO) : [] };
}

/** Changes the details of a change (another substitute, another room…). The new details are checked like a new change. */
export async function updateOverride(ctx: ServiceContext, overrideId: string, data: UpdateOverrideData): Promise<OverrideResultDTO> {
  const found = await Override.findOne({ _id: overrideId, tenantId: ctx.tenantId }).lean<OverrideDoc>();
  if (!found) throw AppError.notFound('One-day change not found.');
  const plan = await writablePlan(ctx, found.planId);
  if (found.status !== 'ACTIVE') throw new AppError('OVERRIDE_INVALID', 'This change was cancelled. Make a new one.');
  await assertChangeDate(ctx, plan, found.date);
  const version = await runningVersion(ctx, plan._id, found.date);
  const faculty = await OverrideFaculty.find({ tenantId: ctx.tenantId, overrideId, status: 'ACTIVE' }).lean<OverrideFacultyDoc[]>();
  const spec = ((): OverrideSpec => {
    const entryId = found.entryId;
    const originals = faculty.filter((f) => f.role === 'ORIGINAL').map((f) => f.employeeId);
    const sub = faculty.find((f) => f.role === 'SUBSTITUTE')?.employeeId;
    switch (found.type) {
      case 'SUBSTITUTE_FACULTY':
        return { type: found.type, entryId, substituteEmployeeId: data.substituteEmployeeId ?? sub!, originalEmployeeId: originals.length === 1 ? originals[0] : undefined };
      case 'ROOM_CHANGE':
        return { type: found.type, entryId, physicalSpaceId: data.physicalSpaceId !== undefined ? data.physicalSpaceId : ((found.payload.physicalSpaceId as string | null) ?? null) };
      case 'CLASS_CANCELLED':
        return { type: found.type, entryId };
      case 'PERIOD_SWAP':
        return { type: found.type, entryId, otherEntryId: data.otherEntryId ?? (found.payload.otherEntryId as string) };
      case 'SUBJECT_CHANGE':
        return { type: found.type, entryId, subjectOfferingId: data.subjectOfferingId ?? (found.payload.subjectOfferingId as string), substituteEmployeeId: data.substituteEmployeeId ?? sub };
      case 'SPECIAL_ACTIVITY':
        return { type: found.type, entryId, activityName: data.activityName ?? (found.payload.activityName as string) };
      case 'COMBINED_CLASS':
        return { type: found.type, entryId, withEntryId: data.withEntryId ?? (found.payload.withEntryId as string) };
    }
  })();
  const doc = await withTransaction(async (db) => {
    await lockPlan(ctx, plan._id, db);
    const row = await Override.findOne({ _id: overrideId, tenantId: ctx.tenantId, status: 'ACTIVE' }).session(db).lean<OverrideDoc>();
    if (!row) throw new AppError('OVERRIDE_INVALID', 'This change was just cancelled.');
    const day = await loadDay(ctx, plan, version, found.date, db, [overrideId]);
    await validateRefs(ctx, day.snap, { teacherIds: spec.type === 'SUBSTITUTE_FACULTY' || spec.type === 'SUBJECT_CHANGE' ? (spec.substituteEmployeeId ? [spec.substituteEmployeeId] : []) : [], spaceId: spec.type === 'ROOM_CHANGE' ? spec.physicalSpaceId : undefined });
    const proposal = propose(day, spec);
    const rec = day.snap.board.get(proposal.entryId)!;
    if (data.override) withOverride(ctx, rec, afterStep(day, proposal), data.override);
    const check = checkDay(day, proposal.ops, proposal.entryId);
    if (check.blockers.length > 0) throw clash(day, spec, check, await coversThisMonth(ctx, plan._id, found.date), rec);
    const reason = data.reason !== undefined ? (data.reason?.trim() || null) : row.reason;
    return { doc: await save(ctx, db, day, proposal, check, { reason }, row), check };
  });
  const [dto] = await overrideDTOs(ctx, plan, [doc.doc]);
  return { override: dto!, issues: [...doc.check.warnings, ...doc.check.info].map(issueDTO) };
}

async function cancelRow(ctx: ServiceContext, db: ClientSession, row: OverrideDoc, note: string | null, plan: TimetablePlanDoc) {
  await Override.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { status: 'CANCELLED', cancelledAt: new Date(), cancelledBy: ctx.userId, updatedBy: ctx.userId, ...(note ? { reason: [row.reason, note].filter(Boolean).join(' · ') } : {}) } }, { session: db });
  await OverrideFaculty.updateMany({ tenantId: ctx.tenantId, overrideId: row._id }, { $set: { status: 'CANCELLED' } }, { session: db });
  await recordTimetableAudit(ctx, db, { entityType: 'timetable_override', entityId: row._id, action: 'timetable_override.cancelled', planId: plan._id, locationId: plan.locationId, changes: [{ field: 'status', from: 'ACTIVE', to: 'CANCELLED' }], metadata: { type: row.type, date: row.date, entryId: row.entryId, note } });
  await emitTimetableEvent(db, ctx.tenantId, 'timetable.override.cancelled', { overrideId: row._id, planId: plan._id, entryId: row.entryId, date: row.date, type: row.type });
}

/** Cancels a one-day change. The lesson goes back to what the weekly timetable says. */
export async function cancelOverride(ctx: ServiceContext, overrideId: string, reason?: string): Promise<OverrideDTO> {
  const found = await Override.findOne({ _id: overrideId, tenantId: ctx.tenantId }).lean<OverrideDoc>();
  if (!found) throw AppError.notFound('One-day change not found.');
  const plan = await writablePlan(ctx, found.planId);
  if (found.status === 'ACTIVE') {
    await withTransaction(async (db) => {
      await lockPlan(ctx, plan._id, db);
      const row = await Override.findOne({ _id: overrideId, tenantId: ctx.tenantId, status: 'ACTIVE' }).session(db).lean<OverrideDoc>();
      if (row) await cancelRow(ctx, db, row, reason ? `Cancelled: ${reason}` : null, plan);
    });
  }
  const [dto] = await overrideDTOs(ctx, plan, [(await Override.findOne({ _id: overrideId, tenantId: ctx.tenantId }).lean<OverrideDoc>())!]);
  return dto!;
}

// ───────────────────────────────────────────────────────────── many at once

interface BulkItem {
  entryId: string;
  date: string;
  spec: OverrideSpec;
  label?: string;
}

/**
 * Many changes in one transaction. Each is judged on the real date with the earlier ones already in place, so two cannot take the same
 * teacher or room. One that clashes is reported with its reason and the rest still save.
 */
async function applyBulk(ctx: ServiceContext, plan: TimetablePlanDoc, items: BulkItem[], opts: { reason: string | null; requestId?: string; verb: string }): Promise<OverrideBulkResultDTO> {
  const batchId = opts.requestId ?? randomUUID();
  if (opts.requestId) {
    const prior = await Override.find({ tenantId: ctx.tenantId, planId: plan._id, batchId: opts.requestId }).lean<OverrideDoc[]>();
    if (prior.length > 0) {
      const dtos = await overrideDTOs(ctx, plan, prior);
      return { requested: items.length, done: prior.length, failed: [], overrides: dtos, message: `${plural(prior.length, 'change')} saved earlier.` };
    }
  }
  for (const date of new Set(items.map((i) => i.date))) await assertChangeDate(ctx, plan, date);
  const result = await withTransaction(async (db) => {
    await lockPlan(ctx, plan._id, db);
    const done: OverrideDoc[] = [];
    const failed: OverrideFailureDTO[] = [];
    const days = new Map<string, DayState>();
    for (const item of items) {
      try {
        const entry = await TimetableEntry.findOne({ _id: item.entryId, tenantId: ctx.tenantId, planId: plan._id }).select('versionId').lean<{ versionId: string }>();
        if (!entry) throw AppError.notFound('Lesson not found.');
        const running = await runningVersion(ctx, plan._id, item.date, db);
        if (running._id !== entry.versionId) throw new AppError('OVERRIDE_INVALID', `The timetable in use on ${item.date} is "${running.versionName}". This lesson is from another version.`);
        let day = days.get(item.date);
        if (!day) {
          day = await loadDay(ctx, plan, running, item.date, db);
          days.set(item.date, day);
        }
        if (day.docs.some((d) => d.entryId === item.entryId && d.type === item.spec.type && d.status === 'ACTIVE') || done.some((d) => d.entryId === item.entryId && d.date === item.date && d.type === item.spec.type)) throw new AppError('OVERRIDE_INVALID', `This lesson already has ${item.spec.type === 'SUBSTITUTE_FACULTY' ? 'a substitute' : 'this change'} on ${item.date}.`);
        await validateRefs(ctx, day.snap, { teacherIds: item.spec.type === 'SUBSTITUTE_FACULTY' ? [item.spec.substituteEmployeeId] : [], spaceId: item.spec.type === 'ROOM_CHANGE' ? item.spec.physicalSpaceId : undefined });
        const proposal = propose(day, item.spec);
        const check = checkDay(day, proposal.ops, proposal.entryId);
        if (check.blockers.length > 0) throw new AppError('TIMETABLE_CLASH', check.blockers[0]!.message);
        const doc = await save(ctx, db, day, proposal, check, { reason: opts.reason, batchId });
        applyToDay(day, proposal);
        day.docs.push(doc);
        done.push(doc);
      } catch (err) {
        if (!(err instanceof AppError) || !['TIMETABLE_CLASH', 'OVERRIDE_INVALID', 'NOT_FOUND', 'WRONG_CAMPUS', 'NO_PUBLISHED_TIMETABLE'].includes(err.code)) throw err;
        const rec = days.get(item.date)?.snap;
        failed.push({ entryId: item.entryId, date: item.date, label: item.label ?? (rec?.board.get(item.entryId) ? namerOf(rec).lesson(rec.board.get(item.entryId)!) : 'Lesson'), message: err.message });
      }
    }
    return { done, failed };
  });
  const dtos = await overrideDTOs(ctx, plan, result.done);
  const message = result.failed.length === 0 ? `${plural(result.done.length, 'change')} saved.` : `${result.done.length} of ${items.length} saved. ${plural(result.failed.length, 'period')} could not be changed: ${result.failed[0]!.message}`;
  return { requested: items.length, done: result.done.length, failed: result.failed, overrides: dtos, message };
}

/** Substitutes for many periods. Each period keeps its own original teacher. */
export async function bulkSubstitutions(ctx: ServiceContext, data: BulkSubstitutionsData): Promise<OverrideBulkResultDTO> {
  const plan = await writablePlan(ctx, data.planId);
  return applyBulk(ctx, plan, data.items.map((i) => ({ entryId: i.entryId, date: i.date, spec: { type: 'SUBSTITUTE_FACULTY' as const, entryId: i.entryId, substituteEmployeeId: i.substituteEmployeeId } })), { reason: data.reason?.trim() || null, requestId: data.requestId, verb: 'covered' });
}

export async function applyRoomChanges(ctx: ServiceContext, data: ApplyRoomChangesData): Promise<OverrideBulkResultDTO> {
  const plan = await writablePlan(ctx, data.planId);
  return applyBulk(ctx, plan, data.items.map((i) => ({ entryId: i.entryId, date: i.date, spec: { type: 'ROOM_CHANGE' as const, entryId: i.entryId, physicalSpaceId: i.physicalSpaceId } })), { reason: data.reason?.trim() || null, requestId: data.requestId, verb: 'moved' });
}

/** Cancels lessons: chosen ones, a section's day, or the whole campus's day (the interim "day off"). */
export async function cancelLessons(ctx: ServiceContext, data: CancelLessonsData): Promise<OverrideBulkResultDTO> {
  const plan = await writablePlan(ctx, data.planId);
  await assertChangeDate(ctx, plan, data.date);
  const version = await runningVersion(ctx, plan._id, data.date);
  const book = await loadLite(ctx, plan, [version._id], undefined, { weekdays: [weekdayOf(data.date)] });
  const all = book.recs.get(version._id) ?? [];
  const chosen = data.entryIds ? all.filter((e) => data.entryIds!.includes(e.id)) : data.sectionIds ? all.filter((e) => e.sectionIds.some((s) => data.sectionIds!.includes(s)) || (e.groupId && book.groups.get(e.groupId)?.sectionPool.some((s) => data.sectionIds!.includes(s)))) : all;
  if (chosen.length === 0) throw new AppError('OVERRIDE_INVALID', `There are no lessons to cancel on ${data.date}.`);
  const n = namerOf(book);
  return applyBulk(ctx, plan, chosen.map((e) => ({ entryId: e.id, date: data.date, label: `${n.lesson(e)}, ${n.periodName(e.periodId)}`, spec: { type: 'CLASS_CANCELLED' as const, entryId: e.id } })), { reason: data.reason.trim(), requestId: data.requestId, verb: 'cancelled' });
}

// ───────────────────────────────────────────────────────────── reading

/** Rows as plain DTOs: who, what, when, in words. Names are looked up each time. */
export async function overrideDTOs(ctx: ServiceContext, plan: TimetablePlanDoc, docs: OverrideDoc[]): Promise<OverrideDTO[]> {
  if (docs.length === 0) return [];
  docs = docs.map((d) => ({ ...d, payload: d.payload ?? {} }));
  const entryIds = [...new Set(docs.flatMap((d) => [d.entryId, ...(typeof d.payload.otherEntryId === 'string' ? [d.payload.otherEntryId] : []), ...(typeof d.payload.withEntryId === 'string' ? [d.payload.withEntryId] : [])]))];
  const versionIds = [...new Set(docs.map((d) => d.versionId))];
  const [book, faculty, users] = await Promise.all([
    loadLite(ctx, plan, versionIds, undefined, { entryIds }),
    OverrideFaculty.find({ tenantId: ctx.tenantId, overrideId: { $in: docs.map((d) => d._id) } }).lean<OverrideFacultyDoc[]>(),
    User.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(docs.map((d) => d.createdBy))] } }).select('fullName').lean<{ _id: string; fullName: string }[]>(),
  ]);
  await book.addTeachers(faculty.map((f) => f.employeeId));
  await book.addRooms(docs.map((d) => d.payload.physicalSpaceId).filter((id): id is string => typeof id === 'string'));
  const n = namerOf(book);
  const recOf = new Map([...book.recs.values()].flat().map((e) => [e.id, e]));
  const userOf = new Map(users.map((u) => [u._id, u.fullName]));
  const when = (id: string) => {
    const e = recOf.get(id);
    return e ? `${n.periodName(e.periodId)}, ${minutesToClock(e.startMin)}-${minutesToClock(e.endMin)}` : '';
  };
  return docs
    .sort((a, b) => a.date.localeCompare(b.date) || (recOf.get(a.entryId)?.startMin ?? 0) - (recOf.get(b.entryId)?.startMin ?? 0) || a._id.localeCompare(b._id))
    .map((d) => {
      const rec = recOf.get(d.entryId);
      const mine = faculty.filter((f) => f.overrideId === d._id);
      const original = mine.filter((f) => f.role === 'ORIGINAL').map((f) => ({ employeeId: f.employeeId, fullName: n.teacher(f.employeeId) }));
      const substitutes = mine.filter((f) => f.role === 'SUBSTITUTE').map((f) => ({ employeeId: f.employeeId, fullName: n.teacher(f.employeeId) }));
      const roomId = (d.payload.physicalSpaceId as string | null | undefined) ?? null;
      const subjectName = typeof d.payload.subjectOfferingId === 'string' ? n.subject(d.payload.subjectOfferingId) : null;
      const activityName = typeof d.payload.activityName === 'string' ? d.payload.activityName : null;
      const otherId = typeof d.payload.otherEntryId === 'string' ? d.payload.otherEntryId : typeof d.payload.withEntryId === 'string' ? d.payload.withEntryId : null;
      const other = otherId ? recOf.get(otherId) : undefined;
      const label = rec ? n.lesson(rec) : 'A lesson';
      const names = (list: { fullName: string }[]) => list.map((t) => t.fullName).join(', ');
      const summary = {
        SUBSTITUTE_FACULTY: `${names(substitutes)} covers${original.length ? ` for ${names(original)}` : ''}`,
        ROOM_CHANGE: roomId ? `Moved to ${n.room(roomId)}` : 'Taught with no room',
        CLASS_CANCELLED: `Cancelled${d.reason ? `: ${d.reason}` : ''}`,
        PERIOD_SWAP: `Swapped with ${other ? `${n.lesson(other)} (${n.periodName(other.periodId)})` : 'another period'}`,
        SUBJECT_CHANGE: `Taught as ${subjectName ?? 'another subject'}${substitutes.length ? ` by ${names(substitutes)}` : ''}`,
        SPECIAL_ACTIVITY: activityName ?? 'Special activity',
        COMBINED_CLASS: `Joins ${other ? n.lesson(other) : 'another lesson'}`,
      }[d.type];
      return {
        overrideId: d._id,
        planId: d.planId,
        versionId: d.versionId,
        entryId: d.entryId,
        date: d.date,
        weekday: weekdayOf(d.date),
        type: d.type,
        status: d.status,
        reason: d.reason,
        label,
        when: when(d.entryId),
        original,
        substitutes,
        roomName: roomId ? n.room(roomId) : null,
        subjectName,
        activityName,
        otherEntryId: otherId,
        otherLabel: other ? n.lesson(other) : null,
        summary: `${OVERRIDE_TYPE_LABELS[d.type]}: ${summary}`.replace(/^[^:]+: (?=Cancelled)/, ''),
        acknowledged: (d.acknowledged ?? []).map((a) => ({ rule: a.rule, reason: a.reason })),
        createdBy: (d.createdBy && userOf.get(d.createdBy)) || 'Someone',
        createdAt: d.createdAt.toISOString(),
        cancelledAt: d.cancelledAt ? d.cancelledAt.toISOString() : null,
      } satisfies OverrideDTO;
    });
}

export async function listOverrides(ctx: ServiceContext, query: ListOverridesQuery): Promise<OverrideDTO[]> {
  const plan = await readablePlan(ctx, query.planId);
  const docs = await Override.find({
    tenantId: ctx.tenantId,
    planId: plan._id,
    status: query.status,
    ...(query.type ? { type: query.type } : {}),
    ...(query.date ? { date: query.date } : query.dateFrom || query.dateTo ? { date: { ...(query.dateFrom ? { $gte: query.dateFrom } : {}), ...(query.dateTo ? { $lte: query.dateTo } : {}) } } : {}),
  })
    .limit(500)
    .lean<OverrideDoc[]>();
  return overrideDTOs(ctx, plan, docs);
}

export async function getOverride(ctx: ServiceContext, overrideId: string): Promise<OverrideDTO> {
  const doc = await Override.findOne({ _id: overrideId, tenantId: ctx.tenantId }).lean<OverrideDoc>();
  if (!doc) throw AppError.notFound('One-day change not found.');
  return (await overrideDTOs(ctx, await readablePlan(ctx, doc.planId), [doc]))[0]!;
}
