import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { list, location, school, SCHOOL_ID } from '@/test/fixtures';
import { API, mockApi, renderWithApp } from '@/test/utils';
import { LocationDetailPage } from '../location-detail-page';
import { LocationActions } from '../location-actions';
import { BasicsFields, EMPTY_LOCATION_FORM, type LocationFormValues } from '../location-form';
import { LocationsPage } from '../locations-page';
import { LOCATION_TYPE_LABELS } from '@shared';
import { AddLocationDrawer } from '../add-location-drawer';

const MOH = location();
const CHD = location({ locationId: '33333333-3333-4333-8333-333333333333', locationCode: 'CHD', displayName: 'Chandigarh Campus', isPrimary: false });
const PKL = location({ locationId: '44444444-4444-4444-8444-444444444444', locationCode: 'PKL', displayName: 'Panchkula Campus', isPrimary: false, status: 'DRAFT' });

function CodeFieldHarness() {
  const form = useForm<LocationFormValues>({ defaultValues: EMPTY_LOCATION_FORM });
  return <BasicsFields form={form} schoolId={SCHOOL_ID} canCheckCode />;
}

describe('location code field', () => {
  it('shows the duplicate error and a suggestion while typing', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/${SCHOOL_ID}/locations/code-availability`]: ({ url }) =>
        url.searchParams.get('code') === 'MOH'
          ? { data: { code: 'MOH', valid: true, available: false, message: 'Location code MOH is already in use.', suggestion: 'MOH2' } }
          : { data: { code: url.searchParams.get('code'), valid: true, available: true, message: null, suggestion: null } },
    });
    renderWithApp(<CodeFieldHarness />);

    await userEvent.type(await screen.findByLabelText(/location code/i), 'moh');

    const alert = await screen.findByText('Location code MOH is already in use.', undefined, { timeout: 3000 });
    expect(alert).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try moh2/i })).toBeInTheDocument();
  });

  it('confirms when a code is free', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/${SCHOOL_ID}/locations/code-availability`]: { data: { code: 'NEW1', valid: true, available: true, message: null, suggestion: null } },
    });
    renderWithApp(<CodeFieldHarness />);
    await userEvent.type(await screen.findByLabelText(/location code/i), 'new1');
    expect(await screen.findByText('Location code NEW1 is available.', undefined, { timeout: 3000 })).toBeInTheDocument();
  });
});

