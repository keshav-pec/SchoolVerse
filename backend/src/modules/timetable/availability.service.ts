import {
  MINUTES_PER_DAY,
  WEEKDAY_LABELS,
  clockToMinutes,
  minutesToClock,
  type AvailabilityBulkResultDTO,
  type AvailabilityRowDTO,
  type BulkAvailabilityData,
  type CopyAvailabilityData,
  type FacultyAvailabilityDTO,
  type PlanTeacherDTO,
  type ReplaceAvailabilityData,
  type SaveWorkloadData,
  type TeacherWorkloadDTO,
  type WorkloadRulesDTO,
  type WorkloadValuesDTO,
  type Weekday,
  WEEKDAYS,
  WORKLOAD_FIELDS,
} from '@shared';
import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { recordTimetableAudit } from './audit';
import { loadPlanTeachers, requirePlanTeacher } from './facts';
import { readablePlan, writablePlan } from './guards';
import { Availability, TimetablePlan, WorkloadRule, type AvailabilityDoc, type TimetablePlanDoc, type WorkloadRuleDoc } from './models';

/** TT-11, TT-12 — teacher availability (only the exceptions are stored) and workload limits. Times are minutes, so one row works across different Daily Periods. */

type RowInput = ReplaceAvailabilityData['rows'][number];
type Parsed = { weekday: Weekday; startMin: number; endMin: number; kind: RowInput['kind'] };

const toRowDTO = (r: Pick<AvailabilityDoc, '_id' | 'weekday' | 'startMin' | 'endMin' | 'kind'>): AvailabilityRowDTO => ({ availabilityId: r._id, weekday: r.weekday, startMin: r.startMin, endMin: r.endMin, start: minutesToClock(r.startMin), end: minutesToClock(r.endMin), kind: r.kind });

function parseRows(plan: TimetablePlanDoc, rows: RowInput[]): Parsed[] {
  const parsed = rows.map((r) => ({ weekday: r.weekday, startMin: clockToMinutes(r.start)!, endMin: clockToMinutes(r.end)!, kind: r.kind }));
  for (const r of parsed) {
    if (!plan.operatingDays.includes(r.weekday)) throw new AppError('AVAILABILITY_INVALID', `${WEEKDAY_LABELS[r.weekday]} is not a school day in this plan.`);
    if (r.startMin >= r.endMin || r.endMin > MINUTES_PER_DAY) throw new AppError('AVAILABILITY_INVALID', `On ${WEEKDAY_LABELS[r.weekday]} the end time must be after the start time.`);
  }
  const sorted = [...parsed].sort((a, b) => a.weekday.localeCompare(b.weekday) || a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1]!;
    const cur = sorted[i]!;
    if (prev.weekday === cur.weekday && cur.startMin < prev.endMin) throw new AppError('AVAILABILITY_INVALID', `Two times on ${WEEKDAY_LABELS[cur.weekday]} overlap (${minutesToClock(prev.startMin)}-${minutesToClock(prev.endMin)} and ${minutesToClock(cur.startMin)}-${minutesToClock(cur.endMin)}).`);
  }
  return parsed;
}

async function insertRows(ctx: ServiceContext, plan: TimetablePlanDoc, employeeId: string, rows: Parsed[], db: ClientSession) {
  if (rows.length === 0) return;
  await Availability.create(rows.map((r) => ({ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId: plan._id, employeeId, ...r, createdBy: ctx.userId, updatedBy: ctx.userId })), { session: db, ordered: true });
}

const byTime = (a: { weekday: Weekday; startMin: number }, b: { weekday: Weekday; startMin: number }) => WEEKDAYS.indexOf(a.weekday) - WEEKDAYS.indexOf(b.weekday) || a.startMin - b.startMin;

export async function getAvailability(ctx: ServiceContext, planId: string, employeeId: string): Promise<FacultyAvailabilityDTO> {
  const plan = await readablePlan(ctx, planId);
  const teacher = await requirePlanTeacher(ctx, plan, employeeId);
  const rows = await Availability.find({ tenantId: ctx.tenantId, planId, employeeId }).lean<AvailabilityDoc[]>();
  return { planId, employeeId, fullName: teacher.fullName, rows: rows.sort(byTime).map(toRowDTO) };
}

