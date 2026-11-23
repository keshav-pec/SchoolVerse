import {
  SCHEDULABLE_PERIOD_TYPES,
  clockToMinutes,
  minutesToClock,
  type BellAssignmentDTO,
  type BellAssignmentsDTO,
  type BellBulkResultDTO,
  type BellGenerateResultDTO,
  type BellGeneratePreviewDTO,
  type BellPeriodDTO,
  type BellResolutionDTO,
  type BellScheduleDTO,
  type BulkBellAssignmentData,
  type GenerateBellData,
  type GeneratedPeriodDTO,
  type PeriodType,
  type Weekday,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { recordTimetableAudit } from './audit';
import { loadBellContext, resolveBell } from './bell.resolve';
import { loadPlanFacts, requirePlanClass, requirePlanSection, sectionLabelOf } from './facts';
import { readablePlan, writablePlan } from './guards';
import { BellAssignment, BellPeriod, BellSchedule, TimetablePlan, type BellAssignmentDoc, type BellPeriodDoc, type BellScheduleDoc, type TimetablePlanDoc } from './models';
import { sortDays } from './plan.service';
import { findPeriodUsage } from './usage';

/** TT-03 to TT-05 — Daily Periods (the bell): templates, periods, the generator, who uses which, and the resolution table. */

const CODE_PREFIX: Record<PeriodType, string> = { TEACHING: 'P', HOMEROOM: 'H', ACTIVITY: 'A', ASSEMBLY: 'ASM', BREAK: 'BRK', LUNCH: 'LUN', NON_INSTRUCTIONAL: 'X' };
const isSchedulableType = (t: PeriodType) => SCHEDULABLE_PERIOD_TYPES.includes(t);

// ───────────────────────────────────────────────────────────── mapping

function toPeriodDTO(p: BellPeriodDoc, used = 0): BellPeriodDTO {
  return { periodId: p._id, bellScheduleId: p.templateId, periodCode: p.periodCode, periodName: p.periodName, startMin: p.startMin, endMin: p.endMin, start: minutesToClock(p.startMin), end: minutesToClock(p.endMin), periodType: p.periodType, schedulable: p.schedulable, displayOrder: p.displayOrder, usedByEntries: used };
}

async function toBellDTOs(ctx: ServiceContext, plan: Pick<TimetablePlanDoc, '_id' | 'defaultBellScheduleId'>, templates: BellScheduleDoc[]): Promise<BellScheduleDTO[]> {
  if (templates.length === 0) return [];
  const ids = templates.map((t) => t._id);
  const [periods, assignments] = await Promise.all([
    BellPeriod.find({ tenantId: ctx.tenantId, templateId: { $in: ids } }).lean<BellPeriodDoc[]>(),
    BellAssignment.find({ tenantId: ctx.tenantId, templateId: { $in: ids } }).select('templateId').lean<{ templateId: string }[]>(),
  ]);
  return templates.map((t) => {
    const own = periods.filter((p) => p.templateId === t._id).sort((a, b) => a.startMin - b.startMin);
    const isDefault = plan.defaultBellScheduleId === t._id;
    return {
      bellScheduleId: t._id,
      planId: t.planId,
      name: t.name,
      kind: t.kind,
      status: t.status,
      isDefault,
      periods: own.map((p) => toPeriodDTO(p)),
      lessonPeriods: own.filter((p) => p.schedulable).length,
      usedBy: assignments.filter((a) => a.templateId === t._id).length + (isDefault ? 1 : 0),
    };
  });
}

function toAssignmentDTO(a: BellAssignmentDoc): BellAssignmentDTO {
  return { assignmentId: a._id, planId: a.planId, scope: a.scope, classOfferingId: a.classOfferingId, sectionOfferingId: a.sectionOfferingId, bellScheduleId: a.templateId, weekdays: sortDays(a.weekdays) };
}

async function loadTemplate(ctx: ServiceContext, id: string, db?: import('mongoose').ClientSession): Promise<BellScheduleDoc> {
  const doc = await BellSchedule.findOne({ _id: id, tenantId: ctx.tenantId }).session(db ?? null).lean<BellScheduleDoc>();
  if (!doc) throw AppError.notFound('Daily Periods not found.');
  return doc;
}

async function loadPeriod(ctx: ServiceContext, id: string, db?: import('mongoose').ClientSession): Promise<BellPeriodDoc> {
  const doc = await BellPeriod.findOne({ _id: id, tenantId: ctx.tenantId }).session(db ?? null).lean<BellPeriodDoc>();
  if (!doc) throw AppError.notFound('Period not found.');
  return doc;
}

// ───────────────────────────────────────────────────────────── templates

export async function listBellSchedules(ctx: ServiceContext, planId: string): Promise<BellScheduleDTO[]> {
  const plan = await readablePlan(ctx, planId);
  const templates = await BellSchedule.find({ tenantId: ctx.tenantId, planId, status: 'ACTIVE' }).sort({ createdAt: 1 }).lean<BellScheduleDoc[]>();
  return toBellDTOs(ctx, plan, templates);
}

export async function getBellSchedule(ctx: ServiceContext, id: string): Promise<BellScheduleDTO> {
  const template = await loadTemplate(ctx, id);
  const plan = await readablePlan(ctx, template.planId);
  return (await toBellDTOs(ctx, plan, [template]))[0]!;
}

export async function createBellSchedule(ctx: ServiceContext, planId: string, data: { name: string; kind: BellScheduleDoc['kind'] }): Promise<BellScheduleDTO> {
  const plan = await writablePlan(ctx, planId);
  const id = await withTransaction(async (db) => {
    const [doc] = await BellSchedule.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId, name: data.name, kind: data.kind, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: doc!._id, action: 'bell_schedule.created', planId, locationId: plan.locationId, metadata: { name: data.name } });
    return doc!._id;
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('name')) throw new AppError('BELL_NAME_TAKEN');
    throw err;
  });
  return getBellSchedule(ctx, id);
}

