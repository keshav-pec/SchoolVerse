import { useState } from 'react';
import { Navigate } from 'react-router';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { cn } from '@/lib/utils';
import { useEffective } from '../timetable/ops/api';
import { DaySection, WeekView } from '../timetable/ops/effective-view';
import { todayIso } from '../timetable/ops/views-page';
import { ChildSwitcher, useChildSelection } from './parent-layout';

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7));

/** `/parent/timetable`: the child's day and week, with changes marked and a short note ("Maths today is taken by Mr. Rao"). Read-only. */
export function ParentTimetablePage() {
  const { query, children: kids, selectedId, select } = useChildSelection();
  const today = todayIso();
  const monday = mondayOf(today);
  const [tab, setTab] = useState<'today' | 'week'>('today');
  const q = useEffective(selectedId ? { studentId: selectedId } : null, tab === 'today' ? { from: today, to: today } : { from: monday, to: addDays(monday, 5) });
  if (query.isLoading) return <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading" />;
  if (query.isSuccess && kids.length === 0) return <Navigate to="/parent" replace />;
  const kid = kids.find((c) => c.studentId === selectedId);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-extrabold">Timetable</h1>
      <ChildSwitcher kids={kids} selectedId={selectedId} onSelect={select} />
      {kid && <p className="text-sm font-semibold text-muted">{kid.displayName || kid.fullName} · {kid.classSection?.label ?? 'No class yet'}</p>}
      <div role="tablist" aria-label="Today or week" className="flex w-fit rounded-control border border-line bg-white p-0.5">
        {(['today', 'week'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={cn('min-h-11 rounded-lg px-5 py-1.5 text-sm font-semibold', tab === t ? 'bg-brand text-white' : 'text-muted hover:text-ink')}>
            {t === 'today' ? 'Today' : 'This Week'}
          </button>
        ))}
      </div>
      {q.isLoading && <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading the timetable" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} />}
      {q.data && tab === 'today' && q.data.days[0] && <DaySection day={q.data.days[0]} perspective="student" heading="full" />}
      {q.data && tab === 'week' && <WeekView schedule={q.data} perspective="student" />}
    </div>
  );
}
