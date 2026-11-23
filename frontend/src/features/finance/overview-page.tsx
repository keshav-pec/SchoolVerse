import { Link } from 'react-router';
import { ArrowRight, Banknote, CircleCheck, CircleDashed, FileUp, ListChecks, ReceiptText, ShieldCheck, Users, Wallet } from 'lucide-react';
import type { ComponentType } from 'react';
import type { Permission } from '@shared';
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
import { useFinanceOverview } from './ops-api';
import { useAuth } from '@/lib/auth';
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

const QUICK: { to: string; label: string; Icon: ComponentType<{ className?: string }>; any: Permission[] }[] = [
  { to: '/finance/collect?tab=take', label: 'Take Payment', Icon: Banknote, any: ['finance:collection:record'] },
  { to: '/finance/fees?tab=billing', label: 'Generate Bills', Icon: ReceiptText, any: ['finance:billing:create'] },
  { to: '/finance/payroll', label: 'Process Payroll', Icon: Users, any: ['payroll:run:prepare'] },
  { to: '/finance/expenses', label: 'Add Expense', Icon: Wallet, any: ['finance:expense:record'] },
  { to: '/finance/banking', label: 'Import Statement', Icon: FileUp, any: ['finance:reconciliation:manage'] },
  { to: '/finance/settings?tab=approvals', label: 'Review Approvals', Icon: ShieldCheck, any: ['finance:view'] },
];

/** Finance Pulse from the whole school: each tile only for people allowed to see it (the API sends `null` otherwise). */
function Pulse() {
  const { can } = useAuth();
  const q = useFinanceOverview();
  const d = q.data;
  const tiles = d
    ? ([
        ['Collections today', d.collectionsTodayPaise, 'Money received and checked today'],
        ['Payroll payable', d.payrollPayablePaise, 'Salaries finalised but not paid'],
        ['Expenses this month', d.monthlyExpensesPaise, 'Booked so far'],
        ['Cash in hand', d.cashInHandPaise, 'Counted in open shifts and cash boxes'],
      ] as const)
    : [];
  return (
    <section aria-label="Across the school" className="mt-4 space-y-3">
      {d && d.attentionTotal > 0 && (
        <Link to="/finance/attention" className="flex items-center gap-2 rounded-xl border border-warning/25 bg-warning-soft px-4 py-3 text-[15px] hover:border-warning/50">
          <ListChecks className="size-5 text-warning" aria-hidden="true" />
          <span>
            <b>{d.attentionTotal}</b> {d.attentionTotal === 1 ? 'thing needs' : 'things need'} attention
          </span>
          <ArrowRight className="ml-auto size-4" aria-hidden="true" />
        </Link>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {tiles
          .filter(([, v]) => v !== null)
          .map(([label, v, note]) => (
            <Tile key={label} label={label} value={formatMoney(v ?? 0)} note={note} />
          ))}
        {d && d.unreconciledBankLines !== null && <Tile label="Bank lines not matched" value={String(d.unreconciledBankLines)} note="From imported statements" />}
      </div>
      <Card aria-label="Quick actions">
        <CardHeader>
          <HelpHeading title="Quick actions" help={<p>The jobs people do most often. Each button shows only if you are allowed to do it.</p>} />
        </CardHeader>
        <div className="flex flex-wrap gap-2">
          {QUICK.filter((x) => x.any.some(can)).map((x) => (
            <Button key={x.label} asChild variant="outline">
              <Link to={x.to}>
                <x.Icon /> {x.label}
              </Link>
            </Button>
          ))}
        </div>
      </Card>
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

      <Pulse />

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
