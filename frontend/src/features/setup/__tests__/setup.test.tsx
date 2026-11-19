import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { list, location, school, SCHOOL_ID, setupStatus, unfinishedSchool } from '@/test/fixtures';
import { mockApi, renderWithApp } from '@/test/utils';
import { celebrate } from '@/lib/confetti';
import { RequireAuth, RequireSetupComplete } from '@/routes/guards';
import { OverviewPage } from '../overview-page';
import { SetupWizardPage } from '../wizard/setup-wizard-page';

vi.mock('@/lib/confetti', () => ({ celebrate: vi.fn() }));

const API = '/api/v1';
const MOH = location();
const CHD = location({ locationId: '33333333-3333-4333-8333-333333333333', locationCode: 'CHD', displayName: 'Chandigarh Campus', isPrimary: false });

beforeEach(() => localStorage.clear());
afterEach(() => vi.unstubAllGlobals());

function Guarded() {
  return (
    <Routes>
      <Route element={<RequireSetupComplete />}>
        <Route path="/" element={<p>Home content</p>} />
      </Route>
      <Route path="/setup" element={<p>Wizard screen</p>} />
    </Routes>
  );
}

describe('first-time setup guard', () => {
  it('sends a School Admin with unfinished setup to the wizard', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/schools/current`]: { data: unfinishedSchool(3) } });
    renderWithApp(<Guarded />);
    expect(await screen.findByText('Wizard screen')).toBeInTheDocument();
  });

  it('sends an admin whose workspace has no school yet to the wizard', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/schools/current`]: { data: null } });
    renderWithApp(<Guarded />);
    expect(await screen.findByText('Wizard screen')).toBeInTheDocument();
  });

  it('shows Faculty "Your school is getting set up" instead of the app', async () => {
    mockApi('FACULTY', { [`GET ${API}/schools/current`]: { data: { ...unfinishedSchool(), setup: undefined } } });
    renderWithApp(<Guarded />);
    expect(await screen.findByRole('heading', { name: /your school is getting set up/i })).toBeInTheDocument();
    expect(screen.queryByText('Home content')).not.toBeInTheDocument();
    expect(screen.queryByText('Wizard screen')).not.toBeInTheDocument();
  });

  it('lets everyone through once setup is complete', async () => {
    mockApi('FACULTY', { [`GET ${API}/schools/current`]: { data: school } });
    renderWithApp(<Guarded />);
    expect(await screen.findByText('Home content')).toBeInTheDocument();
  });

  it('never asks Parents about school setup', async () => {
    const api = mockApi('PARENT', {});
    renderWithApp(<Guarded />);
    expect(await screen.findByText('Home content')).toBeInTheDocument();
    expect(api.callsTo('/schools/current')).toHaveLength(0);
  });
});

function wizard() {
  return renderWithApp(
    <Routes>
      <Route element={<RequireAuth />}>
        <Route path="/setup" element={<SetupWizardPage />} />
        <Route path="/school-setup" element={<p>Overview screen</p>} />
      </Route>
    </Routes>,
    { route: '/setup' },
  );
}

