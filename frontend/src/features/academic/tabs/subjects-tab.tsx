import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowRight, Copy, Link2, Plus, Trash2, Unlink } from 'lucide-react';
import { SUBJECT_OFFERING_TYPES, SUBJECT_OFFERING_TYPE_LABELS, type SubjectOfferingDTO, type SubjectOfferingType } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { ComboboxField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useAcademicMutation, useClassOfferings, useSession, useSubjectOfferings, useSubjects } from '../api';
import { ClassPicker } from '../class-picker';
import type { TabProps } from '../session-page';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { StatusToggle } from '../status-toggle';

const OFFERING_TYPE_OPTIONS = SUBJECT_OFFERING_TYPES.map((t) => ({ value: t, label: SUBJECT_OFFERING_TYPE_LABELS[t] }));

function OfferingTypeHelp() {
  return (
    <>
      <p>What kind of subject this is for the class:</p>
      <ul>
        <li><b>Mandatory</b>: every student studies it.</li>
        <li><b>Elective</b>: students may choose it from a set of options.</li>
        <li><b>Optional / additional</b>: an extra subject some students take on top of the rest.</li>
        <li><b>Language</b>: a language subject, such as Hindi or Punjabi.</li>
        <li><b>Skill</b>: a skill or activity subject, such as Art or Computers.</li>
        <li><b>Internal</b>: the school teaches and marks it itself; it isn’t reported to the board.</li>
      </ul>
      <p>If students pick between subjects, also set that up on the Subject Choice Rules tab.</p>
    </>
  );
}

