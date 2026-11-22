import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { SPACE_IMPORT_FIELD_LABELS, SPACE_IMPORT_FIELDS, SPACE_IMPORT_REQUIRED_FIELDS, type SpaceImportCommitDTO, type SpaceImportDTO, type SpaceImportField } from '@shared';
import { ArrowLeft, CircleCheck, FileCheck2, Link2, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { api, ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useSpaceImport, useSpaceImportRows, useSpaceMutation } from './api';
import { SPACE_IMPORT_STATUS_TEXT } from './imports-page';

/** Step 1: the columns we matched by ourselves, and a picker only for the ones we could not match. */
function MappingStep({ imp, onDone }: { imp: SpaceImportDTO; onDone: () => void }) {
  const [mapping, setMapping] = useState<Partial<Record<SpaceImportField, string | null>>>(imp.mapping);
  const [showAll, setShowAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useSpaceMutation((_: void) => api.put<SpaceImportDTO>(`/space-imports/${imp.importId}/mapping`, { mapping }), { quiet: true });

  const matched = SPACE_IMPORT_FIELDS.filter((f) => imp.mapping[f]);
  const unmatched = SPACE_IMPORT_FIELDS.filter((f) => !imp.mapping[f]);
  const shown = showAll ? SPACE_IMPORT_FIELDS : unmatched;
  const missing = SPACE_IMPORT_REQUIRED_FIELDS.filter((f) => !mapping[f]);
  const options = [{ value: '', label: 'Not in the file' }, ...imp.headers.map((h) => ({ value: h, label: h }))];

  return (
    <Card className="space-y-4" aria-label="Match the columns">
      <CardHeader className="mb-0">
        <CardTitle className="text-lg">1. Match the columns</CardTitle>
      </CardHeader>
      <Alert tone={matched.length > 0 ? 'success' : 'info'}>
        We matched {matched.length} of {SPACE_IMPORT_FIELDS.length} columns by ourselves{matched.length > 0 ? `: ${matched.map((f) => `${SPACE_IMPORT_FIELD_LABELS[f]} ← “${imp.mapping[f]}”`).join(', ')}` : ''}. Only fix the ones below.
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
                {SPACE_IMPORT_FIELD_LABELS[f]}
                {SPACE_IMPORT_REQUIRED_FIELDS.includes(f) && <span className="text-danger"> *</span>}
              </span>
              <Combobox aria-label={`File column for ${SPACE_IMPORT_FIELD_LABELS[f]}`} className="h-9 flex-1" value={mapping[f] ?? ''} onChange={(v) => setMapping((m) => ({ ...m, [f]: v || null }))} options={options} searchPlaceholder="Search columns…" />
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" onClick={() => setShowAll((v) => !v)} aria-expanded={showAll}>
        {showAll ? 'Show only unmatched columns' : 'Change a matched column'}
      </Button>
      {missing.length > 0 && <Alert tone="warning">Match {missing.map((f) => SPACE_IMPORT_FIELD_LABELS[f]).join(' and ')} before checking. Every room needs them.</Alert>}
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

const ROW_BADGE = { READY: ['success', 'Ready'], IMPORTED: ['success', 'Imported'], NEEDS_ATTENTION: ['warning', 'Needs attention'], SKIPPED: ['neutral', 'Skipped'] } as const;

/** Step 2: “398 ready, 14 need attention”, the problems grouped by kind with their fix, the rows, and Import Ready Rows. */
function ReviewStep({ imp, onRemap }: { imp: SpaceImportDTO; onRemap: () => void }) {
  const [allRows, setAllRows] = useState(false);
  const [page, setPage] = useState(1);
  const rows = useSpaceImportRows(imp.importId, { status: allRows ? undefined : 'NEEDS_ATTENTION', page });
  const [confirming, setConfirming] = useState(false);
  const commit = useSpaceMutation((_: void) => api.post<SpaceImportCommitDTO>(`/space-imports/${imp.importId}/commit`), { quiet: true });
  const pages = rows.data ? Math.max(1, Math.ceil(rows.data.total / rows.data.pageSize)) : 1;
  const done = imp.status === 'COMMITTED';

  return (
    <div className="space-y-4">
      <Card className="flex flex-wrap items-center gap-4" aria-label="Import summary">
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-semibold" data-testid="import-summary">
            {imp.message}
          </p>
          {imp.imported > 0 && <p className="text-sm text-success">{imp.imported.toLocaleString('en-IN')} already imported.</p>}
        </div>
        {!done && (
          <Button variant="ghost" size="sm" onClick={onRemap}>
            <Link2 /> Change Column Matching
          </Button>
        )}
        <Button onClick={() => setConfirming(true)} disabled={imp.ready === 0 || done} title={imp.ready === 0 ? 'No row is ready yet' : undefined}>
          <Rocket /> Import Ready Rows
        </Button>
      </Card>

      <Card className="p-0" aria-label="Problems by kind">
        <h2 className="border-b border-line px-4 py-3 text-base font-bold">Problems by kind</h2>
        {imp.issueGroups.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted">
            <CircleCheck className="size-4 text-success" aria-hidden="true" /> No problems found.
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {imp.issueGroups.map((g) => (
              <li key={g.code} className="space-y-1 px-4 py-3" data-testid="issue-group">
                <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                  <Badge tone="warning">Check</Badge>
                  {g.title}
                  <span className="font-normal text-muted">
                    · {g.count} row{g.count === 1 ? '' : 's'}
                  </span>
                </p>
                <p className="text-[13px] text-muted">Fix: {g.fix}</p>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-0" aria-label="Rows">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
          <h2 className="flex-1 text-base font-bold">{allRows ? 'All rows' : 'Rows that need attention'}</h2>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAllRows((v) => !v);
              setPage(1);
            }}
          >
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
              {rows.data!.items.map((r) => {
                const [tone, text] = ROW_BADGE[r.status];
                return (
                  <li key={r.rowId} className="px-4 py-2.5 text-sm">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-muted">Row {r.rowNumber}</span>
                      <span className="font-semibold">{r.values.spaceName || 'No name'}</span>
                      <span className="text-muted">{[r.values.type, r.values.building, r.values.floor].filter(Boolean).join(' · ')}</span>
                      <Badge tone={tone}>{text}</Badge>
                      {r.spaceId && (
                        <Link to={`/spaces?room=${r.spaceId}`} className="text-brand hover:underline">
                          Open room
                        </Link>
                      )}
                    </p>
                    {r.issues.length > 0 && (
                      <ul className="mt-1 space-y-0.5 text-[13px] text-muted">
                        {r.issues.map((i, ix) => (
                          <li key={ix}>
                            <span className="font-semibold text-danger">{i.title}</span> {i.fix}
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
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
          title={`Import ${imp.ready.toLocaleString('en-IN')} ready rows?`}
          description={`Each becomes a room. ${imp.needsAttention > 0 ? `The ${imp.needsAttention} rows that need attention stay here for fixing.` : ''} Importing again never adds a room twice.`}
          confirmLabel="Import Rows"
          loadingLabel="Importing…"
          onConfirm={async () => {
            const r = await commit.mutateAsync();
            toast.success(r.message);
          }}
        />
      )}
    </div>
  );
}

/** `/spaces/imports/:importId`: match the columns, then review and import the ready rows. */
export function SpaceImportPage() {
  const { importId } = useParams();
  const q = useSpaceImport(importId);
  const [remap, setRemap] = useState(false);

  if (q.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading import" />;
  if (q.error instanceof ApiError && q.error.status === 404)
    return (
      <Card>
        <EmptyState
          title="Import not found"
          description="This import does not exist, or it belongs to another campus."
          action={
            <Button asChild variant="outline">
              <Link to="/spaces/imports">Go To Imports</Link>
            </Button>
          }
        />
      </Card>
    );
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const imp = q.data;
  const mapping = remap || imp.status === 'UPLOADED';

  return (
    <>
      <Link to="/spaces/imports" className="mb-2 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand">
        <ArrowLeft className="size-4" /> Imports
      </Link>
      <PageHeader eyebrow="Import" title={imp.fileName} description={SPACE_IMPORT_STATUS_TEXT[imp.status]} />
      {mapping ? <MappingStep imp={imp} onDone={() => setRemap(false)} /> : <ReviewStep imp={imp} onRemap={() => setRemap(true)} />}
    </>
  );
}
