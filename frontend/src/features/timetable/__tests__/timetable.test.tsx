import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import type {
  BellAssignmentsDTO,
  BellGeneratePreviewDTO,
  BellResolutionDTO,
  BellScheduleDTO,
  FacultyAvailabilityDTO,
  PlanTeacherDTO,
  RequirementListDTO,
  TeachingGroupDTO,
  TimetablePlanDTO,
  TimetableReadinessDTO,
  WorkloadRulesDTO,
} from '@shared';
import { CLASS_OFFERING_ID, LOCATION_ID, SECTION_A_ID, SECTION_B_ID, SESSION_ID, academicSession, classOffering, masterLocation } from '@/test/fixtures';
import { API, Ready, mockApi, pickOption, renderWithApp, type MockResponse } from '@/test/utils';
import { RequireTimetableSetup } from '@/routes/guards';
import { TimetableLayout } from '../context';
import { TimetableOverviewPage } from '../overview-page';
import { TimetableSetupPage } from '../setup-page';
import { setCell } from '../tabs/availability-tab';
import { periodProblem } from '../tabs/periods-tab';

const PLAN_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const BELL_ID = 'b1b1b1b1-0000-4000-8000-000000000001';
const JUNIOR_ID = 'b2b2b2b2-0000-4000-8000-000000000002';
const SUBJECT_MATH = 'c1c1c1c1-0000-4000-8000-000000000001';
const SUBJECT_SCI = 'c2c2c2c2-0000-4000-8000-000000000002';
const TEACHER_1 = 'd1d1d1d1-0000-4000-8000-000000000001';
const TEACHER_2 = 'd2d2d2d2-0000-4000-8000-000000000002';
const GROUP_ID = 'e1e1e1e1-0000-4000-8000-000000000001';
const STUDENT_ID = 'f1f1f1f1-0000-4000-8000-000000000001';

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
  operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'],
  defaultBellScheduleId: BELL_ID,
  capacityPolicy: 'WARN',
  transitionMinutes: 30,
  defaultMaxPerDay: 6,
  defaultMaxConsecutive: null,
  defaultMaxPerWeek: null,
  status: 'DRAFT',
  version: 1,
};

const period = (n: number, startMin: number, endMin: number, over: Record<string, unknown> = {}) => ({
  periodId: `p${n}`,
  bellScheduleId: BELL_ID,
  periodCode: `P${n}`,
  periodName: `Period ${n}`,
  startMin,
  endMin,
  start: `${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}`,
  end: `${String(Math.floor(endMin / 60)).padStart(2, '0')}:${String(endMin % 60).padStart(2, '0')}`,
  periodType: 'TEACHING' as const,
  schedulable: true,
  displayOrder: n,
  usedByEntries: 0,
  ...over,
});

const regular: BellScheduleDTO = {
  bellScheduleId: BELL_ID,
  planId: PLAN_ID,
  name: 'Regular',
  kind: 'REGULAR',
  status: 'ACTIVE',
  isDefault: true,
  periods: [period(1, 480, 525), period(2, 525, 570), period(3, 570, 615)],
  lessonPeriods: 3,
  usedBy: 1,
};
const junior: BellScheduleDTO = { ...regular, bellScheduleId: JUNIOR_ID, name: 'Junior', kind: 'JUNIOR', isDefault: false, usedBy: 0 };

