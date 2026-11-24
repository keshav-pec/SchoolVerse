import { describe, expect, it } from 'vitest';
import type { AbsenceDTO, AbsenceImpactDTO, CompareDTO, DailyScheduleDTO, EffectiveScheduleDTO, OverrideBulkResultDTO, OverrideResultDTO, PublishResultDTO, SubstituteRecommendationDTO, OneDayRoomRecommendationDTO, RoomImpactDTO, TimetableOverviewDTO, TimetableReportDTO, TimetableVersionDTO, VersionValidationDTO } from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { OutboxEvent } from '../src/modules/spaces/space.models';
import { AcademicAssignment } from '../src/modules/staff/assignment.models';
import { Availability, EntryFaculty, Override, TimetableEntry, TimetablePlan, TimetableVersion } from '../src/modules/timetable/models';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { seedDemo } from '../src/scripts/seed';
import { permissionsFor } from '@shared';
import { Tenant } from '../src/platform/tenants/tenant.model';
import { User } from '../src/platform/users/user.model';
import { getAttention } from '../src/modules/timetable/schedule/attention.service';
import { planReadiness } from '../src/modules/timetable/readiness.service';
import { validateVersion } from '../src/modules/timetable/schedule/publish.service';
import { activatedParent, addActiveEmployee, addStudent, API, expectError, loginAs, nextDate, nextPhone, plusDays, publishedSchool, scheduleSchool, today, useTestDatabase, type PublishedSchool, type ScheduleSchool } from './helpers';

useTestDatabase();

const ok = <T>(res: { status: number; body: { data: T } }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data;
};

const publish = (t: ScheduleSchool, id = t.versionId, body: Record<string, unknown> = { acknowledgeWarnings: true }, agent = t.agent) => t.send('post', `/timetable-versions/${id}/publish`, body, agent);
const override = (t: PublishedSchool, body: Record<string, unknown>, agent = t.agent) => t.send('post', '/timetable-overrides', body, agent);
const sub = (t: PublishedSchool, entryId: string, date: string, substituteEmployeeId: string, extra: Record<string, unknown> = {}, agent = t.agent) => override(t, { type: 'SUBSTITUTE_FACULTY', entryId, date, substituteEmployeeId, ...extra }, agent);
const effective = async (t: PublishedSchool, query: string) => ok<EffectiveScheduleDTO>(await t.send('get', `/schedule/effective?${query}`));
const dayItems = async (t: PublishedSchool, sectionId: string, date: string) => (await effective(t, `sectionId=${sectionId}&date=${date}`)).days[0]!.items;
const staffWith = async (t: ScheduleSchool, bundles: string[]) => {
  const employee = await addActiveEmployee(t);
  const login = await loginAs(t, 'STAFF', employee);
  ok(await t.tt.put(`/timetable/access/${login.userId}`, { bundles }));
  return { ...login, employee };
};
/** The weekly lessons, so a test can show a one-day change never touched them. */
const weekly = async (t: ScheduleSchool) => (await TimetableEntry.find({ tenantId: t.tenantId }).sort({ _id: 1 }).lean()).map((e) => JSON.stringify([e._id, e.versionId, e.weekday, e.periodId, e.physicalSpaceId, e.subjectOfferingId, e.version, e.rev]));
const teachersOf = async (t: ScheduleSchool) => (await EntryFaculty.find({ tenantId: t.tenantId }).sort({ _id: 1 }).lean()).map((f) => `${f.entryId}:${f.employeeId}`);

