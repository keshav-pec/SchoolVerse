import { REPORT_TITLES, VERSION_PHASE_LABELS, WEEKDAYS, WEEKDAY_LABELS, type ReportColumnDTO, type ReportQuery, type ReportType, type TimetableReportDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import { User } from '../../../platform/users/user.model';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { recordTimetableAudit } from '../audit';
import { allowedTeachers } from '../engine/check';
import { coverageRows } from '../engine/coverage';
import { addDays, niceDate } from '../engine/effective';
import { namerOf, plural, tagLabel } from '../engine/messages';
import { loadSnapshot } from '../engine/snapshot';
import type { Snapshot } from '../engine/types';
import { teacherWorkload } from '../engine/workload';
import { readablePlan } from '../guards';
import { ConflictOverride, TimetableVersion, type ConflictOverrideDoc, type TimetablePlanDoc, type TimetableVersionDoc } from '../models';
import { listOverrides } from './override.service';
import { validateSnapshot } from './publish.service';
import { canReadDrafts, phaseOf } from './version.service';

/**
 * TT-45 to 47 — seven reports. Each names the version and the dates it is based on, so two people reading it see the same numbers.
 * Everything is worked out from the published lessons and one-day changes; nothing is stored for a report.
 */

const col = (key: string, label: string, align: ReportColumnDTO['align'] = 'left'): ReportColumnDTO => ({ key, label, align });
type Row = Record<string, string | number | null>;

/** The version a report is about: the one asked for, else the one running today, else the one starting next, else the latest published. */
async function reportVersion(ctx: ServiceContext, plan: TimetablePlanDoc, versionId: string | undefined, today: string): Promise<TimetableVersionDoc | null> {
  if (versionId) {
    const v = await TimetableVersion.findOne({ _id: versionId, tenantId: ctx.tenantId, planId: plan._id }).lean<TimetableVersionDoc>();
    if (!v || (v.status !== 'PUBLISHED' && !canReadDrafts(ctx))) throw AppError.notFound('Timetable version not found.');
    return v;
  }
  const published = await TimetableVersion.find({ tenantId: ctx.tenantId, planId: plan._id, status: 'PUBLISHED' }).sort({ effectiveFrom: -1 }).lean<TimetableVersionDoc[]>();
  return published.find((v) => (v.effectiveFrom ?? '') <= today && today <= (v.effectiveTo ?? '9999')) ?? [...published].reverse().find((v) => (v.effectiveFrom ?? '') > today) ?? published[0] ?? null;
}

export const basisLine = (v: Pick<TimetableVersionDoc, 'versionName' | 'status' | 'effectiveFrom' | 'effectiveTo'>, today: string) => `${v.versionName} · ${VERSION_PHASE_LABELS[phaseOf(v, today)]}${v.effectiveFrom ? ` · from ${niceDate(v.effectiveFrom)}` : ''}`;

const weekSlots = (snap: Snapshot) => {
  const template = snap.plan.defaultBellScheduleId ?? [...snap.bell.templates.keys()][0];
  return snap.plan.operatingDays.length * [...snap.periods.values()].filter((p) => p.templateId === template && p.schedulable).length;
};

async function rowsFor(ctx: ServiceContext, plan: TimetablePlanDoc, version: TimetableVersionDoc, type: ReportType, q: ReportQuery, today: string): Promise<{ columns: ReportColumnDTO[]; rows: Row[]; dateFrom: string | null; dateTo: string | null }> {
  const none = { dateFrom: null, dateTo: null };
  if (type === 'substitution-history') {
    const dateFrom = q.dateFrom ?? `${today.slice(0, 7)}-01`;
    const dateTo = q.dateTo ?? addDays(dateFrom, 30);
    const [active, cancelled] = await Promise.all([listOverrides(ctx, { planId: plan._id, type: 'SUBSTITUTE_FACULTY', status: 'ACTIVE', dateFrom, dateTo }), listOverrides(ctx, { planId: plan._id, type: 'SUBSTITUTE_FACULTY', status: 'CANCELLED', dateFrom, dateTo })]);
    return {
      dateFrom,
      dateTo,
      columns: [col('date', 'Date'), col('lesson', 'Lesson'), col('when', 'Period'), col('original', 'Away'), col('substitute', 'Covered by'), col('reason', 'Reason'), col('by', 'Entered by'), col('status', 'Status')],
      rows: [...active, ...cancelled]
        .filter((o) => !q.employeeId || o.substitutes.some((s) => s.employeeId === q.employeeId) || o.original.some((s) => s.employeeId === q.employeeId))
        .sort((a, b) => a.date.localeCompare(b.date) || a.when.localeCompare(b.when))
        .map((o) => ({ date: o.date, lesson: o.label, when: o.when, original: o.original.map((t) => t.fullName).join(', '), substitute: o.substitutes.map((t) => t.fullName).join(', '), reason: o.reason, by: o.createdBy, status: o.status === 'ACTIVE' ? 'In place' : 'Cancelled' })),
    };
  }
  const snap = await loadSnapshot(ctx, plan, version);
  const n = namerOf(snap);
  switch (type) {
    case 'section-coverage': {
      const v = validateSnapshot(snap, version.rev);
      return { ...none, columns: [col('section', 'Section'), col('needed', 'Needed', 'right'), col('placed', 'Placed', 'right'), col('left', 'Left', 'right'), col('over', 'Extra', 'right'), col('status', 'Status')], rows: [...v.sections].sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true })).map((s) => ({ section: s.label, needed: s.needed, placed: s.placed, left: s.left, over: s.over, status: s.empty ? 'Nothing placed' : s.left > 0 ? `${plural(s.left, 'period')} missing` : 'Complete' })) };
    }
    case 'subject-coverage': {
      const by = new Map<string, { klass: string; subject: string; sections: Set<string>; needed: number; placed: number; left: number }>();
      for (const r of coverageRows(snap)) {
        const klass = r.sectionOfferingId ? (snap.facts.classOf.get(snap.facts.sectionOf.get(r.sectionOfferingId)?.classOfferingId ?? '')?.displayCode ?? '') : 'Groups';
        const key = `${klass}|${r.subjectName}`;
        const row = by.get(key) ?? { klass, subject: r.subjectName, sections: new Set<string>(), needed: 0, placed: 0, left: 0 };
        row.sections.add(r.sectionOfferingId ?? r.teachingGroupId ?? '');
        row.needed += r.needed;
        row.placed += Math.min(r.placed, r.needed);
        row.left += r.left;
        by.set(key, row);
      }
      return { ...none, columns: [col('class', 'Class'), col('subject', 'Subject'), col('sections', 'Sections', 'right'), col('needed', 'Needed', 'right'), col('placed', 'Placed', 'right'), col('left', 'Left', 'right')], rows: [...by.values()].sort((a, b) => a.klass.localeCompare(b.klass, 'en', { numeric: true }) || a.subject.localeCompare(b.subject)).map((r) => ({ class: r.klass, subject: r.subject, sections: r.sections.size, needed: r.needed, placed: r.placed, left: r.left })) };
    }
    case 'teacher-workload': {
      const rows = [...snap.campusTeachers].map((id) => {
        const w = teacherWorkload(snap, id);
        const sections = new Set(WEEKDAYS.flatMap((d) => snap.board.ofTeacher(id, d).flatMap((e) => e.sectionIds)));
        return { teacher: w.fullName, week: w.week, ...Object.fromEntries(snap.plan.operatingDays.map((d) => [d, w.perDay[d] ?? 0])), longest: w.longestRun, free: Object.values(w.freePeriodsPerDay).reduce((a, b) => a + (b ?? 0), 0), sections: sections.size, limit: w.limits.maxPerWeek } satisfies Row;
      });
      return {
        ...none,
        columns: [col('teacher', 'Teacher'), col('week', 'Periods a week', 'right'), ...snap.plan.operatingDays.map((d) => col(d, WEEKDAY_LABELS[d].slice(0, 3), 'right')), col('longest', 'Longest run', 'right'), col('free', 'Free periods', 'right'), col('sections', 'Sections', 'right'), col('limit', 'Weekly limit', 'right')],
        rows: rows.sort((a, b) => String(a.teacher).localeCompare(String(b.teacher), 'en', { sensitivity: 'base' })),
      };
    }
    case 'room-utilization': {
      const slots = weekSlots(snap);
      const rows = [...snap.rooms.values()].map((room) => {
        const booked = WEEKDAYS.reduce((c, d) => c + snap.board.ofRoom(room.spaceId, d).length, 0);
        return { room: room.spaceName, booked, free: Math.max(0, slots - booked), percent: slots > 0 ? Math.round((booked / slots) * 100) : 0, capacity: room.capacity, kinds: room.tags.filter((t) => t !== 'GENERAL_TEACHING').map(tagLabel).join(', ') || 'General' } satisfies Row;
      });
      return { ...none, columns: [col('room', 'Room'), col('booked', 'Booked', 'right'), col('free', 'Free', 'right'), col('percent', 'Used %', 'right'), col('capacity', 'Seats', 'right'), col('kinds', 'Kinds')], rows: rows.sort((a, b) => Number(b.percent) - Number(a.percent) || String(a.room).localeCompare(String(b.room), 'en', { numeric: true })) };
    }
    case 'unplaced-requirements': {
      const rows = coverageRows(snap)
        .filter((r) => r.left > 0)
        .map((r) => {
          const teachers = allowedTeachers(snap, { groupId: r.teachingGroupId, sectionIds: r.sectionOfferingId ? [r.sectionOfferingId] : [], subjectOfferingId: r.subjectOfferingId });
          return { lesson: r.sectionLabel ?? r.groupName ?? '', subject: r.subjectName, needed: r.needed, placed: r.placed, left: r.left, why: teachers.length === 0 ? 'No teacher is assigned' : teachers.length > 1 ? 'Two teachers match: pick one' : 'No free time where the teacher, section and room are all free' } satisfies Row;
        });
      return { ...none, columns: [col('lesson', 'Section or group'), col('subject', 'Subject'), col('needed', 'Needed', 'right'), col('placed', 'Placed', 'right'), col('left', 'Left', 'right'), col('why', 'Why')], rows: rows.sort((a, b) => String(a.lesson).localeCompare(String(b.lesson), 'en', { numeric: true }) || String(a.subject).localeCompare(String(b.subject))) };
    }
    case 'conflict-overrides': {
      const docs = await ConflictOverride.find({ tenantId: ctx.tenantId, versionId: version._id }).lean<ConflictOverrideDoc[]>();
      const users = await User.find({ tenantId: ctx.tenantId, _id: { $in: docs.map((d) => d.byUserId) } }).select('fullName').lean<{ _id: string; fullName: string }[]>();
      const nameOf = new Map(users.map((u) => [u._id, u.fullName]));
      const rows = docs.flatMap((d) => {
        const e = snap.board.get(d.entryId);
        return e ? [{ lesson: n.lesson(e), when: n.when(e.weekday, e.periodId), rule: d.rule.replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase()), reason: d.reason, by: nameOf.get(d.byUserId) ?? 'Someone', on: d.at.toISOString().slice(0, 10) } satisfies Row] : [];
      });
      return { ...none, columns: [col('lesson', 'Lesson'), col('when', 'When'), col('rule', 'Clash accepted'), col('reason', 'Reason'), col('by', 'Accepted by'), col('on', 'On')], rows: rows.sort((a, b) => String(a.on).localeCompare(String(b.on)) || String(a.lesson).localeCompare(String(b.lesson))) };
    }
    default:
      throw AppError.notFound('Report not found.');
  }
}

