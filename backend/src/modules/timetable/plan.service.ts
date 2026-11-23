import {
  DEFAULT_OPERATING_DAYS,
  DEFAULT_TRANSITION_MINUTES,
  WEEKDAY_LABELS,
  type CreateTimetablePlanData,
  type ListTimetablePlansQuery,
  type PlanStatus,
  type TimetablePlanDTO,
  type UpdateTimetablePlanData,
  type Weekday,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { diffFields } from '../audit/diff';
import { Location } from '../locations/location.model';
import { assertLocationWritable, loadLocation } from '../spaces/guards';
import { emitTimetableEvent, recordTimetableAudit } from './audit';
import { assertInScope, assertSessionOpen, assertVersion, loadSession, readablePlan, requireSchool, timetableScope, writablePlan, inScope } from './guards';
import { TimetablePlan, type TimetablePlanDoc } from './models';
import { findPeriodUsage } from './usage';

/** TT-01, TT-02 — one plan per campus per session. The plan holds the school week, the capacity rule and the workload defaults. */

const AUDITED = ['planName', 'effectiveFrom', 'effectiveTo', 'operatingDays', 'capacityPolicy', 'transitionMinutes', 'defaultMaxPerDay', 'defaultMaxConsecutive', 'defaultMaxPerWeek', 'status'] as const;

const ORDER = new Map<Weekday, number>([['MON', 0], ['TUE', 1], ['WED', 2], ['THU', 3], ['FRI', 4], ['SAT', 5], ['SUN', 6]]);
export const sortDays = (days: readonly Weekday[]): Weekday[] => [...new Set(days)].sort((a, b) => ORDER.get(a)! - ORDER.get(b)!);

export async function toPlanDTOs(ctx: ServiceContext, docs: TimetablePlanDoc[]): Promise<TimetablePlanDTO[]> {
  if (docs.length === 0) return [];
  const [locations, sessions] = await Promise.all([
    Location.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(docs.map((d) => d.locationId))] } }).select('displayName').lean<{ _id: string; displayName: string }[]>(),
    AcademicSession.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(docs.map((d) => d.academicSessionId))] } }).select('name').lean<{ _id: string; name: string }[]>(),
  ]);
  const locationName = new Map(locations.map((l) => [l._id, l.displayName]));
  const sessionName = new Map(sessions.map((s) => [s._id, s.name]));
  return docs.map((d) => ({
    planId: d._id,
    locationId: d.locationId,
    locationName: locationName.get(d.locationId) ?? 'Unknown campus',
    academicSessionId: d.academicSessionId,
    sessionName: sessionName.get(d.academicSessionId) ?? 'Unknown session',
    planName: d.planName,
    effectiveFrom: d.effectiveFrom,
    effectiveTo: d.effectiveTo,
    operatingDays: sortDays(d.operatingDays),
    defaultBellScheduleId: d.defaultBellScheduleId,
    capacityPolicy: d.capacityPolicy,
    transitionMinutes: d.transitionMinutes,
    defaultMaxPerDay: d.defaultMaxPerDay,
    defaultMaxConsecutive: d.defaultMaxConsecutive,
    defaultMaxPerWeek: d.defaultMaxPerWeek,
    status: d.status,
    version: d.version,
  }));
}

function assertDates(from: string, to: string, session: Pick<AcademicSessionDoc, 'startDate' | 'endDate'>) {
  if (from > to) throw new AppError('PLAN_DATES_INVALID');
  if (from < session.startDate || to > session.endDate) throw new AppError('PLAN_DATES_INVALID', `The plan dates must be inside the session (${session.startDate} to ${session.endDate}).`);
}

