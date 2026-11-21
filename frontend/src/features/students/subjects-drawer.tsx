import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, CircleAlert, Lock } from 'lucide-react';
import { toast } from 'sonner';
import type { ProgrammeChangePreviewDTO, StudentAdminProfileDTO, StudentSubjectsDTO, SubjectSelectionResultDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useChoiceGroups, useClassMaster, useClassOfferings, useProgrammes, useSubjectOfferings } from '../academic/api';
import { useEnrollmentSubjects, useStudentMutation, useValidateSubjects } from './api';
import { AUTO_SUBJECTS_HELP } from './help-copy';

/** Shows what a programme change would do, in four plain lists. Nothing is saved until the person confirms. */
function ProgrammePreview({ preview }: { preview: ProgrammeChangePreviewDTO }) {
  const list = (title: string, items: { subjectName: string }[], tone: 'success' | 'neutral' | 'danger') =>
    items.length > 0 && (
      <div>
        <p className="text-xs font-bold tracking-wide text-muted uppercase">{title}</p>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {items.map((i) => (
            <Badge key={i.subjectName} tone={tone}>
              {i.subjectName}
            </Badge>
          ))}
        </div>
      </div>
    );
  return (
    <div className="space-y-3 rounded-xl border border-line bg-canvas p-3" aria-label="What the programme change would do">
      {list('Kept', preview.kept, 'neutral')}
      {list('Added', preview.added, 'success')}
      {list('No longer valid', preview.noLongerValid, 'danger')}
      {preview.undecided.length > 0 && (
        <div>
          <p className="text-xs font-bold tracking-wide text-muted uppercase">Still to decide</p>
          <ul className="mt-1 list-disc pl-5 text-sm">
            {preview.undecided.map((u) => (
              <li key={u.message}>{u.message}</li>
            ))}
          </ul>
        </div>
      )}
      {preview.kept.length + preview.added.length + preview.noLongerValid.length + preview.undecided.length === 0 && <p className="text-sm text-muted">No subject changes.</p>}
    </div>
  );
}

function ProgrammeSection({ student, enrollment }: { student: StudentAdminProfileDTO; enrollment: NonNullable<StudentAdminProfileDTO['enrollment']> }) {
  const programmes = useProgrammes(enrollment.academicSessionId, enrollment.locationId);
  const classMaster = useClassMaster();
  const offerings = useClassOfferings(enrollment.academicSessionId, enrollment.locationId);
  const [programmeId, setProgrammeId] = useState(enrollment.programmeId ?? '');
  const [preview, setPreview] = useState<ProgrammeChangePreviewDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only programmes that cover this student's class.
  const options = useMemo(() => {
    const masterOf = (classId: string) => classMaster.data?.find((c) => c.classId === classId)?.sequenceNumber;
    const mine = masterOf(offerings.data?.find((o) => o.classOfferingId === enrollment.classOfferingId)?.classId ?? '');
    return (programmes.data ?? [])
      .filter((p) => p.status === 'ACTIVE' && (mine === undefined || ((masterOf(p.classFromId) ?? -1) <= mine && mine <= (masterOf(p.classToId) ?? 99))))
      .map((p) => ({ value: p.programmeId, label: p.name, hint: p.code }));
  }, [programmes.data, classMaster.data, offerings.data, enrollment.classOfferingId]);

  const check = useStudentMutation((body: { confirm: boolean }) => api.patch<ProgrammeChangePreviewDTO>(`/student-enrollments/${enrollment.enrollmentId}`, { version: enrollment.version, programmeId: programmeId || null, ...body }), { quiet: true });

  if (options.length === 0 && !enrollment.programmeId) return null;
  const changed = programmeId !== (enrollment.programmeId ?? '');

  return (
    <section className="space-y-3 rounded-xl border border-line p-4" aria-label="Programme">
      <h3 className="flex items-center gap-1.5 text-sm font-bold">
        Programme or stream
        <InfoTip label="About the programme">
          <p>Senior classes can follow a programme, such as Science or Commerce. Changing it can add or remove subjects. You see exactly what changes before anything is saved.</p>
        </InfoTip>
      </h3>
      <ComboboxField
        label="Programme"
        value={programmeId}
        onChange={(v) => {
          setProgrammeId(v);
          setPreview(null);
          setError(null);
        }}
        options={[{ value: '', label: 'No programme' }, ...options]}
        searchPlaceholder="Search programmes…"
      />
      {error && <Alert tone="danger">{error}</Alert>}
      {changed && !preview && (
        <Button
          variant="outline"
          loading={check.isPending}
          loadingText="Checking…"
          onClick={async () => {
            setError(null);
            try {
              setPreview(await check.mutateAsync({ confirm: false }));
            } catch (err) {
              setError(messageFor(err));
            }
          }}
        >
          See What Would Change
        </Button>
      )}
      {preview && (
        <>
          <ProgrammePreview preview={preview} />
          <Button
            loading={check.isPending}
            loadingText="Saving…"
            onClick={async () => {
              setError(null);
              try {
                await check.mutateAsync({ confirm: true });
                toast.success(`Programme changed for ${student.fullName}.`);
                setPreview(null);
              } catch (err) {
                setError(messageFor(err));
              }
            }}
          >
            Confirm Programme Change
          </Button>
        </>
      )}
    </section>
  );
}