function Offerings({ classOfferingId, sessionId, locationId, readOnly, draft }: { classOfferingId: string; sessionId: string; locationId: string; readOnly: boolean; draft: boolean }) {
  const offerings = useSubjectOfferings(classOfferingId);
  const subjects = useSubjects({ status: 'ACTIVE' }, 200);
  const session = useSession(sessionId);
  const classes = useClassOfferings(sessionId, locationId);
  const pinned = session.data?.locations.find((l) => l.locationId === locationId)?.boardRuleVersionId;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [type, setType] = useState<SubjectOfferingType>('MANDATORY');
  const [copyFrom, setCopyFrom] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useAcademicMutation((_: void) => api.post(`/class-offerings/${classOfferingId}/subjects`, { subjectIds: [...picked], offeringType: type }), { quiet: true, success: 'Subjects added.' });
  const patch = useAcademicMutation(({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/subject-offerings/${id}`, body));
  const remove = useAcademicMutation((id: string) => api.delete<void>(`/subject-offerings/${id}`), { success: 'Subject removed.' });
  const copy = useAcademicMutation((from: string) => api.post<{ created: unknown[]; skipped: number }>(`/class-offerings/${classOfferingId}/subjects/copy-from/${from}`), {
    success: (r) => `Copied ${r.created.length} subject${r.created.length === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} already there` : ''}.`,
  });

  if (offerings.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading subjects" />;
  if (offerings.isError) return <ErrorState error={offerings.error} onRetry={() => void offerings.refetch()} retrying={offerings.isFetching} />;
  const list = offerings.data ?? [];
  const offered = new Set(list.map((o) => o.subjectId));
  const available = (subjects.data?.items ?? []).filter((s) => !offered.has(s.subjectId));
  const mappingFor = (o: SubjectOfferingDTO) => subjects.data?.items.find((s) => s.subjectId === o.subjectId)?.boardCodes.find((c) => c.boardRuleVersionId === pinned);

  return (
    <div className="space-y-6">
      {list.length === 0 ? (
        <Card>
          <EmptyState title="No subjects offered yet" description={readOnly ? undefined : 'Add subjects below, or copy the list from another class.'} />
        </Card>
      ) : (
        <ul className="space-y-2" aria-label="Subject offerings">
          {list.map((o) => {
            const mapping = mappingFor(o);
            return (
              <li key={o.subjectOfferingId} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-white px-4 py-3">
                <div className="min-w-[160px] flex-1">
                  <p className="font-bold">{o.subjectName}</p>
                  <p className="text-[13px] text-muted">
                    {o.subjectCode}
                    {o.boardSubjectCode ? ` · board code ${o.boardSubjectCode}` : ''}
                  </p>
                </div>
                {readOnly ? (
                  <span className="text-sm">{SUBJECT_OFFERING_TYPE_LABELS[o.offeringType]}</span>
                ) : (
                  <Combobox
                    aria-label={`Offering type of ${o.subjectName}`}
                    className="h-9 w-44"
                    value={o.offeringType}
                    onChange={(v) => patch.mutate({ id: o.subjectOfferingId, body: { offeringType: v } })}
                    options={OFFERING_TYPE_OPTIONS}
                    searchPlaceholder="Search types…"
                  />
                )}
                {!readOnly && mapping && !o.boardSubjectDefinitionId && (
                  <Button variant="outline" size="sm" onClick={() => patch.mutate({ id: o.subjectOfferingId, body: { boardSubjectDefinitionId: mapping.definitionId } })}>
                    <Link2 /> Map To {mapping.boardSubjectCode}
                  </Button>
                )}
                {!readOnly && o.boardSubjectDefinitionId && (
                  <Button variant="ghost" size="sm" onClick={() => patch.mutate({ id: o.subjectOfferingId, body: { boardSubjectDefinitionId: null } })}>
                    <Unlink /> Unlink Board Code
                  </Button>
                )}
                <StatusToggle status={o.status} label={o.subjectName} disabled={readOnly} onToggle={() => patch.mutate({ id: o.subjectOfferingId, body: { status: o.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' } })} />
                {!readOnly && draft && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${o.subjectName}`} onClick={() => remove.mutate(o.subjectOfferingId)}>
                    <Trash2 />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!readOnly && (
        <Card>
          <CardHeader>
            <div>
              <HelpHeading
                title="Add subjects"
                helpLabel="How to add subjects"
                help={
                  <>
                    <p>Tick the subjects taught in this class, choose their type, then press Add.</p>
                    <p>The list comes from your school’s Subject Master. Missing a subject? <Link to="/academics/subjects" className="font-semibold text-brand underline">Add it in the Subject Master</Link> first.</p>
                    <p><b>Board code</b>: the code your board (e.g. CBSE) uses for the subject. It links on its own when one is known.</p>
                  </>
                }
              />
              <CardDescription>Tick the subjects taught in this class. Board codes link up on their own when one is known.</CardDescription>
            </div>
          </CardHeader>
          {available.length === 0 ? (
            <p className="text-sm text-muted">Every active subject is already offered for this class.</p>
          ) : (
            <fieldset className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              <legend className="sr-only">Subjects</legend>
              {available.map((s) => (
                <label key={s.subjectId} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm hover:border-brand/50">
                  <input
                    type="checkbox"
                    className="accent-[var(--color-brand)]"
                    checked={picked.has(s.subjectId)}
                    onChange={() => setPicked((cur) => (cur.has(s.subjectId) ? new Set([...cur].filter((x) => x !== s.subjectId)) : new Set([...cur, s.subjectId])))}
                  />
                  {s.name}
                </label>
              ))}
            </fieldset>
          )}
          {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
          <div className="mt-4 flex flex-wrap items-end gap-3">
            <ComboboxField
              containerClassName="w-52"
              label="Offering type"
              labelAside={<InfoTip label="About offering types"><OfferingTypeHelp /></InfoTip>}
              value={type}
              onChange={(v) => setType(v as SubjectOfferingType)}
              options={OFFERING_TYPE_OPTIONS}
              searchPlaceholder="Search types…"
            />
            <Button
              disabled={picked.size === 0}
              loading={add.isPending}
              loadingText="Adding…"
              onClick={async () => {
                setError(null);
                try {
                  await add.mutateAsync();
                  setPicked(new Set());
                } catch (err) {
                  setError(messageFor(err));
                }
              }}
            >
              <Plus /> Add {picked.size || ''} Subject{picked.size === 1 ? '' : 's'}
            </Button>
          </div>

          <div className="mt-6 border-t border-line pt-4">
            <div className="flex items-end gap-3">
              <ComboboxField
                containerClassName="w-64"
                label="Copy from another class"
                value={copyFrom}
                onChange={setCopyFrom}
                placeholder="Choose a class…"
                options={(classes.data ?? []).filter((g) => g.classOfferingId !== classOfferingId).map((g) => ({ value: g.classOfferingId, label: g.displayName }))}
                searchPlaceholder="Search classes…"
              />
              <Button variant="outline" size="icon" aria-label="Copy subjects" title="Copy subjects" disabled={!copyFrom} loading={copy.isPending} onClick={() => copy.mutate(copyFrom)}>
                <Copy />
              </Button>
            </div>
            <p className="mt-2 text-sm text-muted">Only when you ask. Nothing is copied automatically.</p>
          </div>
        </Card>
      )}
    </div>
  );
}

export function SubjectsTab({ sessionId, locationId, readOnly, status }: TabProps) {
  const [classOfferingId, setClassOfferingId] = useState('');
  const masterSubjects = useSubjects({ status: 'ACTIVE' }, 200);
  const masterEmpty = !readOnly && masterSubjects.isSuccess && masterSubjects.data.items.length === 0;
  return (
    <div className="space-y-5">
      <TabIntro title="Subjects" need="required">
        <p>List the subjects taught in each class. Pick a class, then tick its subjects. Every class needs at least one subject.</p>
        <p><b>First time?</b> Subjects are chosen from your school’s subject list (the Subject Master). Add them there first, then come back here.</p>
        <p><b>Tip:</b> Once one class is done, use “Copy from another class” to save time.</p>
      </TabIntro>
      {masterEmpty ? (
        <Card>
          <EmptyState
            title="Add your school’s subjects first"
            description="Your subject list is empty, so there is nothing to pick here yet. Add subjects like English or Maths to the Subject Master, then come back to this tab and choose them for each class."
            action={
              <Button asChild>
                <Link to="/academics/subjects">
                  Go To Subject Master <ArrowRight />
                </Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <ClassPicker sessionId={sessionId} locationId={locationId} value={classOfferingId} onChange={setClassOfferingId}>
          {(id) => <Offerings key={id} classOfferingId={id} sessionId={sessionId} locationId={locationId} readOnly={readOnly} draft={status === 'DRAFT'} />}
        </ClassPicker>
      )}
    </div>
  );
}
