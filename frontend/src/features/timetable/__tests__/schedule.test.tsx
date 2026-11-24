import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import type {
  AlternativeDTO,
  BellResolutionDTO,
  CheckResultDTO,
  GridCellDTO,
  GridDTO,
  PreviousSessionDTO,
  RunItemDTO,
  ScheduleAttentionDTO,
  TimetablePlanDTO,
  TimetableReadinessDTO,
  TimetableVersionDTO,
  Weekday,
  WriteResultDTO,
} from '@shared';
import { CLASS_OFFERING_ID, LOCATION_ID, SECTION_A_ID, SESSION_ID, academicSession, masterLocation } from '@/test/fixtures';
import { API, Ready, mockApi, renderWithApp, type MockResponse } from '@/test/utils';
import { RequireTimetableSchedule } from '@/routes/guards';
import { TimetableLayout } from '../context';
import { AttentionPage } from '../schedule/attention-page';
import { SchedulePage } from '../schedule/schedule-page';

const PLAN_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const VERSION_ID = 'a2a2a2a2-0000-4000-8000-000000000002';
const SUBJECT_MATH = 'c1c1c1c1-0000-4000-8000-000000000001';
const SUBJECT_SCI = 'c2c2c2c2-0000-4000-8000-000000000002';
const TEACHER_1 = 'd1d1d1d1-0000-4000-8000-000000000001';
const TEACHER_2 = 'd2d2d2d2-0000-4000-8000-000000000002';
const ENTRY_MATH = 'e1e1e1e1-0000-4000-8000-000000000001';
const ENTRY_SCI = 'e2e2e2e2-0000-4000-8000-000000000002';
const ENTRY_FIXED = 'e3e3e3e3-0000-4000-8000-000000000003';

type Handlers = Record<string, MockResponse | ((r: { url: URL; method: string; body: unknown }) => MockResponse | undefined)>;

const plan: TimetablePlanDTO = {
  planId: PLAN_ID,
  locationId: LOCATION_ID,
  locationName: 'Mohali Campus',
  academicSessionId: SESSION_ID,
  sessionName: '2026-27',
  planName: '2026-27 · Mohali Campus',
  effectiveFrom: '2026-04-01',
  effectiveTo: '2027-03-31',
  operatingDays: ['MON', 'TUE'],
  defaultBellScheduleId: 'b1',
  capacityPolicy: 'WARN',
  transitionMinutes: 30,
  defaultMaxPerDay: null,
  defaultMaxConsecutive: null,
  defaultMaxPerWeek: null,
  status: 'DRAFT',
  version: 1,
};

const version: TimetableVersionDTO = { versionId: VERSION_ID, planId: PLAN_ID, versionNumber: 1, versionName: 'Draft 1', sourceVersionId: null, status: 'DRAFT', rev: 3, entryCount: 3, effectiveFrom: null, effectiveTo: null, publishedAt: null, createdAt: '2026-04-01T00:00:00.000Z' };