describe('publishing a timetable (TT-34 to 37)', () => {
  it('QA TT-34: clashes block publishing with a reason, warnings need a tick and their counts are stored, publishing is audited, and a published version cannot be edited', async () => {
    const t = await scheduleSchool();
    const lesson = ok<{ entries: { entryId: string }[] }>(await t.put(t.lesson('A', 'MATH', 'MON', 1)), 201).entries[0]!.entryId;
    ok(await t.put(t.lesson('B', 'SCI', 'MON', 1)), 201);
    expect(ok<VersionValidationDTO>(await t.send('post', `/timetable-versions/${t.versionId}/validate`)).summary).toMatch(/^0 of 3 sections complete\. 0 clashes\. \d+ warnings?\.$/);

    // The teacher's assignment ends after the lesson was placed: the lesson is now a clash, and nothing can be published.
    await AcademicAssignment.updateMany({ tenantId: t.tenantId, employeeId: t.maths.employeeId }, { $set: { cancelledAt: new Date() } });
    const check = ok<VersionValidationDTO>(await t.send('post', `/timetable-versions/${t.versionId}/validate`));
    expect(check).toMatchObject({ clashCount: 1, canPublish: false });
    expect(check.clashes[0]).toMatchObject({ entryId: lesson, label: '8-A Mathematics on Monday, Period 1' });
    const refused = expectError(await publish(t), 409, 'PUBLISH_BLOCKED');
    expect(refused.message).toMatch(/1 clash must be fixed before you publish\. First: .* is not assigned to teach Mathematics/);
    expect((await TimetableVersion.findOne({ tenantId: t.tenantId, _id: t.versionId }).lean())!.status).toBe('DRAFT');

    await AcademicAssignment.updateMany({ tenantId: t.tenantId, employeeId: t.maths.employeeId }, { $set: { cancelledAt: null } });
    const unticked = expectError(await publish(t, t.versionId, {}), 409, 'ACKNOWLEDGE_REQUIRED');
    expect(unticked.message).toMatch(/^\d+ periods still not placed/);
    const done = ok<PublishResultDTO>(await publish(t, t.versionId, { effectiveFrom: today(), acknowledgeWarnings: true }));
    expect(done.version).toMatchObject({ status: 'PUBLISHED', phase: 'ACTIVE', effectiveFrom: today(), effectiveTo: '2027-03-31', publishedWarningCount: 0, publishedUnplacedCount: 31 });
    expect(done.version.publishedByName).toBeTruthy();
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'timetable_version', action: 'timetable_version.published' })).toBe(1);
    expect((await OutboxEvent.find({ tenantId: t.tenantId, type: 'timetable.published' }).lean()).length).toBe(1);

    // Published is read-only, and the answer points at Create Revision.
    const edit = expectError(await t.send('patch', `/timetable-entries/${lesson}`, { notes: 'x' }), 409, 'VERSION_PUBLISHED');
    expect((edit.details as unknown as { action: string }).action).toBe('CREATE_REVISION');
    expectError(await t.put(t.lesson('C', 'MATH', 'WED', 1)), 409, 'VERSION_PUBLISHED');
    expectError(await publish(t), 409, 'VERSION_PUBLISHED');
  });

  it('QA TT-35: a section with nothing placed is reported; Mark Ready checks everything and any later edit sends the draft back; a coordinator can mark ready but not publish', async () => {
    const t = await scheduleSchool();
    const lesson = ok<{ entries: { entryId: string }[] }>(await t.put(t.lesson('A', 'MATH', 'MON', 1)), 201).entries[0]!.entryId;
    const check = ok<VersionValidationDTO>(await t.send('post', `/timetable-versions/${t.versionId}/validate`));
    expect(check.emptySections).toEqual(['8-B', '8-C']);
    expect(check.sections[0]).toMatchObject({ empty: true });
    expect(check.sections.find((s) => s.label === '8-A')).toMatchObject({ needed: 11, placed: 1, left: 10, empty: false });
    expect(check).toMatchObject({ needsAcknowledge: true, canPublish: true, sectionsComplete: 0, sectionsTotal: 3, unplacedCount: 32 });

    const coordinator = await staffWith(t, ['SCHEDULING_COORDINATOR']);
    const ready = ok<TimetableVersionDTO>(await t.send('post', `/timetable-versions/${t.versionId}/mark-ready`, {}, coordinator.agent));
    expect(ready).toMatchObject({ status: 'READY', phase: 'READY' });
    expect((await publish(t, t.versionId, { acknowledgeWarnings: true }, coordinator.agent)).status).toBe(403);
    ok(await t.send('patch', `/timetable-entries/${lesson}`, { notes: 'moved a note' }, coordinator.agent));
    expect((await TimetableVersion.findOne({ tenantId: t.tenantId, _id: t.versionId }).lean())!.status).toBe('DRAFT');

    // Mark Ready refuses while a clash is there.
    await AcademicAssignment.updateMany({ tenantId: t.tenantId, employeeId: t.maths.employeeId }, { $set: { cancelledAt: new Date() } });
    expectError(await t.send('post', `/timetable-versions/${t.versionId}/mark-ready`), 409, 'PUBLISH_BLOCKED');
  });

  it('QA TT-36: a revision copies the lessons with new ids, a second draft is refused, a discarded draft stays as history, and compare lists what changed', async () => {
    const t = await publishedSchool();
    const before = await TimetableEntry.find({ tenantId: t.tenantId, versionId: t.versionId }).lean();
    const rev = ok<TimetableVersionDTO>(await t.send('post', `/timetable-versions/${t.versionId}/clone`, {}), 201);
    expect(rev).toMatchObject({ status: 'DRAFT', versionNumber: 2, sourceVersionId: t.versionId, entryCount: 7 });
    const copies = await TimetableEntry.find({ tenantId: t.tenantId, versionId: rev.versionId }).lean();
    expect(copies).toHaveLength(7);
    expect(copies.every((c) => !before.some((b) => b._id === c._id) && before.some((b) => b._id === c.copiedFromEntryId))).toBe(true);
    expect(await EntryFaculty.countDocuments({ tenantId: t.tenantId, versionId: rev.versionId })).toBe(7);
    const second = expectError(await t.send('post', `/timetable-versions/${t.versionId}/clone`, {}), 409, 'DRAFT_EXISTS');
    expect((second.details as unknown as { versionId: string }).versionId).toBe(rev.versionId);

    // Move one lesson, add one, remove one in the revision, then compare against the published version.
    const moved = copies.find((c) => c.copiedFromEntryId === t.lessons.monCMath)!;
    ok(await t.send('post', `/timetable-entries/${moved._id}/move`, { weekday: 'WED', periodId: t.p[3]! }));
    const gone = copies.find((c) => c.copiedFromEntryId === t.lessons.tueAMath)!;
    ok(await t.send('delete', `/timetable-entries/${gone._id}`));
    ok(await t.put(t.lesson('C', 'MATH', 'FRI', 2), t.agent, rev.versionId), 201);
    const diff = ok<CompareDTO>(await t.send('get', `/timetable-versions/${rev.versionId}/compare`));
    expect(diff).toMatchObject({ added: 1, removed: 1, moved: 1, changed: 0, unchanged: 5, toVersionId: t.versionId });
    expect(diff.changes.find((c) => c.kind === 'MOVED')).toMatchObject({ label: '8-C Mathematics', was: 'Monday, Period 3', now: 'Wednesday, Period 3' });
    expect(diff.summary).toBe('1 added, 1 removed, 1 moved. 5 lessons stay the same.');

    const discarded = ok<TimetableVersionDTO>(await t.send('post', `/timetable-versions/${rev.versionId}/discard`));
    expect(discarded).toMatchObject({ status: 'DISCARDED', phase: 'DISCARDED' });
    expectError(await t.send('patch', `/timetable-entries/${moved._id}`, { notes: 'x' }), 409, 'VERSION_PUBLISHED');
    expectError(await t.send('post', `/timetable-versions/${t.versionId}/discard`), 409, 'VERSION_PUBLISHED');
    expect(ok<TimetableVersionDTO[]>(await t.send('get', `/timetable-plans/${t.planId}/versions`)).map((v) => v.phase)).toEqual(['DISCARDED', 'ACTIVE']);
  });

  it('QA TT-37: a future-dated revision leaves today on the old timetable, the resolver picks the right version on each date, and impossible start dates are refused', async () => {
    const t = await publishedSchool();
    const rev = ok<TimetableVersionDTO>(await t.send('post', `/timetable-versions/${t.versionId}/clone`, {}), 201);
    const copy = (await TimetableEntry.findOne({ tenantId: t.tenantId, versionId: rev.versionId, copiedFromEntryId: t.lessons.monCMath }).lean())!;
    ok(await t.send('post', `/timetable-entries/${copy._id}/move`, { weekday: 'MON', periodId: t.p[5]! }));

    expectError(await publish(t, rev.versionId, { effectiveFrom: plusDays(today(), -1), acknowledgeWarnings: true }), 422, 'EFFECTIVE_DATE_INVALID');
    expectError(await publish(t, rev.versionId, { effectiveFrom: '2028-01-01', acknowledgeWarnings: true }), 422, 'EFFECTIVE_DATE_INVALID');
    const start = plusDays(nextDate('MON'), 7);
    const done = ok<PublishResultDTO>(await publish(t, rev.versionId, { effectiveFrom: start, acknowledgeWarnings: true }));
    expect(done).toMatchObject({ previousRunsUntil: plusDays(start, -1), message: `Published. It starts on ${start}. The current timetable runs until ${plusDays(start, -1)}.` });
    expect(done.version.phase).toBe('UPCOMING');
    const versions = ok<TimetableVersionDTO[]>(await t.send('get', `/timetable-plans/${t.planId}/versions`));
    expect(versions.map((v) => [v.versionNumber, v.phase, v.effectiveFrom, v.effectiveTo])).toEqual([[2, 'UPCOMING', start, '2027-03-31'], [1, 'ACTIVE', today(), plusDays(start, -1)]]);

    // Today and next Monday still show the old timetable (8-C Maths in Period 3); the new one starts a week later (Period 5).
    const periods = async (date: string) => (await dayItems(t, t.sections.C, date)).filter((i) => i.subjectName === 'Mathematics').map((i) => i.periodCode);
    expect(await periods(t.monday)).toEqual(['P3']);
    expect(await periods(plusDays(start, -7))).toEqual(['P3']);
    expect(await periods(start)).toEqual(['P5']);
    expect(await periods(plusDays(start, 7))).toEqual(['P5']);

    // A new version cannot start before the one that is already published starts, and no windows overlap.
    const third = ok<TimetableVersionDTO>(await t.send('post', `/timetable-versions/${rev.versionId}/clone`, {}), 201);
    expectError(await publish(t, third.versionId, { effectiveFrom: plusDays(start, -3), acknowledgeWarnings: true }), 422, 'EFFECTIVE_DATE_INVALID');
    const windows = (await TimetableVersion.find({ tenantId: t.tenantId, status: 'PUBLISHED' }).sort({ versionNumber: 1 }).lean()).map((v) => [v.effectiveFrom!, v.effectiveTo!]);
    expect(windows[0]![1]! < windows[1]![0]!).toBe(true);
  });

  it('QA TT-37b: two admins publishing at the same moment get one success, and the loser is told it was just published', async () => {
    const t = await scheduleSchool();
    ok(await t.put(t.lesson('A', 'MATH', 'MON', 1)), 201);
    const second = await staffWith(t, []);
    void second;
    const [a, b] = await Promise.all([publish(t), publish(t)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('VERSION_PUBLISHED');
    expect(await TimetableVersion.countDocuments({ tenantId: t.tenantId, status: 'PUBLISHED' })).toBe(1);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'timetable_version.published' })).toBe(1);
  });
});