export async function replaceAvailability(ctx: ServiceContext, employeeId: string, data: ReplaceAvailabilityData): Promise<FacultyAvailabilityDTO> {
  const plan = await writablePlan(ctx, data.planId);
  await requirePlanTeacher(ctx, plan, employeeId);
  const rows = parseRows(plan, data.rows);
  await withTransaction(async (db) => {
    const removed = await Availability.deleteMany({ tenantId: ctx.tenantId, planId: plan._id, employeeId }, { session: db });
    await insertRows(ctx, plan, employeeId, rows, db);
    await recordTimetableAudit(ctx, db, { entityType: 'faculty_availability', entityId: employeeId, action: 'faculty_availability.replaced', planId: plan._id, locationId: plan.locationId, metadata: { before: removed.deletedCount, after: rows.length } });
  });
  return getAvailability(ctx, plan._id, employeeId);
}

/** "These part-time teachers can't do Saturday." `ADD` keeps their other rows (new rows win where times overlap); `REPLACE` starts again. */
export async function bulkAvailability(ctx: ServiceContext, data: BulkAvailabilityData): Promise<AvailabilityBulkResultDTO> {
  const plan = await writablePlan(ctx, data.planId);
  const ids = [...new Set(data.employeeIds)];
  for (const id of ids) await requirePlanTeacher(ctx, plan, id);
  const rows = parseRows(plan, data.rows);
  await withTransaction(async (db) => {
    for (const employeeId of ids) {
      if (data.mode === 'REPLACE') await Availability.deleteMany({ tenantId: ctx.tenantId, planId: plan._id, employeeId }, { session: db });
      else {
        const existing = await Availability.find({ tenantId: ctx.tenantId, planId: plan._id, employeeId }).session(db).lean<AvailabilityDoc[]>();
        const clash = existing.filter((e) => rows.some((r) => r.weekday === e.weekday && r.startMin < e.endMin && r.endMin > e.startMin)).map((e) => e._id);
        if (clash.length > 0) await Availability.deleteMany({ tenantId: ctx.tenantId, _id: { $in: clash } }, { session: db });
      }
      await insertRows(ctx, plan, employeeId, rows, db);
    }
    await recordTimetableAudit(ctx, db, { entityType: 'faculty_availability', entityId: plan._id, action: 'faculty_availability.bulk_applied', planId: plan._id, locationId: plan.locationId, metadata: { teachers: ids.length, rows: rows.length, mode: data.mode } });
  });
  return { teachers: ids.length, rowsPerTeacher: rows.length };
}

export async function copyAvailability(ctx: ServiceContext, data: CopyAvailabilityData): Promise<AvailabilityBulkResultDTO> {
  const plan = await writablePlan(ctx, data.planId);
  await requirePlanTeacher(ctx, plan, data.fromEmployeeId);
  const targets = [...new Set(data.toEmployeeIds)].filter((id) => id !== data.fromEmployeeId);
  for (const id of targets) await requirePlanTeacher(ctx, plan, id);
  const source = await Availability.find({ tenantId: ctx.tenantId, planId: plan._id, employeeId: data.fromEmployeeId }).lean<AvailabilityDoc[]>();
  const rows: Parsed[] = source.map((r) => ({ weekday: r.weekday, startMin: r.startMin, endMin: r.endMin, kind: r.kind }));
  await withTransaction(async (db) => {
    for (const employeeId of targets) {
      await Availability.deleteMany({ tenantId: ctx.tenantId, planId: plan._id, employeeId }, { session: db });
      await insertRows(ctx, plan, employeeId, rows, db);
    }
    await recordTimetableAudit(ctx, db, { entityType: 'faculty_availability', entityId: plan._id, action: 'faculty_availability.copied', planId: plan._id, locationId: plan.locationId, metadata: { fromEmployeeId: data.fromEmployeeId, teachers: targets.length, rows: rows.length } });
  });
  return { teachers: targets.length, rowsPerTeacher: rows.length };
}

// ───────────────────────────────────────────────────────────── teachers of the plan

export async function listPlanTeachers(ctx: ServiceContext, planId: string): Promise<PlanTeacherDTO[]> {
  const plan = await readablePlan(ctx, planId);
  const teachers = await loadPlanTeachers(ctx, plan);
  const [rows, rules] = await Promise.all([Availability.distinct('employeeId', { tenantId: ctx.tenantId, planId }), WorkloadRule.distinct('employeeId', { tenantId: ctx.tenantId, planId })]);
  const withRows = new Set(rows as string[]);
  const withRules = new Set(rules as string[]);
  return teachers.map((t) => ({ employeeId: t.employee._id, fullName: t.fullName, employeeCode: t.employee.employeeCode, hasAvailabilityRows: withRows.has(t.employee._id), hasOwnWorkload: withRules.has(t.employee._id) }));
}

