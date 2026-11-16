import type { ClientSession } from 'mongoose';
import { DEFAULT_TIMEZONE, type AssignmentStatus } from '@shared';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { todayIn } from '../academic/term.service';
import { School } from '../school/school.model';

/**
 * Effective dating (Module 3). A row has `effectiveFrom`, an optional last day `effectiveTo` (inclusive) and an optional
 * `cancelledAt`. Its status is never stored: it is worked out from today's date in the school's time zone,
 * so nothing has to flip statuses overnight and history is never overwritten.
 */
export interface EffectiveRange {
  effectiveFrom: string;
  effectiveTo?: string | null;
  cancelledAt?: Date | string | null;
}

export function assignmentStatus(row: EffectiveRange, today: string): AssignmentStatus {
  if (row.cancelledAt) return 'CANCELLED';
  if (today < row.effectiveFrom) return 'PLANNED';
  if (row.effectiveTo && today > row.effectiveTo) return 'COMPLETED';
  return 'ACTIVE';
}

/** True while the row is current or still to come (not ended, not cancelled). */
export function isOpen(row: EffectiveRange, today: string): boolean {
  const status = assignmentStatus(row, today);
  return status === 'ACTIVE' || status === 'PLANNED';
}

/** `YYYY-MM-DD` plus or minus whole days, with no time zone shift. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const latest = (a: string, b: string) => (a >= b ? a : b);

/** Mongo fragment: rows whose range overlaps `[from, to]` (`to = null` means open-ended). Combine with `$and`. */
export function overlapping(from: string, to: string | null) {
  return {
    $and: [
      ...(to ? [{ effectiveFrom: { $lte: to } }] : []),
      { $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }] },
    ],
  };
}

/** Mongo fragment: rows that are current or planned on `today` (not ended, not cancelled). */
export function openOn(today: string) {
  return { cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] };
}

/** Today in the school's time zone. */
export async function todayFor(ctx: ServiceContext, db?: ClientSession): Promise<string> {
  return todayForTenant(ctx.tenantId, db);
}

export async function todayForTenant(tenantId: string, db?: ClientSession, now = new Date()): Promise<string> {
  const school = await School.findOne({ tenantId }).select('defaultTimezone').session(db ?? null).lean<{ defaultTimezone: string }>();
  return todayIn(school?.defaultTimezone ?? DEFAULT_TIMEZONE, now);
}

/** Time zones for several tenants at once (the hourly exit job). */
export async function timezonesByTenant(tenantIds: string[]): Promise<Map<string, string>> {
  const schools = await School.find({ tenantId: { $in: tenantIds } })
    .setOptions(SKIP_TENANT_SCOPE)
    .select('tenantId defaultTimezone')
    .lean<{ tenantId: string; defaultTimezone: string }[]>();
  return new Map(schools.map((s) => [s.tenantId, s.defaultTimezone]));
}