describe('one-day changes (QA 54 to 62)', () => {
  it('QA TT-54: an absence lists the affected lessons without writing anything, recommendations are valid and never include a busy or absent teacher, and a bulk apply saves what it can', async () => {
    const t = await publishedSchool();
    const base = { weekly: await weekly(t), teachers: await teachersOf(t) };
    const impact = ok<AbsenceImpactDTO>(await t.send('post', '/faculty-absence/impact', { planId: t.planId, employeeId: t.maths.employeeId, dateFrom: t.monday }));
    expect(impact.items.map((i) => [i.label, i.periodName, i.covered])).toEqual([['8-A Mathematics', 'Period 1', false], ['8-B Mathematics', 'Period 2', false], ['8-C Mathematics', 'Period 3', false]]);
    expect(impact.summary).toBe('3 periods affected. 3 periods still need a teacher.');
    expect(await Override.countDocuments({ tenantId: t.tenantId })).toBe(0);

    const absence = ok<AbsenceDTO>(await t.send('post', '/faculty-absence', { planId: t.planId, employeeId: t.maths.employeeId, dateFrom: t.monday, reason: 'Fever' }), 201);
    expect(absence).toMatchObject({ affected: 3, uncovered: 3, status: 'ACTIVE' });
    // The same absence again is the same record.
    expect(ok<AbsenceDTO>(await t.send('post', '/faculty-absence', { planId: t.planId, employeeId: t.maths.employeeId, dateFrom: t.monday, reason: 'Fever' }), 201).absenceId).toBe(absence.absenceId);

    const items = impact.items.map((i) => ({ entryId: i.entryId, date: i.date }));
    const rec = ok<SubstituteRecommendationDTO[]>(await t.send('post', '/substitutions/recommend', { planId: t.planId, items }));
    // The Science teacher teaches in Periods 1 and 2, so only the spare teacher can cover those. In Period 3 the Science teacher is free.
    expect(rec.map((r) => r.recommended?.employeeId)).toEqual([t.spare.employeeId, t.spare.employeeId, t.sci.employeeId]);
    expect(rec[0]!.alternatives.map((a) => a.employeeId)).not.toContain(t.maths.employeeId);
    expect(rec[0]!.alternatives.map((a) => a.employeeId)).not.toContain(t.sci.employeeId);
    expect(rec[2]).toMatchObject({ label: '8-C Mathematics', recommended: { employeeId: t.sci.employeeId, match: 'CLASS', periodsThatDay: 3 } });
    expect(rec[2]!.alternatives.map((a) => a.employeeId)).toEqual([t.spare.employeeId]);

    // Bulk: the first two go to the spare teacher, the third asks for the Science teacher who is free, and one bad pick fails alone.
    const bulk = ok<OverrideBulkResultDTO>(await t.send('post', '/substitutions/bulk', { planId: t.planId, items: [{ ...items[0]!, substituteEmployeeId: t.spare.employeeId }, { ...items[1]!, substituteEmployeeId: t.sci.employeeId }, { ...items[2]!, substituteEmployeeId: t.sci.employeeId }], reason: 'Fever' }));
    expect(bulk).toMatchObject({ requested: 3, done: 2 });
    expect(bulk.failed).toEqual([{ entryId: items[1]!.entryId, date: t.monday, label: '8-B Mathematics', message: expect.stringMatching(/is already teaching 8-A Science on Monday, Period 2/) }]);
    expect(bulk.message).toMatch(/^2 of 3 saved\. 1 period could not be changed/);
    // 8-A is covered. 8-B could not be (the Science teacher is busy), so it still has the absent teacher and shows as uncovered.
    expect((await dayItems(t, t.sections.A, t.monday)).find((i) => i.subjectName === 'Mathematics')).toMatchObject({ state: 'SUBSTITUTED', uncovered: false });
    expect((await dayItems(t, t.sections.B, t.monday)).find((i) => i.subjectName === 'Mathematics')).toMatchObject({ state: 'NORMAL', uncovered: true });
    expect((await dayItems(t, t.sections.C, t.monday)).find((i) => i.subjectName === 'Mathematics')).toMatchObject({ state: 'SUBSTITUTED', uncovered: false });

    // The weekly timetable is exactly as it was.
    expect(await weekly(t)).toEqual(base.weekly);
    expect(await teachersOf(t)).toEqual(base.teachers);
    expect((await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'timetable_override' }))).toBe(2);
  });

  it('QA TT-55: a clash on a one-day change is refused with the reason and options, two people taking one teacher get one success, and a teacher who is away cannot be chosen', async () => {
    const t = await publishedSchool();
    // 8-B Maths and 8-A Science are both in Period 2 on Monday: the spare teacher can cover only one of them.
    const both = await Promise.all([sub(t, t.lessons.monBMath, t.monday, t.spare.employeeId), sub(t, t.lessons.monASci, t.monday, t.spare.employeeId)]);
    expect(both.map((r) => r.status).sort()).toEqual([201, 409]);
    const refused = both.find((r) => r.status === 409)!;
    expect(refused.body.error).toMatchObject({ code: 'TIMETABLE_CLASH' });
    expect(refused.body.error.message).toMatch(/is already teaching .* on Monday, Period 2/);
    expect(await Override.countDocuments({ tenantId: t.tenantId, status: 'ACTIVE' })).toBe(1);

    // Someone away cannot be named, and the refusal carries other teachers who are free.
    ok(await t.send('post', '/faculty-absence', { planId: t.planId, employeeId: t.spare.employeeId, dateFrom: t.monday }), 201);
    const away = await sub(t, t.lessons.monCMath, t.monday, t.spare.employeeId);
    const error = expectError(away, 409, 'TIMETABLE_CLASH');
    expect(error.message).toMatch(/is away on /);
    const details = error.details as unknown as { blockers: { rule: string; overridable: boolean }[]; alternatives: { kind: string; employeeId: string }[] };
    expect(details.blockers[0]).toMatchObject({ rule: 'TEACHER_UNAVAILABLE', overridable: true });
    expect(details.alternatives.map((a) => a.employeeId)).toEqual([t.sci.employeeId]);
    expect((await Override.countDocuments({ tenantId: t.tenantId, status: 'ACTIVE' }))).toBe(1);

    // An overridable clash needs the permission and a reason. The coordinator bundle has no override permission.
    const coordinator = await staffWith(t, ['SCHEDULING_COORDINATOR', 'SUBSTITUTION_MANAGER']);
    const denied = await sub(t, t.lessons.monCMath, t.monday, t.spare.employeeId, { override: { rule: 'TEACHER_UNAVAILABLE', reason: 'Short visit' } }, coordinator.agent);
    expectError(denied, 403, 'OVERRIDE_NOT_ALLOWED');
    expectError(await sub(t, t.lessons.monCMath, t.monday, t.spare.employeeId, { override: { rule: 'TEACHER_BUSY', reason: 'Never' } }), 403, 'OVERRIDE_NOT_ALLOWED');
    const accepted = ok<OverrideResultDTO>(await sub(t, t.lessons.monCMath, t.monday, t.spare.employeeId, { override: { rule: 'TEACHER_UNAVAILABLE', reason: 'Came in for this one' } }), 201);
    expect(accepted.override.acknowledged).toEqual([{ rule: 'TEACHER_UNAVAILABLE', reason: 'Came in for this one' }]);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'conflict_override', action: 'conflict_override.created' })).toBe(1);
  });

  it('QA TT-56: a room change lists the lessons that use the room, offers only rooms that are free and suitable, and a closed room is never offered', async () => {
    const t = await publishedSchool({ lab: true });
    const impact = ok<RoomImpactDTO>(await t.send('post', '/room-changes/impact', { planId: t.planId, physicalSpaceId: t.rooms.A, dateFrom: t.monday, dateTo: plusDays(t.monday, 1) }));
    expect(impact.items.map((i) => [i.date, i.label])).toEqual([[t.monday, '8-A Mathematics'], [t.monday, '8-A Science'], [t.tuesday, '8-A Mathematics']]);
    expect(impact.summary).toBe('3 lessons use Room 101 in these days.');

    // Room 104 (spare) is closed for the day, so it must not be offered. The small room is offered last, with a warning about seats.
    const close = await t.send('post', `/physical-spaces/${t.rooms.spare}/availability-blocks`, { startDatetime: `${t.monday}T00:00:00.000Z`, endDatetime: `${t.monday}T23:59:00.000Z`, reasonCode: 'MAINTENANCE', reason: 'Painting' });
    expect(close.status, JSON.stringify(close.body)).toBe(201);
    const items = impact.items.filter((i) => i.date === t.monday).map((i) => ({ entryId: i.entryId, date: i.date }));
    const rec = ok<OneDayRoomRecommendationDTO[]>(await t.send('post', '/room-changes/recommend', { planId: t.planId, items, avoidRoomId: t.rooms.A }));
    expect(rec.every((r) => r.recommended !== null)).toBe(true);
    const offered = rec.flatMap((r) => [r.recommended!, ...r.alternatives]).map((c) => c.physicalSpaceId);
    expect(offered).not.toContain(t.rooms.spare);
    expect(offered).not.toContain(t.rooms.A);
    // Two lessons at different times may share a room, but a pick made for one counts as taken for a lesson at the same time.
    const applied = ok<OverrideBulkResultDTO>(await t.send('post', '/room-changes/apply', { planId: t.planId, items: rec.map((r) => ({ entryId: r.entryId, date: r.date, physicalSpaceId: r.recommended!.physicalSpaceId })), reason: 'Leaking roof' }));
    expect(applied).toMatchObject({ requested: 2, done: 2, failed: [] });
    expect((await dayItems(t, t.sections.A, t.monday)).map((i) => [i.state, i.original?.roomName])).toEqual([['ROOM_CHANGED', 'Room 101'], ['ROOM_CHANGED', 'Room 101']]);
    // Tuesday is untouched, and picking the closed room by hand is refused with the reason.
    expect((await dayItems(t, t.sections.A, t.tuesday))[0]).toMatchObject({ state: 'NORMAL', roomName: 'Room 101' });
    const closed = await override(t, { type: 'ROOM_CHANGE', entryId: t.lessons.monCMath, date: t.monday, physicalSpaceId: t.rooms.spare });
    expectError(closed, 409, 'TIMETABLE_CLASH');
    expect(await Override.countDocuments({ tenantId: t.tenantId, type: 'ROOM_CHANGE', status: 'ACTIVE' })).toBe(2);
  });

  it('QA TT-57: cancelling a lesson and swapping two periods are checked, each shows on the day, cancelling the change brings the lesson back, and the weekly timetable never moves', async () => {
    const t = await publishedSchool();
    const base = await weekly(t);
    const cancelled = ok<OverrideResultDTO>(await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.tueAMath, date: t.tuesday, reason: 'Sports day' }), 201);
    expect(cancelled.override).toMatchObject({ type: 'CLASS_CANCELLED', summary: 'Cancelled: Sports day', label: '8-A Mathematics' });
    expectError(await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.tueAMath, date: t.tuesday, reason: 'Again' }), 422, 'OVERRIDE_INVALID');
    expectError(await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.monAMath, date: t.monday }), 400, 'VALIDATION_FAILED');
    expect((await dayItems(t, t.sections.A, t.tuesday))[0]).toMatchObject({ state: 'CANCELLED', note: 'Mathematics is cancelled: Sports day' });

    // Swap 8-C Maths (Period 3) with 8-C Science (Period 4): the Maths teacher is free in Period 4 and the Science teacher in Period 3.
    const swap = ok<OverrideResultDTO>(await override(t, { type: 'PERIOD_SWAP', entryId: t.lessons.monCMath, otherEntryId: t.lessons.monCSci, date: t.monday }), 201);
    expect(swap.override.summary).toBe('Swapped periods: Swapped with 8-C Science (Period 4)');
    expect((await dayItems(t, t.sections.C, t.monday)).map((i) => [i.subjectName, i.periodCode, i.state])).toEqual([['Science', 'P3', 'SWAPPED'], ['Mathematics', 'P4', 'SWAPPED']]);
    expectError(await override(t, { type: 'PERIOD_SWAP', entryId: t.lessons.monCMath, otherEntryId: t.lessons.monCSci, date: t.monday }), 422, 'OVERRIDE_INVALID');

    // A swap with a bad side: 8-A Maths and 8-A Science would put the Maths teacher in Period 2 (taking 8-B Maths) and the Science teacher in Period 1 (taking 8-B Science).
    const bad = expectError(await override(t, { type: 'PERIOD_SWAP', entryId: t.lessons.monAMath, otherEntryId: t.lessons.monASci, date: t.monday }), 409, 'TIMETABLE_CLASH');
    expect(bad.message).toMatch(/is already teaching 8-B (Mathematics on Monday, Period 2|Science on Monday, Period 1)/);
    expect((bad.details as unknown as { blockers: unknown[] }).blockers).toHaveLength(2);
    // Two lessons of different sections, or from different days, cannot be swapped.
    expectError(await override(t, { type: 'PERIOD_SWAP', entryId: t.lessons.monBMath, otherEntryId: t.lessons.monCMath, date: t.monday }), 422, 'OVERRIDE_INVALID');
    expectError(await override(t, { type: 'PERIOD_SWAP', entryId: t.lessons.monAMath, otherEntryId: t.lessons.tueAMath, date: t.monday }), 422, 'OVERRIDE_INVALID');

    // Cancelling the swap and the cancellation brings the lessons back, and nothing weekly ever moved.
    ok(await t.send('post', `/timetable-overrides/${swap.override.overrideId}/cancel`, {}));
    ok(await t.send('post', `/timetable-overrides/${cancelled.override.overrideId}/cancel`, {}));
    expect((await dayItems(t, t.sections.C, t.monday)).map((i) => [i.subjectName, i.periodCode, i.state])).toEqual([['Mathematics', 'P3', 'NORMAL'], ['Science', 'P4', 'NORMAL']]);
    expect((await dayItems(t, t.sections.A, t.tuesday))[0]).toMatchObject({ state: 'NORMAL', note: null });
    expect(await weekly(t)).toEqual(base);
    expect(await Override.countDocuments({ tenantId: t.tenantId, status: 'CANCELLED' })).toBe(2);
    expect(await Override.countDocuments({ tenantId: t.tenantId, status: 'ACTIVE' })).toBe(0);
  });

  it('QA TT-58: every kind of one-day change shows in the effective schedule beside the original, and a whole day can be cancelled for the campus', async () => {
    const t = await publishedSchool();
    ok(await sub(t, t.lessons.monAMath, t.monday, t.spare.employeeId, { reason: 'Training' }), 201);
    ok(await override(t, { type: 'SPECIAL_ACTIVITY', entryId: t.lessons.monBMath, date: t.monday, activityName: 'Quiz Hour' }), 201);
    ok(await override(t, { type: 'SUBJECT_CHANGE', entryId: t.lessons.monCMath, date: t.monday, subjectOfferingId: t.offerings.SCI, substituteEmployeeId: t.sci.employeeId }), 201);
    ok(await override(t, { type: 'ROOM_CHANGE', entryId: t.lessons.monCSci, date: t.monday, physicalSpaceId: t.rooms.spare }), 201);
    const a = (await dayItems(t, t.sections.A, t.monday)).find((i) => i.entryId === t.lessons.monAMath)!;
    expect(a).toMatchObject({ state: 'SUBSTITUTED', note: 'Mathematics today is taken by ' + a.teachers[0]!.fullName, original: { teachers: [{ fullName: expect.any(String) }] } });
    expect(a.teachers[0]!.employeeId).toBe(t.spare.employeeId);
    expect((await dayItems(t, t.sections.B, t.monday)).find((i) => i.entryId === t.lessons.monBMath)).toMatchObject({ state: 'CHANGED', activityName: 'Quiz Hour', note: 'Today: Quiz Hour', original: { subjectName: 'Mathematics' } });
    expect((await dayItems(t, t.sections.C, t.monday)).find((i) => i.entryId === t.lessons.monCMath)).toMatchObject({ state: 'CHANGED', subjectName: 'Science', note: 'Today taught as Science' });
    expect((await dayItems(t, t.sections.C, t.monday)).find((i) => i.entryId === t.lessons.monCSci)).toMatchObject({ state: 'ROOM_CHANGED', roomName: 'Room 104', original: { roomName: 'Room 103' } });
    // The same lesson on another Monday is untouched.
    expect((await dayItems(t, t.sections.A, plusDays(t.monday, 7))).find((i) => i.entryId === t.lessons.monAMath)).toMatchObject({ state: 'NORMAL', note: null });

    // A day off for the whole campus (cancel every lesson), safe to repeat with the same request id.
    const off = ok<OverrideBulkResultDTO>(await t.send('post', '/timetable-overrides/bulk-cancel', { planId: t.planId, date: t.tuesday, reason: 'Heavy rain', requestId: 'rain-1' }));
    expect(off).toMatchObject({ requested: 1, done: 1, failed: [] });
    expect(ok<OverrideBulkResultDTO>(await t.send('post', '/timetable-overrides/bulk-cancel', { planId: t.planId, date: t.tuesday, reason: 'Heavy rain', requestId: 'rain-1' })).message).toBe('1 change saved earlier.');
    const day = ok<DailyScheduleDTO>(await t.send('get', `/daily-schedule?planId=${t.planId}&date=${t.tuesday}`));
    expect(day.summary).toMatchObject({ lessons: 1, cancelled: 1 });
    expect(day.exceptions.map((e) => e.kind)).toEqual(['CANCELLED']);
    // A date that has passed, a Sunday and a day outside the plan are refused in plain words.
    expectError(await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.monAMath, date: plusDays(t.monday, -14), reason: 'Late' }), 422, 'OVERRIDE_INVALID');
    expectError(await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.monAMath, date: plusDays(t.monday, 6), reason: 'Sunday' }), 422, 'OVERRIDE_INVALID');
    expectError(await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.monAMath, date: plusDays(t.tuesday, 1), reason: 'Wrong weekday' }), 422, 'OVERRIDE_INVALID');
  });

  it('QA TT-58b: a change can be edited (the new details are checked again), replaced by a newer one of the same kind, and read back by date', async () => {
    const t = await publishedSchool();
    const first = ok<OverrideResultDTO>(await sub(t, t.lessons.monAMath, t.monday, t.spare.employeeId, { reason: 'Training' }), 201).override;
    // The Science teacher is teaching 8-B Science in Period 1, so editing the change to name them is refused.
    const busy = await t.send('patch', `/timetable-overrides/${first.overrideId}`, { substituteEmployeeId: t.sci.employeeId });
    expectError(busy, 409, 'TIMETABLE_CLASH');
    const reworded = ok<OverrideResultDTO>(await t.send('patch', `/timetable-overrides/${first.overrideId}`, { reason: 'Training day' }));
    expect(reworded.override).toMatchObject({ overrideId: first.overrideId, reason: 'Training day' });
    // A newer substitute for the same lesson replaces the older one instead of failing.
    const absent = await addActiveEmployee(t);
    const newer = ok<OverrideResultDTO>(await sub(t, t.lessons.monAMath, t.monday, absent.employeeId), 201).override;
    expect(newer.overrideId).not.toBe(first.overrideId);
    const list = ok<{ overrideId: string; summary: string }[]>(await t.send('get', `/timetable-overrides?planId=${t.planId}&date=${t.monday}`));
    expect(list.map((o) => o.overrideId)).toEqual([newer.overrideId]);
    expect(ok<{ status: string }[]>(await t.send('get', `/timetable-overrides?planId=${t.planId}&date=${t.monday}&status=CANCELLED`)).map((o) => o.status)).toEqual(['CANCELLED']);
    expect(await Override.countDocuments({ tenantId: t.tenantId, entryId: t.lessons.monAMath, status: 'ACTIVE' })).toBe(1);
    const asked = ok<DailyScheduleDTO>(await t.send('get', `/daily-schedule?locationId=${t.moh.locationId}&date=${t.monday}`));
    expect(asked.summary).toMatchObject({ lessons: 6, substituted: 1 });
    expect((await t.send('get', `/daily-schedule?date=${t.monday}`)).status).toBe(400);
  });

  it('QA TT-59: the daily schedule says how many periods have no teacher, lists the exceptions, and moving to a substitute clears the count', async () => {
    const t = await publishedSchool();
    ok(await t.send('post', '/faculty-absence', { planId: t.planId, employeeId: t.sci.employeeId, dateFrom: t.monday }), 201);
    let day = ok<DailyScheduleDTO>(await t.send('get', `/daily-schedule?planId=${t.planId}&date=${t.monday}`));
    expect(day).toMatchObject({ line: '3 periods have no teacher', summary: { lessons: 6, uncovered: 3 } });
    expect(day.exceptions).toEqual([expect.objectContaining({ kind: 'ABSENT', affected: 3, uncovered: 3, message: '3 periods of 3 still need a teacher.' })]);
    expect(day.uncovered.map((u) => u.periodCode)).toEqual(['P1', 'P2', 'P4']);
    ok(await sub(t, t.lessons.monBSci, t.monday, t.spare.employeeId), 201);
    day = ok<DailyScheduleDTO>(await t.send('get', `/daily-schedule?planId=${t.planId}&date=${t.monday}`));
    expect(day.line).toBe('2 periods have no teacher');
    expect(day.exceptions[0]).toMatchObject({ uncovered: 2, message: '2 periods of 3 still need a teacher.' });
    // Cancelling the absence puts the teacher back in the schedule.
    const absence = ok<AbsenceDTO[]>(await t.send('get', `/faculty-absence?planId=${t.planId}&date=${t.monday}`));
    expect(absence).toHaveLength(1);
    ok(await t.send('post', `/faculty-absence/${absence[0]!.absenceId}/cancel`));
    expect(ok<DailyScheduleDTO>(await t.send('get', `/daily-schedule?planId=${t.planId}&date=${t.monday}`)).line).toBe('Nothing unusual today');
    expect(ok<DailyScheduleDTO>(await t.send('get', `/daily-schedule?planId=${t.planId}&date=${nextDate('SUN')}`)).line).toBe('Not a school day');
  });

  it('QA TT-60: publishing a revision from today carries one-day changes over to the unchanged lessons and cancels the ones whose lesson changed', async () => {
    const t = await publishedSchool();
    const keep = ok<OverrideResultDTO>(await sub(t, t.lessons.monAMath, t.monday, t.spare.employeeId, { reason: 'Training' }), 201).override;
    const lose = ok<OverrideResultDTO>(await sub(t, t.lessons.monCMath, t.monday, t.spare.employeeId, { reason: 'Training' }), 201).override;
    const rev = ok<TimetableVersionDTO>(await t.send('post', `/timetable-versions/${t.versionId}/clone`, {}), 201);
    const copy = (await TimetableEntry.findOne({ tenantId: t.tenantId, versionId: rev.versionId, copiedFromEntryId: t.lessons.monCMath }).lean())!;
    ok(await t.send('post', `/timetable-entries/${copy._id}/move`, { weekday: 'MON', periodId: t.p[6]! }));
    const done = ok<PublishResultDTO>(await publish(t, rev.versionId));
    expect(done).toMatchObject({ movedOverrides: 1, cancelledOverrides: 1, supersededVersionId: t.versionId });
    expect((await OutboxEvent.find({ tenantId: t.tenantId, type: 'timetable.version.superseded' }).lean()).length).toBe(1);
    const rows = await Override.find({ tenantId: t.tenantId }).lean();
    const kept = rows.find((r) => r._id === keep.overrideId)!;
    expect(kept).toMatchObject({ status: 'ACTIVE', versionId: rev.versionId });
    expect(kept.entryId).not.toBe(t.lessons.monAMath);
    expect(rows.find((r) => r._id === lose.overrideId)).toMatchObject({ status: 'CANCELLED' });
    expect((await dayItems(t, t.sections.A, t.monday)).find((i) => i.subjectName === 'Mathematics')).toMatchObject({ state: 'SUBSTITUTED', versionId: rev.versionId });
  });
});

