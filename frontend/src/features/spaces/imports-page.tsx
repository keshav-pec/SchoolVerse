import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { SPACE_IMPORT_MAX_BYTES, SPACE_IMPORT_MAX_ROWS, type SpaceImportDTO, type SpaceImportStatus } from '@shared';
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
import { useStudentContext } from '../students/context';
import { SPACE_IMPORT_TEMPLATE_URL, useSpaceImports, useSpaceMutation } from './api';
import { IMPORTS_INTRO } from './help-copy';

export const SPACE_IMPORT_STATUS_TEXT: Record<SpaceImportStatus, string> = { UPLOADED: 'Columns to match', CHECKED: 'Checked', COMMITTED: 'Imported' };

/** `/spaces/imports`: upload a CSV of rooms, download the template, and open earlier uploads. */
export function SpaceImportsPage() {
  const ctx = useStudentContext();
  const navigate = useNavigate();
  const list = useSpaceImports();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const create = useSpaceMutation((form: FormData) => api.upload<SpaceImportDTO>('/space-imports', form), { quiet: true });

  const submit = async () => {
    setError(null);
    if (!ctx.locationId) return setError('Choose a campus at the top of the page first.');
    if (!file) return setError('Choose the CSV file to upload.');
    if (file.size > SPACE_IMPORT_MAX_BYTES) return setError('This file is too large. The maximum size is 1 MB.');
    const form = new FormData();
    form.append('locationId', ctx.locationId);
    form.append('file', file);
    try {
      const created = await create.mutateAsync(form);
      navigate(`/spaces/imports/${created.importId}`);
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <>
      <PageHeader eyebrow="Campus" title="Imports" description="Add many rooms at once from a CSV file." />
      <TabIntro title="About imports" need="optional" className="mb-4">
        {IMPORTS_INTRO}
      </TabIntro>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-lg">Upload a file</CardTitle>
          <Button asChild variant="outline" size="sm">
            <a href={SPACE_IMPORT_TEMPLATE_URL} download>
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
          <div className="flex flex-col gap-1.5">
            <label htmlFor="space-import-file" className="text-sm font-semibold">
              CSV file
            </label>
            <input
              ref={input}
              id="space-import-file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-soft file:px-4 file:py-2.5 file:font-semibold file:text-brand"
            />
            <p className="text-[13px] text-muted">
              Rooms go to {ctx.location?.displayName ?? 'this campus'}. Save an Excel sheet as “CSV” first. Up to {SPACE_IMPORT_MAX_ROWS.toLocaleString('en-IN')} rows. Only “Room name” and “Type” are needed.
            </p>
          </div>
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={create.isPending} loadingText="Uploading…">
            <Upload /> Upload And Check
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
                    {formatDateTime(i.createdAt)} · {i.message}
                  </p>
                </div>
                <Badge tone={i.status === 'COMMITTED' ? 'success' : 'warning'}>{SPACE_IMPORT_STATUS_TEXT[i.status]}</Badge>
                <Button asChild size="sm" variant="outline">
                  <Link to={`/spaces/imports/${i.importId}`}>Open</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