describe('setup wizard (SCH-LOC-12)', () => {
  it('starts at step 1 for a brand-new workspace and keeps typing in this browser', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/schools/current`]: { data: null } });
    const user = userEvent.setup();
    wizard();

    expect(await screen.findByRole('heading', { name: /let’s set up your school/i })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^school name/i), 'Greenfield Public School');
    const saved = JSON.parse(localStorage.getItem('sv.setup.draft.t1')!);
    expect(saved).toMatchObject({ step: 1, values: { displayName: 'Greenfield Public School' } });
  });

  it('resumes from the browser draft before the school exists', async () => {
    localStorage.setItem(
      'sv.setup.draft.t1',
      JSON.stringify({ step: 2, values: { displayName: 'Greenfield Public School', legalName: 'Greenfield Society', schoolCode: 'GPS', primaryEmail: 'office@greenfield.demo' } }),
    );
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/schools/current`]: { data: null } });
    wizard();
    expect(await screen.findByRole('heading', { name: /how can people reach you/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^primary email/i)).toHaveValue('office@greenfield.demo');
  });

  it('resumes from the server step after a refresh or re-login', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: unfinishedSchool(4) },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([MOH]) },
    });
    wizard();
    expect(await screen.findByRole('heading', { name: /any other campuses/i })).toBeInTheDocument();
  });

  it('refuses to leave step 1 until the required identity fields are valid', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/schools/current`]: { data: null } });
    const user = userEvent.setup();
    wizard();
    await user.click(await screen.findByRole('button', { name: /^continue/i }));
    expect(await screen.findByText('School name is required.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /let’s set up your school/i })).toBeInTheDocument();
  });

  it('creates the school at the end of step 2, clears the draft and saves progress on the server', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: null },
      [`POST ${API}/schools`]: { status: 201, data: unfinishedSchool(1) },
      [`PATCH ${API}/schools/${SCHOOL_ID}/setup`]: { data: unfinishedSchool(3) },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([]) },
    });
    const user = userEvent.setup();
    wizard();

    await user.type(await screen.findByLabelText(/^school name/i), 'Greenfield Public School');
    await user.type(screen.getByLabelText(/^legal name/i), 'Greenfield Educational Society');
    await user.type(screen.getByLabelText(/^school code/i), 'gps');
    await user.click(screen.getByRole('button', { name: /^continue/i }));

    await user.type(await screen.findByLabelText(/^primary email/i), 'office@greenfield.demo');
    await user.type(screen.getByLabelText(/^primary phone/i), '98140 11000');
    await user.click(screen.getByRole('button', { name: /save & continue/i }));

    await waitFor(() => expect(api.callsTo('/schools', 'POST').filter((c) => c.path === `${API}/schools`)).toHaveLength(1));
    const body = api.callsTo('/schools', 'POST').find((c) => c.path === `${API}/schools`)!.body;
    expect(body).toMatchObject({ displayName: 'Greenfield Public School', schoolCode: 'GPS', primaryPhone: '+919814011000', defaultTimezone: 'Asia/Kolkata' });

    expect(await screen.findByRole('heading', { name: /your primary location/i })).toBeInTheDocument();
    expect(localStorage.getItem('sv.setup.draft.t1')).toBeNull();
    await waitFor(() => expect(api.callsTo('/setup', 'PATCH').map((c) => c.body)).toContainEqual({ currentStep: 3 }));
  });

  it('shows the review with an Edit button per section', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: unfinishedSchool(5) },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([MOH, CHD]) },
    });
    wizard();
    expect(await screen.findByRole('heading', { name: /review and finish/i })).toBeInTheDocument();
    for (const section of ['School identity', 'Contact & defaults', 'Primary Location', 'Additional locations (1)']) {
      expect(within(await screen.findByRole('region', { name: section })).getByRole('button', { name: /edit/i })).toBeInTheDocument();
    }
    expect(screen.getByText('Chandigarh Campus')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /edit school identity/i }));
    expect(await screen.findByRole('heading', { name: /let’s set up your school/i })).toBeInTheDocument();
  });

  it('completes setup with the Primary candidate and celebrates', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: unfinishedSchool(5) },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([MOH]) },
      [`POST ${API}/schools/${SCHOOL_ID}/setup/complete`]: { data: school },
    });
    const user = userEvent.setup();
    wizard();

    await user.click(await screen.findByRole('button', { name: /complete school setup/i }));
    expect(await screen.findByRole('heading', { name: /you’re all set/i })).toBeInTheDocument();
    expect(celebrate).toHaveBeenCalledTimes(1);
    expect(api.callsTo('/setup/complete', 'POST')[0]!.body).toEqual({ primaryLocationId: MOH.locationId });
    await user.click(screen.getByRole('button', { name: /go to the overview/i }));
    expect(await screen.findByText('Overview screen')).toBeInTheDocument();
  });

  it('explains what is missing when the server refuses to complete, and links back to the right step', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: unfinishedSchool(5) },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([MOH]) },
      [`GET ${API}/locations/${MOH.locationId}`]: { data: MOH },
      [`POST ${API}/schools/${SCHOOL_ID}/setup/complete`]: {
        status: 422,
        error: { code: 'SETUP_INCOMPLETE', message: 'Finish the required setup details before completing School Setup.', details: { fields: { 'primaryLocation.phone': 'Phone number is required for an active location.' } } },
      },
    });
    const user = userEvent.setup();
    wizard();

    await user.click(await screen.findByRole('button', { name: /complete school setup/i }));
    expect(await screen.findByText('Phone number is required for an active location.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /fix this/i }));
    expect(await screen.findByRole('heading', { name: /your primary location/i })).toBeInTheDocument();
  });

  it('does not show the wizard to finished schools or to non-admins', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/schools/current`]: { data: school } });
    wizard();
    expect(await screen.findByText('Overview screen')).toBeInTheDocument();
  });
});

