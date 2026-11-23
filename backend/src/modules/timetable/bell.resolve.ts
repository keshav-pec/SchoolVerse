import type { ClientSession } from 'mongoose';
import type { BellSource, Weekday } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { BellAssignment, BellPeriod, BellSchedule, type BellAssignmentDoc, type BellPeriodDoc, type BellScheduleDoc, type TimetablePlanDoc } from './models';

/**
 * Which Daily Periods apply to a section on a weekday: the most specific row wins. Section, then Class, then the school default; at one
 * level a row for particular weekdays beats a row for every day. Pure functions on loaded data, so the readiness check, Subject Needs
 * totals and the resolution table all give the same answer.
 */
export interface BellContext {
  plan: Pick<TimetablePlanDoc, '_id' | 'operatingDays' | 'defaultBellScheduleId'>;
  templates: Map<string, BellScheduleDoc>;
  periods: Map<string, BellPeriodDoc[]>;
  assignments: BellAssignmentDoc[];
}

export async function loadBellContext(ctx: ServiceContext, plan: BellContext['plan'], db?: ClientSession): Promise<BellContext> {
  const where = { tenantId: ctx.tenantId, planId: plan._id };
  const [templates, periods, assignments] = await Promise.all([
    BellSchedule.find({ ...where, status: 'ACTIVE' }).session(db ?? null).lean<BellScheduleDoc[]>(),
    BellPeriod.find(where).session(db ?? null).lean<BellPeriodDoc[]>(),
    BellAssignment.find(where).session(db ?? null).lean<BellAssignmentDoc[]>(),
  ]);
  const byTemplate = new Map<string, BellPeriodDoc[]>();
  for (const p of periods) byTemplate.set(p.templateId, [...(byTemplate.get(p.templateId) ?? []), p]);
  for (const list of byTemplate.values()) list.sort((a, b) => a.startMin - b.startMin);
  return { plan, templates: new Map(templates.map((t) => [t._id, t])), periods: byTemplate, assignments };
}

export interface BellChoice {
  templateId: string;
  source: BellSource;
}

function pick(rows: BellAssignmentDoc[], day: Weekday): BellAssignmentDoc | undefined {
  return rows.find((r) => r.weekdays.includes(day)) ?? rows.find((r) => r.weekdays.length === 0);
}

export function resolveBell(c: BellContext, classOfferingId: string, sectionOfferingId: string | null, day: Weekday): BellChoice | null {
  const live = (r: BellAssignmentDoc | undefined) => (r && c.templates.has(r.templateId) ? r : undefined);
  if (sectionOfferingId) {
    const hit = live(pick(c.assignments.filter((a) => a.scope === 'SECTION' && a.sectionOfferingId === sectionOfferingId), day));
    if (hit) return { templateId: hit.templateId, source: 'SECTION' };
  }
  const klass = live(pick(c.assignments.filter((a) => a.scope === 'CLASS' && a.classOfferingId === classOfferingId), day));
  if (klass) return { templateId: klass.templateId, source: 'CLASS' };
  const fallback = c.plan.defaultBellScheduleId;
  return fallback && c.templates.has(fallback) ? { templateId: fallback, source: 'DEFAULT' } : null;
}

export const lessonPeriodsOf = (c: BellContext, templateId: string): BellPeriodDoc[] => (c.periods.get(templateId) ?? []).filter((p) => p.schedulable);

/** Periods a week can hold for a section (or a class when no section is given). Null when no school day has Daily Periods yet. */
export function weekSlots(c: BellContext, classOfferingId: string, sectionOfferingId: string | null): number | null {
  let total = 0;
  let found = false;
  for (const day of c.plan.operatingDays) {
    const choice = resolveBell(c, classOfferingId, sectionOfferingId, day);
    if (!choice) continue;
    found = true;
    total += lessonPeriodsOf(c, choice.templateId).length;
  }
  return found ? total : null;
}
