import { describe, expect, it } from 'vitest';
import type { AcceptGroupResultDTO, CopyPreviousResultDTO, ExplainUnplacedDTO, GenerationRunDTO, GridDTO, PreviousSessionDTO, RunItemDTO, ScheduleAttentionDTO, TimetablePlanDTO, VersionHealthDTO, WriteResultDTO } from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { SectionOffering, SubjectOffering } from '../src/modules/academic/offering.model';
import { PhysicalSpace } from '../src/modules/spaces/space.models';
import { AcademicAssignment } from '../src/modules/staff/assignment.models';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { GenerationRun, Requirement, RunItem, TimetableEntry, TimetableVersion } from '../src/modules/timetable/models';
import { smartDraftHooks } from '../src/modules/timetable/schedule/smartdraft.service';
import { addActiveEmployee, API, data, expectError, forceStatus, loginAs, scheduleSchool, useTestDatabase, type ScheduleSchool } from './helpers';

useTestDatabase();

const ok = <T>(res: { status: number; body: { data: T } }, status = 200): T => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data;
};
const saved = (res: { status: number; body: { data: WriteResultDTO } }) => ok(res, 201);

const smartDraft = (t: ScheduleSchool, body: Record<string, unknown> = {}) => t.send('post', `/timetable-versions/${t.versionId}/smart-draft`, body);
const grid = async (t: ScheduleSchool, view: string, id: string) => ok<GridDTO>(await t.send('get', `/timetable-versions/${t.versionId}/grid?view=${view}&id=${id}`));
/** Every lesson of a section as "Subject|Day|Period", so two schools can be compared without their ids. */
const weekOf = async (t: ScheduleSchool) => Object.fromEntries(await Promise.all((['A', 'B', 'C'] as const).map(async (c) => [c, (await grid(t, 'section', t.sections[c])).cells.map((x) => `${x.subjectName}|${x.weekday}|${x.periodCode}|${x.roomName}`).sort()] as const)));

