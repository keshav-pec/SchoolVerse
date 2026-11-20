import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { CHOICE_RULE_TYPES, CHOICE_RULE_TYPE_LABELS, type ChoiceRuleType, type ConstraintType, type SubjectOfferingDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useAcademicMutation, useChoiceGroups, useConstraints, useSubjectOfferings } from '../api';
import { ClassPicker } from '../class-picker';
import type { TabProps } from '../session-page';
import { HelpHeading, TabIntro } from '../help';
import { StatusToggle } from '../status-toggle';

function GroupForm({ classOfferingId, offerings }: { classOfferingId: string; offerings: SubjectOfferingDTO[] }) {
  const [name, setName] = useState('');
  const [ruleType, setRuleType] = useState<ChoiceRuleType>('CHOOSE_ONE');
  const [min, setMin] = useState('1');
  const [max, setMax] = useState('2');
  const [picked, setPicked] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const add = useAcademicMutation(
    (_: void) =>
      api.post(`/class-offerings/${classOfferingId}/choice-groups`, {
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
          <HelpHeading title="Add a choice group" helpLabel="How to add a choice group" help={<AddGroupHelp />} />
          <CardDescription>Give it a name, pick how many subjects a student takes, then tick the subjects. Example: “Language 1: choose one of Punjabi, Hindi, Urdu”.</CardDescription>
        </div>
      </CardHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Group name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Language 1" hint="A name staff will recognise, e.g. Second language." />
        <ComboboxField
          label="How many can a student take?"
          labelAside={<InfoTip label="About the choice types"><RuleTypeHelp /></InfoTip>}
          hint={RULE_TYPE_HINTS[ruleType]}
          value={ruleType}
          onChange={(v) => setRuleType(v as ChoiceRuleType)}
          options={CHOOSE_RULE_OPTIONS.map((t) => ({ value: t, label: CHOICE_RULE_TYPE_LABELS[t] }))}
          searchPlaceholder="Search rules…"
        />
        {ruleType === 'CHOOSE_N' && <TextField label="At least" type="number" min={0} value={min} onChange={(e) => setMin(e.target.value)} hint="Fewest subjects a student must pick." />}
        {(ruleType === 'CHOOSE_N' || ruleType === 'OPTIONAL') && <TextField label="At most" type="number" min={1} value={max} onChange={(e) => setMax(e.target.value)} hint="Most subjects a student may pick." />}
      </div>
      <fieldset className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <legend className="mb-1 text-sm font-semibold">Subjects in this group</legend>
        {offerings.length === 0 && <p className="text-sm text-muted sm:col-span-3">This class has no subjects yet. Add them on the Subjects tab first.</p>}
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
        <Plus /> Add Group
      </Button>
    </Card>
  );
}
const CHOOSE_RULE_OPTIONS = CHOICE_RULE_TYPES;

/** One line under the dropdown so the chosen type is explained without opening the help card. */
const RULE_TYPE_HINTS: Record<ChoiceRuleType, string> = {
  REQUIRED_ALL: 'Every student studies all the ticked subjects.',
  CHOOSE_ONE: 'Each student picks exactly one of the ticked subjects.',
  CHOOSE_N: 'Each student picks between “at least” and “at most” of them.',
  OPTIONAL: 'Students may skip these, or pick up to “at most” of them.',
};

function RuleTypeHelp() {
  return (
    <>
      <p>How many subjects from this group each student takes:</p>
      <ul>
        <li><b>Take all</b>: every subject in the group is compulsory.</li>
        <li><b>Choose one</b>: the student picks exactly one. Example: one of Hindi, Punjabi, Urdu.</li>
        <li><b>Choose a number</b>: the student picks a set number, e.g. 2 of 4 electives.</li>
        <li><b>Optional</b>: the student may pick none, or a few extras.</li>
      </ul>
    </>
  );
}

function AddGroupHelp() {
  return (
    <>
      <p><b>1.</b> Name the group, e.g. “Second language”.</p>
      <p><b>2.</b> Choose how many subjects a student takes from it.</p>
      <p><b>3.</b> Tick the subjects that belong in the group, then press Add group.</p>
      <p>A subject should sit in only one group.</p>
    </>
  );
}

function ConstraintForm({ classOfferingId, offerings }: { classOfferingId: string; offerings: SubjectOfferingDTO[] }) {
  const [type, setType] = useState<ConstraintType>('REQUIRES');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useAcademicMutation((_: void) => api.post(`/class-offerings/${classOfferingId}/constraints`, { type, subjectOfferingId: a, otherSubjectOfferingId: b }), { quiet: true, success: 'Rule added.' });
  const options = offerings.map((o) => ({ value: o.subjectOfferingId, label: o.subjectName }));
  return (
    <div className="mt-4 grid items-end gap-3 sm:grid-cols-[1fr_auto_1fr_auto]">
      <ComboboxField label="Subject" value={a} onChange={setA} placeholder="Choose…" options={options} searchPlaceholder="Search subjects…" />
      <ComboboxField
        label="Rule"
        labelAside={<InfoTip label="About requires and excludes"><LinkTypeHelp /></InfoTip>}
        value={type}
        onChange={(v) => setType(v as ConstraintType)}
        options={[{ value: 'REQUIRES', label: 'requires', hint: 'must also take' }, { value: 'EXCLUDES', label: 'excludes', hint: 'cannot take both' }]}
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
        <Plus /> Add Rule
      </Button>
      {error && <Alert tone="danger" className="sm:col-span-4">{error}</Alert>}
    </div>
  );
}

function LinkTypeHelp() {
  return (
    <ul>
      <li><b>requires</b>: a student who takes the first subject must also take the other. Example: Computer Science requires Mathematics.</li>
      <li><b>excludes</b>: a student cannot take both subjects. Example: Hindi excludes Sanskrit.</li>
    </ul>
  );
}

function Rules({ classOfferingId, readOnly, draft }: { classOfferingId: string; readOnly: boolean; draft: boolean }) {
  const groups = useChoiceGroups(classOfferingId);
  const constraints = useConstraints(classOfferingId);
  const offerings = useSubjectOfferings(classOfferingId);
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
        <HelpHeading
          title="Choice groups"
          helpLabel="What is a choice group?"
          help={
            <>
              <p>A <b>choice group</b> is a set of subjects where students <b>pick</b> instead of studying all of them.</p>
              <p>Example: “Second language: choose one of Hindi, Punjabi, Sanskrit”. Each student studies one of the three.</p>
              <p><b>Do I need one?</b> Only if students in this class choose between subjects. If everyone studies every subject, leave this empty.</p>
            </>
          }
        />
        <p className="text-sm text-muted">Use these when students choose between subjects, such as picking one second language.</p>
        {(groups.data ?? []).length === 0 && <p className="text-sm text-muted">No choice groups yet. That’s fine if every student in this class studies all of its subjects.</p>}
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
        {!readOnly && <GroupForm classOfferingId={classOfferingId} offerings={active} />}
      </section>

      <section aria-label="Subject rules" className="space-y-3">
        <HelpHeading
          title="Subject rules"
          helpLabel="What is a subject rule?"
          help={
            <>
              <p>A <b>subject rule</b> links two subjects, so one choice affects the other.</p>
              <LinkTypeHelp />
              <p><b>Do I need one?</b> Rarely. Most classes need none. Add one only when your board or school has such a rule.</p>
            </>
          }
        />
        <p className="text-sm text-muted">Link two subjects when taking one means a student must also take, or cannot take, the other.</p>
        {(constraints.data ?? []).length === 0 && <p className="text-sm text-muted">No subject rules yet. Most classes don’t need any.</p>}
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
        {!readOnly && <ConstraintForm classOfferingId={classOfferingId} offerings={active} />}
      </section>
    </div>
  );
}

export function RulesTab({ sessionId, locationId, readOnly, status }: TabProps) {
  const [classOfferingId, setClassOfferingId] = useState('');
  return (
    <div className="space-y-5">
      <TabIntro title="Subject Choice Rules" need="optional">
        <p>Set this up only when students <b>choose</b> their subjects, for example picking one second language, or electives in Class 11.</p>
        <p>If every student in a class studies the same subjects, you can skip this tab for that class.</p>
      </TabIntro>
      <ClassPicker sessionId={sessionId} locationId={locationId} value={classOfferingId} onChange={setClassOfferingId}>
        {(id) => <Rules key={id} classOfferingId={id} readOnly={readOnly} draft={status === 'DRAFT'} />}
      </ClassPicker>
    </div>
  );
}
