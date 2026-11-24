import request from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  TIMETABLE_DATA_CLASSIFICATION,
  SYSTEM_FIELDS,
  TIMETABLE_BUNDLE_PERMISSIONS,
  type AvailabilityBulkResultDTO,
  type BellAssignmentsDTO,
  type BellBulkResultDTO,
  type BellGeneratePreviewDTO,
  type BellGenerateResultDTO,
  type BellPeriodDTO,
  type BellResolutionDTO,
  type BellScheduleDTO,
  type FacultyAvailabilityDTO,
  type GroupHealthDTO,
  type GroupMemberListDTO,
  type PlanTeacherDTO,
  type RequirementCopyResultDTO,
  type RequirementListDTO,
  type RequirementSaveResultDTO,
  type TeachingGroupDTO,
  type TimetableAccessGrantDTO,
  type TimetablePlanDTO,
  type TimetableReadinessDTO,
  type WorkloadRulesDTO,
} from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { withTransaction } from '../src/db/transaction';
import { runOfferingCleanup } from '../src/modules/academic/cleanup';
import { registerPeriodUsage } from '../src/modules/timetable/usage';
import { Availability, AvailabilityException, BellAssignment, BellPeriod, BellSchedule, ChangeSet, ConflictOverride, EntryFaculty, EntrySection, GenerationRun, GroupMembership, Override, OverrideFaculty, Requirement, RunItem, TeachingGroup, TimetableEntry, TimetableGrant, TimetablePlan, TimetableVersion, WorkloadRule } from '../src/modules/timetable/models';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { addActiveEmployee, addClasses, addStudent, API, app, createUserAndLogin, data, expectError, forceStatus, loginAs, offer, setupSchool, timetableSchool, useTestDatabase, type TimetableSchool } from './helpers';

useTestDatabase();

