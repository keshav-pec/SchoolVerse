import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router';
import { describe, expect, it } from 'vitest';
import { school, SCHOOL_ID } from '@/test/fixtures';
import { API, mockApi, renderWithApp } from '@/test/utils';
import { AppShell } from '@/layouts/app-shell';
import { RequireAuth } from '@/routes/guards';
import { SchoolProfilePage } from '../school-profile-page';

const base = {
  [`GET ${API}/schools/current`]: { data: school },
  [`GET ${API}/schools/${SCHOOL_ID}/identifiers`]: { data: [] },
};

describe('School Profile page', () => {
  it('shows the unsaved-changes bar and saves only the fields that changed', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      ...base,
      [`PATCH ${API}/schools/${SCHOOL_ID}`]: { data: { ...school, displayName: 'Greenfield Senior School' } },
    });
    const user = userEvent.setup();
    renderWithApp(<SchoolProfilePage />, { route: '/school-setup/profile' });

    const name = await screen.findByLabelText(/^school name/i);
    expect(screen.queryByRole('region', { name: /unsaved changes/i })).not.toBeInTheDocument();

    await user.clear(name);
    await user.type(name, 'Greenfield Senior School');
    expect(await screen.findByRole('region', { name: /unsaved changes/i })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(api.callsTo(`/schools/${SCHOOL_ID}`, 'PATCH')).toHaveLength(1));
    expect(api.callsTo(`/schools/${SCHOOL_ID}`, 'PATCH')[0]!.body).toEqual({ displayName: 'Greenfield Senior School' });
    await waitFor(() => expect(screen.queryByRole('region', { name: /unsaved changes/i })).not.toBeInTheDocument());
  });

  it('puts server field errors on the matching input', async () => {
    mockApi('SCHOOL_ADMIN', {
      ...base,
      [`PATCH ${API}/schools/${SCHOOL_ID}`]: { status: 409, error: { code: 'SCHOOL_CODE_TAKEN', message: 'This School code is already taken', details: { fields: { schoolCode: 'This School code is already taken' } } } },
    });
    const user = userEvent.setup();
    renderWithApp(<SchoolProfilePage />, { route: '/school-setup/profile' });

    const code = await screen.findByLabelText(/^school code/i);
    await user.clear(code);
    await user.type(code, 'taken');
    await user.click(await screen.findByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('This School code is already taken')).toBeInTheDocument();
    expect(code).toHaveAttribute('aria-invalid', 'true');
  });

  it('gives Faculty a read-only profile with no form and no identifiers', async () => {
    mockApi('FACULTY', base);
    renderWithApp(<SchoolProfilePage />, { route: '/school-setup/profile' });

    expect(await screen.findByText(/limited, read-only view/i)).toBeInTheDocument();
    expect(screen.getByText('Greenfield Public School Society')).toBeInTheDocument();
    expect(screen.queryByLabelText(/^school name/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upload logo|replace logo/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/official identifiers/i)).not.toBeInTheDocument();
  });

  it('offers to create the profile when the workspace has none yet', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/schools/current`]: { data: null } });
    renderWithApp(<SchoolProfilePage />, { route: '/school-setup/profile' });
    expect(await screen.findByRole('button', { name: /create school profile/i })).toBeInTheDocument();
  });

  it('shows the school logo on the sidebar card, and updates it as soon as the logo changes', async () => {
    const LOGO = '/uploads/t1/school-logos/new.png';
    mockApi('SCHOOL_ADMIN', {
      ...base,
      [`GET ${API}/schools/current`]: { data: { ...school, logoUrl: '/uploads/t1/school-logos/old.png' } },
      [`GET ${API}/schools/current/branding`]: { data: { displayName: school.displayName, logoUrl: '/uploads/t1/school-logos/old.png' } },
      [`GET ${API}/profile-change-requests`]: { data: [] },
      [`POST ${API}/schools/${SCHOOL_ID}/logo`]: { data: { ...school, logoUrl: LOGO } },
    });
    const user = userEvent.setup();
    renderWithApp(
      <Routes>
        <Route element={<RequireAuth />}>
          <Route element={<AppShell />}>
            <Route path="/school-setup/profile" element={<SchoolProfilePage />} />
          </Route>
        </Route>
      </Routes>,
      { route: '/school-setup/profile' },
    );

    // The sidebar card's image is the one labelled with the workspace name.
    const sidebarLogo = () => screen.findByRole('img', { name: 'Greenfield logo' });
    expect(await sidebarLogo()).toHaveAttribute('src', '/uploads/t1/school-logos/old.png');

    await user.upload(await screen.findByLabelText(/choose logo file/i), new File([new Uint8Array([137, 80, 78, 71])], 'logo.png', { type: 'image/png' }));
    await waitFor(async () => expect(await sidebarLogo()).toHaveAttribute('src', LOGO));
  });
});
