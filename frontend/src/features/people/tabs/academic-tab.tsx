import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import {
  ACADEMIC_ASSIGNMENT_TYPES,
  ACADEMIC_ASSIGNMENT_TYPE_LABELS,
  type AcademicAssignmentType,
  type EmployeeProfileDTO,
  type FacultyAssignmentDTO,
} from '@shared';
import { ArrowRight, BookOpenCheck, ChevronDown, Plus, Save } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { AssignmentStatusChip } from '@/components/sv/employee-status';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  useClassOfferings,
  useSections,
  useSessions,
  useSubjectOfferings,
} from '../../academic/api';
import { useFacultyAssignments, usePeopleMutation } from '../api';
import { CancelAssignmentDialog, EndAssignmentDialog } from '../assignment-dialogs';
import { ASSIGNMENT_TYPE_HINTS, END_CANCEL_HELP } from '../help-copy';

const NEEDS_SECTIONS: AcademicAssignmentType[] = [
  'SUBJECT_FACULTY',
  'CLASS_TEACHER',
  'CO_CLASS_TEACHER',
];

/** The server takes at most this many rows in one save. */
const MAX_ITEMS = 50;

/** A row of tick-boxes shown as chips (sections, subjects), with Select All / Clear. */
function ChipPicker({
  legend,
  items,
  picked,
  onChange,
  loading,
  empty,
}: {
  legend: string;
  items: { id: string; label: string }[];
  picked: string[];
  onChange: (ids: string[]) => void;
  loading: boolean;
  empty: React.ReactNode;
}) {
  const id = `assign-${legend.toLowerCase()}-label`;
  const all = items.length > 0 && picked.length === items.length;
  return (
    <fieldset aria-labelledby={id}>
      <div className="mb-2 flex items-center justify-between">
        <legend id={id} className="text-sm font-semibold">
          {legend}{' '}
          <span aria-hidden="true" className="text-danger">
            *
          </span>
        </legend>
        {items.length > 1 && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(all ? [] : items.map((i) => i.id))}
          >
            {all ? 'Clear' : 'Select All'}
          </Button>
        )}
      </div>
      {loading ? (
        <Skeleton className="h-10" />
      ) : items.length === 0 ? (
        <div className="text-sm text-muted">{empty}</div>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items.map((item) => (
            <label
              key={item.id}
              className="flex cursor-pointer items-center gap-2 rounded-xl border border-line px-3 py-2 text-sm font-semibold has-[:checked]:border-brand has-[:checked]:bg-brand-soft"
            >
              <input
                type="checkbox"
                className="size-4 accent-[var(--color-brand)]"
                checked={picked.includes(item.id)}
                onChange={() =>
                  onChange(
                    picked.includes(item.id)
                      ? picked.filter((x) => x !== item.id)
                      : [...picked, item.id],
                  )
                }
              />
              {item.label}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** Several sections and subjects in one go: Maths and Science for VIII-A and B is one save. */
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
  const [classOfferingId, setClass] = useState('');
  const [sectionIds, setSectionIds] = useState<string[]>([]);
  const [subjectIds, setSubjectIds] = useState<string[]>([]);
  const [showDates, setShowDates] = useState(false);
  const [effectiveFrom, setFrom] = useState('');
  const [effectiveTo, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!locationId && locations[0]) setLocationId(locations[0].locationId);
  }, [locations, locationId]);

  const classes = useClassOfferings(sessionId, locationId);
  const sections = useSections(classOfferingId || undefined);
  const subjects = useSubjectOfferings(classOfferingId || undefined);
  const needsSections = NEEDS_SECTIONS.includes(type);
  const needsSubjects = type === 'SUBJECT_FACULTY';
  const activeClasses = (classes.data ?? []).filter((g) => g.status === 'ACTIVE');
  const activeSections = (sections.data ?? []).filter((s) => s.status === 'ACTIVE');
  const activeSubjects = (subjects.data ?? []).filter((s) => s.status === 'ACTIVE');
  const count = needsSections
    ? sectionIds.length * (needsSubjects ? subjectIds.length : 1)
    : classOfferingId
      ? 1
      : 0;
  const setupLink = (
    <Link
      to={`/academics/sessions/${sessionId}`}
      className="inline-flex items-center gap-1 font-semibold text-brand underline"
    >
      Open Academic Setup <ArrowRight className="size-3.5" aria-hidden="true" />
    </Link>
  );

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

  const submit = async () => {
    setError(null);
    if (!locationId) return setError('Choose a location.');
    if (!classOfferingId) return setError('Choose a class.');
    if (needsSections && sectionIds.length === 0) return setError('Choose at least one section.');
    if (needsSubjects && subjectIds.length === 0) return setError('Choose at least one subject.');
    if (count > MAX_ITEMS)
      return setError(`That is ${count} at once. Save at most ${MAX_ITEMS}, then add the rest.`);
    const dates = {
      ...(effectiveFrom ? { effectiveFrom } : {}),
      ...(effectiveTo ? { effectiveTo } : {}),
    };
    // One row per section (and per subject, for a subject teacher).
    const items: object[] = needsSections
      ? sectionIds.flatMap((sectionId): object[] =>
          needsSubjects
            ? subjectIds.map((subjectOfferingId) => ({
                assignmentType: type,
                sectionId,
                subjectOfferingId,
                ...dates,
              }))
            : [{ assignmentType: type, sectionId, ...dates }],
        )
      : [{ assignmentType: type, classOfferingId, ...dates }];
    try {
      await create.mutateAsync(items);
      onClose();
    } catch (err) {
      setError(messageFor(err));
    }
  };

  const sectionNames = activeSections
    .filter((s) => sectionIds.includes(s.sectionOfferingId))
    .map((s) => s.displayName);
  const subjectNames = activeSubjects
    .filter((s) => subjectIds.includes(s.subjectOfferingId))
    .map((s) => s.subjectName);
  const className = activeClasses.find((c) => c.classOfferingId === classOfferingId)?.displayName;
  const summary =
    count === 0
      ? null
      : needsSubjects
        ? `${subjectNames.join(', ')} for ${sectionNames.join(', ')}`
        : needsSections
          ? `${ACADEMIC_ASSIGNMENT_TYPE_LABELS[type]} of ${sectionNames.join(', ')}`
          : `${ACADEMIC_ASSIGNMENT_TYPE_LABELS[type]} of ${className ?? 'this class'}`;

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
                <p>
                  {employee.displayName} doesn’t work at any campus that is part of this session, so
                  there are no classes to choose. Add the campus on the Overview tab first.
                </p>
                <Button asChild size="sm" variant="outline" className="mt-2">
                  <Link to="?tab=overview">
                    Go To Overview <ArrowRight />
                  </Link>
                </Button>
              </Alert>
            )}

            <fieldset>
              <legend className="mb-2 text-sm font-semibold">
                What will they do?{' '}
                <span aria-hidden="true" className="text-danger">
                  *
                </span>
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {ACADEMIC_ASSIGNMENT_TYPES.map((t) => (
                  <label
                    key={t}
                    className={cn(
                      'flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm',
                      type === t ? 'border-brand bg-brand-soft' : 'border-line hover:bg-canvas',
                    )}
                  >
                    <input
                      type="radio"
                      name="assignment-type"
                      value={t}
                      checked={type === t}
                      onChange={() => {
                        setType(t);
                        setSectionIds([]);
                        setSubjectIds([]);
                      }}
                      className="mt-1 accent-[var(--color-brand)]"
                    />
                    <span>
                      <span className="block font-semibold">
                        {ACADEMIC_ASSIGNMENT_TYPE_LABELS[t]}
                      </span>
                      <span className="text-[13px] text-muted">{ASSIGNMENT_TYPE_HINTS[t]}</span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="grid gap-5 sm:grid-cols-2">
              <ComboboxField
                label="Location"
                required
                value={locationId}
                onChange={(v) => {
                  setLocationId(v);
                  setClass('');
                  setSectionIds([]);
                  setSubjectIds([]);
                }}
                options={locations.map((l) => ({ value: l.locationId, label: l.locationName ?? '' }))}
                searchPlaceholder="Search locations…"
              />
              <ComboboxField
                label="Class"
                required
                value={classOfferingId}
                onChange={(v) => {
                  setClass(v);
                  setSectionIds([]);
                  setSubjectIds([]);
                }}
                placeholder="Choose…"
                options={activeClasses.map((g) => ({ value: g.classOfferingId, label: g.displayName }))}
                searchPlaceholder="Search classes…"
              />
            </div>
            {locationId && classes.isSuccess && activeClasses.length === 0 && (
              <Alert tone="warning">
                <p>This campus has no classes in {session?.name ?? 'this session'} yet.</p>
                <p className="mt-1">{setupLink}</p>
              </Alert>
            )}

            {needsSections && classOfferingId && (
              <ChipPicker
                legend="Sections"
                items={activeSections.map((s) => ({ id: s.sectionOfferingId, label: s.displayName }))}
                picked={sectionIds}
                onChange={setSectionIds}
                loading={sections.isLoading}
                empty={
                  <>
                    This class has no sections yet. Add them on the Classes tab of Academic Setup.{' '}
                    {setupLink}
                  </>
                }
              />
            )}

            {needsSubjects && classOfferingId && (
              <ChipPicker
                legend="Subjects"
                items={activeSubjects.map((s) => ({ id: s.subjectOfferingId, label: s.subjectName }))}
                picked={subjectIds}
                onChange={setSubjectIds}
                loading={subjects.isLoading}
                empty={
                  <>
                    This class has no subjects yet. Add them on the Subjects tab of Academic Setup.{' '}
                    {setupLink}
                  </>
                }
              />
            )}

            <div>
              <button
                type="button"
                aria-expanded={showDates}
                onClick={() => setShowDates((v) => !v)}
                className="flex items-center gap-1.5 text-sm font-semibold text-brand"
              >
                <ChevronDown
                  className={cn('size-4 transition-transform', showDates && 'rotate-180')}
                  aria-hidden="true"
                />
                Different dates? (optional)
              </button>
              {showDates ? (
                <div className="mt-3 grid gap-5 sm:grid-cols-2">
                  <TextField
                    label="Starts on"
                    type="date"
                    hint="Leave blank to start with the session."
                    value={effectiveFrom}
                    onChange={(e) => setFrom(e.target.value)}
                  />
                  <TextField
                    label="Ends on"
                    type="date"
                    hint="Leave blank to run to the end of the session."
                    value={effectiveTo}
                    onChange={(e) => setTo(e.target.value)}
                  />
                </div>
              ) : (
                <p className="mt-1 text-[13px] text-muted">
                  It runs for the whole session
                  {session ? ` (${formatDateOnly(session.startDate)} – ${formatDateOnly(session.endDate)})` : ''}.
                </p>
              )}
            </div>

            {summary && (
              <p className="rounded-xl bg-canvas px-3 py-2 text-sm" aria-live="polite">
                You are adding <b>{count}</b>: {summary}.
              </p>
            )}
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
              <Save /> {count > 1 ? `Assign ${count}` : 'Assign'}
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

function classLabel(a: FacultyAssignmentDTO) {
  return a.sectionName ? `${a.schoolClassName} · ${a.sectionName}` : a.schoolClassName;
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
    <div className="space-y-4">
      <TabIntro title="Classes & Subjects" need="required">
        <p>
          What {employee.displayName} teaches this year. Press <b>Assign Classes</b>, pick the
          class, tick the sections and subjects, and save. Example: Maths for 8-A and 8-B is one
          save.
        </p>
        <p>
          You can also make them a <b>class teacher</b> or <b>coordinator</b> here. Earlier years
          stay as history: switch the session to see them.
        </p>
      </TabIntro>
      <Card>
        <CardHeader>
          <div>
            <HelpHeading
              title="Classes & subjects"
              help={
                <>
                  <p>Each row is one job in one session, e.g. Maths for 8-A.</p>
                  {END_CANCEL_HELP}
                </>
              }
            />
            <CardDescription>
              For one session at a time. Classes can be given in a published or active session.
            </CardDescription>
          </div>
          <Can permission="employee:manage">
            {canAssign && (
              <Button size="sm" onClick={() => setAssigning(true)}>
                <Plus /> Assign Classes
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
            description="Classes come from Academic Setup. Set up this year’s session there and publish it, then come back to give classes."
            action={
              <Can permission="academic:manage">
                <Button asChild>
                  <Link to="/academics">
                    Go To Academic Setup <ArrowRight />
                  </Link>
                </Button>
              </Can>
            }
          />
        ) : (
          <>
            <div className="mb-4 max-w-xs">
              <ComboboxField
                label="Session"
                value={sessionId}
                onChange={setPicked}
                options={usable.map((s) => ({ value: s.academicSessionId, label: s.name, hint: s.status.toLowerCase() }))}
                searchPlaceholder="Search sessions…"
              />
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
                title="No classes given in this session"
                description={
                  canAssign
                    ? 'Press Assign Classes to give them subjects and sections, or make them a class teacher.'
                    : undefined
                }
              />
            ) : (
              <>
                <div className="hidden overflow-x-auto md:block">
                  <table className="w-full min-w-[720px] text-sm">
                    <caption className="sr-only">Classes and subjects</caption>
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
                <ul className="divide-y divide-line md:hidden" aria-label="Classes and subjects">
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
      </Card>

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
    </div>
  );
}
