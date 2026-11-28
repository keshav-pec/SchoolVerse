import { Link } from 'react-router';
import { CalendarClock } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useEffective } from './api';
import { todayIso } from './views-page';
import { LessonCard } from './effective-view';

/** "Today" on a teacher's home page: their periods, free periods and anything covered for them. Nothing at all for someone with no lessons. */
export function TodayCard() {
  const date = todayIso();
  const q = useEffective({ employeeId: 'me' }, { from: date, to: date });
  if (q.isLoading) return <Skeleton className="h-24 rounded-card" />;
  const day = q.data?.days[0];
  if (!day || !day.versionId || day.items.length === 0) return null;
  return (
    <Card className="p-4 sm:p-5" aria-label="Today">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
          <CalendarClock className="size-5 text-brand" aria-hidden="true" /> Today
        </h2>
        <Link to="/me/timetable" className="text-sm font-semibold text-brand hover:underline">
          My Timetable
        </Link>
      </div>
      <ul className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {day.items.slice(0, 6).map((i) => (
          <LessonCard key={i.entryId} item={i} perspective="teacher" />
        ))}
      </ul>
    </Card>
  );
}
