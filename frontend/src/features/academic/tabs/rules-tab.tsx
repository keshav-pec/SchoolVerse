import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CHOICE_RULE_TYPES, CHOICE_RULE_TYPE_LABELS, type ChoiceRuleType, type ConstraintType, type SubjectOfferingDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useAcademicMutation, useChoiceGroups, useConstraints, useSubjectOfferings } from '../api';
import { GradePicker } from '../grade-picker';
import type { TabProps } from '../session-page';
import { StatusToggle } from '../status-toggle';

function GroupForm({ gradeOfferingId, offerings }: { gradeOfferingId: string; offerings: SubjectOfferingDTO[] }) {
  const [name, setName] = useState('');
  const [ruleType, setRuleType] = useState<ChoiceRuleType>('CHOOSE_ONE');
  const [min, setMin] = useState('1');
  const [max, setMax] = useState('2');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const add = useAcademicMutation(
    (_: void) =>
      api.post(`/grade-offerings/${gradeOfferingId}/choice-groups`, {
        name,
        ruleType,
        subjectOfferingIds: picked,
        ...(ruleType === 'CHOOSE_N' ? { min: Number(min), max: Number(max) } : ruleType === 'OPTIONAL' ? { max: Number(max) } : {}),
      }),
    { quiet: true, success: 'Choice group added.' },
  );

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Add a choice group</CardTitle>
          <CardDescription>For example “Language 1: choose one of Punjabi, Hindi, Urdu”.</CardDescription>
        </div>
      </CardHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Group name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Language 1" />
        <ComboboxField
          label="Rule"
          value={ruleType}
          onChange={(v) => setRuleType(v as ChoiceRuleType)}
          options={CHOOSE_RULE_OPTIONS.map((t) => ({ value: t, label: CHOICE_RULE_TYPE_LABELS[t] }))}
          searchPlaceholder="Search rules…"
        />
        {ruleType === 'CHOOSE_N' && <TextField label="At least" type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} />}
        {(ruleType === 'CHOOSE_N' || ruleType === 'OPTIONAL') && <TextField label="At most" type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} />}
      </div>
      <fieldset className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Subjects in this group</legend>
        {offerings.map((o) => (
          <label key={o.subjectOfferingId} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
            <input type="checkbox" className="accent-[var(--color-brand)]" checked={picked.includes(o.subjectOfferingId)} onChange={() => setPicked((cur) => (cur.includes(o.subjectOfferingId) ? cur.filter((x) => x !== o.subjectOfferingId) : [...cur, o.subjectOfferingId]))} />
            {o.subjectName}
          </label>
        ))}
      </fieldset>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      <Button
        className="mt-4"
        disabled={!name.trim() || picked.length === 0}
        loading={add.isPending}
        loadingText="Adding…"
        onClick={async () => {
          setError(null);
          try {
            await add.mutateAsync();
            setName('');
            setPicked([]);
          } catch (err) {
            setError(messageFor(err));
          }
        }}
      >
        <Plus /> Add group
      </Button>
    </Card>
  );
}
const CHOOSE_RULE_OPTIONS = CHOICE_RULE_TYPES;

function ConstraintForm({ gradeOfferingId, offerings }: { gradeOfferingId: string; offerings: SubjectOfferingDTO[] }) {
  const [type, setType] = useState<ConstraintType>('REQUIRES');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useAcademicMutation((_: void) => api.post(`/grade-offerings/${gradeOfferingId}/constraints`, { type, subjectOfferingId: a, otherSubjectOfferingId: b }), { quiet: true, success: 'Rule added.' });
  const options = offerings.map((o) => ({ value: o.subjectOfferingId, label: o.subjectName }));
  return (
    <div className="mt-4 grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr_auto]">
      <ComboboxField label="Subject" value={a} onChange={setA} placeholder="Choose…" options={options} searchPlaceholder="Search subjects…" />
      <ComboboxField
        label="Rule"
        value={type}
        onChange={(v) => setType(v as ConstraintType)}
        options={[{ value: 'REQUIRES', label: 'requires' }, { value: 'EXCLUDES', label: 'excludes' }]}
        searchPlaceholder="Search rules…"
      />
      <ComboboxField label="Other subject" value={b} onChange={setB} placeholder="Choose…" options={options} searchPlaceholder="Search subjects…" />
      <Button
        disabled={!a || !b}
        loading={add.isPending}
        loadingText="Adding…"
        onClick={async () => {
          setError(null);
          try {
            await add.mutateAsync();
            setA('');
            setB('');
          } catch (err) {
            setError(messageFor(err));
          }
        }}
      >
        <Plus /> Add rule
      </Button>
      {error && <Alert tone="danger" className="sm:col-span-4">{error}</Alert>}
    </div>
  );
}

