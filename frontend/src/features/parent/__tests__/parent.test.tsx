import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import type { ParentChildDTO, ParentStudentSummaryDTO } from '@shared';
import { RequireParent } from '@/routes/guards';
import { classSection } from '@/test/fixtures';
import { API, Ready, mockApi, renderWithApp, type MockResponse } from '@/test/utils';
import { ParentLayout } from '../parent-layout';
import { ParentChildPage, ParentDocumentsPage, ParentHomePage } from '../parent-pages';
import { ParentRequestsPage } from '../parent-requests-page';

beforeEach(() => sessionStorage.clear());

const RIYA = 'aaaaaaaa-0000-4000-8000-000000000001';
const ARJUN = 'aaaaaaaa-0000-4000-8000-000000000002';
const STRANGER = 'aaaaaaaa-0000-4000-8000-000000000099';

const kid = (studentId: string, name: string, code: string): ParentChildDTO => ({ studentId, fullName: name, displayName: name, admissionNumber: `GPS/2026/${code}`, classSection: classSection(code === '00001' ? 'A' : 'B'), status: 'ACTIVE', relationshipType: 'Mother', canSeeAcademics: true, canSeeFees: false });
const summary = (studentId: string, name: string): ParentStudentSummaryDTO => ({ studentId, fullName: name, displayName: name, admissionNumber: 'GPS/2026/00001', classSection: classSection('A'), rollNumber: '17', hasPhoto: false, subjects: [{ subjectOfferingId: 'm', subjectName: 'Maths', isMandatory: true }], primaryGuardianName: 'Simran Kaur', campusName: 'Mohali Campus' });

function portal(route: string, extra: Record<string, MockResponse> = {}, kids = [kid(RIYA, 'Riya Sharma', '00001'), kid(ARJUN, 'Arjun Sharma', '00002')]) {
  const api = mockApi('PARENT', {
    [`GET ${API}/parent/children`]: { data: { children: kids } },
    [`GET ${API}/parent/children/${RIYA}`]: { data: summary(RIYA, 'Riya Sharma') },
    [`GET ${API}/parent/children/${ARJUN}`]: { data: summary(ARJUN, 'Arjun Sharma') },
    [`GET ${API}/parent/children/${RIYA}/documents`]: { data: [] },
    [`GET ${API}/parent/children/${ARJUN}/documents`]: { data: [] },
    [`GET ${API}/parent/children/${STRANGER}`]: { status: 404, error: { code: 'NOT_FOUND', message: 'Not found.' } },
    [`GET ${API}/parent/children/${STRANGER}/documents`]: { status: 404, error: { code: 'NOT_FOUND', message: 'Not found.' } },
    [`GET ${API}/parent/change-requests`]: { data: [] },
    ...extra,
  });
  renderWithApp(
    <Ready>
      <Routes>
        <Route path="/parent" element={<RequireParent />}>
          <Route element={<ParentLayout />}>
            <Route index element={<ParentHomePage />} />
            <Route path="children/:studentId" element={<ParentChildPage />} />
            <Route path="documents" element={<ParentDocumentsPage />} />
            <Route path="requests" element={<ParentRequestsPage />} />
          </Route>
        </Route>
      </Routes>
    </Ready>,
    { route },
  );
  return api;
}

