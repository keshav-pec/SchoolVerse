import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { PROGRAMME_KINDS, type ProgrammeDTO, type ProgrammeKind, type ProgrammeRequirement } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useAcademicMutation, useClassMaster, useClassOfferings, useProgrammes, useSubjectOfferingsOf } from '../api';
import type { TabProps } from '../session-page';
import { HelpHeading, TabIntro } from '../help';
import { StatusToggle } from '../status-toggle';

const REQUIREMENTS: ProgrammeRequirement[] = ['REQUIRED', 'CHOICE', 'OPTIONAL'];
const REQUIREMENT_OPTIONS = [{ value: '', label: 'Not included' }, ...REQUIREMENTS.map((r) => ({ value: r, label: r.charAt(0) + r.slice(1).toLowerCase() }))];

function ProgrammeForm({ sessionId, locationId }: { sessionId: string; locationId: string }) {
  const master = useClassMaster();
  const offeringsAtLocation = useClassOfferings(sessionId, locationId);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<ProgrammeKind>('STREAM');
  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [rules, setRules] = useState<Record<string, ProgrammeRequirement>>({});
  const [choice, setChoice] = useState({ min: '1', max: '1' });
  const [error, setError] = useState<string | null>(null);

  const classes = master.data ?? [];
  const classOptions = classes.map((g) => ({ value: g.classId, label: g.canonicalName }));
  const seq = (id: string) => classes.find((g) => g.classId === id)?.sequenceNumber ?? 0;
  const senior = classes.filter((g) => g.sequenceNumber >= 3);
  const from = fromId || senior.find((g) => g.canonicalCode === 'G11')?.classId || '';
  const to = toId || senior.find((g) => g.canonicalCode === 'G12')?.classId || '';
  const inRange = useMemo(() => (offeringsAtLocation.data ?? []).filter((g) => seq(g.classId) >= seq(from) && seq(g.classId) <= seq(to)), [offeringsAtLocation.data, from, to, classes]); // eslint-disable-line react-hooks/exhaustive-deps
  const subjectQueries = useSubjectOfferingsOf(kind === 'STREAM' ? inRange.map((g) => g.classOfferingId) : []);
  const choiceCount = Object.values(rules).filter((r) => r === 'CHOICE').length;

  const add = useAcademicMutation(
    (_: void) =>
      api.post('/academic-programmes', {
        academicSessionId: sessionId,
        locationId,
        name,
        code,
        kind,
        classFromId: from,
        classToId: to,
        subjectRules: kind === 'STREAM' ? Object.entries(rules).map(([subjectOfferingId, requirement]) => ({ subjectOfferingId, requirement })) : [],
        ...(choiceCount > 0 ? { choiceMin: Number(choice.min), choiceMax: Number(choice.max) } : {}),
      }),
    { quiet: true, success: 'Programme added.' },
  );

  return (
    <Card>
      <CardHeader>
        <div>
          <HelpHeading
            title="Add a programme"
            helpLabel="How to add a programme"
            help={
              <>
                <p><b>1.</b> Give it a name and short code, e.g. Science / SCI.</p>
                <p><b>2.</b> Choose the kind: a fixed stream, or a flexible combination.</p>
                <p><b>3.</b> Pick the classes it covers, usually Class 11 to Class 12.</p>
                <p><b>4.</b> For a stream, mark each subject as Required, Choice or Optional.</p>
              </>
            }
          />
          <CardDescription>A stream has a fixed set of subjects. A flexible combination lets students pick any subjects the Subject Choice Rules allow.</CardDescription>
        </div>
      </CardHeader>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Science" />
        <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="SCI" hint="A short form, used in lists and reports." />
        <ComboboxField
          label="Kind"
          labelAside={
            <InfoTip label="About programme kinds">
              <ul>
                <li><b>Stream</b>: a fixed bundle of subjects, e.g. Science = Physics, Chemistry, Mathematics, English.</li>
                <li><b>Flexible combination</b>: no fixed bundle. Students pick any subjects that the class’s Subject Choice Rules allow.</li>
              </ul>
            </InfoTip>
          }
          value={kind}
          onChange={(v) => setKind(v as ProgrammeKind)}
          options={PROGRAMME_KINDS.map((k) => ({ value: k, label: k === 'STREAM' ? 'Stream' : 'Flexible combination' }))}
          searchPlaceholder="Search kinds…"
        />
        <ComboboxField label="From class" value={from} onChange={setFromId} options={classOptions} searchPlaceholder="Search classes…" hint="First class this programme covers." />
        <ComboboxField label="To class" value={to} onChange={setToId} options={classOptions} searchPlaceholder="Search classes…" hint="Last class this programme covers." />
      </div>

      {kind === 'STREAM' && (
        <fieldset className="mt-4">
          <legend className="mb-2 flex items-center gap-1.5 text-sm font-semibold">
            Subjects
            <InfoTip label="About subject requirements">
              <p>For each subject, choose how it fits this stream:</p>
              <ul>
                <li><b>Required</b>: every student in the stream studies it.</li>
                <li><b>Choice</b>: students pick from these. Set how many below.</li>
                <li><b>Optional</b>: students may add it as an extra.</li>
                <li><b>Not included</b>: not part of this stream.</li>
              </ul>
            </InfoTip>
          </legend>
          <ul className="grid gap-2 sm:grid-cols-2">
            {subjectQueries.flatMap((q, i) =>
              (q.data ?? [])
                .filter((o) => o.status === 'ACTIVE')
                .map((o) => (
                  <li key={o.subjectOfferingId} className="flex items-center justify-between gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
                    <span>
                      {o.subjectName} <span className="text-muted">({inRange[i]?.displayName})</span>
                    </span>
                    <Combobox
                      aria-label={`Requirement for ${o.subjectName}`}
                      className="h-8 w-40 rounded-md px-2"
                      value={rules[o.subjectOfferingId] ?? ''}
                      onChange={(v) => setRules((cur) => {
                        const next = { ...cur };
                        if (v) next[o.subjectOfferingId] = v as ProgrammeRequirement;
                        else delete next[o.subjectOfferingId];
                        return next;
                      })}
                      options={REQUIREMENT_OPTIONS}
                      searchPlaceholder="Search…"
                    />
                  </li>
                )),
            )}
          </ul>
          {subjectQueries.length === 0 && <p className="text-sm text-muted">No classes in this range at this location yet.</p>}
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
        <Plus /> Add Programme
      </Button>
    </Card>
  );
}

export function ProgrammesTab({ sessionId, locationId, readOnly, status }: TabProps) {
  const programmes = useProgrammes(sessionId, locationId);
  const master = useClassMaster();
  const toggle = useAcademicMutation(({ id, status }: { id: string; status: string }) => api.patch(`/academic-programmes/${id}`, { status }));
  const remove = useAcademicMutation((id: string) => api.delete<void>(`/academic-programmes/${id}`), { success: 'Programme removed.' });
  const name = (id: string) => master.data?.find((g) => g.classId === id)?.canonicalName ?? '';

  if (programmes.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading programmes" />;
  if (programmes.isError) return <ErrorState error={programmes.error} onRetry={() => void programmes.refetch()} retrying={programmes.isFetching} />;
  const list: ProgrammeDTO[] = programmes.data ?? [];

  return (
    <div className="space-y-6">
      <TabIntro title="Programmes" need="optional">
        <p>
          A <b>programme</b> is a stream students join in the senior classes, such as Science, Commerce or Humanities. It decides which subjects those students study.
        </p>
        <p>Skip this tab if your school has no streams, or only teaches up to Class 10.</p>
      </TabIntro>
      {list.length === 0 ? (
        <Card>
          <EmptyState title="No programmes yet" description="Programmes (Science, Commerce, Humanities or a flexible combination) are for the senior classes. They are optional." />
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
              <p className="text-[13px] text-muted">{name(p.classFromId)} to {name(p.classToId)}</p>
              {p.kind === 'FLEXIBLE' ? (
                <p className="mt-2 text-sm">Students pick any combination the class’s Subject Choice Rules allow.</p>
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
