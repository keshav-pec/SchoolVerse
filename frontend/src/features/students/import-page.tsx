import { useState } from 'react';
import { useParams } from 'react-router';
import { IMPORT_FIELD_LABELS, IMPORT_FIELDS, IMPORT_REQUIRED_FIELDS, type ImportCommitResultDTO, type ImportDTO, type ImportField, type ImportIssueLevel } from '@shared';
import { Download, Link2, RefreshCw, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ColumnMappingStep, ImportRowsCard, ImportsBackLink, IssueGroupsCard, useImportRowFilter } from '@/components/sv/csv-import';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { api, ApiError } from '@/lib/api';
import { useStudentMutation } from './api';
import { IMPORT_STATUS_TEXT } from './imports-page';
import { importIssuesCsvUrl, useImport, useImportIssues, useImportRows } from './lifecycle-api';
import { StudentNotFound } from './not-found';

const LEVEL_TONE: Record<ImportIssueLevel, 'danger' | 'warning' | 'brand'> = { ERROR: 'danger', WARNING: 'warning', INFO: 'brand' };
const LEVEL_TEXT: Record<ImportIssueLevel, string> = { ERROR: 'Must fix', WARNING: 'Check', INFO: 'Good to know' };

/** Step 1: match the columns, then the server checks every row. */
function MappingStep({ imp, onDone }: { imp: ImportDTO; onDone: () => void }) {
  const save = useStudentMutation(async (mapping: Partial<Record<ImportField, string | null>>) => {
    await api.post<ImportDTO>(`/students/imports/${imp.importId}/map`, { mapping });
    return api.post<ImportDTO>(`/students/imports/${imp.importId}/validate`);
  }, { quiet: true });
  return (
    <ColumnMappingStep
      fields={IMPORT_FIELDS}
      labels={IMPORT_FIELD_LABELS}
      required={IMPORT_REQUIRED_FIELDS}
      matched={imp.mapping}
      headers={imp.headers}
      noun="student"
      checking={save.isPending}
      onCheck={async (mapping) => {
        await save.mutateAsync(mapping);
        onDone();
      }}
    />
  );
}

/** Step 2: the summary, the problems grouped by kind (with the fix), the rows that need attention, and Import Ready Rows. */
function ReviewStep({ imp, onRemap }: { imp: ImportDTO; onRemap: () => void }) {
  const issues = useImportIssues(imp.importId, true);
  const filter = useImportRowFilter();
  const rows = useImportRows(imp.importId, filter.args, true);
  const [confirming, setConfirming] = useState(false);
  const recheck = useStudentMutation((_: void) => api.post<ImportDTO>(`/students/imports/${imp.importId}/validate`), { success: 'Checked again.' });
  const commit = useStudentMutation((_: void) => api.post<ImportCommitResultDTO>(`/students/imports/${imp.importId}/commit`), { quiet: true });
  const summary = issues.data?.summary ?? imp.summary;

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4" aria-label="Import summary">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold" data-testid="import-summary">
            {summary.message}
          </p>
          {summary.imported > 0 && <p className="text-sm text-success">{summary.imported.toLocaleString('en-IN')} already imported.</p>}
        </div>
        <Button variant="outline" size="sm" onClick={() => recheck.mutate()} loading={recheck.isPending} loadingText="Checking…">
          <RefreshCw /> Check Again
        </Button>
        {imp.status !== 'COMMITTED' && (
          <Button variant="ghost" size="sm" onClick={onRemap}>
            <Link2 /> Change Column Matching
          </Button>
        )}
        <Button onClick={() => setConfirming(true)} disabled={summary.ready === 0} title={summary.ready === 0 ? 'No row is ready yet' : undefined}>
          <Rocket /> Import Ready Rows
        </Button>
      </Card>

      <IssueGroupsCard
        query={issues}
        action={
          <Button asChild variant="outline" size="sm">
            <a href={importIssuesCsvUrl(imp.importId)} download>
              <Download /> Download Error Report
            </a>
          </Button>
        }
        groups={(issues.data?.groups ?? []).map((g) => ({
          code: g.code,
          title: g.title,
          count: g.count,
          badge: <Badge tone={LEVEL_TONE[g.level]}>{LEVEL_TEXT[g.level]}</Badge>,
          fix: `${g.suggestedFix} Rows ${g.rowNumbers.slice(0, 12).join(', ')}${g.rowNumbers.length > 12 ? '…' : ''}`,
        }))}
      />

      <ImportRowsCard
        filter={filter}
        query={rows}
        data={
          rows.data && {
            ...rows.data,
            items: rows.data.items.map((r) => ({
              rowId: r.rowId,
              rowNumber: r.rowNumber,
              status: r.status,
              name: r.values.studentName ?? '',
              detail: `${[r.values.className, r.values.sectionName].filter(Boolean).join('-')}${r.values.admissionNumber ? ` · ${r.values.admissionNumber}` : ''}`,
              link: r.studentId ? { to: `/students/${r.studentId}`, label: 'Open student' } : null,
              issues: r.issues.map((i) => ({ title: i.message, fix: i.suggestedFix, strong: i.level === 'ERROR' })),
            })),
          }
        }
      />

      {confirming && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setConfirming(false)}
          icon={<Rocket className="size-5" />}
          title={`Import ${summary.ready.toLocaleString('en-IN')} ready rows?`}
          description={`Each becomes a student with their parent, class, section and required subjects. ${summary.needsAttention > 0 ? `The ${summary.needsAttention} rows that need attention stay here for fixing.` : ''} Importing again never adds anyone twice.`}
          confirmLabel="Import Rows"
          loadingLabel="Importing…"
          onConfirm={async () => {
            const r = await commit.mutateAsync();
            toast.success(`${r.imported} imported${r.skipped ? `, ${r.skipped} already there` : ''}${r.failed ? `, ${r.failed} could not be imported` : ''}.`);
          }}
        />
      )}
    </div>
  );
}

/** `/students/imports/:importId`: match the columns, then review and import the ready rows. */
export function ImportPage() {
  const { importId } = useParams();
  const q = useImport(importId);
  const [remap, setRemap] = useState(false);

  if (q.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading import" />;
  if (q.error instanceof ApiError && q.error.status === 404) return <StudentNotFound backTo="/students/imports" backLabel="Go To Imports" />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const imp = q.data;
  const mapping = remap || imp.status === 'UPLOADED' || imp.status === 'MAPPED';

  return (
    <>
      <ImportsBackLink to="/students/imports" />
      <PageHeader eyebrow="Import" title={imp.fileName} description={`${imp.mode === 'EXISTING_STUDENTS' ? 'Existing students' : 'New admissions'} · ${IMPORT_STATUS_TEXT[imp.status]}`} />
      {mapping ? <MappingStep imp={imp} onDone={() => setRemap(false)} /> : <ReviewStep imp={imp} onRemap={() => setRemap(true)} />}
    </>
  );
}
