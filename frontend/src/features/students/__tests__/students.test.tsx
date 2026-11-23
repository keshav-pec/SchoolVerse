import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import type { StudentAttentionDTO, StudentSubjectsDTO, AcademicSessionDTO, ImportDTO, MasterLocationDTO, ParentAccessDTO, PromotionReadinessDTO, PromotionRowDTO, TransferCertificateDTO } from '@shared';
import { RequireStudentAdmin } from '@/routes/guards';
import { academicSession, CLASS_OFFERING_ID, classOffering, directoryRow, ENROLLMENT_ID, enrollmentDto, guardianLink, LOCATION_ID, masterLocation, SECTION_A_ID, SECTION_B_ID, SESSION_ID, STUDENT_ID, studentProfile } from '@/test/fixtures';
import { API, Ready, mockApi, pickOption, renderWithApp, type MockResponse, type Handler } from '@/test/utils';
import { AddStudentDrawer } from '../add-student-drawer';
import { AttentionPage } from '../attention-page';
import { StudentContextProvider } from '../context';
import { MyStudentsPage } from '../my-students-page';
import { ChangeSectionDialog } from '../section-dialogs';
import { StudentPage } from '../student-page';
import { StudentsPage } from '../students-page';
import { SubjectsDrawer } from '../subjects-drawer';
import type { ReactNode } from 'react';
import { MoveCampusDrawer } from '../exit-dialogs';
import { ImportPage } from '../import-page';
import { PromotionPage } from '../promotion-page';
import { AccessTab } from '../tabs/access-tab';
import { DocumentsTab } from '../tabs/documents-tab';
import { ExitTab } from '../tabs/exit-tab';

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
      [`GET ${API}/students/attention`]: { data: { counts: { activeStudents: 0, newThisYear: 0, needsAttention: 0, followUp: 0, portalActivationPercent: null, withdrawalsThisYear: 0 }, groups: [] } },
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
      [`GET ${API}/students/attention`]: { data: { counts: { activeStudents: 38, newThisYear: 6, needsAttention: 4, followUp: 0, portalActivationPercent: null, withdrawalsThisYear: 0 }, groups: [] } },
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
    expect(within(strip).getAllByRole('link')[0]).toHaveAttribute('href', '/students/attention');
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
      counts: { activeStudents: 3, newThisYear: 1, needsAttention: 3, followUp: 0, portalActivationPercent: null, withdrawalsThisYear: 0 },
      groups: [
        { key: 'SETUP', title: 'Student setup', followUp: false, items: [{ key: 'a:SECTION', studentId: 'stu-a', personId: null, fullName: 'Neha Gill', admissionNumber: 'GPS/2026/00003', classSection: directoryRow().classSection, message: 'No section yet.', fix: 'ADD_SECTION' }] },
        { key: 'FAMILY', title: 'Family', followUp: false, items: [{ key: 'b:GUARDIAN', studentId: 'stu-b', personId: null, fullName: 'Draftie Learner', admissionNumber: null, classSection: null, message: 'No parent or guardian is linked.', fix: 'ADD_GUARDIAN' }, { key: 'parent:p1', studentId: null, personId: 'p1', fullName: 'Asha One', admissionNumber: null, classSection: null, message: 'Has the same phone number as Asha Two. They may be the same parent.', fix: 'OPEN_FAMILY' }] },
        { key: 'SUBJECTS', title: 'Subjects', followUp: false, items: [] },
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
    // Empty groups collapse into one "all clear" line instead of a card each.
    expect(screen.getByTestId('all-clear')).toHaveTextContent(/nothing to fix in: subjects/i);
  });

  it('says everything is in order when nothing needs attention', async () => {
    mockApi('SCHOOL_ADMIN', { ...schoolHandlers(), [`GET ${API}/students/attention`]: { data: { counts: { activeStudents: 5, newThisYear: 0, needsAttention: 0, followUp: 0, portalActivationPercent: null, withdrawalsThisYear: 0 }, groups: [] } } });
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

const NEXT_ID = '99999999-9999-4999-8999-999999999999';
const CHD_ID = '33333333-3333-4333-8333-333333333333';

const nextSession: AcademicSessionDTO = { ...academicSession, academicSessionId: NEXT_ID, name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', status: 'PUBLISHED', isCurrent: false };
const chandigarh: MasterLocationDTO = { ...masterLocation, locationId: CHD_ID, locationCode: 'CHD', displayName: 'Chandigarh Campus', isPrimary: false, city: 'Chandigarh' };

function school(extra: Record<string, MockResponse | Handler> = {}) {
  return {
    [`GET ${API}/academic-sessions`]: { data: [academicSession, nextSession] },
    [`GET ${API}/master/locations`]: { data: [masterLocation, chandigarh] },
    ...extra,
  };
}

function inContext(ui: ReactNode, route = '/') {
  return renderWithApp(
    <Ready>
      <StudentContextProvider>{ui}</StudentContextProvider>
    </Ready>,
    { route },
  );
}

// ───────────────────────────────────────────────────────────── promotion

const row = (overrides: Partial<PromotionRowDTO>): PromotionRowDTO => ({
  studentId: 's1',
  enrollmentId: 'e1',
  fullName: 'Riya Sharma',
  admissionNumber: 'GPS/2026/00001',
  fromClass: 'Class VIII',
  fromSection: 'A',
  nextClassOfferingId: 'next-ix',
  nextClassName: 'Class IX',
  suggestedSectionId: 'ix-a',
  suggestedSectionLabel: 'IX-A',
  isFinalClass: false,
  suggestedDecision: 'PROMOTE',
  reasons: [],
  ...overrides,
});

const readiness: PromotionReadinessDTO = {
  fromSessionId: SESSION_ID,
  toSessionId: NEXT_ID,
  locationId: LOCATION_ID,
  checked: 3,
  ready: 1,
  needsReview: 2,
  readyRows: [row({})],
  reviewRows: [
    row({ studentId: 's2', fullName: 'Kabir Gill', fromClass: 'Class IX', nextClassOfferingId: null, nextClassName: null, suggestedDecision: null, reasons: [{ code: 'NO_NEXT_CLASS', message: 'No class is offered for next year.' }] }),
    row({ studentId: 's3', fullName: 'Zoya Khan', suggestedDecision: null, reasons: [{ code: 'LEAVING', message: 'This student is leaving the school.' }] }),
  ],
};

describe('Promotion workspace (Module 4, Part 4)', () => {
  it('shows ready and needs-a-look counts, lists the exceptions first with reasons, and confirms before promoting the ready group', async () => {
    const api = mockApi('SCHOOL_ADMIN', school({ [`GET ${API}/promotions/readiness`]: { data: readiness }, [`POST ${API}/promotions/bulk`]: { data: { done: 1, skipped: 0, failed: 0, rows: [{ studentId: 's1', fullName: 'Riya Sharma', decision: 'PROMOTE', status: 'DONE', message: null, toEnrollmentId: 'x' }] } } }));
    inContext(<PromotionPage />);
    const summary = await screen.findByTestId('promotion-summary');
    expect(summary).toHaveTextContent('3 students checked. 1 ready. 2 need a look.');
    const review = screen.getByLabelText('Needs a look');
    expect(within(review).getByText(/no class is offered for next year/i, { selector: 'h3' })).toBeInTheDocument();
    expect(within(review).getByText('Kabir Gill')).toBeInTheDocument();
    // Ready students are collapsed until asked for.
    expect(screen.queryByText('Class IX · IX-A')).not.toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /promote all ready students/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/promote 1 ready students\?/i);
    expect(dialog).toHaveTextContent(/2 students who need a look are not touched/i);
    await user.click(within(dialog).getByRole('button', { name: 'Promote Students' }));
    expect(await screen.findByText(/1 done · 0 skipped · 0 failed/)).toBeInTheDocument();
    expect(api.callsTo('/promotions/bulk', 'POST')[0]!.body).toMatchObject({ fromSessionId: SESSION_ID, toSessionId: NEXT_ID, locationId: LOCATION_ID, readyOnly: true });
  });

  it('a failed row in the result says why, and a decision for a reviewed student is sent as a decision', async () => {
    const api = mockApi('SCHOOL_ADMIN', school({
      [`GET ${API}/promotions/readiness`]: { data: readiness },
      [`POST ${API}/promotions/bulk`]: { data: { done: 0, skipped: 0, failed: 1, rows: [{ studentId: 's3', fullName: 'Zoya Khan', decision: 'REPEAT', status: 'FAILED', message: 'Class VIII is not offered next year.', toEnrollmentId: null }] } },
    }));
    inContext(<PromotionPage />);
    const user = userEvent.setup();
    await pickOption(user, await screen.findByLabelText('What happens to Zoya Khan'), 'Repeat the class');
    await user.click(screen.getByRole('button', { name: /save 1 decision/i }));
    const result = await screen.findByLabelText('Promotion result');
    expect(within(result).getByText('Zoya Khan')).toBeInTheDocument();
    expect(within(result).getByText('Class VIII is not offered next year.')).toBeInTheDocument();
    expect(api.callsTo('/promotions/bulk', 'POST')[0]!.body).toMatchObject({ decisions: [{ studentId: 's3', decision: 'REPEAT' }] });
  });
});

// ───────────────────────────────────────────────────────────── import

const summary = { total: 1000, ready: 965, needsAttention: 35, imported: 0, skipped: 0, message: '1,000 rows: 965 ready, 35 need attention' };
const importDto = (overrides: Partial<ImportDTO>): ImportDTO => ({
  importId: 'imp1',
  fileName: 'students.csv',
  mode: 'EXISTING_STUDENTS',
  status: 'UPLOADED',
  academicSessionId: SESSION_ID,
  locationId: LOCATION_ID,
  headers: ['Student Name', 'Class', 'Section', 'Mobile'],
  mapping: { studentName: 'Student Name', className: 'Class', sectionName: 'Section' },
  missingRequired: [],
  summary: { ...summary, ready: 0, needsAttention: 1000, message: '1,000 rows: 0 ready, 1,000 need attention' },
  createdAt: '2026-11-20T10:00:00.000Z',
  ...overrides,
});

describe('Import review (Module 4, Part 4)', () => {
  it('shows the columns matched by themselves, asks only about the rest, then shows ready vs attention and the problems grouped by kind', async () => {
    let status: ImportDTO['status'] = 'UPLOADED';
    const api = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/students/imports/imp1`]: () => ({ data: importDto(status === 'UPLOADED' ? {} : { status, summary }) }),
      [`POST ${API}/students/imports/imp1/map`]: { data: importDto({ status: 'MAPPED' }) },
      [`POST ${API}/students/imports/imp1/validate`]: () => {
        status = 'VALIDATED';
        return { data: importDto({ status, summary }) };
      },
      [`GET ${API}/students/imports/imp1/issues`]: {
        data: {
          summary,
          groups: [
            { code: 'DUPLICATE_ADMISSION_NUMBER_IN_FILE', level: 'ERROR', title: 'Same admission number twice in the file', suggestedFix: 'Give each student their own number.', count: 20, rowNumbers: [4, 9] },
            { code: 'PARENT_FOUND', level: 'INFO', title: 'Parent already in the school', suggestedFix: 'Nothing to do. The parent is reused.', count: 12, rowNumbers: [3] },
          ],
        },
      },
      [`GET ${API}/students/imports/imp1/rows`]: { data: { items: [], page: 1, pageSize: 25, total: 0 } },
    });
    renderWithApp(
      <Routes>
        <Route path="/students/imports/:importId" element={<ImportPage />} />
      </Routes>,
      { route: '/students/imports/imp1' },
    );
    expect(await screen.findByText(/we matched 3 of 13 columns by ourselves/i)).toBeInTheDocument();
    // Only the unmatched columns get a picker.
    expect(screen.queryByLabelText('File column for Student name')).not.toBeInTheDocument();
    const user = userEvent.setup();
    await pickOption(user, screen.getByLabelText('File column for Parent phone'), 'Mobile');
    await user.click(screen.getByRole('button', { name: /check the file/i }));

    expect(await screen.findByTestId('import-summary')).toHaveTextContent('1,000 rows: 965 ready, 35 need attention');
    const groups = await screen.findAllByTestId('issue-group');
    expect(groups[0]).toHaveTextContent(/must fix.*same admission number twice in the file.*20 rows/i);
    expect(groups[1]).toHaveTextContent(/good to know.*parent already in the school/i);
    expect(screen.getByRole('link', { name: /download error report/i })).toHaveAttribute('href', '/api/v1/students/imports/imp1/issues.csv');
    expect(api.callsTo('/map', 'POST')[0]!.body).toMatchObject({ mapping: { studentName: 'Student Name', guardianPhone: 'Mobile' } });
    expect(screen.getByRole('button', { name: /import ready rows/i })).toBeEnabled();
  });
});

// ───────────────────────────────────────────────────────────── parent access

const access = (overrides: Partial<ParentAccessDTO>): ParentAccessDTO => ({
  guardianLinkId: 'l1',
  studentId: STUDENT_ID,
  guardianPersonId: 'p1',
  fullName: 'Priya Sharma',
  relationshipType: 'Mother',
  isPrimary: true,
  canSeeAcademics: true,
  canSeeFees: false,
  linkActive: true,
  portalEnabled: false,
  portalState: 'NOT_INVITED',
  hasEmail: true,
  hasLogin: false,
  accountStatus: null,
  reusedAccount: false,
  invitationSent: false,
  ...overrides,
});

describe('Parent Access tab (Module 4, Part 4)', () => {
  it('says when the parent already has a login, and Remove Access explains it is for this child only', async () => {
    const api = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/students/${STUDENT_ID}/parent-access`]: { data: [access({ hasLogin: true, accountStatus: 'ACTIVE' }), access({ guardianLinkId: 'l2', fullName: 'Rahul Sharma', relationshipType: 'Father', isPrimary: false, portalEnabled: true, portalState: 'ACTIVE', hasLogin: true, accountStatus: 'ACTIVE' })] },
      [`POST ${API}/guardian-links/l2/revoke-portal`]: { data: access({ guardianLinkId: 'l2', portalState: 'REVOKED' }) },
    });
    renderWithApp(
      <Ready>
        <AccessTab student={studentProfile()} readOnly={false} />
      </Ready>,
    );
    expect(await screen.findByTestId('has-login')).toHaveTextContent('Priya already has a login. We’ll use it.');
    expect(screen.getByRole('button', { name: 'Invite Priya Sharma' })).toBeEnabled();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Remove Rahul Sharma’s access' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent(/this child only/i);
    expect(dialog).toHaveTextContent(/keeps their login and their other children/i);
    await user.click(within(dialog).getByRole('button', { name: 'Remove Access' }));
    await waitFor(() => expect(api.callsTo('/guardian-links/l2/revoke-portal', 'POST')).toHaveLength(1));
  });

  it('a parent with no email cannot be invited, and the tab says what to add', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/students/${STUDENT_ID}/parent-access`]: { data: [access({ hasEmail: false })] } });
    renderWithApp(
      <Ready>
        <AccessTab student={studentProfile()} readOnly={false} />
      </Ready>,
    );
    expect(await screen.findByText(/add an email for priya/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Invite Priya Sharma' })).toBeDisabled();
  });
});

// ───────────────────────────────────────────────────────────── transfer certificate and campus move

const tc = (overrides: Partial<TransferCertificateDTO>): TransferCertificateDTO => ({
  certificateId: 'tc1',
  studentId: STUDENT_ID,
  certificateNumber: null,
  status: 'APPROVED',
  copyType: 'ORIGINAL',
  applicationDate: '2026-11-01',
  issueDate: null,
  leavingDate: '2027-03-31',
  reasonForLeaving: 'Family is moving',
  lastClass: 'Class VIII',
  result: null,
  duesStatus: 'CLEARED',
  documentId: null,
  originalCertificateId: null,
  duplicateReason: null,
  locked: false,
  createdAt: '2026-11-01T10:00:00.000Z',
  ...overrides,
});

describe('Transfers & Exit tab (Module 4, Part 4)', () => {
  it('the Transfer Certificate panel shows its steps, and locks after Issue (only a duplicate is offered)', async () => {
    let issued = false;
    mockApi('SCHOOL_ADMIN', school({
      [`GET ${API}/students/${STUDENT_ID}/transfers`]: { data: { items: [] } },
      [`GET ${API}/students/${STUDENT_ID}/transfer-certificates`]: () => ({ data: [issued ? tc({ status: 'ISSUED', certificateNumber: 'TC/2026-27/0001', issueDate: '2026-11-21', locked: true, documentId: 'doc1' }) : tc({})] }),
      [`POST ${API}/transfer-certificates/tc1/issue`]: () => {
        issued = true;
        return { data: tc({ status: 'ISSUED', certificateNumber: 'TC/2026-27/0001', locked: true }) };
      },
    }));
    inContext(<ExitTab student={studentProfile()} readOnly={false} />);
    const card = await screen.findByTestId('tc-card');
    expect(within(card).getByRole('list', { name: 'Certificate steps' })).toHaveTextContent(/requested.*waiting for dues.*approved.*issued/i);
    const user = userEvent.setup();
    await user.click(within(card).getByRole('button', { name: /issue certificate/i }));

    expect(await screen.findByTestId('tc-locked')).toHaveTextContent(/can’t be changed/i);
    const locked = screen.getByTestId('tc-card');
    expect(within(locked).getByText('TC/2026-27/0001')).toBeInTheDocument();
    expect(within(locked).queryByRole('button', { name: /approve/i })).not.toBeInTheDocument();
    expect(within(locked).queryByRole('checkbox', { name: /dues cleared/i })).not.toBeInTheDocument();
    expect(within(locked).getByRole('button', { name: /issue duplicate/i })).toBeInTheDocument();
    expect(within(locked).getByRole('button', { name: /download pdf/i })).toBeInTheDocument();
  });

  it('a move to a campus on another board shows the board change and asks for the subjects again', async () => {
    const chdClass = { ...classOffering, classOfferingId: 'chd-viii', locationId: CHD_ID };
    const api = mockApi('SCHOOL_ADMIN', school({
      [`GET ${API}/academic-sessions/${SESSION_ID}/class-offerings`]: ({ url }) => ({ data: url.searchParams.get('locationId') === CHD_ID ? [chdClass] : [classOffering] }),
      [`GET ${API}/class-offerings/chd-viii/sections`]: { data: [] },
      [`POST ${API}/students/${STUDENT_ID}/location-transfer/validate`]: {
        data: {
          canTransfer: true,
          problems: [],
          warnings: [],
          from: { locationId: LOCATION_ID, locationName: 'Mohali Campus', className: 'Class VIII', sectionLabel: 'A', boardName: 'CBSE' },
          to: { locationId: CHD_ID, locationName: 'Chandigarh Campus', className: 'Class VIII', sectionLabel: null, boardName: 'ICSE' },
          boardChanged: true,
          subjectMappingRequired: true,
          destinationSubjects: [
            { subjectOfferingId: 'eng', subjectName: 'English', offeringType: 'MANDATORY', isMandatory: true, carriedOver: false },
            { subjectOfferingId: 'fr', subjectName: 'French', offeringType: 'LANGUAGE', isMandatory: false, carriedOver: false },
          ],
          selection: null,
        },
      },
      [`POST ${API}/students/${STUDENT_ID}/location-transfer`]: { data: { event: {}, fromEnrollmentId: 'a', toEnrollmentId: 'b', mandatorySubjectsAdded: 1, carriedSubjects: 0, choicePending: false, warnings: [] } },
    }));
    const onClose = vi.fn();
    inContext(<MoveCampusDrawer student={studentProfile({ enrollment: { ...studentProfile().enrollment!, classOfferingId: CLASS_OFFERING_ID } })} onClose={onClose} />);
    const user = userEvent.setup();
    await pickOption(user, await screen.findByLabelText(/^new campus/i), /chandigarh campus/i);
    await pickOption(user, screen.getByLabelText(/^class at the new campus/i), /class viii/i);
    await user.click(screen.getByRole('button', { name: /check the move/i }));

    expect(await screen.findByText(/different board/i)).toBeInTheDocument();
    expect(screen.getByText(/CBSE → ICSE/)).toBeInTheDocument();
    const subjects = screen.getByRole('group', { name: /subjects at the new campus/i });
    expect(within(subjects).getByRole('checkbox', { name: /english/i })).toBeChecked();
    expect(within(subjects).getByRole('checkbox', { name: /english/i })).toBeDisabled();
    await user.click(within(subjects).getByRole('checkbox', { name: /french/i }));
    await user.type(screen.getByLabelText(/^reason/i), 'Family moved');
    await user.click(screen.getByRole('button', { name: /move student/i }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(api.callsTo('/location-transfer', 'POST').at(-1)!.body).toMatchObject({ toLocationId: CHD_ID, classOfferingId: 'chd-viii', reason: 'Family moved', subjectOfferingIds: expect.arrayContaining(['eng', 'fr']) });
  });
});

// ───────────────────────────────────────────────────────────── documents

describe('Documents tab (Module 4, Part 4)', () => {
  it('shows the completeness line with an Upload button for the first missing paper, and opens the upload form while there are no files', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/students/${STUDENT_ID}/documents`]: {
        data: {
          items: [],
          completeness: { total: 4, done: 0, missing: [{ documentType: 'BIRTH_CERTIFICATE', label: 'Birth certificate' }, { documentType: 'PHOTO', label: 'Photo' }], message: '0 of 4 done. Missing: Birth certificate, Previous school record, ID proof, Photo' },
        },
      },
    });
    renderWithApp(
      <Ready>
        <DocumentsTab student={studentProfile()} readOnly={false} />
      </Ready>,
    );
    expect(await screen.findByTestId('documents-completeness')).toHaveTextContent('0 of 4 done. Missing: Birth certificate');
    expect(screen.getByRole('button', { name: /upload birth certificate/i })).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /upload a document/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/^type/i)).toHaveTextContent('Birth certificate');
  });
});
