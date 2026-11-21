import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { IMPORT_MAX_BYTES, type ImportDTO, type ImportMode } from '@shared';
import { Download, FileSpreadsheet, FileUp, Upload } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useStudentMutation } from './api';
import { useStudentContext } from './context';
import { IMPORTS_INTRO } from './help-copy';
import { IMPORT_TEMPLATE_URL, useImports } from './lifecycle-api';

const MODES: { value: ImportMode; title: string; text: string }[] = [
  { value: 'EXISTING_STUDENTS', title: 'Existing Students', text: 'Students who already study here. Their old admission number and date are kept.' },
  { value: 'NEW_ADMISSIONS', title: 'New Admissions', text: 'New students joining this year. Admission numbers can be made for you.' },
];

export const IMPORT_STATUS_TEXT: Record<ImportDTO['status'], string> = { UPLOADED: 'Columns to match', MAPPED: 'Ready to check', VALIDATED: 'Checked', COMMITTED: 'Imported' };

/** `/students/imports`: upload a CSV (existing students or new admissions), download the template, and open earlier imports. */
export function ImportsPage() {
  const ctx = useStudentContext();
  const navigate = useNavigate();
  const list = useImports();
  const [mode, setMode] = useState<ImportMode>('EXISTING_STUDENTS');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const create = useStudentMutation((form: FormData) => api.upload<ImportDTO>('/students/imports', form), { quiet: true });

  const submit = async () => {
    setError(null);
    if (!ctx.locationId) return setError('Choose a campus at the top of the page first.');
    if (!file) return setError('Choose the CSV file to upload.');
    if (file.size > IMPORT_MAX_BYTES) return setError('This file is too large. The maximum size is 2 MB (about 2,000 students).');
    const form = new FormData();
    form.append('mode', mode);
    form.append('locationId', ctx.locationId);
    if (ctx.sessionId) form.append('academicSessionId', ctx.sessionId);
    form.append('file', file);
    try {
      const created = await create.mutateAsync(form);
      navigate(`/students/imports/${created.importId}`);
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <>
      <PageHeader eyebrow="Students" title="Imports" description="Add many students at once from a CSV file." />
      <TabIntro title="About imports" className="mb-4">
        {IMPORTS_INTRO}
      </TabIntro>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-lg">Upload a file</CardTitle>
          <Button asChild variant="outline" size="sm">
            <a href={IMPORT_TEMPLATE_URL} download>
              <Download /> Download Sample Template
            </a>
          </Button>
        </CardHeader>
        <form
          className="space-y-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <fieldset>
            <legend className="mb-2 text-sm font-semibold">What kind of students are in the file?</legend>
            <div className="grid gap-3 sm:grid-cols-2" role="radiogroup">
              {MODES.map((m) => (
                <label key={m.value} className={cn('flex cursor-pointer gap-3 rounded-xl border p-3', mode === m.value ? 'border-brand bg-brand-soft' : 'border-line hover:border-brand/40')}>
                  <input type="radio" name="import-mode" value={m.value} checked={mode === m.value} onChange={() => setMode(m.value)} className="mt-1 size-4 accent-[var(--color-brand)]" />
                  <span>
                    <span className="block text-sm font-bold">{m.title}</span>
                    <span className="block text-[13px] text-muted">{m.text}</span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="import-file" className="text-sm font-semibold">
              CSV file
            </label>
            <input
              ref={input}
              id="import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-4 file:py-2.5 file:font-semibold file:text-brand"
            />
            <p className="text-[13px] text-muted">
              Students go to {ctx.session?.code ?? 'this year'} at {ctx.location?.displayName ?? 'this campus'}. Save an Excel sheet as “CSV” first. Up to 2,000 rows.
            </p>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={create.isPending} loadingText="Uploading…">
            <Upload /> Upload And Match Columns
          </Button>
        </form>
      </Card>

      <Card className="p-0" aria-label="Earlier imports">
        <h2 className="border-b border-line px-4 py-3 text-base font-bold">Earlier imports</h2>
        {list.isLoading ? (
          <Skeleton className="m-4 h-16" />
        ) : list.isError ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState illustration={<FileSpreadsheet className="size-12 text-muted" aria-hidden="true" />} title="No imports yet" description="Files you upload show here, so you can come back and finish them." />
        ) : (
          <ul className="divide-y divide-line">
            {(list.data ?? []).map((i) => (
              <li key={i.importId} className="flex flex-wrap items-center gap-3 px-4 py-3">
                <FileUp className="size-5 text-brand" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{i.fileName}</p>
                  <p className="text-[13px] text-muted">
                    {formatDateTime(i.createdAt)} · {i.summary.message}
                  </p>
                </div>
                <Badge tone={i.status === 'COMMITTED' ? 'success' : 'warning'}>{IMPORT_STATUS_TEXT[i.status]}</Badge>
                <Button asChild size="sm" variant="outline">
                  <Link to={`/students/imports/${i.importId}`}>Open</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
