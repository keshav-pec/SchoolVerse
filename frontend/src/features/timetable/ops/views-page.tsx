import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { Combobox } from '@/components/ui/combobox';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { cn } from '@/lib/utils';
import { useCampusRooms } from '../../spaces/api';
import { useBellResolution, useGroups, usePlanTeachers } from '../api';
import { CreatePlanCard, useTimetablePlan } from '../context';
import { VIEWS_INTRO } from '../help-copy';
import { useView, type ViewKind } from './api';
import { WeekView, type Perspective } from './effective-view';

const KINDS: { id: ViewKind; label: string; perspective: Perspective; free: boolean }[] = [
  { id: 'section', label: 'Section', perspective: 'section', free: false },
  { id: 'teacher', label: 'Teacher', perspective: 'teacher', free: true },
  { id: 'space', label: 'Room', perspective: 'room', free: true },
  { id: 'teaching-group', label: 'Teaching Group', perspective: 'group', free: false },
];

export const todayIso = () => new Date().toLocaleDateString('en-CA');

/** `/timetable/views`. Anyone who can look at the timetable sees what is really on: the weekly lessons with the one-day changes marked. */
export function ViewsPage() {
  const { plan, loading } = useTimetablePlan();
  const [params, setParams] = useSearchParams();
  const kind = (KINDS.find((k) => k.id === params.get('kind'))?.id ?? 'section') as ViewKind;
  const [date, setDate] = useState(todayIso());
  const [week, setWeek] = useState(true);
  const resolution = useBellResolution(plan?.planId);
  const teachers = usePlanTeachers(plan?.planId);
  const groups = useGroups(plan?.planId);
  const rooms = useCampusRooms(plan?.locationId, kind === 'space');

  const options = useMemo(() => {
    if (kind === 'teacher') return (teachers.data ?? []).map((t) => ({ value: t.employeeId, label: t.fullName, hint: t.employeeCode }));
    if (kind === 'space') return (rooms.data?.items ?? []).map((r) => ({ value: r.spaceId, label: r.spaceName, hint: undefined as string | undefined }));
    if (kind === 'teaching-group') return (groups.data ?? []).map((g) => ({ value: g.groupId, label: g.name, hint: g.subjectName ?? undefined }));
    return (resolution.data?.rows ?? []).map((s) => ({ value: s.sectionOfferingId, label: s.label, hint: s.className }));
  }, [kind, teachers.data, rooms.data, groups.data, resolution.data]);
  const id = params.get('id') && options.some((o) => o.value === params.get('id')) ? (params.get('id') as string) : options[0]?.value;
  const view = useView(kind, id, { date, week });
  const current = KINDS.find((k) => k.id === kind)!;

  return (
    <>
      <PageHeader eyebrow="Timetable" title="Views" description="See the timetable of a section, a teacher, a room or a Teaching Group, as it really is." />
      <div className="space-y-4">
        <TabIntro title="How this works">{VIEWS_INTRO}</TabIntro>
        {loading && <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading" />}
        {!loading && !plan && <CreatePlanCard />}
        {plan && (
          <>
            <div className="flex flex-wrap items-end gap-3">
              <div role="tablist" aria-label="What to look at" className="flex rounded-control border border-line bg-white p-0.5">
                {KINDS.map((k) => (
                  <button key={k.id} type="button" role="tab" aria-selected={kind === k.id} onClick={() => setParams({ kind: k.id })} className={cn('rounded-lg px-3 py-1.5 text-sm font-semibold', kind === k.id ? 'bg-brand text-white' : 'text-muted hover:text-ink')}>
                    {k.label}
                  </button>
                ))}
              </div>
              <Combobox aria-label={current.label} className="h-10 w-56" value={id ?? ''} onChange={(v) => setParams({ kind, id: v })} options={options} searchPlaceholder="Search…" placeholder={options.length === 0 ? 'Nothing to show' : 'Choose'} />
              <TextField label="Date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} containerClassName="w-44" />
              <div role="tablist" aria-label="Week or day" className="flex rounded-control border border-line bg-white p-0.5">
                {[
                  { v: true, label: 'Week' },
                  { v: false, label: 'Day' },
                ].map((o) => (
                  <button key={o.label} type="button" role="tab" aria-selected={week === o.v} onClick={() => setWeek(o.v)} className={cn('rounded-lg px-3 py-1.5 text-sm font-semibold', week === o.v ? 'bg-brand text-white' : 'text-muted hover:text-ink')}>
                    {o.label}
                  </button>
                ))}
              </div>
            </div>
            {view.isLoading && <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading the timetable" />}
            {view.isError && <ErrorState error={view.error} onRetry={() => void view.refetch()} />}
            {view.data && (
              <>
                <p className="text-sm font-semibold text-muted" data-testid="view-title">
                  {view.data.target.label}
                </p>
                <WeekView schedule={view.data} perspective={current.perspective} showFree={current.free} />
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}
