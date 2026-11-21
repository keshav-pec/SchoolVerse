import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import type { StudentAttentionDTO, StudentSubjectsDTO } from '@shared';
import { useAuth } from '@/lib/auth';
import { RequireStudentAdmin } from '@/routes/guards';
import {
  academicSession,
  CLASS_OFFERING_ID,
  classOffering,
  directoryRow,
  ENROLLMENT_ID,
  enrollmentDto,
  guardianLink,
  LOCATION_ID,
  masterLocation,
  SECTION_A_ID,
  SECTION_B_ID,
  SESSION_ID,
  STUDENT_ID,
  studentProfile,
} from '@/test/fixtures';
import { mockApi, pickOption, renderWithApp, type MockResponse } from '@/test/utils';
import { AddStudentDrawer } from '../add-student-drawer';
import { AttentionPage } from '../attention-page';
import { StudentContextProvider } from '../context';
import { MyStudentsPage } from '../my-students-page';
import { ChangeSectionDialog } from '../section-dialogs';
import { StudentPage } from '../student-page';
import { StudentsPage } from '../students-page';
import { SubjectsDrawer } from '../subjects-drawer';

afterEach(() => vi.unstubAllGlobals());

const API = '/api/v1';

/** Components that call `useSession` need the session to have loaded first (the app's route guard does this). */
function Ready({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session ? <>{children}</> : null;
}

const sectionRows = [
  { sectionId: SECTION_B_ID, sectionCode: 'B', sectionName: 'VIII-B', capacity: 40, enrolled: 34, free: 6, isFull: false, recommended: true, label: 'VIII-B · 34 of 40' },
  { sectionId: SECTION_A_ID, sectionCode: 'A', sectionName: 'VIII-A', capacity: 40, enrolled: 39, free: 1, isFull: false, recommended: false, label: 'VIII-A · 39 of 40' },
];

const subjectOffering = (id: string, name: string, offeringType: 'MANDATORY' | 'ELECTIVE' | 'LANGUAGE' = 'MANDATORY') => ({
  subjectOfferingId: id,
  classOfferingId: CLASS_OFFERING_ID,
  academicSessionId: SESSION_ID,
  locationId: LOCATION_ID,
  subjectId: `s-${id}`,
  subjectCode: id.toUpperCase(),
  subjectName: name,
  category: 'CORE',
  offeringType,
  boardSubjectDefinitionId: null,
  boardSubjectCode: null,
  boardSubjectName: null,
  status: 'ACTIVE',
});

/** What every Students screen needs to know about the school year, campus and class. */
function schoolHandlers(extra: Record<string, MockResponse | ((r: { url: URL; method: string; body: unknown }) => MockResponse | undefined)> = {}) {
  return {
    [`GET ${API}/academic-sessions`]: { data: [academicSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation] },
    [`GET ${API}/academic-sessions/${SESSION_ID}/class-offerings`]: { data: [classOffering] },
    [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/sections`]: { data: [] },
    [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/subjects`]: {
      data: ['English', 'Maths', 'Science', 'Social Science', 'Computer'].map((n, i) => subjectOffering(`m${i}`, n)),
    },
    [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/choice-groups`]: { data: [] },
    [`POST ${API}/sections/recommend`]: { data: sectionRows },
    [`GET ${API}/admission-number-settings`]: { data: { mode: 'AUTO' } },
    [`POST ${API}/admission-numbers/preview`]: { data: { mode: 'AUTO', admissionNumber: 'GPS/2026/00002' } },
    [`POST ${API}/guardians/match`]: { data: [] },
    ...extra,
  };
}

function renderQuickAdd() {
  return renderWithApp(
    <Ready>
      <StudentContextProvider>
        <AddStudentDrawer open onOpenChange={() => {}} />
      </StudentContextProvider>
    </Ready>,
  );
}

async function chooseClass(user: ReturnType<typeof userEvent.setup>) {
  await pickOption(user, await screen.findByLabelText(/^class\W*$/i), /^class viii/i);
}

// ───────────────────────────────────────────────────────────── Quick Add

describe('Quick Add (Module 4, Part 2)', () => {
  it('shows the matched-parent card as soon as a phone is typed, and "Use This Parent" fills the parent in', async () => {
    mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`POST ${API}/guardians/match`]: {
        data: [
          {
            personId: 'p-priya',
            fullName: 'Priya Sharma',
            maskedPhone: '•••••• 0001',
            maskedEmail: null,
            isGuardian: true,
            children: [{ studentId: 'k1', fullName: 'Riya', admissionNumber: 'GPS/2026/00001', classSection: { classOfferingId: 'c', className: 'Class VI', classCode: 'VI', sectionId: 's', sectionCode: 'B', label: 'VI-B' } }],
          },
        ],
      },
    });
    renderQuickAdd();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^parent phone/i), '9876543210');

    expect(await screen.findByText(/priya sharma is already a parent of riya \(vi-b\)/i, {}, { timeout: 4000 })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /use this parent/i }));

    expect(await screen.findByText(/using priya sharma/i)).toBeInTheDocument();
    // A reused parent needs no name to be typed again.
    expect(screen.queryByLabelText(/^parent name/i)).not.toBeInTheDocument();
  });

  it('hides the admission number field in AUTO mode and shows it in MANUAL mode', async () => {
    mockApi('SCHOOL_ADMIN', schoolHandlers());
    const { unmount } = renderQuickAdd();
    expect(await screen.findByText(/will be created automatically/i)).toBeInTheDocument();
    expect(screen.queryByLabelText(/^admission number/i)).not.toBeInTheDocument();
    unmount();

    mockApi('SCHOOL_ADMIN', schoolHandlers({ [`GET ${API}/admission-number-settings`]: { data: { mode: 'MANUAL' } } }));
    renderQuickAdd();
    expect(await screen.findByLabelText(/^admission number/i)).toBeInTheDocument();
    expect(screen.queryByText(/will be created automatically \(/i)).not.toBeInTheDocument();
  });

  it('says how many required subjects are added automatically once a class is chosen, and mentions subject choices', async () => {
    mockApi(
      'SCHOOL_ADMIN',
      schoolHandlers({
        [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/choice-groups`]: {
          data: [{ choiceGroupId: 'g1', classOfferingId: CLASS_OFFERING_ID, academicSessionId: SESSION_ID, name: 'Second language', ruleType: 'CHOOSE_ONE', min: 1, max: 1, sequence: 1, status: 'ACTIVE', subjects: [], summary: 'Choose 1 of Hindi, Punjabi' }],
        },
      }),
    );
    renderQuickAdd();
    const user = userEvent.setup();
    await chooseClass(user);

    expect(await screen.findByText('5 required subjects')).toBeInTheDocument();
    expect(screen.getByText(/subject choice \(for example a second language\)/i)).toBeInTheDocument();
    // The best section comes first, with its free seats.
    expect(await screen.findByText(/suggested: viii-b · 34 of 40/i)).toBeInTheDocument();
  });

  it('asks "Is this the same student?" with both choices, and "No, Add As New" sends the confirmation', async () => {
    let posts = 0;
    const bodies: unknown[] = [];
    const created = { student: studentProfile({ fullName: 'Riya Sharma' }), enrollment: enrollmentDto(), subjectsMessage: '5 mandatory subjects added', mandatorySubjectsAdded: 5, guardianReused: false, warnings: [] };
    mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`POST ${API}/students`]: ({ body }) => {
        bodies.push(body);
        posts += 1;
        if (posts === 1) {
          return {
            status: 409,
            error: {
              code: 'POSSIBLE_DUPLICATE_STUDENT',
              message: 'This looks like a student who is already in the school.',
              details: {
                candidates: [{ studentId: 'old-1', fullName: 'Riya Sharma', admissionNumber: 'GPS/2025/00044', status: 'ACTIVE', classSection: { classOfferingId: 'c', className: 'Class VII', classCode: 'VII', sectionId: null, sectionCode: 'A', label: 'VII-A' }, reasons: ['SAME_NAME_AND_DOB'] }],
              },
            },
          };
        }
        return { status: 201, data: created };
      },
      [`GET ${API}/students/${STUDENT_ID}`]: { data: studentProfile() },
    });
    renderQuickAdd();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/^first name/i), 'Riya');
    await chooseClass(user);
    await user.type(screen.getByLabelText(/^parent name/i), 'Priya');
    await pickOption(user, screen.getByLabelText(/^relationship/i), 'Mother');
    await user.click(screen.getByRole('button', { name: /^add student$/i }));

    const card = await screen.findByRole('region', { name: /possible duplicate/i });
    expect(within(card).getByText(/is this the same student\?/i)).toBeInTheDocument();
    expect(within(card).getByText(/same name and date of birth/i)).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: /open existing student/i })).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: /no, add as new/i }));
    await waitFor(() => expect(posts).toBe(2));
    expect(bodies[0]).not.toHaveProperty('confirmNotDuplicate');
    expect(bodies[1]).toMatchObject({ confirmNotDuplicate: true, legalFirstName: 'Riya', classOfferingId: CLASS_OFFERING_ID, locationId: LOCATION_ID });
  });

  it('keeps the form open with a plain message when something required is missing, and sends nothing', async () => {
    const api = mockApi('SCHOOL_ADMIN', schoolHandlers());
    renderQuickAdd();
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^add student$/i }));
    expect(await screen.findByText('Enter the student’s first name.')).toBeInTheDocument();
    expect(screen.getByText('Choose a class.')).toBeInTheDocument();
    expect(screen.getByText('Enter the parent’s name.')).toBeInTheDocument();
    expect(api.callsTo('/students', 'POST')).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────── class, section and subjects

