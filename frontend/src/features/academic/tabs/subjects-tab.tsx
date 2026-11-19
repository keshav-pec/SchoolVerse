import { useState } from 'react';
import { Copy, Link2, Plus, Trash2, Unlink } from 'lucide-react';
import { SUBJECT_OFFERING_TYPES, SUBJECT_OFFERING_TYPE_LABELS, type SubjectOfferingDTO, type SubjectOfferingType } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { ComboboxField } from '@/components/ui/field';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useAcademicMutation, useGradeOfferings, useSession, useSubjectOfferings, useSubjects } from '../api';
import { GradePicker } from '../grade-picker';
import type { TabProps } from '../session-page';
import { StatusToggle } from '../status-toggle';

const OFFERING_TYPE_OPTIONS = SUBJECT_OFFERING_TYPES.map((t) => ({ value: t, label: SUBJECT_OFFERING_TYPE_LABELS[t] }));

function Offerings({ gradeOfferingId, sessionId, locationId, readOnly, draft }: { gradeOfferingId: string; sessionId: string; locationId: string; readOnly: boolean; draft: boolean }) {
  const offerings = useSubjectOfferings(gradeOfferingId);
  const subjects = useSubjects({ status: 'ACTIVE' }, 200);
  const session = useSession(sessionId);
  const grades = useGradeOfferings(sessionId, locationId);
  const pinned = session.data?.locations.find((l) => l.locationId === locationId)?.boardRuleVersionId;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [type, setType] = useState<SubjectOfferingType>('MANDATORY');
  const [copyFrom, setCopyFrom] = useState('');
  const [error, setError] = useState<string | null>(null);

  const add = useAcademicMutation((_: void) => api.post(`/grade-offerings/${gradeOfferingId}/subjects`, { subjectIds: [...picked], offeringType: type }), { quiet: true, success: 'Subjects added.' });
  const patch = useAcademicMutation(({ id, body }: { id: string; body: Record<string, unknown> }) => api.patch(`/subject-offerings/${id}`, body));
  const remove = useAcademicMutation((id: string) => api.delete<void>(`/subject-offerings/${id}`), { success: 'Subject removed.' });
  const copy = useAcademicMutation((from: string) => api.post<{ created: unknown[]; skipped: number }>(`/grade-offerings/${gradeOfferingId}/subjects/copy-from/${from}`), {
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
          <EmptyState title="No subjects offered yet" description={readOnly ? undefined : 'Add subjects below, or copy the list from another grade.'} />
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
                    <Link2 /> Map to {mapping.boardSubjectCode}
                  </Button>
                )}
                {!readOnly && o.boardSubjectDefinitionId && (
                  <Button variant="ghost" size="sm" onClick={() => patch.mutate({ id: o.subjectOfferingId, body: { boardSubjectDefinitionId: null } })}>
                    <Unlink /> Unlink board code
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
              <CardTitle>Add subjects</CardTitle>
              <CardDescription>Choose from the subject master. Board codes link up on their own when a mapping exists.</CardDescription>
            </div>
          </CardHeader>
          {available.length === 0 ? (
            <p className="text-sm text-muted">Every active subject is already offered for this grade.</p>
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
              <Plus /> Add {picked.size || ''} subject{picked.size === 1 ? '' : 's'}
            </Button>
          </div>

          <div className="mt-6 flex flex-wrap items-end gap-3 border-t border-line pt-4">
            <ComboboxField
              containerClassName="w-64"
              label="Copy from another grade"
              value={copyFrom}
              onChange={setCopyFrom}
              hint="Only when you ask. Nothing is copied automatically."
              placeholder="Choose a grade…"
              options={(grades.data ?? []).filter((g) => g.gradeOfferingId !== gradeOfferingId).map((g) => ({ value: g.gradeOfferingId, label: g.displayName }))}
              searchPlaceholder="Search grades…"
            />
            <Button variant="outline" disabled={!copyFrom} loading={copy.isPending} loadingText="Copying…" onClick={() => copy.mutate(copyFrom)}>
              <Copy /> Copy subjects
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

export function SubjectsTab({ sessionId, locationId, readOnly, status }: TabProps) {
  const [gradeOfferingId, setGradeOfferingId] = useState('');
  return (
    <GradePicker sessionId={sessionId} locationId={locationId} value={gradeOfferingId} onChange={setGradeOfferingId}>
      {(id) => <Offerings key={id} gradeOfferingId={id} sessionId={sessionId} locationId={locationId} readOnly={readOnly} draft={status === 'DRAFT'} />}
    </GradePicker>
  );
}