describe('Smart Draft (TT-UX-08 to 11)', () => {
  it('QA TT-UX-08: it fills the whole week with no clashes, puts Science in the lab, uses each Home Classroom, and gives the same answer for the same input', async () => {
    const [one, two] = [await scheduleSchool({ needsLab: true }), await scheduleSchool({ needsLab: true })];
    const run = ok<GenerationRunDTO>(await smartDraft(one));
    expect(run).toMatchObject({ runType: 'SMART_DRAFT', status: 'DONE', mode: 'FILL_GAPS', totalRequirements: 6, totalPeriods: 33, entriesCreated: 33, unresolvedCount: 0 });
    expect(run.summary).toMatch(/^33 of 33 placed · 0 left · 0 clashes · \d+ warnings?$/);
    expect(await TimetableEntry.countDocuments({ tenantId: one.tenantId })).toBe(33);
    expect(ok<VersionHealthDTO>(await one.send('get', `/timetable-versions/${one.versionId}/health`)).healthy).toBe(true);
    for (const c of ['A', 'B', 'C'] as const) {
      const g = await grid(one, 'section', one.sections[c]);
      expect(g.coverage).toMatchObject({ needed: 11, placed: 11, left: 0 });
      expect(g.cells.filter((x) => x.subjectName === 'Science').every((x) => x.roomName === 'Chemistry Lab 1')).toBe(true);
      expect(g.cells.filter((x) => x.subjectName === 'Mathematics').every((x) => x.roomName === `Room 10${c.charCodeAt(0) - 64}`)).toBe(true);
    }
    expect(await AuditEvent.countDocuments({ tenantId: one.tenantId, action: 'generation_run.smart_draft' })).toBe(1);
    expect(await GenerationRun.countDocuments({ tenantId: one.tenantId })).toBe(1);

    ok(await smartDraft(two));
    expect(await weekOf(two)).toEqual(await weekOf(one));
    // A second run has nothing left to place and changes nothing.
    const again = ok<GenerationRunDTO>(await smartDraft(one));
    expect(again).toMatchObject({ entriesCreated: 0, unresolvedCount: 0 });
    expect(await TimetableEntry.countDocuments({ tenantId: one.tenantId })).toBe(33);
  });

  it('QA TT-UX-09: it respects fixed periods, a teacher\'s free days and double periods, and fill-gaps keeps what a person placed', async () => {
    const t = await scheduleSchool({ needsLab: true });
    t.unwrap(await t.tt.post('/subject-schedule-requirements/apply-grade', { planId: t.planId, classOfferingId: t.classOfferingId, items: [{ subjectOfferingId: t.offerings.MATH, periodsPerWeek: 6, doubleMode: 'REQUIRED', doublesPerWeek: 1 }] }));
    ok(await t.tt.put(`/faculty-availability/${t.maths.employeeId}`, { planId: t.planId, rows: [{ weekday: 'SAT', start: '08:00', end: '14:05', kind: 'UNAVAILABLE' }] }));
    const fixed = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1, { isFixed: true }))).entries[0]!;
    const manual = saved(await t.put(t.lesson('B', 'MATH', 'TUE', 5))).entries[0]!;
    const run = ok<GenerationRunDTO>(await smartDraft(t));
    expect(run.unresolvedCount).toBe(0);
    const kept = await TimetableEntry.find({ tenantId: t.tenantId, _id: { $in: [fixed.entryId, manual.entryId] } }).lean();
    expect(kept.map((e) => [e.weekday, e.isFixed]).sort()).toEqual([['MON', true], ['TUE', false]]);
    const maths = await TimetableEntry.find({ tenantId: t.tenantId, subjectOfferingId: t.offerings.MATH }).lean();
    expect(maths.some((e) => e.weekday === 'SAT')).toBe(false);
    for (const c of ['A', 'B', 'C'] as const) {
      const cells = (await grid(t, 'section', t.sections[c])).cells.filter((x) => x.subjectName === 'Mathematics');
      const double = cells.some((a) => cells.some((b) => a.weekday === b.weekday && Number(b.periodCode.slice(1)) === Number(a.periodCode.slice(1)) + 1));
      expect(double, `8-${c} has a double period`).toBe(true);
    }
    // Start fresh needs a confirmation, removes what is not fixed, and keeps the fixed lesson.
    expectError(await smartDraft(t, { mode: 'START_FRESH' }), 400, 'VALIDATION_FAILED');
    const fresh = ok<GenerationRunDTO>(await smartDraft(t, { mode: 'START_FRESH', confirm: true }));
    expect(fresh).toMatchObject({ mode: 'START_FRESH', unresolvedCount: 0 });
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId, _id: fixed.entryId })).toBe(1);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(33);
  });

  it('QA TT-UX-10: what cannot be placed is listed with a reason, a repeated request is safe, and an unready plan is refused', async () => {
    const t = await scheduleSchool();
    await AcademicAssignment.updateMany({ tenantId: t.tenantId, employeeId: t.sci.employeeId }, { $set: { cancelledAt: new Date() } });
    const run = ok<GenerationRunDTO>(await smartDraft(t, { requestId: 'draft-1' }));
    expect(run.summary).toMatch(/^18 of 33 placed · 15 left · 0 clashes/);
    expect(run.unresolved).toHaveLength(3);
    expect(run.unresolved[0]).toMatchObject({ reason: 'NO_TEACHER', remaining: 5, message: 'No teacher is assigned. Assign one in Assign Classes.' });
    const same = ok<GenerationRunDTO>(await smartDraft(t, { requestId: 'draft-1' }));
    expect(same.runId).toBe(run.runId);
    expect(await GenerationRun.countDocuments({ tenantId: t.tenantId })).toBe(1);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(18);
    expect(ok<GenerationRunDTO>(await t.send('get', `/timetable-generation-runs/${run.runId}`)).unresolvedCount).toBe(3);

    const bare = await scheduleSchool();
    await Requirement.deleteMany({ tenantId: bare.tenantId });
    const refused = expectError(await smartDraft(bare), 409, 'NOT_READY');
    expect(refused.message).toMatch(/No Subject Needs are set yet/);
  });

  it('QA TT-UX-11: if someone edits while it is working it plans again on the new state, and a time limit gives a partial run that is safe to run again', async () => {
    const t = await scheduleSchool();
    let edited = false;
    smartDraftHooks.afterPlan = async () => {
      if (edited) return;
      edited = true;
      // Someone places 8-A Maths on Monday P1 by hand after the plan was made.
      saved(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    };
    try {
      const run = ok<GenerationRunDTO>(await smartDraft(t));
      expect(run.unresolvedCount).toBe(0);
    } finally {
      smartDraftHooks.afterPlan = undefined;
    }
    expect(edited).toBe(true);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(33);
    expect(ok<VersionHealthDTO>(await t.send('get', `/timetable-versions/${t.versionId}/health`)).healthy).toBe(true);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId, weekday: 'MON', source: 'MANUAL' })).toBe(1);

    const slow = await scheduleSchool();
    process.env.SMART_DRAFT_TIME_LIMIT_MS = '1';
    let partial: GenerationRunDTO;
    try {
      partial = ok<GenerationRunDTO>(await smartDraft(slow));
    } finally {
      delete process.env.SMART_DRAFT_TIME_LIMIT_MS;
    }
    expect(partial.status).toBe('PARTIAL');
    expect(partial.unresolved.every((u) => u.reason === 'TIME_UP')).toBe(true);
    const finished = ok<GenerationRunDTO>(await smartDraft(slow));
    expect(finished).toMatchObject({ status: 'DONE', unresolvedCount: 0 });
    expect(await TimetableEntry.countDocuments({ tenantId: slow.tenantId })).toBe(33);
  });
});

