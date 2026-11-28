import { useState } from 'react';
import { Download, Info } from 'lucide-react';
import { toast } from 'sonner';
import { REPORT_TITLES, REPORT_TYPES, type ReportType } from '@shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { fetchBlob } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { CreatePlanCard, useTimetablePlan } from '../context';
import { REPORTS_INTRO } from '../help-copy';
import { reportPath, useReport } from './api';
import { todayIso } from './views-page';

const monthStart = () => `${todayIso().slice(0, 8)}01`;

/** `/timetable/reports`: seven simple tables. Each says which version and dates it is based on. */
export function ReportsPage() {
  const { plan, loading } = useTimetablePlan();
  const [type, setType] = useState<ReportType>('section-coverage');
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const dated = type === 'substitution-history';
  const params = { planId: plan?.planId, ...(dated ? { dateFrom: from, ...(to ? { dateTo: to } : {}) } : {}) };
  const report = useReport(type, params);
  const r = report.data;

  const download = async () => {
    setBusy(true);
    try {
      const blob = await fetchBlob(reportPath(type, { ...params, format: 'csv' } as Record<string, string | undefined>));
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `timetable-${type}.csv`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Timetable" title="Reports" description="How complete the timetable is, who is busy, which rooms are used, and who covered for whom." />
      <div className="space-y-4">
        <TabIntro title="How this works">{REPORTS_INTRO}</TabIntro>
        {loading && <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading" />}
        {!loading && !plan && <CreatePlanCard />}
        {plan && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div className="space-y-1">
                <span className="text-sm font-semibold">Report</span>
                <Combobox aria-label="Report" className="h-10 w-64" value={type} onChange={(v) => setType(v as ReportType)} options={REPORT_TYPES.map((t) => ({ value: t, label: REPORT_TITLES[t] }))} searchPlaceholder="Search reports…" />
              </div>
              {dated && (
                <>
                  <TextField label="From" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} containerClassName="w-44" />
                  <TextField label="To (optional)" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} containerClassName="w-44" />
                </>
              )}
              <Button className="ml-auto" variant="outline" loading={busy} loadingText="Preparing…" disabled={!r?.versionId} onClick={() => void download()}>
                <Download /> Download CSV
              </Button>
            </div>
            {report.isLoading && <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading the report" />}
            {report.isError && <ErrorState error={report.error} onRetry={() => void report.refetch()} />}
            {r && (
              <Card className="space-y-3 p-4 sm:p-5" aria-label={r.title}>
                <div>
                  <h2 className="text-lg font-bold">{r.title}</h2>
                  <p className="flex items-center gap-1.5 text-[13px] text-muted" data-testid="report-basis">
                    <Info className="size-3.5 shrink-0" aria-hidden="true" /> {r.basis}
                  </p>
                </div>
                {r.message && r.rows.length === 0 && <p className="rounded-xl border border-dashed border-line p-4 text-sm text-muted">{r.message}</p>}
                {r.rows.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b border-line text-left text-[13px] text-muted">
                          {r.columns.map((c) => (
                            <th key={c.key} scope="col" className={cn('px-2 py-2 font-semibold', c.align === 'right' && 'text-right')}>
                              {c.label}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {r.rows.slice(0, 300).map((row, i) => (
                          <tr key={i} className="border-b border-line/60 last:border-0">
                            {r.columns.map((c) => (
                              <td key={c.key} className={cn('px-2 py-2', c.align === 'right' && 'text-right tabular-nums')}>
                                {row[c.key] ?? '—'}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            )}
          </>
        )}
      </div>
    </>
  );
}