export async function updateBellSchedule(ctx: ServiceContext, id: string, data: { name?: string; kind?: BellScheduleDoc['kind'] }): Promise<BellScheduleDTO> {
  const before = await loadTemplate(ctx, id);
  const plan = await writablePlan(ctx, before.planId);
  const patch = pickDefined(data);
  await withTransaction(async (db) => {
    const changes = diffFields(before, { ...before, ...patch }, ['name', 'kind'] as const);
    if (changes.length === 0) return;
    await BellSchedule.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: id, action: 'bell_schedule.updated', changes, planId: plan._id, locationId: plan.locationId });
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('name')) throw new AppError('BELL_NAME_TAKEN');
    throw err;
  });
  return getBellSchedule(ctx, id);
}

/** Copy a template (for Junior or Saturday): new template, same periods, new ids. */
export async function duplicateBellSchedule(ctx: ServiceContext, id: string, data: { name: string; kind: BellScheduleDoc['kind'] }): Promise<BellScheduleDTO> {
  const source = await loadTemplate(ctx, id);
  const plan = await writablePlan(ctx, source.planId);
  const periods = await BellPeriod.find({ tenantId: ctx.tenantId, templateId: id }).sort({ startMin: 1 }).lean<BellPeriodDoc[]>();
  const newId = await withTransaction(async (db) => {
    const [doc] = await BellSchedule.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId: plan._id, name: data.name, kind: data.kind, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    if (periods.length > 0) {
      await BellPeriod.create(
        periods.map((p) => ({ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId: plan._id, templateId: doc!._id, periodCode: p.periodCode, periodName: p.periodName, startMin: p.startMin, endMin: p.endMin, periodType: p.periodType, schedulable: p.schedulable, displayOrder: p.displayOrder, createdBy: ctx.userId, updatedBy: ctx.userId })),
        { session: db, ordered: true },
      );
    }
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: doc!._id, action: 'bell_schedule.duplicated', planId: plan._id, locationId: plan.locationId, metadata: { copiedFrom: id, periods: periods.length } });
    return doc!._id;
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('name')) throw new AppError('BELL_NAME_TAKEN');
    throw err;
  });
  return getBellSchedule(ctx, newId);
}