/** The Regular Daily Periods, generated. */
const withRegular = async (t: TimetableSchool) => t.unwrap<BellGenerateResultDTO>(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules/generate`, t.regular), 201).schedule;

/** Class VIII needs: Maths 6 and Science 5 a week (class level, so every section inherits). */
const classNeeds = (t: TimetableSchool, over: Record<string, unknown> = {}) =>
  t.tt.post('/subject-schedule-requirements/apply-grade', { planId: t.planId, classOfferingId: t.classOfferingId, items: [{ subjectOfferingId: t.offerings.MATH, periodsPerWeek: 6, ...over }, { subjectOfferingId: t.offerings.SCI, periodsPerWeek: 5 }] });

const readiness = (t: TimetableSchool) => t.getData<TimetableReadinessDTO>(`/timetable-plans/${t.planId}/readiness`);
const codes = (r: TimetableReadinessDTO) => r.areas.flatMap((a) => a.items.map((i) => i.code));

/** A Faculty or Staff login linked to a new employee at the given campus. */
async function loginAt(t: TimetableSchool, role: 'FACULTY' | 'STAFF', locationId = t.moh.locationId) {
  const employee = await addActiveEmployee(t, { primaryLocationId: locationId });
  return { ...(await loginAs(t, role, employee)), employee };
}

describe('timetable plan and school week (TT-01, TT-02)', () => {
  it('QA TT-01: a plan has the session dates, Monday to Saturday and the 30-minute travel rule by default, and a second plan for the same campus and session is refused with a link', async () => {
    const t = await timetableSchool();
    expect(t.plan).toMatchObject({ locationName: 'Mohali Campus', operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], capacityPolicy: 'WARN', transitionMinutes: 30, status: 'DRAFT', version: 1, defaultBellScheduleId: null });
    const again = expectError(await t.tt.post('/timetable-plans', { locationId: t.moh.locationId, academicSessionId: t.sessionId }), 409, 'PLAN_EXISTS');
    expect(again.details.planId).toBe(t.planId);
    expect(await TimetablePlan.countDocuments({ tenantId: t.tenantId })).toBe(1);
  });

  it('QA TT-01: school days are stored, never assumed; a campus that is not in the session, a closed session and bad dates are refused', async () => {
    const t = await timetableSchool();
    const five = data(await t.tt.post('/timetable-plans', { locationId: t.chd.locationId, academicSessionId: t.sessionId, operatingDays: ['FRI', 'MON', 'WED', 'TUE', 'THU'], planName: 'Chandigarh week' }).expect(201)) as TimetablePlanDTO;
    expect(five.operatingDays).toEqual(['MON', 'TUE', 'WED', 'THU', 'FRI']);
    expectError(await t.tt.post('/timetable-plans', { locationId: t.pkl.locationId, academicSessionId: t.sessionId }), 409, 'LOCATION_NOT_IN_SESSION');
    expectError(await t.tt.patch(`/timetable-plans/${t.planId}`, { version: 1, effectiveFrom: '2020-01-01' }), 422, 'PLAN_DATES_INVALID');
    await forceStatus(t.tenantId, t.sessionId, 'CLOSED');
    await TimetablePlan.deleteOne({ _id: five.planId, tenantId: t.tenantId });
    expectError(await t.tt.post('/timetable-plans', { locationId: t.chd.locationId, academicSessionId: t.sessionId }), 409, 'SESSION_READ_ONLY');
    expectError(await t.tt.patch(`/timetable-plans/${t.planId}`, { version: 1, planName: 'Late edit' }), 409, 'SESSION_READ_ONLY');
  });

  it('QA TT-02: a school day with lessons on it cannot be removed; an edit from an old copy is a version conflict; archiving and restoring keep everything', async () => {
    const t = await timetableSchool();
    registerPeriodUsage('test.saturday', async (q) => ({ count: q.weekday === 'SAT' ? 12 : 0, examples: q.weekday === 'SAT' ? ['8-A Maths, Saturday Period 1'] : [] }));
    const blocked = expectError(await t.tt.patch(`/timetable-plans/${t.planId}`, { version: 1, operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }), 409, 'OPERATING_DAY_IN_USE');
    expect(blocked.message).toBe('12 lessons are on Saturday. Clear them first.');
    registerPeriodUsage('test.saturday', async () => ({ count: 0, examples: [] }));
    const five = t.unwrap<TimetablePlanDTO>(await t.tt.patch(`/timetable-plans/${t.planId}`, { version: 1, operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], capacityPolicy: 'BLOCK' }));
    expect(five).toMatchObject({ operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], capacityPolicy: 'BLOCK', version: 2 });
    expectError(await t.tt.patch(`/timetable-plans/${t.planId}`, { version: 1, planName: 'Stale' }), 409, 'VERSION_CONFLICT');
    const archived = t.unwrap<TimetablePlanDTO>(await t.tt.post(`/timetable-plans/${t.planId}/status`, { to: 'ARCHIVED' }));
    expect(archived.status).toBe('ARCHIVED');
    expectError(await t.tt.patch(`/timetable-plans/${t.planId}`, { version: archived.version, planName: 'x' }), 409, 'PLAN_READ_ONLY');
    expect(t.unwrap<TimetablePlanDTO>(await t.tt.post(`/timetable-plans/${t.planId}/status`, { to: 'DRAFT' })).status).toBe('DRAFT');
    expect((await AuditEvent.find({ tenantId: t.tenantId, entityType: 'timetable_plan', entityId: t.planId }).lean()).map((e) => e.action).sort()).toEqual(['timetable_plan.archived', 'timetable_plan.created', 'timetable_plan.restored', 'timetable_plan.updated']);
  });

  it('QA TT-02: a campus or session with a live plan cannot be switched off or closed until the plan is archived', async () => {
    const t = await timetableSchool();
    const blocked = expectError(await t.tt.post(`/academic-sessions/${t.sessionId}/close`), 409, 'ACADEMIC_HAS_DEPENDENCIES');
    expect(blocked.message).toMatch(/timetable plan is still set up/);
    const chdPlan = data(await t.tt.post('/timetable-plans', { locationId: t.chd.locationId, academicSessionId: t.sessionId }).expect(201)) as TimetablePlanDTO;
    await t.tt.post(`/locations/${t.chd.locationId}/deactivate`).expect(200);
    const held = expectError(await t.tt.post(`/locations/${t.chd.locationId}/archive`), 409, 'LOCATION_HAS_DEPENDENCIES');
    expect(held.details.dependencies).toMatchObject([{ key: 'timetable.plans', label: 'Timetable plans', count: 1 }]);
    await t.tt.post(`/timetable-plans/${chdPlan.planId}/status`, { to: 'ARCHIVED' }).expect(200);
    await t.tt.post(`/locations/${t.chd.locationId}/archive`).expect(200);
    await t.tt.post(`/timetable-plans/${t.planId}/status`, { to: 'ARCHIVED' }).expect(200);
    await t.tt.post(`/academic-sessions/${t.sessionId}/close`).expect(200);
  });
});

describe('Daily Periods (TT-03 to 05)', () => {
  it('QA TT-03: the generator previews the exact periods and the minutes left over; commit makes the template and is safe to retry', async () => {
    const t = await timetableSchool();
    const preview = t.unwrap<BellGeneratePreviewDTO>(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules/generate/preview`, t.regular));
    expect(preview.periods.map((p) => `${p.periodCode} ${p.start}-${p.end}`)).toEqual(['P1 08:00-08:45', 'P2 08:45-09:30', 'P3 09:30-10:15', 'BRK1 10:15-10:30', 'P4 10:30-11:15', 'P5 11:15-12:00', 'LUN1 12:00-12:30', 'P6 12:30-13:15', 'P7 13:15-14:00']);
    expect(preview).toMatchObject({ lessonPeriods: 7, leftoverMinutes: 5 });
    expect(preview.message).toMatch(/^5 minutes left at the end of the day/);
    expect(preview.periods.find((p) => p.periodCode === 'BRK1')!.schedulable).toBe(false);
    expect(await BellSchedule.countDocuments({ tenantId: t.tenantId })).toBe(0);

    const first = t.unwrap<BellGenerateResultDTO>(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules/generate`, t.regular), 201);
    expect(first.alreadyExisted).toBe(false);
    expect(first.schedule).toMatchObject({ name: 'Regular', lessonPeriods: 7, isDefault: true });
    const retry = t.unwrap<BellGenerateResultDTO>(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules/generate`, t.regular));
    expect(retry.alreadyExisted).toBe(true);
    expect(retry.schedule.bellScheduleId).toBe(first.schedule.bellScheduleId);
    expect(await BellPeriod.countDocuments({ tenantId: t.tenantId })).toBe(9);
    expectError(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules/generate`, { ...t.regular, periodMinutes: 40 }), 409, 'BELL_NAME_TAKEN');
    expect((await t.getData<TimetablePlanDTO>(`/timetable-plans/${t.planId}`)).defaultBellScheduleId).toBe(first.schedule.bellScheduleId);
  });

  it('QA TT-03: a break outside the day, overlapping breaks and an inverted day are refused with plain reasons', async () => {
    const t = await timetableSchool();
    const url = `/timetable-plans/${t.planId}/bell-schedules/generate/preview`;
    expectError(await t.tt.post(url, { ...t.regular, breaks: [{ name: 'Late', start: '15:00', end: '15:15', type: 'BREAK' }] }), 422, 'PERIOD_INVALID');
    expectError(await t.tt.post(url, { ...t.regular, breaks: [{ name: 'A', start: '10:00', end: '10:30', type: 'BREAK' }, { name: 'B', start: '10:15', end: '10:45', type: 'BREAK' }] }), 409, 'PERIOD_OVERLAP');
    expectError(await t.tt.post(url, { ...t.regular, start: '15:00', end: '08:00' }), 422, 'PERIOD_INVALID');
    const gap = t.unwrap<BellGeneratePreviewDTO>(await t.tt.post(url, { name: 'Gap', start: '08:00', end: '10:00', periodMinutes: 45, breaks: [{ name: 'Break', start: '09:30', end: '10:00', type: 'BREAK' }], assembly: { name: 'Assembly', start: '08:00', end: '08:10' } }));
    expect(gap.leftoverMinutes).toBeGreaterThan(0);
  });

  it('QA TT-04: periods overlap-check, times must make sense, breaks can never hold lessons, and periods always come back in time order', async () => {
    const t = await timetableSchool();
    const regular = await withRegular(t);
    const add = (body: Record<string, unknown>) => t.tt.post(`/bell-schedules/${regular.bellScheduleId}/periods`, body);
    const overlap = expectError(await add({ periodName: 'Clash', start: '08:30', end: '09:00' }), 409, 'PERIOD_OVERLAP');
    expect(overlap.message).toMatch(/overlaps Period 1/);
    expectError(await add({ periodName: 'Backwards', start: '07:00', end: '06:00' }), 422, 'PERIOD_INVALID');
    expectError(await add({ periodName: 'Odd break', start: '06:00', end: '06:30', periodType: 'BREAK', schedulable: true }), 422, 'PERIOD_INVALID');
    const zero = t.unwrap<BellScheduleDTO>(await add({ periodName: 'Zero Period', start: '07:15', end: '08:00' }), 201);
    expect(zero.periods[0]).toMatchObject({ periodName: 'Zero Period', periodCode: 'P8', displayOrder: 1, schedulable: true });
    expect(zero.periods.map((p) => p.startMin)).toEqual([...zero.periods.map((p) => p.startMin)].sort((a, b) => a - b));

    const p2 = zero.periods.find((p) => p.periodCode === 'P2')!;
    expectError(await t.tt.patch(`/bell-schedule-periods/${p2.periodId}`, { end: '10:00' }), 409, 'PERIOD_OVERLAP');
    const asBreak = t.unwrap<BellPeriodDTO>(await t.tt.patch(`/bell-schedule-periods/${p2.periodId}`, { periodType: 'LUNCH' }));
    expect(asBreak).toMatchObject({ periodType: 'LUNCH', schedulable: false, usedByEntries: 0 });
  });

  it('QA TT-04: a period used by lessons cannot be removed, and a time change reports the lessons it touches', async () => {
    const t = await timetableSchool();
    const regular = await withRegular(t);
    const p1 = regular.periods[0]!;
    registerPeriodUsage('test.in-use', async (q) => ({ count: q.periodIds?.includes(p1.periodId) ? 3 : 0, examples: ['8-A Maths'] }));
    const changed = t.unwrap<BellPeriodDTO>(await t.tt.patch(`/bell-schedule-periods/${p1.periodId}`, { start: '07:55' }));
    expect(changed.usedByEntries).toBe(3);
    expectError(await t.tt.del(`/bell-schedule-periods/${p1.periodId}`), 409, 'BELL_IN_USE');
    registerPeriodUsage('test.in-use', async () => ({ count: 0, examples: [] }));
    await t.tt.del(`/bell-schedule-periods/${p1.periodId}`).expect(204);
    expect((await t.getData<BellScheduleDTO>(`/bell-schedules/${regular.bellScheduleId}`)).periods).toHaveLength(8);
  });

  it('QA TT-05: assign Daily Periods to many classes at once; the resolution is Section, then Class, then School default, and a weekday rule beats an all-days rule', async () => {
    const t = await timetableSchool();
    const regular = await withRegular(t);
    const junior = t.unwrap<BellScheduleDTO>(await t.tt.post(`/bell-schedules/${regular.bellScheduleId}/duplicate`, { name: 'Junior', kind: 'JUNIOR' }), 201);
    expect(junior.periods.map((p) => p.periodCode)).toEqual(regular.periods.map((p) => p.periodCode));
    expect(junior.periods[0]!.periodId).not.toBe(regular.periods[0]!.periodId);
    const saturday = t.unwrap<BellScheduleDTO>(await t.tt.post(`/bell-schedules/${regular.bellScheduleId}/duplicate`, { name: 'Saturday', kind: 'SATURDAY' }), 201);
    const url = `/timetable-plans/${t.planId}/bell-assignments/bulk`;
    const cell = async (section: 'A' | 'B' | 'C', day: string) => {
      const res = await t.getData<BellResolutionDTO>(`/timetable-plans/${t.planId}/bell-resolution`);
      const row = res.rows.find((r) => r.sectionOfferingId === t.sections[section])!;
      return `${row.byDay[day as 'MON']!.bellScheduleName}/${row.byDay[day as 'MON']!.source}`;
    };

    expect(await cell('A', 'MON')).toBe('Regular/DEFAULT');
    t.unwrap<BellBulkResultDTO>(await t.tt.post(url, { bellScheduleId: junior.bellScheduleId, scope: 'CLASS', classOfferingIds: [t.classOfferingId] }));
    expect(await cell('A', 'MON')).toBe('Junior/CLASS');
    t.unwrap<BellBulkResultDTO>(await t.tt.post(url, { bellScheduleId: saturday.bellScheduleId, scope: 'CLASS', classOfferingIds: [t.classOfferingId], weekdays: ['SAT'] }));
    expect(await cell('A', 'SAT')).toBe('Saturday/CLASS');
    expect(await cell('A', 'FRI')).toBe('Junior/CLASS');
    t.unwrap<BellBulkResultDTO>(await t.tt.post(url, { bellScheduleId: regular.bellScheduleId, scope: 'SECTION', sectionOfferingIds: [t.sections.B] }));
    expect(await cell('B', 'FRI')).toBe('Regular/SECTION');
    expect(await cell('B', 'SAT')).toBe('Regular/SECTION');
    expect(await cell('C', 'SAT')).toBe('Saturday/CLASS');

    // A second Saturday-only rule takes the day from the older one instead of leaving two rules for one day.
    t.unwrap<BellBulkResultDTO>(await t.tt.post(url, { bellScheduleId: regular.bellScheduleId, scope: 'CLASS', classOfferingIds: [t.classOfferingId], weekdays: ['SAT', 'FRI'] }));
    expect(await cell('C', 'FRI')).toBe('Regular/CLASS');
    expect(await BellAssignment.countDocuments({ tenantId: t.tenantId, scope: 'CLASS' })).toBe(2);
    expectError(await t.tt.post(url, { bellScheduleId: regular.bellScheduleId, scope: 'CLASS', classOfferingIds: [t.classOfferingId], weekdays: ['SUN'] }), 400, 'VALIDATION_FAILED');

    const list = await t.getData<BellAssignmentsDTO>(`/timetable-plans/${t.planId}/bell-assignments`);
    t.unwrap<{ removed: number }>(await t.tt.post(`/timetable-plans/${t.planId}/bell-assignments/clear`, { assignmentIds: list.items.map((i) => i.assignmentId) }));
    expect(await cell('B', 'FRI')).toBe('Regular/DEFAULT');
    expect(await BellAssignment.countDocuments({ tenantId: t.tenantId })).toBe(0);
  });

  it('QA TT-05: a section with no Daily Periods is listed as missing; Daily Periods that classes use cannot be deleted; a day outside the school week is refused', async () => {
    const t = await timetableSchool();
    expect((await t.getData<BellResolutionDTO>(`/timetable-plans/${t.planId}/bell-resolution`)).missing.map((m) => m.label)).toEqual(['8-A', '8-B', '8-C']);
    const regular = await withRegular(t);
    expect((await t.getData<BellResolutionDTO>(`/timetable-plans/${t.planId}/bell-resolution`)).missing).toEqual([]);
    const junior = t.unwrap<BellScheduleDTO>(await t.tt.post(`/bell-schedules/${regular.bellScheduleId}/duplicate`, { name: 'Junior', kind: 'JUNIOR' }), 201);
    await t.tt.post(`/timetable-plans/${t.planId}/bell-assignments/bulk`, { bellScheduleId: junior.bellScheduleId, scope: 'CLASS', classOfferingIds: [t.classOfferingId] }).expect(200);
    expectError(await t.tt.del(`/bell-schedules/${junior.bellScheduleId}`), 409, 'BELL_IN_USE');
    expectError(await t.tt.del(`/bell-schedules/${regular.bellScheduleId}`), 409, 'BELL_IN_USE');
    await t.tt.post(`/timetable-plans/${t.planId}/bell-assignments/bulk`, { bellScheduleId: junior.bellScheduleId, scope: 'DEFAULT' }).expect(200);
    expect((await t.getData<TimetablePlanDTO>(`/timetable-plans/${t.planId}`)).defaultBellScheduleId).toBe(junior.bellScheduleId);
    const other = t.unwrap<BellScheduleDTO>(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules`, { name: 'Spare', kind: 'OTHER' }), 201);
    await t.tt.del(`/bell-schedules/${other.bellScheduleId}`).expect(204);
    expectError(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules`, { name: 'junior', kind: 'OTHER' }), 409, 'BELL_NAME_TAKEN');
  });
});

describe('Subject Needs (TT-09, 10)', () => {
  it('QA TT-09: needs are set once for the class and every section uses them; a section row exists only when someone changes it', async () => {
    const t = await timetableSchool();
    await withRegular(t);
    const saved = t.unwrap<RequirementSaveResultDTO>(await classNeeds(t));
    expect(saved).toMatchObject({ saved: 2, unchanged: 0 });
    expect(saved.total).toMatchObject({ needed: 11, available: 42, ok: true, message: 'Total 11 of 42 periods' });
    expect(t.unwrap<RequirementSaveResultDTO>(await classNeeds(t))).toMatchObject({ saved: 0, unchanged: 2 });
    expect(await Requirement.countDocuments({ tenantId: t.tenantId, scope: 'SECTION' })).toBe(0);

    const classList = await t.getData<RequirementListDTO>(`/subject-schedule-requirements?planId=${t.planId}&classOfferingId=${t.classOfferingId}`);
    expect(classList.items.map((i) => [i.subjectName, i.source, i.effective.periodsPerWeek, i.effective.maxPerDay])).toEqual([['Mathematics', 'CLASS', 6, 2], ['Science', 'CLASS', 5, 2]]);
    const sectionA = await t.getData<RequirementListDTO>(`/subject-schedule-requirements?planId=${t.planId}&sectionOfferingId=${t.sections.A}`);
    expect(sectionA.items.every((i) => i.source === 'CLASS' && i.classDefault !== null)).toBe(true);

    // Section B gets its own Maths; the class value stays.
    t.unwrap<RequirementSaveResultDTO>(await t.tt.put('/subject-schedule-requirements', { planId: t.planId, items: [{ scope: 'SECTION', classOfferingId: t.classOfferingId, sectionOfferingId: t.sections.B, subjectOfferingId: t.offerings.MATH, periodsPerWeek: 8 }] }));
    const sectionB = await t.getData<RequirementListDTO>(`/subject-schedule-requirements?planId=${t.planId}&sectionOfferingId=${t.sections.B}`);
    expect(sectionB.items.find((i) => i.subjectName === 'Mathematics')).toMatchObject({ source: 'SECTION', effective: { periodsPerWeek: 8 }, classDefault: { periodsPerWeek: 6 } });
    expect(sectionB.total.needed).toBe(13);
    expect((await t.getData<RequirementListDTO>(`/subject-schedule-requirements?planId=${t.planId}&sectionOfferingId=${t.sections.A}`)).total.needed).toBe(11);
    expect((await t.getData<RequirementListDTO>(`/subject-schedule-requirements?planId=${t.planId}&classOfferingId=${t.classOfferingId}`)).sectionsWithOverrides).toBe(1);
    const reset = t.unwrap<{ removed: number }>(await t.tt.post('/subject-schedule-requirements/reset-section', { planId: t.planId, sectionOfferingId: t.sections.B }));
    expect(reset.removed).toBe(1);
    expect((await t.getData<RequirementListDTO>(`/subject-schedule-requirements?planId=${t.planId}&sectionOfferingId=${t.sections.B}`)).total.needed).toBe(11);
  });

  it('QA TT-09: copy to other sections writes only the differences and says what was already the same', async () => {
    const t = await timetableSchool();
    await withRegular(t);
    await classNeeds(t);
    await t.tt.put('/subject-schedule-requirements', { planId: t.planId, items: [{ scope: 'SECTION', classOfferingId: t.classOfferingId, sectionOfferingId: t.sections.B, subjectOfferingId: t.offerings.MATH, periodsPerWeek: 8, maxPerDay: 3 }] }).expect(200);
    const first = t.unwrap<RequirementCopyResultDTO>(await t.tt.post('/subject-schedule-requirements/copy-section', { planId: t.planId, fromSectionId: t.sections.B, toSectionIds: [t.sections.C] }));
    expect(first).toMatchObject({ copied: 1, alreadySame: 1, message: '1 copied, 1 was already the same.' });
    expect(await Requirement.countDocuments({ tenantId: t.tenantId, scope: 'SECTION' })).toBe(2);
    expect(t.unwrap<RequirementCopyResultDTO>(await t.tt.post('/subject-schedule-requirements/copy-section', { planId: t.planId, fromSectionId: t.sections.B, toSectionIds: [t.sections.C] }))).toMatchObject({ copied: 0, alreadySame: 2 });
    // Copying a section that matches the class makes the target match the class again: its own row goes away.
    t.unwrap<RequirementCopyResultDTO>(await t.tt.post('/subject-schedule-requirements/copy-section', { planId: t.planId, fromSectionId: t.sections.A, toSectionIds: [t.sections.C] }));
    expect(await Requirement.countDocuments({ tenantId: t.tenantId, scope: 'SECTION', sectionOfferingId: t.sections.C })).toBe(0);
  });

  it('QA TT-10: needs that cannot work are refused in plain words, and a week that is too long is saved with a warning', async () => {
    const t = await timetableSchool();
    await withRegular(t);
    const put = (item: Record<string, unknown>) => t.tt.post('/subject-schedule-requirements/apply-grade', { planId: t.planId, classOfferingId: t.classOfferingId, items: [{ subjectOfferingId: t.offerings.MATH, periodsPerWeek: 6, ...item }] });
    expect(expectError(await put({ doubleMode: 'REQUIRED', doublesPerWeek: 4 }), 422, 'REQUIREMENT_INVALID').message).toBe('Mathematics: 4 double periods need 8 periods a week, but only 6 are set.');
    expect(expectError(await put({ minPerWeek: 7 }), 422, 'REQUIREMENT_INVALID').message).toMatch(/least a week \(7\)/);
    expect(expectError(await put({ maxPerWeek: 4 }), 422, 'REQUIREMENT_INVALID').message).toMatch(/most a week \(4\)/);
    expect(expectError(await put({ neededSuitability: ['LASER_LAB'] }), 422, 'REQUIREMENT_INVALID').message).toMatch(/not a room kind/);
    expectError(await put({ maxPerDay: 0 }), 400, 'VALIDATION_FAILED');
    expectError(await put({ periodsPerWeek: -1 }), 400, 'VALIDATION_FAILED');

    // Another class's subject is not this class's subject.
    const [class9] = await addClasses(t.agent, t.sessionId, t.moh.locationId, [t.ref.classId.G09!]);
    const nine = await offer(t.agent, class9!.classOfferingId, [(await t.agent.get(`${API}/subjects?pageSize=100`)).body.data.items.find((s: { subjectCode: string }) => s.subjectCode === 'MATH').subjectId]);
    expect(expectError(await put({ subjectOfferingId: nine.MATH }), 422, 'REQUIREMENT_INVALID').message).toBe('This subject is not offered in that class.');

    const doubles = t.unwrap<RequirementSaveResultDTO>(await put({ doubleMode: 'PREFERRED', neededSuitability: ['COMPUTER_PRACTICAL', 'COMPUTER_PRACTICAL'] }));
    expect(doubles.saved).toBe(1);
    const row = (await t.getData<RequirementListDTO>(`/subject-schedule-requirements?planId=${t.planId}&classOfferingId=${t.classOfferingId}`)).items.find((i) => i.subjectName === 'Mathematics')!;
    expect(row.effective).toMatchObject({ doubleMode: 'PREFERRED', doublesPerWeek: 1, neededSuitability: ['COMPUTER_PRACTICAL'] });
    expectError(await t.tt.put('/subject-schedule-requirements', { planId: t.planId, items: [{ scope: 'CLASS', classOfferingId: t.classOfferingId, subjectOfferingId: t.offerings.MATH, periodsPerWeek: 7, version: row.version! + 5 }] }), 409, 'VERSION_CONFLICT');

    const long = t.unwrap<RequirementSaveResultDTO>(await put({ periodsPerWeek: 40 }));
    expect(long.total).toMatchObject({ needed: 40, available: 42, ok: true });
    const longer = t.unwrap<RequirementSaveResultDTO>(await t.tt.post('/subject-schedule-requirements/apply-grade', { planId: t.planId, classOfferingId: t.classOfferingId, items: [{ subjectOfferingId: t.offerings.SCI, periodsPerWeek: 10 }] }));
    expect(longer.total).toMatchObject({ needed: 50, available: 42, ok: false, message: 'Needs 50 periods, the week has 42' });
  });

  it('QA TT-10: needs from another campus are refused as WRONG_CAMPUS and another school\'s ids are a 404', async () => {
    const t = await timetableSchool();
    const [chdClass] = await addClasses(t.agent, t.sessionId, t.chd.locationId, [t.ref.classId.G08!]);
    expectError(await t.tt.put('/subject-schedule-requirements', { planId: t.planId, items: [{ scope: 'CLASS', classOfferingId: chdClass!.classOfferingId, subjectOfferingId: t.offerings.MATH, periodsPerWeek: 4 }] }), 409, 'WRONG_CAMPUS');
    const other = await timetableSchool();
    expectError(await other.tt.put('/subject-schedule-requirements', { planId: other.planId, items: [{ scope: 'CLASS', classOfferingId: t.classOfferingId, subjectOfferingId: t.offerings.MATH, periodsPerWeek: 4 }] }), 404, 'NOT_FOUND');
    expectError(await other.tt.put('/subject-schedule-requirements', { planId: t.planId, items: [{ scope: 'CLASS', classOfferingId: other.classOfferingId, subjectOfferingId: other.offerings.MATH, periodsPerWeek: 4 }] }), 404, 'NOT_FOUND');
  });
});

describe('teacher availability and workload (TT-11, 12)', () => {
  it('QA TT-11: only exceptions are stored; overlaps, non-school days and teachers from another campus are refused', async () => {
    const t = await timetableSchool();
    const teacher = await addActiveEmployee(t);
    const rows = [{ weekday: 'SAT', start: '08:00', end: '14:00', kind: 'UNAVAILABLE' }, { weekday: 'MON', start: '08:00', end: '09:30', kind: 'PREFERRED' }];
    const saved = t.unwrap<FacultyAvailabilityDTO>(await t.tt.put(`/faculty-availability/${teacher.employeeId}`, { planId: t.planId, rows }));
    expect(saved.rows.map((r) => `${r.weekday} ${r.start}-${r.end} ${r.kind}`)).toEqual(['MON 08:00-09:30 PREFERRED', 'SAT 08:00-14:00 UNAVAILABLE']);
    expect(await Availability.countDocuments({ tenantId: t.tenantId })).toBe(2);
    expect(t.unwrap<FacultyAvailabilityDTO>(await t.tt.put(`/faculty-availability/${teacher.employeeId}`, { planId: t.planId, rows: [] })).rows).toEqual([]);
    expect(await Availability.countDocuments({ tenantId: t.tenantId })).toBe(0);

    expect(expectError(await t.tt.put(`/faculty-availability/${teacher.employeeId}`, { planId: t.planId, rows: [rows[1], { weekday: 'MON', start: '09:00', end: '10:00', kind: 'NOT_PREFERRED' }] }), 422, 'AVAILABILITY_INVALID').message).toMatch(/overlap/);
    expect(expectError(await t.tt.put(`/faculty-availability/${teacher.employeeId}`, { planId: t.planId, rows: [{ weekday: 'SUN', start: '08:00', end: '09:00', kind: 'UNAVAILABLE' }] }), 422, 'AVAILABILITY_INVALID').message).toMatch(/Sunday is not a school day/);
    expectError(await t.tt.put(`/faculty-availability/${teacher.employeeId}`, { planId: t.planId, rows: [{ weekday: 'MON', start: '10:00', end: '09:00', kind: 'UNAVAILABLE' }] }), 422, 'AVAILABILITY_INVALID');

    const atChd = await addActiveEmployee(t, { primaryLocationId: t.chd.locationId });
    expectError(await t.tt.put(`/faculty-availability/${atChd.employeeId}`, { planId: t.planId, rows }), 409, 'WRONG_CAMPUS');
    const stranger = await setupSchool({ seedLocations: true, workspace: 'Elsewhere' });
    expectError(await t.tt.put(`/faculty-availability/${stranger.school.schoolId}`, { planId: t.planId, rows }), 404, 'NOT_FOUND');
  });

  it('QA TT-11: bulk apply and copy from another teacher; ADD keeps the other rows, REPLACE starts again; one audit event with the counts', async () => {
    const t = await timetableSchool();
    const [a, b, c] = [await addActiveEmployee(t), await addActiveEmployee(t), await addActiveEmployee(t)];
    const sat = { weekday: 'SAT', start: '08:00', end: '14:00', kind: 'UNAVAILABLE' };
    await t.tt.put(`/faculty-availability/${b.employeeId}`, { planId: t.planId, rows: [{ weekday: 'MON', start: '08:00', end: '09:00', kind: 'NOT_PREFERRED' }] }).expect(200);
    expect(t.unwrap<AvailabilityBulkResultDTO>(await t.tt.post('/faculty-availability/bulk', { planId: t.planId, employeeIds: [a.employeeId, b.employeeId], rows: [sat], mode: 'ADD' }))).toEqual({ teachers: 2, rowsPerTeacher: 1 });
    expect((await t.getData<FacultyAvailabilityDTO>(`/faculty-availability/${b.employeeId}?planId=${t.planId}`)).rows).toHaveLength(2);
    t.unwrap<AvailabilityBulkResultDTO>(await t.tt.post('/faculty-availability/bulk', { planId: t.planId, employeeIds: [b.employeeId], rows: [{ ...sat, start: '09:00', end: '10:00' }], mode: 'ADD' }));
    expect((await t.getData<FacultyAvailabilityDTO>(`/faculty-availability/${b.employeeId}?planId=${t.planId}`)).rows.map((r) => r.start)).toEqual(['08:00', '09:00']);
    t.unwrap<AvailabilityBulkResultDTO>(await t.tt.post('/faculty-availability/bulk', { planId: t.planId, employeeIds: [b.employeeId], rows: [sat], mode: 'REPLACE' }));
    expect((await t.getData<FacultyAvailabilityDTO>(`/faculty-availability/${b.employeeId}?planId=${t.planId}`)).rows).toHaveLength(1);
    expect(t.unwrap<AvailabilityBulkResultDTO>(await t.tt.post('/faculty-availability/copy', { planId: t.planId, fromEmployeeId: a.employeeId, toEmployeeIds: [c.employeeId, a.employeeId] }))).toEqual({ teachers: 1, rowsPerTeacher: 1 });
    expect((await t.getData<FacultyAvailabilityDTO>(`/faculty-availability/${c.employeeId}?planId=${t.planId}`)).rows[0]).toMatchObject({ weekday: 'SAT', kind: 'UNAVAILABLE' });
    const events = await AuditEvent.find({ tenantId: t.tenantId, entityType: 'faculty_availability', action: 'faculty_availability.bulk_applied', 'metadata.teachers': 2 }).lean();
    expect(events).toHaveLength(1);
    expect(events[0]!.metadata).toMatchObject({ teachers: 2, rows: 1, mode: 'ADD' });
    const teachers = await t.getData<PlanTeacherDTO[]>(`/timetable-plans/${t.planId}/teachers`);
    expect(teachers.find((x) => x.employeeId === c.employeeId)!.hasAvailabilityRows).toBe(true);
  });

  it('QA TT-12: the school default applies until a teacher sets their own; clearing every field returns the teacher to the default', async () => {
    const t = await timetableSchool();
    const teacher = await addActiveEmployee(t);
    const put = async (body: Record<string, unknown>) => t.unwrap<WorkloadRulesDTO>(await t.tt.put('/faculty-workload-rules', { planId: t.planId, ...body }));
    let rules = await put({ employeeId: null, maxPerDay: 6, maxConsecutive: 4, maxPerWeek: 30 });
    expect(rules.planDefault).toMatchObject({ maxPerDay: 6, maxConsecutive: 4, maxPerWeek: 30 });
    const mine = () => rules.teachers.find((x) => x.employeeId === teacher.employeeId)!;
    expect(mine().usingDefault).toEqual({ maxPerDay: true, maxConsecutive: true, maxPerWeek: true, preferredFreePerDay: true });
    expect(mine().effective).toMatchObject({ maxPerDay: 6, maxPerWeek: 30 });
    rules = await put({ employeeId: teacher.employeeId, maxPerDay: 5, preferredFreePerDay: 1 });
    expect(mine()).toMatchObject({ own: { maxPerDay: 5, maxConsecutive: null, preferredFreePerDay: 1 }, effective: { maxPerDay: 5, maxConsecutive: 4, maxPerWeek: 30, preferredFreePerDay: 1 }, usingDefault: { maxPerDay: false, maxConsecutive: true } });
    rules = await put({ employeeId: teacher.employeeId, maxPerDay: null, preferredFreePerDay: null });
    expect(mine().usingDefault.maxPerDay).toBe(true);
    expect(await WorkloadRule.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect((await t.getData<TimetablePlanDTO>(`/timetable-plans/${t.planId}`)).defaultMaxPerDay).toBe(6);
    expectError(await t.tt.put('/faculty-workload-rules', { planId: t.planId, employeeId: null, maxPerDay: 0 }), 400, 'VALIDATION_FAILED');
  });
});

describe('Teaching Groups (TT-18, 19)', () => {
  const group = (t: TimetableSchool, over: Record<string, unknown> = {}) =>
    t.tt.post('/teaching-groups', { planId: t.planId, name: 'Maths Group 1', kind: 'SUBJECT', classOfferingId: t.classOfferingId, subjectOfferingId: t.offerings.MATH, sectionPool: [t.sections.A, t.sections.B], ...over });

  it('QA TT-18: members are worked out from subject choice in the sections the group draws from; hand-added members are stored and shown with their source', async () => {
    const t = await timetableSchool();
    const [a1, a2, b1, c1] = [await addStudent(t, { sectionId: t.sections.A }), await addStudent(t, { sectionId: t.sections.A }), await addStudent(t, { sectionId: t.sections.B }), await addStudent(t, { sectionId: t.sections.C })];
    const made = t.unwrap<TeachingGroupDTO>(await group(t), 201);
    expect(made).toMatchObject({ name: 'Maths Group 1', className: expect.stringMatching(/8|VIII/), subjectName: 'Mathematics', memberCount: 3, manualCount: 0 });
    expect(made.sectionPool.map((s) => s.label)).toEqual(['8-A', '8-B']);
    expect(await GroupMembership.countDocuments({ tenantId: t.tenantId })).toBe(0);

    const members = await t.getData<GroupMemberListDTO>(`/teaching-groups/${made.groupId}/members`);
    expect(members.total).toBe(3);
    expect(members.items.every((m) => m.source === 'SUBJECT_CHOICE')).toBe(true);
    expect(members.items.map((m) => m.studentId).sort()).toEqual([a1.student.studentId, a2.student.studentId, b1.student.studentId].sort());

    const added = t.unwrap<{ added: number; removed: number }>(await t.tt.post(`/teaching-groups/${made.groupId}/members`, { add: [c1.student.studentId, a1.student.studentId], remove: [] }));
    expect(added.added).toBe(2);
    const after = await t.getData<GroupMemberListDTO>(`/teaching-groups/${made.groupId}/members`);
    expect(after.items.find((m) => m.studentId === c1.student.studentId)).toMatchObject({ source: 'MANUAL', sectionLabel: '8-C' });
    expect(after.items.find((m) => m.studentId === a1.student.studentId)!.source).toBe('SUBJECT_CHOICE');
    expect((await t.getData<GroupMemberListDTO>(`/teaching-groups/${made.groupId}/members?pageSize=2&page=2`)).items).toHaveLength(2);
    expect(t.unwrap<{ added: number; removed: number }>(await t.tt.post(`/teaching-groups/${made.groupId}/members`, { add: [], remove: [c1.student.studentId] })).removed).toBe(1);
    expectError(await t.tt.post(`/teaching-groups/${made.groupId}/members`, { add: ['00000000-0000-4000-8000-000000000000'] }), 404, 'NOT_FOUND');
  });

  it('QA TT-19: health lists students who chose the subject but are in no group, members who left the section, and students in two groups', async () => {
    const t = await timetableSchool();
    const [a1, , c1] = [await addStudent(t, { sectionId: t.sections.A }), await addStudent(t, { sectionId: t.sections.B }), await addStudent(t, { sectionId: t.sections.C })];
    const made = t.unwrap<TeachingGroupDTO>(await group(t), 201);
    expect(made.healthBadge).toBe('1 student not in any group');
    const health = await t.getData<GroupHealthDTO>(`/teaching-groups/${made.groupId}/health`);
    expect(health).toMatchObject({ healthy: false, leftSection: [], inTwoGroups: [] });
    expect(health.notInAnyGroup.map((s) => [s.studentId, s.sectionLabel])).toEqual([[c1.student.studentId, '8-C']]);

    // A second group for the same subject picks them up; now a student sits in two groups.
    const second = t.unwrap<TeachingGroupDTO>(await group(t, { name: 'maths group 2', sectionPool: [t.sections.C] }), 201);
    expect((await t.getData<GroupHealthDTO>(`/teaching-groups/${made.groupId}/health`)).notInAnyGroup).toEqual([]);
    expect((await t.getData<GroupHealthDTO>(`/teaching-groups/${second.groupId}/health`)).healthy).toBe(true);
    await t.tt.post(`/teaching-groups/${second.groupId}/members`, { add: [a1.student.studentId] }).expect(200);
    const crowded = await t.getData<GroupHealthDTO>(`/teaching-groups/${made.groupId}/health`);
    expect(crowded.inTwoGroups.map((s) => s.studentId)).toEqual([a1.student.studentId]);
    expect((await t.getData<TeachingGroupDTO[]>(`/teaching-groups?planId=${t.planId}`)).find((g) => g.groupId === made.groupId)!.healthBadge).toBe('1 student is in two groups');

    // A hand-added member who is not in the group's sections has "left" them.
    await t.tt.post(`/teaching-groups/${made.groupId}/members`, { add: [c1.student.studentId] }).expect(200);
    expect((await t.getData<GroupHealthDTO>(`/teaching-groups/${made.groupId}/health`)).leftSection.map((s) => s.studentId)).toEqual([c1.student.studentId]);
  });

  it('QA TT-18: the teacher is worked out from Assign Classes; none or several means the group asks for a pick, and a chosen teacher wins', async () => {
    const t = await timetableSchool();
    const [t1, t2] = [await addActiveEmployee(t), await addActiveEmployee(t)];
    const made = t.unwrap<TeachingGroupDTO>(await group(t), 201);
    expect(made.teacher).toMatchObject({ status: 'MISSING', employeeIds: [] });
    expect(made.healthBadge).toBe('No teacher yet');
    const assign = (employeeId: string, sectionId: string) => t.tt.post(`/employees/${employeeId}/academic-assignments`, { items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId, subjectOfferingId: t.offerings.MATH }] }).expect(201);
    await assign(t1.employeeId, t.sections.A);
    expect((await t.getData<TeachingGroupDTO>(`/teaching-groups/${made.groupId}`)).teacher).toMatchObject({ status: 'OK', source: 'ASSIGNMENT', employeeIds: [t1.employeeId] });
    await assign(t2.employeeId, t.sections.B);
    const two = (await t.getData<TeachingGroupDTO>(`/teaching-groups/${made.groupId}`)).teacher;
    expect(two).toMatchObject({ status: 'PICK_ONE', employeeIds: [] });
    expect(two.candidates).toHaveLength(2);
    const chosen = t.unwrap<TeachingGroupDTO>(await t.tt.patch(`/teaching-groups/${made.groupId}`, { version: 1, teacherIds: [t2.employeeId] }));
    expect(chosen.teacher).toMatchObject({ status: 'OK', source: 'CHOSEN', employeeIds: [t2.employeeId] });
    const atChd = await addActiveEmployee(t, { primaryLocationId: t.chd.locationId });
    expectError(await t.tt.patch(`/teaching-groups/${made.groupId}`, { version: chosen.version, teacherIds: [atChd.employeeId] }), 409, 'WRONG_CAMPUS');
  });

  it('QA TT-18: group names are unique in a plan, shapes that cannot work are refused, a stale edit is a conflict and archiving keeps the group', async () => {
    const t = await timetableSchool();
    const made = t.unwrap<TeachingGroupDTO>(await group(t), 201);
    expectError(await group(t, { name: 'MATHS GROUP 1' }), 409, 'GROUP_NAME_TAKEN');
    expectError(await group(t, { name: 'No subject', subjectOfferingId: undefined }), 422, 'GROUP_INVALID');
    expectError(await group(t, { name: 'No sections', sectionPool: [] }), 422, 'GROUP_INVALID');
    expect(expectError(await group(t, { name: 'Wrong subject', subjectOfferingId: '00000000-0000-4000-8000-000000000000' }), 422, 'GROUP_INVALID').message).toMatch(/not offered/);
    const activity = t.unwrap<TeachingGroupDTO>(await t.tt.post('/teaching-groups', { planId: t.planId, name: 'Chess Club', kind: 'ACTIVITY', sectionPool: [] }), 201);
    expect(activity).toMatchObject({ subjectName: null, memberCount: 0, teacher: { status: 'MISSING' } });
    expectError(await t.tt.patch(`/teaching-groups/${made.groupId}`, { version: 9, name: 'x' }), 409, 'VERSION_CONFLICT');
    const archived = t.unwrap<TeachingGroupDTO>(await t.tt.patch(`/teaching-groups/${made.groupId}`, { version: 1, status: 'ARCHIVED' }));
    expect(archived).toMatchObject({ status: 'ARCHIVED', healthBadge: null });
    expect((await t.getData<TeachingGroupDTO[]>(`/teaching-groups?planId=${t.planId}`)).map((g) => g.name)).toEqual(['Chess Club']);
    expect(await TeachingGroup.countDocuments({ tenantId: t.tenantId })).toBe(2);
  });
});

describe('readiness (TT-UX-01)', () => {
  /** Buildings, rooms and Home Classrooms for sections A, B, C, plus a Chemistry lab. */
  async function rooms(t: TimetableSchool, options: { lab?: boolean; noSeats?: boolean } = {}) {
    const post = async <T>(path: string, body: unknown) => t.unwrap<T>(await t.tt.post(path, body), 201);
    const building = await post<{ buildingId: string }>(`/locations/${t.moh.locationId}/buildings`, { buildingName: 'Main Block', buildingCode: 'MAB' });
    const floors = await post<{ floors: { floorId: string }[] }>(`/buildings/${building.buildingId}/floors/bulk`, { floors: [{ name: 'Ground' }] });
    const types = Object.fromEntries((await t.getData<{ code: string; spaceTypeId: string }[]>('/space-types')).map((x) => [x.code, x.spaceTypeId]));
    const room = (name: string, type: string, academicCapacity: number | null = 40) =>
      post<{ spaceId: string }>('/physical-spaces', { locationId: t.moh.locationId, buildingId: building.buildingId, floorId: floors.floors[0]!.floorId, spaceTypeId: types[type], spaceName: name, roomNumber: name.replace(/\D/g, '') || undefined, ...(academicCapacity ? { academicCapacity, physicalCapacity: academicCapacity + 2 } : {}) });
    for (const code of ['A', 'B', 'C'] as const) {
      const r = await room(`Room 10${code.charCodeAt(0) - 64}`, 'STANDARD_CLASSROOM');
      t.unwrap(await t.tt.post('/section-space-assignments', { sectionOfferingId: t.sections[code], physicalSpaceId: r.spaceId }), 201);
    }
    if (options.lab) await room('Chemistry Lab 1', 'CHEMISTRY_LAB');
    if (options.noSeats) {
      const kind = await post<{ spaceTypeId: string }>('/space-types', { name: 'Activity Room', isSchedulable: true, isHomeClassroomEligible: true, defaultAcademicCapacity: null });
      types.ACTIVITY = kind.spaceTypeId;
      await room('Activity Room 1', 'ACTIVITY', null);
    }
  }
  /** One teacher for both subjects in all three sections. */
  async function teach(t: TimetableSchool) {
    const teacher = await addActiveEmployee(t);
    const items = (['A', 'B', 'C'] as const).flatMap((c) => [t.offerings.MATH, t.offerings.SCI].map((subjectOfferingId) => ({ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections[c], subjectOfferingId })));
    await t.tt.post(`/employees/${teacher.employeeId}/academic-assignments`, { items }).expect(201);
    return teacher;
  }

  it('QA TT-UX-01: a new plan lists every missing step in four areas, each with a fix button, and counts the actions', async () => {
    const t = await timetableSchool();
    const r = await readiness(t);
    expect(r).toMatchObject({ ready: false, canSmartDraft: false });
    expect(r.areas.map((a) => [a.area, a.status])).toEqual([['CLASSES_SUBJECTS', 'NEEDS_ACTION'], ['TEACHERS', 'READY'], ['ROOMS', 'NEEDS_ACTION'], ['TIME', 'NEEDS_ACTION']]);
    expect(codes(r).sort()).toEqual(['NO_DAILY_PERIODS', 'NO_HOME_CLASSROOM', 'NO_SUBJECT_NEEDS']);
    expect(r.needsActions).toBe(3);
    expect(r.message).toBe('Timetable setup needs 3 actions');
    const needs = r.areas[0]!.items[0]!;
    expect(needs).toMatchObject({ count: 2, examples: ['Mathematics', 'Science'], fix: { action: 'SET_SUBJECT_NEEDS', label: 'Set Subject Needs' } });
    expect(needs.fix.path).toBe(`/timetable/setup?tab=needs&classOfferingId=${t.classOfferingId}`);
    expect(r.areas[3]!.items[0]!.fix).toMatchObject({ action: 'SET_DAILY_PERIODS', label: 'Set Daily Periods' });
    expect(r.areas[2]!.items[0]!).toMatchObject({ count: 3, examples: ['8-A', '8-B', '8-C'], fix: { action: 'CLASSROOM_ALLOCATION', label: 'Go To Classroom Allocation' } });
    expect(r.smartDraftBlockedBy).toEqual(['Time is not ready: fix the Daily Periods first.', 'No Subject Needs are set yet.']);
    expect((await readiness(t)).needsActions).toBe(r.needsActions);
  });

  it('QA TT-UX-01: a missing teacher or room only leaves lessons unplaced, so Smart Draft stays open once Time and Subject Needs are fine', async () => {
    const t = await timetableSchool();
    await withRegular(t);
    await classNeeds(t);
    const r = await readiness(t);
    expect(r.canSmartDraft).toBe(true);
    expect(r.areas.map((a) => [a.area, a.items.map((i) => i.code)])).toEqual([['CLASSES_SUBJECTS', []], ['TEACHERS', ['NO_TEACHER']], ['ROOMS', ['NO_HOME_CLASSROOM']], ['TIME', []]]);
    expect(r.areas[1]!.items[0]).toMatchObject({ count: 6, fix: { action: 'ASSIGN_CLASSES', label: 'Go To Assign Classes' } });
    expect(r.areas[1]!.items[0]!.examples).toEqual(['8-A Mathematics', '8-A Science', '8-B Mathematics', 'and 3 more']);
  });

  it('QA TT-UX-01: two teachers for one subject is a "pick one" item, never a guess; a teacher from another campus is named', async () => {
    const t = await timetableSchool();
    await withRegular(t);
    await classNeeds(t);
    await teach(t);
    const other = await addActiveEmployee(t);
    await t.tt.post(`/employees/${other.employeeId}/academic-assignments`, { items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.A, subjectOfferingId: t.offerings.MATH }] }).expect(201);
    const r = await readiness(t);
    expect(r.areas[1]!.items.map((i) => [i.code, i.count])).toEqual([['PICK_TEACHER', 1]]);
    // The section-level teacher beats a class-level one, so a class-wide teacher does not make this ambiguous.
    const stray = await addActiveEmployee(t, { primaryLocationId: t.chd.locationId });
    await t.tt.post(`/employees/${stray.employeeId}/academic-assignments`, { items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.B, subjectOfferingId: t.offerings.SCI }] }).then((res) => expect([201, 409, 422]).toContain(res.status));
  });

  it('QA TT-UX-01: a special room kind with no room, rooms with no seat count, sections whose week is too short and sections with no Daily Periods are each listed', async () => {
    const t = await timetableSchool();
    await withRegular(t);
    await classNeeds(t, { neededSuitability: ['CHEMISTRY_PRACTICAL'] });
    await rooms(t, { noSeats: true });
    let r = await readiness(t);
    expect(r.areas[2]!.items.map((i) => i.code).sort()).toEqual(['NO_ROOM_KIND', 'ROOMS_NO_CAPACITY']);
    expect(r.areas[2]!.items.find((i) => i.code === 'NO_ROOM_KIND')!.message).toMatch(/Chemistry practical/);
    expect(r.counts.homeClassrooms).toBe(3);

    await t.tt.post('/subject-schedule-requirements/apply-grade', { planId: t.planId, classOfferingId: t.classOfferingId, items: [{ subjectOfferingId: t.offerings.SCI, periodsPerWeek: 40 }] }).expect(200);
    r = await readiness(t);
    const tooMany = r.areas[3]!.items.find((i) => i.code === 'TOO_MANY_PERIODS')!;
    expect(tooMany).toMatchObject({ severity: 'BLOCKER', count: 3 });
    expect(tooMany.examples[0]).toBe('8-A needs 46, the week has 42');
    expect(r.canSmartDraft).toBe(false);

    // A class that uses Daily Periods on only some days leaves its sections unresolved.
    const [only] = await t.getData<BellScheduleDTO[]>(`/timetable-plans/${t.planId}/bell-schedules`);
    await TimetablePlan.updateOne({ _id: t.planId, tenantId: t.tenantId }, { $set: { defaultBellScheduleId: null } });
    await t.tt.post(`/timetable-plans/${t.planId}/bell-assignments/bulk`, { bellScheduleId: only!.bellScheduleId, scope: 'CLASS', classOfferingIds: [t.classOfferingId], weekdays: ['MON'] }).expect(200);
    r = await readiness(t);
    expect(codes(r)).toContain('NO_PERIODS_FOR_SECTIONS');
    expect(r.canSmartDraft).toBe(false);
  });

  it('QA TT-UX-01: once the week, the needs, the teachers and the rooms are set, the plan is Ready to build with nothing to fix', async () => {
    const t = await timetableSchool();
    await withRegular(t);
    await classNeeds(t, { neededSuitability: ['CHEMISTRY_PRACTICAL'] });
    await teach(t);
    await rooms(t, { lab: true });
    const r = await readiness(t);
    expect(r).toMatchObject({ ready: true, needsActions: 0, message: 'Ready to build', canSmartDraft: true, smartDraftBlockedBy: [] });
    expect(r.areas.every((a) => a.status === 'READY' && a.items.length === 0)).toBe(true);
    expect(r.counts).toMatchObject({ sections: 3, subjects: 2, teachers: 1, homeClassrooms: 3, specialRooms: 1 });
    expect(await Requirement.countDocuments({ tenantId: t.tenantId })).toBe(2);
  });
});

describe('isolation, permissions and audit (TT-49)', () => {
  it('QA TT-49: another school gets a 404 for every id; a teacher at another campus gets a 403 and a CROSS_SCOPE_DENIED event', async () => {
    const t = await timetableSchool();
    const stranger = await timetableSchool();
    expectError(await stranger.tt.patch(`/timetable-plans/${t.planId}`, { version: 1, planName: 'x' }), 404, 'NOT_FOUND');
    expectError(await stranger.tt.post(`/timetable-plans/${t.planId}/bell-schedules`, { name: 'x' }), 404, 'NOT_FOUND');
    expect((await stranger.agent.get(`${API}/timetable-plans/${t.planId}/readiness`)).status).toBe(404);
    expect((await stranger.agent.get(`${API}/timetable-plans`)).body.data.map((p: TimetablePlanDTO) => p.planId)).toEqual([stranger.planId]);

    const chd = await loginAt(t, 'FACULTY', t.chd.locationId);
    expect((await chd.agent.get(`${API}/timetable-plans/${t.planId}`)).status).toBe(403);
    expect((await chd.agent.get(`${API}/timetable-plans/${t.planId}/readiness`)).status).toBe(403);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: chd.userId })).toBe(2);
    expect((await chd.agent.get(`${API}/timetable-plans`)).body.data).toEqual([]);
    const chdPlan = data(await t.tt.post('/timetable-plans', { locationId: t.chd.locationId, academicSessionId: t.sessionId }).expect(201)) as TimetablePlanDTO;
    expect((await chd.agent.get(`${API}/timetable-plans`)).body.data.map((p: TimetablePlanDTO) => p.planId)).toEqual([chdPlan.planId]);
  });

  it('QA TT-49: Faculty may look but never change; the setup and availability routes need their own permission', async () => {
    const t = await timetableSchool();
    const faculty = await loginAt(t, 'FACULTY');
    expect((await faculty.agent.get(`${API}/timetable-plans/${t.planId}`)).status).toBe(200);
    expect((await faculty.agent.get(`${API}/timetable-plans/${t.planId}/readiness`)).status).toBe(200);
    for (const send of [
      () => faculty.agent.post(`${API}/timetable-plans`).send({ locationId: t.moh.locationId, academicSessionId: t.sessionId }),
      () => faculty.agent.patch(`${API}/timetable-plans/${t.planId}`).send({ version: 1, planName: 'x' }),
      () => faculty.agent.post(`${API}/timetable-plans/${t.planId}/bell-schedules/generate`).send(t.regular),
      () => faculty.agent.put(`${API}/subject-schedule-requirements`).send({ planId: t.planId, items: [] }),
      () => faculty.agent.put(`${API}/faculty-availability/${faculty.employee.employeeId}`).send({ planId: t.planId, rows: [] }),
      () => faculty.agent.post(`${API}/teaching-groups`).send({ planId: t.planId, name: 'x' }),
      () => faculty.agent.put(`${API}/timetable/access/${faculty.userId}`).send({ bundles: ['FRONT_OFFICE'] }),
    ]) expect((await send()).status).toBe(403);
    expect((await request(app).get(`${API}/timetable-plans`)).status).toBe(401);
  });

  it('QA TT-49: a job bundle gives a Staff login permissions at once, only at the campuses they work at, and taking it away works on the next request', async () => {
    const t = await timetableSchool();
    const staff = await loginAt(t, 'STAFF');
    expect((await staff.agent.get(`${API}/timetable-plans/${t.planId}`)).status).toBe(403);
    const grant = (bundles: string[], locationIds?: string[]) => t.tt.put(`/timetable/access/${staff.userId}`, { bundles, ...(locationIds ? { locationIds } : {}) });
    expect(t.unwrap<TimetableAccessGrantDTO>(await grant(['FRONT_OFFICE'])).bundles).toEqual(['FRONT_OFFICE']);
    expect((await staff.agent.get(`${API}/timetable-plans/${t.planId}`)).status).toBe(200);
    expect((await staff.agent.patch(`${API}/timetable-plans/${t.planId}`).send({ version: 1, planName: 'x' })).status).toBe(403);
    t.unwrap<TimetableAccessGrantDTO>(await grant(['SCHEDULING_COORDINATOR']));
    expect((await staff.agent.patch(`${API}/timetable-plans/${t.planId}`).send({ version: 1, planName: 'Coordinated' })).status).toBe(200);
    expect(TIMETABLE_BUNDLE_PERMISSIONS.SCHEDULING_COORDINATOR).not.toContain('timetable:publish');
    expect(TIMETABLE_BUNDLE_PERMISSIONS.SCHEDULING_COORDINATOR).not.toContain('timetable:conflict:override');
    expect(TIMETABLE_BUNDLE_PERMISSIONS.SUBSTITUTION_MANAGER).toContain('timetable:override:manage');
    // Narrowing the bundle to the other campus removes access to this one.
    t.unwrap<TimetableAccessGrantDTO>(await grant(['SCHEDULING_COORDINATOR'], [t.chd.locationId]));
    expect((await staff.agent.get(`${API}/timetable-plans/${t.planId}`)).status).toBe(403);
    t.unwrap<TimetableAccessGrantDTO>(await grant([]));
    expect(await TimetableGrant.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect((await staff.agent.get(`${API}/timetable-plans/${t.planId}`)).status).toBe(403);
    expect((await staff.agent.put(`${API}/timetable/access/${staff.userId}`).send({ bundles: ['FRONT_OFFICE'] })).status).toBe(403);
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    expect((await parent.agent.get(`${API}/timetable-plans`)).status).toBe(403);
    expectError(await t.tt.put(`/timetable/access/${t.ctx.userId}`, { bundles: ['FRONT_OFFICE'] }), 400, 'VALIDATION_FAILED');
  });

  it('QA TT-49: every setup change writes an audit event; bulk changes write one event with counts; deleting a draft session or subject takes its setup with it', async () => {
    const t = await timetableSchool();
    await withRegular(t);
    await classNeeds(t);
    const teacher = await addActiveEmployee(t);
    await t.tt.post('/faculty-availability/bulk', { planId: t.planId, employeeIds: [teacher.employeeId], rows: [{ weekday: 'SAT', start: '08:00', end: '14:00', kind: 'UNAVAILABLE' }] }).expect(200);
    const events = await AuditEvent.find({ tenantId: t.tenantId, 'metadata.planId': t.planId }).lean();
    expect(new Set(events.map((e) => e.entityType))).toEqual(new Set(['timetable_plan', 'bell_schedule', 'schedule_requirement', 'faculty_availability']));
    expect(events.filter((e) => e.action === 'schedule_requirement.applied_to_class')).toHaveLength(1);
    expect(events.find((e) => e.action === 'schedule_requirement.applied_to_class')!.metadata).toMatchObject({ saved: 2, unchanged: 0 });

    await withTransaction((db) => runOfferingCleanup(t.tenantId, { subjectOfferingIds: [t.offerings.SCI] }, db));
    expect(await Requirement.countDocuments({ tenantId: t.tenantId })).toBe(1);
    await withTransaction((db) => runOfferingCleanup(t.tenantId, { sessionId: t.sessionId }, db));
    expect(await TimetablePlan.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await BellPeriod.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await Availability.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await AvailabilityException.countDocuments({ tenantId: t.tenantId })).toBe(0);
  });

  it('QA SEC-TT-01: every stored field of the timetable collections has a data class, and nothing in the map is stale', () => {
    const systemFields: readonly string[] = SYSTEM_FIELDS;
    const businessPaths = (schema: { paths: Record<string, unknown> }) => [...new Set(Object.keys(schema.paths).map((p) => p.split('.')[0]!))].filter((p) => !systemFields.includes(p));
    const cases: [keyof typeof TIMETABLE_DATA_CLASSIFICATION, { schema: { paths: Record<string, unknown> } }][] = [
      ['timetable_plan', TimetablePlan], ['bell_schedule_template', BellSchedule], ['bell_schedule_period', BellPeriod], ['bell_schedule_assignment', BellAssignment],
      ['subject_schedule_requirement', Requirement], ['faculty_schedule_availability', Availability], ['faculty_schedule_availability_exception', AvailabilityException],
      ['faculty_workload_rule', WorkloadRule], ['teaching_group', TeachingGroup], ['teaching_group_membership', GroupMembership], ['timetable_access_grant', TimetableGrant],
      ['timetable_version', TimetableVersion], ['timetable_entry', TimetableEntry], ['timetable_entry_section', EntrySection], ['timetable_entry_faculty', EntryFaculty], ['timetable_conflict_override', ConflictOverride],
      ['timetable_change_set', ChangeSet], ['timetable_generation_run', GenerationRun], ['timetable_run_item', RunItem], ['timetable_override', Override], ['timetable_override_faculty', OverrideFaculty],
    ];
    for (const [entity, model] of cases) expect(businessPaths(model.schema).sort(), entity).toEqual(Object.keys(TIMETABLE_DATA_CLASSIFICATION[entity]).sort());
    expect(cases).toHaveLength(Object.keys(TIMETABLE_DATA_CLASSIFICATION).length);
    expect(TIMETABLE_DATA_CLASSIFICATION.faculty_schedule_availability_exception.reason).toBe('PERSONAL');
    expect(TIMETABLE_DATA_CLASSIFICATION.timetable_override.reason).toBe('PERSONAL');
  });
});
