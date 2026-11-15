import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { PROGRAMME_KINDS, type ProgrammeDTO, type ProgrammeKind, type ProgrammeRequirement } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useAcademicMutation, useGradeMaster, useGradeOfferings, useProgrammes, useSubjectOfferingsOf } from '../api';
import type { TabProps } from '../session-page';
import { StatusToggle } from '../status-toggle';

const REQUIREMENTS: ProgrammeRequirement[] = ['REQUIRED', 'CHOICE', 'OPTIONAL'];

function ProgrammeForm({ sessionId, locationId }: { sessionId: string; locationId: string }) {
  const master = useGradeMaster();
  const offeringsAtLocation = useGradeOfferings(sessionId, locationId);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<ProgrammeKind>('STREAM');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [rules, setRules] = useState<Record<string, ProgrammeRequirement>>({});
  const [choice, setChoice] = useState({ min: '1', max: '1' });
  const [error, setError] = useState<string | null>(null);

  const grades = master.data ?? [];
  const seq = (id: string) => grades.find((g) => g.gradeId === id)?.sequenceNumber ?? 0;
  const senior = grades.filter((g) => g.sequenceNumber >= 3);
  const from = fromId || senior.find((g) => g.canonicalCode === 'G11')?.gradeId || '';
  const to = toId || senior.find((g) => g.canonicalCode === 'G12')?.gradeId || '';
  const inRange = useMemo(() => (offeringsAtLocation.data ?? []).filter((g) => seq(g.gradeId) >= seq(from) && seq(g.gradeId) <= seq(to)), [offeringsAtLocation.data, from, to, grades]); // eslint-disable-line react-hooks/exhaustive-deps
  const subjectQueries = useSubjectOfferingsOf(kind === 'STREAM' ? inRange.map((g) => g.gradeOfferingId) : []);
  const choiceCount = Object.values(rules).filter((r) => r === 'CHOICE').length;

  const add = useAcademicMutation(
    (_: void) =>
      api.post('/academic-programmes', {
        academicSessionId: sessionId,
        locationId,
        name,
        code,
        kind,
        gradeFromId: from,
        gradeToId: to,
        subjectRules: kind === 'STREAM' ? Object.entries(rules).map(([subjectOfferingId, requirement]) => ({ subjectOfferingId, requirement })) : [],
        ...(choiceCount > 0 ? { choiceMin: Number(choice.min), choiceMax: Number(choice.max) } : {}),
      }),
    { quiet: true, success: 'Programme added.' },
  );

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Add a programme</CardTitle>
          <CardDescription>A stream has fixed subjects. A flexible combination lets students pick within the grade’s choice rules.</CardDescription>
        </div>
      </CardHeader>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Science" />
        <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="SCI" />
        <SelectField label="Kind" value={kind} onChange={(e) => setKind(e.target.value as ProgrammeKind)}>
          {PROGRAMME_KINDS.map((k) => (
            <option key={k} value={k}>
              {k === 'STREAM' ? 'Stream' : 'Flexible combination'}
            </option>
          ))}
        </SelectField>
        <SelectField label="From grade" value={from} onChange={(e) => setFromId(e.target.value)}>
          {grades.map((g) => (
            <option key={g.gradeId} value={g.gradeId}>{g.canonicalName}</option>
          ))}
        </SelectField>
        <SelectField label="To grade" value={to} onChange={(e) => setToId(e.target.value)}>
          {grades.map((g) => (
            <option key={g.gradeId} value={g.gradeId}>{g.canonicalName}</option>
          ))}
        </SelectField>
      </div>

      {kind === 'STREAM' && (
        <fieldset className="mt-4">
          <legend className="mb-2 text-sm font-semibold">Subjects</legend>
          <ul className="grid gap-2 sm:grid-cols-2">
            {subjectQueries.flatMap((q, i) =>
              (q.data ?? [])
                .filter((o) => o.status === 'ACTIVE')
                .map((o) => (
                  <li key={o.subjectOfferingId} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
                    <span>
                      {o.subjectName} <span className="text-muted">({inRange[i]?.displayName})</span>
                    </span>
                    <select
                      aria-label={`Requirement for ${o.subjectName}`}
                      className="h-8 rounded-md border border-control bg-white px-2 text-sm"
                      value={rules[o.subjectOfferingId] ?? ''}
                      onChange={(e) => setRules((cur) => {
                        const next = { ...cur };
                        if (e.target.value) next[o.subjectOfferingId] = e.target.value as ProgrammeRequirement;
                        else delete next[o.subjectOfferingId];
                        return next;
                      })}
                    >
                      <option value="">Not included</option>
                      {REQUIREMENTS.map((r) => (
                        <option key={r} value={r}>{r.charAt(0) + r.slice(1).toLowerCase()}</option>
                      ))}
                    </select>
                  </li>
                )),
            )}
          </ul>
          {subjectQueries.length === 0 && <p className="text-sm text-muted">No grades in this range at this location yet.</p>}
          {choiceCount > 0 && (
            <div className="mt-3 flex gap-3">
              <TextField containerClassName="w-32" label="Choose at least" type="number" min={0} value={choice.min} onChange={(e) => setChoice({ ...choice, min: e.target.value })} />
              <TextField containerClassName="w-32" label="Choose at most" type="number" min={0} max={choiceCount} value={choice.max} onChange={(e) => setChoice({ ...choice, max: e.target.value })} />
            </div>
          )}
        </fieldset>
      )}
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      <Button
        className="mt-4"
        disabled={!name.trim() || !code.trim() || !from || !to}
        loading={add.isPending}
        loadingText="Adding…"
        onClick={async () => {
          setError(null);
          try {
            await add.mutateAsync();
            setName('');
            setCode('');
            setRules({});
          } catch (err) {
            setError(messageFor(err));
          }
        }}
      >
        <Plus /> Add programme
      </Button>
    </Card>
  );
}

