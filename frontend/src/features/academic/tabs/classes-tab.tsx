import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ClassOfferingDTO } from '@shared';
import { EmptyMap } from '@/components/illustrations/empty-map';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { A, useAcademicMutation, useClassMaster, useClassOfferings, useSections } from '../api';
import type { TabProps } from '../session-page';
import { HelpHeading, TabIntro } from '../help';
import { StatusToggle } from '../status-toggle';

/** "A, B c" → ["A", "B", "C"]. Codes are compared in upper case. */
export function parseCodes(text: string): string[] {
  return text.split(/[\s,;]+/).map((c) => c.trim().toUpperCase()).filter(Boolean);
}

function Sections({ schoolClass, readOnly, draft }: { schoolClass: ClassOfferingDTO; readOnly: boolean; draft: boolean }) {
  const sections = useSections(schoolClass.classOfferingId);
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useAcademicMutation((codes: string[]) => api.post(`/class-offerings/${schoolClass.classOfferingId}/sections`, { codes }), { quiet: true, success: 'Sections added.' });
  const toggle = useAcademicMutation(({ id, status }: { id: string; status: string }) => api.patch(`/sections/${id}`, { status }), {});
  const remove = useAcademicMutation((id: string) => api.delete<void>(`/sections/${id}`), { success: 'Section removed.' });

  const submit = async () => {
    const codes = parseCodes(text);
    if (codes.length === 0) return setError('Enter at least one section code, e.g. A, B, C.');
    setError(null);
    try {
      await add.mutateAsync(codes);
      setText('');
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <div className="space-y-3 bg-canvas px-4 py-4 sm:px-5">
      {sections.isLoading ? (
        <Skeleton className="h-8 w-48" />
      ) : sections.isError ? (
        <ErrorState error={sections.error} onRetry={() => void sections.refetch()} retrying={sections.isFetching} />
      ) : (
        <ul className="flex flex-wrap gap-2" aria-label={`Sections of ${schoolClass.displayName}`}>
          {(sections.data ?? []).length === 0 && <li className="text-sm text-muted">No sections yet.</li>}
          {(sections.data ?? []).map((s) => (
            <li key={s.sectionOfferingId} className="flex items-center gap-2 rounded-xl border border-line bg-white py-1.5 pr-2 pl-3 text-sm">
              <span className="font-bold">{schoolClass.displayCode}-{s.sectionCode}</span>
              {s.displayName !== s.sectionCode && <span className="text-muted">{s.displayName}</span>}
              <StatusToggle status={s.status} label={`section ${s.sectionCode}`} disabled={readOnly} onToggle={() => toggle.mutate({ id: s.sectionOfferingId, status: s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })} />
              <Can permission="academic:manage">
                {draft && !readOnly && (
                  <button type="button" className="grid size-7 place-items-center rounded-md text-muted hover:bg-danger-soft hover:text-danger" aria-label={`Delete section ${s.sectionCode}`} onClick={() => remove.mutate(s.sectionOfferingId)}>
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </Can>
            </li>
          ))}
        </ul>
      )}
      {!readOnly && (
        <form
          className="flex flex-wrap items-start gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="min-w-[220px] flex-1">
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add sections: A, B, C" aria-label={`Add sections to ${schoolClass.displayName}`} aria-invalid={!!error || undefined} />
            {error && (
              <p role="alert" className="mt-1.5 text-[13px] font-medium text-danger">
                {error}
              </p>
            )}
          </div>
          <Button type="submit" variant="secondary" loading={add.isPending} loadingText="Adding…">
            <Plus /> Add sections
          </Button>
        </form>
      )}
    </div>
  );
}

function ClassRow({ schoolClass, readOnly, draft, queryKey }: { schoolClass: ClassOfferingDTO; readOnly: boolean; draft: boolean; queryKey: readonly unknown[] }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState({ displayName: schoolClass.displayName, displayCode: schoolClass.displayCode, medium: schoolClass.medium ?? '', capacity: schoolClass.capacity?.toString() ?? '' });
  const [error, setError] = useState<string | null>(null);

  // Optimistic: the pill flips at once and rolls back if the server refuses (e.g. downstream dependencies).
  const toggle = useAcademicMutation((status: string) => api.patch(`/class-offerings/${schoolClass.classOfferingId}`, { status }), {
    optimistic: { key: queryKey as never, update: (old: ClassOfferingDTO[], status) => old.map((g) => (g.classOfferingId === schoolClass.classOfferingId ? { ...g, status: status as ClassOfferingDTO['status'] } : g)) },
  });
  const save = useAcademicMutation(
    (_: void) => api.patch(`/class-offerings/${schoolClass.classOfferingId}`, { displayName: form.displayName, displayCode: form.displayCode, medium: form.medium || null, capacity: form.capacity ? Number(form.capacity) : null }),
    { quiet: true, success: 'Class updated.' },
  );
  const remove = useAcademicMutation((_: void) => api.delete<void>(`/class-offerings/${schoolClass.classOfferingId}`), { success: 'Class removed.' });

  return (
    <li className="overflow-hidden rounded-xl border border-line bg-white">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} sections of ${schoolClass.displayName}`} className="grid size-8 place-items-center rounded-lg hover:bg-ink/5">
          {open ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <p className="font-bold">{schoolClass.displayName}</p>
          <p className="text-[13px] text-muted">
            {schoolClass.sectionCount} section{schoolClass.sectionCount === 1 ? '' : 's'} · {schoolClass.subjectCount} subject{schoolClass.subjectCount === 1 ? '' : 's'}
            {schoolClass.medium ? ` · ${schoolClass.medium}` : ''}
            {schoolClass.capacity ? ` · capacity ${schoolClass.capacity}` : ''}
          </p>
        </div>
        <StatusToggle status={schoolClass.status} label={schoolClass.displayName} disabled={readOnly} onToggle={() => toggle.mutate(schoolClass.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE')} />
        {!readOnly && (
          <>
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${schoolClass.displayName}`} onClick={() => setEditing(!editing)}>
              <Pencil />
            </Button>
            {draft && (
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${schoolClass.displayName}`} onClick={() => setDeleting(true)}>
                <Trash2 />
              </Button>
            )}
          </>
        )}
      </div>
      {editing && !readOnly && (
        <form
          className="grid gap-3 border-t border-line bg-canvas px-4 py-4 sm:grid-cols-4"
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            try {
              await save.mutateAsync();
              setEditing(false);
            } catch (err) {
              setError(messageFor(err));
            }
          }}
        >
          <TextField label="Display name" value={form.displayName} onChange={(e) => setForm({ ...form, displayName: e.target.value })} hint="Class VIII, Standard 8…" />
          <TextField label="Display code" value={form.displayCode} onChange={(e) => setForm({ ...form, displayCode: e.target.value })} hint="Short form used in section names." labelAside={<InfoTip label="About the display code">A short form of the class name. It starts each section’s name: code “8” with section A shows as 8-A.</InfoTip>} />
          <TextField label="Medium" value={form.medium} onChange={(e) => setForm({ ...form, medium: e.target.value })} hint="Teaching language, e.g. English." labelAside={<InfoTip label="About medium">The language this class is taught in, such as English or Hindi. Leave it empty if every class uses the same language.</InfoTip>} />
          <TextField label="Capacity" type="number" min={1} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} hint="Most students allowed." labelAside={<InfoTip label="About capacity">The most students this class can take across all its sections. Leave it empty if there’s no limit.</InfoTip>} />
          {error && <Alert tone="danger" className="sm:col-span-4">{error}</Alert>}
          <div className="sm:col-span-4">
            <Button type="submit" loading={save.isPending} loadingText="Saving…">Save class</Button>
          </div>
        </form>
      )}
      {open && <Sections schoolClass={schoolClass} readOnly={readOnly} draft={draft} />}
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        tone="danger"
        title={`Delete ${schoolClass.displayName}?`}
        description="Removes this class with its sections and subjects from the draft session."
        confirmLabel="Delete class"
        loadingLabel="Deleting…"
        onConfirm={async () => void (await remove.mutateAsync())}
      />
    </li>
  );
}

function AddClasses({ sessionId, locationId, taken }: { sessionId: string; locationId: string; taken: Set<string> }) {
  const master = useClassMaster();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [medium, setMedium] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useAcademicMutation((_: void) => api.post(`/academic-sessions/${sessionId}/class-offerings`, { locationId, classIds: [...picked], medium: medium || null }), {
    quiet: true,
    success: 'Classes added.',
  });
  const all = master.data ?? [];
  const toggle = (id: string) => setPicked((cur) => (cur.has(id) ? new Set([...cur].filter((x) => x !== id)) : new Set([...cur, id])));
  // Nursery to XII: everything except Pre-Nursery.
  const quickPick = () => setPicked(new Set(all.filter((g) => g.canonicalCode !== 'PRE_NURSERY' && !taken.has(g.classId)).map((g) => g.classId)));

  return (
    <Card>
      <CardHeader>
        <div>
          <HelpHeading
            title="Add classes"
            helpLabel="How to add classes"
            help={
              <>
                <p>Tick every class taught at this location, or press <b>Nursery–XII</b> to tick them all at once. Then press Add.</p>
                <p>After that, open each class with the arrow to add its sections.</p>
                <p>Classes already added are greyed out.</p>
              </>
            }
          />
          <CardDescription>Pick the classes taught at this location. You can rename them afterwards.</CardDescription>
        </div>
        <Button variant="outline" size="sm" onClick={quickPick}>Nursery–XII</Button>
      </CardHeader>
      <fieldset className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        <legend className="sr-only">Classes</legend>
        {all.map((g) => (
          <label key={g.classId} className={`flex items-center gap-2 rounded-lg border px-3 py-2 text-sm ${taken.has(g.classId) ? 'border-line bg-canvas text-muted' : 'border-line hover:border-brand/50'}`}>
            <input type="checkbox" className="accent-[var(--color-brand)]" disabled={taken.has(g.classId)} checked={picked.has(g.classId) || taken.has(g.classId)} onChange={() => toggle(g.classId)} />
            {g.canonicalName}
          </label>
        ))}
      </fieldset>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <TextField containerClassName="w-48" label="Medium (optional)" labelAside={<InfoTip label="About medium">The language these classes are taught in, such as English or Hindi. Leave it empty if you don’t need it.</InfoTip>} value={medium} onChange={(e) => setMedium(e.target.value)} placeholder="English" />
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
          <Plus /> Add {picked.size || ''} class{picked.size === 1 ? '' : 's'}
        </Button>
      </div>
    </Card>
  );
}

export function ClassesTab({ sessionId, locationId, readOnly, status }: TabProps) {
  const classes = useClassOfferings(sessionId, locationId);
  const draft = status === 'DRAFT';
  const queryKey = [...A, 'class-offerings', sessionId, locationId];

  if (classes.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading classes" />;
  if (classes.isError) return <ErrorState error={classes.error} onRetry={() => void classes.refetch()} retrying={classes.isFetching} />;
  const list = classes.data ?? [];

  return (
    <div className="space-y-6">
      <TabIntro title="Classes & Sections" need="required">
        <p>
          A <b>class</b> is the year of study, such as Nursery, Class 1 or Class 12. A <b>section</b> is one group of students inside a class, usually one classroom with its own class teacher.
        </p>
        <p>Example: Class 6 with sections A and B gives you 6-A and 6-B. Add the classes first, then open each one with the arrow to add its sections.</p>
      </TabIntro>
      {list.length === 0 ? (
        <Card>
          <EmptyState illustration={<EmptyMap className="w-44" />} title="No classes at this location yet" description={readOnly ? 'Nothing has been set up here.' : 'Add the classes taught here, then give each one its sections.'} />
        </Card>
      ) : (
        <ul className="space-y-3" aria-label="Classes">
          {list.map((g) => (
            <ClassRow key={g.classOfferingId} schoolClass={g} readOnly={readOnly} draft={draft} queryKey={queryKey} />
          ))}
        </ul>
      )}
      {!readOnly && <AddClasses sessionId={sessionId} locationId={locationId} taken={new Set(list.map((g) => g.classId))} />}
    </div>
  );
}
