import { useState, type ReactNode } from 'react';
import { Download, Info } from 'lucide-react';
import { toast } from 'sonner';
import type { ReportDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { downloadFile } from '@/features/finance/ops-api';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';

function cell(kind: string, value: string | number | null) {
  if (value === null || value === undefined || value === '') return '—';
  if (kind === 'money') return formatMoney(Number(value));
  if (kind === 'date') return formatDateOnly(String(value));
  if (kind === 'number') return Number(value).toLocaleString('en-IN');
  return String(value);
}

/**
 * Any finance report: the basis line first ("Based on posted journals" or "Money received view"), so nobody mixes the two up,
 * then the table, the totals and the notes. **Download CSV** shows only for people allowed to export.
 */
export function ReportTable({
  query,
  csvPath,
  fileName,
  csvLabel = 'Download CSV',
  extraNote,
  maxRows = 200,
}: {
  query: { data?: ReportDTO; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown; isFetching: boolean };
  /** Without `?format=csv`; the button adds it. */
  csvPath?: string;
  fileName?: string;
  csvLabel?: string;
  extraNote?: ReactNode;
  maxRows?: number;
}) {
  const { can } = useAuth();
  const [busy, setBusy] = useState(false);
  if (query.isLoading) return <Skeleton className="h-40" role="status" aria-label="Loading report" />;
  if (query.isError || !query.data) return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
  const r = query.data;
  const canExport = can('finance:report:export') && !!csvPath;
  const download = async () => {
    if (!csvPath) return;
    setBusy(true);
    try {
      await downloadFile(`${csvPath}${csvPath.includes('?') ? '&' : '?'}format=csv`, fileName ?? `${r.type}.csv`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };
  const rows = r.rows.slice(0, maxRows);
  return (
    <section aria-label={r.title} className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h3 className="text-base font-bold">{r.title}</h3>
          <p className="flex items-center gap-1.5 text-[13px] text-muted" data-testid="report-basis">
            <Info className="size-3.5 shrink-0" aria-hidden="true" /> {r.basis}
            {r.from || r.to ? ` · ${r.from ? formatDateOnly(r.from) : '…'} to ${r.to ? formatDateOnly(r.to) : 'today'}` : ''}
          </p>
        </div>
        {canExport && (
          <Button size="sm" variant="outline" onClick={() => void download()} loading={busy} loadingText="Preparing…">
            <Download /> {csvLabel}
          </Button>
        )}
      </div>
      {extraNote}
      {r.rows.length === 0 ? (
        <p className="rounded-xl bg-canvas px-4 py-6 text-center text-sm text-muted">Nothing to show for these dates.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full min-w-[560px] text-sm">
            <thead className="bg-canvas text-left text-[13px] text-muted">
              <tr>
                {r.columns.map((c) => (
                  <th key={c.key} scope="col" className={`px-3 py-2 font-semibold ${c.kind === 'money' || c.kind === 'number' ? 'text-right' : ''}`}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((row, i) => (
                <tr key={i}>
                  {r.columns.map((c) => (
                    <td key={c.key} className={`px-3 py-2 ${c.kind === 'money' || c.kind === 'number' ? 'text-right tabular-nums' : ''}`}>
                      {cell(c.kind, row[c.key] ?? null)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            {r.totals && (
              <tfoot className="bg-canvas font-bold">
                <tr>
                  {r.columns.map((c, i) => (
                    <td key={c.key} className={`px-3 py-2 ${c.kind === 'money' || c.kind === 'number' ? 'text-right tabular-nums' : ''}`}>
                      {r.totals![c.key] !== undefined ? cell(c.kind, r.totals![c.key]!) : i === 0 ? 'Total' : ''}
                    </td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {r.rows.length > maxRows && <p className="text-[13px] text-muted">Showing the first {maxRows} of {r.rows.length} rows. Download the CSV for all of them.</p>}
      {r.notes.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-[13px] text-muted">
          {r.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </section>
  );
}
