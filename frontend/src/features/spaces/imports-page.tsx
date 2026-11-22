import { useState } from 'react';
import { useNavigate } from 'react-router';
import { SPACE_IMPORT_MAX_BYTES, SPACE_IMPORT_MAX_ROWS, type SpaceImportDTO, type SpaceImportStatus } from '@shared';
import { Download, Upload } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { CsvFileField, EarlierImportsCard } from '@/components/sv/csv-import';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
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
          <CsvFileField id="space-import-file" onFile={setFile} hint={<>Rooms go to {ctx.location?.displayName ?? 'this campus'}. Save an Excel sheet as “CSV” first. Up to {SPACE_IMPORT_MAX_ROWS.toLocaleString('en-IN')} rows. Only “Room name” and “Type” are needed.</>} />
          {error && <Alert tone="danger">{error}</Alert>}
          <Button type="submit" loading={create.isPending} loadingText="Uploading…">
            <Upload /> Upload And Check
          </Button>
        </form>
      </Card>

      <EarlierImportsCard
        query={list}
        items={(list.data ?? []).map((i) => ({ importId: i.importId, fileName: i.fileName, createdAt: i.createdAt, message: i.message, statusText: SPACE_IMPORT_STATUS_TEXT[i.status], committed: i.status === 'COMMITTED', href: `/spaces/imports/${i.importId}` }))}
      />
    </>
  );
}
