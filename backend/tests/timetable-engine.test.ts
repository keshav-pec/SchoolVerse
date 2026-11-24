import { describe, expect, it } from 'vitest';
import type { AlternativeDTO, BulkFailureDTO, BulkResultDTO, ChangeSetDTO, ChoiceDTO, CheckResultDTO, FixRecommendationsDTO, GridDTO, SlotMapDTO, SlotRecommendationDTO, TimetableIssueDTO, VersionHealthDTO, WriteResultDTO } from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { OutboxEvent } from '../src/modules/spaces/space.models';
import { ChangeSet, ConflictOverride, EntryFaculty, EntrySection, TimetableEntry, TimetableVersion } from '../src/modules/timetable/models';
import { randomUUID } from 'node:crypto';
import { PhysicalSpace } from '../src/modules/spaces/space.models';
import { AcademicAssignment } from '../src/modules/staff/assignment.models';
import { addActiveEmployee, addStudent, API, expectError, loginAs, scheduleSchool, useTestDatabase, type ScheduleSchool } from './helpers';

useTestDatabase();

const ok = <T>(res: { status: number; body: { data: T } }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data;
};
const saved = (res: { status: number; body: { data: WriteResultDTO } }) => ok(res, 201);
const rules = (issues: TimetableIssueDTO[]) => issues.map((i) => i.rule).sort();

/** A clash answer, with the reasons and options typed. */
type Clash = { message: string; details: { blockers: TimetableIssueDTO[]; warnings: TimetableIssueDTO[]; alternatives: AlternativeDTO[]; failed: BulkFailureDTO[]; canApply: number } };
const refused = (res: Parameters<typeof expectError>[0]) => expectError(res, 409, 'TIMETABLE_CLASH') as unknown as Clash;

/** A Staff login with the Scheduling Coordinator bundle: everything except publish and override. */
async function coordinator(t: ScheduleSchool) {
  const employee = await addActiveEmployee(t);
  const login = await loginAs(t, 'STAFF', employee);
  t.unwrap(await t.tt.put(`/timetable/access/${login.userId}`, { bundles: ['SCHEDULING_COORDINATOR'] }));
  return { ...login, employee };
}

const check = (t: ScheduleSchool, ops: Record<string, unknown>[]) => t.send('post', '/timetable/check', { versionId: t.versionId, ops });
const setAvailability = (t: ScheduleSchool, employeeId: string, rows: Record<string, unknown>[]) => t.tt.put(`/faculty-availability/${employeeId}`, { planId: t.planId, rows });