export async function deleteBellSchedule(ctx: ServiceContext, id: string): Promise<void> {
  const template = await loadTemplate(ctx, id);
  const plan = await writablePlan(ctx, template.planId);
  const [assigned, periods] = await Promise.all([BellAssignment.countDocuments({ tenantId: ctx.tenantId, templateId: id }), BellPeriod.find({ tenantId: ctx.tenantId, templateId: id }).select('_id').lean<{ _id: string }[]>()]);
  const usage = await findPeriodUsage({ tenantId: ctx.tenantId, planId: plan._id, periodIds: periods.map((p) => p._id) });
  if (assigned > 0 || plan.defaultBellScheduleId === id || usage.count > 0) {
    throw new AppError('BELL_IN_USE', plan.defaultBellScheduleId === id ? 'This is the school default. Choose another default first.' : assigned > 0 ? `${assigned} class${assigned === 1 ? ' or section uses' : 'es or sections use'} these Daily Periods. Choose other Daily Periods for them first.` : undefined, { assignments: assigned, lessons: usage.count });
  }
  await withTransaction(async (db) => {
    await BellPeriod.deleteMany({ tenantId: ctx.tenantId, templateId: id }, { session: db });
    await BellSchedule.deleteOne({ _id: id, tenantId: ctx.tenantId }, { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: id, action: 'bell_schedule.deleted', planId: plan._id, locationId: plan.locationId, metadata: { name: template.name } });
  });
}

// ───────────────────────────────────────────────────────────── periods

interface PeriodInput {
  periodName: string;
  start: string;
  end: string;
  periodType: PeriodType;
  schedulable?: boolean;
}

function readTimes(start: string, end: string): { startMin: number; endMin: number } {
  const startMin = clockToMinutes(start);
  const endMin = clockToMinutes(end);
  if (startMin === null || endMin === null) throw new AppError('PERIOD_INVALID', 'Enter the times like 08:30.');
  if (endMin <= startMin) throw new AppError('PERIOD_INVALID', 'A period must end after it starts.', { fields: { end: 'Choose a time after the start.' } });
  return { startMin, endMin };
}

function assertSchedulable(type: PeriodType, schedulable: boolean) {
  if (schedulable && !isSchedulableType(type)) throw new AppError('PERIOD_INVALID', 'Breaks, lunch and assembly can never hold a lesson.', { fields: { schedulable: 'Only teaching, homeroom and activity periods can hold lessons.' } });
}

function assertNoOverlap(others: BellPeriodDoc[], startMin: number, endMin: number) {
  const clash = others.find((o) => startMin < o.endMin && endMin > o.startMin);
  if (clash) {
    throw new AppError('PERIOD_OVERLAP', `This overlaps ${clash.periodName} (${minutesToClock(clash.startMin)} to ${minutesToClock(clash.endMin)}).`, { with: { periodId: clash._id, periodName: clash.periodName, start: minutesToClock(clash.startMin), end: minutesToClock(clash.endMin) } });
  }
}

function nextCode(prefix: string, taken: Set<string>): string {
  for (let n = 1; ; n += 1) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** Renumbers `displayOrder` by start time, so the order is always the order of the day. */
async function renumber(ctx: ServiceContext, templateId: string, db: import('mongoose').ClientSession) {
  const rows = await BellPeriod.find({ tenantId: ctx.tenantId, templateId }).sort({ startMin: 1 }).select('_id displayOrder').session(db).lean<{ _id: string; displayOrder: number }[]>();
  for (const [index, row] of rows.entries()) if (row.displayOrder !== index + 1) await BellPeriod.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { displayOrder: index + 1 } }, { session: db });
}

export async function addBellPeriod(ctx: ServiceContext, templateId: string, data: PeriodInput & { periodCode?: string }): Promise<BellScheduleDTO> {
  const template = await loadTemplate(ctx, templateId);
  const plan = await writablePlan(ctx, template.planId);
  const { startMin, endMin } = readTimes(data.start, data.end);
  const schedulable = data.schedulable ?? isSchedulableType(data.periodType);
  assertSchedulable(data.periodType, schedulable);
  await withTransaction(async (db) => {
    const others = await BellPeriod.find({ tenantId: ctx.tenantId, templateId }).session(db).lean<BellPeriodDoc[]>();
    assertNoOverlap(others, startMin, endMin);
    const taken = new Set(others.map((o) => o.periodCode));
    const code = (data.periodCode ?? nextCode(CODE_PREFIX[data.periodType], taken)).toUpperCase();
    if (taken.has(code)) throw new AppError('PERIOD_INVALID', `The code ${code} is already used in these Daily Periods.`, { fields: { periodCode: 'Choose another code.' } });
    const [doc] = await BellPeriod.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId: plan._id, templateId, periodCode: code, periodName: data.periodName, startMin, endMin, periodType: data.periodType, schedulable, displayOrder: others.length + 1, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await renumber(ctx, templateId, db);
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: templateId, action: 'bell_period.created', planId: plan._id, locationId: plan.locationId, metadata: { periodId: doc!._id, periodCode: code, start: data.start, end: data.end } });
  });
  return getBellSchedule(ctx, templateId);
}