const readiness = (over: Partial<TimetableReadinessDTO> = {}): TimetableReadinessDTO => ({
  planId: PLAN_ID,
  ready: false,
  needsActions: 3,
  message: 'Timetable setup needs 3 actions',
  canSmartDraft: false,
  smartDraftBlockedBy: ['Time is not ready: fix the Daily Periods first.'],
  counts: { sections: 2, subjects: 2, teachers: 1, homeClassrooms: 1, specialRooms: 0 },
  areas: [
    { area: 'CLASSES_SUBJECTS', label: 'Classes & Subjects', status: 'NEEDS_ACTION', summary: '1 thing to fix', items: [{ key: 'NO_SUBJECT_NEEDS:c', code: 'NO_SUBJECT_NEEDS', severity: 'BLOCKER', message: 'Class VIII: 2 subjects have no Subject Needs yet.', count: 2, examples: ['Mathematics', 'Science'], fix: { action: 'SET_SUBJECT_NEEDS', label: 'Set Subject Needs', path: `/timetable/setup?tab=needs&classOfferingId=${CLASS_OFFERING_ID}` } }] },
    { area: 'TEACHERS', label: 'Teachers', status: 'NEEDS_ACTION', summary: '1 thing to fix', items: [{ key: 'NO_TEACHER:c', code: 'NO_TEACHER', severity: 'WARNING', message: 'Class VIII: 2 lesson subjects have no teacher.', count: 2, examples: [], fix: { action: 'ASSIGN_CLASSES', label: 'Go To Assign Classes', path: '/people' } }] },
    { area: 'ROOMS', label: 'Rooms', status: 'READY', summary: 'All set', items: [] },
    { area: 'TIME', label: 'Time', status: 'NEEDS_ACTION', summary: '1 thing to fix', items: [{ key: 'NO_DAILY_PERIODS:p', code: 'NO_DAILY_PERIODS', severity: 'BLOCKER', message: 'Daily Periods are not set up yet.', count: 0, examples: [], fix: { action: 'SET_DAILY_PERIODS', label: 'Set Daily Periods', path: '/timetable/setup?tab=periods' } }] },
  ],
  ...over,
});

const values = (periodsPerWeek: number) => ({ periodsPerWeek, minPerWeek: null, maxPerWeek: null, maxPerDay: 2, doubleMode: 'NONE' as const, doublesPerWeek: 0, preferredBand: 'ANY' as const, neededSuitability: [], priority: 0 });
const needsList = (over: Partial<RequirementListDTO> = {}): RequirementListDTO => ({
  planId: PLAN_ID,
  classOfferingId: CLASS_OFFERING_ID,
  sectionOfferingId: null,
  sectionsWithOverrides: 0,
  total: { needed: 11, available: 42, ok: true, message: 'Total 11 of 42 periods' },
  items: [
    { subjectOfferingId: SUBJECT_MATH, subjectName: 'Mathematics', subjectCode: 'MATH', source: 'CLASS', requirementId: 'r1', version: 1, configured: true, effective: values(6), classDefault: values(6) },
    { subjectOfferingId: SUBJECT_SCI, subjectName: 'Science', subjectCode: 'SCI', source: 'CLASS', requirementId: 'r2', version: 1, configured: true, effective: values(5), classDefault: values(5) },
  ],
  ...over,
});

const teachers: PlanTeacherDTO[] = [
  { employeeId: TEACHER_1, fullName: 'Rakesh Sharma', employeeCode: 'FAC-001', hasAvailabilityRows: false, hasOwnWorkload: false },
  { employeeId: TEACHER_2, fullName: 'Meena Rao', employeeCode: 'FAC-002', hasAvailabilityRows: false, hasOwnWorkload: false },
];

const group = (over: Partial<TeachingGroupDTO> = {}): TeachingGroupDTO => ({
  groupId: GROUP_ID,
  planId: PLAN_ID,
  name: 'French – Class 8',
  kind: 'LANGUAGE',
  classOfferingId: CLASS_OFFERING_ID,
  className: 'Class VIII',
  subjectOfferingId: SUBJECT_MATH,
  subjectName: 'French',
  sectionPool: [{ sectionOfferingId: SECTION_A_ID, label: '8-A' }],
  teacher: { status: 'OK', source: 'ASSIGNMENT', employeeIds: [TEACHER_1], names: ['Rakesh Sharma'], candidates: [] },
  memberCount: 3,
  manualCount: 0,
  healthBadge: '4 students not in any group',
  status: 'ACTIVE',
  version: 1,
  ...over,
});

const sections = [
  { sectionOfferingId: SECTION_A_ID, classOfferingId: CLASS_OFFERING_ID, sectionCode: 'A', displayName: 'A' },
  { sectionOfferingId: SECTION_B_ID, classOfferingId: CLASS_OFFERING_ID, sectionCode: 'B', displayName: 'B' },
];

