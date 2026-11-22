import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { SPACE_IMPORT_FIELD_LABELS, SPACE_IMPORT_FIELDS, SPACE_IMPORT_REQUIRED_FIELDS, type SpaceImportCommitDTO, type SpaceImportDTO, type SpaceImportField } from '@shared';
import { Link2, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ColumnMappingStep, ImportRowsCard, ImportsBackLink, IssueGroupsCard, useImportRowFilter } from '@/components/sv/csv-import';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { api, ApiError } from '@/lib/api';
import { useSpaceImport, useSpaceImportRows, useSpaceMutation } from './api';
import { SPACE_IMPORT_STATUS_TEXT } from './imports-page';

/** Step 1: match the columns, then the server checks every row. */
function MappingStep({ imp, onDone }: { imp: SpaceImportDTO; onDone: () => void }) {
  const save = useSpaceMutation((mapping: Partial<Record<SpaceImportField, string | null>>) => api.put<SpaceImportDTO>(`/space-imports/${imp.importId}/mapping`, { mapping }), { quiet: true });
  return (
    <ColumnMappingStep
      fields={SPACE_IMPORT_FIELDS}
      labels={SPACE_IMPORT_FIELD_LABELS}
      required={SPACE_IMPORT_REQUIRED_FIELDS}
      matched={imp.mapping}
      headers={imp.headers}
      noun="room"
      checking={save.isPending}
      onCheck={async (mapping) => {
        await save.mutateAsync(mapping);
        onDone();
      }}
    />
  );
}

/** Step 2: “398 ready, 14 need attention”, the problems grouped by kind with their fix, the rows, and Import Ready Rows. */
function ReviewStep({ imp, onRemap }: { imp: SpaceImportDTO; onRemap: () => void }) {
  const filter = useImportRowFilter();
  const rows = useSpaceImportRows(imp.importId, filter.args);
  const [confirming, setConfirming] = useState(false);
  const commit = useSpaceMutation((_: void) => api.post<SpaceImportCommitDTO>(`/space-imports/${imp.importId}/commit`), { quiet: true });
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

      <IssueGroupsCard groups={imp.issueGroups.map((g) => ({ code: g.code, title: g.title, count: g.count, fix: g.fix, badge: <Badge tone="warning">Check</Badge> }))} />

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
              name: r.values.spaceName ?? '',
              detail: [r.values.type, r.values.building, r.values.floor].filter(Boolean).join(' · '),
              link: r.spaceId ? { to: `/spaces?room=${r.spaceId}`, label: 'Open room' } : null,
              issues: r.issues.map((i) => ({ title: i.title, fix: i.fix, strong: true })),
            })),
          }
        }
      />

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
      <ImportsBackLink to="/spaces/imports" />
      <PageHeader eyebrow="Import" title={imp.fileName} description={SPACE_IMPORT_STATUS_TEXT[imp.status]} />
      {mapping ? <MappingStep imp={imp} onDone={() => setRemap(false)} /> : <ReviewStep imp={imp} onRemap={() => setRemap(true)} />}
    </>
  );
}