function Checker({ result }: { result: SubjectSelectionResultDTO | null }) {
  if (!result) return null;
  return result.valid ? (
    <p className="flex items-center gap-2 rounded-xl border border-success/30 bg-success-soft px-4 py-2.5 text-sm font-semibold text-success" role="status">
      <CheckCircle2 className="size-[18px]" aria-hidden="true" /> This choice follows the class rules.
    </p>
  ) : (
    <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-2.5 text-sm" role="alert">
      <p className="flex items-center gap-2 font-semibold text-danger">
        <CircleAlert className="size-[18px]" aria-hidden="true" /> Fix this before saving
      </p>
      <ul className="mt-1 list-disc pl-6 text-ink">
        {result.problems.map((p) => (
          <li key={p.message}>{p.message}</li>
        ))}
      </ul>
    </div>
  );
}

function SubjectsForm({ student, subjects, onClose }: { student: StudentAdminProfileDTO; subjects: StudentSubjectsDTO; onClose: () => void }) {
  const enrollment = student.enrollment!;
  const offerings = useSubjectOfferings(enrollment.classOfferingId);
  const groups = useChoiceGroups(enrollment.classOfferingId);
  const validate = useValidateSubjects(enrollment.enrollmentId);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(subjects.subjects.filter((s) => !s.isMandatory).map((s) => s.subjectOfferingId)));
  const [result, setResult] = useState<SubjectSelectionResultDTO | null>(subjects.selection);
  const [saveError, setSaveError] = useState<string | null>(null);

  const save = useStudentMutation((ids: string[]) => api.post<StudentSubjectsDTO>(`/student-enrollments/${enrollment.enrollmentId}/subjects`, { subjectOfferingIds: ids }), { quiet: true });

  const active = (offerings.data ?? []).filter((o) => o.status === 'ACTIVE');
  const mandatoryIds = new Set(subjects.subjects.filter((s) => s.isMandatory).map((s) => s.subjectOfferingId));
  active.filter((o) => o.offeringType === 'MANDATORY').forEach((o) => mandatoryIds.add(o.subjectOfferingId));
  const mandatory = active.filter((o) => mandatoryIds.has(o.subjectOfferingId));
  const activeGroups = (groups.data ?? []).filter((g) => g.status === 'ACTIVE' && g.ruleType !== 'REQUIRED_ALL');
  const inGroup = new Set(activeGroups.flatMap((g) => g.subjects.map((s) => s.subjectOfferingId)));
  const others = active.filter((o) => !mandatoryIds.has(o.subjectOfferingId) && !inGroup.has(o.subjectOfferingId));

  // Check the choice as it changes, so the plain-words message is always up to date.
  const key = [...picked].sort().join(',');
  useEffect(() => {
    const t = setTimeout(() => {
      validate.mutate([...picked], { onSuccess: setResult });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const toggle = (id: string) => {
    setSaveError(null);
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const checkbox = (id: string, name: string) => (
    <label key={id} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm hover:bg-canvas">
      <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={picked.has(id)} onChange={() => toggle(id)} />
      {name}
    </label>
  );

  const valid = result?.valid ?? false;
  return (
    <>
      <DrawerBody>
        <div className="space-y-5">
          <ProgrammeSection student={student} enrollment={enrollment} />

          <section aria-label="Required subjects" className="space-y-1.5">
            <h3 className="flex items-center gap-1.5 text-sm font-bold">
              Required subjects <InfoTip label="Why these are added automatically">{AUTO_SUBJECTS_HELP}</InfoTip>
            </h3>
            {mandatory.length === 0 ? (
              <p className="text-sm text-muted">This class has no required subjects.</p>
            ) : (
              <ul className="flex flex-wrap gap-1.5">
                {mandatory.map((o) => (
                  <li key={o.subjectOfferingId}>
                    <Badge tone="neutral">
                      <Lock aria-hidden /> {o.subjectName}
                    </Badge>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {activeGroups.map((g) => {
            const check = result?.groups.find((c) => c.choiceGroupId === g.choiceGroupId);
            return (
              <section key={g.choiceGroupId} aria-label={g.name} className="space-y-1.5 rounded-xl border border-line p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-sm font-bold">{g.name}</h3>
                  {check && <Badge tone={check.satisfied ? 'success' : 'warning'}>{check.satisfied ? 'Done' : 'Needs a choice'}</Badge>}
                </div>
                <p className="text-[13px] text-muted">{g.summary}</p>
                <div className="grid gap-0.5 sm:grid-cols-2">{g.subjects.filter((s) => s.status === 'ACTIVE').map((s) => checkbox(s.subjectOfferingId, s.subjectName))}</div>
              </section>
            );
          })}

          {others.length > 0 && (
            <section aria-label="Other subjects" className="space-y-1.5">
              <h3 className="text-sm font-bold">Other subjects</h3>
              <div className="grid gap-0.5 sm:grid-cols-2">{others.map((o) => checkbox(o.subjectOfferingId, o.subjectName))}</div>
            </section>
          )}

          <Checker result={result} />
          {saveError && <Alert tone="danger">{saveError}</Alert>}
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onClose} disabled={save.isPending}>
          Cancel
        </Button>
        <Button
          disabled={!valid}
          title={valid ? undefined : 'Fix the problems above first'}
          loading={save.isPending}
          loadingText="Saving…"
          onClick={async () => {
            try {
              await save.mutateAsync([...picked]);
              toast.success('Subjects saved. The old choices stay in History.');
              onClose();
            } catch (err) {
              setSaveError(messageFor(err));
            }
          }}
        >
          Save Subjects
        </Button>
      </DrawerFooter>
    </>
  );
}

/** Change Subjects: the class's choices with a checker that says in plain words what to fix ("Pick 1 language. You picked 2."). */
export function SubjectsDrawer({ student, onClose }: { student: StudentAdminProfileDTO; onClose: () => void }) {
  const enrollment = student.enrollment;
  const subjects = useEnrollmentSubjects(enrollment?.enrollmentId);
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent title="Change subjects" description={`${student.fullName} · ${enrollment?.className ?? ''}`}>
        {subjects.isLoading ? (
          <DrawerBody>
            <Skeleton className="h-48 rounded-card" />
          </DrawerBody>
        ) : subjects.isError || !subjects.data ? (
          <DrawerBody>
            <ErrorState error={subjects.error} onRetry={() => void subjects.refetch()} retrying={subjects.isFetching} />
          </DrawerBody>
        ) : (
          // A new key after a programme change starts the form again with the new subjects.
          <SubjectsForm key={`${enrollment?.version}-${subjects.data.subjects.length}`} student={student} subjects={subjects.data} onClose={onClose} />
        )}
      </DrawerContent>
    </Drawer>
  );
}
