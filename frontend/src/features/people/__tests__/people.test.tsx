import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import { EMPLOYEE_CATEGORY_LABELS, ROLE_LABELS, type ProfileChangeRequestDTO } from '@shared';
import { MyProfilePage } from '@/features/me/my-profile-page';
import { useAuth } from '@/lib/auth';
import { RequireAuth, RequirePeopleAdmin } from '@/routes/guards';
import { EMPLOYEE_ID, employeeProfile, restrictedProfile, selfProfile } from '@/test/fixtures';
import { mockApi, pickOption, renderWithApp } from '@/test/utils';
import { AddEmployeeDrawer } from '../add-employee-drawer';
import { ColleaguesPage } from '../colleagues-page';
import { EmployeePage } from '../employee-page';
import { AcademicTab } from '../tabs/academic-tab';
import { AccountTab } from '../tabs/account-tab';
import { PersonalTab } from '../tabs/personal-tab';

afterEach(() => vi.unstubAllGlobals());

const API = '/api/v1';
const forbidden = {
  status: 403,
  error: { code: 'STEP_UP_REQUIRED', message: 'Confirm your password to continue.' },
};

/** Components that call `useSession` need the session to have loaded first (the app's route guard does this). */
function Ready({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session ? <>{children}</> : null;
}

describe('IDs & Bank tab (SEC-02)', () => {
  it('shows masked values, Show asks for the password, shows the value, and masks it again after the timer', async () => {
    let stepped = false;
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/employees/${EMPLOYEE_ID}/restricted`]: { data: restrictedProfile },
      [`POST ${API}/auth/step-up`]: () => {
        stepped = true;
        return { data: { stepUpAt: new Date().toISOString(), validForSeconds: 300 } };
      },
      // The server refuses until a recent step-up exists, exactly like the real route.
      [`POST ${API}/employees/${EMPLOYEE_ID}/restricted/reveal`]: () =>
        stepped
          ? { data: { field: 'BANK_ACCOUNT_NUMBER', value: '000000005678', hideAfterSeconds: 1 } }
          : forbidden,
    });
    renderWithApp(
      <Ready>
        <PersonalTab employee={employeeProfile()} />
      </Ready>,
    );

    // Masked by default: nothing real is on the page.
    expect(await screen.findByText('•••• 5678')).toBeInTheDocument();
    expect(screen.getByText('••/••/1988')).toBeInTheDocument();
    expect(screen.getByText('XXXX XXXX 000X')).toBeInTheDocument();
    expect(screen.queryByText('000000005678')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /show account number/i }));

    // The step-up dialog opens; a wrong flow can be cancelled, a right one reveals.
    const dialog = await screen.findByRole('dialog', { name: /confirm your password/i });
    await user.type(within(dialog).getByLabelText(/^password/i), 'Welcome@123');
    await user.click(within(dialog).getByRole('button', { name: /^confirm$/i }));

    expect(await screen.findByText('000000005678')).toBeInTheDocument();
    expect(screen.queryByText('•••• 5678')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /hide account number/i })).toBeInTheDocument();

    // After the time the server named, it is masked again without any click.
    await waitFor(() => expect(screen.queryByText('000000005678')).not.toBeInTheDocument(), {
      timeout: 3000,
    });
    expect(screen.getByText('•••• 5678')).toBeInTheDocument();
  });

  it('cancelling the password dialog reveals nothing and shows no error', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/employees/${EMPLOYEE_ID}/restricted`]: { data: restrictedProfile },
      [`POST ${API}/employees/${EMPLOYEE_ID}/restricted/reveal`]: forbidden,
    });
    renderWithApp(
      <Ready>
        <PersonalTab employee={employeeProfile()} />
      </Ready>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /show date of birth/i }));
    const dialog = await screen.findByRole('dialog', { name: /confirm your password/i });
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByText('••/••/1988')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Login tab (IAM-01)', () => {
  it('has no password input anywhere, and says that a job title grants no access', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/employees/${EMPLOYEE_ID}/user-account`]: {
        data: { account: null, defaultEmail: 'priya@greenfield.demo' },
      },
    });
    const { container } = renderWithApp(
      <Ready>
        <AccountTab employee={employeeProfile()} />
      </Ready>,
    );
    expect(await screen.findByRole('button', { name: /create login/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/sign-in email/i)).toHaveValue('priya@greenfield.demo');
    expect(screen.getByLabelText(/^role/i)).toBeInTheDocument();
    expect(screen.getAllByText(/job title doesn’t give any access/i).length).toBeGreaterThan(0);
    expect(container.querySelector('input[type="password"]')).toBeNull();
    expect(screen.queryByLabelText(/password/i)).not.toBeInTheDocument();
  });

  it('sends the chosen role and email only, and never a password', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/employees/${EMPLOYEE_ID}/user-account`]: {
        data: { account: null, defaultEmail: 'priya@greenfield.demo' },
      },
      [`POST ${API}/employees/${EMPLOYEE_ID}/user-account`]: {
        status: 201,
        data: {
          userId: 'u9',
          email: 'priya@greenfield.demo',
          role: 'STAFF',
          status: 'PENDING_ACTIVATION',
        },
      },
    });
    renderWithApp(
      <Ready>
        <AccountTab employee={employeeProfile()} />
      </Ready>,
    );
    const user = userEvent.setup();
    await pickOption(user, await screen.findByLabelText(/^role/i), ROLE_LABELS.STAFF);
    await user.click(screen.getByRole('button', { name: /create login/i }));
    await waitFor(() => expect(api.callsTo('/user-account', 'POST')).toHaveLength(1));
    expect(api.callsTo('/user-account', 'POST')[0]!.body).toEqual({
      email: 'priya@greenfield.demo',
      role: 'STAFF',
    });
  });

  it('an active login offers suspend, change role and disable, with a last sign-in and still no password input', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/employees/${EMPLOYEE_ID}/user-account`]: {
        data: {
          account: {
            userId: 'u9',
            tenantId: 't1',
            email: 'priya@greenfield.demo',
            fullName: 'Priya Sharma',
            role: 'FACULTY',
            status: 'ACTIVE',
            personId: 'p1',
            lastLoginAt: '2026-11-10T09:00:00.000Z',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
          defaultEmail: null,
        },
      },
    });
    const { container } = renderWithApp(
      <Ready>
        <AccountTab employee={employeeProfile()} />
      </Ready>,
    );
    expect(await screen.findByRole('button', { name: /suspend login/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /change role/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /disable login/i })).toBeInTheDocument();
    expect(screen.getByText('priya@greenfield.demo')).toBeInTheDocument();
    expect(container.querySelector('input[type="password"]')).toBeNull();
  });
});

/** The employee code check: FAC-001 is taken, the next free teaching code is FAC-008. */
const codeCheck = ({ url }: { url: URL }) => {
  const code = url.searchParams.get('code')?.trim().toUpperCase() ?? null;
  if (!code) return { data: { code: null, valid: false, available: false, message: null, suggestion: url.searchParams.get('category') === 'FACULTY' ? 'FAC-008' : 'STF-003' } };
  const taken = code === 'FAC-001';
  return { data: { code, valid: true, available: !taken, message: taken ? 'This employee code is already in use.' : null, suggestion: taken ? 'FAC-008' : null } };
};

describe('Add employee drawer (FSM-01)', () => {
  it('picking a category fills in the next free code, and a taken code offers the next free one', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/master/locations`]: { data: [] },
      [`GET ${API}/departments`]: { data: [] },
      [`GET ${API}/designations`]: { data: [] },
      [`GET ${API}/employees`]: { data: { items: [], page: 1, pageSize: 100, total: 0 } },
      [`GET ${API}/employees/code-availability`]: codeCheck,
    });
    renderWithApp(
      <Ready>
        <AddEmployeeDrawer open onOpenChange={vi.fn()} />
      </Ready>,
    );
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog', { name: /add employee/i });
    const code = within(drawer).getByLabelText(/^employee code/i);

    await pickOption(user, within(drawer).getByLabelText(/^category/i), EMPLOYEE_CATEGORY_LABELS.FACULTY);
    await waitFor(() => expect(code).toHaveValue('FAC-008'));
    expect(await within(drawer).findByText(/suggested for you and free to use/i)).toBeInTheDocument();

    // Typing a code someone already has offers the free one instead.
    await user.clear(code);
    await user.type(code, 'fac-001');
    expect(await within(drawer).findByText(/someone already has this code/i)).toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Use FAC-008' }));
    expect(code).toHaveValue('FAC-008');
  });

  it('when there are no departments or designations, offers to add the suggested lists in one click', async () => {
    let departments: { departmentId: string; code: string; name: string; status: string }[] = [];
    const api = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/master/locations`]: { data: [] },
      [`GET ${API}/departments`]: () => ({ data: departments }),
      [`GET ${API}/designations`]: { data: [{ designationId: 'g1', code: 'PGT', name: 'PGT', status: 'ACTIVE' }] },
      [`GET ${API}/employees`]: { data: { items: [], page: 1, pageSize: 100, total: 0 } },
      [`GET ${API}/employees/code-availability`]: codeCheck,
      [`POST ${API}/departments/suggested`]: () => {
        departments = [{ departmentId: 'd1', code: 'ACADEMICS', name: 'Academics', status: 'ACTIVE' }];
        return { status: 201, data: { created: departments, skipped: 0 } };
      },
    });
    renderWithApp(
      <Ready>
        <AddEmployeeDrawer open onOpenChange={vi.fn()} />
      </Ready>,
    );
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog', { name: /add employee/i });
    await user.type(within(drawer).getByLabelText(/^first name/i), 'Priya');
    await user.type(within(drawer).getByLabelText(/^last name/i), 'Sharma');
    await pickOption(user, within(drawer).getByLabelText(/^category/i), EMPLOYEE_CATEGORY_LABELS.FACULTY);
    await waitFor(() => expect(within(drawer).getByLabelText(/^employee code/i)).toHaveValue('FAC-008'));
    await user.click(within(drawer).getByRole('button', { name: /^next/i }));

    expect(await within(drawer).findByText(/your school has no departments yet/i)).toBeInTheDocument();
    expect(within(drawer).queryByText(/your school has no designations yet/i)).not.toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /set up your own list/i })).toHaveAttribute('href', '/people/settings');
    await user.click(within(drawer).getByRole('button', { name: /add suggested departments/i }));
    await waitFor(() => expect(api.callsTo('/departments/suggested', 'POST')).toHaveLength(1));
    await waitFor(() => expect(within(drawer).queryByText(/your school has no departments yet/i)).not.toBeInTheDocument());
  });


  it('shows field errors on the first step and does not move on until they are fixed', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/master/locations`]: { data: [] },
      [`GET ${API}/departments`]: { data: [] },
      [`GET ${API}/designations`]: { data: [] },
      [`GET ${API}/employees`]: { data: { items: [], page: 1, pageSize: 100, total: 0 } },
      [`GET ${API}/employees/code-availability`]: codeCheck,
    });
    renderWithApp(
      <Ready>
        <AddEmployeeDrawer open onOpenChange={vi.fn()} />
      </Ready>,
    );
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog', { name: /add employee/i });
    // Joining date starts as today, so it isn't one of the errors.
    expect(within(drawer).getByLabelText(/^joining date/i)).toHaveValue(new Date().toLocaleDateString('en-CA'));
    await user.click(within(drawer).getByRole('button', { name: /^next/i }));

    expect(await within(drawer).findByText('First name is required.')).toBeInTheDocument();
    expect(within(drawer).getByText('Last name is required.')).toBeInTheDocument();
    expect(within(drawer).getByText('Choose Teaching staff or Non-teaching staff.')).toBeInTheDocument();
    expect(within(drawer).getByText('Employee code is required.')).toBeInTheDocument();
    // Still on step 1: the placement fields have not appeared.
    expect(within(drawer).queryByLabelText(/primary location/i)).not.toBeInTheDocument();

    // A code in the wrong shape is caught as well.
    await user.type(within(drawer).getByLabelText(/first name/i), 'Priya');
    await user.type(within(drawer).getByLabelText(/last name/i), 'Sharma');
    await pickOption(user, within(drawer).getByLabelText(/^category/i), EMPLOYEE_CATEGORY_LABELS.FACULTY);
    await user.clear(within(drawer).getByLabelText(/^employee code/i));
    await user.type(within(drawer).getByLabelText(/^employee code/i), 'bad code!');
    await user.click(within(drawer).getByRole('button', { name: /^next/i }));
    expect(
      await within(drawer).findByText(/Use up to 20 letters, numbers, hyphens or slashes/),
    ).toBeInTheDocument();
  });
});