export async function updateBellPeriod(ctx: ServiceContext, periodId: string, data: Partial<PeriodInput>): Promise<BellPeriodDTO> {
  const before = await loadPeriod(ctx, periodId);
  const plan = await writablePlan(ctx, before.planId);
  const nextType = data.periodType ?? before.periodType;
  const times = data.start !== undefined || data.end !== undefined ? readTimes(data.start ?? minutesToClock(before.startMin), data.end ?? minutesToClock(before.endMin)) : { startMin: before.startMin, endMin: before.endMin };
  // Changing the type to a break turns "can hold lessons" off unless the caller says otherwise (which is then refused).
  const schedulable = data.schedulable ?? (data.periodType !== undefined ? isSchedulableType(nextType) : before.schedulable);
  assertSchedulable(nextType, schedulable);
  const changedTime = times.startMin !== before.startMin || times.endMin !== before.endMin;
  const usage = changedTime || nextType !== before.periodType || schedulable !== before.schedulable ? await findPeriodUsage({ tenantId: ctx.tenantId, planId: plan._id, periodIds: [periodId] }) : { count: 0, examples: [] };
  await withTransaction(async (db) => {
    const others = (await BellPeriod.find({ tenantId: ctx.tenantId, templateId: before.templateId, _id: { $ne: periodId } }).session(db).lean<BellPeriodDoc[]>());
    assertNoOverlap(others, times.startMin, times.endMin);
    const next = { periodName: data.periodName ?? before.periodName, periodType: nextType, schedulable, ...times };
    const changes = diffFields(before, { ...before, ...next }, ['periodName', 'startMin', 'endMin', 'periodType', 'schedulable'] as const);
    if (changes.length === 0) return;
    await BellPeriod.updateOne({ _id: periodId, tenantId: ctx.tenantId }, { $set: { ...next, updatedBy: ctx.userId } }, { session: db });
    await renumber(ctx, before.templateId, db);
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: before.templateId, action: 'bell_period.updated', changes, planId: plan._id, locationId: plan.locationId, metadata: { periodId, affectedLessons: usage.count } });
  });
  return toPeriodDTO(await loadPeriod(ctx, periodId), usage.count);
}

export async function deleteBellPeriod(ctx: ServiceContext, periodId: string): Promise<void> {
  const period = await loadPeriod(ctx, periodId);
  const plan = await writablePlan(ctx, period.planId);
  const usage = await findPeriodUsage({ tenantId: ctx.tenantId, planId: plan._id, periodIds: [periodId] });
  if (usage.count > 0) throw new AppError('BELL_IN_USE', `${usage.count} lesson${usage.count === 1 ? ' uses' : 's use'} this period. Move or clear ${usage.count === 1 ? 'it' : 'them'} first.`, { lessons: usage.count, examples: usage.examples });
  await withTransaction(async (db) => {
    await BellPeriod.deleteOne({ _id: periodId, tenantId: ctx.tenantId }, { session: db });
    await renumber(ctx, period.templateId, db);
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: period.templateId, action: 'bell_period.deleted', planId: plan._id, locationId: plan.locationId, metadata: { periodCode: period.periodCode } });
  });
}

// ───────────────────────────────────────────────────────────── generator

interface Block {
  name: string;
  startMin: number;
  endMin: number;
  type: PeriodType;
}