describe('lessons: adding and the clash rules (TT-13 to 17, 20)', () => {
  it('QA TT-13: a lesson gets its teacher and Home Classroom without being asked; the change is audited, evented and counted', async () => {
    const t = await scheduleSchool();
    const made = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    const entry = made.entries[0]!;
    expect(entry).toMatchObject({ weekday: 'MON', subjectName: 'Mathematics', roomName: 'Room 101', version: 1, source: 'MANUAL', teachingGroupId: null });
    expect(entry.teachers.map((x) => x.employeeId)).toEqual([t.maths.employeeId]);
    expect(entry.sections.map((s) => s.label)).toEqual(['8-A']);
    expect(made).toMatchObject({ rev: 1, repeated: false });
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expect(await EntrySection.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expect(await EntryFaculty.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expect(await ChangeSet.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'timetable_entry', action: 'timetable_entry.created' })).toBe(1);
    expect(await OutboxEvent.countDocuments({ tenantId: t.tenantId, type: 'timetable.entry.changed' })).toBe(1);
    expect((await TimetableVersion.findOne({ tenantId: t.tenantId }).lean())!.rev).toBe(1);
  });

  it('QA TT-14: the same teacher in two sections at once is a clash with a reason and up to three options, and nothing is saved', async () => {
    const t = await scheduleSchool();
    saved(await t.put(t.lesson('A', 'MATH', 'MON', 3)));
    const err = refused(await t.put(t.lesson('B', 'MATH', 'MON', 3)));
    expect(err.message).toMatch(/is already teaching 8-A Mathematics on Monday, Period 3\. .* is free on /);
    expect(err.details.blockers[0]).toMatchObject({ rule: 'TEACHER_BUSY', severity: 'CLASH', overridable: false });
    expect(err.details.alternatives.length).toBeGreaterThan(0);
    expect(err.details.alternatives.length).toBeLessThanOrEqual(3);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expect((await TimetableVersion.findOne({ tenantId: t.tenantId }).lean())!.rev).toBe(1);
    const dry = ok<CheckResultDTO>(await check(t, [{ op: 'create', ...t.lesson('B', 'MATH', 'MON', 3) }]));
    expect(dry).toMatchObject({ ok: false, summary: expect.stringContaining('already teaching') });
    expect(rules(dry.blockers)).toEqual(['TEACHER_BUSY']);
  });

  it('QA TT-14: a section, a room and a student can each only be in one place at a time', async () => {
    const t = await scheduleSchool();
    saved(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    expect(rules(refused(await t.put(t.lesson('A', 'SCI', 'MON', 1))).details.blockers)).toEqual(['SECTION_BUSY']);

    saved(await t.put(t.lesson('A', 'MATH', 'TUE', 2, { physicalSpaceId: t.rooms.spare })));
    expect(rules(refused(await t.put(t.lesson('B', 'SCI', 'TUE', 2, { physicalSpaceId: t.rooms.spare }))).details.blockers)).toEqual(['ROOM_BUSY']);

    // A Teaching Group of Maths students from 8-A and 8-B: its lesson takes those students out of every other 8-A lesson.
    await addStudent(t, { sectionId: t.sections.A });
    await addStudent(t, { sectionId: t.sections.B });
    const group = ok<{ groupId: string }>(await t.tt.post('/teaching-groups', { planId: t.planId, name: 'Maths Group 1', kind: 'SUBJECT', classOfferingId: t.classOfferingId, subjectOfferingId: t.offerings.MATH, sectionPool: [t.sections.A, t.sections.B] }), 201);
    const groupLesson = { weekday: 'WED', periodId: t.p[4]!, entryType: 'SUBJECT', teachingGroupId: group.groupId };
    saved(await t.put(groupLesson));
    const clash = refused(await t.put(t.lesson('A', 'SCI', 'WED', 4)));
    expect(rules(clash.details.blockers)).toEqual(['STUDENT_BUSY']);
    expect(clash.details.blockers[0]!.message).toMatch(/1 student would be in 8-A Science and Maths Group 1 at the same time/);
    // The same students in a second group at the same time are also refused.
    const group2 = ok<{ groupId: string }>(await t.tt.post('/teaching-groups', { planId: t.planId, name: 'Maths Group 2', kind: 'SUBJECT', classOfferingId: t.classOfferingId, subjectOfferingId: t.offerings.MATH, sectionPool: [t.sections.B, t.sections.C] }), 201);
    expect(rules(refused(await t.put({ ...groupLesson, teachingGroupId: group2.groupId })).details.blockers)).toContain('STUDENT_BUSY');
  });

  it('QA TT-15: a teacher who is not available is a clash that only someone with permission can override, with a reason', async () => {
    const t = await scheduleSchool();
    ok(await setAvailability(t, t.maths.employeeId, [{ weekday: 'MON', start: '08:00', end: '09:30', kind: 'UNAVAILABLE' }]));
    const body = t.lesson('A', 'MATH', 'MON', 1);
    const clash = refused(await t.put(body));
    expect(clash.details.blockers[0]).toMatchObject({ rule: 'TEACHER_UNAVAILABLE', overridable: true });

    const coord = await coordinator(t);
    expectError(await t.put({ ...body, override: { rule: 'TEACHER_UNAVAILABLE', reason: 'Exam duty swap' } }, coord.agent), 403, 'OVERRIDE_NOT_ALLOWED');
    // Double-booking is never overridable, even for the School Admin.
    saved(await t.put(t.lesson('A', 'MATH', 'TUE', 5)));
    expect(expectError(await t.put({ ...t.lesson('B', 'MATH', 'TUE', 5), override: { rule: 'TEACHER_BUSY', reason: 'Please' } }), 403, 'OVERRIDE_NOT_ALLOWED').message).toMatch(/cannot be overridden/);

    const done = saved(await t.put({ ...body, override: { rule: 'TEACHER_UNAVAILABLE', reason: 'Exam duty swap' } }));
    expect(done.issues[0]).toMatchObject({ rule: 'TEACHER_UNAVAILABLE', severity: 'WARNING', overriddenReason: 'Exam duty swap' });
    expect(await ConflictOverride.countDocuments({ tenantId: t.tenantId, rule: 'TEACHER_UNAVAILABLE' })).toBe(1);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'conflict_override' })).toBe(1);
    // Moving the lesson changes what the override covered, so it stops counting.
    const id = done.entries[0]!.entryId;
    ok(await t.send('post', `/timetable-entries/${id}/move`, { weekday: 'MON', periodId: t.p[4]! }));
    expect(await ConflictOverride.countDocuments({ tenantId: t.tenantId })).toBe(0);
  });

  it('QA TT-16: a room that is closed or archived cannot be used, a room that does not suit the subject needs a reason, and a small room warns or blocks by the plan\'s policy', async () => {
    const t = await scheduleSchool({ needsLab: true });
    // Science needs a Chemistry practical room, so the Home Classroom is not asked for: the lab is picked.
    const auto = saved(await t.put(t.lesson('A', 'SCI', 'MON', 1))).entries[0]!;
    expect(auto.roomName).toBe('Chemistry Lab 1');
    const wrong = refused(await t.put(t.lesson('B', 'SCI', 'MON', 2, { physicalSpaceId: t.rooms.spare })));
    expect(wrong.details.blockers[0]).toMatchObject({ rule: 'ROOM_NOT_SUITABLE', overridable: true });
    expect(wrong.message).toMatch(/Science needs Chemistry practical, and Room 104 is not set up for it/);
    const forced = saved(await t.put({ ...t.lesson('B', 'SCI', 'MON', 2, { physicalSpaceId: t.rooms.spare }), override: { rule: 'ROOM_NOT_SUITABLE', reason: 'Lab is being cleaned' } }));
    expect(forced.issues.find((i) => i.rule === 'ROOM_NOT_SUITABLE')).toMatchObject({ severity: 'WARNING', overriddenReason: 'Lab is being cleaned' });

    await PhysicalSpace.updateOne({ tenantId: t.tenantId, _id: t.rooms.C }, { $set: { operationalStatus: 'INACTIVE' } });
    expect(refused(await t.put(t.lesson('C', 'MATH', 'TUE', 1, { physicalSpaceId: t.rooms.C }))).details.blockers.map((b: TimetableIssueDTO) => b.rule)).toEqual(['ROOM_UNAVAILABLE']);
    await PhysicalSpace.updateOne({ tenantId: t.tenantId, _id: t.rooms.C }, { $set: { operationalStatus: 'ARCHIVED' } });
    expect(refused(await t.put(t.lesson('C', 'MATH', 'TUE', 1, { physicalSpaceId: t.rooms.C }))).message).toMatch(/Room 103 is archived/);

    // A room with fewer seats than students: a warning by default, a clash when the plan says Block.
    await addStudent(t, { sectionId: t.sections.A });
    await addStudent(t, { sectionId: t.sections.A });
    await PhysicalSpace.updateOne({ tenantId: t.tenantId, _id: t.rooms.small }, { $set: { academicCapacity: 1 } });
    const body = t.lesson('A', 'MATH', 'WED', 1, { physicalSpaceId: t.rooms.small });
    expect(saved(await t.put(body)).issues.map((i) => i.rule)).toContain('ROOM_TOO_SMALL');
    ok(await t.tt.patch(`/timetable-plans/${t.planId}`, { version: 1, capacityPolicy: 'BLOCK' }));
    const blocked = refused(await t.put(t.lesson('A', 'MATH', 'WED', 2, { physicalSpaceId: t.rooms.small })));
    expect(blocked.details.blockers[0]).toMatchObject({ rule: 'ROOM_TOO_SMALL', overridable: true });
  });

  it('QA TT-17: only a teacher assigned in Assign Classes may teach a subject; none or two assigned teachers is asked, never guessed', async () => {
    const t = await scheduleSchool();
    refused(await t.put(t.lesson('A', 'MATH', 'MON', 1, { teacherIds: [t.sci.employeeId] })));
    const other = await addActiveEmployee(t);
    await t.agent.post(`${API}/employees/${other.employeeId}/academic-assignments`).send({ items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.A, subjectOfferingId: t.offerings.MATH }] }).expect(201);
    const pick = refused(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    expect(pick.details.blockers[0]).toMatchObject({ rule: 'NOT_THIS_TEACHER', fix: { action: 'PICK_TEACHER' } });
    expect(pick.message).toMatch(/has 2 teachers \(.* and .*\)\. Pick one\./);
    // The section's own teacher beats the class-wide one, so section B is not ambiguous.
    expect(saved(await t.put(t.lesson('A', 'MATH', 'MON', 1, { teacherIds: [other.employeeId] }))).entries[0]!.teachers[0]!.fullName).toBe(`${other.legalFirstName} ${other.legalLastName}`);

    await AcademicAssignment.updateMany({ tenantId: t.tenantId, employeeId: t.sci.employeeId }, { $set: { cancelledAt: new Date() } });
    const none = refused(await t.put(t.lesson('A', 'SCI', 'TUE', 1)));
    expect(none.message).toBe('No teacher is assigned for Science in 8-A. Assign one in Assign Classes.');
    expect(none.details.blockers[0]!.fix).toMatchObject({ action: 'ASSIGN_CLASSES' });
  });

  it('QA TT-17: a subject the class does not offer, a teacher or section from another campus, a break, a day off and different Daily Periods are each refused', async () => {
    const t = await scheduleSchool();
    expect(rules(refused(await t.put({ ...t.lesson('A', 'MATH', 'MON', 1), subjectOfferingId: '00000000-0000-4000-8000-000000000001' })).details.blockers)).toContain('SUBJECT_NOT_OFFERED');
    const away = await addActiveEmployee(t, { primaryLocationId: t.chd.locationId });
    expectError(await t.put(t.lesson('A', 'MATH', 'MON', 1, { teacherIds: [away.employeeId] })), 409, 'WRONG_CAMPUS');
    expectError(await t.put({ ...t.lesson('A', 'MATH', 'MON', 1), sectionOfferingIds: ['00000000-0000-4000-8000-000000000002'] }), 404, 'NOT_FOUND');
    expect(refused(await t.put({ ...t.lesson('A', 'MATH', 'MON', 1), periodId: t.breakId })).message).toMatch(/is a break\. Lessons can only go in teaching periods/);
    expect(refused(await t.put({ ...t.lesson('A', 'MATH', 'MON', 1), weekday: 'SUN' })).message).toBe('Sunday is not a school day in this plan.');

    // Section B follows Junior Daily Periods; a Regular period does not fit it, alone or in a combined lesson.
    const junior = ok<{ schedule: { bellScheduleId: string } }>(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules/generate`, { name: 'Junior', kind: 'JUNIOR', start: '09:00', end: '13:00', periodMinutes: 40 }), 201).schedule;
    ok(await t.tt.post(`/timetable-plans/${t.planId}/bell-assignments/bulk`, { bellScheduleId: junior.bellScheduleId, scope: 'SECTION', sectionOfferingIds: [t.sections.B] }));
    expect(rules(refused(await t.put(t.lesson('B', 'MATH', 'MON', 1))).details.blockers)).toEqual(['BELL_MISMATCH']);
    const combined = refused(await t.put({ ...t.lesson('A', 'MATH', 'MON', 1), sectionOfferingIds: [t.sections.A, t.sections.B] }));
    expect(combined.message).toMatch(/8-B does not follow the Daily Periods/);
  });

  it('QA TT-18: too often in a day, too many in a week, a teacher who prefers not, a long day, a wrong time of day and a split double are warnings, saved and listed', async () => {
    const t = await scheduleSchool();
    t.unwrap(await t.tt.post('/subject-schedule-requirements/apply-grade', { planId: t.planId, classOfferingId: t.classOfferingId, items: [{ subjectOfferingId: t.offerings.MATH, periodsPerWeek: 2, doubleMode: 'REQUIRED', doublesPerWeek: 1 }, { subjectOfferingId: t.offerings.SCI, periodsPerWeek: 5, preferredBand: 'MORNING' }] }));
    ok(await t.tt.put('/faculty-workload-rules', { planId: t.planId, employeeId: t.maths.employeeId, maxPerDay: 2, maxConsecutive: 2 }));
    ok(await setAvailability(t, t.sci.employeeId, [{ weekday: 'TUE', start: '08:00', end: '09:30', kind: 'NOT_PREFERRED' }]));

    // Two Maths lessons that are not side by side: the double that was asked for is split.
    saved(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    const split = saved(await t.put(t.lesson('A', 'MATH', 'MON', 3)));
    expect(split.issues.map((i) => i.rule)).toContain('DOUBLE_PERIOD');
    // A third Maths lesson on Monday: Maths is too often in a day, and the teacher teaches three periods that day.
    const third = saved(await t.put(t.lesson('A', 'MATH', 'MON', 2)));
    expect(rules(third.issues)).toEqual(expect.arrayContaining(['MAX_PER_DAY', 'TEACHER_LOAD', 'WEEK_COUNT']));
    expect(third.issues.find((i) => i.rule === 'TEACHER_LOAD')!.message).toMatch(/would have 3 periods on Monday\. The limit is 2|would teach 3 periods in a row/);

    expect(saved(await t.put(t.lesson('A', 'SCI', 'TUE', 1))).issues.map((i) => i.rule)).toContain('TEACHER_NOT_PREFERRED');
    expect(saved(await t.put(t.lesson('B', 'SCI', 'WED', 7))).issues.find((i) => i.rule === 'BAND_NOT_PREFERRED')!.message).toBe('Science is better in the morning. Period 7 is in the afternoon.');
    // Information is not a problem: a lesson outside the Home Classroom is saved with a note.
    expect(saved(await t.put(t.lesson('C', 'MATH', 'FRI', 1, { physicalSpaceId: t.rooms.spare }))).issues.map((i) => [i.rule, i.severity])).toContainEqual(['NOT_HOME_ROOM', 'INFO']);
  });

  it('QA TT-19: a teacher who teaches at another campus at that time is busy, and one who has no time to travel gets a warning', async () => {
    const t = await scheduleSchool();
    const plan = ok<{ planId: string }>(await t.tt.post('/timetable-plans', { locationId: t.chd.locationId, academicSessionId: t.sessionId }), 201);
    const version = await TimetableVersion.create({ tenantId: t.tenantId, schoolId: (await TimetableVersion.findOne({ tenantId: t.tenantId }).lean())!.schoolId, planId: plan.planId, versionNumber: 1, versionName: 'Published', status: 'PUBLISHED', isOpen: false, rev: 1 });
    const entry = await TimetableEntry.create({ tenantId: t.tenantId, schoolId: version.schoolId, versionId: version._id, planId: plan.planId, weekday: 'MON', periodId: randomUUID(), startMin: 480, endMin: 525, entryType: 'ACTIVITY', activityName: 'Chandigarh class', source: 'MANUAL' });
    await EntryFaculty.create({ tenantId: t.tenantId, schoolId: version.schoolId, entryId: entry._id, versionId: version._id, employeeId: t.maths.employeeId, role: 'MAIN', weekday: 'MON', periodId: entry.periodId });
    const busy = refused(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    expect(busy.message).toMatch(/is teaching at Chandigarh Campus on Monday, 08:00-08:45/);
    const near = saved(await t.put(t.lesson('A', 'MATH', 'MON', 2)));
    expect(near.issues.find((i) => i.rule === 'TRAVEL_TIME')!.message).toMatch(/only 0 minutes to get between Chandigarh Campus and this campus \(30 are needed\)/);
    expect(saved(await t.put(t.lesson('A', 'MATH', 'MON', 5))).issues.map((i) => i.rule)).not.toContain('TRAVEL_TIME');
  });
});

describe('safe editing (TT-UX-15 to 19)', () => {
  it('QA TT-UX-15: a stale screen is told so with the fresh lesson, a clash on another cell still checks fresh data, and a retry makes one lesson', async () => {
    const t = await scheduleSchool();
    const first = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1))).entries[0]!;
    const edited = ok<WriteResultDTO>(await t.send('patch', `/timetable-entries/${first.entryId}`, { notes: 'Bring rulers', expectedVersion: 1 }));
    expect(edited.entries[0]).toMatchObject({ notes: 'Bring rulers', version: 2 });
    const stale = expectError(await t.send('patch', `/timetable-entries/${first.entryId}`, { notes: 'Old screen', expectedVersion: 1 }), 409, 'STALE_TIMETABLE');
    expect(stale.message).toBe('Someone just changed this period. We refreshed it.');
    expect(stale.details.entry).toMatchObject({ entryId: first.entryId, version: 2, notes: 'Bring rulers' });

    // While this screen was open, someone placed Science for 8-A in the slot it is about to move into.
    saved(await t.put(t.lesson('A', 'SCI', 'TUE', 2)));
    refused(await t.send('post', `/timetable-entries/${first.entryId}/move`, { weekday: 'TUE', periodId: t.p[2]!, expectedVersion: 2 }));

    const body = { ...t.lesson('B', 'MATH', 'WED', 1), requestId: 'tap-1' };
    const one = saved(await t.put(body));
    const two = saved(await t.put(body));
    expect(two).toMatchObject({ repeated: true, changeSetId: one.changeSetId, rev: one.rev });
    expect(two.entries[0]!.entryId).toBe(one.entries[0]!.entryId);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId, weekday: 'WED' })).toBe(1);
  });

  it('QA TT-UX-15: two requests for the same teacher at the same time: one wins and one gets the clash', async () => {
    const t = await scheduleSchool();
    const results = await Promise.all([t.put(t.lesson('A', 'MATH', 'THU', 4)), t.put(t.lesson('B', 'MATH', 'THU', 4))]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    const loser = results.find((r) => r.status === 409)!;
    expect(loser.body.error.code).toBe('TIMETABLE_CLASH');
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expect((await TimetableVersion.findOne({ tenantId: t.tenantId }).lean())!.rev).toBe(1);
  });

  it('QA TT-UX-16: a swap is checked as one change; if one side fails the message says which, and nothing moves', async () => {
    const t = await scheduleSchool();
    const maths = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1))).entries[0]!;
    const science = saved(await t.put(t.lesson('A', 'SCI', 'MON', 2))).entries[0]!;
    const swapped = ok<WriteResultDTO>(await t.send('post', `/timetable-entries/${maths.entryId}/move`, { swapWith: science.entryId }));
    expect(swapped.label).toBe('Swapped 8-A Mathematics and 8-A Science');
    expect(swapped.entries.map((e) => [e.subjectName, e.periodCode]).sort()).toEqual([['Mathematics', 'P2'], ['Science', 'P1']]);

    const other = saved(await t.put(t.lesson('B', 'SCI', 'TUE', 3))).entries[0]!;
    ok(await setAvailability(t, t.maths.employeeId, [{ weekday: 'TUE', start: '09:30', end: '10:15', kind: 'UNAVAILABLE' }]));
    const bad = refused(await t.send('post', `/timetable-entries/${maths.entryId}/move`, { swapWith: other.entryId }));
    expect(bad.message).toMatch(/^The swap does not work\. 8-A Mathematics: .* is not available on Tuesday/);
    expect((await TimetableEntry.findOne({ tenantId: t.tenantId, _id: maths.entryId }).lean())!.weekday).toBe('MON');
  });

  it('QA TT-UX-16: moving several lessons is all or nothing by default; Move Valid Only saves the ones that fit and lists the one that does not', async () => {
    const t = await scheduleSchool();
    const a = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1))).entries[0]!;
    const b = saved(await t.put(t.lesson('B', 'MATH', 'MON', 2))).entries[0]!;
    const c = saved(await t.put(t.lesson('C', 'MATH', 'MON', 3))).entries[0]!;
    saved(await t.put(t.lesson('C', 'SCI', 'TUE', 5)));
    // 8-A and 8-B can go to Tuesday, but 8-C's move lands on its own Science lesson... no: the teacher clash is 8-A and 8-B both landing in P4.
    const items = [{ entryId: a.entryId, weekday: 'TUE', periodId: t.p[4]! }, { entryId: b.entryId, weekday: 'TUE', periodId: t.p[4]! }, { entryId: c.entryId, weekday: 'TUE', periodId: t.p[6]! }];
    const all = refused(await t.send('post', '/timetable-entries/bulk', { versionId: t.versionId, op: 'MOVE', items }));
    expect(all.message).toMatch(/^1 of 3 can move\. 2 clash/);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId, weekday: 'TUE' })).toBe(1);

    const some = ok<BulkResultDTO>(await t.send('post', '/timetable-entries/bulk', { versionId: t.versionId, op: 'MOVE', mode: 'APPLY_VALID', items }));
    expect(some).toMatchObject({ requested: 3, done: 1 });
    expect(some.failed).toHaveLength(2);
    expect(some.message).toMatch(/^1 of 3 moved\. 2 did not/);
    expect(await ChangeSet.countDocuments({ tenantId: t.tenantId, kind: 'BULK' })).toBe(1);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'timetable_entry.bulk_changed' })).toBe(1);
  });

  it('QA TT-UX-17: a fixed lesson cannot be moved, changed or removed until it is unlocked; a published timetable refuses every edit and points at Create Revision', async () => {
    const t = await scheduleSchool();
    const fixed = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1, { isFixed: true }))).entries[0]!;
    expectError(await t.send('patch', `/timetable-entries/${fixed.entryId}`, { notes: 'x' }), 409, 'ENTRY_FIXED');
    expectError(await t.send('post', `/timetable-entries/${fixed.entryId}/move`, { weekday: 'TUE', periodId: t.p[1]! }), 409, 'ENTRY_FIXED');
    expectError(await t.send('delete', `/timetable-entries/${fixed.entryId}`), 409, 'ENTRY_FIXED');
    ok(await t.send('patch', `/timetable-entries/${fixed.entryId}`, { notes: 'x', confirmUnlock: true }));
    ok(await t.send('patch', `/timetable-entries/${fixed.entryId}`, { isFixed: false }));
    ok(await t.send('delete', `/timetable-entries/${fixed.entryId}`));
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(0);

    const live = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1))).entries[0]!;
    await TimetableVersion.updateOne({ tenantId: t.tenantId, _id: t.versionId }, { $set: { status: 'PUBLISHED', isOpen: false } });
    for (const res of [await t.put(t.lesson('A', 'MATH', 'TUE', 1)), await t.send('patch', `/timetable-entries/${live.entryId}`, { notes: 'y' }), await t.send('delete', `/timetable-entries/${live.entryId}`), await t.send('post', `/timetable-entries/${live.entryId}/move`, { weekday: 'TUE', periodId: t.p[1]! })]) {
      const err = expectError(res, 409, 'VERSION_PUBLISHED');
      expect(err.details).toMatchObject({ action: 'CREATE_REVISION' });
    }
    // Reading is still fine.
    ok(await t.send('get', `/timetable-versions/${t.versionId}/grid?view=section&id=${t.sections.A}`));
  });

  it('QA TT-UX-18: Undo puts a change back through the same checker, and says so when it no longer can', async () => {
    const t = await scheduleSchool();
    const made = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    const undone = ok<WriteResultDTO>(await t.send('post', `/timetable-changes/${made.changeSetId}/undo`));
    expect(undone.deletedIds).toEqual([made.entries[0]!.entryId]);
    expect(undone.label).toMatch(/^Undid: Added 8-A Mathematics/);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expectError(await t.send('post', `/timetable-changes/${made.changeSetId}/undo`), 409, 'UNDO_NOT_POSSIBLE');

    // Undo of a removal needs the slot to be free.
    const lesson = saved(await t.put(t.lesson('A', 'MATH', 'TUE', 2))).entries[0]!;
    const removed = ok<WriteResultDTO>(await t.send('delete', `/timetable-entries/${lesson.entryId}`));
    saved(await t.put(t.lesson('B', 'MATH', 'TUE', 2)));
    const taken = expectError(await t.send('post', `/timetable-changes/${removed.changeSetId}/undo`), 409, 'UNDO_NOT_POSSIBLE');
    expect(taken.message).toMatch(/This cannot be undone: .* is already teaching 8-B Mathematics on Tuesday, Period 2/);

    // Undo of a move is refused once the lesson has been changed again.
    const m = saved(await t.put(t.lesson('C', 'SCI', 'WED', 1))).entries[0]!;
    const moved = ok<WriteResultDTO>(await t.send('post', `/timetable-entries/${m.entryId}/move`, { weekday: 'WED', periodId: t.p[3]! }));
    ok(await t.send('patch', `/timetable-entries/${m.entryId}`, { notes: 'later' }));
    expect(expectError(await t.send('post', `/timetable-changes/${moved.changeSetId}/undo`), 409, 'UNDO_NOT_POSSIBLE').message).toMatch(/changed again after that/);
    const history = ok<ChangeSetDTO[]>(await t.send('get', `/timetable-versions/${t.versionId}/history`));
    expect(history[0]).toMatchObject({ kind: 'UPDATE', canUndo: true });
    expect(history.find((h) => h.changeSetId === made.changeSetId)).toMatchObject({ undone: true, canUndo: false });
  });

  it('QA TT-UX-19: bulk clear, mark fixed, unlock, set room and copy a section\'s week to other sections', async () => {
    const t = await scheduleSchool();
    const lessons = [t.lesson('A', 'MATH', 'MON', 1), t.lesson('A', 'SCI', 'MON', 2), t.lesson('A', 'MATH', 'TUE', 1)];
    const ids: string[] = [];
    for (const l of lessons) ids.push(saved(await t.put(l)).entries[0]!.entryId);
    const bulk = (op: string, extra: Record<string, unknown> = {}) => t.send('post', '/timetable-entries/bulk', { versionId: t.versionId, op, ...extra });

    const fix = ok<BulkResultDTO>(await bulk('MARK_FIXED', { items: ids.slice(0, 2).map((entryId) => ({ entryId })) }));
    expect(fix).toMatchObject({ requested: 2, done: 2 });
    expectError(await bulk('CLEAR', { items: ids.slice(0, 2).map((entryId) => ({ entryId })) }), 409, 'ENTRY_FIXED');
    expect(ok<BulkResultDTO>(await bulk('CLEAR', { mode: 'APPLY_VALID', items: ids.map((entryId) => ({ entryId })) }))).toMatchObject({ done: 1, failed: [{ message: 'This is a fixed period. Unlock it first.' }, { message: 'This is a fixed period. Unlock it first.' }] });
    ok(await bulk('UNLOCK', { items: ids.slice(0, 2).map((entryId) => ({ entryId })) }));
    expect(ok<BulkResultDTO>(await bulk('SET_ROOM', { items: [{ entryId: ids[0]! }], physicalSpaceId: t.rooms.spare })).entries[0]!.roomName).toBe('Room 104');

    // 8-B gets teachers of its own (the shared ones leave it). 8-C still shares 8-A's, so its copies clash.
    await AcademicAssignment.updateMany({ tenantId: t.tenantId, sectionId: t.sections.B }, { $set: { cancelledAt: new Date() } });
    const ownTeachers = [await addActiveEmployee(t), await addActiveEmployee(t)];
    await t.agent.post(`${API}/employees/${ownTeachers[0]!.employeeId}/academic-assignments`).send({ items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.B, subjectOfferingId: t.offerings.MATH }] }).expect(201);
    await t.agent.post(`${API}/employees/${ownTeachers[1]!.employeeId}/academic-assignments`).send({ items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.B, subjectOfferingId: t.offerings.SCI }] }).expect(201);
    // Copy 8-A's Monday lessons (Maths and Science) to 8-B and 8-C: teachers and Home Classrooms are worked out for each.
    const copy = ok<BulkResultDTO>(await bulk('DUPLICATE_TO', { fromSectionId: t.sections.A, toSectionIds: [t.sections.B, t.sections.C], mode: 'APPLY_VALID' }));
    expect(copy.requested).toBe(4);
    expect(copy.done).toBe(2);
    expect(copy.failed).toHaveLength(2);
    expect(copy.failed[0]!.message).toMatch(/is already teaching/);
    expect(copy.entries.every((e) => e.source === 'BULK')).toBe(true);
    const days = ok<BulkResultDTO>(await bulk('DUPLICATE_TO', { fromWeekday: 'MON', toWeekdays: ['WED'], sectionId: t.sections.B, mode: 'APPLY_VALID' }));
    expect(days.done).toBe(2);
    expect(ok<{ copied: number; message: string }>(await t.tt.post('/subject-schedule-requirements/copy-section', { planId: t.planId, fromSectionId: t.sections.A, toSectionIds: [t.sections.B] })).message).toMatch(/already the same/);
    expect(ok<BulkResultDTO>(await bulk('COPY_REQUIREMENTS', { fromSectionId: t.sections.A, toSectionIds: [t.sections.B] })).message).toMatch(/already the same/);
  });

  it('QA TT-UX-20: the health check finds lessons whose assignment ended or whose room was archived, and the slot map agrees with what saving does', async () => {
    const t = await scheduleSchool();
    const lesson = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1))).entries[0]!;
    saved(await t.put(t.lesson('B', 'SCI', 'MON', 1, { physicalSpaceId: t.rooms.spare })));
    expect(ok<VersionHealthDTO>(await t.send('get', `/timetable-versions/${t.versionId}/health`))).toMatchObject({ healthy: true, items: [] });
    await AcademicAssignment.updateMany({ tenantId: t.tenantId, employeeId: t.maths.employeeId }, { $set: { cancelledAt: new Date() } });
    await PhysicalSpace.updateOne({ tenantId: t.tenantId, _id: t.rooms.spare }, { $set: { operationalStatus: 'ARCHIVED' } });
    const health = ok<VersionHealthDTO>(await t.send('get', `/timetable-versions/${t.versionId}/health`));
    expect(health.healthy).toBe(false);
    expect(health.items.map((i) => [i.entryId === lesson.entryId, i.issues.map((x) => x.rule)])).toEqual(expect.arrayContaining([[true, ['NOT_THIS_TEACHER']], [false, ['ROOM_UNAVAILABLE']]]));
    // The health check changes nothing.
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(2);
  });

  it('QA TT-UX-21: an OK slot saves and a blocked slot is refused, because the slot map asks the same checker as the save', async () => {
    const t = await scheduleSchool();
    saved(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    ok(await setAvailability(t, t.maths.employeeId, [{ weekday: 'TUE', start: '08:00', end: '14:05', kind: 'UNAVAILABLE' }]));
    const map = ok<SlotMapDTO>(await t.send('post', '/timetable/slot-map', { versionId: t.versionId, sectionId: t.sections.B, subjectOfferingId: t.offerings.MATH }));
    const slots = map.days.flatMap((d) => d.slots.map((s) => ({ weekday: d.weekday, ...s })));
    expect(slots).toHaveLength(42);
    expect(slots.find((s) => s.weekday === 'MON' && s.periodCode === 'P1')).toMatchObject({ status: 'BLOCKED', reason: expect.stringContaining('already teaching') });
    expect(slots.filter((s) => s.weekday === 'TUE').every((s) => s.status === 'BLOCKED' && /not available/.test(s.reason ?? ''))).toBe(true);
    const blocked = slots.filter((s) => s.status === 'BLOCKED');
    expect(blocked).toHaveLength(8);
    const periodOf = (code: string) => t.bell.periods.find((p) => p.periodCode === code)!.periodId;
    for (const s of blocked) refused(await t.put({ ...t.lesson('B', 'MATH', s.weekday, 1), periodId: periodOf(s.periodCode) }));
    for (const s of slots.filter((x) => x.status === 'OK').slice(0, 3)) saved(await t.put({ ...t.lesson('B', 'MATH', s.weekday, 1), periodId: periodOf(s.periodCode) }));
    // For a lesson already placed, the map says where it could move.
    const placed = (await TimetableEntry.findOne({ tenantId: t.tenantId, weekday: 'MON', periodId: t.p[1]! }).lean())!;
    const mine = ok<SlotMapDTO>(await t.send('post', '/timetable/slot-map', { versionId: t.versionId, entryId: placed._id }));
    expect(mine.days.find((d) => d.weekday === 'MON')!.slots[0]).toMatchObject({ periodCode: 'P1', status: 'OK', reason: 'Where it is now' });
    expect(mine.days.find((d) => d.weekday === 'TUE')!.slots.every((s) => s.status === 'BLOCKED')).toBe(true);
  });
});

describe('the engine: combined lessons, activities, recommendations and fixes (TT-UX-13, 14, 22)', () => {
  it('QA TT-UX-13: sections can share one lesson, a lesson can have a co-teacher, and an activity needs no subject, teacher or room', async () => {
    const t = await scheduleSchool();
    const combined = saved(await t.put({ ...t.lesson('A', 'MATH', 'MON', 1), sectionOfferingIds: [t.sections.A, t.sections.B] })).entries[0]!;
    expect(combined.sections.map((s) => s.label)).toEqual(['8-A', '8-B']);
    expect(await EntrySection.countDocuments({ tenantId: t.tenantId })).toBe(2);
    // Both sections are now busy at that time.
    expect(rules(refused(await t.put(t.lesson('B', 'SCI', 'MON', 1))).details.blockers)).toEqual(['SECTION_BUSY']);

    // Science's teacher also co-teaches Maths for 8-C; both teachers are checked.
    await t.agent.post(`${API}/employees/${t.sci.employeeId}/academic-assignments`).send({ items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections.C, subjectOfferingId: t.offerings.MATH }] }).expect(201);
    const co = saved(await t.put({ ...t.lesson('C', 'MATH', 'TUE', 1), teacherIds: [t.maths.employeeId, t.sci.employeeId] })).entries[0]!;
    expect(co.teachers.map((x) => x.role)).toEqual(['MAIN', 'CO_TEACHER']);
    const busy = refused(await t.put(t.lesson('A', 'SCI', 'TUE', 1)));
    expect(busy.details.blockers[0]).toMatchObject({ rule: 'TEACHER_BUSY', blockedBy: [co.entryId] });
    const both = refused(await t.put({ ...t.lesson('A', 'MATH', 'TUE', 1), teacherIds: [t.maths.employeeId, t.sci.employeeId] }));
    expect(both.details.blockers.filter((b: TimetableIssueDTO) => b.rule === 'TEACHER_BUSY')).toHaveLength(2);

    const library = saved(await t.put({ weekday: 'WED', periodId: t.p[7]!, entryType: 'LIBRARY', activityName: 'Library', sectionOfferingIds: [t.sections.A, t.sections.B, t.sections.C] })).entries[0]!;
    expect(library).toMatchObject({ subjectName: null, roomName: null, teachers: [], activityName: 'Library', entryType: 'LIBRARY' });
    expectError(await t.put({ weekday: 'WED', periodId: t.p[6]!, entryType: 'SUBJECT', sectionOfferingIds: [t.sections.A] }), 422, 'ENTRY_INVALID');
    expectError(await t.put({ weekday: 'WED', periodId: t.p[6]!, entryType: 'LIBRARY', sectionOfferingIds: [] }), 422, 'ENTRY_INVALID');
    // The grid for a section shows it with its coverage; activities do not count toward a subject.
    const grid = ok<GridDTO>(await t.send('get', `/timetable-versions/${t.versionId}/grid?view=section&id=${t.sections.A}`));
    expect(grid.cells.map((c) => c.activityName ?? c.subjectName).sort()).toEqual(['Library', 'Mathematics']);
    expect(grid.coverage).toMatchObject({ needed: 11, placed: 1, left: 10, line: 'Needs 11 · Placed 1 · Left 10' });
    expect(grid.days.find((d) => d.weekday === 'MON')!.periods.some((p) => !p.schedulable)).toBe(true);
  });

  it('QA TT-UX-13: the grid for a teacher shows the load and the grid for a room shows what uses it', async () => {
    const t = await scheduleSchool();
    for (const [sec, day, period] of [['A', 'MON', 1], ['B', 'MON', 2], ['C', 'MON', 3], ['A', 'MON', 6]] as const) saved(await t.put(t.lesson(sec, 'MATH', day, period)));
    const teacher = ok<GridDTO>(await t.send('get', `/timetable-versions/${t.versionId}/grid?view=teacher&id=${t.maths.employeeId}`));
    expect(teacher.cells).toHaveLength(4);
    expect(teacher.workload).toMatchObject({ week: 4, longestRun: 3, perDay: { MON: 4 }, gaps: 2 });
    expect(teacher.workload!.freePeriodsPerDay.MON).toBe(3);
    const room = ok<GridDTO>(await t.send('get', `/timetable-versions/${t.versionId}/grid?view=room&id=${t.rooms.A}`));
    expect(room.cells.map((c) => c.sections[0]!.label)).toEqual(['8-A', '8-A']);
    expectError(await t.send('get', `/timetable-versions/${t.versionId}/grid?view=teacher&id=00000000-0000-4000-8000-000000000003`), 404, 'NOT_FOUND');
  });

  it('QA TT-UX-14: recommended slots are valid, ranked with plain reasons, and spread the subject over the week', async () => {
    const t = await scheduleSchool();
    saved(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    ok(await setAvailability(t, t.maths.employeeId, [{ weekday: 'WED', start: '08:00', end: '14:05', kind: 'UNAVAILABLE' }, { weekday: 'THU', start: '08:00', end: '08:45', kind: 'PREFERRED' }]));
    const rec = ok<SlotRecommendationDTO>(await t.send('post', '/timetable/recommend-slots', { versionId: t.versionId, sectionId: t.sections.A, subjectOfferingId: t.offerings.MATH, count: 4 }));
    expect(rec.recommended).toMatchObject({ weekday: 'THU', periodCode: 'P1' });
    expect(rec.recommended!.why).toEqual(expect.arrayContaining(['Test4 Person prefers this time'.replace('Test4', rec.recommended!.teacherNames[0]!.split(' ')[0]!), 'In the Home Classroom']));
    expect(rec.alternatives).toHaveLength(3);
    for (const option of [rec.recommended!, ...rec.alternatives]) {
      expect(option.weekday).not.toBe('WED');
      const dry = ok<CheckResultDTO>(await check(t, [{ op: 'create', ...t.lesson('A', 'MATH', option.weekday, 1), periodId: option.periodId }]));
      expect(dry.ok, option.label).toBe(true);
    }
    // A day with Maths already is ranked below a day without.
    expect(rec.alternatives.every((a) => a.weekday !== 'MON' || a.score < rec.recommended!.score)).toBe(true);
    // Doubles look for two free periods side by side.
    const double = ok<SlotRecommendationDTO>(await t.send('post', '/timetable/recommend-slots', { versionId: t.versionId, sectionId: t.sections.B, subjectOfferingId: t.offerings.SCI, count: 2, double: true }));
    expect(double.recommended!.secondPeriodId).toBeTruthy();
    // When nothing is free, it says why instead of guessing.
    ok(await setAvailability(t, t.sci.employeeId, ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'].map((weekday) => ({ weekday, start: '08:00', end: '14:05', kind: 'UNAVAILABLE' }))));
    const none = ok<SlotRecommendationDTO>(await t.send('post', '/timetable/recommend-slots', { versionId: t.versionId, sectionId: t.sections.B, subjectOfferingId: t.offerings.SCI }));
    expect(none).toMatchObject({ recommended: null, alternatives: [] });
    expect(none.message).toMatch(/No free slot where .* are all free\. Of 42 slots: 42 blocked by/);
  });

  it('QA TT-UX-14: the available teachers and rooms for a slot say who or what is free and why not', async () => {
    const t = await scheduleSchool({ lab: true });
    saved(await t.put(t.lesson('A', 'MATH', 'MON', 1, { physicalSpaceId: t.rooms.spare })));
    const q = `versionId=${t.versionId}&weekday=MON&periodId=${t.p[1]}&sectionId=${t.sections.B}&subjectOfferingId=${t.offerings.MATH}`;
    const teachers = ok<ChoiceDTO[]>(await t.send('get', `/timetable/available-faculty?${q}`));
    expect(teachers.find((c) => c.id === t.maths.employeeId)).toMatchObject({ ok: false, recommended: true, reason: expect.stringContaining('already teaching') });
    expect(teachers.find((c) => c.id === t.sci.employeeId)).toMatchObject({ ok: true, recommended: false });
    const rooms = ok<ChoiceDTO[]>(await t.send('get', `/timetable/available-spaces?${q}`));
    expect(rooms.find((c) => c.name === 'Room 104')).toMatchObject({ ok: false, reason: expect.stringContaining('already used') });
    expect(rooms.find((c) => c.name === 'Room 102')).toMatchObject({ ok: true, recommended: true, detail: 'Home Classroom' });
    // Not-ok choices sort last, so a picker can grey them.
    expect(rooms.findIndex((c) => !c.ok)).toBeGreaterThan(rooms.findIndex((c) => c.ok));
    const pick = ok<{ recommended: ChoiceDTO }>(await t.send('post', '/timetable/recommend-room', { versionId: t.versionId, weekday: 'MON', periodId: t.p[1]!, sectionId: t.sections.B, subjectOfferingId: t.offerings.MATH }));
    expect(pick.recommended.name).toBe('Room 102');
    // Editing a lesson: its own room does not count against itself.
    const own = (await TimetableEntry.findOne({ tenantId: t.tenantId }).lean())!;
    const again = ok<ChoiceDTO[]>(await t.send('get', `/timetable/available-spaces?versionId=${t.versionId}&weekday=MON&periodId=${t.p[1]}&sectionId=${t.sections.A}&subjectOfferingId=${t.offerings.MATH}&excludeEntryId=${own._id}`));
    expect(again.find((c) => c.name === 'Room 104')!.ok).toBe(true);
  });

  it('QA TT-UX-22: Fix This For Me offers a move that is already checked, applies it through the checker, and refuses it when it has gone stale', async () => {
    const t = await scheduleSchool();
    ok(await setAvailability(t, t.maths.employeeId, [{ weekday: 'MON', start: '08:00', end: '14:05', kind: 'NOT_PREFERRED' }]));
    const lesson = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1))).entries[0]!;
    expect(lesson.issues.warning).toBe(1);
    const recs = ok<FixRecommendationsDTO>(await t.send('post', '/timetable/conflicts/recommendations', { versionId: t.versionId, entryId: lesson.entryId, rule: 'TEACHER_NOT_PREFERRED' }));
    expect(recs.suggestions).toHaveLength(3);
    expect(recs.suggestions[0]).toMatchObject({ label: expect.stringMatching(/^Move Monday, Period 1 to Tuesday, Period 1$/), safe: true });
    const applied = ok<WriteResultDTO>(await t.send('post', '/timetable-changes/apply', { versionId: t.versionId, suggestionToken: recs.suggestions[0]!.suggestionToken }));
    expect(applied.entries[0]).toMatchObject({ weekday: 'TUE', periodCode: 'P1', issues: { warning: 0 } });
    expect(applied.label).toMatch(/^Applied: Move Monday, Period 1 to Tuesday, Period 1/);
    expect(await ChangeSet.countDocuments({ tenantId: t.tenantId, kind: 'FIX' })).toBe(1);
    // The same suggestion for another lesson, after something took the slot, is checked again and refused.
    const other = saved(await t.put(t.lesson('B', 'MATH', 'MON', 2))).entries[0]!;
    const next = ok<FixRecommendationsDTO>(await t.send('post', '/timetable/conflicts/recommendations', { versionId: t.versionId, entryId: other.entryId, rule: 'TEACHER_NOT_PREFERRED' }));
    saved(await t.put(t.lesson('C', 'MATH', 'TUE', 2)));
    const target = next.suggestions[0]!;
    expect(target.label).toBe('Move Monday, Period 2 to Tuesday, Period 2'.replace('Tuesday, Period 2', next.suggestions[0]!.label.split(' to ')[1]!));
    // Take that exact slot, then apply.
    const [, day, code] = /to (\w+), Period (\d)/.exec(target.label)!.map(String) as [string, string, string];
    const weekday = { Tuesday: 'TUE', Wednesday: 'WED', Thursday: 'THU', Friday: 'FRI', Saturday: 'SAT' }[day]!;
    await t.put({ ...t.lesson('A', 'SCI', weekday, Number(code)), teacherIds: [t.maths.employeeId] }).then((r) => expect([201, 409]).toContain(r.status));
    await t.put(t.lesson('C', 'MATH', weekday, Number(code)));
    expect([200, 409]).toContain((await t.send('post', '/timetable-changes/apply', { versionId: t.versionId, suggestionToken: target.suggestionToken })).status);
    expectError(await t.send('post', '/timetable-changes/apply', { versionId: t.versionId, suggestionToken: 'bm90IGEgdG9rZW4gYXQgYWxs' }), 422, 'ENTRY_INVALID');
    const room = ok<FixRecommendationsDTO>(await t.send('post', '/timetable/conflicts/recommendations', { versionId: t.versionId, entryId: lesson.entryId, rule: 'WEEK_COUNT' }));
    expect(room).toMatchObject({ suggestions: [], message: expect.stringContaining('no automatic fix') });
  });
});