describe('why a lesson is unplaced (TT-UX-12)', () => {
  it('QA TT-UX-12: the reason is worked out live: which slots are blocked by whom, and which need two things to be free', async () => {
    const t = await scheduleSchool({ operatingDays: ['MON'] });
    for (const p of [1, 2, 3]) saved(await t.put(t.lesson('B', 'MATH', 'MON', p)));
    for (const p of [3, 4, 5]) saved(await t.put(t.lesson('A', 'SCI', 'MON', p)));
    ok(await t.tt.put(`/faculty-availability/${t.maths.employeeId}`, { planId: t.planId, rows: [{ weekday: 'MON', start: '12:30', end: '14:05', kind: 'UNAVAILABLE' }] }));
    const why = ok<ExplainUnplacedDTO>(await t.send('get', `/timetable/explain-unplaced?versionId=${t.versionId}&sectionId=${t.sections.A}&subjectOfferingId=${t.offerings.MATH}`));
    const name = (await grid(t, 'teacher', t.maths.employeeId)).label;
    expect(why).toMatchObject({ needed: 6, placed: 0, left: 6, slots: 7, needTwo: 1, reasonCode: 'NO_SLOT' });
    expect(why.blockedBy).toEqual([{ kind: 'TEACHER', name, slots: 4 }, { kind: 'SECTION', name: '8-A', slots: 2 }]);
    expect(why.message).toBe(`No free slot where ${name} and 8-A are all free. Of 7 slots: 4 blocked by ${name}, 2 blocked by 8-A, the rest need two of them.`);
    expect(why.bestFix).toMatchObject({ action: 'MOVE_ENTRY', label: expect.stringMatching(/^Move .*'s Monday, Period 1 lesson \(8-B Mathematics\)$/) });
    // Still true after an edit: removing a blocker changes the counts.
    const gone = (await TimetableEntry.findOne({ tenantId: t.tenantId, periodId: t.p[1]! }).lean())!;
    ok(await t.send('delete', `/timetable-entries/${gone._id}`));
    const after = ok<ExplainUnplacedDTO>(await t.send('get', `/timetable/explain-unplaced?versionId=${t.versionId}&sectionId=${t.sections.A}&subjectOfferingId=${t.offerings.MATH}`));
    expect(after.message).toMatch(/^8-A Mathematics has 6 periods still to place, and 1 of 7 slots are free/);
    // A missing teacher is named as such.
    await AcademicAssignment.updateMany({ tenantId: t.tenantId, employeeId: t.sci.employeeId }, { $set: { cancelledAt: new Date() } });
    expect(ok<ExplainUnplacedDTO>(await t.send('get', `/timetable/explain-unplaced?versionId=${t.versionId}&sectionId=${t.sections.B}&subjectOfferingId=${t.offerings.SCI}`))).toMatchObject({ reasonCode: 'NO_TEACHER', bestFix: { action: 'ASSIGN_CLASSES' } });
  });
});

describe('Needs Attention (TT-UX-12)', () => {
  it('QA TT-UX-12: groups with stable row ids, a fix for each row and the progress line', async () => {
    const t = await scheduleSchool({ needsLab: true });
    saved(await t.put(t.lesson('A', 'MATH', 'MON', 1)));
    const science = saved(await t.put(t.lesson('B', 'SCI', 'MON', 2))).entries[0]!;
    saved(await t.put(t.lesson('C', 'MATH', 'TUE', 1, { physicalSpaceId: null })));
    ok(await t.tt.put('/faculty-workload-rules', { planId: t.planId, employeeId: t.maths.employeeId, maxPerDay: 1 }));
    saved(await t.put(t.lesson('B', 'MATH', 'MON', 3)));
    // After scheduling, Science loses its teacher and a Science lesson is left in a room that closes.
    await AcademicAssignment.updateMany({ tenantId: t.tenantId, employeeId: t.sci.employeeId }, { $set: { cancelledAt: new Date() } });
    await PhysicalSpace.updateOne({ tenantId: t.tenantId, _id: t.rooms.lab! }, { $set: { operationalStatus: 'INACTIVE' } });
    const a = ok<ScheduleAttentionDTO>(await t.send('get', `/timetable-versions/${t.versionId}/attention`));
    const b = ok<ScheduleAttentionDTO>(await t.send('get', `/timetable-versions/${t.versionId}/attention`));
    expect(b.groups.map((g) => g.rows.map((r) => r.rowId))).toEqual(a.groups.map((g) => g.rows.map((r) => r.rowId)));
    const group = (name: string) => a.groups.find((g) => g.group === name)!;
    expect(a.groups.map((g) => g.group)).toEqual(['NOT_PLACED', 'TEACHERS', 'ROOMS', 'COVERAGE', 'WORKLOAD', 'CHANGED', 'LAST_YEAR']);
    expect(group('TEACHERS').rows.map((r) => r.rowId)).toEqual(expect.arrayContaining([`health:${science.entryId}:NOT_THIS_TEACHER`, `unplaced:sec:${t.sections.C}:${t.offerings.SCI}`]));
    expect(group('ROOMS').rows.map((r) => r.rowId)).toEqual(expect.arrayContaining([`health:${science.entryId}:ROOM_UNAVAILABLE`]));
    expect(group('NOT_PLACED').rows.find((r) => r.rowId === `unplaced:sec:${t.sections.A}:${t.offerings.MATH}`)).toMatchObject({ fix: 'PLACE_SLOT', fixLabel: 'Place It There', slot: { weekday: expect.any(String), periodId: expect.any(String) }, message: expect.stringMatching(/^5 of 6 periods not placed\./) });
    expect(group('WORKLOAD').rows[0]).toMatchObject({ fix: 'APPLY_FIX', suggestionToken: expect.any(String) });
    // The fix the row offers can be applied as it is.
    ok(await t.send('post', '/timetable-changes/apply', { versionId: t.versionId, suggestionToken: group('WORKLOAD').rows[0]!.suggestionToken }));
    expect(a.progress).toBe(`${a.placed} / ${a.needed} placed · ${a.total} need attention`);
    expect(a).toMatchObject({ needed: 33, placed: 4 });
  });
});

describe("last year's timetable (TT-UX-05 to 07)", () => {
  /** Seven lessons last year, published; the session is cloned; this year has its own plan, Daily Periods (no Period 7), teachers and archived Room 104. */
  async function nextYear() {
    const t = await scheduleSchool();
    const put = async (sec: 'A' | 'B' | 'C', sub: 'MATH' | 'SCI', day: string, p: number, extra: Record<string, unknown> = {}) => saved(await t.put(t.lesson(sec, sub, day, p, extra)));
    await put('A', 'MATH', 'MON', 1);
    await put('B', 'MATH', 'TUE', 1);
    await put('A', 'SCI', 'MON', 2);
    await put('C', 'SCI', 'WED', 3);
    await put('A', 'MATH', 'TUE', 4, { physicalSpaceId: t.rooms.spare });
    await put('A', 'MATH', 'SAT', 7);
    await put('B', 'SCI', 'THU', 2);
    await TimetableVersion.updateOne({ tenantId: t.tenantId, _id: t.versionId }, { $set: { status: 'PUBLISHED', isOpen: false } });

    const next = data(await t.agent.post(`${API}/academic-sessions/${t.sessionId}/clone`).send({ name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' }).expect(201)) as { academicSessionId: string };
    await forceStatus(t.tenantId, t.sessionId, 'CLOSED');
    await forceStatus(t.tenantId, next.academicSessionId, 'ACTIVE');
    const sections = Object.fromEntries((await SectionOffering.find({ tenantId: t.tenantId, sessionId: next.academicSessionId }).lean()).map((s) => [s.sectionCode, s._id])) as Record<'A' | 'B' | 'C', string>;
    const newOfferings = await SubjectOffering.find({ tenantId: t.tenantId, sessionId: next.academicSessionId }).lean();
    const oldOfferings = await SubjectOffering.find({ tenantId: t.tenantId, sessionId: t.sessionId }).lean();
    const newOf = (oldId: string) => newOfferings.find((o) => o.subjectId === oldOfferings.find((x) => x._id === oldId)!.subjectId)!._id;
    const plan = ok<TimetablePlanDTO>(await t.tt.post('/timetable-plans', { locationId: t.moh.locationId, academicSessionId: next.academicSessionId }), 201);
    ok(await t.tt.post(`/timetable-plans/${plan.planId}/bell-schedules/generate`, { ...t.regular, end: '13:15' }), 201);
    const newSci = await addActiveEmployee(t);
    const assign = (e: { employeeId: string }, sec: 'A' | 'B' | 'C', subject: string) => t.agent.post(`${API}/employees/${e.employeeId}/academic-assignments`).send({ items: [{ assignmentType: 'SUBJECT_FACULTY', sectionId: sections[sec], subjectOfferingId: newOf(subject) }] });
    for (const c of ['A', 'B', 'C'] as const) { const r = await assign(t.maths, c, t.offerings.MATH); expect(r.status, JSON.stringify(r.body)).toBe(201); }
    expect((await assign(newSci, 'A', t.offerings.SCI)).status).toBe(201);
    for (const c of ['B', 'C'] as const) expect((await assign(t.sci, c, t.offerings.SCI)).status).toBe(201);
    await SectionOffering.updateOne({ tenantId: t.tenantId, _id: sections.C }, { $set: { status: 'INACTIVE' } });
    await PhysicalSpace.updateOne({ tenantId: t.tenantId, _id: t.rooms.spare }, { $set: { operationalStatus: 'ARCHIVED' } });
    return { t, plan, sections, newOf, newSci, copy: (mode: string) => t.send('post', `/timetable-plans/${plan.planId}/copy-previous-session`, { mode }) };
  }

  it('QA TT-UX-05: the copy says what is available and previews without saving anything', async () => {
    const { t, plan, copy } = await nextYear();
    expect(ok<PreviousSessionDTO>(await t.send('get', `/timetable-plans/${plan.planId}/previous-session`))).toMatchObject({ available: true, lessons: 7, alreadyCopied: false, message: "Last year's timetable is available: 7 lessons" });
    expect(ok<PreviousSessionDTO>(await t.send('get', `/timetable-plans/${t.planId}/previous-session`)).available).toBe(false);
    const preview = ok<CopyPreviousResultDTO>(await copy('PREVIEW'));
    expect(preview).toMatchObject({ mode: 'PREVIEW', total: 7, copied: 3, needLook: 4, needsFilled: 1, summary: expect.stringMatching(/^43% carried over\. 3 lessons copied\. 4 need a look\. Subject Needs were filled from last year for 1 class\.$/) });
    expect(preview.byReason).toEqual({ TEACHER_CHANGED: 1, SECTION_NOT_FOUND: 1, ROOM_PROBLEM: 1, PERIOD_NOT_FOUND: 1 });
    expect(await TimetableVersion.countDocuments({ tenantId: t.tenantId, planId: plan.planId })).toBe(0);
    expect(await Requirement.countDocuments({ tenantId: t.tenantId, planId: plan.planId })).toBe(0);
    expectError(await t.send('post', `/timetable-plans/${t.planId}/copy-previous-session`, { mode: 'PREVIEW' }), 409, 'COPY_NOT_AVAILABLE');
  });

  it('QA TT-UX-06: clean lessons get new ids, the rest become items with a reason and a suggestion, and a second copy is refused', async () => {
    const { t, plan, sections, newOf, newSci, copy } = await nextYear();
    // 8-B Science on Thursday P2 was already placed by hand this year, so last year's copy of it clashes.
    const draft = ok<{ versionId: string }>(await t.send('post', `/timetable-plans/${plan.planId}/versions`), 201);
    const periods = ok<{ periods: { periodId: string; schedulable: boolean }[] }[]>(await t.send('get', `/timetable-plans/${plan.planId}/bell-schedules`))[0]!.periods.filter((p) => p.schedulable);
    saved(await t.put({ weekday: 'THU', periodId: periods[1]!.periodId, sectionOfferingIds: [sections.B], subjectOfferingId: newOf(t.offerings.SCI) }, t.agent, draft.versionId));

    const done = ok<CopyPreviousResultDTO>(await copy('COMMIT'));
    expect(done).toMatchObject({ mode: 'COMMIT', total: 7, copied: 2, needLook: 5, needsFilled: 1, alreadyCopied: false });
    expect(done.summary).toMatch(/^29% carried over\. 2 lessons copied\. 5 need a look\./);
    const lessons = await TimetableEntry.find({ tenantId: t.tenantId, versionId: draft.versionId, source: 'PREVIOUS_SESSION_COPY' }).lean();
    expect(lessons).toHaveLength(2);
    const oldIds = (await TimetableEntry.find({ tenantId: t.tenantId, versionId: t.versionId }).lean()).map((e) => e._id);
    expect(lessons.every((l) => !oldIds.includes(l._id) && l.copiedFromEntryId && oldIds.includes(l.copiedFromEntryId))).toBe(true);
    expect(await Requirement.countDocuments({ tenantId: t.tenantId, planId: plan.planId, scope: 'CLASS' })).toBe(2);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'generation_run.previous_copy' })).toBe(1);

    const items = ok<RunItemDTO[]>(await t.send('get', `/timetable-versions/${draft.versionId}/run-items?status=OPEN`));
    expect(items.map((i) => i.reason).sort()).toEqual(['PERIOD_NOT_FOUND', 'ROOM_PROBLEM', 'SECTION_NOT_FOUND', 'STILL_CLASHES', 'TEACHER_CHANGED']);
    const changed = items.find((i) => i.reason === 'TEACHER_CHANGED')!;
    expect(changed).toMatchObject({ label: '8-A Science, Monday Period 2', suggestion: `Use ${newSci.legalFirstName} ${newSci.legalLastName}`, hasSuggestion: true });
    expect(items.find((i) => i.reason === 'SECTION_NOT_FOUND')!.hasSuggestion).toBe(false);

    const again = ok<CopyPreviousResultDTO>(await copy('COMMIT'));
    expect(again).toMatchObject({ alreadyCopied: true, copied: 2 });
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId, versionId: draft.versionId })).toBe(3);

    // The group buttons: the clash fails with its reason and stays open; the rest are done once, and again is safe.
    const runId = (await RunItem.findOne({ tenantId: t.tenantId }).lean())!.runId;
    const clashed = ok<AcceptGroupResultDTO>(await t.send('post', '/timetable-run-items/accept-group', { runId, reason: 'STILL_CLASHES' }));
    expect(clashed.accepted).toBe(0);
    expect(clashed.failed[0]!.message).toMatch(/already has|is already teaching/);
    const accepted = ok<{ item: RunItemDTO; result: WriteResultDTO }>(await t.send('post', `/timetable-run-items/${changed.itemId}/accept`));
    expect(accepted.item.status).toBe('ACCEPTED');
    expect(accepted.result.entries[0]!.teachers[0]!.employeeId).toBe(newSci.employeeId);
    expect(ok<{ result: WriteResultDTO | null }>(await t.send('post', `/timetable-run-items/${changed.itemId}/accept`)).result).toBeNull();
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId, versionId: draft.versionId })).toBe(4);
    expectError(await t.send('post', `/timetable-run-items/${items.find((i) => i.reason === 'SECTION_NOT_FOUND')!.itemId}/accept`), 422, 'ENTRY_INVALID');
    const room = items.find((i) => i.reason === 'ROOM_PROBLEM')!;
    expect(ok<RunItemDTO>(await t.send('post', `/timetable-run-items/${room.itemId}/dismiss`)).status).toBe('DISMISSED');
    const attention = ok<ScheduleAttentionDTO>(await t.send('get', `/timetable-versions/${draft.versionId}/attention`));
    expect(attention.groups.find((g) => g.group === 'LAST_YEAR')!.rows.map((r) => r.fix)).toEqual(['ACCEPT_MAPPING', 'ACCEPT_MAPPING', 'ACCEPT_MAPPING']);
  });
});

