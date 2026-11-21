import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { EXITED_STUDENT_STATUSES, type AttentionFix, type CompletenessEntryDTO } from '@shared';
import { ArrowLeft, BookOpen, FileText, History, LayoutGrid, Lock, MoveRight, UserPlus, UsersRound } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Can } from '@/components/sv/can';
import { ErrorState } from '@/components/sv/error-state';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { NotFoundPage } from '../errors/not-found-page';
import { StudentNotFound } from './not-found';
import { useFacultyStudent, useStudent } from './api';
import { StudentContextProvider } from './context';
import { EditStudentDrawer } from './edit-student-drawer';
import { AddGuardianDrawer } from './guardian-dialogs';
import { PlaceInClassDialog } from './place-in-class-dialog';
import { ChangeSectionDialog, currentSection, RollNumberDialog } from './section-dialogs';
import { placementText, StudentStatusPill } from './student-bits';
import { SubjectsDrawer } from './subjects-drawer';
import { AcademicTab } from './tabs/academic-tab';
import { AdmissionTab } from './tabs/admission-tab';
import { GuardiansTab } from './tabs/guardians-tab';
import { HistoryTab } from './tabs/history-tab';
import { OverviewTab } from './tabs/overview-tab';

type Dialog = 'section' | 'roll' | 'subjects' | 'guardian-new' | 'guardian-link' | 'edit' | 'place' | null;

const FIX_TO_DIALOG: Partial<Record<AttentionFix, Dialog>> = {
  ADD_SECTION: 'section',
  ADD_GUARDIAN: 'guardian-new',
  CHOOSE_SUBJECTS: 'subjects',
  ADD_ADMISSION: 'place',
  ADD_CLASS: 'place',
};