/** The exact periods the generator would make, and the minutes it could not use. Pure, so preview and commit always agree. */
export function buildGeneratedPeriods(data: Pick<GenerateBellData, 'start' | 'end' | 'periodMinutes' | 'breaks' | 'assembly'>): { periods: GeneratedPeriodDTO[]; leftoverMinutes: number; message: string | null } {
  const start = clockToMinutes(data.start);
  const end = clockToMinutes(data.end);
  if (start === null || end === null || end <= start) throw new AppError('PERIOD_INVALID', 'The school day must end after it starts.', { fields: { end: 'Choose a time after the start.' } });
  const blocks: Block[] = data.breaks.map((b) => ({ name: b.name, startMin: clockToMinutes(b.start)!, endMin: clockToMinutes(b.end)!, type: b.type }));
  if (data.assembly) blocks.push({ name: data.assembly.name, startMin: clockToMinutes(data.assembly.start)!, endMin: clockToMinutes(data.assembly.end)!, type: 'ASSEMBLY' });
  blocks.sort((a, b) => a.startMin - b.startMin);
  for (const [i, b] of blocks.entries()) {
    if (b.endMin <= b.startMin) throw new AppError('PERIOD_INVALID', `${b.name} must end after it starts.`);
    if (b.startMin < start || b.endMin > end) throw new AppError('PERIOD_INVALID', `${b.name} must be inside the school day (${data.start} to ${data.end}).`);
    const next = blocks[i + 1];
    if (next && next.startMin < b.endMin) throw new AppError('PERIOD_OVERLAP', `${b.name} and ${next.name} overlap.`);
  }

  const periods: GeneratedPeriodDTO[] = [];
  const counts: Partial<Record<PeriodType, number>> = {};
  const push = (name: string | null, type: PeriodType, startMin: number, endMin: number) => {
    counts[type] = (counts[type] ?? 0) + 1;
    const n = counts[type]!;
    const code = type === 'ASSEMBLY' && n === 1 ? 'ASM' : `${CODE_PREFIX[type]}${n}`;
    periods.push({ periodCode: code, periodName: name ?? `Period ${n}`, start: minutesToClock(startMin), end: minutesToClock(endMin), startMin, endMin, periodType: type, schedulable: isSchedulableType(type) });
  };

  let cursor = start;
  let gaps = 0;
  let queue = [...blocks];
  while (cursor < end) {
    const next = queue[0];
    if (next && cursor >= next.startMin) {
      push(next.name, next.type, next.startMin, next.endMin);
      cursor = Math.max(cursor, next.endMin);
      queue = queue.slice(1);
      continue;
    }
    const limit = next ? next.startMin : end;
    if (cursor + data.periodMinutes <= limit) {
      push(null, 'TEACHING', cursor, cursor + data.periodMinutes);
      cursor += data.periodMinutes;
    } else if (next) {
      gaps += limit - cursor;
      cursor = limit;
    } else {
      break;
    }
  }
  const atEnd = Math.max(0, end - cursor);
  const leftoverMinutes = gaps + atEnd;
  const parts: string[] = [];
  if (atEnd > 0) parts.push(`${atEnd} minute${atEnd === 1 ? '' : 's'} left at the end of the day`);
  if (gaps > 0) parts.push(`${gaps} minute${gaps === 1 ? '' : 's'} left before a break`);
  return { periods, leftoverMinutes, message: parts.length ? `${parts.join(' and ')}. A full period does not fit there.` : null };
}

export async function previewBellGeneration(ctx: ServiceContext, planId: string, data: GenerateBellData): Promise<BellGeneratePreviewDTO> {
  await readablePlan(ctx, planId);
  const built = buildGeneratedPeriods(data);
  return { name: data.name, periods: built.periods, lessonPeriods: built.periods.filter((p) => p.schedulable).length, leftoverMinutes: built.leftoverMinutes, message: built.message };
}

const sameShape = (a: { periodCode: string; startMin: number; endMin: number; periodType: PeriodType }[], b: { periodCode: string; startMin: number; endMin: number; periodType: PeriodType }[]) =>
  a.length === b.length && a.every((p, i) => p.periodCode === b[i]!.periodCode && p.startMin === b[i]!.startMin && p.endMin === b[i]!.endMin && p.periodType === b[i]!.periodType);

