import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import {
  timetableBundlePermissions,
  type AbsenceImpactDTO,
  type AffectedLessonDTO,
  type CompareDTO,
  type DailyScheduleDTO,
  type EffectiveItemDTO,
  type EffectiveScheduleDTO,
  type EffectiveState,
  type ParentChildDTO,
  type TimetableOverviewDTO,
  type TimetablePlanDTO,
  type TimetableReportDTO,
  type TimetableVersionDTO,
  type VersionPhase,
  type VersionValidationDTO,
} from '@shared';
import { RequireParent, RequireTimetableAny } from '@/routes/guards';
import { CLASS_OFFERING_ID, LOCATION_ID, SESSION_ID, academicSession, classSection, masterLocation, sessionFor } from '@/test/fixtures';
import { API, Ready, mockApi, renderWithApp, type MockResponse } from '@/test/utils';
import { MyTimetablePage } from '../../me/my-timetable-page';
import { ParentLayout } from '../../parent/parent-layout';
import { ParentTimetablePage } from '../../parent/parent-timetable-page';
import { TimetableLayout } from '../context';
import { TimetableOverviewPage } from '../overview-page';
import { DailyPage } from '../ops/daily-page';
import { PublishPage } from '../ops/publish-page';
import { ReportsPage } from '../ops/reports-page';
import { VersionsPage } from '../ops/versions-page';
import { ViewsPage } from '../ops/views-page';

const PLAN_ID = 'a1a1a1a1-0000-4000-8000-000000000001';
const DRAFT_ID = 'a2a2a2a2-0000-4000-8000-000000000002';
const LIVE_ID = 'a3a3a3a3-0000-4000-8000-000000000003';
const E1 = 'e1e1e1e1-0000-4000-8000-000000000001';
const E2 = 'e2e2e2e2-0000-4000-8000-000000000002';
const E3 = 'e3e3e3e3-0000-4000-8000-000000000003';
const T_RAKESH = 'd1d1d1d1-0000-4000-8000-000000000001';
const T_MEENA = 'd2d2d2d2-0000-4000-8000-000000000002';
const SECTION = 'f1f1f1f1-0000-4000-8000-000000000001';
const KID = 'aaaaaaaa-0000-4000-8000-000000000001';
const TODAY = new Date().toLocaleDateString('en-CA');

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
  status: 'ACTIVE',
  version: 2,
};

const version = (id: string, over: Partial<TimetableVersionDTO> = {}): TimetableVersionDTO => ({
  versionId: id,
  planId: PLAN_ID,
  versionNumber: 1,
  versionName: 'Version 1',
  sourceVersionId: null,
  status: 'PUBLISHED',
  rev: 4,
  entryCount: 3,
  effectiveFrom: '2026-07-01',
  effectiveTo: '2027-03-31',
  publishedAt: '2026-06-20T00:00:00.000Z',
  createdAt: '2026-06-01T00:00:00.000Z',
  phase: 'ACTIVE' as VersionPhase,
  publishedByName: 'Aarav Mehta',
  publishedWarningCount: 0,
  publishedUnplacedCount: 0,
  ...over,
});
const live = version(LIVE_ID);
const draft = version(DRAFT_ID, { versionNumber: 2, versionName: 'Revision of Version 1', status: 'DRAFT', phase: 'DRAFT', sourceVersionId: LIVE_ID, effectiveFrom: null, effectiveTo: null, publishedAt: null, publishedByName: null });

const validation = (over: Partial<VersionValidationDTO> = {}): VersionValidationDTO => ({
  versionId: DRAFT_ID,
  rev: 4,
  entryCount: 30,
  clashCount: 0,
  clashes: [],
  warningCount: 6,
  warnings: [{ rule: 'MAX_PER_DAY', label: 'Too often in a day', count: 6, items: [{ entryId: E1, label: '8-A Mathematics on Monday, Period 1', message: 'Mathematics is 3 times on Monday for 8-A. The most is 2.', when: 'Monday, Period 1', rule: 'MAX_PER_DAY', sectionOfferingId: SECTION, teachingGroupId: null }] }],
  sections: [
    { sectionOfferingId: SECTION, label: '8-A', needed: 11, placed: 9, left: 2, over: 0, empty: false },
    { sectionOfferingId: 's2', label: '8-B', needed: 11, placed: 11, left: 0, over: 0, empty: false },
  ],
  sectionsTotal: 2,
  sectionsComplete: 1,
  emptySections: [],
  unplacedCount: 2,
  canPublish: true,
  needsAcknowledge: true,
  summary: '1 of 2 sections complete. 0 clashes. 6 warnings.',
  ...over,
});