export function ProgrammesTab({ sessionId, locationId, readOnly, status }: TabProps) {
  const programmes = useProgrammes(sessionId, locationId);
  const master = useGradeMaster();
  const toggle = useAcademicMutation(({ id, status }: { id: string; status: string }) => api.patch(`/academic-programmes/${id}`, { status }));
  const remove = useAcademicMutation((id: string) => api.delete<void>(`/academic-programmes/${id}`), { success: 'Programme removed.' });
  const name = (id: string) => master.data?.find((g) => g.gradeId === id)?.canonicalName ?? '';

  if (programmes.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading programmes" />;
  if (programmes.isError) return <ErrorState error={programmes.error} onRetry={() => void programmes.refetch()} retrying={programmes.isFetching} />;
  const list: ProgrammeDTO[] = programmes.data ?? [];

  return (
    <div className="space-y-6">
      {list.length === 0 ? (
        <Card>
          <EmptyState title="No programmes yet" description="Programmes (Science, Commerce, Humanities or a flexible combination) are for the senior grades. They are optional." />
        </Card>
      ) : (
        <ul className="grid gap-4 lg:grid-cols-2" aria-label="Programmes">
          {list.map((p) => (
            <li key={p.programmeId} className="rounded-card border border-line bg-white p-4">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="flex-1 text-base font-extrabold">
                  {p.name} <span className="text-sm font-medium text-muted">{p.code}</span>
                </h3>
                <Badge tone={p.kind === 'STREAM' ? 'brand' : 'mint'}>{p.kind === 'STREAM' ? 'Stream' : 'Flexible'}</Badge>
                <StatusToggle status={p.status} label={p.name} disabled={readOnly} onToggle={() => toggle.mutate({ id: p.programmeId, status: p.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })} />
                {!readOnly && status === 'DRAFT' && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${p.name}`} onClick={() => remove.mutate(p.programmeId)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
              <p className="text-[13px] text-muted">{name(p.gradeFromId)} to {name(p.gradeToId)}</p>
              {p.kind === 'FLEXIBLE' ? (
                <p className="mt-2 text-sm">Students pick any combination the grade’s choice rules allow.</p>
              ) : (
                <dl className="mt-3 space-y-1.5 text-sm">
                  {REQUIREMENTS.map((r) => {
                    const items = p.subjectRules.filter((s) => s.requirement === r);
                    if (items.length === 0) return null;
                    return (
                      <div key={r} className="flex gap-2">
                        <dt className="w-24 shrink-0 font-semibold">{r === 'CHOICE' && p.choiceMin !== null ? `Choose ${p.choiceMin === p.choiceMax ? p.choiceMin : `${p.choiceMin}–${p.choiceMax}`}` : r.charAt(0) + r.slice(1).toLowerCase()}</dt>
                        <dd>{items.map((s) => s.subjectName).join(', ')}</dd>
                      </div>
                    );
                  })}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
      {!readOnly && <ProgrammeForm sessionId={sessionId} locationId={locationId} />}
    </div>
  );
}