export async function generateBell(ctx: ServiceContext, planId: string, data: GenerateBellData): Promise<BellGenerateResultDTO> {
  const plan = await writablePlan(ctx, planId);
  const built = buildGeneratedPeriods(data);
  const existing = await BellSchedule.findOne({ tenantId: ctx.tenantId, planId, name: data.name }).lean<BellScheduleDoc>();
  if (existing) {
    const rows = await BellPeriod.find({ tenantId: ctx.tenantId, templateId: existing._id }).sort({ startMin: 1 }).lean<BellPeriodDoc[]>();
    if (!sameShape(rows, built.periods)) throw new AppError('BELL_NAME_TAKEN');
    return { schedule: await getBellSchedule(ctx, existing._id), alreadyExisted: true };
  }
  const id = await withTransaction(async (db) => {
    const [doc] = await BellSchedule.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId, name: data.name, kind: data.kind, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await BellPeriod.create(
      built.periods.map((p, i) => ({ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId, templateId: doc!._id, periodCode: p.periodCode, periodName: p.periodName, startMin: p.startMin, endMin: p.endMin, periodType: p.periodType, schedulable: p.schedulable, displayOrder: i + 1, createdBy: ctx.userId, updatedBy: ctx.userId })),
      { session: db, ordered: true },
    );
    // The first set of Daily Periods becomes the school default, so a small school has nothing else to set.
    if (!plan.defaultBellScheduleId) await TimetablePlan.updateOne({ _id: planId, tenantId: ctx.tenantId, defaultBellScheduleId: null }, { $set: { defaultBellScheduleId: doc!._id } }, { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: doc!._id, action: 'bell_schedule.generated', planId, locationId: plan.locationId, metadata: { name: data.name, periods: built.periods.length, leftoverMinutes: built.leftoverMinutes } });
    return doc!._id;
  }).catch(async (err: unknown) => {
    if (duplicateKeyFields(err)?.includes('name')) throw new AppError('BELL_NAME_TAKEN');
    throw err;
  });
  return { schedule: await getBellSchedule(ctx, id), alreadyExisted: false };
}

// ───────────────────────────────────────────────────────────── who uses which

export async function listBellAssignments(ctx: ServiceContext, planId: string): Promise<BellAssignmentsDTO> {
  const plan = await readablePlan(ctx, planId);
  const rows = await BellAssignment.find({ tenantId: ctx.tenantId, planId }).sort({ createdAt: 1 }).lean<BellAssignmentDoc[]>();
  return { defaultBellScheduleId: plan.defaultBellScheduleId, items: rows.map(toAssignmentDTO) };
}