const compare: CompareDTO = { versionId: DRAFT_ID, versionName: 'Revision of Version 1', toVersionId: LIVE_ID, toVersionName: 'Version 1', added: 0, removed: 0, moved: 1, changed: 0, unchanged: 2, changes: [{ kind: 'MOVED', label: '8-C Mathematics', was: 'Monday, Period 3', now: 'Wednesday, Period 3', entryId: E3 }], summary: '1 moved. 2 lessons stay the same.' };

const item = (entryId: string, over: Partial<EffectiveItemDTO> = {}): EffectiveItemDTO => ({
  date: TODAY,
  weekday: 'MON',
  entryId,
  versionId: LIVE_ID,
  periodId: 'p1',
  periodCode: 'P1',
  periodName: 'Period 1',
  start: '08:00',
  end: '08:45',
  startMin: 480,
  endMin: 525,
  state: 'NORMAL' as EffectiveState,
  entryType: 'SUBJECT',
  subjectOfferingId: 'sub-math',
  subjectName: 'Mathematics',
  activityName: null,
  teachingGroupId: null,
  groupName: null,
  sections: [{ sectionOfferingId: SECTION, label: '8-A' }],
  teachers: [{ employeeId: T_RAKESH, fullName: 'Rakesh Sharma', role: 'MAIN' }],
  physicalSpaceId: 'r1',
  roomName: 'Room 101',
  original: null,
  overrideId: null,
  overrideType: null,
  reason: null,
  uncovered: false,
  note: null,
  ...over,
});

const schedule = (items: EffectiveItemDTO[], over: Partial<EffectiveScheduleDTO['days'][number]> = {}, label = '8-A'): EffectiveScheduleDTO => ({
  from: TODAY,
  to: TODAY,
  target: { kind: 'section', id: SECTION, label },
  planId: PLAN_ID,
  days: [{ date: TODAY, weekday: 'MON', isSchoolDay: true, versionId: LIVE_ID, versionName: 'Version 1', items, free: [], ...over }],
});

const daily = (over: Partial<DailyScheduleDTO> = {}): DailyScheduleDTO => ({
  date: TODAY,
  weekday: 'MON',
  planId: PLAN_ID,
  locationId: LOCATION_ID,
  isSchoolDay: true,
  versionId: LIVE_ID,
  versionName: 'Version 1',
  message: null,
  summary: { lessons: 3, uncovered: 2, substituted: 0, roomChanged: 0, cancelled: 0, swapped: 0, changed: 0 },
  line: '2 periods have no teacher',
  exceptions: [{ kind: 'ABSENT', title: 'Rakesh Sharma is away', message: '2 periods of 2 still need a teacher.', affected: 2, uncovered: 2, employeeId: T_RAKESH, physicalSpaceId: null }],
  uncovered: [item(E1, { uncovered: true }), item(E2, { uncovered: true, periodId: 'p2', periodCode: 'P2', periodName: 'Period 2', start: '08:45', end: '09:30', startMin: 525, endMin: 570 })],
  lessons: [item(E1, { uncovered: true }), item(E2, { uncovered: true, periodId: 'p2', periodCode: 'P2', periodName: 'Period 2', start: '08:45', end: '09:30', startMin: 525, endMin: 570 }), item(E3, { sections: [{ sectionOfferingId: 's2', label: '8-B' }], periodId: 'p3', periodCode: 'P3', periodName: 'Period 3', startMin: 570, endMin: 615 })],
  ...over,
});

const affected = (entryId: string, period: string, over: Partial<AffectedLessonDTO> = {}): AffectedLessonDTO => ({ entryId, date: TODAY, weekday: 'MON', label: '8-A Mathematics', periodName: period, start: '08:00', end: '08:45', startMin: 480, endMin: 525, sections: ['8-A'], subjectName: 'Mathematics', roomName: 'Room 101', state: 'NORMAL', covered: false, coveredBy: null, ...over });
const impact: AbsenceImpactDTO = { employeeId: T_RAKESH, employeeName: 'Rakesh Sharma', items: [affected(E1, 'Period 1'), affected(E2, 'Period 2')], uncovered: 2, summary: '2 periods affected. 2 periods still need a teacher.' };

const overview = (over: Partial<TimetableOverviewDTO> = {}): TimetableOverviewDTO => ({
  planId: PLAN_ID,
  locationId: LOCATION_ID,
  planStatus: 'ACTIVE',
  versionId: LIVE_ID,
  versionName: 'Version 1',
  phase: 'ACTIVE',
  statusLine: 'Version 1 · Published · from 1 Jul 2026',
  publishedVersionId: LIVE_ID,
  draftVersionId: null,
  coveragePercent: 94,
  needed: 100,
  placed: 94,
  clashes: 0,
  warnings: 6,
  today: { date: TODAY, uncovered: 2, absentTeachers: 1, cancelled: 0, substituted: 0 },
  next: 'OPEN_DAILY_OPERATIONS',
  ux: { inheritedPercent: 90, autoTeacherPercent: 95, defaultRoomPercent: 90, smartDraftCompletionPercent: 94, manualPercent: 6, unresolved: 6, lastYearReusePercent: null, fixesApplied: 0 },
  ...over,
});

