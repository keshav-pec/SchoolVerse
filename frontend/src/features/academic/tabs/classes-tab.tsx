import { useState } from 'react';
import { ChevronDown, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import type { ApplySectionsResult, ClassMasterDTO, ClassOfferingDTO } from '@shared';
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
import { HelpHeading, TabIntro } from '@/components/sv/help';
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
            <Plus /> Add Sections
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
            <Button type="submit" loading={save.isPending} loadingText="Saving…">Save Class</Button>
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

/** Gives every class at this location the same sections in one step; classes that need more or fewer are adjusted one by one afterwards. */
function SectionsForAll({ sessionId, locationId, classCount }: { sessionId: string; locationId: string; classCount: number }) {
  const [text, setText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const apply = useAcademicMutation((codes: string[]) => api.post<ApplySectionsResult>(`/academic-sessions/${sessionId}/class-offerings/sections`, { locationId, codes }), {
    quiet: true,
    success: (r) =>
      r.sectionsAdded === 0
        ? 'Every class already has these sections.'
        : `Added ${r.sectionsAdded} section${r.sectionsAdded === 1 ? '' : 's'} across ${r.classesChanged} class${r.classesChanged === 1 ? '' : 'es'}.${r.sectionsSkipped > 0 ? ` ${r.sectionsSkipped} already existed and were left as they are.` : ''}`,
  });

  const submit = async () => {
    const codes = parseCodes(text);
    if (codes.length === 0) return setError('Enter at least one section code, e.g. A, B, C.');
    setError(null);
    try {
      await apply.mutateAsync(codes);
      setText('');
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <HelpHeading
            title="Sections for all classes"
            helpLabel="About sections for all classes"
            help={
              <>
                <p>Most schools use the same sections in every class, such as A, B and C. Type them once and press <b>Apply</b> to give them to every class listed here.</p>
                <p>Sections a class already has are left alone, so it is safe to press Apply again.</p>
                <p>If one class needs more or fewer, open it with the arrow and add or delete sections there.</p>
              </>
            }
          />
          <CardDescription>Type the sections once and give them to all {classCount} class{classCount === 1 ? '' : 'es'} at this location.</CardDescription>
        </div>
      </CardHeader>
      <form
        className="flex flex-wrap items-start gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="min-w-[220px] flex-1">
          <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Sections: A, B, C" aria-label="Sections to add to all classes" aria-invalid={!!error || undefined} />
          {error && (
            <p role="alert" className="mt-1.5 text-[13px] font-medium text-danger">
              {error}
            </p>
          )}
        </div>
        <Button type="submit" loading={apply.isPending} loadingText="Applying…">
          <Plus /> Apply To All {classCount} Class{classCount === 1 ? '' : 'es'}
        </Button>
      </form>
    </Card>
  );
}

function AddClasses({ sessionId, locationId, taken }: { sessionId: string; locationId: string; taken: Set<string> }) {
  const master = useClassMaster();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [medium, setMedium] = useState('');
  // What the school typed over the standard names, by class id. Classes it never touched are absent.
  const [typed, setTyped] = useState<Record<string, Partial<{ displayName: string; displayCode: string }>>>({});
  const [error, setError] = useState<string | null>(null);
  const all = master.data ?? [];
  const chosen = all.filter((g) => picked.has(g.classId));
  const nameOf = (g: ClassMasterDTO) => typed[g.classId]?.displayName ?? g.canonicalName;
  const codeOf = (g: ClassMasterDTO) => typed[g.classId]?.displayCode ?? g.shortCode;
  const blank = chosen.some((g) => !nameOf(g).trim() || !codeOf(g).trim());
  // Only classes that were actually renamed are sent; the rest keep the standard name.
  const labels = Object.fromEntries(
    chosen.filter((g) => nameOf(g).trim() !== g.canonicalName || codeOf(g).trim() !== g.shortCode).map((g) => [g.classId, { displayName: nameOf(g).trim(), displayCode: codeOf(g).trim() }]),
  );
  const add = useAcademicMutation((_: void) => api.post(`/academic-sessions/${sessionId}/class-offerings`, { locationId, classIds: [...picked], medium: medium || null, labels }), {
    quiet: true,
    success: 'Classes added.',
  });
  const setField = (g: ClassMasterDTO, patch: Partial<{ displayName: string; displayCode: string }>) => setTyped((cur) => ({ ...cur, [g.classId]: { ...cur[g.classId], ...patch } }));
  const toggle = (id: string) => setPicked((cur) => (cur.has(id) ? new Set([...cur].filter((x) => x !== id)) : new Set([...cur, id])));
  const available = all.filter((g) => !taken.has(g.classId));
  const selectAll = () => setPicked(new Set(available.map((g) => g.classId)));
  const clearAll = () => setPicked(new Set());

  return (
    <Card>
      <CardHeader>
        <div>
          <HelpHeading
            title="Add classes"
            helpLabel="How to add classes"
            help={
              <>
                <p>Tick every class taught at this location. Most schools teach most of these, so press <b>Select all</b> and untick the few you don’t teach. Then press Add.</p>
                <p>Schools with two kindergarten years can tick <b>LKG</b> and <b>UKG</b>. Use <b>KG</b> only if you have a single kindergarten year.</p>
                <p>Your school calls a class something else, such as “Playgroup” or “Std 1”? Tick it, then type your own name in the <b>Rename</b> box that appears below. You can also rename later with the pencil.</p>
                <p>After that, open each class with the arrow to add its sections.</p>
                <p>Classes already added are greyed out.</p>
              </>
            }
          />
          <CardDescription>Pick the classes taught at this location. You can rename them afterwards.</CardDescription>
        </div>
        {available.length > 0 && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={selectAll} disabled={picked.size === available.length}>Select All</Button>
            <Button variant="ghost" size="sm" onClick={clearAll} disabled={picked.size === 0}>Clear</Button>
          </div>
        )}
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
      {chosen.length > 0 && (
        <div className="mt-4 rounded-xl border border-line bg-canvas p-4">
          <p className="text-sm font-bold">Rename (optional)</p>
          <p className="mb-3 text-[13px] text-muted">Does your school use a different name? Type it here. Leave a row as it is to keep the standard name.</p>
          <ul className="space-y-2" aria-label="Rename selected classes">
            {chosen.map((g) => (
              <li key={g.classId} className="grid items-center gap-2 sm:grid-cols-[8rem_1fr_7rem]">
                <span className="text-sm text-muted">{g.canonicalName}</span>
                <Input value={nameOf(g)} maxLength={60} onChange={(e) => setField(g, { displayName: e.target.value })} aria-label={`Name for ${g.canonicalName}`} aria-invalid={!nameOf(g).trim() || undefined} />
                <Input value={codeOf(g)} maxLength={20} onChange={(e) => setField(g, { displayCode: e.target.value })} aria-label={`Short code for ${g.canonicalName}`} aria-invalid={!codeOf(g).trim() || undefined} />
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[13px] text-muted">The short code starts each section’s name: code “PG” with section A shows as PG-A.</p>
        </div>
      )}
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <TextField containerClassName="w-48" label="Medium (optional)" labelAside={<InfoTip label="About medium">The language these classes are taught in, such as English or Hindi. Leave it empty if you don’t need it.</InfoTip>} value={medium} onChange={(e) => setMedium(e.target.value)} placeholder="English" />
        <Button
          disabled={picked.size === 0 || blank}
          loading={add.isPending}
          loadingText="Adding…"
          onClick={async () => {
            setError(null);
            try {
              await add.mutateAsync();
              setPicked(new Set());
              setTyped({});
            } catch (err) {
              setError(messageFor(err));
            }
          }}
        >
          <Plus /> Add {picked.size || ''} {picked.size === 1 ? 'Class' : 'Classes'}
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
        <p>Add the classes first. Then give every class the same sections in one go, and open any class with the arrow if it needs more or fewer.</p>
      </TabIntro>
      {!readOnly && list.length > 0 && <SectionsForAll sessionId={sessionId} locationId={locationId} classCount={list.length} />}
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
