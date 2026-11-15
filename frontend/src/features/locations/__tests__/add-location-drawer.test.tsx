import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { location, school, SCHOOL_ID } from '@/test/fixtures';
import { mockApi, renderWithApp } from '@/test/utils';
import { AddLocationDrawer } from '../add-location-drawer';

afterEach(() => vi.unstubAllGlobals());

const API = '/api/v1';
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
    expect(screen.getByLabelText(/location type/i)).toHaveValue('MAIN_CAMPUS');
  });
});