export async function bulkAssignBell(ctx: ServiceContext, planId: string, data: BulkBellAssignmentData): Promise<BellBulkResultDTO> {
  const plan = await writablePlan(ctx, planId);
  const template = await loadTemplate(ctx, data.bellScheduleId);
  if (template.planId !== planId || template.status !== 'ACTIVE') throw AppError.notFound('Daily Periods not found.');
  const weekdays = sortDays(data.weekdays ?? []);
  const closed = weekdays.filter((d) => !plan.operatingDays.includes(d));
  if (closed.length > 0) throw AppError.validation({ weekdays: `${closed.join(', ')} ${closed.length === 1 ? 'is' : 'are'} not a school day in this plan.` });

  if (data.scope === 'DEFAULT') {
    await withTransaction(async (db) => {
      await TimetablePlan.updateOne({ _id: planId, tenantId: ctx.tenantId }, { $set: { defaultBellScheduleId: template._id, updatedBy: ctx.userId } }, { session: db });
      await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: template._id, action: 'bell_schedule.default_set', changes: [{ field: 'defaultBellScheduleId', from: plan.defaultBellScheduleId, to: template._id }], planId, locationId: plan.locationId });
    });
    return { applied: 1, defaultSet: true, items: [] };
  }

  const scope: 'CLASS' | 'SECTION' = data.scope === 'CLASS' ? 'CLASS' : 'SECTION';
  const targets = scope === 'CLASS' ? [...new Set(data.classOfferingIds ?? [])] : [...new Set(data.sectionOfferingIds ?? [])];
  const classOf = new Map<string, string>();
  for (const id of targets) {
    if (scope === 'CLASS') await requirePlanClass(ctx, plan, id);
    else classOf.set(id, (await requirePlanSection(ctx, plan, id)).classOfferingId);
  }

  const touched: BellAssignmentDoc[] = [];
  await withTransaction(async (db) => {
    for (const target of targets) {
      const key = scope === 'CLASS' ? { classOfferingId: target, sectionOfferingId: null } : { classOfferingId: classOf.get(target)!, sectionOfferingId: target };
      const existing = await BellAssignment.find({ tenantId: ctx.tenantId, planId, scope, ...(scope === 'CLASS' ? { classOfferingId: target } : { sectionOfferingId: target }) }).session(db).lean<BellAssignmentDoc[]>();
      if (weekdays.length === 0) {
        const allDays = existing.find((r) => r.weekdays.length === 0);
        if (allDays) {
          await BellAssignment.updateOne({ _id: allDays._id, tenantId: ctx.tenantId }, { $set: { templateId: template._id, updatedBy: ctx.userId } }, { session: db });
          touched.push({ ...allDays, templateId: template._id });
          continue;
        }
      } else {
        // A day can only be named once at one level, so the new rule takes those days from older day-specific rules.
        for (const row of existing.filter((r) => r.weekdays.length > 0)) {
          const left = row.weekdays.filter((d) => !weekdays.includes(d));
          if (left.length === row.weekdays.length) continue;
          if (left.length === 0) await BellAssignment.deleteOne({ _id: row._id, tenantId: ctx.tenantId }, { session: db });
          else await BellAssignment.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { weekdays: left, updatedBy: ctx.userId } }, { session: db });
        }
      }
      const [doc] = await BellAssignment.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId, scope, ...key, templateId: template._id, weekdays, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
      touched.push(doc!.toObject() as BellAssignmentDoc);
    }
    await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: template._id, action: 'bell_schedule.assigned', planId, locationId: plan.locationId, metadata: { scope, targets: targets.length, weekdays } });
  });
  return { applied: targets.length, defaultSet: false, items: touched.map(toAssignmentDTO) };
}

export async function clearBellAssignments(ctx: ServiceContext, planId: string, assignmentIds: string[]): Promise<{ removed: number }> {
  const plan = await writablePlan(ctx, planId);
  const removed = await withTransaction(async (db) => {
    const result = await BellAssignment.deleteMany({ tenantId: ctx.tenantId, planId, _id: { $in: assignmentIds } }, { session: db });
    if (result.deletedCount > 0) await recordTimetableAudit(ctx, db, { entityType: 'bell_schedule', entityId: planId, action: 'bell_assignment.cleared', planId, locationId: plan.locationId, metadata: { removed: result.deletedCount } });
    return result.deletedCount;
  });
  return { removed };
}

/** For every section and school day, which Daily Periods apply and from where. Sections with none are listed so the screen can fix them. */
export async function bellResolution(ctx: ServiceContext, planId: string): Promise<BellResolutionDTO> {
  const plan = await readablePlan(ctx, planId);
  const [facts, bell] = await Promise.all([loadPlanFacts(ctx, plan), loadBellContext(ctx, plan)]);
  const days = sortDays(plan.operatingDays);
  const rows = facts.sections.map((section) => {
    const byDay: BellResolutionDTO['rows'][number]['byDay'] = {};
    const missingDays: Weekday[] = [];
    for (const day of days) {
      const choice = resolveBell(bell, section.classOfferingId, section._id, day);
      if (!choice) {
        byDay[day] = { bellScheduleId: null, bellScheduleName: null, source: null };
        missingDays.push(day);
      } else byDay[day] = { bellScheduleId: choice.templateId, bellScheduleName: bell.templates.get(choice.templateId)?.name ?? null, source: choice.source };
    }
    return { sectionOfferingId: section._id, classOfferingId: section.classOfferingId, label: sectionLabelOf(facts, section._id), className: facts.classOf.get(section.classOfferingId)?.displayName ?? '', byDay, missingDays };
  });
  return { planId, operatingDays: days, rows, missing: rows.filter((r) => r.missingDays.length > 0).map((r) => ({ sectionOfferingId: r.sectionOfferingId, label: r.label, days: r.missingDays })) };
}