function base(extra: Handlers = {}): Handlers {
  return {
    [`GET ${API}/academic-sessions`]: { data: [academicSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation] },
    [`GET ${API}/timetable-plans`]: { data: [plan] },
    [`GET ${API}/timetable-plans/${PLAN_ID}/readiness`]: { data: readiness() },
    [`GET ${API}/timetable-plans/${PLAN_ID}/bell-schedules`]: { data: [regular, junior] },
    [`GET ${API}/timetable-plans/${PLAN_ID}/bell-assignments`]: { data: { defaultBellScheduleId: BELL_ID, items: [] } satisfies BellAssignmentsDTO },
    [`GET ${API}/timetable-plans/${PLAN_ID}/bell-resolution`]: { data: { planId: PLAN_ID, operatingDays: plan.operatingDays, rows: [], missing: [] } satisfies BellResolutionDTO },
    [`GET ${API}/academic-sessions/${SESSION_ID}/class-offerings`]: { data: [classOffering, { ...classOffering, classOfferingId: 'c9c9c9c9-0000-4000-8000-000000000009', displayName: 'Class IX', sectionCount: 2 }] },
    [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/sections`]: { data: sections },
    [`GET ${API}/timetable-plans/${PLAN_ID}/teachers`]: { data: teachers },
    ...extra,
  };
}

function renderAt(route: string) {
  return renderWithApp(
    <Ready>
      <Toaster />
      <Routes>
        <Route path="/restricted" element={<p>Restricted page</p>} />
        <Route element={<RequireTimetableSetup />}>
          <Route element={<TimetableLayout />}>
            <Route path="/timetable" element={<TimetableOverviewPage />} />
            <Route path="/timetable/setup" element={<TimetableSetupPage />} />
          </Route>
        </Route>
      </Routes>
    </Ready>,
    { route },
  );
}

describe('Timetable overview (TT-UX-01)', () => {
  it('(TT-UX-01) a campus with no plan sees one big Create Timetable Plan button, and it creates the plan from the bar’s campus and year', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/timetable-plans`]: { data: [] }, [`POST ${API}/timetable-plans`]: { status: 201, data: plan } }));
    renderAt('/timetable');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Create Timetable Plan' }));
    await waitFor(() => expect(mock.callsTo('/timetable-plans', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/timetable-plans', 'POST')[0]!.body).toEqual({ locationId: LOCATION_ID, academicSessionId: SESSION_ID });
  });

  it('(TT-UX-01) shows "needs 3 actions", four tiles, and a fix button for every item that opens the right place', async () => {
    mockApi('SCHOOL_ADMIN', base());
    renderAt('/timetable');
    expect(await screen.findByText('Timetable setup needs 3 actions')).toBeInTheDocument();
    for (const name of ['Classes & Subjects', 'Teachers', 'Rooms', 'Time']) expect(screen.getByRole('region', { name })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Rooms' })).getByText('Nothing to fix here.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Set Subject Needs/ })).toHaveAttribute('href', `/timetable/setup?tab=needs&classOfferingId=${CLASS_OFFERING_ID}`);
    expect(screen.getByRole('link', { name: /Go To Assign Classes/ })).toHaveAttribute('href', '/people');
    expect(screen.getByRole('link', { name: /Set Daily Periods/ })).toHaveAttribute('href', '/timetable/setup?tab=periods');
    // Until the schedule screen exists the button is off, and says why.
    expect(screen.getByRole('button', { name: 'Open Schedule' })).toBeDisabled();
  });

  it('(TT-UX-01) a ready plan says so in one line', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/timetable-plans/${PLAN_ID}/readiness`]: { data: readiness({ ready: true, needsActions: 0, message: 'Ready to build', canSmartDraft: true, smartDraftBlockedBy: [], areas: readiness().areas.map((a) => ({ ...a, status: 'READY' as const, items: [], summary: 'All set' })) }) } }));
    renderAt('/timetable');
    expect(await screen.findByText('Ready to build')).toBeInTheDocument();
    expect(screen.getAllByText('Nothing to fix here.')).toHaveLength(4);
  });

  it('(TT-49) Faculty are sent away from the timetable setup', async () => {
    mockApi('FACULTY', base());
    renderAt('/timetable/setup');
    expect(await screen.findByText('Restricted page')).toBeInTheDocument();
  });
});

describe('School Week and Daily Periods (TT-03 to 05)', () => {
  const preview: BellGeneratePreviewDTO = {
    name: 'Regular',
    periods: [
      { periodCode: 'P1', periodName: 'Period 1', start: '08:00', end: '08:45', startMin: 480, endMin: 525, periodType: 'TEACHING', schedulable: true },
      { periodCode: 'BRK1', periodName: 'Short Break', start: '08:45', end: '09:00', startMin: 525, endMin: 540, periodType: 'BREAK', schedulable: false },
    ],
    lessonPeriods: 1,
    leftoverMinutes: 5,
    message: '5 minutes left at the end of the day. A full period does not fit there.',
  };

  it('(TT-03) the School Week tab previews the day with its lesson count and leftover minutes, then creates the Daily Periods from the form', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable-plans/${PLAN_ID}/bell-schedules`]: { data: [] },
      [`POST ${API}/timetable-plans/${PLAN_ID}/bell-schedules/generate/preview`]: { data: preview },
      [`POST ${API}/timetable-plans/${PLAN_ID}/bell-schedules/generate`]: { status: 201, data: { schedule: regular, alreadyExisted: false } },
    }));
    renderAt('/timetable/setup');
    expect(await screen.findByTestId('preview-summary')).toHaveTextContent('1 lesson periods a day.');
    expect(screen.getByText(/5 minutes left at the end of the day/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Create Daily Periods' }));
    await waitFor(() => expect(mock.callsTo('/bell-schedules/generate', 'POST').filter((c) => !c.path.includes('preview'))).toHaveLength(1));
    const body = mock.callsTo('/bell-schedules/generate', 'POST').find((c) => !c.path.includes('preview'))!.body as { name: string; start: string; end: string; periodMinutes: number; breaks: unknown[] };
    expect(body).toMatchObject({ name: 'Regular', start: '08:00', end: '14:30', periodMinutes: 45 });
    expect(body.breaks).toHaveLength(2);
    expect(await screen.findByRole('link', { name: 'Go To Daily Periods' })).toHaveAttribute('href', '/timetable/setup?tab=periods');
  });

  it('(TT-03) the seven day buttons toggle, and Save School Days sends the days in week order with the plan’s version', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable-plans/${PLAN_ID}/bell-schedules`]: { data: [] },
      [`POST ${API}/timetable-plans/${PLAN_ID}/bell-schedules/generate/preview`]: { data: preview },
      [`PATCH ${API}/timetable-plans/${PLAN_ID}`]: { data: { ...plan, operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'], version: 2 } },
    }));
    renderAt('/timetable/setup');
    const user = userEvent.setup();
    const sat = await screen.findByRole('button', { name: 'Sat' });
    expect(sat).toHaveAttribute('aria-pressed', 'true');
    await user.click(sat);
    expect(sat).toHaveAttribute('aria-pressed', 'false');
    await user.click(screen.getByRole('button', { name: 'Save School Days' }));
    await waitFor(() => expect(mock.callsTo(`/timetable-plans/${PLAN_ID}`, 'PATCH')).toHaveLength(1));
    expect(mock.callsTo(`/timetable-plans/${PLAN_ID}`, 'PATCH')[0]!.body).toEqual({ version: 1, operatingDays: ['MON', 'TUE', 'WED', 'THU', 'FRI'] });
  });

  it('(TT-04) a period that runs into the next one turns red with the reason, and nothing is sent', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base());
    renderAt('/timetable/setup?tab=periods');
    const user = userEvent.setup();
    const rows = await screen.findAllByLabelText('To');
    const first = rows[0] as HTMLInputElement;
    await user.clear(first);
    await user.type(first, '09:00');
    await user.tab();
    expect(await screen.findByText('This overlaps Period 2 (08:45 to 09:30).')).toBeInTheDocument();
    expect(mock.callsTo('/bell-schedule-periods/', 'PATCH')).toHaveLength(0);
    expect(periodProblem(regular.periods.slice(1), '08:00', '08:30')).toBeNull();
    expect(periodProblem(regular.periods.slice(1), '08:00', '07:00')).toBe('A period must end after it starts.');
  });

  it('(TT-04) a clean time edit is saved on leaving the box', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({ [`PATCH ${API}/bell-schedule-periods/p3`]: { data: { ...regular.periods[2]!, end: '10:20' } } }));
    renderAt('/timetable/setup?tab=periods');
    const user = userEvent.setup();
    const ends = await screen.findAllByLabelText('To');
    await user.clear(ends[2]!);
    await user.type(ends[2]!, '10:20');
    await user.tab();
    await waitFor(() => expect(mock.callsTo('/bell-schedule-periods/p3', 'PATCH')).toHaveLength(1));
    expect(mock.callsTo('/bell-schedule-periods/p3', 'PATCH')[0]!.body).toEqual({ end: '10:20' });
  });

  it('(TT-05) one save gives the same Daily Periods to many classes, with an optional day rule', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({ [`POST ${API}/timetable-plans/${PLAN_ID}/bell-assignments/bulk`]: { data: { applied: 2, defaultSet: false, items: [] } } }));
    renderAt('/timetable/setup?tab=periods');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select all classes' }));
    await pickOption(user, screen.getByRole('combobox', { name: 'Apply these Daily Periods' }), /^Junior/);
    await user.click(screen.getByRole('checkbox', { name: /Only on some days/ }));
    await user.click(screen.getByRole('button', { name: 'Sat' }));
    await user.click(screen.getByRole('button', { name: 'Apply To 2 Classes' }));
    await waitFor(() => expect(mock.callsTo('/bell-assignments/bulk', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/bell-assignments/bulk', 'POST')[0]!.body).toEqual({ bellScheduleId: JUNIOR_ID, scope: 'CLASS', classOfferingIds: [CLASS_OFFERING_ID, 'c9c9c9c9-0000-4000-8000-000000000009'], weekdays: ['SAT'] });
    expect(await screen.findByText('Daily Periods set for 2 items.')).toBeInTheDocument();
  });

  it('(TT-05) sections with no Daily Periods are listed, and the school default is one pick', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable-plans/${PLAN_ID}/bell-resolution`]: { data: { planId: PLAN_ID, operatingDays: plan.operatingDays, rows: [], missing: [{ sectionOfferingId: SECTION_A_ID, label: '8-A', days: ['SAT'] }] } },
      [`POST ${API}/timetable-plans/${PLAN_ID}/bell-assignments/bulk`]: { data: { applied: 1, defaultSet: true, items: [] } },
    }));
    renderAt('/timetable/setup?tab=periods');
    const user = userEvent.setup();
    expect(await screen.findByText('1 section has no Daily Periods')).toBeInTheDocument();
    await pickOption(user, screen.getByRole('combobox', { name: 'School default' }), /^Junior/);
    await waitFor(() => expect(mock.callsTo('/bell-assignments/bulk', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/bell-assignments/bulk', 'POST')[0]!.body).toEqual({ bellScheduleId: JUNIOR_ID, scope: 'DEFAULT' });
  });
});