describe('lifecycle actions', () => {
  it('disables Deactivate on the Primary Location and explains why', async () => {
    mockApi('SCHOOL_ADMIN', {});
    renderWithApp(<LocationActions variant="buttons" location={MOH} schoolId={SCHOOL_ID} />);

    const deactivate = await screen.findByRole('button', { name: /^deactivate$/i });
    expect(deactivate).toBeDisabled();
    expect(screen.getByText(/set another active location as primary first/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /choose new primary/i })).toBeEnabled();
  });

  it('also disables Deactivate in the row menu', async () => {
    mockApi('SCHOOL_ADMIN', {});
    renderWithApp(<LocationActions location={MOH} schoolId={SCHOOL_ID} />);
    await userEvent.click(await screen.findByRole('button', { name: /actions for mohali campus/i }));
    const item = await screen.findByRole('menuitem', { name: /deactivate/i });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByTestId('primary-deactivate-note')).toHaveTextContent(/set another active location as primary/i);
  });

  it('lists each blocking dependency when archive is rejected', async () => {
    const inactive = location({ status: 'INACTIVE', isPrimary: false, locationId: CHD.locationId, displayName: 'Chandigarh Campus' });
    mockApi('SCHOOL_ADMIN', {
      [`POST ${API}/locations/${inactive.locationId}/archive`]: {
        status: 409,
        error: {
          code: 'LOCATION_HAS_DEPENDENCIES',
          message: 'This location cannot be archived because active records are still associated with it.',
          details: {
            dependencies: [
              { key: 'staff', label: 'Staff', count: 12, message: '12 active staff members are assigned to this location.' },
              { key: 'students', label: 'Students', count: 340, message: '340 active students are enrolled at this location.' },
            ],
          },
        },
      },
    });
    renderWithApp(<LocationActions variant="buttons" location={inactive} schoolId={SCHOOL_ID} />);

    await userEvent.click(await screen.findByRole('button', { name: /^archive$/i }));
    const dialog = await screen.findByRole('alertdialog');
    await userEvent.click(within(dialog).getByRole('button', { name: /archive location/i }));

    const deps = await within(dialog).findByRole('list', { name: /blocking dependencies/i });
    expect(within(deps).getByText('12 active staff members are assigned to this location.')).toBeInTheDocument();
    expect(within(deps).getByText('340 active students are enrolled at this location.')).toBeInTheDocument();
    expect(within(deps).getByText('12')).toBeInTheDocument();
    // The dialog stays open so the admin can read what is blocking.
    expect(dialog).toBeInTheDocument();
  });

  it('offers Discard only for drafts and Archive for inactive locations', async () => {
    mockApi('SCHOOL_ADMIN', {});
    const { unmount } = renderWithApp(<LocationActions variant="buttons" location={PKL} schoolId={SCHOOL_ID} deletable />);
    expect(await screen.findByRole('button', { name: /discard draft/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^activate$/i })).toBeInTheDocument();
    unmount();

    renderWithApp(<LocationActions variant="buttons" location={location({ status: 'ARCHIVED', isPrimary: false })} schoolId={SCHOOL_ID} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('role-aware controls', () => {
  it('shows Faculty a read-only list with no mutation controls', async () => {
    mockApi('FACULTY', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([MOH, CHD]) },
    });
    renderWithApp(<LocationsPage />, { route: '/school-setup/locations' });

    expect((await screen.findAllByText('Chandigarh Campus')).length).toBeGreaterThan(0);
    expect(screen.getByText(/limited, read-only view/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add location/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /actions for/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: /filter by status/i })).not.toBeInTheDocument();
  });

  it('shows Faculty a read-only detail page without edit buttons or the activity tab', async () => {
    mockApi('FACULTY', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/locations/${MOH.locationId}`]: { data: MOH },
    });
    renderWithApp(
      <Routes>
        <Route path="/school-setup/locations/:locationId" element={<LocationDetailPage />} />
      </Routes>,
      { route: `/school-setup/locations/${MOH.locationId}` },
    );

    expect(await screen.findByRole('heading', { name: 'Mohali Campus' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /activity/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /set as primary|deactivate|archive/i })).not.toBeInTheDocument();
  });

  it('gives School Admins the controls', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([MOH, CHD]) },
    });
    renderWithApp(<LocationsPage />, { route: '/school-setup/locations' });
    expect(await screen.findByRole('button', { name: /add location/i })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /actions for mohali campus/i }).length).toBeGreaterThan(0);
    expect(screen.getByRole('group', { name: /filter by status/i })).toBeInTheDocument();
  });
});

describe('locations list states', () => {
  it('shows the PRD empty state with the Add Primary Location CTA', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([]) },
    });
    renderWithApp(<LocationsPage />, { route: '/school-setup/locations' });
    expect(await screen.findByText('No school locations have been added yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add primary location/i })).toBeInTheDocument();
  });

  it('offers a retry when loading fails', async () => {
    let attempts = 0;
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: () => (++attempts === 1 ? { status: 500, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong on our side. Please try again.' } } : { data: list([MOH]) }),
    });
    renderWithApp(<LocationsPage />, { route: '/school-setup/locations' });
    await userEvent.click(await screen.findByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getAllByText('Mohali Campus').length).toBeGreaterThan(0));
  });

  it('puts filters in the URL query and sends them to the API', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/schools/current`]: { data: school },
      [`GET ${API}/schools/${SCHOOL_ID}/locations`]: { data: list([MOH, CHD, PKL]) },
    });
    renderWithApp(<LocationsPage />, { route: '/school-setup/locations?status=DRAFT' });
    await screen.findAllByText('Panchkula Campus');
    expect(api.callsTo('/locations?', 'GET').some((c) => c.path.includes('status=DRAFT'))).toBe(true);
    expect(screen.getByRole('button', { name: /^draft/i })).toHaveAttribute('aria-pressed', 'true');
  });
});

const CHECK = `GET ${API}/schools/${SCHOOL_ID}/locations/code-availability`;
const CREATE = `POST ${API}/schools/${SCHOOL_ID}/locations`;

const availability = ({ url }: { url: URL }) => {
  const code = url.searchParams.get('code');
  return code ? { data: { code, valid: true, available: true, message: null, suggestion: null } } : { data: { code: null, valid: false, available: false, message: null, suggestion: 'PAN' } };
};

async function goToReview(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText(/location name/i), 'Panchkula Campus');
  // The code is filled in from the name until the person types their own.
  await waitFor(() => expect(screen.getByLabelText(/location code/i)).toHaveValue('PAN'), { timeout: 3000 });
  for (let i = 0; i < 4; i += 1) await user.click(screen.getByRole('button', { name: /^next/i }));
  await screen.findByRole('button', { name: /save as draft/i });
}

