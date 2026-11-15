import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AcademicSessionDTO, GradeOfferingDTO, ValidationResultDTO } from '@shared';
import { mockApi, renderWithApp } from '@/test/utils';
import { AcademicStructurePage } from '../academic-structure-page';
import { LifecycleButtons } from '../lifecycle-buttons';
import { SubjectsPage } from '../subjects-page';
import { GradesTab } from '../tabs/grades-tab';
import { OverviewTab } from '../tabs/overview-tab';

afterEach(() => vi.unstubAllGlobals());

const API = '/api/v1';
const SID = '55555555-5555-4555-8555-555555555555';
const LOC = '22222222-2222-4222-8222-222222222222';
const GO = '66666666-6666-4666-8666-666666666666';

function session(overrides: Partial<AcademicSessionDTO> = {}): AcademicSessionDTO {
  return {
    academicSessionId: SID,
    schoolId: 's1',
    name: 'Academic Year 2026-27',
    code: '2026-27',
    startDate: '2026-04-01',
    endDate: '2027-03-31',
    status: 'DRAFT',
    isCurrent: false,
    locations: [{ locationId: LOC, locationCode: 'MOH', locationName: 'Mohali Campus', boardId: 'b1', boardCode: 'CBSE', boardName: 'CBSE', boardRuleVersionId: 'v1', ruleVersionName: '2026-27', affiliationNumber: null }],
    previousSessionId: null,
    warnings: [],
    deletable: true,
    lastValidation: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

const grade: GradeOfferingDTO = {
  gradeOfferingId: GO,
  academicSessionId: SID,
  locationId: LOC,
  gradeId: 'g8',
  canonicalCode: 'G08',
  displayName: 'Class VIII',
  displayCode: 'VIII',
  medium: null,
  capacity: null,
  sequenceOrder: 10,
  status: 'ACTIVE',
  sectionCount: 1,
  subjectCount: 3,
};

describe('validation panel', () => {
  it('lists errors, warnings and suggestions with links, and disables Publish while errors exist', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/academic-sessions/${SID}/overview`]: { data: { academicSessionId: SID, status: 'DRAFT', counts: {}, boards: [], checklist: [{ key: 'grades', label: 'Grades', status: 'pending', detail: 'Add grades' }], lastValidation: null } },
    });
    const result: ValidationResultDTO = {
      academicSessionId: SID,
      validatedAt: '2026-11-15T00:00:00.000Z',
      summary: { errors: 1, warnings: 1, info: 1 },
      canPublish: false,
      issues: [
        { level: 'ERROR', code: 'GRADE_WITHOUT_SECTIONS', message: 'Class VIII at Mohali Campus has no sections.', entityType: 'grade_offering', entityId: GO },
        { level: 'WARNING', code: 'GRADE_WITHOUT_TERMS', message: 'Class VIII at Mohali Campus has no terms.', entityType: 'grade_offering', entityId: GO },
        { level: 'INFO', code: 'NO_TERMS', message: 'No terms are set up yet.', entityType: 'academic_session', entityId: SID },
      ],
    };
    const goTo = vi.fn();
    renderWithApp(<OverviewTab session={session()} readOnly={false} validation={result} onValidated={vi.fn()} onGoTo={goTo} />);

    const errors = await screen.findByRole('region', { name: 'Errors' });
    expect(within(errors).getByText('Class VIII at Mohali Campus has no sections.')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Warnings' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Suggestions' })).toBeInTheDocument();

    expect(await screen.findByRole('button', { name: /^publish$/i })).toBeDisabled();
    expect(screen.getByText(/fix 1 validation error to publish/i)).toBeInTheDocument();

    await userEvent.click(within(errors).getByRole('button', { name: /go to grades & sections/i }));
    expect(goTo).toHaveBeenCalledWith('grades');
  });

  it('enables Publish once validation has no errors', async () => {
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/academic-sessions/${SID}/overview`]: { data: { academicSessionId: SID, status: 'DRAFT', counts: {}, boards: [], checklist: [], lastValidation: null } } });
    const clean: ValidationResultDTO = { academicSessionId: SID, validatedAt: '2026-11-15T00:00:00.000Z', summary: { errors: 0, warnings: 0, info: 0 }, canPublish: true, issues: [] };
    renderWithApp(<OverviewTab session={session()} readOnly={false} validation={clean} onValidated={vi.fn()} onGoTo={vi.fn()} />);
    expect(await screen.findByText(/everything checks out/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /^publish$/i })).toBeEnabled();
  });
});