// ───────────────────────────────────────────────────────────── workload

const emptyValues = (): WorkloadValuesDTO => ({ maxPerDay: null, maxConsecutive: null, maxPerWeek: null, preferredFreePerDay: null });
const valuesOfRule = (r: Pick<WorkloadRuleDoc, 'maxPerDay' | 'maxConsecutive' | 'maxPerWeek' | 'preferredFreePerDay'>): WorkloadValuesDTO => ({ maxPerDay: r.maxPerDay, maxConsecutive: r.maxConsecutive, maxPerWeek: r.maxPerWeek, preferredFreePerDay: r.preferredFreePerDay });

export async function getWorkload(ctx: ServiceContext, planId: string): Promise<WorkloadRulesDTO> {
  const plan = await readablePlan(ctx, planId);
  const [teachers, rules] = await Promise.all([loadPlanTeachers(ctx, plan), WorkloadRule.find({ tenantId: ctx.tenantId, planId }).lean<WorkloadRuleDoc[]>()]);
  const own = new Map(rules.map((r) => [r.employeeId, valuesOfRule(r)]));
  const planDefault = { maxPerDay: plan.defaultMaxPerDay, maxConsecutive: plan.defaultMaxConsecutive, maxPerWeek: plan.defaultMaxPerWeek, preferredFreePerDay: null };
  return {
    planId,
    planDefault,
    teachers: teachers.map((t): TeacherWorkloadDTO => {
      const mine = own.get(t.employee._id) ?? emptyValues();
      const usingDefault = Object.fromEntries(WORKLOAD_FIELDS.map((f) => [f, mine[f] === null])) as TeacherWorkloadDTO['usingDefault'];
      const effective = Object.fromEntries(WORKLOAD_FIELDS.map((f) => [f, mine[f] ?? planDefault[f]])) as unknown as WorkloadValuesDTO;
      return { employeeId: t.employee._id, fullName: t.fullName, own: mine, effective, usingDefault };
    }),
  };
}

export async function saveWorkload(ctx: ServiceContext, data: SaveWorkloadData): Promise<WorkloadRulesDTO> {
  const plan = await writablePlan(ctx, data.planId);
  const patch = Object.fromEntries(WORKLOAD_FIELDS.filter((f) => data[f] !== undefined).map((f) => [f, data[f]])) as Partial<WorkloadValuesDTO>;
  if (data.employeeId === null) {
    // The school default lives on the plan.
    const planPatch: Record<string, number | null> = {};
    if (patch.maxPerDay !== undefined) planPatch.defaultMaxPerDay = patch.maxPerDay;
    if (patch.maxConsecutive !== undefined) planPatch.defaultMaxConsecutive = patch.maxConsecutive;
    if (patch.maxPerWeek !== undefined) planPatch.defaultMaxPerWeek = patch.maxPerWeek;
    if (patch.preferredFreePerDay) throw AppError.validation({ preferredFreePerDay: 'Free periods can only be set for one teacher at a time.' });
    await withTransaction(async (db) => {
      await TimetablePlan.updateOne({ _id: plan._id, tenantId: ctx.tenantId }, { $set: { ...planPatch, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
      await recordTimetableAudit(ctx, db, { entityType: 'faculty_availability', entityId: plan._id, action: 'faculty_workload.default_saved', planId: plan._id, locationId: plan.locationId, metadata: planPatch });
    });
    return getWorkload(ctx, plan._id);
  }
  await requirePlanTeacher(ctx, plan, data.employeeId);
  await withTransaction(async (db) => {
    const existing = await WorkloadRule.findOne({ tenantId: ctx.tenantId, planId: plan._id, employeeId: data.employeeId! }).session(db).lean<WorkloadRuleDoc>();
    const next = { ...(existing ? valuesOfRule(existing) : emptyValues()), ...patch };
    if (WORKLOAD_FIELDS.every((f) => next[f] === null)) {
      if (existing) await WorkloadRule.deleteOne({ _id: existing._id, tenantId: ctx.tenantId }, { session: db });
    } else if (existing) await WorkloadRule.updateOne({ _id: existing._id, tenantId: ctx.tenantId }, { $set: { ...next, updatedBy: ctx.userId } }, { session: db });
    else await WorkloadRule.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId: plan._id, employeeId: data.employeeId!, ...next, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'faculty_availability', entityId: data.employeeId!, action: 'faculty_workload.saved', planId: plan._id, locationId: plan.locationId, metadata: next });
  });
  return getWorkload(ctx, plan._id);
}
