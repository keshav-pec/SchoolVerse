import { VERSION_PHASE_LABELS, type TimetableOverviewDTO } from '@shared';
import type { OverviewQuery } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { allowedTeachers, neededTags } from '../engine/check';
import { niceDate } from '../engine/effective';
import { needItems } from '../engine/coverage';
import { loadSnapshot } from '../engine/snapshot';
import { assertInScope, timetableScope } from '../guards';
import { ChangeSet, GenerationRun, Requirement, TimetablePlan, TimetableVersion, type GenerationRunDoc, type TimetablePlanDoc, type TimetableVersionDoc } from '../models';
import { dailySchedule } from './daily.service';
import { validateSnapshot } from './publish.service';
import { canReadDrafts, phaseOf } from './version.service';

/** TT-UX-21 — the numbers on the Timetable home page: what state the plan is in, how complete it is, what is wrong today, and how much of it the system did. */

const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : null);

export async function overview(ctx: ServiceContext, q: OverviewQuery): Promise<TimetableOverviewDTO> {
  const scope = await timetableScope(ctx);
  await assertInScope(ctx, scope, q.locationId, 'timetable_overview', q.locationId);
  const today = await todayFor(ctx);
  const plans = await TimetablePlan.find({ tenantId: ctx.tenantId, locationId: q.locationId, status: { $ne: 'ARCHIVED' }, ...(q.academicSessionId ? { academicSessionId: q.academicSessionId } : {}) }).lean<TimetablePlanDoc[]>();
  const plan = plans.find((p) => p.effectiveFrom <= today && today <= p.effectiveTo) ?? plans.sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
  const blank: TimetableOverviewDTO = {
    planId: null,
    locationId: q.locationId,
    planStatus: null,
    versionId: null,
    versionName: null,
    phase: null,
    statusLine: 'No timetable plan yet',
    publishedVersionId: null,
    draftVersionId: null,
    coveragePercent: null,
    needed: 0,
    placed: 0,
    clashes: 0,
    warnings: 0,
    today: null,
    next: 'SETUP',
    ux: { inheritedPercent: null, autoTeacherPercent: null, defaultRoomPercent: null, smartDraftCompletionPercent: null, manualPercent: null, unresolved: 0, lastYearReusePercent: null, fixesApplied: 0 },
  };
  if (!plan) return blank;

  const versions = await TimetableVersion.find({ tenantId: ctx.tenantId, planId: plan._id, status: { $ne: 'DISCARDED' } }).sort({ versionNumber: -1 }).lean<TimetableVersionDoc[]>();
  const drafts = canReadDrafts(ctx);
  const draft = drafts ? versions.find((v) => v.isOpen) : undefined;
  const published = versions.filter((v) => v.status === 'PUBLISHED');
  const running = published.find((v) => phaseOf(v, today) === 'ACTIVE') ?? published.find((v) => phaseOf(v, today) === 'UPCOMING') ?? published[0];
  const shown = draft ?? running;
  const base = { ...blank, planId: plan._id, planStatus: plan.status, publishedVersionId: running?._id ?? null, draftVersionId: draft?._id ?? null };
  if (!shown) return { ...base, statusLine: 'No timetable yet', next: 'OPEN_SCHEDULE' };

  const phase = phaseOf(shown, today);
  const statusLine = `${shown.versionName} · ${VERSION_PHASE_LABELS[phase]}${shown.status === 'PUBLISHED' && shown.effectiveFrom ? ` · from ${niceDate(shown.effectiveFrom)}` : ''}`;
  const snap = await loadSnapshot(ctx, plan, shown);
  const check = validateSnapshot(snap, shown.rev);
  const needed = check.sections.reduce((c, s) => c + s.needed, 0) + 0;
  const placed = check.sections.reduce((c, s) => c + s.placed, 0);

  // How much the system did, from the lessons themselves.
  const lessons = snap.board.all();
  const subject = lessons.filter((e) => e.entryType === 'SUBJECT');
  const single = subject.filter((e) => !e.groupId && e.sectionIds.length === 1);
  const needItemsCount = needItems(snap).length;
  const sectionRows = await Requirement.countDocuments({ tenantId: ctx.tenantId, planId: plan._id, scope: 'SECTION' });
  const runs = await GenerationRun.find({ tenantId: ctx.tenantId, versionId: shown._id, runType: 'SMART_DRAFT' }).lean<GenerationRunDoc[]>();
  const draftedTotal = Math.max(0, ...runs.map((r) => r.totalPeriods));
  const ux: TimetableOverviewDTO['ux'] = {
    inheritedPercent: needItemsCount > 0 ? Math.max(0, Math.round(((needItemsCount - sectionRows) / needItemsCount) * 100)) : null,
    autoTeacherPercent: pct(subject.filter((e) => e.teachers.length === 1 && allowedTeachers(snap, e).length === 1 && allowedTeachers(snap, e)[0] === e.teachers[0]!.employeeId).length, subject.length),
    defaultRoomPercent: pct(single.filter((e) => neededTags(snap, e).length === 0 && e.spaceId !== null && e.spaceId === snap.homeRoom.get(e.sectionIds[0]!)).length, single.filter((e) => neededTags(snap, e).length === 0).length),
    smartDraftCompletionPercent: draftedTotal > 0 ? pct(Math.min(draftedTotal, runs.reduce((c, r) => c + r.entriesCreated, 0)), draftedTotal) : null,
    manualPercent: pct(lessons.filter((e) => e.source === 'MANUAL' || e.source === 'BULK').length, lessons.length),
    unresolved: check.unplacedCount,
    lastYearReusePercent: pct(lessons.filter((e) => e.source === 'PREVIOUS_SESSION_COPY').length, lessons.length),
    fixesApplied: await ChangeSet.countDocuments({ tenantId: ctx.tenantId, versionId: shown._id, kind: 'FIX' }),
  };

  let todayBlock: TimetableOverviewDTO['today'] = null;
  if (running && phaseOf(running, today) === 'ACTIVE') {
    const day = await dailySchedule(ctx, { planId: plan._id, date: today });
    todayBlock = { date: today, uncovered: day.summary.uncovered, absentTeachers: day.exceptions.filter((e) => e.kind === 'ABSENT').length, cancelled: day.summary.cancelled, substituted: day.summary.substituted };
  }
  const next: TimetableOverviewDTO['next'] = draft ? (lessons.length > 0 ? 'REVIEW_AND_PUBLISH' : 'OPEN_SCHEDULE') : 'OPEN_DAILY_OPERATIONS';
  return { ...base, versionId: shown._id, versionName: shown.versionName, phase, statusLine, coveragePercent: pct(placed, needed), needed, placed, clashes: check.clashCount, warnings: check.warningCount, today: todayBlock, next, ux };
}