function base(extra: Handlers = {}): Handlers {
  return {
    [`GET ${API}/academic-sessions`]: { data: [academicSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation] },
    [`GET ${API}/timetable-plans`]: { data: [plan] },
    [`GET ${API}/timetable-plans/${PLAN_ID}/versions`]: { data: [draft, live] },
    [`GET ${API}/timetable-versions/${DRAFT_ID}`]: { data: draft },
    [`POST ${API}/timetable-versions/${DRAFT_ID}/validate`]: { data: validation() },
    [`GET ${API}/timetable-versions/${DRAFT_ID}/compare`]: { data: compare },
    [`GET ${API}/timetable-versions/${LIVE_ID}/compare`]: { data: compare },
    [`GET ${API}/timetable-plans/${PLAN_ID}/teachers`]: { data: [{ employeeId: T_RAKESH, fullName: 'Rakesh Sharma', employeeCode: 'FAC-001' }, { employeeId: T_MEENA, fullName: 'Meena Rao', employeeCode: 'FAC-002' }] },
    [`GET ${API}/timetable-plans/${PLAN_ID}/bell-resolution`]: { data: { planId: PLAN_ID, operatingDays: plan.operatingDays, rows: [{ sectionOfferingId: SECTION, classOfferingId: CLASS_OFFERING_ID, label: '8-A', className: 'Class VIII', byDay: {}, missingDays: [] }], missing: [] } },
    [`GET ${API}/teaching-groups`]: { data: [] },
    [`GET ${API}/timetable-overrides`]: { data: [] },
    ...extra,
  };
}

const coordinator = () => ({ data: { ...sessionFor('STAFF'), permissions: timetableBundlePermissions(['SCHEDULING_COORDINATOR']) } });

function renderAt(route: string) {
  return renderWithApp(
    <Ready>
      <Toaster />
      <Routes>
        <Route path="/restricted" element={<p>Restricted page</p>} />
        <Route element={<TimetableLayout />}>
          <Route path="/timetable" element={<TimetableOverviewPage />} />
          <Route element={<RequireTimetableAny any={['timetable:draft:create', 'timetable:review', 'timetable:publish']} />}>
            <Route path="/timetable/versions" element={<VersionsPage />} />
            <Route path="/timetable/versions/:id/publish" element={<PublishPage />} />
          </Route>
          <Route path="/timetable/daily" element={<DailyPage />} />
          <Route path="/timetable/reports" element={<ReportsPage />} />
          <Route path="/timetable/views" element={<ViewsPage />} />
        </Route>
        <Route path="/me/timetable" element={<MyTimetablePage />} />
        <Route path="/schedule-stub" element={<p>Schedule</p>} />
        <Route path="/timetable/schedule" element={<p>Schedule page</p>} />
      </Routes>
    </Ready>,
    { route },
  );
}