describe('Add Location drawer', () => {
  it('walks the five steps and saves a draft with only the basics', async () => {
    const onOpenChange = vi.fn();
    const api = mockApi('SCHOOL_ADMIN', {
      [CHECK]: availability,
      [CREATE]: { status: 201, data: location({ displayName: 'Panchkula Campus', locationCode: 'PAN', status: 'DRAFT', isPrimary: false }) },
    });
    const user = userEvent.setup();
    renderWithApp(<AddLocationDrawer open onOpenChange={onOpenChange} school={school} isFirst={false} />);

    await goToReview(user);
    // A draft needs no address or phone, but the review tells the admin what activation will need.
    expect(screen.getByText(/a few details are needed before this location can go live/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /activate location/i })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /save as draft/i }));

    await waitFor(() => expect(api.callsTo('/locations', 'POST')).toHaveLength(1));
    const body = api.callsTo('/locations', 'POST')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ displayName: 'Panchkula Campus', locationCode: 'PAN', locationType: 'BRANCH_CAMPUS', intent: 'DRAFT', isPrimary: false });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('activates a fully filled location and normalises the phone number', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      [CHECK]: availability,
      [CREATE]: { status: 201, data: location({ displayName: 'Panchkula Campus', locationCode: 'PAN', isPrimary: false }) },
    });
    const user = userEvent.setup();
    renderWithApp(<AddLocationDrawer open onOpenChange={() => {}} school={school} isFirst={false} />);

    await user.type(await screen.findByLabelText(/location name/i), 'Panchkula Campus');
    await waitFor(() => expect(screen.getByLabelText(/location code/i)).toHaveValue('PAN'), { timeout: 3000 });
    await user.click(screen.getByRole('button', { name: /^next/i }));

    await user.type(await screen.findByLabelText(/address line 1/i), 'Sector 5');
    await user.type(screen.getByLabelText(/^city/i), 'Panchkula');
    await user.type(screen.getByLabelText(/^state/i), 'Haryana');
    await user.type(screen.getByLabelText(/postal code/i), '134109');
    await user.click(screen.getByRole('button', { name: /^next/i }));

    await user.type(await screen.findByLabelText(/^phone/i), '98765 43210');
    await user.click(screen.getByRole('button', { name: /^next/i }));
    await user.click(await screen.findByRole('button', { name: /^next/i }));

    const activate = await screen.findByRole('button', { name: /activate location/i });
    expect(activate).toBeEnabled();
    await user.click(activate);

    await waitFor(() => expect(api.callsTo('/locations', 'POST')).toHaveLength(1));
    expect(api.callsTo('/locations', 'POST')[0]!.body).toMatchObject({
      intent: 'ACTIVE',
      phone: '+919876543210',
      address: { line1: 'Sector 5', city: 'Panchkula', state: 'Haryana', postalCode: '134109', country: 'IN' },
    });
  });

  it('shows the server duplicate-code error on the code field and returns to the Basics step', async () => {
    mockApi('SCHOOL_ADMIN', {
      [CHECK]: availability,
      [CREATE]: {
        status: 409,
        error: { code: 'LOCATION_CODE_TAKEN', message: 'Location code PAN is already in use.', details: { fields: { locationCode: 'Location code PAN is already in use.' }, suggestion: 'PAN2' } },
      },
    });
    const user = userEvent.setup();
    renderWithApp(<AddLocationDrawer open onOpenChange={() => {}} school={school} isFirst={false} />);

    await goToReview(user);
    await user.click(screen.getByRole('button', { name: /save as draft/i }));

    const field = await screen.findByLabelText(/location code/i);
    expect(within(field.closest('div')!.parentElement!).getByText('Location code PAN is already in use.')).toBeInTheDocument();
    expect(field).toHaveAttribute('aria-invalid', 'true');
  });

  it('turns into "Add Primary Location" for the first campus', async () => {
    mockApi('SCHOOL_ADMIN', { [CHECK]: availability });
    renderWithApp(<AddLocationDrawer open onOpenChange={() => {}} school={school} isFirst />);
    expect(await screen.findByRole('heading', { name: 'Add Primary Location' })).toBeInTheDocument();
    expect(await screen.findByRole('checkbox', { name: /make this the primary location/i })).toBeChecked();
    expect(screen.getByLabelText(/location type/i)).toHaveTextContent(LOCATION_TYPE_LABELS.MAIN_CAMPUS);
  });
});
