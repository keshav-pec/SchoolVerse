import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Route, Routes } from 'react-router';
import type { ReactNode } from 'react';
import type { AcademicSessionDTO, ImportDTO, MasterLocationDTO, ParentAccessDTO, PromotionReadinessDTO, PromotionRowDTO, TransferCertificateDTO } from '@shared';
import { useAuth } from '@/lib/auth';
import { academicSession, CLASS_OFFERING_ID, classOffering, LOCATION_ID, masterLocation, SESSION_ID, STUDENT_ID, studentProfile } from '@/test/fixtures';
import { mockApi, pickOption, renderWithApp, type Handler, type MockResponse } from '@/test/utils';
import { StudentContextProvider } from '../context';
import { MoveCampusDrawer } from '../exit-dialogs';
import { ImportPage } from '../import-page';
import { PromotionPage } from '../promotion-page';
import { AccessTab } from '../tabs/access-tab';
import { DocumentsTab } from '../tabs/documents-tab';
import { ExitTab } from '../tabs/exit-tab';

afterEach(() => vi.unstubAllGlobals());

const API = '/api/v1';
const NEXT_ID = '99999999-9999-4999-8999-999999999999';
const CHD_ID = '33333333-3333-4333-8333-333333333333';

function Ready({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  return session ? <>{children}</> : null;
}

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
