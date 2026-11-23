import { Link } from 'react-router';
import { ArrowRight, CircleCheck, CircleDashed } from 'lucide-react';
import { AGING_BUCKETS } from '@shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { formatMoney } from '@/lib/money';
import { useStudentContext } from '../students/context';
import { useOutstanding, usePulse, useReadiness } from './api';
import { AGING_LABELS, OVERVIEW_INTRO, TIP_OUTSTANDING } from './help-copy';

const monthLabel = (key: string) => new Date(`${key}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

function Tile({ label, value, note, tone }: { label: string; value: string; note: string; tone?: 'danger' }) {
  return (
    <section className="rounded-card border border-line bg-white p-4 shadow-card" aria-label={label}>
      <p className="text-[13px] font-semibold text-muted">{label}</p>
      <p className={`mt-1 text-2xl font-extrabold tabular-nums ${tone === 'danger' ? 'text-danger' : 'text-ink'}`}>{value}</p>
      <p className="text-xs text-muted">{note}</p>
    </section>
  );
}

/** `/finance`: the Finance Pulse tiles and the Setup Checklist card. Charts stay small and secondary. */
export function FinanceOverviewPage() {
  const ctx = useStudentContext();
  const pulse = usePulse(ctx.locationId);
  const aging = useOutstanding({ locationId: ctx.locationId });
  const readiness = useReadiness();
  const overdue = (aging.data?.buckets ?? []).filter((b) => b.bucket !== 'CURRENT').reduce((s, b) => s + b.totalPaise, 0);
  const max = Math.max(1, ...(aging.data?.buckets ?? []).map((b) => b.totalPaise));
  const todo = (readiness.data?.items ?? []).filter((i) => i.status === 'NEEDS_ATTENTION');

  return (
    <>
      <PageHeader eyebrow="Finance" title="Finance Overview" description={ctx.location ? `Fee money at ${ctx.location.displayName}.` : 'Fee money at your campus.'} />
      <TabIntro title="Finance Overview" className="mb-4">
        {OVERVIEW_INTRO}
      </TabIntro>

      {(pulse.isError || aging.isError) && <ErrorState error={pulse.error ?? aging.error} onRetry={() => { void pulse.refetch(); void aging.refetch(); }} retrying={pulse.isFetching || aging.isFetching} />}
      <div className="grid gap-3 sm:grid-cols-3" aria-label="Finance pulse">
        {pulse.isLoading || aging.isLoading ? (
          <>
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-24 rounded-card" />
          </>
        ) : (
          <>
            <Tile label="Billed this month" value={formatMoney(pulse.data?.billedPaise ?? 0)} note={`${pulse.data ? monthLabel(pulse.data.month) : ''} · ${pulse.data?.billCount ?? 0} bills`} />
            <Tile label="Outstanding" value={formatMoney(aging.data?.totalPaise ?? 0)} note="Still to be paid, from all issued bills" />
            <Tile label="Overdue" value={formatMoney(overdue)} note="Past the due date" tone="danger" />
          </>
        )}
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card aria-label="Setup checklist">
          <CardHeader>
            <HelpHeading title="Setup checklist" help={<p>Finance needs a few things set up once. Open the checklist to finish them.</p>} />
            <Button asChild size="sm" variant="outline">
              <Link to="/finance/settings">
                Open Checklist <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          {readiness.isLoading && <Skeleton className="h-20" />}
          {readiness.data && (
            <>
              <p className="font-semibold" data-testid="overview-headline">
                {readiness.data.headline}
              </p>
              {todo.length === 0 ? (
                <p className="mt-2 flex items-center gap-2 text-sm text-success">
                  <CircleCheck className="size-4" aria-hidden="true" /> Everything is set up.
                </p>
              ) : (
                <ul className="mt-2 space-y-1.5">
                  {todo.slice(0, 4).map((i) => (
                    <li key={i.key} className="flex items-start gap-2 text-sm">
                      <CircleDashed className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
                      <span className="min-w-0 flex-1">{i.sentence}</span>
                      {i.fix && (
                        <Link to={i.fix.path} className="shrink-0 font-semibold text-brand hover:underline">
                          {i.fix.label}
                        </Link>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </Card>

        <Card aria-label="How late the unpaid bills are">
          <CardHeader>
            <HelpHeading title="How late are unpaid bills?" help={TIP_OUTSTANDING} helpLabel="About outstanding" />
            <Button asChild size="sm" variant="outline">
              <Link to="/finance/fees?tab=accounts">
                See Accounts <ArrowRight />
              </Link>
            </Button>
          </CardHeader>
          <ul className="space-y-2">
            {AGING_BUCKETS.map((b) => {
              const row = aging.data?.buckets.find((x) => x.bucket === b);
              return (
                <li key={b} className="text-sm">
                  <p className="flex justify-between gap-2">
                    <span>{AGING_LABELS[b]}</span>
                    <span className="font-semibold tabular-nums">{formatMoney(row?.totalPaise ?? 0)}</span>
                  </p>
                  <div className="mt-1 h-2 overflow-hidden rounded-full bg-ink/8" aria-hidden="true">
                    <div className={`h-full rounded-full ${b === 'CURRENT' ? 'bg-brand' : 'bg-danger/70'}`} style={{ width: `${((row?.totalPaise ?? 0) / max) * 100}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </>
  );
}