const period = (n: number, startMin: number, endMin: number, schedulable = true) => ({
  periodId: `p${n}`,
  periodCode: `P${n}`,
  periodName: schedulable ? `Period ${n}` : 'Short Break',
  start: `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`,
  end: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`,
  startMin,
  endMin,
  schedulable,
});
const periods = [period(1, 480, 525), period(2, 525, 570), period(3, 570, 585, false), period(4, 585, 630)];

const cell = (entryId: string, weekday: Weekday, p: ReturnType<typeof period>, subject: string, teacher: string, over: Partial<GridCellDTO> = {}): GridCellDTO => ({
  entryId,
  versionId: VERSION_ID,
  weekday,
  periodId: p.periodId,
  periodCode: p.periodCode,
  periodName: p.periodName,
  startMin: p.startMin,
  endMin: p.endMin,
  start: p.start,
  end: p.end,
  entryType: 'SUBJECT',
  subjectOfferingId: subject === 'Mathematics' ? SUBJECT_MATH : SUBJECT_SCI,
  subjectName: subject,
  activityName: null,
  teachingGroupId: null,
  groupName: null,
  physicalSpaceId: 'room-1',
  roomName: 'Room 101',
  sections: [{ sectionOfferingId: SECTION_A_ID, label: '8-A' }],
  teachers: [{ employeeId: teacher === 'Rakesh Sharma' ? TEACHER_1 : TEACHER_2, fullName: teacher, role: 'MAIN' }],
  isFixed: false,
  source: 'MANUAL',
  notes: null,
  version: 1,
  rev: 3,
  issues: { clash: 0, warning: 0, info: 0 },
  issueList: [],
  ...over,
});

const grid = (cells: GridCellDTO[] = [cell(ENTRY_MATH, 'MON', periods[0]!, 'Mathematics', 'Rakesh Sharma'), cell(ENTRY_SCI, 'MON', periods[1]!, 'Science', 'Meena Rao')]): GridDTO => ({
  versionId: VERSION_ID,
  rev: 3,
  view: 'section',
  targetId: SECTION_A_ID,
  label: '8-A',
  status: 'DRAFT',
  days: [
    { weekday: 'MON', label: 'Monday', periods },
    { weekday: 'TUE', label: 'Tuesday', periods },
  ],
  cells,
  coverage: {
    needed: 11,
    placed: 2,
    left: 9,
    line: 'Needs 11 · Placed 2 · Left 9',
    rows: [
      { key: `sec:${SECTION_A_ID}:${SUBJECT_MATH}`, kind: 'SECTION', sectionOfferingId: SECTION_A_ID, sectionLabel: '8-A', teachingGroupId: null, groupName: null, subjectOfferingId: SUBJECT_MATH, subjectName: 'Mathematics', needed: 6, placed: 1, left: 5, over: 0 },
      { key: `sec:${SECTION_A_ID}:${SUBJECT_SCI}`, kind: 'SECTION', sectionOfferingId: SECTION_A_ID, sectionLabel: '8-A', teachingGroupId: null, groupName: null, subjectOfferingId: SUBJECT_SCI, subjectName: 'Science', needed: 5, placed: 1, left: 4, over: 0 },
    ],
  },
  workload: null,
});

const write = (over: Partial<WriteResultDTO> = {}): WriteResultDTO => ({ rev: 4, changeSetId: 'cs-1', label: 'Moved 8-A Mathematics from Monday, Period 1 to Tuesday, Period 1', issues: [], entries: [], deletedIds: [], repeated: false, ...over });

const attention = (over: Partial<ScheduleAttentionDTO> = {}): ScheduleAttentionDTO => ({
  versionId: VERSION_ID,
  rev: 3,
  total: 2,
  needed: 11,
  placed: 2,
  progress: '2 / 11 placed · 2 need attention',
  groups: [
    {
      group: 'NOT_PLACED',
      label: 'Not Placed',
      count: 1,
      rows: [{ rowId: `unplaced:sec:${SECTION_A_ID}:${SUBJECT_MATH}`, title: '8-A Mathematics', message: '5 of 6 periods not placed. Rakesh Sharma and 8-A are free', fix: 'PLACE_SLOT', fixLabel: 'Place It There', entryId: null, sectionOfferingId: SECTION_A_ID, subjectOfferingId: SUBJECT_MATH, teachingGroupId: null, employeeId: null, runItemId: null, slot: { weekday: 'TUE', periodId: 'p2', label: 'Tuesday, Period 2' }, suggestionToken: null }],
    },
    { group: 'TEACHERS', label: 'Teachers', count: 0, rows: [] },
    { group: 'ROOMS', label: 'Rooms', count: 0, rows: [] },
    { group: 'COVERAGE', label: 'Coverage', count: 0, rows: [] },
    { group: 'WORKLOAD', label: 'Workload', count: 0, rows: [] },
    { group: 'CHANGED', label: 'Changed Since You Scheduled', count: 0, rows: [] },
    {
      group: 'LAST_YEAR',
      label: "Last Year's Timetable",
      count: 2,
      rows: [
        { rowId: 'item:i1', title: '8-A Science, Monday Period 2', message: 'Meena Rao no longer teaches this. Use Neelam Das', fix: 'ACCEPT_MAPPING', fixLabel: 'Accept', entryId: null, sectionOfferingId: null, subjectOfferingId: null, teachingGroupId: null, employeeId: null, runItemId: 'i1', slot: null, suggestionToken: null },
        { rowId: 'item:i2', title: '8-B Science, Tuesday Period 2', message: 'Meena Rao no longer teaches this. Use Neelam Das', fix: 'ACCEPT_MAPPING', fixLabel: 'Accept', entryId: null, sectionOfferingId: null, subjectOfferingId: null, teachingGroupId: null, employeeId: null, runItemId: 'i2', slot: null, suggestionToken: null },
      ],
    },
  ],
  ...over,
});

const readiness = (over: Partial<TimetableReadinessDTO> = {}): TimetableReadinessDTO => ({
  planId: PLAN_ID,
  ready: true,
  needsActions: 0,
  message: 'Ready to build',
  areas: [],
  canSmartDraft: true,
  smartDraftBlockedBy: [],
  counts: { sections: 36, teachers: 42, homeClassrooms: 35, specialRooms: 8, subjects: 12 },
  ...over,
});

const resolution: BellResolutionDTO = { planId: PLAN_ID, operatingDays: plan.operatingDays, rows: [{ sectionOfferingId: SECTION_A_ID, classOfferingId: CLASS_OFFERING_ID, label: '8-A', className: 'Class VIII', byDay: {}, missingDays: [] }], missing: [] };
const previousNone: PreviousSessionDTO = { available: false, previousSessionId: null, previousSessionName: null, versionId: null, lessons: 0, message: 'No earlier session.', alreadyCopied: false };
const slotMapAll = (statuses: Record<string, 'OK' | 'WARNING' | 'BLOCKED'>) => ({
  versionId: VERSION_ID,
  rev: 3,
  days: (['MON', 'TUE'] as Weekday[]).map((weekday) => ({ weekday, slots: periods.filter((p) => p.schedulable).map((p) => ({ periodId: p.periodId, periodCode: p.periodCode, status: statuses[`${weekday}|${p.periodId}`] ?? 'OK', reason: statuses[`${weekday}|${p.periodId}`] === 'BLOCKED' ? 'Rakesh Sharma is teaching 8-B' : null })) })),
});

function base(extra: Handlers = {}): Handlers {
  return {
    [`GET ${API}/academic-sessions`]: { data: [academicSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation] },
    [`GET ${API}/timetable-plans`]: { data: [plan] },
    [`GET ${API}/timetable-plans/${PLAN_ID}/versions`]: { data: [version] },
    [`GET ${API}/timetable-versions/${VERSION_ID}`]: { data: version },
    [`GET ${API}/timetable-versions/${VERSION_ID}/grid`]: { data: grid() },
    [`GET ${API}/timetable-versions/${VERSION_ID}/attention`]: { data: attention() },
    [`GET ${API}/timetable-versions/${VERSION_ID}/run-items`]: { data: [] },
    [`GET ${API}/timetable-plans/${PLAN_ID}/bell-resolution`]: { data: resolution },
    [`GET ${API}/timetable-plans/${PLAN_ID}/teachers`]: { data: [] },
    [`GET ${API}/teaching-groups`]: { data: [] },
    [`GET ${API}/timetable-plans/${PLAN_ID}/previous-session`]: { data: previousNone },
    [`GET ${API}/timetable-plans/${PLAN_ID}/readiness`]: { data: readiness() },
    [`POST ${API}/timetable/recommend-slots`]: { data: { recommended: { weekday: 'TUE', periodId: 'p1', periodCode: 'P1', label: 'Tuesday, Period 1', why: ['Rakesh Sharma and 8-A are free'], warnings: [], teacherNames: ['Rakesh Sharma'], roomName: 'Room 101', score: 100, secondPeriodId: null }, alternatives: [{ weekday: 'TUE', periodId: 'p2', periodCode: 'P2', label: 'Tuesday, Period 2', why: [], warnings: [], teacherNames: [], roomName: null, score: 90, secondPeriodId: null }], message: null } },
    ...extra,
  };
}

function renderAt(route: string) {
  return renderWithApp(
    <Ready>
      <Toaster />
      <Routes>
        <Route path="/restricted" element={<p>Restricted page</p>} />
        <Route element={<RequireTimetableSchedule />}>
          <Route element={<TimetableLayout />}>
            <Route path="/timetable/schedule" element={<SchedulePage />} />
            <Route path="/timetable/attention" element={<AttentionPage />} />
          </Route>
        </Route>
      </Routes>
    </Ready>,
    { route },
  );
}

const lesson = (name: RegExp) => screen.findByRole('button', { name });
const dt = { dataTransfer: { setData: () => undefined, effectAllowed: '' } };

describe('Start page (TT-UX-05 to 08)', () => {
  it('(TT-UX-05) with no draft it shows Reuse Last Year with its preview, Prepare Smart Draft with what it will use, and a small Start Empty link', async () => {
    mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable-plans/${PLAN_ID}/versions`]: { data: [] },
      [`GET ${API}/timetable-plans/${PLAN_ID}/previous-session`]: { data: { ...previousNone, available: true, lessons: 1496, message: "Last year's timetable is available: 1,496 lessons" } },
      [`POST ${API}/timetable-plans/${PLAN_ID}/copy-previous-session`]: { data: { mode: 'PREVIEW', total: 100, copied: 91, needLook: 9, byReason: {}, needsFilled: 0, summary: '91% carried over. 91 lessons copied. 9 need a look.', alreadyCopied: false, runId: null, rev: null } },
    }));
    renderAt('/timetable/schedule');
    expect(await screen.findByRole('heading', { name: /Reuse Last Year/ })).toBeInTheDocument();
    expect(await screen.findByTestId('copy-preview')).toHaveTextContent('91% carried over. 91 lessons copied. 9 need a look.');
    expect(await screen.findByTestId('smart-uses')).toHaveTextContent('36 sections, 42 teachers, 35 Home Classrooms, 8 special rooms');
    expect(screen.getByRole('button', { name: 'Start Empty' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('(TT-UX-08) if setup is not ready it shows the exact actions instead and Smart Draft stays off', async () => {
    mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable-plans/${PLAN_ID}/versions`]: { data: [] },
      [`GET ${API}/timetable-plans/${PLAN_ID}/readiness`]: { data: readiness({ ready: false, canSmartDraft: false, smartDraftBlockedBy: ['Time is not ready: fix the Daily Periods first.'], areas: [{ area: 'TIME', label: 'Time', status: 'NEEDS_ACTION', summary: '1 thing to fix', items: [{ key: 'NO_DAILY_PERIODS:p', code: 'NO_DAILY_PERIODS', severity: 'BLOCKER', message: 'Daily Periods are not set up yet.', count: 0, examples: [], fix: { action: 'SET_DAILY_PERIODS', label: 'Set Daily Periods', path: '/timetable/setup?tab=periods' } }] }] }) },
    }));
    renderAt('/timetable/schedule');
    expect(await screen.findByText('Daily Periods are not set up yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set Daily Periods/ })).toHaveAttribute('href', '/timetable/setup?tab=periods');
    expect(screen.getByRole('button', { name: 'Prepare Smart Draft' })).toBeDisabled();
  });

  it('(TT-UX-09) Prepare Smart Draft makes the draft, runs it, and the workspace opens with the result card and Review Exceptions', async () => {
    let made = false;
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable-plans/${PLAN_ID}/versions`]: () => ({ data: made ? [version] : [] }),
      [`POST ${API}/timetable-plans/${PLAN_ID}/versions`]: () => {
        made = true;
        return { status: 201, data: version };
      },
      [`POST ${API}/timetable-versions/${VERSION_ID}/smart-draft`]: { data: { runId: 'r1', versionId: VERSION_ID, runType: 'SMART_DRAFT', mode: 'FILL_GAPS', status: 'DONE', startedAt: '', completedAt: '', totalRequirements: 6, totalPeriods: 1728, entriesCreated: 1642, unresolvedCount: 1, warningCount: 14, summary: '1,642 of 1,728 placed · 86 left · 0 clashes · 14 warnings', unresolved: [{ key: 'k', label: '8-A Science', remaining: 5, reason: 'NO_TEACHER', message: 'No teacher is assigned.' }], rev: 4, changeSetId: 'cs' } },
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Prepare Smart Draft' }));
    expect(await screen.findByTestId('run-summary')).toHaveTextContent('1,642 of 1,728 placed · 86 left · 0 clashes · 14 warnings');
    expect(screen.getByRole('link', { name: 'Review Exceptions' })).toHaveAttribute('href', '/timetable/attention');
    expect(screen.getByText('8-A Science')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Weekly timetable' })).toBeInTheDocument();
    expect(mock.callsTo('/smart-draft', 'POST')[0]!.body).toMatchObject({ mode: 'FILL_GAPS' });
  });
});

describe('Workspace grid (TT-UX-07, 13)', () => {
  it('(TT-UX-07) shows the context line, the coverage line, lessons with teacher and room, and Add on a free period', async () => {
    mockApi('SCHOOL_ADMIN', base());
    renderAt('/timetable/schedule');
    expect(await screen.findByTestId('coverage-line')).toHaveTextContent('Needs 11 · Placed 2 · Left 9');
    expect(screen.getByTestId('context-line')).toHaveTextContent('Class VIII · 8-A');
    const maths = await lesson(/^Mathematics, Rakesh Sharma, Room 101/);
    expect(maths).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Add a lesson on Tuesday, Period 1/ })).toBeInTheDocument();
    expect(screen.getByTestId('progress-line')).toHaveTextContent('2 / 11 placed · 2 need attention');
    // The break is drawn quietly and never has Add.
    expect(screen.getAllByText('Short Break').length).toBeGreaterThan(0);
  });

  it('(TT-UX-13) starting to drag colours every slot green, amber or grey from the slot map, with the reason on a grey one', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({ [`POST ${API}/timetable/slot-map`]: { data: slotMapAll({ 'TUE|p1': 'BLOCKED', 'TUE|p2': 'WARNING' }) } }));
    renderAt('/timetable/schedule');
    fireEvent.dragStart(await lesson(/^Mathematics/), dt);
    await waitFor(() => expect(screen.getByTestId('slot-TUE-P1')).toHaveAttribute('data-slot-status', 'BLOCKED'));
    expect(screen.getByTestId('slot-TUE-P2')).toHaveAttribute('data-slot-status', 'WARNING');
    expect(screen.getByTestId('slot-TUE-P1')).toHaveAttribute('title', 'Rakesh Sharma is teaching 8-B');
    expect(mock.callsTo('/timetable/slot-map', 'POST')[0]!.body).toEqual({ versionId: VERSION_ID, entryId: ENTRY_MATH });
    fireEvent.dragEnd(await lesson(/^Mathematics/));
    await waitFor(() => expect(screen.getByTestId('slot-TUE-P1')).not.toHaveAttribute('data-slot-status'));
  });

  it('(TT-UX-13) dropping on a good slot saves at once with Saving then Saved, and the toast Undo takes it back', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`POST ${API}/timetable/slot-map`]: { data: slotMapAll({}) },
      [`POST ${API}/timetable-entries/${ENTRY_MATH}/move`]: { data: write() },
      [`POST ${API}/timetable-changes/cs-1/undo`]: { data: write({ label: 'Undid: Moved 8-A Mathematics' }) },
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    fireEvent.dragStart(await lesson(/^Mathematics/), dt);
    await waitFor(() => expect(screen.getByTestId('slot-TUE-P1')).toHaveAttribute('data-slot-status', 'OK'));
    fireEvent.drop(screen.getByTestId('slot-TUE-P1'), dt);
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const move = mock.callsTo('/move', 'POST')[0]!.body as Record<string, unknown>;
    expect(move).toMatchObject({ weekday: 'TUE', periodId: 'p1', expectedVersion: 1 });
    expect(typeof move.requestId).toBe('string');
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mock.callsTo('/undo', 'POST')).toHaveLength(1));
  });

  it('(TT-UX-13) dropping on a blocked slot opens Why Not Here with the reasons and better slots as buttons', async () => {
    const alternatives: AlternativeDTO[] = [{ kind: 'SLOT', label: 'Tuesday, Period 4', weekday: 'TUE', periodId: 'p4', physicalSpaceId: null, employeeId: null }];
    const blocked: CheckResultDTO = { ok: false, summary: 'Rakesh Sharma is already teaching 8-B Mathematics on Tuesday, Period 1.', warnings: [], info: [], alternatives, perOp: [], blockers: [{ rule: 'TEACHER_BUSY', severity: 'CLASH', message: 'Rakesh Sharma is already teaching 8-B Mathematics on Tuesday, Period 1.', who: [], when: null, overridable: false, overriddenReason: null, entryId: null, blockedBy: [], fix: null }] };
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`POST ${API}/timetable/slot-map`]: { data: slotMapAll({ 'TUE|p1': 'BLOCKED' }) },
      [`POST ${API}/timetable/check`]: { data: blocked },
      [`POST ${API}/timetable-entries/${ENTRY_MATH}/move`]: { data: write() },
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    fireEvent.dragStart(await lesson(/^Mathematics/), dt);
    await waitFor(() => expect(screen.getByTestId('slot-TUE-P1')).toHaveAttribute('data-slot-status', 'BLOCKED'));
    fireEvent.drop(screen.getByTestId('slot-TUE-P1'), dt);
    const dialog = await screen.findByRole('dialog', { name: 'Why Not Here?' });
    expect(within(dialog).getByText(/is already teaching 8-B Mathematics/, { selector: 'span' })).toBeInTheDocument();
    expect(mock.callsTo('/move', 'POST')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Tuesday, Period 4' }));
    await waitFor(() => expect(mock.callsTo('/move', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/move', 'POST')[0]!.body).toMatchObject({ weekday: 'TUE', periodId: 'p4' });
  });

  it('(TT-UX-13) dropping on another lesson offers Swap These Two, and confirming sends the swap', async () => {
    const ok: CheckResultDTO = { ok: true, summary: 'All 2 can be saved.', blockers: [], warnings: [], info: [], alternatives: [], perOp: [] };
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`POST ${API}/timetable/slot-map`]: { data: slotMapAll({}) },
      [`POST ${API}/timetable/check`]: { data: ok },
      [`POST ${API}/timetable-entries/${ENTRY_MATH}/move`]: { data: write({ label: 'Swapped 8-A Mathematics and 8-A Science' }) },
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    fireEvent.dragStart(await lesson(/^Mathematics/), dt);
    await waitFor(() => expect(screen.getByTestId('slot-MON-P2')).toHaveAttribute('data-slot-status', 'SWAP'));
    fireEvent.drop(screen.getByTestId('slot-MON-P2'), dt);
    const dialog = await screen.findByRole('dialog', { name: 'Swap These Two' });
    expect(mock.callsTo('/timetable/check', 'POST')[0]!.body).toMatchObject({ ops: [{ op: 'move', entryId: ENTRY_MATH, weekday: 'MON', periodId: 'p2' }, { op: 'move', entryId: ENTRY_SCI, weekday: 'MON', periodId: 'p1' }] });
    await user.click(within(dialog).getByRole('button', { name: 'Swap These Two' }));
    await waitFor(() => expect(mock.callsTo('/move', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/move', 'POST')[0]!.body).toMatchObject({ swapWith: ENTRY_SCI });
  });

  it('(TT-UX-14) a failed save keeps "Not saved yet" with Try Again, and Try Again sends the same request id', async () => {
    let calls = 0;
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`POST ${API}/timetable/slot-map`]: { data: slotMapAll({}) },
      [`POST ${API}/timetable-entries/${ENTRY_MATH}/move`]: () => (++calls === 1 ? undefined : { data: write() }),
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    fireEvent.dragStart(await lesson(/^Mathematics/), dt);
    await waitFor(() => expect(screen.getByTestId('slot-TUE-P1')).toHaveAttribute('data-slot-status', 'OK'));
    fireEvent.drop(screen.getByTestId('slot-TUE-P1'), dt);
    expect(await screen.findByText('Not saved yet')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try Again' }));
    expect(await screen.findByText('Saved')).toBeInTheDocument();
    const [first, second] = mock.callsTo('/move', 'POST').map((c) => (c.body as { requestId: string }).requestId);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it('(TT-UX-15) when the server says someone else changed the period, the grid refreshes and a note says so', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`POST ${API}/timetable/slot-map`]: { data: slotMapAll({}) },
      [`POST ${API}/timetable-entries/${ENTRY_MATH}/move`]: { status: 409, error: { code: 'STALE_TIMETABLE', message: 'Someone just changed this period. We refreshed it.' } },
    }));
    renderAt('/timetable/schedule');
    fireEvent.dragStart(await lesson(/^Mathematics/), dt);
    await waitFor(() => expect(screen.getByTestId('slot-TUE-P1')).toHaveAttribute('data-slot-status', 'OK'));
    const before = mock.callsTo('/grid', 'GET').length;
    fireEvent.drop(screen.getByTestId('slot-TUE-P1'), dt);
    expect(await screen.findByText('Someone just changed this period. We refreshed it.')).toBeInTheDocument();
    await waitFor(() => expect(mock.callsTo('/grid', 'GET').length).toBeGreaterThan(before));
  });

  it('(TT-UX-16) a fixed lesson asks "Unlock this fixed period first?" and only continues after you confirm', async () => {
    const fixedGrid = grid([cell(ENTRY_FIXED, 'MON', periods[0]!, 'Mathematics', 'Rakesh Sharma', { isFixed: true })]);
    let n = 0;
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable-versions/${VERSION_ID}/grid`]: { data: fixedGrid },
      [`POST ${API}/timetable/slot-map`]: { data: slotMapAll({}) },
      [`POST ${API}/timetable-entries/${ENTRY_FIXED}/move`]: () => (++n === 1 ? { status: 409, error: { code: 'ENTRY_FIXED', message: 'Mathematics on Monday, Period 1 is a fixed period. Unlock it first.' } } : { data: write() }),
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    fireEvent.dragStart(await lesson(/^Mathematics.*fixed/), dt);
    await waitFor(() => expect(screen.getByTestId('slot-TUE-P1')).toHaveAttribute('data-slot-status', 'OK'));
    fireEvent.drop(screen.getByTestId('slot-TUE-P1'), dt);
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Unlock this fixed period first?')).toBeInTheDocument();
    expect(mock.callsTo('/move', 'POST')).toHaveLength(1);
    await user.click(within(dialog).getByRole('button', { name: 'Unlock And Continue' }));
    await waitFor(() => expect(mock.callsTo('/move', 'POST')).toHaveLength(2));
    expect(mock.callsTo('/move', 'POST')[1]!.body).toMatchObject({ confirmUnlock: true });
  });

  it('(TT-UX-17) Shift-click selects several lessons; the preview says how many can move and Move 1 Only saves just those', async () => {
    const preview: CheckResultDTO = { ok: false, summary: '1 of 2 can be saved. 1 clashes: Meena Rao is already teaching 8-B Science.', warnings: [], info: [], alternatives: [], perOp: [{ index: 0, entryId: ENTRY_MATH, blockers: 0, warnings: 0, info: 0 }, { index: 1, entryId: ENTRY_SCI, blockers: 1, warnings: 0, info: 0 }], blockers: [{ rule: 'TEACHER_BUSY', severity: 'CLASH', message: 'Meena Rao is already teaching 8-B Science.', who: [], when: null, overridable: false, overriddenReason: null, entryId: ENTRY_SCI, blockedBy: [], fix: null }] };
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`POST ${API}/timetable/check`]: { data: preview },
      [`POST ${API}/timetable-entries/bulk`]: { data: { op: 'MOVE', mode: 'APPLY_VALID', requested: 2, done: 1, failed: [{ entryId: ENTRY_SCI, label: '8-A Science', message: 'x' }], rev: 4, changeSetId: 'cs-2', issues: [], entries: [], deletedIds: [], message: '1 of 2 moved. 1 did not: x' } },
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    await user.click(await lesson(/^Mathematics/));
    await user.keyboard('{Shift>}');
    await user.click(await lesson(/^Science/));
    await user.keyboard('{/Shift}');
    const bar = await screen.findByRole('toolbar', { name: 'Selected lessons' });
    expect(within(bar).getByText('2 selected')).toBeInTheDocument();
    await user.click(within(bar).getByRole('button', { name: 'Move' }));
    const dialog = await screen.findByRole('dialog', { name: /Move lessons to another day/ });
    expect(await within(dialog).findByText('1 of 2 can be saved. 1 clashes: Meena Rao is already teaching 8-B Science.')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Move 1 Only' }));
    await waitFor(() => expect(mock.callsTo('/timetable-entries/bulk', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/timetable-entries/bulk', 'POST')[0]!.body).toMatchObject({ op: 'MOVE', mode: 'APPLY_VALID' });
  });
});

describe('Inspector, pickers and Add (TT-UX-18, 19)', () => {
  it('(TT-UX-18) the teacher picker lists valid choices first and greys out busy ones with the reason', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable/available-faculty`]: { data: [{ id: TEACHER_1, name: 'Rakesh Sharma', ok: true, reason: null, recommended: true, detail: 'Assigned in Assign Classes' }, { id: TEACHER_2, name: 'Meena Rao', ok: false, reason: 'Meena Rao is already teaching 8-B Science on Monday, Period 1.', recommended: false, detail: null }] },
      [`PATCH ${API}/timetable-entries/${ENTRY_MATH}`]: { data: write({ label: 'Changed 8-A Mathematics' }) },
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    await user.click(await lesson(/^Mathematics/));
    await user.click(await screen.findByRole('button', { name: /Teacher: Rakesh Sharma\. Change/ }));
    const list = await screen.findByRole('list', { name: 'Choose a teacher' });
    const busy = within(list).getByRole('button', { name: /Meena Rao/ });
    expect(busy).toBeDisabled();
    expect(within(busy).getByText(/already teaching 8-B Science/)).toBeInTheDocument();
    await user.click(within(list).getByRole('button', { name: /Rakesh Sharma/ }));
    await waitFor(() => expect(mock.callsTo(`/timetable-entries/${ENTRY_MATH}`, 'PATCH')).toHaveLength(1));
    expect(mock.callsTo(`/timetable-entries/${ENTRY_MATH}`, 'PATCH')[0]!.body).toMatchObject({ teacherIds: [TEACHER_1], expectedVersion: 1 });
  });

  it('(TT-UX-18) a soft clash can be allowed anyway with a reason, if you have permission', async () => {
    const soft = { rule: 'TEACHER_UNAVAILABLE', severity: 'CLASH', message: 'Rakesh Sharma is not available on Monday, 08:00-09:30.', who: [], when: null, overridable: true, overriddenReason: null, entryId: ENTRY_MATH, blockedBy: [], fix: null };
    let n = 0;
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable/available-spaces`]: { data: [{ id: 'room-2', name: 'Room 102', ok: true, reason: null, recommended: false, detail: null }] },
      [`PATCH ${API}/timetable-entries/${ENTRY_MATH}`]: () => (++n === 1 ? { status: 409, error: { code: 'TIMETABLE_CLASH', message: soft.message, details: { blockers: [soft], alternatives: [] } } } : { data: write({ label: 'Changed 8-A Mathematics' }) }),
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    await user.click(await lesson(/^Mathematics/));
    await user.click(await screen.findByRole('button', { name: /Room: Room 101\. Change/ }));
    await user.click(await screen.findByRole('button', { name: 'Room 102' }));
    const dialog = await screen.findByRole('dialog', { name: 'Why Not Here?' });
    await user.type(within(dialog).getByLabelText('Reason'), 'Covering exam duty');
    await user.click(within(dialog).getByRole('button', { name: 'Allow Anyway' }));
    await waitFor(() => expect(mock.callsTo(`/timetable-entries/${ENTRY_MATH}`, 'PATCH')).toHaveLength(2));
    expect(mock.callsTo(`/timetable-entries/${ENTRY_MATH}`, 'PATCH')[1]!.body).toMatchObject({ override: { rule: 'TEACHER_UNAVAILABLE', reason: 'Covering exam duty' } });
  });

  it('(TT-UX-19) a free cell opens Add with "Still needed" subjects and the recommended teacher and room already chosen', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/subjects`]: { data: [] },
      [`GET ${API}/timetable/available-faculty`]: { data: [{ id: TEACHER_1, name: 'Rakesh Sharma', ok: true, reason: null, recommended: true, detail: null }] },
      [`GET ${API}/timetable/available-spaces`]: { data: [{ id: 'room-1', name: 'Room 101', ok: true, reason: null, recommended: true, detail: 'Home Classroom' }] },
      [`POST ${API}/timetable-versions/${VERSION_ID}/entries`]: { status: 201, data: write({ label: 'Added 8-A Mathematics' }) },
    }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Add a lesson on Tuesday, Period 1/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a lesson' });
    await user.click(within(dialog).getByRole('button', { name: /Mathematics · 5 left/ }));
    await waitFor(() => expect(within(dialog).getByRole('combobox', { name: /Teacher/ })).toHaveTextContent('Rakesh Sharma'));
    expect(within(dialog).getByRole('combobox', { name: /Room/ })).toHaveTextContent('Room 101');
    await user.click(within(dialog).getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(mock.callsTo('/entries', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/entries', 'POST')[0]!.body).toMatchObject({ weekday: 'TUE', periodId: 'p1', entryType: 'SUBJECT', subjectOfferingId: SUBJECT_MATH, sectionOfferingIds: [SECTION_A_ID], teacherIds: [TEACHER_1], physicalSpaceId: 'room-1' });
  });
});

