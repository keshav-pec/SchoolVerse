import { useState } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ChevronLeft, ChevronRight, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { SUBJECT_CATEGORIES, SUBJECT_CATEGORY_LABELS, type SubjectCategory, type SubjectDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { ApiError, api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useAcademicMutation, useAllRuleVersions, useBoards, useClassMaster, useSubjects, type SubjectParams } from './api';
import { StatusToggle } from './status-toggle';

const CATEGORY_OPTIONS = SUBJECT_CATEGORIES.map((c) => ({ value: c, label: SUBJECT_CATEGORY_LABELS[c] }));

const EMPTY = { subjectCode: '', name: '', shortName: '', category: 'OTHER' as SubjectCategory, languageCode: '', hasTheory: true, hasPractical: false, hasProject: false, hasInternalAssessment: false };

function BoardCodes({ subject }: { subject: SubjectDTO }) {
  const boards = useBoards();
  const versions = useAllRuleVersions(boards.data ?? []);
  const options = (boards.data ?? []).flatMap((b, i) => (versions[i]?.data ?? []).filter((v) => v.status === 'PUBLISHED').map((v) => ({ id: v.ruleVersionId, label: `${b.boardCode} · ${v.name}` })));
  const [versionId, setVersionId] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const set = useAcademicMutation((_: void) => api.put<SubjectDTO>(`/subjects/${subject.subjectId}/board-codes`, { boardRuleVersionId: versionId || options[0]?.id, boardSubjectCode: code }), { quiet: true, success: 'Board code saved.' });
  const remove = useAcademicMutation((ruleVersionId: string) => api.delete<SubjectDTO>(`/subjects/${subject.subjectId}/board-codes/${ruleVersionId}`), { success: 'Board code removed.' });

  return (
    <section aria-label="Board codes" className="mt-6 border-t border-line pt-4">
      <h3 className="text-sm font-bold">Board subject codes</h3>
      <p className="mb-3 text-[13px] text-muted">The official code on each board’s rule version. The subject itself stays the same when a code changes.</p>
      <ul className="mb-3 space-y-1.5">
        {subject.boardCodes.length === 0 && <li className="text-sm text-muted">No board codes yet.</li>}
        {subject.boardCodes.map((c) => (
          <li key={c.definitionId} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-sm">
            <span className="flex-1">{c.boardCode} · {c.ruleVersionName}: <strong>{c.boardSubjectCode}</strong></span>
            <Button variant="ghost" size="icon-sm" aria-label={`Remove ${c.boardCode} code`} onClick={() => remove.mutate(c.boardRuleVersionId)}>
              <Trash2 />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <ComboboxField
          containerClassName="w-48"
          label="Board · version"
          value={versionId || options[0]?.id || ''}
          onChange={setVersionId}
          options={options.map((o) => ({ value: o.id, label: o.label }))}
          searchPlaceholder="Search versions…"
        />
        <TextField containerClassName="w-32" label="Code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="041" />
        <Button
          variant="secondary"
          disabled={!code.trim() || options.length === 0}
          loading={set.isPending}
          loadingText="Saving…"
          onClick={async () => {
            setError(null);
            try {
              await set.mutateAsync();
              setCode('');
            } catch (err) {
              setError(messageFor(err));
            }
          }}
        >
          Save code
        </Button>
      </div>
      {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
    </section>
  );
}

function SubjectDrawer({ open, onOpenChange, subject }: { open: boolean; onOpenChange: (o: boolean) => void; subject: SubjectDTO | null }) {
  const [form, setForm] = useState(EMPTY);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const key = subject?.subjectId ?? null;
  if (open && loadedFor !== key) {
    setLoadedFor(key);
    setErrors({});
    setBanner(null);
    setForm(subject ? { subjectCode: subject.subjectCode, name: subject.name, shortName: subject.shortName ?? '', category: subject.category, languageCode: subject.languageCode ?? '', hasTheory: subject.hasTheory, hasPractical: subject.hasPractical, hasProject: subject.hasProject, hasInternalAssessment: subject.hasInternalAssessment } : EMPTY);
  }
  if (!open && loadedFor !== undefined) setLoadedFor(undefined);

  const save = useAcademicMutation(
    (_: void) => {
      const body = { ...form, shortName: form.shortName || null, languageCode: form.languageCode || null };
      return subject ? api.patch<SubjectDTO>(`/subjects/${subject.subjectId}`, body) : api.post<SubjectDTO>('/subjects', body);
    },
    { quiet: true, success: subject ? 'Subject updated.' : 'Subject added.' },
  );

  const submit = async () => {
    setErrors({});
    setBanner(null);
    try {
      await save.mutateAsync();
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      setBanner(messageFor(err));
    }
  };
  const flag = (k: 'hasTheory' | 'hasPractical' | 'hasProject' | 'hasInternalAssessment', label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" className="accent-[var(--color-brand)]" checked={form[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} /> {label}
    </label>
  );

  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title={subject ? `Edit ${subject.name}` : 'Add a subject'} description="Subjects are never deleted. Mark one inactive to retire it.">
        <DrawerBody className="space-y-4">
          {banner && <Alert tone="danger">{banner}</Alert>}
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Internal code" required value={form.subjectCode} error={errors.subjectCode} onChange={(e) => setForm({ ...form, subjectCode: e.target.value.toUpperCase() })} placeholder="MATH" />
            <TextField label="Name" required value={form.name} error={errors.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Mathematics" />
            <TextField label="Short name" value={form.shortName} error={errors.shortName} onChange={(e) => setForm({ ...form, shortName: e.target.value })} />
            <ComboboxField
              label="Category"
              value={form.category}
              error={errors.category}
              onChange={(v) => setForm({ ...form, category: v as SubjectCategory })}
              options={CATEGORY_OPTIONS}
              searchPlaceholder="Search categories…"
            />
            <TextField label="Language code" value={form.languageCode} error={errors.languageCode} onChange={(e) => setForm({ ...form, languageCode: e.target.value })} placeholder="en" hint="For language subjects only." />
          </div>
          <fieldset className="grid gap-2 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-semibold">Assessment parts</legend>
            {flag('hasTheory', 'Theory')}
            {flag('hasPractical', 'Practical')}
            {flag('hasProject', 'Project')}
            {flag('hasInternalAssessment', 'Internal assessment')}
          </fieldset>
          {subject && <BoardCodes subject={subject} />}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} loading={save.isPending} loadingText="Saving…">{subject ? 'Save changes' : 'Add subject'}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** Academics → Subject master. Filters follow the PRD: name, internal code, board code, category, class, language, status. */
export function SubjectsPage() {
  const [filters, setFilters] = useState<SubjectParams>({});
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<SubjectDTO | null>(null);
  const [open, setOpen] = useState(false);
  const search = useDebouncedValue(filters.search ?? '', 250);
  const boardCode = useDebouncedValue(filters.boardCode ?? '', 250);
  const classes = useClassMaster();
  const params: SubjectParams = { ...filters, search, boardCode, page };
  const q = useSubjects(params, 20);
  const toggle = useAcademicMutation(({ id, status }: { id: string; status: string }) => api.patch(`/subjects/${id}`, { status }));
  const set = (patch: SubjectParams) => {
    setFilters((cur) => ({ ...cur, ...patch }));
    setPage(1);
  };
  const total = q.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / 20));

  return (
    <>
      <Link to="/academics" className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand">
        <ArrowLeft className="size-4" /> Academic Setup
      </Link>
      <PageHeader
        eyebrow="Academics"
        title="Subject master"
        description="One list of subjects for the whole school. Sessions offer them class by class."
        actions={
          <Can permission="academic:manage">
            <Button onClick={() => { setEditing(null); setOpen(true); }}>
              <Plus /> Add subject
            </Button>
          </Can>
        }
      />
      <Card className="mb-4">
        <form role="search" aria-label="Filter subjects" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4" onSubmit={(e) => e.preventDefault()}>
          <div className="relative sm:col-span-2">
            <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input className="pl-10" aria-label="Search by name or internal code" placeholder="Search by name or code" value={filters.search ?? ''} onChange={(e) => set({ search: e.target.value })} />
          </div>
          <Input aria-label="Board code" placeholder="Board code (041 or CBSE)" value={filters.boardCode ?? ''} onChange={(e) => set({ boardCode: e.target.value })} />
          <Combobox aria-label="Category" value={filters.category ?? ''} onChange={(v) => set({ category: v })} options={[{ value: '', label: 'All categories' }, ...CATEGORY_OPTIONS]} searchPlaceholder="Search categories…" />
          <Combobox
            aria-label="Class"
            value={filters.classId ?? ''}
            onChange={(v) => set({ classId: v })}
            options={[{ value: '', label: 'Any class' }, ...(classes.data ?? []).map((g) => ({ value: g.classId, label: g.canonicalName }))]}
            searchPlaceholder="Search classes…"
          />
          <Input aria-label="Language code" placeholder="Language (en, hi…)" value={filters.languageCode ?? ''} onChange={(e) => set({ languageCode: e.target.value })} />
          <Combobox
            aria-label="Status"
            value={filters.status ?? ''}
            onChange={(v) => set({ status: v })}
            options={[{ value: '', label: 'Any status' }, { value: 'ACTIVE', label: 'Active' }, { value: 'INACTIVE', label: 'Inactive' }]}
            searchPlaceholder="Search statuses…"
          />
        </form>
      </Card>

      {q.isLoading ? (
        <div role="status" aria-label="Loading subjects" className="space-y-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-16 rounded-xl" />)}
        </div>
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : total === 0 ? (
        <Card><EmptyState title="No subjects match" description="Try different filters, or add a subject." /></Card>
      ) : (
        <>
          <ul className="space-y-2" aria-label="Subjects">
            {q.data?.items.map((s) => (
              <li key={s.subjectId} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-white px-4 py-3">
                <div className="min-w-[180px] flex-1">
                  <p className="font-bold">{s.name} <span className="text-sm font-medium text-muted">{s.subjectCode}</span></p>
                  <p className="text-[13px] text-muted">
                    {SUBJECT_CATEGORY_LABELS[s.category]}
                    {s.languageCode ? ` · ${s.languageCode}` : ''}
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {s.boardCodes.map((c) => <Badge key={c.definitionId} tone="lavender">{c.boardCode} {c.boardSubjectCode}</Badge>)}
                </div>
                <StatusToggle status={s.status} label={s.name} disabled={false} onToggle={() => toggle.mutate({ id: s.subjectId, status: s.status === 'ACTIVE' ? 'INACTIVE' : 'ACTIVE' })} />
                <Can permission="academic:manage">
                  <Button variant="outline" size="sm" onClick={() => { setEditing(s); setOpen(true); }} aria-label={`Edit ${s.name}`}>
                    <Pencil /> Edit
                  </Button>
                </Can>
              </li>
            ))}
          </ul>
          <nav className="mt-4 flex items-center justify-between text-sm text-muted" aria-label="Pagination">
            <span>{total} subject{total === 1 ? '' : 's'}</span>
            <span className="flex items-center gap-2">
              <Button variant="outline" size="icon-sm" aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft /></Button>
              Page {page} of {pages}
              <Button variant="outline" size="icon-sm" aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)}><ChevronRight /></Button>
            </span>
          </nav>
        </>
      )}
      <SubjectDrawer open={open} onOpenChange={setOpen} subject={editing ? (q.data?.items.find((s) => s.subjectId === editing.subjectId) ?? editing) : null} />
    </>
  );
}