describe('the effective schedule, views and what each person may see (TT-44 to 51)', () => {
  it('QA TT-61: the effective schedule works for a section, teacher, room and student, limits ranges, and answers the Attendance questions', async () => {
    const t = await publishedSchool();
    const student = await addStudent(t, { sectionId: t.sections.A });
    ok(await sub(t, t.lessons.monAMath, t.monday, t.spare.employeeId), 201);
    ok(await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.monASci, date: t.monday, reason: 'Assembly' }), 201);

    const sectionWeek = await effective(t, `sectionId=${t.sections.A}&from=${t.monday}&to=${t.tuesday}`);
    expect(sectionWeek.days.map((d) => d.items.map((i) => `${i.subjectName}:${i.state}`))).toEqual([['Mathematics:SUBSTITUTED', 'Science:CANCELLED'], ['Mathematics:NORMAL']]);
    const studentDay = await effective(t, `studentId=${student.student.studentId}&date=${t.monday}`);
    expect(studentDay.days[0]!.items.map((i) => i.entryId)).toEqual(sectionWeek.days[0]!.items.map((i) => i.entryId));
    // The spare teacher: the substituted lesson is theirs today, and their free periods are listed.
    const spare = await effective(t, `employeeId=${t.spare.employeeId}&date=${t.monday}`);
    expect(spare.days[0]!.items.map((i) => [i.subjectName, i.state])).toEqual([['Mathematics', 'SUBSTITUTED']]);
    expect(spare.days[0]!.free.map((f) => f.periodName)).toEqual(['Period 2', 'Period 3', 'Period 4', 'Period 5', 'Period 6', 'Period 7']);
    // The original teacher sees the lesson they lost, marked.
    expect((await effective(t, `employeeId=${t.maths.employeeId}&date=${t.monday}`)).days[0]!.items.find((i) => i.entryId === t.lessons.monAMath)).toMatchObject({ state: 'SUBSTITUTED' });
    const room = await effective(t, `physicalSpaceId=${t.rooms.A}&date=${t.monday}`);
    expect(room.days[0]!.items).toHaveLength(2);
    // 8-A Science is cancelled, so its room is free again: 7 periods, 1 in use.
    expect(room.days[0]!.free).toHaveLength(6);

    expect((await t.send('get', `/schedule/effective?sectionId=${t.sections.A}&from=${t.monday}&to=${plusDays(t.monday, 40)}`)).status).toBe(400);
    expect((await t.send('get', `/schedule/effective?date=${t.monday}`)).status).toBe(400);
    const context = (await import('../src/modules/timetable/schedule/effective.service')).timetableService;
    const ctx = t.ctx;
    expect(await context.isClassHeld(ctx, t.sections.A, t.p[1]!, t.monday)).toBe(true);
    expect(await context.isClassHeld(ctx, t.sections.A, t.p[2]!, t.monday)).toBe(false);
    expect(await context.isClassHeld(ctx, t.sections.A, t.p[3]!, t.monday)).toBe(false);
    expect((await context.getEntryContext(ctx, t.lessons.monAMath, t.monday))!.state).toBe('SUBSTITUTED');
    expect(await context.getEntryContext(ctx, t.lessons.monAMath, t.tuesday)).toBeNull();
  });

  it('QA TT-62: a parent sees only their own child and another child is a 404; Faculty read published timetables only; the views mark changes', async () => {
    const t = await publishedSchool();
    const guardian = (first: string) => ({ legalFirstName: first, legalLastName: 'Rao', phone: nextPhone(), email: `${first.toLowerCase()}.tt@example.com`, relationshipType: 'Mother' });
    const mine = await addStudent(t, { sectionId: t.sections.A, guardian: guardian('Asha') });
    const other = await addStudent(t, { sectionId: t.sections.B, guardian: guardian('Bina') });
    const parent = await activatedParent(t, mine.student.studentId, 'asha.tt@example.com');
    ok(await sub(t, t.lessons.monAMath, t.monday, t.spare.employeeId), 201);

    const own = ok<EffectiveScheduleDTO>(await parent.agent.get(`${API}/schedule/effective?studentId=${mine.student.studentId}&date=${t.monday}`).then((r) => ({ status: r.status, body: r.body })));
    expect(own.days[0]!.items.find((i) => i.entryId === t.lessons.monAMath)).toMatchObject({ state: 'SUBSTITUTED', note: expect.stringMatching(/^Mathematics today is taken by /) });
    const foreign = await parent.agent.get(`${API}/schedule/effective?studentId=${other.student.studentId}&date=${t.monday}`);
    expect(foreign.status).toBe(404);
    expect((await parent.agent.get(`${API}/schedule/effective?sectionId=${t.sections.A}&date=${t.monday}`)).status).toBe(403);
    expect((await parent.agent.get(`${API}/daily-schedule?planId=${t.planId}`)).status).toBe(403);
    expect((await parent.agent.post(`${API}/timetable-overrides`).send({ type: 'CLASS_CANCELLED', entryId: t.lessons.monAMath, date: t.monday, reason: 'x' })).status).toBe(403);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'PARENT_ACCESS_DENIED' })).toBe(1);

    // Faculty see the published timetable (their own week, a section, a room) and never a draft.
    const rev = ok<TimetableVersionDTO>(await t.send('post', `/timetable-versions/${t.versionId}/clone`, {}), 201);
    const faculty = await loginAs(t, 'FACULTY', t.maths);
    const week = ok<EffectiveScheduleDTO>(await t.send('get', `/schedule/effective?employeeId=me&from=${t.monday}&to=${t.tuesday}`, {}, faculty.agent));
    expect(week.target).toMatchObject({ kind: 'employee', id: t.maths.employeeId });
    expect(week.days.map((d) => d.items.length)).toEqual([3, 1]);
    expect(ok<EffectiveScheduleDTO>(await t.send('get', `/timetable/section/${t.sections.A}?date=${t.monday}`, {}, faculty.agent)).days).toHaveLength(6);
    expect((await t.send('get', `/timetable/section/${t.sections.A}?versionId=${rev.versionId}`, {}, faculty.agent)).status).toBe(404);
    expect((await t.send('get', `/timetable-versions/${rev.versionId}`, {}, faculty.agent)).status).toBe(404);
    // An admin can view the draft's weekly lessons in the same shape.
    const draft = ok<EffectiveScheduleDTO>(await t.send('get', `/timetable/section/${t.sections.A}?versionId=${rev.versionId}&date=${t.monday}`));
    expect(draft.days[0]!.items.map((i) => i.state)).toEqual(['NORMAL', 'NORMAL']);
    expect(ok<EffectiveScheduleDTO>(await t.send('get', `/timetable/teacher/${t.maths.employeeId}?date=${t.monday}&week=false`)).days).toHaveLength(1);
    expect((ok<EffectiveScheduleDTO>(await t.send('get', `/timetable/space/${t.rooms.A}?date=${t.monday}&week=false`)).days[0]!.free).length).toBe(5);
  });
});