describe('isolation and permissions (TT-49)', () => {
  it('QA TT-49: another school gets a 404 for every id; a teacher at another campus gets a 403 and a CROSS_SCOPE_DENIED event', async () => {
    const t = await scheduleSchool();
    const lesson = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1))).entries[0]!;
    const stranger = await scheduleSchool();
    const v = t.versionId;
    for (const res of [
      await stranger.send('get', `/timetable-versions/${v}`),
      await stranger.send('get', `/timetable-versions/${v}/grid?view=section&id=${t.sections.A}`),
      await stranger.send('get', `/timetable-versions/${v}/history`),
      await stranger.send('get', `/timetable-versions/${v}/health`),
      await stranger.send('get', `/timetable-versions/${v}/attention`),
      await stranger.send('get', `/timetable-entries/${lesson.entryId}`),
      await stranger.send('patch', `/timetable-entries/${lesson.entryId}`, { notes: 'x' }),
      await stranger.send('delete', `/timetable-entries/${lesson.entryId}`),
      await stranger.send('post', `/timetable-entries/${lesson.entryId}/move`, { weekday: 'TUE', periodId: stranger.p[1]! }),
      await stranger.put(t.lesson('B', 'MATH', 'TUE', 1), stranger.agent, v),
      await stranger.send('post', `/timetable-versions/${v}/smart-draft`, {}),
      await stranger.send('post', '/timetable/check', { versionId: v, ops: [{ op: 'delete', entryId: lesson.entryId }] }),
      await stranger.send('post', '/timetable/slot-map', { versionId: v, entryId: lesson.entryId }),
      await stranger.send('post', '/timetable-entries/bulk', { versionId: v, op: 'CLEAR', items: [{ entryId: lesson.entryId }] }),
      await stranger.send('post', `/timetable-plans/${t.planId}/copy-previous-session`, { mode: 'PREVIEW' }),
    ]) expect(res.status, JSON.stringify(res.body)).toBe(404);
    expect(await TimetableEntry.countDocuments({ tenantId: t.tenantId })).toBe(1);

    const away = await addActiveEmployee(t, { primaryLocationId: t.chd.locationId });
    const chd = { ...(await loginAs(t, 'FACULTY', away)), employee: away };
    for (const res of [await t.send('get', `/timetable-versions/${v}/grid?view=section&id=${t.sections.A}`, {}, chd.agent), await t.send('get', `/timetable-entries/${lesson.entryId}`, {}, chd.agent), await t.send('get', `/timetable-versions/${v}/attention`, {}, chd.agent)]) expect(res.status).toBe(403);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: chd.userId })).toBe(3);
  });

  it('QA TT-49: Faculty may look at the schedule but never change it; a coordinator builds it but cannot override a clash', async () => {
    const t = await scheduleSchool();
    const lesson = saved(await t.put(t.lesson('A', 'MATH', 'MON', 1))).entries[0]!;
    const teacher = await addActiveEmployee(t);
    const faculty = await loginAs(t, 'FACULTY', teacher);
    expect((await t.send('get', `/timetable-versions/${t.versionId}/grid?view=teacher&id=${t.maths.employeeId}`, {}, faculty.agent)).status).toBe(200);
    expect((await t.send('get', `/timetable-versions/${t.versionId}/attention`, {}, faculty.agent)).status).toBe(200);
    for (const res of [
      await t.put(t.lesson('B', 'MATH', 'TUE', 1), faculty.agent),
      await t.send('patch', `/timetable-entries/${lesson.entryId}`, { notes: 'x' }, faculty.agent),
      await t.send('delete', `/timetable-entries/${lesson.entryId}`, {}, faculty.agent),
      await t.send('post', `/timetable-entries/${lesson.entryId}/move`, { weekday: 'TUE', periodId: t.p[1]! }, faculty.agent),
      await t.send('post', '/timetable-entries/bulk', { versionId: t.versionId, op: 'CLEAR', items: [{ entryId: lesson.entryId }] }, faculty.agent),
      await t.send('post', '/timetable/check', { versionId: t.versionId, ops: [{ op: 'delete', entryId: lesson.entryId }] }, faculty.agent),
      await t.send('post', `/timetable-versions/${t.versionId}/smart-draft`, {}, faculty.agent),
      await t.send('post', `/timetable-plans/${t.planId}/versions`, {}, faculty.agent),
      await t.send('post', `/timetable-plans/${t.planId}/copy-previous-session`, { mode: 'COMMIT' }, faculty.agent),
    ]) expect(res.status).toBe(403);

    const employee = await addActiveEmployee(t);
    const staff = await loginAs(t, 'STAFF', employee);
    t.unwrap(await t.tt.put(`/timetable/access/${staff.userId}`, { bundles: ['SCHEDULING_COORDINATOR'] }));
    saved(await t.put(t.lesson('B', 'MATH', 'TUE', 1), staff.agent));
    ok(await t.send('patch', `/timetable-entries/${lesson.entryId}`, { notes: 'by the coordinator' }, staff.agent));
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'timetable_entry', actorId: staff.userId })).toBe(2);
    t.unwrap(await t.tt.put(`/timetable/access/${staff.userId}`, { bundles: ['FRONT_OFFICE'] }));
    expect((await t.put(t.lesson('C', 'MATH', 'TUE', 2), staff.agent)).status).toBe(403);
    expect((await t.send('get', `/timetable-versions/${t.versionId}/grid?view=section&id=${t.sections.A}`, {}, staff.agent)).status).toBe(200);
  });

  it('QA TT-49: the first draft of a plan is made once, deleting a draft session takes its lessons with it, and a closed session is read-only', async () => {
    const t = await scheduleSchool({ draft: false });
    const made = ok<{ versionId: string; status: string; rev: number; versionNumber: number }>(await t.send('post', `/timetable-plans/${t.planId}/versions`, { versionName: 'Term 1' }), 201);
    expect(made).toMatchObject({ status: 'DRAFT', rev: 0, versionNumber: 1 });
    expect(expectError(await t.send('post', `/timetable-plans/${t.planId}/versions`, {}), 409, 'DRAFT_EXISTS').details.versionId).toBe(made.versionId);
    saved(await t.put(t.lesson('A', 'MATH', 'MON', 1), t.agent, made.versionId));
    expect(ok<{ entryCount: number }[]>(await t.send('get', `/timetable-plans/${t.planId}/versions`))[0]!.entryCount).toBe(1);
    // A lesson uses its period: it cannot be deleted, and removing Saturday with lessons on it names them.
    expect(expectError(await t.tt.del(`/bell-schedule-periods/${t.p[1]}`), 409, 'BELL_IN_USE').message).toMatch(/1 lesson uses this period/);
    saved(await t.put(t.lesson('A', 'SCI', 'SAT', 2), t.agent, made.versionId));
    const blocked = expectError(await t.tt.patch(`/timetable-plans/${t.planId}`, { version: 1, operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] }), 409, 'OPERATING_DAY_IN_USE');
    expect(blocked.message).toBe('1 lesson is on Saturday. Clear them first.');
    await forceStatus(t.tenantId, t.sessionId, 'CLOSED');
    expectError(await t.put(t.lesson('B', 'MATH', 'TUE', 1), t.agent, made.versionId), 409, 'SESSION_READ_ONLY');
    ok(await t.send('get', `/timetable-versions/${made.versionId}/grid?view=section&id=${t.sections.A}`));
  });
});
