import { useState } from 'react';
import { Link } from 'react-router';
import { Ban, ShieldAlert, UserRoundCheck } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { TextField } from '@/components/ui/field';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { CreatePlanCard, useTimetablePlan } from '../context';
import { DAILY_INTRO } from '../help-copy';
import { useDaily } from './api';
import { CancelTab } from './cancel-tab';
import { ExceptionsTab } from './exceptions-tab';
import { RoomsTab } from './rooms-tab';
import { SubstitutionsTab } from './substitutions-tab';
import { todayIso } from './views-page';

type Tab = 'exceptions' | 'substitutions' | 'rooms' | 'cancel';
const TABS: { id: Tab; label: string }[] = [
  { id: 'exceptions', label: "Today's Exceptions" },
  { id: 'substitutions', label: 'Substitutions' },
  { id: 'rooms', label: 'Room Changes' },
  { id: 'cancel', label: 'Cancellations & Swaps' },
];

/** `/timetable/daily`: the day-to-day work. Nothing here edits the weekly timetable. */
export function DailyPage() {
  const { plan, loading } = useTimetablePlan();
  const [date, setDate] = useState(todayIso());
  const [tab, setTab] = useState<Tab>('exceptions');
  const day = useDaily(plan?.planId, date);
  const d = day.data;

  return (
    <>
      <PageHeader eyebrow="Timetable" title="Daily Operations" description="A teacher is away, a room is closed, a lesson is cancelled? Handle it here for the day." />
      <div className="space-y-4">
        <TabIntro title="How this works">{DAILY_INTRO}</TabIntro>
        {loading && <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading" />}
        {!loading && !plan && <CreatePlanCard />}
        {plan && (
          <>
            <Card className="flex flex-col gap-3 p-4 sm:flex-row sm:items-end sm:justify-between sm:p-5">
              <div className="flex flex-wrap items-end gap-3">
                <TextField label="Day" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} containerClassName="w-44" />
                <Button variant="outline" onClick={() => setDate(todayIso())}>
                  Today
                </Button>
              </div>
              <div className="min-w-0 sm:text-right" aria-live="polite">
                <p className="text-lg font-extrabold" data-testid="daily-line">
                  {d ? d.line : 'Loading…'}
                </p>
                {d && (
                  <p className="mt-1 flex flex-wrap gap-1.5 sm:justify-end">
                    {d.summary.uncovered > 0 && (
                      <Badge tone="danger">
                        <ShieldAlert aria-hidden="true" /> {d.summary.uncovered} no teacher
                      </Badge>
                    )}
                    {d.summary.substituted > 0 && (
                      <Badge tone="brand">
                        <UserRoundCheck aria-hidden="true" /> {d.summary.substituted} covered
                      </Badge>
                    )}
                    {d.summary.cancelled > 0 && (
                      <Badge tone="danger">
                        <Ban aria-hidden="true" /> {d.summary.cancelled} cancelled
                      </Badge>
                    )}
                    {d.summary.roomChanged > 0 && <Badge tone="sun">{d.summary.roomChanged} room changes</Badge>}
                  </p>
                )}
              </div>
            </Card>

            {d && !d.versionId && !d.message?.startsWith('Not') && (
              <Card className="space-y-2 p-5 text-center">
                <p className="text-sm text-muted">{d.message}</p>
                <Button asChild>
                  <Link to="/timetable/schedule">Go To Schedule</Link>
                </Button>
              </Card>
            )}

            <div role="tablist" aria-label="Daily Operations" className="flex gap-1 overflow-x-auto border-b border-line">
              {TABS.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} className={cn('-mb-px shrink-0 border-b-2 px-3 py-2 text-sm font-semibold', tab === t.id ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink')}>
                  {t.label}
                </button>
              ))}
            </div>
            {day.isLoading && <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading the day" />}
            {day.isError && <ErrorState error={day.error} onRetry={() => void day.refetch()} />}
            {tab === 'exceptions' && d && <ExceptionsTab planId={plan.planId} locationId={plan.locationId} day={d} date={date} onGo={setTab} />}
            {tab === 'substitutions' && <SubstitutionsTab planId={plan.planId} locationId={plan.locationId} date={date} />}
            {tab === 'rooms' && <RoomsTab planId={plan.planId} locationId={plan.locationId} date={date} />}
            {tab === 'cancel' && <CancelTab planId={plan.planId} locationId={plan.locationId} day={d} date={date} />}
          </>
        )}
      </div>
    </>
  );
}