function Rules({ gradeOfferingId, readOnly, draft }: { gradeOfferingId: string; readOnly: boolean; draft: boolean }) {
  const groups = useChoiceGroups(gradeOfferingId);
  const constraints = useConstraints(gradeOfferingId);
  const offerings = useSubjectOfferings(gradeOfferingId);
  const toggle = useAcademicMutation(({ id, status }: { id: string; status: string }) => api.patch(`/choice-groups/${id}`, { status }));
  const removeGroup = useAcademicMutation((id: string) => api.delete<void>(`/choice-groups/${id}`), { success: 'Group removed.' });
  const removeConstraint = useAcademicMutation((id: string) => api.delete<void>(`/constraints/${id}`), { success: 'Rule removed.' });

  if (groups.isLoading || constraints.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading rules" />;
  if (groups.isError) return <ErrorState error={groups.error} onRetry={() => void groups.refetch()} retrying={groups.isFetching} />;
  if (constraints.isError) return <ErrorState error={constraints.error} onRetry={() => void constraints.refetch()} retrying={constraints.isFetching} />;
  const active = (offerings.data ?? []).filter((o) => o.status === 'ACTIVE');

  return (
    <div className="space-y-6">
      <section aria-label="Choice groups" className="space-y-3">
        <h2 className="text-lg font-bold">Choice groups</h2>
        {(groups.data ?? []).length === 0 && <p className="text-sm text-muted">No choice groups. Every subject is simply offered.</p>}
        <ul className="space-y-3">
          {(groups.data ?? []).map((g) => (
            <li key={g.choiceGroupId} className="rounded-xl border border-line bg-white px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold">
                    {g.name} <Badge tone="lavender" className="ml-1.5">{CHOICE_RULE_TYPE_LABELS[g.ruleType]}</Badge>
                  </p>
                  <p className="mt-0.5 text-sm text-ink">{g.summary}</p>
                </div>
                <StatusToggle status={g.status} label={g.name} disabled={readOnly} onToggle={() => toggle.mutate({ id: g.choiceGroupId, status: g.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })} />
                {!readOnly && draft && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete group ${g.name}`} onClick={() => removeGroup.mutate(g.choiceGroupId)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {!readOnly && <GroupForm gradeOfferingId={gradeOfferingId} offerings={active} />}
      </section>

      <section aria-label="Subject rules" className="space-y-3">
        <h2 className="text-lg font-bold">Subject rules</h2>
        {(constraints.data ?? []).length === 0 && <p className="text-sm text-muted">No “requires” or “excludes” rules.</p>}
        <ul className="space-y-2">
          {(constraints.data ?? []).map((c) => (
            <li key={c.constraintId} className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-2.5 text-sm">
              <span className="flex-1 font-semibold">{c.summary}</span>
              {!readOnly && (
                <Button variant="ghost" size="icon-sm" aria-label={`Remove rule: ${c.summary}`} onClick={() => removeConstraint.mutate(c.constraintId)}>
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ul>
        {!readOnly && <ConstraintForm gradeOfferingId={gradeOfferingId} offerings={active} />}
      </section>
    </div>
  );
}

export function RulesTab({ sessionId, locationId, readOnly, status }: TabProps) {
  const [gradeOfferingId, setGradeOfferingId] = useState('');
  return (
    <GradePicker sessionId={sessionId} locationId={locationId} value={gradeOfferingId} onChange={setGradeOfferingId}>
      {(id) => <Rules key={id} gradeOfferingId={id} readOnly={readOnly} draft={status === 'DRAFT'} />}
    </GradePicker>
  );
}