describe('reports, overview and security (TT-45 to 51)', () => {
  it('QA TT-45: each report matches what is placed, says which version it is based on, exports as CSV (audited, spreadsheet-safe) and is for people with the report permission', async () => {
    const t = await publishedSchool();
    ok(await sub(t, t.lessons.monAMath, t.monday, t.spare.employeeId, { reason: '=HYPERLINK("http://x")' }), 201);
    const report = async (type: string, query = '') => ok<TimetableReportDTO>(await t.send('get', `/timetable/reports/${type}?planId=${t.planId}${query}`));
    const sections = await report('section-coverage');
    expect(sections.basis).toBe(`Version 1 · Published · from ${new Date(`${today()}T00:00:00Z`).getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][new Date(`${today()}T00:00:00Z`).getUTCMonth()]} ${today().slice(0, 4)}`);
    expect(sections.rows.map((r) => [r.section, r.needed, r.placed, r.left, r.status])).toEqual([['8-A', 11, 3, 8, '8 periods missing'], ['8-B', 11, 2, 9, '9 periods missing'], ['8-C', 11, 2, 9, '9 periods missing']]);
    expect((await report('subject-coverage')).rows.map((r) => [r.subject, r.needed, r.placed, r.left])).toEqual([['Mathematics', 18, 4, 14], ['Science', 15, 3, 12]].map((r) => r));
    const workload = await report('teacher-workload');
    expect(workload.rows.find((r) => r.teacher === t.maths.fullName)).toMatchObject({ week: 4, MON: 3, TUE: 1, sections: 3 });
    const rooms = await report('room-utilization');
    expect(rooms.rows.find((r) => r.room === 'Room 101')).toMatchObject({ booked: 3, free: 39, capacity: 40 });
    const unplaced = await report('unplaced-requirements');
    expect(unplaced.rows).toHaveLength(6);
    expect(unplaced.rows[0]).toMatchObject({ lesson: '8-A', subject: 'Mathematics', left: 4 });
    expect((await report('conflict-overrides')).rows).toEqual([]);
    const history = await report('substitution-history', `&dateFrom=${t.monday}&dateTo=${t.monday}`);
    expect(history.rows).toEqual([expect.objectContaining({ date: t.monday, lesson: '8-A Mathematics', substitute: t.spare.fullName, status: 'In place' })]);

    const csv = await t.agent.get(`${API}/timetable/reports/substitution-history?planId=${t.planId}&dateFrom=${t.monday}&dateTo=${t.monday}&format=csv`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'timetable_report', action: 'timetable_report.exported' })).toBe(1);

    const faculty = await loginAs(t, 'FACULTY', t.maths);
    expect((await t.send('get', `/timetable/reports/section-coverage?planId=${t.planId}`, {}, faculty.agent)).status).toBe(403);
    const front = await staffWith(t, ['FRONT_OFFICE']);
    expect((await t.send('get', `/timetable/reports/section-coverage?planId=${t.planId}`, {}, front.agent)).status).toBe(200);
    expect((await t.send('get', `/daily-schedule?planId=${t.planId}`, {}, front.agent)).status).toBe(200);
    expect((await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.monAMath, date: t.monday, reason: 'x' }, front.agent)).status).toBe(403);
  });

  it('QA TT-46: the overview says which version is shown, how complete it is, what today needs, and which button comes next', async () => {
    const t = await scheduleSchool();
    const get = async () => ok<TimetableOverviewDTO>(await t.send('get', `/timetable/overview?locationId=${t.moh.locationId}`));
    expect(await get()).toMatchObject({ next: 'OPEN_SCHEDULE', statusLine: 'Draft 1 · Draft', clashes: 0, needed: 33, placed: 0, coveragePercent: 0 });
    ok(await t.put(t.lesson('A', 'MATH', 'MON', 1)), 201);
    expect(await get()).toMatchObject({ next: 'REVIEW_AND_PUBLISH', placed: 1, coveragePercent: 3, ux: { unresolved: 32, manualPercent: 100, autoTeacherPercent: 100, defaultRoomPercent: 100 } });
    ok(await publish(t));
    const after = await get();
    expect(after).toMatchObject({ next: 'OPEN_DAILY_OPERATIONS', phase: 'ACTIVE', draftVersionId: null });
    expect(after.statusLine).toMatch(/^Version 1 · Published · from \d+ \w{3} \d{4}$/);
    expect(after.today).toMatchObject({ date: today(), uncovered: 0 });
    const faculty = await loginAs(t, 'FACULTY', t.maths);
    expect(ok<TimetableOverviewDTO>(await t.send('get', `/timetable/overview?locationId=${t.moh.locationId}`, {}, faculty.agent)).draftVersionId).toBeNull();
    const rev = ok<TimetableVersionDTO>(await t.send('post', `/timetable-versions/${t.versionId}/clone`, {}), 201);
    expect(await get()).toMatchObject({ next: 'REVIEW_AND_PUBLISH', draftVersionId: rev.versionId, versionName: rev.versionName });
  });

  it('QA SEC-TT-02: events are written for each step, bundles keep their limits, and another campus or another school cannot reach this timetable', async () => {
    const t = await publishedSchool();
    ok(await sub(t, t.lessons.monAMath, t.monday, t.spare.employeeId), 201);
    ok(await override(t, { type: 'ROOM_CHANGE', entryId: t.lessons.monBMath, date: t.monday, physicalSpaceId: t.rooms.spare }), 201);
    ok(await override(t, { type: 'CLASS_CANCELLED', entryId: t.lessons.monCMath, date: t.monday, reason: 'Trip' }), 201);
    ok(await t.send('post', '/faculty-absence', { planId: t.planId, employeeId: t.sci.employeeId, dateFrom: t.monday }), 201);
    const types = (await OutboxEvent.find({ tenantId: t.tenantId, type: { $regex: '^timetable\\.' } }).lean()).map((e) => e.type);
    for (const type of ['timetable.published', 'timetable.substitution.created', 'timetable.room.changed', 'timetable.class.cancelled', 'timetable.absence.recorded']) expect(types, type).toContain(type);

    // A substitution manager handles the day but cannot edit the weekly timetable; a coordinator builds but cannot publish.
    const manager = await staffWith(t, ['SUBSTITUTION_MANAGER']);
    expect((await sub(t, t.lessons.monCSci, t.monday, t.spare.employeeId, {}, manager.agent)).status).toBe(201);
    for (const res of [await t.put(t.lesson('C', 'MATH', 'WED', 1), manager.agent), await t.send('post', `/timetable-versions/${t.versionId}/clone`, {}, manager.agent), await t.send('post', `/timetable-versions/${t.versionId}/validate`, {}, manager.agent)]) expect(res.status).toBe(403);
    expect((await t.send('get', `/timetable-overrides?planId=${t.planId}&date=${t.monday}`, {}, manager.agent)).status).toBe(200);

    // A teacher at the other campus is refused with a security event; another school gets a 404.
    const away = await addActiveEmployee(t, { primaryLocationId: t.chd.locationId });
    const chd = await loginAs(t, 'STAFF', away);
    ok(await t.tt.put(`/timetable/access/${chd.userId}`, { bundles: ['SUBSTITUTION_MANAGER', 'FRONT_OFFICE'] }));
    for (const res of [await t.send('get', `/daily-schedule?planId=${t.planId}&date=${t.monday}`, {}, chd.agent), await t.send('get', `/timetable/reports/section-coverage?planId=${t.planId}`, {}, chd.agent), await t.send('post', '/faculty-absence/impact', { planId: t.planId, employeeId: t.maths.employeeId, dateFrom: t.monday }, chd.agent)]) expect(res.status).toBe(403);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: chd.userId })).toBe(3);
    const other = await scheduleSchool();
    expect((await other.send('get', `/daily-schedule?planId=${t.planId}&date=${t.monday}`)).status).toBe(404);
    expect((await other.send('post', `/timetable-versions/${t.versionId}/clone`)).status).toBe(404);
    expect((await other.send('get', `/timetable-overrides/${(await Override.findOne({ tenantId: t.tenantId }).lean())!._id}`)).status).toBe(404);
    expect(await Availability.countDocuments({ tenantId: t.tenantId })).toBe(0);
  });
});