export async function runReport(ctx: ServiceContext, type: ReportType, q: ReportQuery): Promise<TimetableReportDTO> {
  const plan = await readablePlan(ctx, q.planId);
  const today = await todayFor(ctx);
  const version = await reportVersion(ctx, plan, q.versionId, today);
  const head = { type, title: REPORT_TITLES[type], planId: plan._id };
  if (!version) return { ...head, versionId: null, versionName: null, effectiveFrom: null, effectiveTo: null, dateFrom: null, dateTo: null, basis: 'No published timetable yet', columns: [], rows: [], message: 'There is no published timetable yet, so there is nothing to report. Publish one first.' };
  const body = await rowsFor(ctx, plan, version, type, q, today);
  const range = body.dateFrom && body.dateTo ? ` · ${niceDate(body.dateFrom)} to ${niceDate(body.dateTo)}` : '';
  return { ...head, versionId: version._id, versionName: version.versionName, effectiveFrom: version.effectiveFrom, effectiveTo: version.effectiveTo, ...body, basis: `${basisLine(version, today)}${range}`, message: body.rows.length === 0 ? 'Nothing to show for this report.' : null };
}

// ───────────────────────────────────────────────────────────── csv

/** A cell that starts with = + - @ would run as a formula in a spreadsheet, so it gets a leading quote. */
const cell = (v: string | number | null) => {
  const text = v === null ? '' : String(v);
  const safe = /^[=+\-@\t\r]/.test(text) && Number.isNaN(Number(text)) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** The report as CSV. Exports are written to the audit trail. */
export async function reportCsv(ctx: ServiceContext, type: ReportType, q: ReportQuery): Promise<{ csv: string; fileName: string }> {
  const report = await runReport(ctx, type, q);
  const plan = await readablePlan(ctx, q.planId);
  await withTransaction((db) => recordTimetableAudit(ctx, db, { entityType: 'timetable_report', entityId: plan._id, action: 'timetable_report.exported', planId: plan._id, locationId: plan.locationId, metadata: { type, versionId: report.versionId, rows: report.rows.length, format: 'csv' } }));
  const lines = [[`${report.title} - ${report.basis}`].map(cell).join(','), report.columns.map((c) => cell(c.label)).join(','), ...report.rows.map((r) => report.columns.map((c) => cell(r[c.key] ?? null)).join(','))];
  return { csv: `${lines.join('\r\n')}\r\n`, fileName: `timetable-${type}-${plan.effectiveFrom}.csv` };
}