describe('Parent portal (Module 4, Part 4)', () => {
  it('Home has a hero greeting and quick links like the other portals; the switcher shows both children and switching changes the card', async () => {
    portal('/parent');
    expect(await screen.findByRole('heading', { level: 1, name: /good (morning|afternoon|evening)/i })).toBeInTheDocument();
    const card = await screen.findByLabelText('Selected child');
    expect(within(card).getByRole('heading', { name: 'Riya Sharma' })).toBeInTheDocument();
    expect(card).toHaveTextContent('VIII-A');
    const switcher = screen.getByRole('tablist', { name: 'Choose a child' });
    expect(within(switcher).getAllByRole('tab')).toHaveLength(2);
    expect(within(switcher).getByRole('tab', { name: /riya sharma/i })).toHaveAttribute('aria-selected', 'true');

    const actions = screen.getByRole('region', { name: /what you can do/i });
    expect(within(actions).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([`/parent/children/${RIYA}`, `/parent/documents?child=${RIYA}`, '/parent/requests']);

    await userEvent.setup().click(within(switcher).getByRole('tab', { name: /arjun sharma/i }));
    expect(await within(await screen.findByLabelText('Selected child')).findByRole('heading', { name: 'Arjun Sharma' })).toBeInTheDocument();
    expect(within(switcher).getByRole('tab', { name: /arjun sharma/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('My Child shows the full cards: class, subjects, primary parent', async () => {
    portal(`/parent/children/${RIYA}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'Riya Sharma' })).toBeInTheDocument();
    expect(screen.getByLabelText('Class and section')).toHaveTextContent('VIII-A');
    expect(screen.getByLabelText('Subjects')).toHaveTextContent('Maths');
    expect(screen.getByLabelText('Primary parent')).toHaveTextContent('Simran Kaur');
  });

  it('shows no admin controls: only the four portal links, no sidebar, no edit buttons', async () => {
    portal('/parent');
    await screen.findByLabelText('Selected child');
    const nav = screen.getByRole('navigation', { name: 'Parent portal' });
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'My Child', 'Documents', 'Requests']);
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
    for (const name of [/add student/i, /edit/i, /remove access/i, /change section/i, /delete/i]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('the portal nav is outside the blurred header, so the phone bar can pin to the bottom of the screen', async () => {
    portal('/parent');
    await screen.findByLabelText('Selected child');
    // backdrop-filter on an ancestor turns `fixed` into "fixed to that ancestor", which is what hid the bar before.
    const nav = screen.getByRole('navigation', { name: 'Parent portal' });
    expect(within(screen.getByRole('banner')).queryByRole('navigation', { name: 'Parent portal' })).not.toBeInTheDocument();
    expect(nav.closest('aside')?.className).toMatch(/(^|\s)fixed(\s|$)/);
  });

  it('shows the logo the school set, even though parents cannot open the school profile', async () => {
    const api = portal('/parent', { [`GET ${API}/schools/current/branding`]: { data: { displayName: 'Greenfield Public School', logoUrl: '/uploads/t1/school-logos/logo.png' } } });
    await screen.findByLabelText('Selected child');
    const logos = await screen.findAllByRole('img', { name: /logo/i });
    expect(logos.length).toBeGreaterThan(0);
    for (const img of logos) expect(img).toHaveAttribute('src', '/uploads/t1/school-logos/logo.png');
    expect(api.callsTo('/schools/current', 'GET').every((c) => c.path.endsWith('/branding'))).toBe(true);
  });

  it('has the same top bar as the other portals: a breadcrumb and the account menu', async () => {
    portal('/parent/documents');
    await screen.findByRole('heading', { name: 'Documents' });
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(crumbs).toHaveTextContent('Documents');
    expect(within(screen.getByRole('banner')).getByRole('button', { name: /open account menu/i })).toBeInTheDocument();
  });

  it('another family’s child is "Not found"; a child whose access was removed during the visit says so', async () => {
    portal(`/parent/children/${STRANGER}`);
    expect(await screen.findByRole('heading', { name: 'Not found' })).toBeInTheDocument();
    vi.unstubAllGlobals();

    // Arjun was shown earlier in this visit; now the school has removed access to him.
    sessionStorage.setItem('sv.parent.seen', JSON.stringify([RIYA, ARJUN]));
    portal(`/parent/children/${ARJUN}`, { [`GET ${API}/parent/children/${ARJUN}`]: { status: 404, error: { code: 'NOT_FOUND', message: 'Not found.' } }, [`GET ${API}/parent/children/${ARJUN}/documents`]: { status: 404, error: { code: 'NOT_FOUND', message: 'Not found.' } } }, [kid(RIYA, 'Riya Sharma', '00001')]);
    expect(await screen.findByRole('heading', { name: /you no longer have access to this child/i })).toBeInTheDocument();
  });

  it('with no linked children it says to contact the school', async () => {
    portal('/parent', {}, []);
    expect(await screen.findByText(/no children are linked to this login/i)).toBeInTheDocument();
  });

  it('"Ask for a change" sends the field, the new value and the reason for the chosen child', async () => {
    const api = portal('/parent/requests', { [`POST ${API}/parent/children/${RIYA}/change-requests`]: { status: 201, data: {} } });
    const form = await screen.findByRole('form', { name: /ask for a change/i });
    const user = userEvent.setup();
    await user.click(within(form).getByRole('radio', { name: /date of birth/i }));
    await user.type(within(form).getByLabelText(/^correct date of birth/i), '2014-06-11');
    await user.type(within(form).getByLabelText(/^why\?/i), 'Typo on the form');
    await user.click(within(form).getByRole('button', { name: /send request/i }));
    await waitFor(() => expect(api.callsTo('/change-requests', 'POST')).toHaveLength(1));
    expect(api.callsTo('/change-requests', 'POST')[0]!.body).toEqual({ field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2014-06-11' }, reason: 'Typo on the form' });
  });

  it('staff and admins are shown Not Found at /parent', async () => {
    mockApi('SCHOOL_ADMIN', {});
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/parent" element={<RequireParent />}>
            <Route index element={<p>Portal</p>} />
          </Route>
        </Routes>
      </Ready>,
      { route: '/parent' },
    );
    expect(await screen.findByRole('heading', { name: /lost in the schoolverse/i })).toBeInTheDocument();
    expect(screen.queryByText('Portal')).not.toBeInTheDocument();
  });
});