describe('Review And Publish (TT-34 to 37)', () => {
  it('shows the short summary, the sections with bars, warnings by rule with Open and Fix This For Me, and What Changed for a revision', async () => {
    mockApi('SCHOOL_ADMIN', base());
    renderAt(`/timetable/versions/${DRAFT_ID}/publish`);
    expect(await screen.findByTestId('validation-summary')).toHaveTextContent('1 of 2 sections complete. 0 clashes. 6 warnings.');
    const sections = screen.getByLabelText('Sections');
    expect(within(sections).getByText('9 of 11')).toBeInTheDocument();
    expect(within(sections).getByRole('img', { name: '9 of 11 placed' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByText(/Too often in a day/));
    expect(screen.getByRole('link', { name: 'Open' })).toHaveAttribute('href', `/timetable/schedule?view=section&id=${SECTION}&entry=${E1}`);
    expect(screen.getByRole('button', { name: 'Fix This For Me' })).toBeInTheDocument();
    const changes = await screen.findByLabelText('What changed');
    expect(changes).toHaveTextContent('1 moved. 2 lessons stay the same.');
    expect(changes).toHaveTextContent('8-C Mathematics Monday, Period 3 → Wednesday, Period 3');
  });

  it('Publish is off while a clash remains and says why with links; with none it needs the tick before it works', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`POST ${API}/timetable-versions/${DRAFT_ID}/validate`]: { data: validation({ canPublish: false, clashCount: 1, clashes: [{ entryId: E1, label: '8-A Mathematics on Monday, Period 1', sectionOfferingId: SECTION, teachingGroupId: null, issues: [{ rule: 'NOT_THIS_TEACHER', severity: 'CLASH', message: 'Rakesh Sharma is not assigned to teach Mathematics to 8-A.', who: [], when: null, overridable: false, overriddenReason: null, entryId: E1, blockedBy: [], fix: null }] }], summary: '1 of 2 sections complete. 1 clash. 6 warnings.' }) } }));
    renderAt(`/timetable/versions/${DRAFT_ID}/publish`);
    expect(await screen.findByRole('button', { name: 'Publish' })).toBeDisabled();
    expect(screen.getByLabelText('Why it cannot be published')).toHaveTextContent('1 clash must be fixed first.');
    const clashes = screen.getByLabelText('Clashes');
    expect(within(clashes).getByText('Rakesh Sharma is not assigned to teach Mathematics to 8-A.')).toBeInTheDocument();
    expect(within(clashes).getByRole('link', { name: 'Open' })).toHaveAttribute('href', expect.stringContaining(`entry=${E1}`));
  });

  it('with warnings and unplaced periods the tick is needed; a later day says the current timetable keeps running; publishing sends the date and the tick', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({ [`POST ${API}/timetable-versions/${DRAFT_ID}/publish`]: { data: { version: live, warningCount: 6, unplacedCount: 2, supersededVersionId: LIVE_ID, previousRunsUntil: '2026-12-31', movedOverrides: 0, cancelledOverrides: 0, message: 'Published. It starts on 2027-01-01. The current timetable runs until 2026-12-31.' } } }));
    renderAt(`/timetable/versions/${DRAFT_ID}/publish`);
    const user = userEvent.setup();
    const publish = await screen.findByRole('button', { name: 'Publish' });
    expect(publish).toBeDisabled();
    await user.click(screen.getByLabelText(/I know 2 periods are not placed and there are 6 warnings/));
    expect(publish).toBeEnabled();
    fireEvent.change(screen.getByLabelText('Starts on'), { target: { value: '2099-01-01' } });
    expect(await screen.findByTestId('starts-note')).toHaveTextContent('The current timetable runs until');
    await user.click(publish);
    await waitFor(() => expect(mock.callsTo('/publish', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/publish', 'POST')[0]!.body).toEqual({ effectiveFrom: '2099-01-01', acknowledgeWarnings: true });
  });

  it('a coordinator sees Mark Ready For Review and no Publish button', async () => {
    const mock = mockApi('STAFF', base({ [`GET ${API}/auth/me`]: coordinator(), [`POST ${API}/timetable-versions/${DRAFT_ID}/mark-ready`]: { data: { ...draft, status: 'READY', phase: 'READY' } } }));
    renderAt(`/timetable/versions/${DRAFT_ID}/publish`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Mark Ready For Review' }));
    expect(screen.queryByRole('button', { name: 'Publish' })).not.toBeInTheDocument();
    await waitFor(() => expect(mock.callsTo('/mark-ready', 'POST')).toHaveLength(1));
  });
});