describe('bulk section add', () => {
  it('shows the server’s duplicate-code error next to the input', async () => {
    const mock = mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/academic-sessions/${SID}/grade-offerings`]: { data: [grade] },
      [`GET ${API}/grades`]: { data: [] },
      [`GET ${API}/grade-offerings/${GO}/sections`]: { data: [{ sectionOfferingId: 's1', gradeOfferingId: GO, academicSessionId: SID, locationId: LOC, sectionCode: 'A', displayName: 'A', capacity: null, sequenceOrder: 1, status: 'ACTIVE' }] },
      [`POST ${API}/grade-offerings/${GO}/sections`]: { status: 409, error: { code: 'SECTION_CODE_TAKEN', message: 'Section A already exists for this grade.', details: { codes: ['A'] } } },
    });
    renderWithApp(<GradesTab sessionId={SID} locationId={LOC} readOnly={false} status="DRAFT" />);

    await userEvent.click(await screen.findByRole('button', { name: /show sections of class viii/i }));
    const input = await screen.findByLabelText(/add sections to class viii/i);
    await userEvent.type(input, 'a, B');
    await userEvent.click(screen.getByRole('button', { name: /add sections/i }));

    expect(await screen.findByText('Section A already exists for this grade.')).toBeInTheDocument();
    // Codes were normalised to upper case and split on commas before they were sent.
    expect(mock.callsTo(`/grade-offerings/${GO}/sections`, 'POST')[0]?.body).toEqual({ codes: ['A', 'B'] });
  });
});

describe('read-only roles', () => {
  it('Faculty sees the structure and no controls to change it', async () => {
    mockApi('FACULTY', {
      [`GET ${API}/academic-sessions`]: { data: [session({ status: 'ACTIVE', isCurrent: true })] },
      [`GET ${API}/academic-context`]: { data: { academicSessionId: SID, locationId: LOC, sessionStatus: 'ACTIVE', board: { boardId: 'b1', boardCode: 'CBSE', boardRuleVersionId: 'v1', ruleVersionName: '2026-27' }, grades: [grade] } },
    });
    renderWithApp(<AcademicStructurePage />);
    expect(await screen.findByRole('heading', { name: 'Academic Structure' })).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /class viii/i })).toBeInTheDocument();
    expect(screen.getByText(/limited, read-only view/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add|create|publish|delete|edit|activate|close/i })).toBeNull();
  });

  it('the subject master hides add and edit for Faculty', async () => {
    mockApi('FACULTY', {
      [`GET ${API}/subjects`]: { data: { items: [{ subjectId: 'x', subjectCode: 'MATH', name: 'Mathematics', shortName: null, category: 'MATHEMATICS', languageCode: null, hasTheory: true, hasPractical: false, hasProject: false, hasInternalAssessment: false, status: 'ACTIVE', boardCodes: [], createdAt: '', updatedAt: '' }], page: 1, pageSize: 20, total: 1 } },
      [`GET ${API}/grades`]: { data: [] },
    });
    renderWithApp(<SubjectsPage />);
    expect(await screen.findByText('Mathematics')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add subject|edit/i })).toBeNull();
  });

  it('GradesTab hides add and delete controls when read-only', async () => {
    mockApi('SCHOOL_ADMIN', {
      [`GET ${API}/academic-sessions/${SID}/grade-offerings`]: { data: [grade] },
    });
    renderWithApp(<GradesTab sessionId={SID} locationId={LOC} readOnly status="CLOSED" />);
    expect(await screen.findByText('Class VIII')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /add .*grade|delete|edit|deactivate/i })).toBeNull();
  });
});

describe('lifecycle dialogs', () => {
  it('Close explains that the session becomes read-only before confirming', async () => {
    const mock = mockApi('SCHOOL_ADMIN', {
      [`POST ${API}/academic-sessions/${SID}/close`]: { data: session({ status: 'CLOSED' }) },
    });
    renderWithApp(<LifecycleButtons session={session({ status: 'ACTIVE', isCurrent: true })} validationErrors={0} />);

    await userEvent.click(await screen.findByRole('button', { name: /close session/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/read-only/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/nothing in it can be changed/i)).toBeInTheDocument();
    expect(mock.callsTo('/close')).toHaveLength(0); // nothing happens until it is confirmed

    await userEvent.click(within(dialog).getByRole('button', { name: /^close session$/i }));
    await waitFor(() => expect(mock.callsTo('/close', 'POST')).toHaveLength(1));
  });

  it('Activate warns that another active session must be closed first, with a link to it', async () => {
    const other = session({ academicSessionId: '77777777-7777-4777-8777-777777777777', name: 'Academic Year 2025-26', status: 'ACTIVE', isCurrent: true });
    mockApi('SCHOOL_ADMIN', { [`GET ${API}/academic-sessions`]: { data: [other] } });
    renderWithApp(<LifecycleButtons session={session({ status: 'PUBLISHED' })} validationErrors={0} />);
    await userEvent.click(await screen.findByRole('button', { name: /^activate$/i }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/another active session has to be closed first/i)).toBeInTheDocument();
    expect(await within(dialog).findByRole('link', { name: 'Academic Year 2025-26' })).toHaveAttribute('href', '/academics/sessions/77777777-7777-4777-8777-777777777777');
  });
});
