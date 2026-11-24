import { Link } from 'react-router';
import { ArrowRight, CalendarCheck2, CircleCheck, CircleDashed } from 'lucide-react';
import { WEEKDAY_LABELS, type TimetableReadinessAreaDTO, type TimetableReadinessItemDTO } from '@shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { cn } from '@/lib/utils';
import { useReadiness } from './api';
import { CreatePlanCard, useTimetablePlan } from './context';
import { OVERVIEW_INTRO } from './help-copy';

function Item({ item }: { item: TimetableReadinessItemDTO }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="font-semibold text-ink">{item.message}</p>
        {item.examples.length > 0 && <p className="mt-0.5 text-[13px] text-muted">{item.examples.join(' · ')}</p>}
      </div>
      <Button asChild variant="outline" size="sm" className="shrink-0">
        <Link to={item.fix.path}>
          {item.fix.label} <ArrowRight />
        </Link>
      </Button>
    </li>
  );
}

function Tile({ area }: { area: TimetableReadinessAreaDTO }) {
  const ready = area.status === 'READY';
  return (
    <Card className="space-y-3 p-4 sm:p-5" aria-label={area.label}>
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-base font-bold">
          {ready ? <CircleCheck className="size-5 text-success" aria-hidden="true" /> : <CircleDashed className="size-5 text-warning" aria-hidden="true" />}
          {area.label}
        </h2>
        <Badge tone={ready ? 'success' : 'warning'}>{ready ? 'All set' : area.summary}</Badge>
      </div>
      {ready ? <p className="text-sm text-muted">Nothing to fix here.</p> : <ul className="space-y-2">{area.items.map((item) => <Item key={item.key} item={item} />)}</ul>}
    </Card>
  );
}

/** `/timetable`. The first thing the admin sees is what is missing, never an empty grid. */
export function TimetableOverviewPage() {
  const { plan, loading } = useTimetablePlan();
  const readiness = useReadiness(plan?.planId);

  return (
    <>
      <PageHeader
        eyebrow="Timetable"
        title="Timetable Overview"
        description="See what is left before the timetable can be built."
        actions={
          plan && (
            <Button asChild variant="outline">
              <Link to="/timetable/setup">Open Setup</Link>
            </Button>
          )
        }
      />
      <div className="space-y-4">
        <TabIntro title="How this works">{OVERVIEW_INTRO}</TabIntro>
        {loading && <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />}
        {!loading && !plan && <CreatePlanCard />}
        {plan && (
          <>
            <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5">
              <div className="min-w-0">
                <p className="text-sm font-semibold text-muted">{plan.planName}</p>
                <p className="text-sm text-muted">
                  {plan.effectiveFrom} to {plan.effectiveTo} · {plan.operatingDays.map((d) => WEEKDAY_LABELS[d].slice(0, 3)).join(', ')}
                </p>
              </div>
            </Card>
            {readiness.isLoading && <Skeleton className="h-40 rounded-card" role="status" aria-label="Checking setup" />}
            {readiness.isError && <ErrorState error={readiness.error} onRetry={() => void readiness.refetch()} />}
            {readiness.data && (
              <>
                <Card className={cn('flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between sm:p-5', readiness.data.ready && 'border-success/40 bg-success-soft/40')}>
                  <div>
                    <h2 className="text-xl font-extrabold" aria-live="polite">
                      {readiness.data.message}
                    </h2>
                    <p className="text-sm text-muted">
                      {readiness.data.ready
                        ? 'Everything the timetable needs is in place.'
                        : readiness.data.canSmartDraft
                          ? 'The timetable can already be built. Missing teachers or rooms only leave some lessons unplaced.'
                          : readiness.data.smartDraftBlockedBy.join(' ')}
                    </p>
                  </div>
                  <span className="flex items-center gap-2">
                    <Button disabled aria-describedby="open-schedule-note">
                      <CalendarCheck2 /> Open Schedule
                    </Button>
                    <InfoTip label="About Open Schedule">
                      <p id="open-schedule-note">The schedule screen, where the timetable is built and checked, comes in the next update. Finish the setup first so it is ready.</p>
                    </InfoTip>
                  </span>
                </Card>
                <div className="grid gap-4 lg:grid-cols-2">
                  {readiness.data.areas.map((area) => (
                    <Tile key={area.area} area={area} />
                  ))}
                </div>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