describe('the demo school (TT-26)', () => {
  it('QA TT-63: the clean demo has Class VIII built by Smart Draft and published, with zero clashes, zero warnings, nothing unplaced, zero Needs Attention and a ready plan', async () => {
    await seedDemo({ quiet: true, clean: true });
    const tenant = (await Tenant.findOne({ slug: 'greenfield-public-school' }).lean())!;
    const admin = (await User.findOne({ tenantId: tenant._id, role: 'SCHOOL_ADMIN' }).lean())!;
    const ctx = { tenantId: tenant._id, userId: admin._id, role: 'SCHOOL_ADMIN' as const, permissions: permissionsFor('SCHOOL_ADMIN'), requestId: null };
    const plan = (await TimetablePlan.findOne({ tenantId: tenant._id }).lean())!;
    const versions = await TimetableVersion.find({ tenantId: tenant._id, planId: plan._id }).lean();
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({ status: 'PUBLISHED', publishedWarningCount: 0, publishedUnplacedCount: 0 });
    const check = await validateVersion(ctx, versions[0]!._id);
    expect(check).toMatchObject({ clashCount: 0, warningCount: 0, unplacedCount: 0, entryCount: 57, canPublish: true, needsAcknowledge: false });
    expect((await getAttention(ctx, versions[0]!._id)).total).toBe(0);
    const readiness = await planReadiness(ctx, plan._id);
    expect({ needsActions: readiness.needsActions, ready: readiness.ready }).toEqual({ needsActions: 0, ready: true });
    expect(await TimetableEntry.countDocuments({ tenantId: tenant._id })).toBe(57);
  }, 120_000);
});