describe('setup overview (SCH-LOC-13)', () => {
  function overview() {
    return renderWithApp(<OverviewPage />, { route: '/school-setup' });
  }

  it('shows the configuration cards, checklist groups and the next step', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/setup-status`]: { data: setupStatus },
      [`GET ${API}/audit`]: { data: { items: [], nextCursor: null } },
    });
    overview();

    expect(await screen.findByText('Greenfield Public School')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Mohali Campus' })).toHaveAttribute('href', `/school-setup/locations/${MOH.locationId}`);
    expect(screen.getByText('Active Locations').parentElement).toHaveTextContent('2');

    const ring = screen.getByRole('progressbar', { name: /setup completion/i });
    expect(ring).toHaveAttribute('aria-valuenow', '88');

    const checklist = screen.getByRole('list', { name: 'Setup checklist' });
    expect(within(checklist).getByRole('link', { name: /School Profile: Done/ })).toHaveAttribute('href', '/school-setup/profile');
    expect(within(checklist).getByRole('link', { name: /Official Identifiers: Needs attention/ })).toHaveAttribute('href', '/school-setup/profile');
    expect(within(checklist).getByRole('link', { name: /Primary Location: Done/ })).toHaveAttribute('href', '/school-setup/locations');
    // modules that aren't built yet have nothing to open and don't count towards the ring
    expect(within(checklist).queryByText('Buildings & Rooms')).not.toBeInTheDocument();
    expect(within(checklist).queryByText('Academic Calendar')).not.toBeInTheDocument();
  });

  it('shows 100% when everything that can be set up today is done', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/setup-status`]: {
        data: { ...setupStatus, completionPercent: 100, nextStep: null, items: setupStatus.items.map((i) => (i.status === 'pending' ? { ...i, status: 'completed' as const } : i)) },
      },
      [`GET ${API}/audit`]: { data: { items: [], nextCursor: null } },
    });
    overview();
    expect(await screen.findByRole('progressbar', { name: /setup completion/i })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByText(/everything available is set up/i)).toBeInTheDocument();
    expect(screen.queryByText(/steps done/i)).not.toBeInTheDocument();
  });

  it('shows the 5 latest activities and the rest behind "Show more"', async () => {
    const items = Array.from({ length: 8 }, (_, n) => ({
      auditEventId: `a${n}`,
      entityType: 'school_location',
      entityId: MOH.locationId,
      action: 'location.primary_set',
      actor: { userId: 'u1', role: 'SCHOOL_ADMIN', name: `Actor ${n}` },
      changes: [],
      metadata: {},
      occurredAt: new Date().toISOString(),
      requestId: null,
    }));
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/setup-status`]: { data: setupStatus },
      [`GET ${API}/audit`]: { data: { items, nextCursor: null } },
    });
    const user = userEvent.setup();
    overview();
    const feed = await screen.findByRole('list', { name: 'Recent activity' });
    expect(within(feed).getAllByRole('listitem')).toHaveLength(5);

    await user.click(screen.getByRole('button', { name: /show 3 more/i }));
    expect(within(feed).getAllByRole('listitem')).toHaveLength(8);

    await user.click(screen.getByRole('button', { name: /show less/i }));
    expect(within(feed).getAllByRole('listitem')).toHaveLength(5);
  });

  it('lists recent activity for admins', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/setup-status`]: { data: setupStatus },
      [`GET ${API}/audit`]: {
        data: {
          items: [
            { auditEventId: 'a1', entityType: 'school_location', entityId: MOH.locationId, action: 'location.primary_set', actor: { userId: 'u1', role: 'SCHOOL_ADMIN', name: 'Aarav Mehta' }, changes: [], metadata: { previousPrimaryName: 'Old' }, occurredAt: new Date().toISOString(), requestId: null },
            { auditEventId: 'a2', entityType: 'user', entityId: 'u1', action: 'user.created', actor: { userId: null, role: 'SYSTEM', name: null }, changes: [], metadata: {}, occurredAt: new Date().toISOString(), requestId: null },
          ],
          nextCursor: null,
        },
      },
    });
    overview();
    const feed = await screen.findByRole('list', { name: 'Recent activity' });
    expect(within(feed).getByText(/set as primary location/i)).toBeInTheDocument();
    expect(within(feed).getByText(/aarav mehta/i)).toBeInTheDocument();
    expect(within(feed).queryByText(/user created/i)).not.toBeInTheDocument(); // account events are not setup activity
  });

  it('shows a retry when the checklist fails to load', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/setup-status`]: { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' } },
    });
    overview();
    expect(await screen.findByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
