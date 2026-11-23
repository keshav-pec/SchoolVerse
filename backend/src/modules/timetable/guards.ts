import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import { recordSecurityEvent } from '../../platform/identity/security-events';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { getCurrentSchool } from '../school/school.service';
import type { SchoolDoc } from '../school/school.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { currentLocationIds, findCallerEmployee } from '../staff/access';
import { todayFor } from '../staff/status';
import { TimetableGrant, TimetablePlan, type TimetablePlanDoc } from './models';

/** Loaders that answer 404 for another tenant's id exactly as for a missing one, plus the campus scope and the read-only rules. */

export async function requireSchool(ctx: ServiceContext): Promise<SchoolDoc> {
  const school = await getCurrentSchool(ctx);
  if (!school) throw AppError.notFound('Set up the school profile before planning the timetable.');
  return school;
}

// ───────────────────────────────────────────────────────────── campus scope

/**
 * A School Admin reaches every campus. Everyone else reaches the campuses where they have an assignment running today, narrowed by the
 * campuses on their timetable bundle if the admin set any. A campus outside that is refused (403) and written as `CROSS_SCOPE_DENIED`.
 */
export interface TimetableScope {
  all: boolean;
  locationIds: string[];
}

export async function timetableScope(ctx: ServiceContext): Promise<TimetableScope> {
  if (ctx.role === 'SCHOOL_ADMIN') return { all: true, locationIds: [] };
  const employee = await findCallerEmployee(ctx);
  if (!employee) return { all: false, locationIds: [] };
  const own = await currentLocationIds(ctx.tenantId, employee._id, await todayFor(ctx));
  const grant = await TimetableGrant.findOne({ tenantId: ctx.tenantId, userId: ctx.userId }).select('locationIds').lean<{ locationIds: string[] | null }>();
  return { all: false, locationIds: grant?.locationIds ? own.filter((id) => grant.locationIds!.includes(id)) : own };
}

export const inScope = (scope: TimetableScope, locationId: string) => scope.all || scope.locationIds.includes(locationId);

export async function assertInScope(ctx: ServiceContext, scope: TimetableScope, locationId: string, resource: string, targetId: string) {
  if (inScope(scope, locationId)) return;
  await recordSecurityEvent({ tenantId: ctx.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: ctx.userId, targetId, ip: ctx.ip ?? null, outcome: 'DENIED', metadata: { resource, locationId } });
  throw new AppError('FORBIDDEN', "You don't have access to this campus.");
}

// ───────────────────────────────────────────────────────────── plan

export async function loadPlan(ctx: ServiceContext, planId: string, db?: ClientSession): Promise<TimetablePlanDoc> {
  const doc = await TimetablePlan.findOne({ _id: planId, tenantId: ctx.tenantId }).session(db ?? null).lean<TimetablePlanDoc>();
  if (!doc) throw AppError.notFound('Timetable plan not found.');
  return doc;
}

export async function loadSession(ctx: ServiceContext, academicSessionId: string, db?: ClientSession): Promise<AcademicSessionDoc> {
  const doc = await AcademicSession.findOne({ _id: academicSessionId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicSessionDoc>();
  if (!doc) throw AppError.notFound('Academic session not found.');
  return doc;
}

export function assertSessionOpen(session: Pick<AcademicSessionDoc, 'status'>) {
  if (session.status === 'CLOSED' || session.status === 'ARCHIVED') throw new AppError('SESSION_READ_ONLY');
}

/** A plan the caller may read: right tenant, right campus. */
export async function readablePlan(ctx: ServiceContext, planId: string, db?: ClientSession): Promise<TimetablePlanDoc> {
  const plan = await loadPlan(ctx, planId, db);
  await assertInScope(ctx, await timetableScope(ctx), plan.locationId, 'timetable_plan', planId);
  return plan;
}

/** A plan the caller may change: readable, not archived, and in a session that is not closed. */
export async function writablePlan(ctx: ServiceContext, planId: string, db?: ClientSession): Promise<TimetablePlanDoc> {
  const plan = await readablePlan(ctx, planId, db);
  if (plan.status === 'ARCHIVED') throw new AppError('PLAN_READ_ONLY');
  assertSessionOpen(await loadSession(ctx, plan.academicSessionId, db));
  return plan;
}

/** Editable rows carry a `version`; a PATCH built from an older copy is refused. */
export function assertVersion(current: number, sent: number) {
  if (current !== sent) throw new AppError('VERSION_CONFLICT', undefined, { currentVersion: current });
}