export async function createPlan(ctx: ServiceContext, data: CreateTimetablePlanData): Promise<TimetablePlanDTO> {
  const [school, location, session] = await Promise.all([requireSchool(ctx), loadLocation(ctx, data.locationId), loadSession(ctx, data.academicSessionId)]);
  await assertInScope(ctx, await timetableScope(ctx), data.locationId, 'location', data.locationId);
  assertLocationWritable(location);
  assertSessionOpen(session);
  if (!session.locations.some((l) => l.locationId === data.locationId)) throw new AppError('LOCATION_NOT_IN_SESSION');
  const from = data.effectiveFrom ?? session.startDate;
  const to = data.effectiveTo ?? session.endDate;
  assertDates(from, to, session);

  const existing = await TimetablePlan.findOne({ tenantId: ctx.tenantId, locationId: data.locationId, academicSessionId: data.academicSessionId }).select('_id').lean<{ _id: string }>();
  if (existing) throw new AppError('PLAN_EXISTS', undefined, { planId: existing._id });

  const id = await withTransaction(async (db) => {
    const [doc] = await TimetablePlan.create(
      [
        {
          tenantId: ctx.tenantId,
          schoolId: school._id,
          locationId: data.locationId,
          academicSessionId: data.academicSessionId,
          planName: data.planName ?? `${session.name} · ${location.displayName}`,
          effectiveFrom: from,
          effectiveTo: to,
          operatingDays: sortDays(data.operatingDays ?? DEFAULT_OPERATING_DAYS),
          capacityPolicy: data.capacityPolicy ?? 'WARN',
          transitionMinutes: data.transitionMinutes ?? DEFAULT_TRANSITION_MINUTES,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_plan', entityId: doc!._id, action: 'timetable_plan.created', planId: doc!._id, locationId: data.locationId, metadata: { academicSessionId: data.academicSessionId } });
    await emitTimetableEvent(db, ctx.tenantId, 'timetable.plan.created', { planId: doc!._id, locationId: data.locationId, academicSessionId: data.academicSessionId });
    return doc!._id;
  }).catch(async (err: unknown) => {
    if (duplicateKeyFields(err)) {
      const again = await TimetablePlan.findOne({ tenantId: ctx.tenantId, locationId: data.locationId, academicSessionId: data.academicSessionId }).select('_id').lean<{ _id: string }>();
      throw new AppError('PLAN_EXISTS', undefined, again ? { planId: again._id } : undefined);
    }
    throw err;
  });
  return getPlan(ctx, id);
}

export async function listPlans(ctx: ServiceContext, query: ListTimetablePlansQuery): Promise<TimetablePlanDTO[]> {
  const scope = await timetableScope(ctx);
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
  if (query.locationId) filter.locationId = query.locationId;
  if (query.academicSessionId) filter.academicSessionId = query.academicSessionId;
  if (!query.includeArchived) filter.status = { $ne: 'ARCHIVED' };
  const docs = (await TimetablePlan.find(filter).sort({ effectiveFrom: -1, planName: 1 }).lean<TimetablePlanDoc[]>()).filter((d) => inScope(scope, d.locationId));
  return toPlanDTOs(ctx, docs);
}

export async function getPlan(ctx: ServiceContext, planId: string): Promise<TimetablePlanDTO> {
  return (await toPlanDTOs(ctx, [await readablePlan(ctx, planId)]))[0]!;
}

export async function updatePlan(ctx: ServiceContext, planId: string, data: UpdateTimetablePlanData): Promise<TimetablePlanDTO> {
  const before = await writablePlan(ctx, planId);
  assertVersion(before.version, data.version);
  const { version: _version, ...rest } = data;
  const patch = pickDefined(rest) as Partial<TimetablePlanDoc>;
  if (patch.operatingDays) patch.operatingDays = sortDays(patch.operatingDays);
  const session = await loadSession(ctx, before.academicSessionId);
  assertDates(patch.effectiveFrom ?? before.effectiveFrom, patch.effectiveTo ?? before.effectiveTo, session);

  // A school day cannot go while lessons are on it.
  const removed = patch.operatingDays ? before.operatingDays.filter((d) => !patch.operatingDays!.includes(d)) : [];
  for (const day of removed) {
    const usage = await findPeriodUsage({ tenantId: ctx.tenantId, planId, weekday: day });
    if (usage.count > 0) throw new AppError('OPERATING_DAY_IN_USE', `${usage.count} lesson${usage.count === 1 ? ' is' : 's are'} on ${WEEKDAY_LABELS[day]}. Clear them first.`, { weekday: day, count: usage.count, examples: usage.examples });
  }

  await withTransaction(async (db) => {
    const changes = diffFields(before, { ...before, ...patch }, AUDITED);
    if (changes.length === 0) return;
    const updated = await TimetablePlan.findOneAndUpdate({ _id: planId, tenantId: ctx.tenantId, version: data.version }, { $set: { ...patch, updatedBy: ctx.userId }, $inc: { version: 1 } }, { returnDocument: 'after', session: db }).lean();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_plan', entityId: planId, action: 'timetable_plan.updated', changes, planId, locationId: before.locationId });
    await emitTimetableEvent(db, ctx.tenantId, 'timetable.plan.updated', { planId });
  });
  return getPlan(ctx, planId);
}

/** Archive a plan (its campus and session can then be closed) or bring it back. Nothing is deleted. */
export async function changePlanStatus(ctx: ServiceContext, planId: string, to: 'ARCHIVED' | 'DRAFT'): Promise<TimetablePlanDTO> {
  const before = await readablePlan(ctx, planId);
  const from: PlanStatus = before.status;
  if (to === 'ARCHIVED' && from === 'ARCHIVED') return getPlan(ctx, planId);
  if (to === 'DRAFT') {
    if (from !== 'ARCHIVED') return getPlan(ctx, planId);
    assertSessionOpen(await loadSession(ctx, before.academicSessionId));
  }
  await withTransaction(async (db) => {
    await TimetablePlan.updateOne({ _id: planId, tenantId: ctx.tenantId }, { $set: { status: to, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'timetable_plan', entityId: planId, action: to === 'ARCHIVED' ? 'timetable_plan.archived' : 'timetable_plan.restored', changes: [{ field: 'status', from, to }], planId, locationId: before.locationId });
    await emitTimetableEvent(db, ctx.tenantId, to === 'ARCHIVED' ? 'timetable.plan.archived' : 'timetable.plan.updated', { planId });
  });
  return getPlan(ctx, planId);
}