describe('Change Section and the subject checker (Module 4, Part 2)', () => {
  it('lists the other sections with seats taken, asks for a reason, and sends the move', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`POST ${API}/students/${STUDENT_ID}/section-transfer`]: {
        data: { from: {}, to: { sectionName: 'VIII-B' }, event: {}, warnings: [] },
      },
    });
    renderWithApp(
      <Ready>
        <ChangeSectionDialog student={studentProfile()} onClose={() => {}} />
      </Ready>,
    );
    const user = userEvent.setup();
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/now in viii-a/i)).toBeInTheDocument();

    // The current section (VIII-A) is not offered; VIII-B shows how full it is.
    await user.click(await within(dialog).findByLabelText(/^new section/i));
    expect(await screen.findByRole('option', { name: /viii-b · 34 of 40/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /viii-a/i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('option', { name: /viii-b · 34 of 40/i }));

    await user.click(within(dialog).getByRole('button', { name: /^change section$/i }));
    expect(await within(dialog).findByText(/write a short reason/i)).toBeInTheDocument();
    expect(api.callsTo('section-transfer')).toHaveLength(0);

    await user.type(within(dialog).getByLabelText(/^reason/i), 'Parent request');
    await user.click(within(dialog).getByRole('button', { name: /^change section$/i }));
    await waitFor(() => expect(api.callsTo('section-transfer', 'POST')).toHaveLength(1));
    expect(api.callsTo('section-transfer')[0]!.body).toMatchObject({ toSectionId: SECTION_B_ID, reason: 'Parent request' });
  });

  it('checks the subject choice and says in plain words what to fix, and blocks saving until it is right', async () => {
    const hindi = subjectOffering('hin', 'Hindi', 'LANGUAGE');
    const punjabi = subjectOffering('pun', 'Punjabi', 'LANGUAGE');
    const mandatory = ['English', 'Maths'].map((n, i) => subjectOffering(`m${i}`, n));
    const group = (satisfied: boolean, picked: number) => ({ choiceGroupId: 'g1', name: 'Second language', ruleType: 'CHOOSE_ONE', min: 1, max: 1, summary: 'Choose 1 of Hindi, Punjabi', picked, satisfied });
    const subjects: StudentSubjectsDTO = {
      enrollmentId: ENROLLMENT_ID,
      subjects: [
        { subjectEnrollmentId: 'se1', enrollmentId: ENROLLMENT_ID, subjectOfferingId: 'm0', subjectId: 's', subjectCode: 'ENG', subjectName: 'English', offeringType: 'MANDATORY', source: 'AUTO_MANDATORY', isMandatory: true, effectiveFrom: '2026-04-01', effectiveTo: null, status: 'ACTIVE' },
        { subjectEnrollmentId: 'se2', enrollmentId: ENROLLMENT_ID, subjectOfferingId: 'hin', subjectId: 's', subjectCode: 'HIN', subjectName: 'Hindi', offeringType: 'LANGUAGE', source: 'ADMIN_SELECTED', isMandatory: false, effectiveFrom: '2026-04-01', effectiveTo: null, status: 'ACTIVE' },
      ],
      selection: { valid: true, problems: [], groups: [group(true, 1)] as never, mandatoryOfferingIds: ['m0', 'm1'], selectedOfferingIds: ['m0', 'm1', 'hin'] },
      choicePending: false,
    };
    const api = mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`GET ${API}/student-enrollments/${ENROLLMENT_ID}/subjects`]: { data: subjects },
      [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/subjects`]: { data: [...mandatory, hindi, punjabi] },
      [`GET ${API}/class-offerings/${CLASS_OFFERING_ID}/choice-groups`]: {
        data: [{ choiceGroupId: 'g1', classOfferingId: CLASS_OFFERING_ID, academicSessionId: SESSION_ID, name: 'Second language', ruleType: 'CHOOSE_ONE', min: 1, max: 1, sequence: 1, status: 'ACTIVE', summary: 'Choose 1 of Hindi, Punjabi', subjects: [hindi, punjabi].map((s) => ({ subjectOfferingId: s.subjectOfferingId, subjectCode: s.subjectCode, subjectName: s.subjectName, status: 'ACTIVE' })) }],
      },
      [`GET ${API}/academic-programmes`]: { data: [] },
      [`GET ${API}/classes`]: { data: [] },
      [`POST ${API}/student-enrollments/${ENROLLMENT_ID}/subjects/validate-selection`]: ({ body }) => {
        const ids = (body as { subjectOfferingIds: string[] }).subjectOfferingIds;
        const languages = ids.filter((i) => i === 'hin' || i === 'pun').length;
        return {
          data: {
            valid: languages === 1,
            problems: languages === 1 ? [] : [{ code: 'GROUP_TOO_MANY', message: `Pick 1 language. You picked ${languages}.` }],
            groups: [group(languages === 1, languages)],
            mandatoryOfferingIds: ['m0', 'm1'],
            selectedOfferingIds: ids,
          },
        };
      },
    });
    renderWithApp(
      <Ready>
        <SubjectsDrawer student={studentProfile()} onClose={() => {}} />
      </Ready>,
    );
    const user = userEvent.setup();
    const drawer = await screen.findByRole('dialog', { name: /change subjects/i });
    expect(await within(drawer).findByText(/follows the class rules/i)).toBeInTheDocument();
    const save = within(drawer).getByRole('button', { name: /save subjects/i });
    expect(save).toBeEnabled();

    // A second language is one too many.
    await user.click(await within(drawer).findByRole('checkbox', { name: 'Punjabi' }));
    expect(await within(drawer).findByText('Pick 1 language. You picked 2.')).toBeInTheDocument();
    expect(within(drawer).getByRole('alert')).toHaveTextContent(/fix this before saving/i);
    expect(save).toBeDisabled();
    expect(api.callsTo('/subjects', 'POST').filter((c) => !c.path.includes('validate'))).toHaveLength(0);

    await user.click(within(drawer).getByRole('checkbox', { name: 'Hindi' }));
    await waitFor(() => expect(save).toBeEnabled());
  });
});

// ───────────────────────────────────────────────────────────── list, profile, access

describe('Student list and profile (Module 4, Part 2)', () => {
  it('shows the empty state with "Add Your First Student" when there are no students', async () => {
    mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`GET ${API}/students`]: { data: { items: [], page: 1, pageSize: 20, total: 0 } },
      [`GET ${API}/students/attention`]: { data: { counts: { activeStudents: 0, newThisYear: 0, needsAttention: 0 }, groups: [] } },
    });
    renderWithApp(
      <Ready>
        <StudentContextProvider>
          <StudentsPage />
        </StudentContextProvider>
      </Ready>,
      { route: '/students' },
    );
    expect(await screen.findByText(/no students yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /add your first student/i })).toBeInTheDocument();
  });

  it('lists a student with class, section, roll and parent, and puts "need attention" before the big numbers', async () => {
    mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`GET ${API}/students`]: { data: { items: [directoryRow()], page: 1, pageSize: 20, total: 1 } },
      [`GET ${API}/students/attention`]: { data: { counts: { activeStudents: 38, newThisYear: 6, needsAttention: 4 }, groups: [] } },
    });
    renderWithApp(
      <Ready>
        <StudentContextProvider>
          <StudentsPage />
        </StudentContextProvider>
      </Ready>,
      { route: '/students' },
    );
    const link = await screen.findAllByRole('link', { name: 'Riya Sharma' });
    expect(link[0]).toHaveAttribute('href', `/students/${STUDENT_ID}`);
    expect(screen.getAllByText(/viii-a · roll 17/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Priya Sharma').length).toBeGreaterThan(0);

    const strip = await screen.findByLabelText('Student summary');
    const items = within(strip).getAllByText(/attention|active students|new this year/i);
    expect(items[0]).toHaveTextContent(/need attention/i);
    expect(within(strip).getByRole('link')).toHaveAttribute('href', '/students/attention');
  });

  it('the profile says what is still to do, with a Fix button; a missing section also turns Roll Number off with its reason', async () => {
    const noSection = studentProfile({
      classSection: { ...studentProfile().classSection!, sectionId: null, sectionCode: null, label: 'VIII' },
      rollNumber: null,
      enrollment: enrollmentDto({ section: null }),
      missing: [{ item: 'SECTION', message: 'No section yet.' }],
    });
    mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`GET ${API}/students/${STUDENT_ID}`]: { data: noSection },
      [`GET ${API}/students/${STUDENT_ID}/enrollments`]: { data: [noSection.enrollment] },
      [`GET ${API}/student-enrollments/${ENROLLMENT_ID}/subjects`]: { data: { enrollmentId: ENROLLMENT_ID, subjects: [], selection: { valid: true, problems: [], groups: [], mandatoryOfferingIds: [], selectedOfferingIds: [] }, choicePending: false } },
    });
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/students/:studentId" element={<StudentPage />} />
        </Routes>
      </Ready>,
      { route: `/students/${STUDENT_ID}?tab=academic` },
    );
    expect(await screen.findByRole('heading', { name: 'Riya Sharma' })).toBeInTheDocument();
    expect(await screen.findByText(/add a section first/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /roll number/i })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: /choose section/i }).length).toBeGreaterThan(0);
  });

  it('the Parents tab shows the primary badge, the emergency badge and the contact', async () => {
    mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`GET ${API}/students/${STUDENT_ID}`]: { data: studentProfile() },
      [`GET ${API}/students/${STUDENT_ID}/guardians`]: {
        data: [guardianLink(), guardianLink({ guardianLinkId: 'link-2', guardianPersonId: 'person-gm', fullName: 'Sunita Sharma', relationshipType: 'Grandmother', isPrimary: false, isEmergencyContact: true, canSeeAcademics: false, canSeeFees: false, phone: '+910000000009', email: null })],
      },
    });
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/students/:studentId" element={<StudentPage />} />
        </Routes>
      </Ready>,
      { route: `/students/${STUDENT_ID}?tab=guardians` },
    );
    const list = await screen.findByRole('list', { name: /parents and guardians/i });
    const mother = within(list).getByText('Priya Sharma').closest('li')!;
    expect(within(mother).getByText('Primary')).toBeInTheDocument();
    expect(within(mother).getByRole('button', { name: /unlink priya sharma/i })).toBeInTheDocument();
    const gran = within(list).getByText('Sunita Sharma').closest('li')!;
    expect(within(gran).getByText('Emergency contact')).toBeInTheDocument();
    expect(within(gran).queryByText('Primary')).not.toBeInTheDocument();
    expect(within(gran).getByRole('button', { name: /make primary/i })).toBeInTheDocument();
  });

  it('the History tab reads as one timeline', async () => {
    mockApi('SCHOOL_ADMIN', {
      ...schoolHandlers(),
      [`GET ${API}/students/${STUDENT_ID}`]: { data: studentProfile() },
      [`GET ${API}/students/${STUDENT_ID}/history`]: {
        data: {
          entries: [
            { entryId: 'h2', kind: 'SECTION', occurredOn: '2026-09-01', recordedAt: '2026-09-01T09:00:00.000Z', title: 'Moved from VIII-A to VIII-B', detail: 'Parent request', actorName: 'Asha Admin' },
            { entryId: 'h1', kind: 'ENROLLMENT', occurredOn: '2026-04-01', recordedAt: '2026-04-01T09:00:00.000Z', title: 'Enrolled in Class VIII', detail: null, actorName: 'Asha Admin' },
          ],
        },
      },
    });
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/students/:studentId" element={<StudentPage />} />
        </Routes>
      </Ready>,
      { route: `/students/${STUDENT_ID}?tab=history` },
    );
    const timeline = await screen.findByRole('list', { name: /^history$/i });
    expect(within(timeline).getAllByRole('listitem').map((li) => li.textContent)).toEqual([expect.stringContaining('Moved from VIII-A to VIII-B'), expect.stringContaining('Enrolled in Class VIII')]);
  });
});

describe('Faculty access (Module 4, Part 2)', () => {
  const facultyStudent = {
    studentId: STUDENT_ID,
    admissionNumber: 'GPS/2026/00001',
    fullName: 'Riya Sharma',
    displayName: 'Riya Sharma',
    hasPhoto: false,
    classSection: directoryRow().classSection,
    rollNumber: '17',
    subjects: [{ subjectOfferingId: 'm1', subjectName: 'Maths' }],
  };

  it('a teacher sees the short summary and none of the admin buttons or personal details', async () => {
    mockApi('FACULTY', { [`GET ${API}/students/${STUDENT_ID}`]: { data: facultyStudent } });
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/students/:studentId" element={<StudentPage />} />
        </Routes>
      </Ready>,
      { route: `/students/${STUDENT_ID}` },
    );
    expect(await screen.findByRole('heading', { name: 'Riya Sharma' })).toBeInTheDocument();
    expect(screen.getByText('Maths')).toBeInTheDocument();
    for (const name of [/change section/i, /add guardian/i, /change subjects/i, /edit details/i]) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    expect(screen.queryByText(/date of birth|address|phone/i)).not.toBeInTheDocument();
  });

  it('a student outside the teacher’s sections shows "Not found"', async () => {
    mockApi('FACULTY', { [`GET ${API}/students/${STUDENT_ID}`]: { status: 404, error: { code: 'NOT_FOUND', message: 'Student not found.' } } });
    renderWithApp(
      <Ready>
        <Routes>
          <Route path="/students/:studentId" element={<StudentPage />} />
        </Routes>
      </Ready>,
      { route: `/students/${STUDENT_ID}` },
    );
    expect(await screen.findByText('Not found')).toBeInTheDocument();
  });

  it('the student list is an admin page: a teacher is shown no such page, and My Students lists only the summary fields', async () => {
    mockApi('FACULTY', { [`GET ${API}/students`]: { data: { items: [facultyStudent], page: 1, pageSize: 24, total: 1 } } });
    const { unmount } = renderWithApp(
      <Ready>
        <Routes>
          <Route path="/students" element={<RequireStudentAdmin />}>
            <Route index element={<div>ADMIN LIST</div>} />
          </Route>
        </Routes>
      </Ready>,
      { route: '/students' },
    );
    expect(await screen.findByText(/lost in the schoolverse/i)).toBeInTheDocument();
    expect(screen.queryByText('ADMIN LIST')).not.toBeInTheDocument();
    unmount();

    renderWithApp(
      <Ready>
        <MyStudentsPage />
      </Ready>,
    );
    expect(await screen.findByText('Riya Sharma')).toBeInTheDocument();
    expect(screen.getByText('Maths')).toBeInTheDocument();
    expect(screen.getByText(/viii-a · roll 17/i)).toBeInTheDocument();
  });
});

describe('Needs Attention (Module 4, Part 2)', () => {
  it('groups what is unfinished and each row\'s Fix button goes to the right place', async () => {
    const data: StudentAttentionDTO = {
      counts: { activeStudents: 3, newThisYear: 1, needsAttention: 3 },
      groups: [
        { key: 'SETUP', title: 'Student setup', items: [{ key: 'a:SECTION', studentId: 'stu-a', personId: null, fullName: 'Neha Gill', admissionNumber: 'GPS/2026/00003', classSection: directoryRow().classSection, message: 'No section yet.', fix: 'ADD_SECTION' }] },
        { key: 'FAMILY', title: 'Family', items: [{ key: 'b:GUARDIAN', studentId: 'stu-b', personId: null, fullName: 'Draftie Learner', admissionNumber: null, classSection: null, message: 'No parent or guardian is linked.', fix: 'ADD_GUARDIAN' }, { key: 'parent:p1', studentId: null, personId: 'p1', fullName: 'Asha One', admissionNumber: null, classSection: null, message: 'Has the same phone number as Asha Two. They may be the same parent.', fix: 'OPEN_FAMILY' }] },
        { key: 'SUBJECTS', title: 'Subjects', items: [] },
      ],
    };
    mockApi('SCHOOL_ADMIN', { ...schoolHandlers(), [`GET ${API}/students/attention`]: { data } });
    renderWithApp(
      <Ready>
        <StudentContextProvider>
          <AttentionPage />
        </StudentContextProvider>
      </Ready>,
      { route: '/students/attention' },
    );
    expect(await screen.findByRole('link', { name: 'Choose Section' })).toHaveAttribute('href', '/students/stu-a?fix=ADD_SECTION');
    expect(screen.getByRole('link', { name: 'Add Parent' })).toHaveAttribute('href', '/students/stu-b?fix=ADD_GUARDIAN');
    expect(screen.getByRole('link', { name: 'Open Family' })).toHaveAttribute('href', '/families/p1');
    const subjects = screen.getByLabelText('Subjects');
    expect(within(subjects).getByText(/nothing to fix here/i)).toBeInTheDocument();
  });

  it('says everything is in order when nothing needs attention', async () => {
    mockApi('SCHOOL_ADMIN', { ...schoolHandlers(), [`GET ${API}/students/attention`]: { data: { counts: { activeStudents: 5, newThisYear: 0, needsAttention: 0 }, groups: [] } } });
    renderWithApp(
      <Ready>
        <StudentContextProvider>
          <AttentionPage />
        </StudentContextProvider>
      </Ready>,
    );
    expect(await screen.findByText(/everything is in order/i)).toBeInTheDocument();
  });
});
