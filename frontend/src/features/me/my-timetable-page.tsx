import { useState } from 'react';
import { WEEKDAY_LABELS } from '@shared';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { cn } from '@/lib/utils';
import { MY_TIMETABLE_INTRO } from '../timetable/help-copy';
import { useEffective } from '../timetable/ops/api';
import { DaySection, WeekView } from '../timetable/ops/effective-view';
import { todayIso } from '../timetable/ops/views-page';

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/** `/me/timetable`: a teacher's own timetable, mobile first. Today comes first, then the week. Read-only. */
export function MyTimetablePage() {
  const today = todayIso();
  const monday = mondayOf(today);
  const [tab, setTab] = useState<'today' | 'week'>('today');
  const q = useEffective({ employeeId: 'me' }, tab === 'today' ? { from: today, to: today } : { from: monday, to: addDays(monday, 5) });
  return (
    <>
      <PageHeader eyebrow="People" title="My Timetable" description={MY_TIMETABLE_INTRO} />
      <div role="tablist" aria-label="Today or week" className="mb-4 flex w-fit rounded-control border border-line bg-white p-0.5">
        {(['today', 'week'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('min-h-10 rounded-lg px-4 py-1.5 text-sm font-semibold', tab === t ? 'bg-brand text-white' : 'text-muted hover:text-ink')}>
            {t === 'today' ? 'Today' : 'This Week'}
          </button>
        ))}
      </div>
      {q.isLoading && <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading your timetable" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && tab === 'today' && q.data.days[0] && (
        <>
          <p className="mb-2 text-sm font-semibold text-muted">{WEEKDAY_LABELS[q.data.days[0].weekday]}</p>
          <DaySection day={q.data.days[0]} perspective="teacher" showFree heading="short" />
        </>
      )}
      {q.data && tab === 'week' && <WeekView schedule={q.data} perspective="teacher" showFree />}
    </>
  );
}
