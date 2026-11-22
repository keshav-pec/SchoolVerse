import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SPACE_REPORT_TITLES, SPACE_REPORT_TYPES, type SpaceReportType } from '@shared';
import { Download, FileText, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { inputClass } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useStudentContext } from '../students/context';
import { reportCsvUrl, useSpaceReport } from './allocation-api';
import { REPORTS_INTRO } from './help-copy';

/** Reports about Home Classrooms follow the school year in the bar at the top; the others are about rooms only. */
const YEAR_REPORTS: readonly SpaceReportType[] = ['classroom-allocation', 'sections-without-home-classroom', 'capacity-mismatch'];
const HINTS: Record<SpaceReportType, string> = {
  'space-inventory': 'Every room',
  'classroom-allocation': 'Section → room',
  'sections-without-home-classroom': 'Needs a room',
  'capacity-mismatch': 'Too many students',
  'schedulable-spaces': 'For the timetable',
  'temporarily-unavailable': 'Closed for now',
  'archived-spaces': 'History',
  'setup-completeness': 'What is missing',
};

const isReport = (v: string | null): v is SpaceReportType => !!v && (SPACE_REPORT_TYPES as readonly string[]).includes(v);

/** `/spaces/reports`: eight ready-made lists as simple tables, a search box and a CSV button. */
export function SpaceReportsPage() {
  const ctx = useStudentContext();
  const [params, setParams] = useSearchParams();
  const type: SpaceReportType = isReport(params.get('report')) ? (params.get('report') as SpaceReportType) : 'space-inventory';
  const scope = { locationId: ctx.locationId, ...(YEAR_REPORTS.includes(type) ? { sessionId: ctx.sessionId } : {}) };
  const q = useSpaceReport(type, scope);
  const [filter, setFilter] = useState('');

  const rows = useMemo(() => {
    const all = q.data?.rows ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return all;
    return all.filter((r) => Object.values(r).some((v) => v !== null && String(v).toLowerCase().includes(needle)));
  }, [q.data, filter]);

  return (
    <>
      <PageHeader
        eyebrow="Campus"
        title="Reports"
        description="Lists about rooms and classrooms."
        actions={
          <Can permission="space:export">
            <Button asChild variant="outline">
              <a href={reportCsvUrl(type, scope)} download>
                <Download /> Download CSV
              </a>
            </Button>
          </Can>
        }
      />
      <TabIntro title="About reports" className="mb-4">
        {REPORTS_INTRO}
      </TabIntro>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Combobox
          aria-label="Report"
          value={type}
          onChange={(v) => {
            setFilter('');
            setParams({ report: v }, { replace: true });
          }}
          options={SPACE_REPORT_TYPES.map((t) => ({ value: t, label: SPACE_REPORT_TITLES[t], hint: HINTS[t] }))}
          searchPlaceholder="Search reports…"
          className="h-10 w-72"
        />
        <label className="relative">
          <span className="sr-only">Search this report</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
          <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Search this report…" className={cn(inputClass, 'h-10 w-64 pl-9')} />
        </label>
        {YEAR_REPORTS.includes(type) && <span className="text-[13px] text-muted">School year {ctx.session?.code}</span>}
      </div>
      {q.isLoading || ctx.loading ? (
        <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />
      ) : q.isError || !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <Card className="p-0" aria-label={q.data.title}>
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
            <h2 className="text-base font-bold">{q.data.title}</h2>
            <span className="text-[13px] text-muted" data-testid="report-count">
              {filter ? `${rows.length} of ${q.data.rows.length}` : q.data.rows.length} row{q.data.rows.length === 1 ? '' : 's'}
            </span>
          </div>
          {q.data.summary && <p className="border-b border-line px-4 py-2 text-sm font-semibold">{q.data.summary}</p>}
          {rows.length === 0 ? (
            <EmptyState illustration={<FileText className="size-12 text-muted" aria-hidden="true" />} title={filter ? 'No rows match your search' : 'Nothing to show'} description={filter ? 'Try another word.' : 'This list is empty for this campus. That is usually good news.'} />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm" aria-label={q.data.title}>
                <thead className="border-b border-line bg-canvas text-[12px] font-bold tracking-wide text-muted uppercase">
                  <tr>
                    {q.data.columns.map((c) => (
                      <th key={c.key} scope="col" className="px-3 py-2 whitespace-nowrap">
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((r, i) => (
                    <tr key={i}>
                      {q.data.columns.map((c) => (
                        <td key={c.key} className="px-3 py-2">
                          {r[c.key] ?? '—'}
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
  );
}