describe('Subject Needs (TT-09, 10)', () => {
  it('(TT-09) shows the class table with the total line in plain words', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/subject-schedule-requirements`]: { data: needsList() } }));
    renderAt('/timetable/setup?tab=needs');
    expect(await screen.findByTestId('needs-total')).toHaveTextContent('Total 11 of 42 periods');
    expect(screen.getByLabelText('Periods a week for Mathematics')).toHaveValue(6);
    expect(screen.getByRole('button', { name: 'Save Needs' })).toBeDisabled();
  });

  it('(TT-09) changing a number updates the total at once, and Save sends only the changed subject to the class', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/subject-schedule-requirements`]: { data: needsList() },
      [`POST ${API}/subject-schedule-requirements/apply-grade`]: { data: { saved: 1, unchanged: 0, total: { needed: 50, available: 42, ok: false, message: 'Needs 50 periods, the week has 42' } } },
    }));
    renderAt('/timetable/setup?tab=needs');
    const user = userEvent.setup();
    const maths = await screen.findByLabelText('Periods a week for Mathematics');
    await user.clear(maths);
    await user.type(maths, '45');
    expect(screen.getByTestId('needs-total')).toHaveTextContent('Needs 50 periods, the week has 42');
    await user.click(screen.getByRole('button', { name: 'Save Needs' }));
    await waitFor(() => expect(mock.callsTo('/apply-grade', 'POST')).toHaveLength(1));
    const body = mock.callsTo('/apply-grade', 'POST')[0]!.body as { planId: string; classOfferingId: string; items: Record<string, unknown>[] };
    expect(body).toMatchObject({ planId: PLAN_ID, classOfferingId: CLASS_OFFERING_ID });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ subjectOfferingId: SUBJECT_MATH, periodsPerWeek: 45, doubleMode: 'NONE', maxPerDay: 2 });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('(TT-09) a section says "Using class default" until someone clicks Change For This Section; then it is saved as that section’s own value', async () => {
    const sectionList = needsList({ sectionOfferingId: SECTION_B_ID });
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/subject-schedule-requirements`]: ({ url }) => ({ data: url.searchParams.get('sectionOfferingId') ? sectionList : needsList() }),
      [`PUT ${API}/subject-schedule-requirements`]: { data: { saved: 1, unchanged: 0, total: sectionList.total } },
    }));
    renderAt('/timetable/setup?tab=needs');
    const user = userEvent.setup();
    await pickOption(user, await screen.findByRole('combobox', { name: 'Section' }), 'Section B');
    expect((await screen.findAllByText('Using class default')).length).toBe(2);
    expect(screen.getByLabelText('Periods a week for Mathematics')).toBeDisabled();
    await user.click(screen.getAllByRole('button', { name: 'Change For This Section' })[0]!);
    const maths = screen.getByLabelText('Periods a week for Mathematics');
    expect(maths).toBeEnabled();
    expect(screen.getByText('Different')).toBeInTheDocument();
    await user.clear(maths);
    await user.type(maths, '8');
    await user.click(screen.getByRole('button', { name: 'Save Needs' }));
    await waitFor(() => expect(mock.callsTo('/subject-schedule-requirements', 'PUT')).toHaveLength(1));
    const body = mock.callsTo('/subject-schedule-requirements', 'PUT')[0]!.body as { items: Record<string, unknown>[] };
    expect(body.items[0]).toMatchObject({ scope: 'SECTION', classOfferingId: CLASS_OFFERING_ID, sectionOfferingId: SECTION_B_ID, subjectOfferingId: SUBJECT_MATH, periodsPerWeek: 8 });
  });

  it('(TT-09) a section with its own value shows the Different tag and a Reset link; Copy To Other Sections lists the other sections', async () => {
    const own = needsList({ sectionOfferingId: SECTION_B_ID, items: needsList().items.map((i, n) => (n === 0 ? { ...i, source: 'SECTION' as const, effective: values(8) } : i)) });
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/subject-schedule-requirements`]: ({ url }) => ({ data: url.searchParams.get('sectionOfferingId') ? own : needsList() }),
      [`POST ${API}/subject-schedule-requirements/reset-section`]: { data: { removed: 1 } },
      [`POST ${API}/subject-schedule-requirements/copy-section`]: { data: { copied: 1, alreadySame: 1, message: '1 copied, 1 was already the same.' } },
    }));
    renderAt('/timetable/setup?tab=needs');
    const user = userEvent.setup();
    await pickOption(user, await screen.findByRole('combobox', { name: 'Section' }), 'Section B');
    expect(await screen.findByText('Different')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Reset/ }));
    await waitFor(() => expect(mock.callsTo('/reset-section', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/reset-section', 'POST')[0]!.body).toEqual({ planId: PLAN_ID, sectionOfferingId: SECTION_B_ID, subjectOfferingIds: [SUBJECT_MATH] });

    await user.click(screen.getByRole('button', { name: /Copy To Other Sections/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Copy To Other Sections' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Section A' }));
    await user.click(within(dialog).getByRole('button', { name: 'Copy To 1 Section' }));
    await waitFor(() => expect(mock.callsTo('/copy-section', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/copy-section', 'POST')[0]!.body).toEqual({ planId: PLAN_ID, fromSectionId: SECTION_B_ID, toSectionIds: [SECTION_A_ID] });
  });

  it('(TT-10) the server’s plain reason for a refused save is shown, and nothing says Saved', async () => {
    mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/subject-schedule-requirements`]: { data: needsList() },
      [`POST ${API}/subject-schedule-requirements/apply-grade`]: { status: 422, error: { code: 'REQUIREMENT_INVALID', message: 'Mathematics: 4 double periods need 8 periods a week, but only 6 are set.' } },
    }));
    renderAt('/timetable/setup?tab=needs');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('combobox', { name: 'Double periods for Mathematics' }));
    await user.click(await screen.findByRole('option', { name: 'Must have doubles' }));
    await user.click(screen.getByRole('button', { name: 'Save Needs' }));
    expect(await screen.findByText(/4 double periods need 8 periods a week/)).toBeInTheDocument();
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});

describe('Teacher availability and workload (TT-11, 12)', () => {
  const none: FacultyAvailabilityDTO = { planId: PLAN_ID, employeeId: TEACHER_1, fullName: 'Rakesh Sharma', rows: [] };
  const rules: WorkloadRulesDTO = {
    planId: PLAN_ID,
    planDefault: { maxPerDay: 6, maxConsecutive: null, maxPerWeek: null, preferredFreePerDay: null },
    teachers: teachers.map((t) => ({ employeeId: t.employeeId, fullName: t.fullName, own: { maxPerDay: null, maxConsecutive: null, maxPerWeek: null, preferredFreePerDay: null }, effective: { maxPerDay: 6, maxConsecutive: null, maxPerWeek: null, preferredFreePerDay: null }, usingDefault: { maxPerDay: true, maxConsecutive: true, maxPerWeek: true, preferredFreePerDay: true } })),
  };

  it('(TT-11) clicking a box walks Available → Not available → Prefers → Prefers not → Available, and saves the exceptions after a short wait', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/faculty-availability/${TEACHER_1}`]: { data: none },
      [`GET ${API}/faculty-workload-rules`]: { data: rules },
      [`PUT ${API}/faculty-availability/${TEACHER_1}`]: { data: none },
    }));
    renderAt('/timetable/setup?tab=availability');
    const user = userEvent.setup();
    const cell = await screen.findByRole('button', { name: 'Saturday Period 1: Available' });
    await user.click(cell);
    expect(screen.getByRole('button', { name: 'Saturday Period 1: Not available' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Saturday Period 1: Not available' }));
    expect(screen.getByRole('button', { name: 'Saturday Period 1: Prefers' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Saturday Period 1: Prefers' }));
    expect(screen.getByRole('button', { name: 'Saturday Period 1: Prefers not' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Saturday Period 1: Prefers not' }));
    expect(screen.getByRole('button', { name: 'Saturday Period 1: Available' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Saturday Period 2: Available' }));
    await waitFor(() => expect(mock.callsTo('/faculty-availability/', 'PUT')).toHaveLength(1), { timeout: 3000 });
    expect(mock.callsTo('/faculty-availability/', 'PUT')[0]!.body).toEqual({ planId: PLAN_ID, rows: [{ weekday: 'SAT', start: '08:45', end: '09:30', kind: 'UNAVAILABLE' }] });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('(TT-11) Apply To More Teachers copies this teacher’s times to the ones picked', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/faculty-availability/${TEACHER_1}`]: { data: none },
      [`GET ${API}/faculty-workload-rules`]: { data: rules },
      [`POST ${API}/faculty-availability/copy`]: { data: { teachers: 1, rowsPerTeacher: 2 } },
    }));
    renderAt('/timetable/setup?tab=availability');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Apply To More Teachers/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Apply To More Teachers' });
    await user.click(within(dialog).getByRole('checkbox', { name: 'Meena Rao' }));
    await user.click(within(dialog).getByRole('button', { name: 'Apply To Teachers' }));
    await waitFor(() => expect(mock.callsTo('/faculty-availability/copy', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/faculty-availability/copy', 'POST')[0]!.body).toEqual({ planId: PLAN_ID, fromEmployeeId: TEACHER_1, toEmployeeIds: [TEACHER_2] });
  });

  it('(TT-12) workload boxes show "Using school default (6)" and save on leaving the box', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/faculty-availability/${TEACHER_1}`]: { data: none },
      [`GET ${API}/faculty-workload-rules`]: { data: rules },
      [`PUT ${API}/faculty-workload-rules`]: { data: rules },
    }));
    renderAt('/timetable/setup?tab=availability');
    const user = userEvent.setup();
    const box = await screen.findByPlaceholderText('Using school default (6)');
    await user.type(box, '5');
    await user.tab();
    await waitFor(() => expect(mock.callsTo('/faculty-workload-rules', 'PUT')).toHaveLength(1));
    expect(mock.callsTo('/faculty-workload-rules', 'PUT')[0]!.body).toEqual({ planId: PLAN_ID, employeeId: TEACHER_1, maxPerDay: 5 });
  });

  it('(TT-11) setCell keeps the parts of a longer row that lie outside the clicked period', () => {
    const rows = [{ weekday: 'MON' as const, startMin: 480, endMin: 615, kind: 'UNAVAILABLE' as const }];
    expect(setCell(rows, 'MON', { startMin: 525, endMin: 570 }, null)).toEqual([
      { weekday: 'MON', startMin: 480, endMin: 525, kind: 'UNAVAILABLE' },
      { weekday: 'MON', startMin: 570, endMin: 615, kind: 'UNAVAILABLE' },
    ]);
    expect(setCell(rows, 'TUE', { startMin: 525, endMin: 570 }, 'PREFERRED')).toHaveLength(2);
  });
});

describe('Teaching Groups (TT-18, 19)', () => {
  it('(TT-19) a group card shows its members, its teacher’s source and a health badge, and Fix opens the students who need a group', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/teaching-groups`]: { data: [group()] },
      [`GET ${API}/teaching-groups/${GROUP_ID}/members`]: { data: { items: [{ studentId: 's1', fullName: 'Asha Verma', admissionNumber: 'A-1', sectionLabel: '8-A', source: 'SUBJECT_CHOICE' }], total: 1, page: 1, pageSize: 200 } },
      [`GET ${API}/teaching-groups/${GROUP_ID}/health`]: { data: { groupId: GROUP_ID, healthy: false, leftSection: [], inTwoGroups: [], notInAnyGroup: [{ studentId: STUDENT_ID, fullName: 'Ravi Kumar', admissionNumber: 'A-9', sectionLabel: '8-C' }] } },
      [`POST ${API}/teaching-groups/${GROUP_ID}/members`]: { data: { added: 1, removed: 0 } },
    }));
    renderAt('/timetable/setup?tab=groups');
    const user = userEvent.setup();
    expect(await screen.findByText('4 students not in any group')).toBeInTheDocument();
    expect(screen.getByText(/From Assign Classes/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fix' }));
    const dialog = await screen.findByRole('dialog', { name: 'French – Class 8' });
    expect(await within(dialog).findByText('Ravi Kumar')).toBeInTheDocument();
    expect(within(dialog).getByText('Subject choice')).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Add Ravi Kumar' }));
    await waitFor(() => expect(mock.callsTo('/members', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/members', 'POST')[0]!.body).toEqual({ add: [STUDENT_ID], remove: [] });
  });

  it('(TT-18) a group with two possible teachers asks for a pick; an empty list explains what the groups are for', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/teaching-groups`]: { data: [group({ healthBadge: 'Pick a teacher', teacher: { status: 'PICK_ONE', source: null, employeeIds: [], names: [], candidates: [{ employeeId: TEACHER_1, fullName: 'Rakesh Sharma' }, { employeeId: TEACHER_2, fullName: 'Meena Rao' }] } })] } }));
    const { unmount } = renderAt('/timetable/setup?tab=groups');
    expect((await screen.findAllByText('Pick a teacher')).length).toBeGreaterThan(0);
    unmount();
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/teaching-groups`]: { data: [] } }));
    renderAt('/timetable/setup?tab=groups');
    expect(await screen.findByText('No Teaching Groups yet')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /Add Group/ }).length).toBeGreaterThan(0);
  });

  it('(TT-18) Add Group asks for the class, the subject and the sections, and sends the teacher only when one is picked', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/teaching-groups`]: { data: [] },
      [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/subjects`]: { data: [{ subjectOfferingId: SUBJECT_MATH, subjectName: 'French', offeringType: 'OPTIONAL' }] },
      [`POST ${API}/teaching-groups`]: { status: 201, data: group() },
    }));
    renderAt('/timetable/setup?tab=groups');
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: /Add Group/ }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Add Teaching Group' });
    await user.type(within(dialog).getByLabelText(/Group name/), 'French – Class 8');
    await pickOption(user, within(dialog).getByRole('combobox', { name: /^Class/ }), 'Class VIII');
    await pickOption(user, within(dialog).getByRole('combobox', { name: /^Subject/ }), /French/);
    await user.click(within(dialog).getByRole('button', { name: 'Select All' }));
    await user.click(within(dialog).getByRole('button', { name: 'Add Group' }));
    await waitFor(() => expect(mock.callsTo('/teaching-groups', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/teaching-groups', 'POST')[0]!.body).toEqual({ planId: PLAN_ID, name: 'French – Class 8', kind: 'SUBJECT', classOfferingId: CLASS_OFFERING_ID, subjectOfferingId: SUBJECT_MATH, sectionPool: [SECTION_A_ID, SECTION_B_ID] });
  });
});
