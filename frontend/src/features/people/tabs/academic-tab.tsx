import { useEffect, useMemo, useState } from 'react';
import {
  ACADEMIC_ASSIGNMENT_TYPES,
  ACADEMIC_ASSIGNMENT_TYPE_LABELS,
  type AcademicAssignmentType,
  type EmployeeProfileDTO,
  type FacultyAssignmentDTO,
} from '@shared';
import { BookOpenCheck, Plus, Save } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { SelectField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { AssignmentStatusChip } from '@/components/sv/employee-status';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import {
  useGradeOfferings,
  useSections,
  useSessions,
  useSubjectOfferings,
} from '../../academic/api';
import { useFacultyAssignments, usePeopleMutation } from '../api';
import { CancelAssignmentDialog, EndAssignmentDialog } from '../assignment-dialogs';

const NEEDS_SECTIONS: AcademicAssignmentType[] = [
  'SUBJECT_FACULTY',
  'CLASS_TEACHER',
  'CO_CLASS_TEACHER',
];

/** Several sections in one go: Maths for VIII-A, B and C is one save. */
function AssignDrawer({
  employee,
  sessionId,
  onClose,
}: {
  employee: EmployeeProfileDTO;
  sessionId: string;
  onClose: () => void;
}) {
  const sessions = useSessions();
  const session = sessions.data?.find((s) => s.academicSessionId === sessionId);
  // The server checks that the employee is placed at the location; offer only those they are placed at.
  const placed = new Set(employee.locations.map((l) => l.locationId));
  const locations = (session?.locations ?? []).filter((l) => placed.has(l.locationId));

  const [type, setType] = useState<AcademicAssignmentType>('SUBJECT_FACULTY');
  const [locationId, setLocationId] = useState('');
  const [gradeOfferingId, setGrade] = useState('');
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [subjectOfferingId, setSubject] = useState('');
  const [effectiveFrom, setFrom] = useState('');
  const [effectiveTo, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!locationId && locations[0]) setLocationId(locations[0].locationId);
  }, [locations, locationId]);

  const grades = useGradeOfferings(sessionId, locationId);
  const sections = useSections(gradeOfferingId || undefined);
  const subjects = useSubjectOfferings(gradeOfferingId || undefined);
  const needsSections = NEEDS_SECTIONS.includes(type);
  const activeSections = (sections.data ?? []).filter((s) => s.status === 'ACTIVE');
  const activeSubjects = (subjects.data ?? []).filter((s) => s.status === 'ACTIVE');

  const create = usePeopleMutation(
    (items: object[]) =>
      api.post<FacultyAssignmentDTO[]>(`/employees/${employee.employeeId}/academic-assignments`, {
        items,
      }),
    {
      quiet: true,
      success: (rows) => `${rows.length} assignment${rows.length === 1 ? '' : 's'} added.`,
    },
  );

  const toggleSection = (id: string) =>
    setSectionIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]));

  const submit = async () => {
    setError(null);
    if (!locationId) return setError('Choose a location.');
    if (!gradeOfferingId) return setError('Choose a grade.');
    if (needsSections && sectionIds.length === 0) return setError('Choose at least one section.');
    if (type === 'SUBJECT_FACULTY' && !subjectOfferingId) return setError('Choose a subject.');
    const dates = {
      ...(effectiveFrom ? { effectiveFrom } : {}),
      ...(effectiveTo ? { effectiveTo } : {}),
    };
    const items = needsSections
      ? sectionIds.map((sectionId) => ({
          assignmentType: type,
          sectionId,
          ...(type === 'SUBJECT_FACULTY' ? { subjectOfferingId } : {}),
          ...dates,
        }))
      : [{ assignmentType: type, gradeOfferingId, ...dates }];
    try {
      await create.mutateAsync(items);
      onClose();
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <Drawer open onOpenChange={(open) => !open && !create.isPending && onClose()}>
      <DrawerContent
        title="Assign classes"
        description={`${employee.fullName} · ${session?.name ?? 'Academic session'}`}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DrawerBody className="space-y-5">
            {error && <Alert tone="danger">{error}</Alert>}
            {locations.length === 0 && !sessions.isLoading && (
              <Alert tone="warning">
                This session has no location where {employee.displayName} is placed. Add the
                location on the Overview tab first.
              </Alert>
            )}
            <SelectField
              label="Assignment type"
              required
              value={type}
              onChange={(e) => setType(e.target.value as AcademicAssignmentType)}
            >
              {ACADEMIC_ASSIGNMENT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACADEMIC_ASSIGNMENT_TYPE_LABELS[t]}
                </option>
              ))}
            </SelectField>
            <div className="grid gap-5 sm:grid-cols-2">
              <SelectField
                label="Location"
                required
                value={locationId}
                onChange={(e) => {
                  setLocationId(e.target.value);
                  setGrade('');
                  setSectionIds([]);
                  setSubject('');
                }}
              >
                {locations.map((l) => (
                  <option key={l.locationId} value={l.locationId}>
                    {l.locationName}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Grade"
                required
                value={gradeOfferingId}
                onChange={(e) => {
                  setGrade(e.target.value);
                  setSectionIds([]);
                  setSubject('');
                }}
              >
                <option value="">Choose…</option>
                {(grades.data ?? [])
                  .filter((g) => g.status === 'ACTIVE')
                  .map((g) => (
                    <option key={g.gradeOfferingId} value={g.gradeOfferingId}>
                      {g.displayName}
                    </option>
                  ))}
              </SelectField>
            </div>

            {needsSections && gradeOfferingId && (
              <fieldset aria-labelledby="assign-sections-label">
                <div className="mb-2 flex items-center justify-between">
                  <legend id="assign-sections-label" className="text-sm font-semibold">
                    Sections{' '}
                    <span aria-hidden="true" className="text-danger">
                      *
                    </span>
                  </legend>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setSectionIds(
                        sectionIds.length === activeSections.length
                          ? []
                          : activeSections.map((s) => s.sectionOfferingId),
                      )
                    }
                  >
                    {sectionIds.length === activeSections.length && activeSections.length > 0
                      ? 'Clear'
                      : 'Select all'}
                  </Button>
                </div>
                {sections.isLoading ? (
                  <Skeleton className="h-10" />
                ) : activeSections.length === 0 ? (
                  <p className="text-sm text-muted">This grade has no active sections.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {activeSections.map((s) => (
                      <label
                        key={s.sectionOfferingId}
                        className="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm font-semibold has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
                      >
                        <input
                          type="checkbox"
                          className="size-4 accent-[var(--color-brand)]"
                          checked={sectionIds.includes(s.sectionOfferingId)}
                          onChange={() => toggleSection(s.sectionOfferingId)}
                        />
                        {s.displayName}
                      </label>
                    ))}
                  </div>
                )}
              </fieldset>
            )}

            {type === 'SUBJECT_FACULTY' && gradeOfferingId && (
              <SelectField
                label="Subject"
                required
                value={subjectOfferingId}
                onChange={(e) => setSubject(e.target.value)}
              >
                <option value="">Choose…</option>
                {activeSubjects.map((s) => (
                  <option key={s.subjectOfferingId} value={s.subjectOfferingId}>
                    {s.subjectName}
                  </option>
                ))}
              </SelectField>
            )}

            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                label="Starts on"
                type="date"
                hint="Leave blank to use the session start."
                value={effectiveFrom}
                onChange={(e) => setFrom(e.target.value)}
              />
              <TextField
                label="Ends on"
                type="date"
                hint="Leave blank to use the session end."
                value={effectiveTo}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </DrawerBody>
          <DrawerFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={create.isPending}
              loadingText="Saving…"
              disabled={locations.length === 0}
            >
              <Save />{' '}
              {needsSections && sectionIds.length > 1
                ? `Assign ${sectionIds.length} sections`
                : 'Assign'}
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

function classLabel(a: FacultyAssignmentDTO) {
  return a.sectionName ? `${a.gradeName} · ${a.sectionName}` : a.gradeName;
}

export function AcademicTab({ employee }: { employee: EmployeeProfileDTO }) {
  const sessions = useSessions();
  const usable = useMemo(
    () => (sessions.data ?? []).filter((s) => s.status !== 'DRAFT'),
    [sessions.data],
  );
  const [picked, setPicked] = useState('');
  const sessionId =
    picked ||
    usable.find((s) => s.isCurrent)?.academicSessionId ||
    usable[0]?.academicSessionId ||
    '';
  const session = usable.find((s) => s.academicSessionId === sessionId);
  const list = useFacultyAssignments(employee.employeeId, sessionId || undefined, !!sessionId);
  const [assigning, setAssigning] = useState(false);
  const [ending, setEnding] = useState<FacultyAssignmentDTO | null>(null);
  const [cancelling, setCancelling] = useState<FacultyAssignmentDTO | null>(null);
  const canAssign =
    !employee.readOnly && (session?.status === 'ACTIVE' || session?.status === 'PUBLISHED');

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Academic assignments</CardTitle>
          <CardDescription>
            Classes, subjects and roles for one session. Older sessions stay as history.
          </CardDescription>
        </div>
        <Can permission="employee:manage">
          {canAssign && (
            <Button size="sm" onClick={() => setAssigning(true)}>
              <Plus /> Assign classes
            </Button>
          )}
        </Can>
      </CardHeader>

      {sessions.isLoading ? (
        <Skeleton className="h-24" />
      ) : usable.length === 0 ? (
        <EmptyState
          illustration={<BookOpenCheck className="size-10 text-muted" aria-hidden="true" />}
          title="No published session yet"
          description="Publish an academic session first. Classes can only be assigned in a published or active session."
        />
      ) : (
        <>
          <div className="mb-4 max-w-xs">
            <SelectField
              label="Session"
              value={sessionId}
              onChange={(e) => setPicked(e.target.value)}
            >
              {usable.map((s) => (
                <option key={s.academicSessionId} value={s.academicSessionId}>
                  {s.name} ({s.status.toLowerCase()})
                </option>
              ))}
            </SelectField>
          </div>
          {list.isLoading ? (
            <Skeleton className="h-24" />
          ) : list.isError ? (
            <ErrorState
              error={list.error}
              onRetry={() => void list.refetch()}
              retrying={list.isFetching}
            />
          ) : (list.data ?? []).length === 0 ? (
            <EmptyState
              illustration={<BookOpenCheck className="size-10 text-muted" aria-hidden="true" />}
              title="No classes assigned in this session"
              description={
                canAssign
                  ? 'Assign subjects and sections, or make them a class teacher or coordinator.'
                  : undefined
              }
            />
          ) : (
            <>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full min-w-[720px] text-sm">
                  <caption className="sr-only">Academic assignments</caption>
                  <thead className="border-b border-line bg-canvas/70">
                    <tr>
                      {['Class', 'Subject', 'Role', 'Location', 'Dates', 'Status', ''].map(
                        (h, i) => (
                          <th
                            key={i}
                            scope="col"
                            className="px-3 py-3 text-left text-xs font-bold tracking-wide text-muted uppercase"
                          >
                            {h || <span className="sr-only">Actions</span>}
                          </th>
                        ),
                      )}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {(list.data ?? []).map((a) => (
                      <tr key={a.academicAssignmentId}>
                        <td className="px-3 py-3 font-semibold">{classLabel(a)}</td>
                        <td className="px-3 py-3">{a.subjectName ?? '—'}</td>
                        <td className="px-3 py-3">
                          {ACADEMIC_ASSIGNMENT_TYPE_LABELS[a.assignmentType]}
                        </td>
                        <td className="px-3 py-3">{a.locationCode}</td>
                        <td className="px-3 py-3 whitespace-nowrap text-muted">
                          {formatDateOnly(a.effectiveFrom)}
                          {a.effectiveTo ? ` – ${formatDateOnly(a.effectiveTo)}` : ''}
                        </td>
                        <td className="px-3 py-3">
                          <AssignmentStatusChip status={a.status} />
                        </td>
                        <td className="px-3 py-3 text-right whitespace-nowrap">
                          <Can permission="employee:manage">
                            {!employee.readOnly && a.status === 'ACTIVE' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setEnding(a)}
                                aria-label={`End ${classLabel(a)} ${a.subjectName ?? ''}`}
                              >
                                End
                              </Button>
                            )}
                            {!employee.readOnly && a.status === 'PLANNED' && (
                              <Button
                                variant="ghost"
                                size="sm"
                                onClick={() => setCancelling(a)}
                                aria-label={`Cancel ${classLabel(a)} ${a.subjectName ?? ''}`}
                              >
                                Cancel
                              </Button>
                            )}
                          </Can>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="divide-y divide-line md:hidden" aria-label="Academic assignments">
                {(list.data ?? []).map((a) => (
                  <li key={a.academicAssignmentId} className="space-y-1.5 py-3">
                    <p className="font-semibold">
                      {classLabel(a)}
                      {a.subjectName ? ` · ${a.subjectName}` : ''}
                    </p>
                    <p className="text-[13px] text-muted">
                      {ACADEMIC_ASSIGNMENT_TYPE_LABELS[a.assignmentType]} · {a.locationCode}
                    </p>
                    <div className="flex flex-wrap items-center gap-2">
                      <AssignmentStatusChip status={a.status} />
                      <Can permission="employee:manage">
                        {!employee.readOnly && a.status === 'ACTIVE' && (
                          <Button variant="ghost" size="sm" onClick={() => setEnding(a)}>
                            End
                          </Button>
                        )}
                        {!employee.readOnly && a.status === 'PLANNED' && (
                          <Button variant="ghost" size="sm" onClick={() => setCancelling(a)}>
                            Cancel
                          </Button>
                        )}
                      </Can>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {assigning && sessionId && (
        <AssignDrawer
          employee={employee}
          sessionId={sessionId}
          onClose={() => setAssigning(false)}
        />
      )}
      {ending && (
        <EndAssignmentDialog
          path={`/academic-assignments/${ending.academicAssignmentId}/end`}
          title={`End ${classLabel(ending)}?`}
          onClose={() => setEnding(null)}
        />
      )}
      {cancelling && (
        <CancelAssignmentDialog
          path={`/academic-assignments/${cancelling.academicAssignmentId}/cancel`}
          title={`Cancel ${classLabel(cancelling)}?`}
          onClose={() => setCancelling(null)}
        />
      )}
    </Card>
  );
}
