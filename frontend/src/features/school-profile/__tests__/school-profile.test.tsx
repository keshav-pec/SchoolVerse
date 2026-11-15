import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { school, SCHOOL_ID } from '@/test/fixtures';
import { mockApi, renderWithApp } from '@/test/utils';
import { SchoolProfilePage } from '../school-profile-page';

afterEach(() => vi.unstubAllGlobals());

const API = '/api/v1';
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
      [`PATCH ${API}/schools/${SCHOOL_ID}`]: { status: 409, error: { code: 'SCHOOL_CODE_TAKEN', message: 'This school code is already in use.', details: { fields: { schoolCode: 'This school code is already in use.' } } } },
    });
    const user = userEvent.setup();
    renderWithApp(<SchoolProfilePage />, { route: '/school-setup/profile' });

    const code = await screen.findByLabelText(/^school code/i);
    await user.clear(code);
    await user.type(code, 'taken');
    await user.click(await screen.findByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('This school code is already in use.')).toBeInTheDocument();
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
});
