import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Link, Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import { Toaster } from 'sonner';
import type { SpaceContextDTO, SpaceDTO, SpaceTreeDTO, SpaceTypeDTO } from '@shared';
import { useAuth } from '@/lib/auth';
import { academicSession, LOCATION_ID, masterLocation } from '@/test/fixtures';
import { mockApi, pickOption, renderWithApp, type MockResponse } from '@/test/utils';
import { StudentContextProvider } from '../../students/context';
import { SpaceAttentionPage } from '../attention-page';
import { BuildPanel } from '../build-panel';
import { Inspector } from '../inspector';
import { SpaceTypesPage } from '../types-page';
import { WorkspacePage } from '../workspace-page';

afterEach(() => vi.unstubAllGlobals());

/** A wide screen shows the room panel beside the table. A narrow one (the default in tests) opens it in a side drawer. */
function wideScreen() {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: true, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

const API = '/api/v1';
const BUILDING_ID = 'b1b1b1b1-0000-4000-8000-000000000001';
const FLOOR_ID = 'f1f1f1f1-0000-4000-8000-000000000001';
const TYPE_STD = 't1t1t1t1-0000-4000-8000-000000000001';
const TYPE_LAB = 't2t2t2t2-0000-4000-8000-000000000002';

function Ready({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session ? <>{children}</> : null;
}

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

  it('(SPACE-52) the archive dialog lists what depends on the room in plain words and does not archive', async () => {
    mockApi('SCHOOL_ADMIN', {
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
    expect(within(result).getByRole('button', { name: /choose a replacement room/i })).toBeDisabled();
    expect(within(result).getByText(/arrive with classroom allocation/i)).toBeInTheDocument();
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

describe('Needs Attention for rooms (Module 5, Part 2)', () => {
  it('(SPACE-62) groups rooms by what is wrong, and Fix opens that room in the inspector', async () => {
    const restore = wideScreen();
    const floorClosed = room('d0000000-0000-4000-8000-00000000000d', 'Room 201', { effectiveStatus: { available: false, status: 'ACTIVE', reason: 'Unavailable because Second Floor is inactive.' } });
    mockApi('SCHOOL_ADMIN', {
      ...baseHandlers({ [`GET ${API}/physical-spaces`]: { data: list([A, C, floorClosed]) }, [`GET ${API}/physical-spaces/${C.spaceId}`]: { data: context(C) }, [`GET ${API}/physical-spaces/${C.spaceId}/availability-blocks`]: { data: [] } }),
    });
    renderWithApp(
      <Ready>
        <StudentContextProvider>
          <Routes>
            <Route path="/spaces/attention" element={<SpaceAttentionPage />} />
            <Route path="/spaces" element={<><WorkspacePage /><Link to="/spaces/attention">back</Link></>} />
          </Routes>
        </StudentContextProvider>
      </Ready>,
      { route: '/spaces/attention' },
    );
    const setup = await screen.findByRole('region', { name: 'Space Setup' });
    expect(within(setup).getByText('Room 103')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Hierarchy' })).toHaveTextContent('Unavailable because Second Floor is inactive.');
    expect(screen.getByTestId('all-clear')).toHaveTextContent(/nothing to fix in: availability/i);

    const user = userEvent.setup();
    const fix = within(setup).getByRole('link', { name: 'Add Seats' });
    expect(fix).toHaveAttribute('href', `/spaces?room=${C.spaceId}`);
    await user.click(fix);
    expect(await screen.findByRole('complementary', { name: 'Room Room 103' })).toBeInTheDocument();
    restore();
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