describe('Smart Rail (TT-UX-20)', () => {
  it('(TT-UX-20) Left To Place shows the recommended slot for each subject and Place saves it in one click', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({ [`POST ${API}/timetable-versions/${VERSION_ID}/entries`]: { status: 201, data: write({ label: 'Added 8-A Mathematics' }) } }));
    renderAt('/timetable/schedule');
    const user = userEvent.setup();
    const rail = await screen.findByLabelText('Smart Rail');
    expect(await within(rail).findAllByText('Tuesday, Period 1')).not.toHaveLength(0);
    await user.click((await within(rail).findAllByRole('button', { name: /^Place Mathematics on Tuesday, Period 1/ }))[0]!);
    await waitFor(() => expect(mock.callsTo('/entries', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/entries', 'POST')[0]!.body).toMatchObject({ weekday: 'TUE', periodId: 'p1', subjectOfferingId: SUBJECT_MATH, sectionOfferingIds: [SECTION_A_ID] });
    await user.click(within(rail).getAllByRole('button', { name: 'More Options' })[0]!);
    expect(within(rail).getAllByRole('list', { name: /More options for/ })[0]).toBeInTheDocument();
  });
});

describe('Needs Attention page (TT-UX-16, 17)', () => {
  it('(TT-UX-16) groups with counts, a Place button with the best slot, and Why? shows the live explanation', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable/explain-unplaced`]: { data: { needed: 6, placed: 1, left: 5, slots: 42, message: 'No free slot where Rakesh Sharma and 8-A are all free. Of 42 slots: 14 blocked by Rakesh Sharma.', blockedBy: [], needTwo: 0, bestFix: { label: "Move Rakesh Sharma's Tuesday P3 lesson", action: 'MOVE_ENTRY', entryId: ENTRY_MATH }, reasonCode: 'NO_SLOT' } },
      [`POST ${API}/timetable-versions/${VERSION_ID}/entries`]: { status: 201, data: write({ label: 'Added 8-A Mathematics' }) },
    }));
    renderAt('/timetable/attention');
    const user = userEvent.setup();
    expect(await screen.findByTestId('attention-progress')).toHaveTextContent('2 / 11 placed · 2 need attention');
    const notPlaced = await screen.findByRole('region', { name: 'Not Placed' });
    expect(within(notPlaced).getByText('Best slot: Tuesday, Period 2')).toBeInTheDocument();
    await user.click(within(notPlaced).getByRole('button', { name: 'Why?' }));
    expect(await screen.findByTestId('why-text')).toHaveTextContent('No free slot where Rakesh Sharma and 8-A are all free. Of 42 slots: 14 blocked by Rakesh Sharma.');
    expect(screen.getByTestId('why-text')).toHaveTextContent("Best fix: Move Rakesh Sharma's Tuesday P3 lesson");
    await user.click(within(notPlaced).getByRole('button', { name: 'Place' }));
    await waitFor(() => expect(mock.callsTo('/entries', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/entries', 'POST')[0]!.body).toMatchObject({ weekday: 'TUE', periodId: 'p2', subjectOfferingId: SUBJECT_MATH });
  });

  it('(TT-UX-17) Accept All teacher changes shows how many were done and why a failed one failed', async () => {
    const items: RunItemDTO[] = [
      { itemId: 'i1', runId: 'run-1', reason: 'TEACHER_CHANGED', status: 'OPEN', label: '8-A Science, Monday Period 2', message: 'x', suggestion: 'Use Neelam Das', hasSuggestion: true },
      { itemId: 'i2', runId: 'run-1', reason: 'TEACHER_CHANGED', status: 'OPEN', label: '8-B Science, Tuesday Period 2', message: 'x', suggestion: 'Use Neelam Das', hasSuggestion: true },
    ];
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable-versions/${VERSION_ID}/run-items`]: { data: items },
      [`POST ${API}/timetable-run-items/accept-group`]: { data: { accepted: 1, failed: [{ itemId: 'i2', message: 'Neelam Das is already teaching 8-C Science on Tuesday, Period 2.' }] } },
    }));
    renderAt('/timetable/attention');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept All 2 Teacher Changes' }));
    const dialog = await screen.findByRole('dialog', { name: 'Accepted' });
    expect(within(dialog).getByText('1 accepted.')).toBeInTheDocument();
    expect(within(dialog).getByText('Neelam Das is already teaching 8-C Science on Tuesday, Period 2.')).toBeInTheDocument();
    expect(mock.callsTo('/accept-group', 'POST')[0]!.body).toEqual({ runId: 'run-1', reason: 'TEACHER_CHANGED' });
  });

  it('(TT-UX-16) when nothing needs attention it says so', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/timetable-versions/${VERSION_ID}/attention`]: { data: attention({ total: 0, groups: attention().groups.map((g) => ({ ...g, count: 0, rows: [] })) }) } }));
    renderAt('/timetable/attention');
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument();
  });
});

describe('Who can open it (TT-UX-21)', () => {
  it('(TT-UX-21) Faculty are sent to the restricted page', async () => {
    mockApi('FACULTY', base());
    renderAt('/timetable/schedule');
    expect(await screen.findByText('Restricted page')).toBeInTheDocument();
  });
});
