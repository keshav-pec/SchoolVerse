import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Route, Routes } from 'react-router';
import { Toaster } from 'sonner';
import type { AcademicSessionDTO, HomeClassroomDTO, RecommendationSetDTO, RolloverSummaryDTO, RoomRefDTO, SectionRefDTO, SpaceAttentionDTO, SpaceAttentionGroupDTO, SpaceAttentionRowDTO, SpaceContextDTO, SpaceDTO, SpaceReportDTO, SpaceTreeDTO, SpaceTypeDTO } from '@shared';
import { academicSession, CLASS_OFFERING_ID, LOCATION_ID, masterLocation, SECTION_A_ID, SECTION_B_ID, SESSION_ID } from '@/test/fixtures';
import { API, Ready, mockApi, pickOption, renderWithApp, type MockResponse } from '@/test/utils';
import { StudentContextProvider } from '../../students/context';
import { RequireSpacePermission } from '@/routes/guards';
import { AllocationPage } from '../allocation-page';
import { useSpaceAttentionCount } from '../attention';
import { SpaceAttentionPage } from '../attention-page';
import { MyClassroomCard } from '../my-classroom-card';
import { SpaceReportsPage } from '../reports-page';
import { roomOptions } from '../room-picker';
import { RolloverPage } from '../rollover-page';
import { BuildPanel } from '../build-panel';
import { Inspector } from '../inspector';
import { SpaceTypesPage } from '../types-page';
import { WorkspacePage } from '../workspace-page';

