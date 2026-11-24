import { WEEKDAY_LABELS } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { loadPlanFacts, sectionLabelOf, subjectNameOf } from '../facts';
import { BellPeriod, EntrySection, TimetableEntry, TimetablePlan, TimetableVersion, type BellPeriodDoc, type TimetablePlanDoc } from '../models';
import { registerPeriodUsage } from '../usage';

/**
 * Replaces the Part 1 answer "no lessons yet" with the real one. Changing a period, removing a Daily Periods set or removing a school day
 * asks this first. Lessons in a discarded draft do not count.
 */
registerPeriodUsage('timetable.period_in_use', async ({ tenantId, planId, periodIds, weekday }) => {
  const live = (await TimetableVersion.find({ tenantId, planId, status: { $ne: 'DISCARDED' } }).select('_id').lean<{ _id: string }[]>()).map((v) => v._id);
  if (live.length === 0) return { count: 0, examples: [] };
  const where = { tenantId, versionId: { $in: live }, ...(periodIds ? { periodId: { $in: periodIds } } : {}), ...(weekday ? { weekday } : {}) };
  const count = await TimetableEntry.countDocuments(where);
  if (count === 0) return { count: 0, examples: [] };
  const sample = await TimetableEntry.find(where).sort({ weekday: 1, startMin: 1 }).limit(3).lean();
  const plan = await TimetablePlan.findOne({ _id: planId, tenantId }).lean<TimetablePlanDoc>();
  if (!plan) return { count, examples: [] };
  const ctx = { tenantId } as ServiceContext;
  const facts = await loadPlanFacts(ctx, plan);
  const sections = await EntrySection.find({ tenantId, entryId: { $in: sample.map((e) => e._id) } }).lean();
  const periods = new Map((await BellPeriod.find({ tenantId, _id: { $in: sample.map((e) => e.periodId) } }).lean<BellPeriodDoc[]>()).map((p) => [p._id, p.periodName]));
  const examples = sample.map((e) => {
    const where = sections.filter((s) => s.entryId === e._id).map((s) => sectionLabelOf(facts, s.sectionOfferingId)).join(' + ');
    const what = e.subjectOfferingId ? subjectNameOf(facts, e.subjectOfferingId) : (e.activityName ?? 'a lesson');
    return `${where} ${what}, ${WEEKDAY_LABELS[e.weekday]} ${periods.get(e.periodId) ?? ''}`.replace(/\s+/g, ' ').trim();
  });
  return { count, examples };
});