function AdminStudentPage({ studentId }: { studentId: string }) {
  const q = useStudent(studentId);
  const [params, setParams] = useSearchParams();
  const [dialog, setDialog] = useState<Dialog>(null);
  const student = q.data;

  const tab = params.get('tab') ?? 'overview';
  const setTab = (next: string) => setParams((prev) => new URLSearchParams({ ...Object.fromEntries(prev), tab: next }), { replace: true });

  // "Fix" links from Needs Attention arrive as ?fix=ADD_SECTION and open the right drawer straight away.
  const fix = params.get('fix') as AttentionFix | null;
  useEffect(() => {
    if (!fix || !student) return;
    if (fix === 'CHOOSE_PRIMARY') setTab('guardians');
    else if (FIX_TO_DIALOG[fix]) setDialog(FIX_TO_DIALOG[fix]!);
    setParams((prev) => { const n = new URLSearchParams(prev); n.delete('fix'); return n; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fix, student?.studentId]);

  if (q.isLoading) {
    return (
      <div role="status" aria-label="Loading student" className="space-y-4">
        <Skeleton className="h-8 w-40" />
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-80 rounded-card" />
      </div>
    );
  }
  if (q.error instanceof ApiError && q.error.status === 404) return <StudentNotFound backTo="/students" backLabel="Go To Students" />;
  if (q.isError || !student) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;

  const readOnly = EXITED_STUDENT_STATUSES.includes(student.status);
  const enrollment = student.enrollment;
  const section = currentSection(student);
  const hasPrimary = student.primaryGuardianName !== null;

  const onFix = (m: CompletenessEntryDTO) => {
    if (m.item === 'SECTION') setDialog('section');
    else if (m.item === 'GUARDIAN') setDialog('guardian-new');
    else if (m.item === 'PRIMARY_GUARDIAN') setTab('guardians');
    else if (m.item === 'SUBJECT_CHOICE') setDialog('subjects');
    else setDialog('place');
  };

  return (
    <>
      <Link to="/students" className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand">
        <ArrowLeft className="size-4" /> Students
      </Link>

      <header className="mb-4 flex flex-col gap-3 rounded-card border border-line bg-white p-4 shadow-card sm:flex-row sm:items-center sm:gap-4 sm:px-5">
        <Avatar name={student.fullName} className="size-14 text-xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-[22px] leading-tight font-extrabold break-words">{student.fullName}</h1>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono font-semibold text-ink">{student.admissionNumber ?? 'No admission number yet'}</span> · {placementText(student.classSection, student.rollNumber)}
            {student.primaryGuardianName ? ` · Parent: ${student.primaryGuardianName}` : ''}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <StudentStatusPill status={student.status} />
          </div>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2" aria-label="Quick actions">
            <Can permission="student:enroll">
              <Button variant="outline" size="sm" onClick={() => setDialog('section')} disabled={!enrollment || enrollment.state !== 'OPEN'} title={!enrollment ? 'Choose a class first' : undefined}>
                <MoveRight /> {section ? 'Change Section' : 'Choose Section'}
              </Button>
            </Can>
            <Can permission="guardian:manage">
              <Button variant="outline" size="sm" onClick={() => setDialog('guardian-new')}>
                <UserPlus /> Add Guardian
              </Button>
            </Can>
            <Can permission="student:enroll">
              <Button variant="outline" size="sm" onClick={() => setDialog('subjects')} disabled={!enrollment || enrollment.state !== 'OPEN'} title={!enrollment ? 'Choose a class first' : undefined}>
                <BookOpen /> Change Subjects
              </Button>
            </Can>
          </div>
        )}
      </header>

      {readOnly && (
        <Alert tone="warning" title="This student has left the school" className="mb-4">
          <span className="inline-flex items-center gap-1.5">
            <Lock className="size-4" aria-hidden="true" /> The record is read-only{student.enrollment?.effectiveTo ? ` (left on ${formatDateOnly(student.enrollment.effectiveTo)})` : ''}. Everything stays visible for history, but nothing can be changed.
          </span>
        </Alert>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Student record">
          <TabsTrigger value="overview">
            <LayoutGrid /> Overview
          </TabsTrigger>
          <TabsTrigger value="academic">
            <BookOpen /> Class &amp; Subjects
          </TabsTrigger>
          <TabsTrigger value="guardians">
            <UsersRound /> Parents &amp; Guardians
          </TabsTrigger>
          <TabsTrigger value="admission">
            <FileText /> Admission
          </TabsTrigger>
          <TabsTrigger value="history">
            <History /> History
          </TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab student={student} onFix={onFix} onEdit={() => setDialog('edit')} />
        </TabsContent>
        <TabsContent value="academic">
          <AcademicTab student={student} readOnly={readOnly} onChangeSection={() => setDialog('section')} onRoll={() => setDialog('roll')} onChangeSubjects={() => setDialog('subjects')} onChooseClass={() => setDialog('place')} />
        </TabsContent>
        <TabsContent value="guardians">
          <GuardiansTab student={student} readOnly={readOnly} onAdd={(mode) => setDialog(mode === 'new' ? 'guardian-new' : 'guardian-link')} />
        </TabsContent>
        <TabsContent value="admission">
          <AdmissionTab student={student} readOnly={readOnly} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab studentId={student.studentId} />
        </TabsContent>
      </Tabs>

      {dialog === 'section' && enrollment && <ChangeSectionDialog student={student} onClose={() => setDialog(null)} />}
      {dialog === 'roll' && section && <RollNumberDialog assignment={section} onClose={() => setDialog(null)} />}
      {dialog === 'subjects' && enrollment && <SubjectsDrawer student={student} onClose={() => setDialog(null)} />}
      {(dialog === 'guardian-new' || dialog === 'guardian-link') && <AddGuardianDrawer student={student} hasPrimary={hasPrimary} initial={dialog === 'guardian-link' ? 'link' : 'new'} onClose={() => setDialog(null)} />}
      {dialog === 'edit' && <EditStudentDrawer student={student} onClose={() => setDialog(null)} />}
      {dialog === 'place' && <PlaceInClassDialog student={student} onClose={() => setDialog(null)} />}
    </>
  );
}

/** A teacher's view of one student: the short summary only. A student outside their sections is "Not found". */
function FacultyStudentPage({ studentId }: { studentId: string }) {
  const q = useFacultyStudent(studentId);
  if (q.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading student" />;
  if (q.error instanceof ApiError && q.error.status === 404) return <StudentNotFound backTo="/my-students" backLabel="Go To My Students" />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const s = q.data;
  return (
    <>
      <Link to="/my-students" className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand">
        <ArrowLeft className="size-4" /> My Students
      </Link>
      <header className="mb-4 flex items-center gap-4 rounded-card border border-line bg-white p-4 shadow-card sm:px-5">
        <Avatar name={s.fullName} className="size-14 text-xl" />
        <div className="min-w-0">
          <h1 className="text-[22px] leading-tight font-extrabold break-words">{s.fullName}</h1>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono font-semibold text-ink">{s.admissionNumber ?? '—'}</span> · {placementText(s.classSection, s.rollNumber)}
          </p>
        </div>
      </header>
      <section className="rounded-card border border-line bg-white p-4 shadow-card sm:p-5" aria-label="Subjects you teach">
        <h2 className="text-lg font-bold">Subjects you teach this student</h2>
        {s.subjects.length === 0 ? (
          <p className="mt-2 text-sm text-muted">None of your subjects. You see this student because of your class or section role.</p>
        ) : (
          <ul className="mt-3 flex flex-wrap gap-2">
            {s.subjects.map((sub) => (
              <li key={sub.subjectOfferingId} className="rounded-pill bg-brand-soft px-3 py-1 text-sm font-semibold text-brand">
                {sub.subjectName}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

/** `/students/:studentId`. Admins get the full record; a teacher gets the short summary. */
export function StudentPage() {
  const { studentId } = useParams();
  const { can } = useAuth();
  if (!studentId) return <NotFoundPage />;
  if (!can('student:view')) return <FacultyStudentPage studentId={studentId} />;
  return (
    <StudentContextProvider>
      <AdminStudentPage studentId={studentId} />
    </StudentContextProvider>
  );
}