describe('speed on a big school (TT-25)', () => {
  it('QA TT-64: with 36 sections a clash check, the slot map, a day of the effective schedule and the daily schedule answer quickly, and Smart Draft finishes in time (asserted loosely)', async () => {
    const t = await scheduleSchool({ draft: true });
    const addSections = async (codes: string[]) => (await t.agent.post(`${API}/class-offerings/${t.classOfferingId}/sections`).send({ codes }).expect(201)).body.data as { sectionOfferingId: string }[];
    const made = [...(await addSections('DEFGHIJKLMNOPQRSTUVWXYZ'.split(''))), ...(await addSections(Array.from({ length: 10 }, (_, i) => String(i + 1))))];
    expect(made).toHaveLength(33);
    // Eleven more Maths teachers and eleven more Science teachers, three sections each, so every section has one of each.
    for (let i = 0; i < 11; i += 1) {
      for (const subject of ['MATH', 'SCI'] as const) {
        const teacher = await addActiveEmployee(t);
        const items = made.slice(i * 3, i * 3 + 3).map((m) => ({ assignmentType: 'SUBJECT_FACULTY', sectionId: m.sectionOfferingId, subjectOfferingId: t.offerings[subject] }));
        await t.agent.post(`${API}/employees/${teacher.employeeId}/academic-assignments`).send({ items }).expect(201);
      }
    }
    const timed = async <T>(run: () => Promise<T>) => {
      const from = performance.now();
      const result = await run();
      return { result, ms: performance.now() - from };
    };

    const draft = await timed(() => t.send('post', `/timetable-versions/${t.versionId}/smart-draft`, {}));
    expect(draft.result.status, JSON.stringify(draft.result.body)).toBe(200);
    expect(draft.result.body.data).toMatchObject({ status: 'DONE', totalPeriods: 36 * 11, unresolvedCount: 0 });
    expect(draft.ms).toBeLessThan(30_000);

    const first = (await TimetableEntry.findOne({ tenantId: t.tenantId }).lean())!;
    const check = await timed(() => t.send('post', '/timetable/check', { versionId: t.versionId, ops: [{ op: 'move', entryId: first._id, weekday: 'SAT', periodId: t.p[7]! }] }));
    expect(check.result.status).toBe(200);
    const slots = await timed(() => t.send('post', '/timetable/slot-map', { versionId: t.versionId, entryId: first._id }));
    expect(slots.result.status).toBe(200);
    expect(check.ms).toBeLessThan(1_000);
    expect(slots.ms).toBeLessThan(3_000);

    ok(await publish(t));
    const date = nextDate('MON');
    const day = await timed(() => t.send('get', `/schedule/effective?sectionId=${t.sections.A}&date=${date}`));
    expect(day.result.status).toBe(200);
    const daily = await timed(() => t.send('get', `/daily-schedule?planId=${t.planId}&date=${date}`));
    expect(daily.result.status).toBe(200);
    expect(daily.result.body.data.summary.lessons).toBeGreaterThan(36 * 11 * 0.1);
    expect(day.ms).toBeLessThan(1_000);
    expect(daily.ms).toBeLessThan(1_500);
  }, 240_000);
});
