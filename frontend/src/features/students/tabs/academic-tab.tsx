import { useState } from 'react';
import { ENROLLMENT_STATUS_LABELS, type StudentAdminProfileDTO } from '@shared';
import { BookOpen, Hash, Lock, MoveRight } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { formatDateOnly } from '@/lib/format';
import { useEnrollmentSubjects, useStudentEnrollments } from '../api';
import { ACADEMIC_INTRO } from '../help-copy';
import { currentSection } from '../section-dialogs';

/** Class, section, roll number and subjects for this year, plus earlier years. */
export function AcademicTab({ student, readOnly, onChangeSection, onRoll, onChangeSubjects, onChooseClass }: { student: StudentAdminProfileDTO; readOnly: boolean; onChangeSection: () => void; onRoll: () => void; onChangeSubjects: () => void; onChooseClass: () => void }) {
  const enrollment = student.enrollment;
  const section = currentSection(student);
  const subjects = useEnrollmentSubjects(enrollment?.enrollmentId, Boolean(enrollment));
  const all = useStudentEnrollments(student.studentId);
  const [showPast, setShowPast] = useState(false);
  const past = (all.data ?? []).filter((e) => e.enrollmentId !== enrollment?.enrollmentId);
  const open = enrollment?.state === 'OPEN';

  return (
    <div className="space-y-4">
      <TabIntro title="About class and subjects">{ACADEMIC_INTRO}</TabIntro>

      {!enrollment ? (
        <Card>
          <Alert tone="warning" title="No class yet">
            This student is not in a class for this year.
            <Can permission="student:enroll">
              <Button size="sm" className="mt-2" onClick={onChooseClass} disabled={readOnly}>
                Choose Class
              </Button>
            </Can>
          </Alert>
        </Card>
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Class and section</CardTitle>
              <Can permission="student:enroll">
                <div className="flex flex-wrap gap-2">
                  <Button variant="outline" size="sm" onClick={onRoll} disabled={readOnly || !section} title={!section ? 'Add a section first' : undefined}>
                    <Hash /> Roll Number
                  </Button>
                  <Button size="sm" onClick={onChangeSection} disabled={readOnly || !open} title={!open ? 'This enrollment is closed' : undefined}>
                    <MoveRight /> {section ? 'Change Section' : 'Choose Section'}
                  </Button>
                </div>
              </Can>
            </CardHeader>
            <InfoGrid>
              <InfoItem label="Year">{enrollment.sessionName || enrollment.sessionCode}</InfoItem>
              <InfoItem label="Campus">{enrollment.locationName}</InfoItem>
              <InfoItem label="Class">{enrollment.className}</InfoItem>
              <InfoItem label="Section">{section ? section.sectionName : <span className="font-normal text-warning">No section yet</span>}</InfoItem>
              <InfoItem label="Roll number">{section?.rollNumber}</InfoItem>
              <InfoItem label="Class status">
                <Badge tone={enrollment.status === 'ACTIVE' ? 'success' : 'neutral'}>{ENROLLMENT_STATUS_LABELS[enrollment.status]}</Badge>
              </InfoItem>
              {enrollment.programmeName && <InfoItem label="Programme">{enrollment.programmeName}</InfoItem>}
              <InfoItem label="In this class since">{formatDateOnly(enrollment.effectiveFrom)}</InfoItem>
            </InfoGrid>
            {!section && open && <p className="mt-3 text-[13px] text-muted">Roll Number is off until a section is chosen. Add a section first.</p>}
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Subjects</CardTitle>
              <Can permission="student:enroll">
                <Button size="sm" onClick={onChangeSubjects} disabled={readOnly || !open} title={!open ? 'This enrollment is closed' : undefined}>
                  <BookOpen /> Change Subjects
                </Button>
              </Can>
            </CardHeader>
            {subjects.isLoading ? (
              <Skeleton className="h-24 rounded-xl" />
            ) : subjects.isError || !subjects.data ? (
              <ErrorState error={subjects.error} onRetry={() => void subjects.refetch()} retrying={subjects.isFetching} />
            ) : (
              <>
                {subjects.data.choicePending && (
                  <Alert tone="warning" title="A subject choice is still to be made" className="mb-3">
                    <ul className="list-disc pl-5">
                      {subjects.data.selection.problems.map((p) => (
                        <li key={p.message}>{p.message}</li>
                      ))}
                    </ul>
                  </Alert>
                )}
                {subjects.data.subjects.length === 0 ? (
                  <p className="text-sm text-muted">No subjects yet. Press Change Subjects to add them.</p>
                ) : (
                  <ul className="grid gap-2 sm:grid-cols-2" aria-label="Subjects">
                    {subjects.data.subjects.map((s) => (
                      <li key={s.subjectEnrollmentId} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-2 text-sm">
                        <span className="font-semibold">{s.subjectName}</span>
                        {s.isMandatory ? (
                          <Badge tone="neutral">
                            <Lock aria-hidden /> Required
                          </Badge>
                        ) : (
                          <Badge tone="brand">Chosen</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            )}
          </Card>
        </>
      )}

      {past.length > 0 && (
        <Card>
          <CardHeader className="mb-2">
            <CardTitle className="text-base">Earlier classes</CardTitle>
            <Button variant="ghost" size="sm" onClick={() => setShowPast((v) => !v)} aria-expanded={showPast}>
              {showPast ? 'Hide' : `Show (${past.length})`}
            </Button>
          </CardHeader>
          {showPast && (
            <ul className="divide-y divide-line" aria-label="Earlier classes">
              {past.map((e) => (
                <li key={e.enrollmentId} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                  <span className="font-semibold">{e.className}{e.section ? `-${e.section.sectionCode}` : ''}</span>
                  <span className="text-muted">
                    {e.sessionCode} · {formatDateOnly(e.effectiveFrom)}{e.effectiveTo ? ` – ${formatDateOnly(e.effectiveTo)}` : ''}
                  </span>
                  <Badge tone="neutral">{ENROLLMENT_STATUS_LABELS[e.status]}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}