/** A wide screen shows the room panel beside the table. A narrow one (the default in tests) opens it in a side drawer. */
function wideScreen() {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: true, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

const BUILDING_ID = 'b1b1b1b1-0000-4000-8000-000000000001';
const FLOOR_ID = 'f1f1f1f1-0000-4000-8000-000000000001';
const TYPE_STD = 't1t1t1t1-0000-4000-8000-000000000001';
const TYPE_LAB = 't2t2t2t2-0000-4000-8000-000000000002';

const stdType = { spaceTypeId: TYPE_STD, code: 'STANDARD_CLASSROOM', name: 'Standard Classroom', isOutdoor: false };

function room(id: string, name: string, over: Partial<SpaceDTO> = {}): SpaceDTO {
  return {
    spaceId: id,
    locationId: LOCATION_ID,
    building: { buildingId: BUILDING_ID, buildingCode: 'MAB', buildingName: 'Main Block' },
    floor: { floorId: FLOOR_ID, floorCode: 'F1', floorName: 'First Floor', floorNumber: 1 },
    spaceCode: name.replace(/\D/g, '') || 'R1',
    spaceName: name,
    roomNumber: null,
    type: stdType,
    physicalCapacity: 45,
    academicCapacity: { value: 40, source: 'TYPE_DEFAULT' },
    examCapacity: null,
    schedulable: { value: true, source: 'TYPE_DEFAULT' },
    homeClassroomEligible: { value: true, source: 'TYPE_DEFAULT' },
    suitabilityTags: { value: ['GENERAL_TEACHING'], source: 'TYPE_DEFAULT' },
    features: [],
    status: 'ACTIVE',
    effectiveStatus: { available: true, status: 'ACTIVE', reason: null },
    archiveAfterDate: null,
    needsReadinessRecheck: false,
    warnings: [],
    version: 3,
    ...over,
  };
}

const context = (r: SpaceDTO): SpaceContextDTO => ({ ...r, locationName: 'Mohali Campus', path: 'Main Block › First Floor › ' + r.spaceName, activeBlock: null, upcomingBlocks: [], homeClassroom: null });

const types: SpaceTypeDTO[] = [
  { spaceTypeId: TYPE_STD, code: 'STANDARD_CLASSROOM', name: 'Standard Classroom', isSchedulable: true, isHomeClassroomEligible: true, defaultSuitabilityTags: ['GENERAL_TEACHING'], defaultAcademicCapacity: 40, isOutdoor: false, isSystem: true, status: 'ACTIVE', roomCount: 34 },
  { spaceTypeId: TYPE_LAB, code: 'COMPUTER_LAB', name: 'Computer Lab', isSchedulable: true, isHomeClassroomEligible: false, defaultSuitabilityTags: ['COMPUTER_PRACTICAL'], defaultAcademicCapacity: 30, isOutdoor: false, isSystem: true, status: 'ACTIVE', roomCount: 2 },
];

const tree = (over: Partial<SpaceTreeDTO> = {}): SpaceTreeDTO => ({
  locationId: LOCATION_ID,
  locationName: 'Mohali Campus',
  buildings: [{ buildingId: BUILDING_ID, buildingCode: 'MAB', buildingName: 'Main Block', buildingType: 'ACADEMIC', status: 'ACTIVE', roomCount: 3, floors: [{ floorId: FLOOR_ID, floorCode: 'F1', floorName: 'First Floor', floorNumber: 1, status: 'ACTIVE', roomCount: 3, unavailableBecause: null }] }],
  outdoorCount: 0,
  totals: { buildings: 1, floors: 1, rooms: 3, schedulableRooms: 3 },
  ...over,
});

const list = (items: SpaceDTO[]) => ({ items, total: items.length, page: 1, pageSize: 50 });

/** What every Campus screen needs to know about the year and campus. */
function baseHandlers(extra: Record<string, MockResponse | ((r: { url: URL; method: string; body: unknown }) => MockResponse | undefined)> = {}) {
  return {
    [`GET ${API}/academic-sessions`]: { data: [academicSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation] },
    [`GET ${API}/space-types`]: { data: types },
    [`GET ${API}/locations/${LOCATION_ID}/space-tree`]: { data: tree() },
    [`GET ${API}/spaces/attention`]: { data: attentionOf([]) },
    ...extra,
  };
}

function renderWorkspace(route = '/spaces') {
  return renderWithApp(
    <Ready>
      <StudentContextProvider>
        <Routes>
          <Route path="/spaces" element={<WorkspacePage />} />
        </Routes>
      </StudentContextProvider>
    </Ready>,
    { route },
  );
}

const A = room('a0000000-0000-4000-8000-00000000000a', 'Room 101');
const B = room('b0000000-0000-4000-8000-00000000000b', 'Room 102');
const C = room('c0000000-0000-4000-8000-00000000000c', 'Room 103', { academicCapacity: { value: null, source: 'TYPE_DEFAULT' }, warnings: [{ code: 'MISSING_ACADEMIC_CAPACITY', message: 'Add how many students this room can hold, so classes can be matched to it.' }] });

// Part 4: sections, room references and the Needs Attention answer.
const SECTION_C = 'dddddddd-0000-4000-8000-00000000000c';
const BIG = room('e0000000-0000-4000-8000-00000000000e', 'Room 109', { academicCapacity: { value: 60, source: 'OVERRIDE' } });
const LAB = room('f0000000-0000-4000-8000-00000000000f', 'Computer Lab', { type: { spaceTypeId: TYPE_LAB, code: 'COMPUTER_LAB', name: 'Computer Lab', isOutdoor: false }, homeClassroomEligible: { value: false, source: 'TYPE_DEFAULT' } });
const SHUT = room('90000000-0000-4000-8000-000000000009', 'Room 104', { status: 'TEMPORARILY_UNAVAILABLE', effectiveStatus: { available: false, status: 'TEMPORARILY_UNAVAILABLE', reason: 'Under repair.' } });

function ref(r: SpaceDTO): RoomRefDTO {
  return { spaceId: r.spaceId, spaceCode: r.spaceCode, spaceName: r.spaceName, path: `Main Block › First Floor › ${r.spaceName}`, academicCapacity: r.academicCapacity.value, physicalCapacity: r.physicalCapacity, effectiveStatus: r.effectiveStatus, homeClassroomEligible: r.homeClassroomEligible.value };
}
const sec = (sectionOfferingId: string, label: string, strength: number): SectionRefDTO => ({ sectionOfferingId, classOfferingId: CLASS_OFFERING_ID, academicSessionId: SESSION_ID, locationId: LOCATION_ID, className: 'Class 8', sectionCode: label.slice(-1), label, strength });

function attentionOf(groups: SpaceAttentionGroupDTO[]): SpaceAttentionDTO {
  const all = (['CLASSROOM_ALLOCATION', 'CAPACITY', 'SPACE_SETUP', 'AVAILABILITY', 'HIERARCHY'] as const).map((g) => groups.find((x) => x.group === g) ?? { group: g, title: g, count: 0, rows: [] });
  const total = all.reduce((n, g) => n + g.count, 0);
  return { academicSessionId: SESSION_ID, locationId: LOCATION_ID, groups: all, counts: { needsAttention: total, byGroup: Object.fromEntries(all.map((g) => [g.group, g.count])) as SpaceAttentionDTO['counts']['byGroup'] }, kpis: { recommendedAutomaticallyPercent: 80, rolloverReusePercent: null, inheritedPropertyPercent: 90, setupCompletenessPercent: 94 } };
}

function homeRow(id: string, section: SectionRefDTO, r: SpaceDTO, over: Partial<HomeClassroomDTO> = {}): HomeClassroomDTO {
  return { assignmentId: id, academicSessionId: SESSION_ID, section, room: ref(r), shiftId: null, effectiveFrom: '2026-04-01', effectiveTo: null, phase: 'ACTIVE', status: 'ACTIVE', source: 'SYSTEM_RECOMMENDED', reason: null, capacityOverride: null, assignedBy: null, warnings: [], version: 1, ...over };
}

// ───────────────────────────────────────────────────────────── workspace

describe('Space Setup workspace (Module 5, Part 2)', () => {
  it('(SPACE-01) a campus with no rooms shows three ways to start', async () => {
    mockApi('SCHOOL_ADMIN', baseHandlers({ [`GET ${API}/locations/${LOCATION_ID}/space-tree`]: { data: tree({ buildings: [], totals: { buildings: 0, floors: 0, rooms: 0, schedulableRooms: 0 } }) }, [`GET ${API}/physical-spaces`]: { data: list([]) } }));
    renderWorkspace();
    expect(await screen.findByText('Recommended', {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /build campus structure/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('link', { name: /import spreadsheet/i })).toHaveAttribute('href', '/spaces/imports');
    expect(screen.getByRole('button', { name: /copy from another location/i })).toBeInTheDocument();
  });

  it('(SPACE-02) shows the tree with counts, the totals, and the rooms of the campus', async () => {
    mockApi('SCHOOL_ADMIN', baseHandlers({ [`GET ${API}/physical-spaces`]: { data: list([A, B, C]) } }));
    renderWorkspace();
    expect(await screen.findByRole('button', { name: 'Room 101' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Campus structure' });
    expect(within(nav).getByRole('button', { name: 'Main Block, 3 rooms' })).toBeInTheDocument();
    expect(within(nav).getByRole('button', { name: 'First Floor, 3 rooms' })).toBeInTheDocument();
    // A room with no seats says so right in the list.
    expect(screen.getByLabelText('Seats not set')).toBeInTheDocument();
  });

  it('(SPACE-08) ticking rooms shows the multi-select bar with a count, and a change shows "2 rooms will change" before it is applied', async () => {
    const mock = mockApi('SCHOOL_ADMIN', {
      ...baseHandlers({ [`GET ${API}/physical-spaces`]: { data: list([A, B, C]) } }),
      [`PATCH ${API}/physical-spaces/bulk`]: ({ body }) => {
        const b = body as { dryRun?: boolean };
        const result = { dryRun: !!b.dryRun, done: [{ spaceId: A.spaceId, spaceCode: '101' }, { spaceId: B.spaceId, spaceCode: '102' }], skipped: [{ spaceId: C.spaceId, spaceCode: '103', reason: 'Archived rooms cannot be changed.' }], message: b.dryRun ? '' : '2 rooms changed, 1 skipped.' };
        return { data: result };
      },
    });
    renderWorkspace();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('checkbox', { name: 'Select Room 101' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Room 102' }));
    expect(screen.getByTestId('bulk-count')).toHaveTextContent('2 rooms selected');

    await user.click(screen.getByRole('button', { name: /set capacity/i }));
    await user.type(await screen.findByLabelText(/^number/i), '45');
    expect(await screen.findByText(/2 rooms will change · 1 will be skipped/i)).toBeInTheDocument();
    expect(screen.getByText(/archived rooms cannot be changed/i)).toBeInTheDocument();
    // Nothing was saved by the preview.
    expect(mock.callsTo('/physical-spaces/bulk', 'PATCH').every((c) => (c.body as { dryRun?: boolean }).dryRun)).toBe(true);

    await user.click(screen.getByRole('button', { name: /change 2 rooms/i }));
    expect(await screen.findByTestId('bulk-result')).toHaveTextContent('2 rooms changed, 1 skipped.');
    expect(mock.callsTo('/physical-spaces/bulk', 'PATCH').at(-1)!.body).toMatchObject({ ids: [A.spaceId, B.spaceId], changes: { academicCapacity: 45 } });
  });

  it('(SPACE-59) Faculty see the rooms with no edit controls', async () => {
    const restore = wideScreen();
    mockApi('FACULTY', {
      ...baseHandlers({ [`GET ${API}/physical-spaces`]: { data: list([A, B]) }, [`GET ${API}/physical-spaces/${A.spaceId}`]: { data: context(A) }, [`GET ${API}/physical-spaces/${A.spaceId}/availability-blocks`]: { data: [] } }),
    });
    renderWorkspace(`/spaces?room=${A.spaceId}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Rooms' })).toBeInTheDocument();
    expect(await screen.findByLabelText('Name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /build campus structure/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /more actions/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^customize$/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /make unavailable/i })).not.toBeInTheDocument();
    restore();
  });
});

// ───────────────────────────────────────────────────────────── room generator

describe('Room generator (Module 5, Part 2)', () => {
  it('(SPACE-21) shows the exact codes before anything is created, with clashes in red, and blocks the button', async () => {
    const mock = mockApi('SCHOOL_ADMIN', {
      ...baseHandlers(),
      [`GET ${API}/buildings/${BUILDING_ID}/floors`]: { data: [{ floorId: FLOOR_ID, buildingId: BUILDING_ID, floorCode: 'F1', floorName: 'First Floor', floorNumber: 1, levelType: 'UPPER', status: 'ACTIVE', effectiveFrom: null, effectiveTo: null, version: 1, roomCount: 1, unavailableBecause: null }] },
      [`POST ${API}/floors/${FLOOR_ID}/spaces/generate/preview`]: {
        data: {
          rows: [
            { spaceCode: '101', spaceName: 'Room 101', roomNumber: '101', clash: 'CODE_TAKEN', clashMessage: 'Room 101 already uses the code 101.' },
            { spaceCode: '102', spaceName: 'Room 102', roomNumber: '102', clash: null, clashMessage: null },
          ],
          willCreate: 1,
          alreadyThere: 0,
          clashes: 1,
        },
      },
    });
    renderWithApp(
      <Ready>
        <BuildPanel open onClose={() => {}} tree={tree()} locationId={LOCATION_ID} initialTab="rooms" onDone={() => {}} />
      </Ready>,
    );
    const user = userEvent.setup();
    await pickOption(user, await screen.findByLabelText(/^floor\W*$/i), /first floor/i);
    const preview = await screen.findByTestId('preview', {}, { timeout: 4000 });
    expect(within(preview).getByText('101')).toBeInTheDocument();
    expect(within(preview).getByText('102')).toBeInTheDocument();
    expect(within(preview).getByText(/1 room will be made · 1 clash/i)).toBeInTheDocument();
    expect(screen.getAllByText(/room 101 already uses the code 101/i).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /create 1 room/i })).toBeDisabled();
    expect(screen.getByText(/fix the red codes first/i)).toBeInTheDocument();
    // The preview asks for the range and the default type, and creates nothing.
    expect(mock.callsTo('/spaces/generate/preview', 'POST').at(-1)!.body).toMatchObject({ from: 101, to: 110, spaceTypeId: TYPE_STD });
    expect(mock.callsTo('/spaces/generate', 'POST').filter((c) => !c.path.includes('preview'))).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────── inspector

/** A room that remembers what was saved, the way the API does. */
function stateful(initial: SpaceDTO) {
  let current = initial;
  const handlers = {
    [`GET ${API}/physical-spaces/${initial.spaceId}`]: () => ({ data: context(current) }),
    [`GET ${API}/physical-spaces/${initial.spaceId}/availability-blocks`]: { data: [] },
    [`PATCH ${API}/physical-spaces/${initial.spaceId}`]: ({ body }: { body: unknown }) => {
      const b = body as { version: number; academicCapacity?: number | null };
      if (b.academicCapacity !== undefined) current = { ...current, academicCapacity: b.academicCapacity === null ? { value: 40, source: 'TYPE_DEFAULT' } : { value: b.academicCapacity, source: 'OVERRIDE' }, version: current.version + 1 };
      return { data: current };
    },
  };
  return handlers;
}

function renderInspector(spaceId: string) {
  return renderWithApp(
    <Ready>
      <Toaster />
      <Inspector spaceId={spaceId} onClose={() => {}} />
    </Ready>,
  );
}

describe('Room inspector (Module 5, Part 2)', () => {
  it('(SPACE-16) a value from the type shows where it came from and a Customize link; only then does it become editable', async () => {
    mockApi('SCHOOL_ADMIN', { ...baseHandlers(), ...stateful(A) });
    renderInspector(A.spaceId);
    const user = userEvent.setup();
    expect(await screen.findByText('from Standard Classroom', { selector: 'span' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Seats for classes')).not.toBeInTheDocument();
    await user.click(screen.getAllByRole('button', { name: /^customize$/i })[0]!);
    expect(await screen.findByLabelText('Seats for classes')).toHaveValue('40');
  });

  it('(SPACE-57) saves a field when you leave it, shows "Saved", and Undo puts the old value back', async () => {
    const mock = mockApi('SCHOOL_ADMIN', { ...baseHandlers(), ...stateful(A) });
    renderInspector(A.spaceId);
    const user = userEvent.setup();
    await user.click((await screen.findAllByRole('button', { name: /^customize$/i }))[0]!);
    const seats = await screen.findByLabelText('Seats for classes');
    await user.clear(seats);
    await user.type(seats, '45');
    await user.tab();

    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent('Saved'));
    expect(mock.callsTo(`/physical-spaces/${A.spaceId}`, 'PATCH')[0]!.body).toMatchObject({ version: 3, academicCapacity: 45 });
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(mock.callsTo(`/physical-spaces/${A.spaceId}`, 'PATCH')).toHaveLength(2));
    expect(mock.callsTo(`/physical-spaces/${A.spaceId}`, 'PATCH')[1]!.body).toMatchObject({ academicCapacity: null });
    expect(await screen.findByText('from Standard Classroom', { selector: 'span' })).toBeInTheDocument();
  });

  it('(SPACE-57) when someone else changed the room, the field says so and offers Reload', async () => {
    mockApi('SCHOOL_ADMIN', {
      ...baseHandlers(),
      [`GET ${API}/physical-spaces/${A.spaceId}`]: { data: context(A) },
      [`GET ${API}/physical-spaces/${A.spaceId}/availability-blocks`]: { data: [] },
      [`PATCH ${API}/physical-spaces/${A.spaceId}`]: { status: 409, error: { code: 'VERSION_CONFLICT', message: 'Someone else changed this record.' } },
    });
    renderInspector(A.spaceId);
    const user = userEvent.setup();
    const name = await screen.findByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Room 101 Annex');
    await user.tab();
    expect(await screen.findByText(/someone changed this\./i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
  });

  it('(SPACE-52) the archive dialog lists what depends on the room, then Choose Replacement moves the sections and archives', async () => {
    const mock = mockApi('SCHOOL_ADMIN', {
      ...baseHandlers(),
      ...stateful(A),
      [`POST ${API}/physical-spaces/${A.spaceId}/archive`]: {
        data: {
          archived: false,
          space: A,
          message: 'Room 101 is still in use, so it was not archived. VIII-A sits here.',
          dependencies: [{ kind: 'HOME_CLASSROOM', label: 'VIII-A sits here.' }],
          suggestedReplacementId: B.spaceId,
          suggestedReplacementName: 'Room 102',
          actions: ['CHOOSE_REPLACEMENT', 'ARCHIVE_AFTER_SESSION'],
        },
      },
      [`GET ${API}/physical-spaces`]: { data: list([A, B]) },
      [`POST ${API}/physical-spaces/${A.spaceId}/replace`]: {
        data: { mode: 'NOW', moved: [{ assignmentId: 'x1', sectionOfferingId: SECTION_A_ID, label: '8-A', fromRoom: 'Room 101', toRoom: 'Room 102' }], archived: true, archiveAfterDate: null, message: '1 section moved to Room 102. Room 101 was archived.', space: { ...A, status: 'ARCHIVED' }, dependencies: [], actions: [] },
      },
    });
    renderInspector(A.spaceId);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /archive room/i }));
    const dialog = await screen.findByRole('dialog', { name: /archive this room/i });
    await user.click(within(dialog).getByRole('button', { name: /archive room/i }));

    const result = await screen.findByRole('dialog', { name: /still in use/i });
    expect(within(result).getAllByText(/viii-a sits here/i).length).toBeGreaterThan(0);
    expect(within(result).getByText('Room 102')).toBeInTheDocument();
    expect(within(result).getByRole('button', { name: 'Archive After Current Session' })).toBeEnabled();

    // (Part 4) Choose Replacement: the suggested room is picked already; the sections move and the room is archived.
    await user.click(within(result).getByRole('button', { name: 'Choose Replacement' }));
    expect(within(result).getByLabelText(/^room that takes over/i)).toHaveTextContent('Room 102');
    await user.click(within(result).getByRole('button', { name: 'Move And Archive' }));
    const moved = await screen.findByRole('dialog', { name: 'Room archived' });
    expect(within(moved).getByTestId('replace-result')).toHaveTextContent(/8-A: Room 101 Room 102/);
    expect(mock.callsTo(`/physical-spaces/${A.spaceId}/replace`, 'POST')[0]!.body).toEqual({ mode: 'NOW', replacementSpaceId: B.spaceId });
  });

  it('(SPACE-46) a very long closure says "mark the room Inactive instead" and offers the button', async () => {
    const mock = mockApi('SCHOOL_ADMIN', {
      ...baseHandlers(),
      ...stateful(A),
      [`POST ${API}/physical-spaces/${A.spaceId}/status`]: { data: { ...A, status: 'INACTIVE' } },
    });
    renderInspector(A.spaceId);
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /more actions/i }));
    await user.click(await screen.findByRole('menuitem', { name: /make unavailable/i }));
    const dialog = await screen.findByRole('dialog', { name: /make this room unavailable/i });
    expect(within(dialog).queryByText(/mark the room inactive instead/i)).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText(/^until/i), { target: { value: '2031-01-01T10:00' } });
    expect(await within(dialog).findByText(/for a long closure, mark the room inactive instead/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: /^make unavailable$/i })).toBeDisabled();
    await user.click(within(dialog).getByRole('button', { name: /mark room inactive/i }));
    await waitFor(() => expect(mock.callsTo(`/physical-spaces/${A.spaceId}/status`, 'POST')).toHaveLength(1));
    expect(mock.callsTo(`/physical-spaces/${A.spaceId}/status`, 'POST')[0]!.body).toEqual({ to: 'INACTIVE' });
  });
});

// ───────────────────────────────────────────────────────────── needs attention, types

describe('Needs Attention (Module 5, Part 4)', () => {
  it('(SPACE-60) shows every group from the server with the right Fix, and the sidebar badge is the same total', async () => {
    const restore = wideScreen();
    const row = (over: Partial<SpaceAttentionRowDTO>): SpaceAttentionRowDTO => ({ rowId: 'r', title: '', detail: '', fix: 'SET_CAPACITY', sectionOfferingId: null, physicalSpaceId: null, assignmentId: null, suggestedRoom: null, ...over });
    const groups: SpaceAttentionGroupDTO[] = [
      { group: 'CLASSROOM_ALLOCATION', title: 'Classroom Allocation', count: 1, rows: [row({ rowId: 'allocation:c', title: '8-C has no Home Classroom', detail: '42 students and no room yet.', fix: 'ASSIGN_ROOM', sectionOfferingId: SECTION_C, suggestedRoom: ref(BIG) })] },
      { group: 'CAPACITY', title: 'Capacity', count: 1, rows: [row({ rowId: 'capacity:a', title: '8-A is bigger than its room', detail: '42 students, but Room 101 holds 40.', fix: 'CHOOSE_LARGER_ROOM', sectionOfferingId: SECTION_A_ID, physicalSpaceId: A.spaceId, assignmentId: 'as-a' })] },
      { group: 'SPACE_SETUP', title: 'Space Setup', count: 1, rows: [row({ rowId: `setup:${C.spaceId}`, title: 'Room 103 has no seat count', detail: 'Add how many students the room can hold.', fix: 'SET_CAPACITY', physicalSpaceId: C.spaceId })] },
      { group: 'AVAILABILITY', title: 'Availability', count: 0, rows: [] },
      { group: 'HIERARCHY', title: 'Hierarchy', count: 0, rows: [] },
    ];
    mockApi('SCHOOL_ADMIN', {
      ...baseHandlers({ [`GET ${API}/physical-spaces/${C.spaceId}`]: { data: context(C) }, [`GET ${API}/physical-spaces/${C.spaceId}/availability-blocks`]: { data: [] }, [`GET ${API}/physical-spaces`]: { data: list([A, C]) } }),
      [`GET ${API}/spaces/attention`]: { data: attentionOf(groups) },
    });
    function SidebarBadge() {
      return <span data-testid="badge">{useSpaceAttentionCount(true)}</span>;
    }
    renderWithApp(
      <Ready>
        <SidebarBadge />
        <StudentContextProvider>
          <Routes>
            <Route path="/spaces/attention" element={<SpaceAttentionPage />} />
            <Route path="/spaces" element={<WorkspacePage />} />
          </Routes>
        </StudentContextProvider>
      </Ready>,
      { route: '/spaces/attention' },
    );
    const allocation = await screen.findByRole('region', { name: 'Classroom Allocation' });
    expect(within(allocation).getByRole('link', { name: 'Assign Room' })).toHaveAttribute('href', `/spaces/allocation?section=${SECTION_C}`);
    expect(within(allocation).getByText('Room 109')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Capacity' })).getByRole('button', { name: 'Choose Larger Room' })).toBeInTheDocument();
    expect(screen.getByTestId('all-clear')).toHaveTextContent(/nothing to fix in: availability · hierarchy/i);
    await waitFor(() => expect(screen.getByTestId('badge')).toHaveTextContent('3'));

    const user = userEvent.setup();
    await user.click(within(screen.getByRole('region', { name: 'Space Setup' })).getByRole('link', { name: 'Add Seats' }));
    expect(await screen.findByRole('complementary', { name: 'Room Room 103' })).toBeInTheDocument();
    restore();
  });

  it('(SPACE-60) an empty list says "Nothing needs attention"', async () => {
    mockApi('SCHOOL_ADMIN', { ...baseHandlers(), [`GET ${API}/spaces/attention`]: { data: attentionOf([]) } });
    renderWithApp(
      <Ready>
        <StudentContextProvider>
          <SpaceAttentionPage />
        </StudentContextProvider>
      </Ready>,
    );
    expect(await screen.findByText('Nothing needs attention')).toBeInTheDocument();
  });
});

describe('Room Types (Module 5, Part 2)', () => {
  it('(SPACE-12) changing a default says how many rooms use it', async () => {
    mockApi('SCHOOL_ADMIN', baseHandlers());
    renderWithApp(
      <Ready>
        <SpaceTypesPage />
      </Ready>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Change Standard Classroom' }));
    expect(screen.queryByTestId('rooms-use-default')).not.toBeInTheDocument();
    const seats = screen.getByLabelText(/^seats for classes/i);
    await user.clear(seats);
    await user.type(seats, '42');
    expect(await screen.findByTestId('rooms-use-default')).toHaveTextContent('34 rooms use this default');
  });
});

// ───────────────────────────────────────────────────────────── Part 4: allocation, rollover, reports, faculty

const recs = (): RecommendationSetDTO => ({
  academicSessionId: SESSION_ID,
  locationId: LOCATION_ID,
  from: '2026-11-22',
  to: '2027-03-31',
  summary: { sections: 3, eligibleRooms: 3, ready: 2, needsReview: 1, alreadyAssigned: 0 },
  recommendations: [
    { section: sec(SECTION_A_ID, '8-A', 36), room: { ...ref(A), seatsLeft: 4 }, score: 95, reasons: ['Same room as last year', 'Best fit: 36 students in a 40-seat room'], warnings: [], replacesAssignmentId: null },
    { section: sec(SECTION_B_ID, '8-B', 30), room: { ...ref(B), seatsLeft: 10 }, score: 80, reasons: ['Best fit: 30 students in a 40-seat room'], warnings: [], replacesAssignmentId: null },
  ],
  unresolved: [{ section: sec(SECTION_C, '8-C', 42), reason: 'ALL_TOO_SMALL', status: 'NEEDS_REVIEW', message: '42 students, but the closest room holds 40.', closestRoom: { ...ref(C), academicCapacity: 40, seatsLeft: -2 } }],
  alreadyAssigned: [],
  message: '',
});

function renderAllocation(handlers: Parameters<typeof baseHandlers>[0] = {}, route = '/spaces/allocation') {
  const mock = mockApi('SCHOOL_ADMIN', baseHandlers({ [`POST ${API}/sections/home-classroom-recommendations`]: { data: recs() }, [`GET ${API}/section-space-assignments`]: { data: { items: [], total: 0, page: 1, pageSize: 200 } }, [`GET ${API}/physical-spaces`]: { data: list([A, B, C, BIG, LAB, SHUT]) }, ...handlers }));
  renderWithApp(
    <Ready>
      <Toaster />
      <StudentContextProvider>
        <Routes>
          <Route path="/spaces/allocation" element={<AllocationPage />} />
        </Routes>
      </StudentContextProvider>
    </Ready>,
    { route },
  );
  return mock;
}

describe('Classroom Allocation (Module 5, Part 4)', () => {
  it('(SPACE-35) opens with a summary in plain words and one Accept button with the count', async () => {
    renderAllocation();
    expect(await screen.findByTestId('allocation-summary')).toHaveTextContent('We found 3 sections and 3 eligible rooms. 2 are ready. 1 needs your attention.');
    expect(screen.getByRole('button', { name: 'Accept 2 Recommended Assignments' })).toBeInTheDocument();
    // The recommended list is collapsed; opening it shows the short reason.
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /recommended 2/i }));
    expect(screen.getByRole('table', { name: 'Recommended rooms' })).toHaveTextContent('Same room as last year · Best fit: 36 students in a 40-seat room');
  });

  it('(SPACE-36) a needs-a-look row says why in plain words and offers three actions; Keep Room Anyway asks for a reason', async () => {
    const mock = renderAllocation({ [`POST ${API}/section-space-assignments`]: { status: 201, data: { assignment: homeRow('n1', sec(SECTION_C, '8-C', 42), C), replaced: null, warnings: [] } } });
    const row = await screen.findByTestId('needs-look-row');
    expect(row).toHaveTextContent('8-C');
    expect(row).toHaveTextContent('42 students, but the closest room holds 40.');
    for (const name of ['Choose Larger Room', 'Keep Room Anyway', 'Pick Another Room']) expect(within(row).getByRole('button', { name })).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(within(row).getByRole('button', { name: 'Keep Room Anyway' }));
    const dialog = await screen.findByRole('dialog', { name: /keep this room anyway/i });
    const keep = within(dialog).getByRole('button', { name: 'Keep Room' });
    expect(keep).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/why keep this room/i), 'Extra desks added');
    await user.click(keep);
    await waitFor(() => expect(mock.callsTo('/section-space-assignments', 'POST')).toHaveLength(1));
    expect(mock.callsTo('/section-space-assignments', 'POST')[0]!.body).toEqual({ sectionOfferingId: SECTION_C, physicalSpaceId: C.spaceId, capacityOverride: { reason: 'Extra desks added' } });
  });

  it('(SPACE-36) accepting all shows what was saved and the reason for each section that failed', async () => {
    const mock = renderAllocation({
      [`POST ${API}/section-space-assignments/bulk`]: { data: { source: 'SYSTEM_RECOMMENDED', done: [{ sectionOfferingId: SECTION_A_ID, label: '8-A', assignmentId: 'n1', roomName: 'Room 101' }], alreadyDone: [], failed: [{ sectionOfferingId: SECTION_B_ID, label: '8-B', physicalSpaceId: B.spaceId, code: 'ROOM_ALREADY_ASSIGNED', message: '8-D already uses Room 102 from 22 Nov 2026.' }], message: '' } },
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Accept 2 Recommended Assignments' }));
    const dialog = await screen.findByRole('dialog', { name: /accept 2 recommended assignments/i });
    await user.click(within(dialog).getByRole('button', { name: 'Accept 2' }));
    const result = await screen.findByTestId('bulk-result');
    expect(result).toHaveTextContent('1 section now has a Home Classroom.');
    expect(result).toHaveTextContent('8-B: 8-D already uses Room 102 from 22 Nov 2026.');
    expect(mock.callsTo('/section-space-assignments/bulk', 'POST')[0]!.body).toEqual({ source: 'SYSTEM_RECOMMENDED', items: [{ sectionOfferingId: SECTION_A_ID, physicalSpaceId: A.spaceId }, { sectionOfferingId: SECTION_B_ID, physicalSpaceId: B.spaceId }] });
  });

  it('(SPACE-34) the room picker greys out taken, closed and non-classroom rooms with the reason; a short room opens the capacity dialog', async () => {
    let tries = 0;
    const mock = renderAllocation({
      [`GET ${API}/section-space-assignments`]: { data: { items: [homeRow('b1', sec(SECTION_B_ID, '8-B', 30), B)], total: 1, page: 1, pageSize: 200 } },
      [`POST ${API}/section-space-assignments`]: () => {
        tries += 1;
        return tries === 1
          ? { status: 409, error: { code: 'ROOM_TOO_SMALL', message: '8-C has 42 students, but Room 101 holds 40.', details: { sectionStrength: 42, roomCapacity: 40, shortBy: 2, actions: ['CHOOSE_LARGER_ROOM', 'KEEP_ROOM_ANYWAY'], suggestedRoom: ref(BIG) } } }
          : { status: 201, data: { assignment: homeRow('n2', sec(SECTION_C, '8-C', 42), BIG), replaced: null, warnings: [] } };
      },
    });
    const user = userEvent.setup();
    await user.click(within(await screen.findByTestId('needs-look-row')).getByRole('button', { name: 'Pick Another Room' }));
    const dialog = await screen.findByRole('dialog', { name: 'Pick a room' });
    const trigger = within(dialog).getByLabelText(/^room\W*$/i);
    await waitFor(() => expect(trigger).toBeEnabled());
    await user.click(trigger);
    expect(await screen.findByRole('option', { name: /room 102.*taken by 8-b/i })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /room 104.*under maintenance/i })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('option', { name: /computer lab.*not a classroom/i })).toHaveAttribute('aria-disabled', 'true');
    // Free rooms that fit come first.
    expect(screen.getAllByRole('option')[0]).toHaveTextContent('Room 109');
    await user.click(screen.getByRole('option', { name: /room 101/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Save Room' }));

    const small = await screen.findByRole('dialog', { name: 'This room is too small' });
    expect(small).toHaveTextContent('8-C has 42 students, but Room 101 holds 40. That is 2 seats short.');
    expect(within(small).getByTestId('larger-room')).toHaveTextContent('Room 109 (60 seats)');
    await user.click(within(small).getByRole('button', { name: 'Choose Larger Room' }));
    await waitFor(() => expect(mock.callsTo('/section-space-assignments', 'POST')).toHaveLength(2));
    expect(mock.callsTo('/section-space-assignments', 'POST')[1]!.body).toEqual({ sectionOfferingId: SECTION_C, physicalSpaceId: BIG.spaceId });
  });

  it('(SPACE-34) roomOptions: the section\'s own room is not "taken", and Choose Larger Room shows only rooms that fit', () => {
    const live = [homeRow('a1', sec(SECTION_A_ID, '8-A', 36), A)];
    expect(roomOptions([A, B], live, { sectionOfferingId: SECTION_A_ID, strength: 36 }).every((o) => !o.disabled)).toBe(true);
    expect(roomOptions([A, B, BIG], [], { strength: 50, minSeats: 50 }).map((o) => o.label)).toEqual(['Room 109']);
  });

  it('(SPACE-38) Current Rooms lists Section → Room with History, Replace Room and End Assignment', async () => {
    renderAllocation({ [`GET ${API}/section-space-assignments`]: ({ url }) => ({ data: { items: url.searchParams.get('sectionOfferingId') ? [homeRow('a0', sec(SECTION_A_ID, '8-A', 36), B, { phase: 'ENDED', effectiveTo: '2026-06-30', source: 'MANUAL' }), homeRow('a1', sec(SECTION_A_ID, '8-A', 36), A)] : [homeRow('a1', sec(SECTION_A_ID, '8-A', 36), A)], total: 1, page: 1, pageSize: 200 } }) }, '/spaces/allocation?tab=current');
    const table = await screen.findByRole('table', { name: 'Current rooms' });
    expect(within(table).getByRole('button', { name: 'Replace room of 8-A' })).toBeInTheDocument();
    expect(within(table).getByRole('button', { name: 'End assignment of 8-A' })).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(within(table).getByRole('button', { name: 'History of 8-A' }));
    const history = await screen.findByRole('list', { name: 'History' });
    expect(history).toHaveTextContent('Room 102');
    expect(history).toHaveTextContent('Ended');
  });
});

describe('Rollover (Module 5, Part 4)', () => {
  it('(SPACE-42) lists the exceptions first, grouped by reason, keeps ready rows collapsed, and carries forward the rest', async () => {
    const next: AcademicSessionDTO = { ...academicSession, academicSessionId: 'bbbbbbbb-0000-4000-8000-000000000002', name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', status: 'PUBLISHED', isCurrent: false, previousSessionId: SESSION_ID };
    const preview: RolloverSummaryDTO = {
      fromSessionId: SESSION_ID,
      toSessionId: next.academicSessionId,
      locationId: LOCATION_ID,
      total: 3,
      ready: 2,
      review: 1,
      done: 0,
      message: '',
      rows: [
        { fromSection: { sectionOfferingId: 'o3', label: '8-C' }, toSection: { sectionOfferingId: 'n3', label: '8-C', strength: 0 }, room: ref(C), status: 'REVIEW', reason: 'ROOM_ARCHIVED', message: 'Room 103 is no longer usable.', suggestedRoom: ref(BIG) },
        { fromSection: { sectionOfferingId: 'o1', label: '8-A' }, toSection: { sectionOfferingId: 'n1', label: '8-A', strength: 0 }, room: ref(A), status: 'READY', reason: null, message: '8-A keeps Room 101.', suggestedRoom: null },
        { fromSection: { sectionOfferingId: 'o2', label: '8-B' }, toSection: { sectionOfferingId: 'n2', label: '8-B', strength: 0 }, room: ref(B), status: 'READY', reason: null, message: '8-B keeps Room 102.', suggestedRoom: null },
      ],
    };
    const mock = mockApi('SCHOOL_ADMIN', {
      ...baseHandlers({ [`GET ${API}/academic-sessions`]: { data: [academicSession, next] } }),
      [`POST ${API}/section-space-assignments/rollover/preview`]: { data: preview },
      [`POST ${API}/section-space-assignments/rollover/commit`]: { data: { carried: 2, skipped: 0, alreadyDone: 0, total: 3, message: '2 of 3 sections carried forward.', summary: preview } },
    });
    renderWithApp(
      <Ready>
        <Toaster />
        <StudentContextProvider>
          <Routes>
            <Route path="/spaces/rollover" element={<RolloverPage />} />
          </Routes>
        </StudentContextProvider>
      </Ready>,
      { route: '/spaces/rollover' },
    );
    expect(await screen.findByTestId('rollover-summary')).toHaveTextContent('2 of 3 mappings can be carried forward. 1 needs a look.');
    // The "To" year defaults to the next one.
    expect(screen.getByLabelText(/^to\W*$/i)).toHaveTextContent('2027-28');
    expect(mock.callsTo('/rollover/preview', 'POST')[0]!.body).toEqual({ fromSessionId: SESSION_ID, toSessionId: next.academicSessionId, locationId: LOCATION_ID });
    const look = screen.getByRole('region', { name: 'Needs a look' });
    const ready = screen.getByRole('region', { name: 'Ready to carry forward' });
    expect(look.compareDocumentPosition(ready) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(look).getByRole('region', { name: 'Room archived or closed' })).toHaveTextContent('Room 103 is no longer usable.');
    expect(within(look).getByRole('button', { name: 'Pick Another Room' })).toBeInTheDocument();
    expect(within(ready).queryByText('Room 101')).not.toBeInTheDocument();
    expect(screen.getByText(/rooms are not copied/i)).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Carry Forward 2 Assignments' }));
    expect(await screen.findByTestId('rollover-result')).toHaveTextContent('2 of 3 sections carried forward.');
  });

  it('(SPACE-41) Classroom Allocation offers to carry forward when next year has no Home Classrooms', async () => {
    const next: AcademicSessionDTO = { ...academicSession, academicSessionId: 'bbbbbbbb-0000-4000-8000-000000000002', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', status: 'PUBLISHED', isCurrent: false, previousSessionId: SESSION_ID };
    renderAllocation({
      [`GET ${API}/academic-sessions`]: { data: [academicSession, next] },
      [`GET ${API}/section-space-assignments`]: ({ url }) => ({ data: url.searchParams.get('academicSessionId') === SESSION_ID ? { items: [homeRow('a1', sec(SECTION_A_ID, '8-A', 36), A)], total: 1, page: 1, pageSize: 1 } : { items: [], total: 0, page: 1, pageSize: 1 } }),
    });
    const banner = await screen.findByTestId('rollover-banner');
    expect(banner).toHaveTextContent('2027-28 has no Home Classrooms yet. Carry forward from 2026-27?');
    expect(within(banner).getByRole('link', { name: 'Carry Forward' })).toHaveAttribute('href', `/spaces/rollover?from=${SESSION_ID}&to=${next.academicSessionId}`);
  });
});

describe('Reports and Faculty (Module 5, Part 4)', () => {
  it('(SPACE-79) a report renders as a table with a search box and a CSV link', async () => {
    const report = (type: string, title: string): SpaceReportDTO => ({ type: type as SpaceReportDTO['type'], title, generatedAt: '2026-11-22T10:00:00Z', columns: [{ key: 'room', label: 'Room' }, { key: 'seats', label: 'Seats' }], rows: [{ room: 'Room 101', seats: 40 }, { room: 'Room 109', seats: 60 }], summary: null });
    const mock = mockApi('SCHOOL_ADMIN', { ...baseHandlers(), [`GET ${API}/spaces/reports/space-inventory`]: { data: report('space-inventory', 'Room list') }, [`GET ${API}/spaces/reports/capacity-mismatch`]: { data: report('capacity-mismatch', 'Sections bigger than their room') } });
    renderWithApp(
      <Ready>
        <StudentContextProvider>
          <SpaceReportsPage />
        </StudentContextProvider>
      </Ready>,
    );
    const table = await screen.findByRole('table', { name: 'Room list' });
    expect(within(table).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('link', { name: /download csv/i })).toHaveAttribute('href', `/api/v1/spaces/reports/space-inventory?locationId=${LOCATION_ID}&format=csv`);
    const user = userEvent.setup();
    await user.type(screen.getByLabelText('Search this report'), '109');
    expect(screen.getByTestId('report-count')).toHaveTextContent('1 of 2 rows');
    await pickOption(user, screen.getByRole('combobox', { name: 'Report' }), /sections bigger than their room/i);
    expect(await screen.findByRole('table', { name: 'Sections bigger than their room' })).toBeInTheDocument();
    expect(mock.callsTo('/spaces/reports/capacity-mismatch')[0]!.path).toContain(`sessionId=${SESSION_ID}`);
  });

  it('(SPACE-59) a teacher sees My Classroom read-only and cannot open Classroom Allocation', async () => {
    mockApi('FACULTY', { ...baseHandlers(), [`GET ${API}/spaces/my-classrooms`]: { data: { items: [homeRow('a1', sec(SECTION_A_ID, '8-A', 36), A)], withoutRoom: [{ sectionOfferingId: SECTION_C, label: '8-C' }] } } });
    renderWithApp(
      <Ready>
        <MyClassroomCard />
        <StudentContextProvider>
          <Routes>
            <Route element={<RequireSpacePermission permission="space:section_assignment:manage" />}>
              <Route path="/spaces/allocation" element={<AllocationPage />} />
            </Route>
            <Route path="*" element={null} />
          </Routes>
        </StudentContextProvider>
      </Ready>,
      { route: '/spaces/allocation' },
    );
    const card = await screen.findByRole('region', { name: 'My Classroom' });
    expect(card).toHaveTextContent('8-A · Room 101');
    expect(card).toHaveTextContent('8-C · no room yet. Ask the school office.');
    expect(within(card).queryByRole('button')).not.toBeInTheDocument();
    expect(screen.getByText(/lost in the schoolverse/i)).toBeInTheDocument();
  });
});