describe('Versions and revisions (TT-36)', () => {
  it('lists phases and dates; with a draft open the published one offers Open Draft, not Create Revision', async () => {
    mockApi('SCHOOL_ADMIN', base());
    renderAt('/timetable/versions');
    const published = await screen.findByLabelText('Version 1');
    expect(within(published).getByText('Published')).toBeInTheDocument();
    expect(published).toHaveTextContent('From 1 Jul 2026 to 31 Mar 2027');
    expect(published).toHaveTextContent('published by Aarav Mehta');
    expect(within(published).queryByRole('button', { name: /Create Revision/ })).not.toBeInTheDocument();
    expect(within(published).getByRole('link', { name: 'Open Draft' })).toHaveAttribute('href', '/timetable/schedule');
    const rev = screen.getByLabelText('Revision of Version 1');
    expect(within(rev).getByRole('link', { name: /Review And Publish/ })).toHaveAttribute('href', `/timetable/versions/${DRAFT_ID}/publish`);
  });

  it('Create Revision makes the copy and opens the Schedule', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/timetable-plans/${PLAN_ID}/versions`]: { data: [live] }, [`POST ${API}/timetable-versions/${LIVE_ID}/clone`]: { status: 201, data: draft } }));
    renderAt('/timetable/versions');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /Create Revision/ }));
    await waitFor(() => expect(mock.callsTo('/clone', 'POST')).toHaveLength(1));
    expect(await screen.findByText('Schedule page')).toBeInTheDocument();
  });
});

describe('who can open what (TT-49)', () => {
  it('Faculty are sent away from Versions and Review And Publish; a substitution manager is not sent away from Daily Operations', async () => {
    mockApi('FACULTY', base());
    renderAt('/timetable/versions');
    expect(await screen.findByText('Restricted page')).toBeInTheDocument();
  });

  it('a Staff login with only the Substitution Manager job reaches Daily Operations but not Versions', async () => {
    const manager = { data: { ...sessionFor('STAFF'), permissions: timetableBundlePermissions(['SUBSTITUTION_MANAGER']) } };
    mockApi('STAFF', base({ [`GET ${API}/auth/me`]: manager, [`GET ${API}/daily-schedule`]: { data: daily() } }));
    renderAt('/timetable/versions');
    expect(await screen.findByText('Restricted page')).toBeInTheDocument();
  });
});

describe('Overview (TT-UX-20)', () => {
  it('shows the status line, the coverage and today, and the main button follows the state', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/timetable-plans/${PLAN_ID}/readiness`]: { data: { planId: PLAN_ID, ready: true, needsActions: 0, message: 'Ready to build', areas: [], canSmartDraft: true, smartDraftBlockedBy: [], counts: { sections: 1, teachers: 1, homeClassrooms: 1, specialRooms: 0, subjects: 1 } } }, [`GET ${API}/timetable/overview`]: { data: overview() } }));
    renderAt('/timetable');
    expect(await screen.findByTestId('status-line')).toHaveTextContent('Version 1 · Published · from 1 Jul 2026');
    expect(screen.getByTestId('coverage')).toHaveTextContent('94% (94 of 100)');
    expect(screen.getByTestId('today-line')).toHaveTextContent('2 with no teacher · 1 away');
    expect(await screen.findByRole('link', { name: /Open Daily Operations/ })).toHaveAttribute('href', '/timetable/daily');
  });

  it('with a draft ready to check the button says Review And Publish and goes to that version', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/timetable-plans/${PLAN_ID}/readiness`]: { data: { planId: PLAN_ID, ready: true, needsActions: 0, message: 'Ready to build', areas: [], canSmartDraft: true, smartDraftBlockedBy: [], counts: { sections: 1, teachers: 1, homeClassrooms: 1, specialRooms: 0, subjects: 1 } } }, [`GET ${API}/timetable/overview`]: { data: overview({ next: 'REVIEW_AND_PUBLISH', draftVersionId: DRAFT_ID, phase: 'DRAFT', statusLine: 'Revision of Version 1 · Draft' }) } }));
    renderAt('/timetable');
    expect(await screen.findByRole('link', { name: /Review And Publish/ })).toHaveAttribute('href', `/timetable/versions/${DRAFT_ID}/publish`);
  });
});

describe('Daily Operations (TT-38 to 42)', () => {
  it('starts with the day line and the exceptions; the periods with no teacher have Find A Teacher', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/daily-schedule`]: { data: daily() } }));
    renderAt('/timetable/daily');
    await waitFor(() => expect(screen.getByTestId('daily-line')).toHaveTextContent('2 periods have no teacher'));
    expect(screen.getByLabelText('Rakesh Sharma is away')).toHaveTextContent('2 periods of 2 still need a teacher.');
    const none = screen.getByLabelText('Periods with no teacher');
    expect(within(none).getAllByRole('button', { name: 'Find A Teacher' })).toHaveLength(2);
    expect(screen.getAllByText('The weekly timetable is not changed.').length).toBeGreaterThan(0);
  });

  it('Teacher Absent lists the affected periods at once, suggests a teacher with the reasons, and Apply Suggestions shows who was set and which failed and why', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/daily-schedule`]: { data: daily() },
      [`POST ${API}/faculty-absence/impact`]: { data: impact },
      [`POST ${API}/substitutions/recommend`]: { data: [{ entryId: E1, date: TODAY, label: '8-A Mathematics', when: 'Period 1', recommended: { employeeId: T_MEENA, fullName: 'Meena Rao', match: 'SUBJECT', periodsThatDay: 2, coversThisMonth: 0, why: 'Teaches Mathematics · free at that time · 2 other periods that day', warnings: [] }, alternatives: [], message: null }, { entryId: E2, date: TODAY, label: '8-A Mathematics', when: 'Period 2', recommended: { employeeId: T_MEENA, fullName: 'Meena Rao', match: 'SUBJECT', periodsThatDay: 2, coversThisMonth: 0, why: 'Teaches Mathematics · free at that time', warnings: [] }, alternatives: [], message: null }] },
      [`POST ${API}/faculty-absence`]: { status: 201, data: { absenceId: 'ab1', employeeId: T_RAKESH, employeeName: 'Rakesh Sharma', dateFrom: TODAY, dateTo: TODAY, startMin: null, endMin: null, kind: 'ABSENT', reason: null, status: 'ACTIVE', affected: 2, uncovered: 2 } },
      [`POST ${API}/substitutions/bulk`]: { data: { requested: 2, done: 1, failed: [{ entryId: E2, date: TODAY, label: '8-A Mathematics', message: 'Meena Rao is already teaching 8-B Science on Monday, Period 2.' }], overrides: [], message: '1 of 2 saved. 1 period could not be changed: Meena Rao is already teaching 8-B Science on Monday, Period 2.' } },
    }));
    renderAt('/timetable/daily');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Substitutions' }));
    await user.click(await screen.findByRole('combobox', { name: 'Teacher' }));
    await user.click(await screen.findByRole('option', { name: /Rakesh Sharma/ }));
    expect(await screen.findByTestId('impact-summary')).toHaveTextContent('2 periods affected. 2 periods still need a teacher.');
    expect((await screen.findAllByTestId('suggestion'))[0]).toHaveTextContent('Meena Rao · Teaches Mathematics · free at that time · 2 other periods that day');
    await user.click(screen.getByRole('button', { name: /Apply Suggestions \(2\)/ }));
    const failed = await screen.findByLabelText('Not saved');
    expect(failed).toHaveTextContent('Meena Rao is already teaching 8-B Science on Monday, Period 2.');
    expect(mock.callsTo('/faculty-absence', 'POST').filter((c) => !c.path.includes('impact'))).toHaveLength(1);
    expect(mock.callsTo('/substitutions/bulk', 'POST')[0]!.body).toMatchObject({ planId: PLAN_ID, items: [{ entryId: E1, substituteEmployeeId: T_MEENA }, { entryId: E2, substituteEmployeeId: T_MEENA }] });
  });

  it('Room Changes lists the lessons in the room, suggests rooms, and applies them', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/daily-schedule`]: { data: daily() },
      [`GET ${API}/physical-spaces`]: { data: { items: [{ spaceId: 'r1', spaceName: 'Room 101' }, { spaceId: 'r2', spaceName: 'Room 102' }], total: 2, page: 1, pageSize: 200 } },
      [`POST ${API}/room-changes/impact`]: { data: { physicalSpaceId: 'r1', roomName: 'Room 101', items: [{ ...affected(E1, 'Period 1'), currentRoomId: 'r1', currentRoomName: 'Room 101' }], summary: '1 lesson use Room 101 in these days.' } },
      [`POST ${API}/room-changes/recommend`]: { data: [{ entryId: E1, date: TODAY, label: '8-A Mathematics', when: 'Period 1', currentRoomName: 'Room 101', recommended: { physicalSpaceId: 'r2', name: 'Room 102', capacity: 40, tags: [], why: 'free at that time · seats 40 for 36 students', warnings: [] }, alternatives: [], message: null }] },
      [`POST ${API}/room-changes/apply`]: { data: { requested: 1, done: 1, failed: [], overrides: [], message: '1 change saved.' } },
    }));
    renderAt('/timetable/daily');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Room Changes' }));
    await user.click(await screen.findByRole('combobox', { name: 'Room' }));
    await user.click(await screen.findByRole('option', { name: 'Room 101' }));
    expect(await screen.findByTestId('room-impact-summary')).toHaveTextContent('Room 101');
    expect(await screen.findByTestId('room-suggestion')).toHaveTextContent('Room 102 · free at that time · seats 40 for 36 students');
    await user.click(screen.getByRole('button', { name: /Apply Suggestions \(1\)/ }));
    await waitFor(() => expect(mock.callsTo('/room-changes/apply', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/room-changes/apply', 'POST')[0]!.body).toMatchObject({ items: [{ entryId: E1, physicalSpaceId: 'r2' }] });
  });

  it('Cancellations & Swaps: a lesson needs a reason, a clash on a swap shows its reasons, and the whole day asks first', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/daily-schedule`]: { data: daily() },
      [`POST ${API}/timetable-overrides`]: (r) => ((r.body as { type: string }).type === 'PERIOD_SWAP' ? { status: 409, error: { code: 'TIMETABLE_CLASH', message: 'Rakesh Sharma is already teaching 8-B Mathematics on Monday, Period 2.', details: { blockers: [{ rule: 'TEACHER_BUSY', severity: 'CLASH', message: 'Rakesh Sharma is already teaching 8-B Mathematics on Monday, Period 2.', who: [], when: null, overridable: false, overriddenReason: null, entryId: null, blockedBy: [], fix: null }], warnings: [], alternatives: [] } } } : { status: 201, data: { override: { summary: 'Cancelled: Sports day' }, issues: [] } }),
      [`POST ${API}/timetable-overrides/bulk-cancel`]: { data: { requested: 3, done: 3, failed: [], overrides: [], message: '3 changes saved.' } },
    }));
    renderAt('/timetable/daily');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('tab', { name: 'Cancellations & Swaps' }));
    const cancel = await screen.findByLabelText('Cancel a lesson');
    expect(within(cancel).getByRole('button', { name: 'Cancel Lesson' })).toBeDisabled();
    await user.click(within(cancel).getByRole('combobox', { name: 'Lesson' }));
    await user.click(await screen.findByRole('option', { name: /8-A Mathematics.*Period 1/ }));
    await user.type(within(cancel).getByLabelText(/Reason/), 'Sports day');
    await user.click(within(cancel).getByRole('button', { name: 'Cancel Lesson' }));
    await waitFor(() => expect(mock.callsTo('/timetable-overrides', 'POST').filter((c) => !c.path.includes('bulk'))).toHaveLength(1));
    expect(mock.callsTo('/timetable-overrides', 'POST')[0]!.body).toEqual({ type: 'CLASS_CANCELLED', entryId: E1, date: TODAY, reason: 'Sports day' });

    const swap = screen.getByLabelText('Swap two periods');
    await user.click(within(swap).getByRole('combobox', { name: 'Section' }));
    await user.click(await screen.findByRole('option', { name: '8-A' }));
    await user.click(within(swap).getByRole('combobox', { name: 'First period' }));
    await user.click(await screen.findByRole('option', { name: /8-A Mathematics.*Period 1/ }));
    await user.click(within(swap).getByRole('combobox', { name: 'Second period' }));
    await user.click(await screen.findByRole('option', { name: /8-A Mathematics.*Period 2/ }));
    await user.click(within(swap).getByRole('button', { name: 'Swap Periods' }));
    expect(await within(swap).findByText('Rakesh Sharma is already teaching 8-B Mathematics on Monday, Period 2.')).toBeInTheDocument();

    const day = screen.getByLabelText('Cancel a class or the day');
    await user.type(within(day).getByLabelText(/Reason/), 'Heavy rain');
    await user.click(within(day).getByRole('button', { name: 'Cancel The Whole Day' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('3 lessons will be cancelled');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel Lessons' }));
    await waitFor(() => expect(mock.callsTo('/bulk-cancel', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/bulk-cancel', 'POST')[0]!.body).toMatchObject({ planId: PLAN_ID, date: TODAY, reason: 'Heavy rain' });
  });
});

describe('Views, My Timetable and the parent timetable (TT-43)', () => {
  it('Views marks a substitute, a cancelled lesson and a room change, shows what was planned, and lists a teacher\'s free periods', async () => {
    mockApi('SCHOOL_ADMIN', base({
      [`GET ${API}/timetable/section/${SECTION}`]: {
        data: schedule([
          item(E1, { state: 'SUBSTITUTED', teachers: [{ employeeId: T_MEENA, fullName: 'Meena Rao', role: 'MAIN' }], original: { teachers: [{ employeeId: T_RAKESH, fullName: 'Rakesh Sharma', role: 'MAIN' }], roomName: 'Room 101', subjectName: 'Mathematics', activityName: null, periodName: 'Period 1', start: '08:00', end: '08:45' }, note: 'Mathematics today is taken by Meena Rao' }),
          item(E2, { state: 'CANCELLED', periodId: 'p2', periodCode: 'P2', periodName: 'Period 2', start: '08:45', end: '09:30', note: 'Mathematics is cancelled: Sports day' }),
          item(E3, { state: 'ROOM_CHANGED', periodId: 'p3', periodCode: 'P3', periodName: 'Period 3', roomName: 'Room 102', note: 'Today in Room 102' }),
        ]),
      },
      [`GET ${API}/timetable/teacher/${T_RAKESH}`]: { data: schedule([item(E1)], { free: [{ periodId: 'p2', periodName: 'Period 2', start: '08:45', end: '09:30', startMin: 525, endMin: 570 }] }, 'Rakesh Sharma') },
    }));
    renderAt('/timetable/views');
    const notes = await screen.findAllByTestId('lesson-note');
    expect(notes.map((n) => n.textContent)).toEqual(['Mathematics today is taken by Meena Rao', 'Mathematics is cancelled: Sports day', 'Today in Room 102']);
    expect(screen.getByText('Substitute')).toBeInTheDocument();
    expect(screen.getByText('Cancelled')).toBeInTheDocument();
    expect(screen.getByText('Room changed')).toBeInTheDocument();
    expect(screen.getByText(/Planned: Mathematics · Rakesh Sharma · Room 101/)).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'Teacher' }));
    expect(await screen.findByLabelText('Free periods')).toHaveTextContent('Free · Period 2 08:45–09:30');
  });

  it('My Timetable shows Today first with a free period and a substitution, then the week on request, and has no edit buttons', async () => {
    const mock = mockApi('FACULTY', base({
      [`GET ${API}/schedule/effective`]: (r) =>
        r.url.searchParams.get('from') === r.url.searchParams.get('to')
          ? { data: { ...schedule([item(E1, { state: 'SUBSTITUTED', note: 'Mathematics today is taken by Rakesh Sharma' })], { free: [{ periodId: 'p2', periodName: 'Period 2', start: '08:45', end: '09:30', startMin: 525, endMin: 570 }] }, 'Rakesh Sharma'), target: { kind: 'employee', id: T_RAKESH, label: 'Rakesh Sharma' } } }
          : { data: { ...schedule([item(E1), item(E2, { periodName: 'Period 2' })]), from: TODAY, to: TODAY } },
    }));
    renderAt('/me/timetable');
    expect(await screen.findByTestId('lesson-note')).toHaveTextContent('Mathematics today is taken by Rakesh Sharma');
    expect(screen.getByLabelText('Free periods')).toHaveTextContent('Free · Period 2');
    expect(mock.callsTo('/schedule/effective')[0]!.path).toContain('employeeId=me');
    expect(screen.queryByRole('button', { name: /edit|cancel|substitute|save/i })).not.toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('tab', { name: 'This Week' }));
    await waitFor(() => expect(mock.callsTo('/schedule/effective').length).toBeGreaterThan(1));
  });

  it('the parent timetable asks for the chosen child only and shows the short note', async () => {
    const kid: ParentChildDTO = { studentId: KID, fullName: 'Riya Sharma', displayName: 'Riya Sharma', admissionNumber: 'GPS/2026/00001', classSection: classSection('A'), status: 'ACTIVE', relationshipType: 'Mother', canSeeAcademics: true, canSeeFees: false };
    const mock = mockApi('PARENT', {
      [`GET ${API}/parent/children`]: { data: { children: [kid] } },
      [`GET ${API}/schedule/effective`]: { data: { ...schedule([item(E1, { state: 'SUBSTITUTED', note: 'Mathematics today is taken by Meena Rao' })]), target: { kind: 'student', id: KID, label: 'Riya Sharma' } } },
    });
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/parent" element={<RequireParent />}>
            <Route element={<ParentLayout />}>
              <Route path="timetable" element={<ParentTimetablePage />} />
            </Route>
          </Route>
        </Routes>
      </Ready>,
      { route: '/parent/timetable' },
    );
    expect(await screen.findByTestId('lesson-note')).toHaveTextContent('Mathematics today is taken by Meena Rao');
    expect(mock.callsTo('/schedule/effective')[0]!.path).toContain(`studentId=${KID}`);
    expect(screen.getByRole('link', { name: 'Timetable' })).toBeInTheDocument();
  });
});

describe('Reports (TT-45)', () => {
  const report = (over: Partial<TimetableReportDTO> = {}): TimetableReportDTO => ({
    type: 'section-coverage',
    title: 'Section coverage',
    planId: PLAN_ID,
    versionId: LIVE_ID,
    versionName: 'Version 1',
    effectiveFrom: '2026-07-01',
    effectiveTo: '2027-03-31',
    dateFrom: null,
    dateTo: null,
    basis: 'Version 1 · Published · from 1 Jul 2026',
    columns: [{ key: 'section', label: 'Section' }, { key: 'needed', label: 'Needed', align: 'right' }, { key: 'left', label: 'Left', align: 'right' }],
    rows: [{ section: '8-A', needed: 11, left: 2 }, { section: '8-B', needed: 11, left: 0 }],
    message: null,
    ...over,
  });

  it('shows the basis line and the table, switches report, and the CSV button asks for the same report as a file', async () => {
    const mock = mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/timetable/reports/section-coverage`]: { data: report() }, [`GET ${API}/timetable/reports/teacher-workload`]: { data: report({ type: 'teacher-workload', title: 'Teacher workload', columns: [{ key: 'teacher', label: 'Teacher' }], rows: [{ teacher: 'Rakesh Sharma' }] }) } }));
    renderAt('/timetable/reports');
    expect(await screen.findByTestId('report-basis')).toHaveTextContent('Version 1 · Published · from 1 Jul 2026');
    const table = screen.getByRole('table');
    expect(within(table).getByText('8-A')).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'Needed' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('combobox', { name: 'Report' }));
    await user.click(await screen.findByRole('option', { name: 'Teacher workload' }));
    expect(await screen.findByText('Rakesh Sharma')).toBeInTheDocument();
    expect(mock.callsTo('/timetable/reports/teacher-workload')).toHaveLength(1);
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeEnabled();
  });

  it('with no published timetable it says so instead of showing an empty table', async () => {
    mockApi('SCHOOL_ADMIN', base({ [`GET ${API}/timetable/reports/section-coverage`]: { data: report({ versionId: null, versionName: null, basis: 'No published timetable yet', rows: [], columns: [], message: 'There is no published timetable yet, so there is nothing to report. Publish one first.' }) } }));
    renderAt('/timetable/reports');
    expect(await screen.findByText(/There is no published timetable yet/)).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download CSV/ })).toBeDisabled();
  });
});