describe('Self-service profile (FSM-06, FSM-07)', () => {
  it('Request change for bank details asks for the password, then shows the request as pending', async () => {
    let stepped = false;
    let created: ProfileChangeRequestDTO | null = null;
    const api = mockApi('FACULTY', {
      [`GET ${API}/me/profile`]: () => ({
        data: selfProfile({ pendingRequests: created ? [created] : [] }),
      }),
      [`GET ${API}/me/profile-change-requests`]: () => ({ data: created ? [created] : [] }),
      [`GET ${API}/me/documents`]: { data: [] },
      [`POST ${API}/auth/step-up`]: () => {
        stepped = true;
        return { data: { stepUpAt: new Date().toISOString(), validForSeconds: 300 } };
      },
      [`POST ${API}/me/profile-change-requests`]: ({ body }) => {
        if (!stepped) return forbidden;
        created = {
          changeRequestId: 'r1',
          employeeId: EMPLOYEE_ID,
          employeeCode: 'FAC-001',
          employeeName: 'Priya Sharma',
          fieldCategory: 'BANK_DETAILS',
          status: 'PENDING',
          currentDisplay: 'Demo Bank •••• 5678 · TEST0000001',
          proposedDisplay: 'Other Bank •••• 7777 · TEST0000002',
          reason: (body as { reason?: string }).reason ?? null,
          requestedAt: '2026-11-16T09:00:00.000Z',
          decidedAt: null,
          decidedByName: null,
          decisionNote: null,
        };
        return { status: 201, data: created };
      },
    });
    renderWithApp(
      <Ready>
        <MyProfilePage />
      </Ready>,
    );
    const user = userEvent.setup();
    // Masked values only; nothing real.
    expect(await screen.findByText('XXXX XXXX 000X')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /request change: bank details/i }));

    const form = await screen.findByRole('alertdialog');
    await user.clear(within(form).getByLabelText(/account number/i));
    await user.type(within(form).getByLabelText(/account number/i), '000000007777');
    await user.type(within(form).getByLabelText(/ifsc code/i), 'TEST0000002');
    await user.type(within(form).getByLabelText(/bank name/i), 'Other Bank');
    await user.click(within(form).getByRole('button', { name: /send request/i }));

    // The server asks for step-up; the dialog appears; the request is retried once.
    const stepUp = await screen.findByRole('dialog', { name: /confirm your password/i });
    await user.type(within(stepUp).getByLabelText(/^password/i), 'Welcome@123');
    await user.click(within(stepUp).getByRole('button', { name: /^confirm$/i }));

    const list = await screen.findByRole('list', { name: /your change requests/i });
    expect(within(list).getByText('Pending')).toBeInTheDocument();
    expect(within(list).getByText(/Other Bank •••• 7777/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /request change: bank details/i })).toBeDisabled();
    expect(api.callsTo('/me/profile-change-requests', 'POST')).toHaveLength(2); // refused once, then accepted
    // The raw account number never appears in the page afterwards.
    expect(document.body.textContent).not.toContain('000000007777');
  });
});

