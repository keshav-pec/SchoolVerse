import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useForm } from 'react-hook-form';
import { Route, Routes } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { list, location, school, SCHOOL_ID } from '@/test/fixtures';
import { mockApi, renderWithApp } from '@/test/utils';
import { LocationDetailPage } from '../location-detail-page';
import { LocationActions } from '../location-actions';
import { BasicsFields, EMPTY_LOCATION_FORM, type LocationFormValues } from '../location-form';
import { LocationsPage } from '../locations-page';

afterEach(() => vi.unstubAllGlobals());

const MOH = location();
const CHD = location({ locationId: '33333333-3333-4333-8333-333333333333', locationCode: 'CHD', displayName: 'Chandigarh Campus', isPrimary: false });
const PKL = location({ locationId: '44444444-4444-4444-8444-444444444444', locationCode: 'PKL', displayName: 'Panchkula Campus', isPrimary: false, status: 'DRAFT' });
const API = '/api/v1';

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
