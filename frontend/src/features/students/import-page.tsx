import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { IMPORT_FIELD_LABELS, IMPORT_FIELDS, IMPORT_REQUIRED_FIELDS, type ImportCommitResultDTO, type ImportDTO, type ImportField, type ImportIssueLevel } from '@shared';
import { ArrowLeft, CircleCheck, Download, FileCheck2, Link2, RefreshCw, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { api, ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useStudentMutation } from './api';
import { IMPORT_STATUS_TEXT } from './imports-page';
import { importIssuesCsvUrl, useImport, useImportIssues, useImportRows } from './lifecycle-api';
import { StudentNotFound } from './not-found';

const LEVEL_TONE: Record<ImportIssueLevel, 'danger' | 'warning' | 'brand'> = { ERROR: 'danger', WARNING: 'warning', INFO: 'brand' };
const LEVEL_TEXT: Record<ImportIssueLevel, string> = { ERROR: 'Must fix', WARNING: 'Check', INFO: 'Good to know' };

/** Step 1: the columns we matched by ourselves, and a picker only for the ones we could not match. */
function MappingStep({ imp, onDone }: { imp: ImportDTO; onDone: () => void }) {
  const [mapping, setMapping] = useState<Partial<Record<ImportField, string | null>>>(imp.mapping);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useStudentMutation(async (_: void) => {
    await api.post<ImportDTO>(`/students/imports/${imp.importId}/map`, { mapping });
    return api.post<ImportDTO>(`/students/imports/${imp.importId}/validate`);
  }, { quiet: true });

  const matched = IMPORT_FIELDS.filter((f) => imp.mapping[f]);
  const unmatched = IMPORT_FIELDS.filter((f) => !imp.mapping[f]);
  const shown = showAll ? IMPORT_FIELDS : unmatched;
  const missing = IMPORT_REQUIRED_FIELDS.filter((f) => !mapping[f]);
  const options = [{ value: '', label: 'Not in the file' }, ...imp.headers.map((h) => ({ value: h, label: h }))];

  return (
    <Card className="space-y-4" aria-label="Match the columns">
      <CardHeader className="mb-0">
        <CardTitle className="text-lg">1. Match the columns</CardTitle>
      </CardHeader>
      <Alert tone={matched.length > 0 ? 'success' : 'info'}>
        We matched {matched.length} of {IMPORT_FIELDS.length} columns by ourselves{matched.length > 0 ? `: ${matched.map((f) => `${IMPORT_FIELD_LABELS[f]} ← “${imp.mapping[f]}”`).join(', ')}` : ''}. Only fix the ones below.
      </Alert>
      {shown.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted">
          <CircleCheck className="size-4 text-success" aria-hidden="true" /> Every column is matched.
        </p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" aria-label="Columns to match">
          {shown.map((f) => (
            <li key={f} className="flex items-center gap-3">
              <span className="w-36 shrink-0 text-sm font-semibold">
                {IMPORT_FIELD_LABELS[f]}
                {IMPORT_REQUIRED_FIELDS.includes(f) && <span className="text-danger"> *</span>}
              </span>
              <Combobox aria-label={`File column for ${IMPORT_FIELD_LABELS[f]}`} className="h-9 flex-1" value={mapping[f] ?? ''} onChange={(v) => setMapping((m) => ({ ...m, [f]: v || null }))} options={options} searchPlaceholder="Search columns…" />
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
        {showAll ? 'Show only unmatched columns' : 'Change a matched column'}
      </Button>
      {missing.length > 0 && <Alert tone="warning">Match {missing.map((f) => IMPORT_FIELD_LABELS[f]).join(' and ')} before checking. Every student needs them.</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button
        disabled={missing.length > 0}
        loading={save.isPending}
        loadingText="Checking every row…"
        onClick={async () => {
          setError(null);
          try {
            await save.mutateAsync();
            onDone();
          } catch (err) {
            setError(messageFor(err));
          }
        }}
      >
        <FileCheck2 /> Check The File
      </Button>
    </Card>
  );
}

/** Step 2: the summary, the problems grouped by kind (with the fix), the rows that need attention, and Import Ready Rows. */
function ReviewStep({ imp, onRemap }: { imp: ImportDTO; onRemap: () => void }) {
  const issues = useImportIssues(imp.importId, true);
  const [allRows, setAllRows] = useState(false);
  const [page, setPage] = useState(1);
  const rows = useImportRows(imp.importId, { status: allRows ? undefined : 'NEEDS_ATTENTION', page }, true);
  const [confirming, setConfirming] = useState(false);
  const recheck = useStudentMutation((_: void) => api.post<ImportDTO>(`/students/imports/${imp.importId}/validate`), { success: 'Checked again.' });
  const commit = useStudentMutation((_: void) => api.post<ImportCommitResultDTO>(`/students/imports/${imp.importId}/commit`), { quiet: true });
  const summary = issues.data?.summary ?? imp.summary;
  const pages = rows.data ? Math.max(1, Math.ceil(rows.data.total / rows.data.pageSize)) : 1;

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

      <Card className="p-0" aria-label="Problems by kind">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="flex-1 text-base font-bold">Problems by kind</h2>
          <Button asChild variant="outline" size="sm">
            <a href={importIssuesCsvUrl(imp.importId)} download>
              <Download /> Download Error Report
            </a>
          </Button>
        </div>
        {issues.isLoading ? (
          <Skeleton className="m-4 h-16" />
        ) : issues.isError ? (
          <ErrorState error={issues.error} onRetry={() => void issues.refetch()} retrying={issues.isFetching} />
        ) : (issues.data?.groups ?? []).length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted">
            <CircleCheck className="size-4 text-success" aria-hidden="true" /> No problems found.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {issues.data!.groups.map((g) => (
              <li key={g.code} className="space-y-1 px-4 py-3" data-testid="issue-group">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  <Badge tone={LEVEL_TONE[g.level]}>{LEVEL_TEXT[g.level]}</Badge>
                  {g.title}
                  <span className="font-normal text-muted">
                    · {g.count} row{g.count === 1 ? '' : 's'}
                  </span>
                </p>
                <p className="text-[13px] text-muted">
                  Fix: {g.suggestedFix} Rows {g.rowNumbers.slice(0, 12).join(', ')}
                  {g.rowNumbers.length > 12 ? '…' : ''}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-0" aria-label="Rows">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="flex-1 text-base font-bold">{allRows ? 'All rows' : 'Rows that need attention'}</h2>
          <Button variant="ghost" size="sm" onClick={() => { setAllRows((v) => !v); setPage(1); }}>
            {allRows ? 'Show only problem rows' : 'Show all rows'}
          </Button>
        </div>
        {rows.isLoading ? (
          <Skeleton className="m-4 h-24" />
        ) : rows.isError ? (
          <ErrorState error={rows.error} onRetry={() => void rows.refetch()} retrying={rows.isFetching} />
        ) : (rows.data?.items ?? []).length === 0 ? (
          <p className="px-4 py-4 text-sm text-muted">{allRows ? 'No rows.' : 'No row needs attention.'}</p>
        ) : (
          <>
            <ul className="divide-y divide-line">
              {rows.data!.items.map((r) => (
                <li key={r.rowId} className="px-4 py-2.5 text-sm">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-xs text-muted">Row {r.rowNumber}</span>
                    <span className="font-semibold">{r.values.studentName || 'No name'}</span>
                    <span className="text-muted">
                      {[r.values.className, r.values.sectionName].filter(Boolean).join('-')}
                      {r.values.admissionNumber ? ` · ${r.values.admissionNumber}` : ''}
                    </span>
                    <Badge tone={r.status === 'READY' || r.status === 'IMPORTED' ? 'success' : r.status === 'SKIPPED' ? 'neutral' : 'warning'}>{r.status === 'NEEDS_ATTENTION' ? 'Needs attention' : r.status === 'READY' ? 'Ready' : r.status === 'IMPORTED' ? 'Imported' : 'Skipped'}</Badge>
                    {r.studentId && (
                      <Link to={`/students/${r.studentId}`} className="text-brand hover:underline">
                        Open student
                      </Link>
                    )}
                  </p>
                  {r.issues.length > 0 && (
                    <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
                      {r.issues.map((i, ix) => (
                        <li key={ix}>
                          <span className={i.level === 'ERROR' ? 'font-semibold text-danger' : undefined}>{i.message}</span> {i.suggestedFix}
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
            {pages > 1 && (
              <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-2">
                <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </Button>
                <span className="text-sm text-muted">
                  Page {page} of {pages}
                </span>
                <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                  Next
                </Button>
              </div>
            )}
          </>
        )}
      </Card>

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
      <Link to="/students/imports" className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand">
        <ArrowLeft className="size-4" /> Imports
      </Link>
      <PageHeader eyebrow="Import" title={imp.fileName} description={`${imp.mode === 'EXISTING_STUDENTS' ? 'Existing students' : 'New admissions'} · ${IMPORT_STATUS_TEXT[imp.status]}`} />
      {mapping ? <MappingStep imp={imp} onDone={() => setRemap(false)} /> : <ReviewStep imp={imp} onRemap={() => setRemap(true)} />}
    </>
  );
}