describe('Faculty sees no admin controls (RBAC)', () => {
  it('the colleague directory has no Add, Export or admin links', async () => {
    mockApi('FACULTY', {
      [`GET ${API}/employees`]: {
        data: {
          items: [
            {
              ...employeeProfile({
                fullName: 'Rohan Gill',
                displayName: 'Rohan Gill',
                employeeCode: 'STF-001',
              }),
              personal: undefined,
            },
          ],
          page: 1,
          pageSize: 12,
          total: 1,
        },
      },
    });
    renderWithApp(
      <Ready>
        <ColleaguesPage />
      </Ready>,
    );
    expect(await screen.findByText('Rohan Gill')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add employee/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /export/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /rohan gill/i })).not.toBeInTheDocument(); // cards, not links to full records
  });

  it('an administrators-only people URL is Not Found for Faculty and the restricted page for Parents', async () => {
    const routes = (
      <Routes>
        <Route element={<RequireAuth />}>
          <Route path="/people" element={<RequirePeopleAdmin />}>
            <Route index element={<p>Directory for admins</p>} />
            <Route path=":employeeId" element={<p>Employee record</p>} />
          </Route>
          <Route path="/restricted" element={<p>Administrators only</p>} />
        </Route>
        <Route path="/login" element={<p>Sign in</p>} />
      </Routes>
    );

    mockApi('FACULTY', {});
    const faculty = renderWithApp(routes, { route: `/people/${EMPLOYEE_ID}` });
    expect(
      await screen.findByRole('heading', { name: /lost in the schoolverse/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Employee record')).not.toBeInTheDocument();
    faculty.unmount();

    mockApi('PARENT', {});
    renderWithApp(routes, { route: '/people' });
    expect(await screen.findByText('Administrators only')).toBeInTheDocument();
    vi.unstubAllGlobals();

    mockApi('SCHOOL_ADMIN', {});
    renderWithApp(routes, { route: '/people' });
    expect(await screen.findByText('Directory for admins')).toBeInTheDocument();
  });
});

describe('Classes & Subjects tab (FSM-04)', () => {
  const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const CLASS = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const MOH = employeeProfile().primaryLocation!.locationId;
  const session = { academicSessionId: SESSION, name: '2026-27', status: 'ACTIVE', isCurrent: true, startDate: '2026-04-01', endDate: '2027-03-31', locations: [{ locationId: MOH, locationName: 'Mohali Campus' }] };
  const offering = (id: string, extra: object) => ({ classOfferingId: CLASS, status: 'ACTIVE', ...extra, [id.startsWith('s') ? 'sectionOfferingId' : 'subjectOfferingId']: id });

  it('with no published session, says why and links to Academic Setup', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/academic-sessions`]: { data: [{ ...session, status: 'DRAFT', isCurrent: false }] } });
    renderWithApp(
      <Ready>
        <AcademicTab employee={employeeProfile()} />
      </Ready>,
    );
    expect(await screen.findByText('No published session yet')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: /about classes & subjects/i })).toHaveTextContent('Required');
    expect(screen.getByRole('link', { name: /go to academic setup/i })).toHaveAttribute('href', '/academics');
  });

  it('two subjects for two sections is one save of four assignments', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/academic-sessions`]: { data: [session] },
      [`GET ${API}/employees/${EMPLOYEE_ID}/academic-assignments`]: { data: [] },
      [`GET ${API}/academic-sessions/${SESSION}/class-offerings`]: { data: [{ classOfferingId: CLASS, displayName: 'Class 8', status: 'ACTIVE' }] },
      [`GET ${API}/class-offerings/${CLASS}/sections`]: { data: [offering('sA', { displayName: '8-A' }), offering('sB', { displayName: '8-B' })] },
      [`GET ${API}/class-offerings/${CLASS}/subjects`]: { data: [offering('jM', { subjectName: 'Mathematics' }), offering('jS', { subjectName: 'Science' })] },
      [`POST ${API}/employees/${EMPLOYEE_ID}/academic-assignments`]: ({ body }) => ({ status: 201, data: (body as { items: unknown[] }).items }),
    });
    renderWithApp(
      <Ready>
        <AcademicTab employee={employeeProfile()} />
      </Ready>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /assign classes/i }));
    const drawer = await screen.findByRole('dialog', { name: /assign classes/i });
    // The role is chosen from explained cards, not a bare list of terms.
    expect(within(drawer).getByRole('radio', { name: /subject teacher/i })).toBeChecked();
    expect(within(drawer).getByText(/in charge of a section/i)).toBeInTheDocument();
    await pickOption(user, within(drawer).getByLabelText(/^class\W*$/i), 'Class 8');
    const sections = await within(drawer).findByRole('group', { name: /sections/i });
    await user.click(within(sections).getByRole('button', { name: 'Select All' }));
    const subjects = within(drawer).getByRole('group', { name: /subjects/i });
    await user.click(within(subjects).getByRole('button', { name: 'Select All' }));
    expect(within(drawer).getByText(/Mathematics, Science for 8-A, 8-B/)).toBeInTheDocument();
    // Dates are tucked away: the whole session is the default.
    expect(within(drawer).queryByLabelText(/starts on/i)).not.toBeInTheDocument();
    await user.click(within(drawer).getByRole('button', { name: 'Assign 4' }));

    await waitFor(() => expect(api.callsTo('/academic-assignments', 'POST')).toHaveLength(1));
    expect(api.callsTo('/academic-assignments', 'POST')[0]!.body).toEqual({
      items: [
        { assignmentType: 'SUBJECT_FACULTY', sectionId: 'sA', subjectOfferingId: 'jM' },
        { assignmentType: 'SUBJECT_FACULTY', sectionId: 'sA', subjectOfferingId: 'jS' },
        { assignmentType: 'SUBJECT_FACULTY', sectionId: 'sB', subjectOfferingId: 'jM' },
        { assignmentType: 'SUBJECT_FACULTY', sectionId: 'sB', subjectOfferingId: 'jS' },
      ],
    });
  });
});

describe('Employee record tabs', () => {
  it('Employment details sit on Overview, old ?tab=employment links land there, and tabs use plain names', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/employees/${EMPLOYEE_ID}`]: { data: employeeProfile() },
      [`GET ${API}/employees/${EMPLOYEE_ID}/location-assignments`]: { data: [] },
    });
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/people/:employeeId" element={<EmployeePage />} />
        </Routes>
      </Ready>,
      { route: `/people/${EMPLOYEE_ID}?tab=employment` },
    );
    expect(await screen.findByRole('tab', { name: /overview/i, selected: true })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Work details' })).toBeInTheDocument();
    expect(screen.getByText('Reports to')).toBeInTheDocument();
    const tabs = screen.getAllByRole('tab').map((t) => t.textContent?.trim());
    expect(tabs).toEqual(['Overview', 'Classes & Subjects', 'Contact', 'IDs & Bank', 'Documents', 'Login', 'History']);
    expect(screen.getByRole('button', { name: 'What the statuses mean' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /record exit/i })).toBeInTheDocument();
  });
});
