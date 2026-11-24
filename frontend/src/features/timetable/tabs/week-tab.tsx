import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { Plus, Trash2 } from 'lucide-react';
import { WEEKDAYS, WEEKDAY_LABELS, type BellGenerateResultDTO, type TimetablePlanDTO, type Weekday } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { TabIntro } from '@/components/sv/help';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { useBellPreview, useBellSchedules, useTimetableMutation, type GenerateBody } from '../api';
import { WEEK_INTRO } from '../help-copy';
import { Timeline, TimelineLegend } from '../timeline';

interface BreakRow {
  id: number;
  name: string;
  start: string;
  end: string;
  type: 'BREAK' | 'LUNCH';
}

const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

function SchoolDays({ plan, canEdit }: { plan: TimetablePlanDTO; canEdit: boolean }) {
  const [days, setDays] = useState<Weekday[]>(plan.operatingDays);
  const save = useTimetableMutation(() => api.patch<TimetablePlanDTO>(`/timetable-plans/${plan.planId}`, { version: plan.version, operatingDays: WEEKDAYS.filter((d) => days.includes(d)) }), { success: 'School days saved.' });
  const dirty = WEEKDAYS.filter((d) => days.includes(d)).join() !== plan.operatingDays.join();
  return (
    <Card className="space-y-3 p-4 sm:p-5">
      <h2 className="text-lg font-bold">School days</h2>
      <div className="flex flex-wrap gap-2" role="group" aria-label="School days">
        {WEEKDAYS.map((d) => {
          const on = days.includes(d);
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              disabled={!canEdit}
              onClick={() => setDays(on ? days.filter((x) => x !== d) : [...days, d])}
              className={cn('min-h-11 min-w-16 rounded-control border px-3 text-sm font-semibold transition-colors focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none disabled:opacity-60', on ? 'border-brand bg-brand text-white' : 'border-control bg-white text-ink hover:border-ink/50')}
            >
              {WEEKDAY_LABELS[d].slice(0, 3)}
            </button>
          );
        })}
      </div>
      {days.length === 0 && <p className="text-sm text-danger">Choose at least one school day.</p>}
      {canEdit && (
        <Button disabled={!dirty || days.length === 0} loading={save.isPending} loadingText="Saving…" onClick={() => save.mutate(undefined)}>
          Save School Days
        </Button>
      )}
    </Card>
  );
}

/** Tab 1: the school day. The right side shows the day as it will be made, before anything is saved. */
export function WeekTab({ plan, canEdit }: { plan: TimetablePlanDTO; canEdit: boolean }) {
  const bells = useBellSchedules(plan.planId);
  const [name, setName] = useState('Regular');
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('14:30');
  const [minutes, setMinutes] = useState('45');
  const [breaks, setBreaks] = useState<BreakRow[]>([
    { id: 1, name: 'Short Break', start: '10:15', end: '10:30', type: 'BREAK' },
    { id: 2, name: 'Lunch', start: '12:00', end: '12:30', type: 'LUNCH' },
  ]);
  const [assembly, setAssembly] = useState(false);
  const [assemblyTime, setAssemblyTime] = useState({ start: '08:00', end: '08:10' });
  const [nextId, setNextId] = useState(3);

  const body = useMemo<GenerateBody | null>(() => {
    const length = Number(minutes);
    const rows = breaks.filter((b) => b.name.trim());
    const times = [start, end, ...rows.flatMap((b) => [b.start, b.end]), ...(assembly ? [assemblyTime.start, assemblyTime.end] : [])];
    if (!name.trim() || !Number.isInteger(length) || length < 10 || length > 180 || !times.every((t) => TIME.test(t))) return null;
    return {
      name: name.trim(),
      kind: 'REGULAR',
      start,
      end,
      periodMinutes: length,
      breaks: rows.map((b) => ({ name: b.name.trim(), start: b.start, end: b.end, type: b.type })),
      ...(assembly ? { assembly: { name: 'Assembly', ...assemblyTime } } : {}),
    };
  }, [name, start, end, minutes, breaks, assembly, assemblyTime]);

  const preview = useBellPreview(plan.planId, body);
  const create = useTimetableMutation((b: GenerateBody) => api.post<BellGenerateResultDTO>(`/timetable-plans/${plan.planId}/bell-schedules/generate`, b), {
    success: (r) => (r.alreadyExisted ? `“${r.schedule.name}” already exists with these periods.` : `Daily Periods “${r.schedule.name}” created.`),
  });
  const setBreak = (id: number, patch: Partial<BreakRow>) => setBreaks(breaks.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  const exists = bells.data?.some((b) => b.name.toLowerCase() === name.trim().toLowerCase());

  return (
    <div className="space-y-4">
      <TabIntro title="School Week" need="required">
        {WEEK_INTRO}
      </TabIntro>
      <SchoolDays plan={plan} canEdit={canEdit} />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card className="space-y-4 p-4 sm:p-5">
          <h2 className="text-lg font-bold">The school day</h2>
          <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} hint="Example: Regular, Junior, Saturday." disabled={!canEdit} />
          <div className="grid gap-3 sm:grid-cols-3">
            <TextField label="School starts" type="time" value={start} onChange={(e) => setStart(e.target.value)} disabled={!canEdit} />
            <TextField label="School ends" type="time" value={end} onChange={(e) => setEnd(e.target.value)} disabled={!canEdit} />
            <TextField label="Period length (minutes)" type="number" min={10} max={180} value={minutes} onChange={(e) => setMinutes(e.target.value)} disabled={!canEdit} />
          </div>
          <fieldset className="space-y-2">
            <legend className="text-sm font-semibold">Breaks</legend>
            {breaks.map((b) => (
              <div key={b.id} className="grid grid-cols-[1fr_auto_auto_auto] items-end gap-2">
                <TextField label="Break name" value={b.name} onChange={(e) => setBreak(b.id, { name: e.target.value })} disabled={!canEdit} />
                <TextField label="From" type="time" value={b.start} onChange={(e) => setBreak(b.id, { start: e.target.value })} disabled={!canEdit} />
                <TextField label="To" type="time" value={b.end} onChange={(e) => setBreak(b.id, { end: e.target.value })} disabled={!canEdit} />
                <Button variant="ghost" size="icon" aria-label={`Remove ${b.name || 'break'}`} disabled={!canEdit} onClick={() => setBreaks(breaks.filter((x) => x.id !== b.id))}>
                  <Trash2 />
                </Button>
              </div>
            ))}
            {canEdit && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setBreaks([...breaks, { id: nextId, name: '', start: '11:00', end: '11:15', type: 'BREAK' }]);
                  setNextId(nextId + 1);
                }}
              >
                <Plus /> Add Break
              </Button>
            )}
          </fieldset>
          <fieldset className="space-y-2">
            <label className="flex items-center gap-2 text-sm font-semibold">
              <input type="checkbox" checked={assembly} disabled={!canEdit} onChange={(e) => setAssembly(e.target.checked)} className="size-4 accent-brand" />
              Morning assembly (optional)
            </label>
            {assembly && (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Assembly from" type="time" value={assemblyTime.start} onChange={(e) => setAssemblyTime({ ...assemblyTime, start: e.target.value })} />
                <TextField label="Assembly to" type="time" value={assemblyTime.end} onChange={(e) => setAssemblyTime({ ...assemblyTime, end: e.target.value })} />
              </div>
            )}
          </fieldset>
        </Card>

        <Card className="space-y-3 p-4 sm:p-5">
          <h2 className="text-lg font-bold">Preview</h2>
          {!body && <p className="text-sm text-muted">Fill in the times and the period length to see the day.</p>}
          {preview.isError && <Alert tone="danger">{messageFor(preview.error)}</Alert>}
          {body && preview.data && !preview.isError && (
            <>
              <Timeline periods={preview.data.periods.map((p) => ({ key: p.periodCode, name: p.periodName, start: p.start, end: p.end, startMin: p.startMin, endMin: p.endMin, periodType: p.periodType }))} />
              <TimelineLegend />
              <p className="text-sm font-semibold" data-testid="preview-summary">
                {preview.data.lessonPeriods} lesson periods a day.
              </p>
              {preview.data.message && <Alert tone="warning">{preview.data.message}</Alert>}
              <ul className="grid gap-1 text-sm sm:grid-cols-2" aria-label="Periods">
                {preview.data.periods.map((p) => (
                  <li key={p.periodCode} className="flex justify-between gap-2 border-b border-line/60 py-1">
                    <span>{p.periodName}</span>
                    <span className="text-muted">
                      {p.start} – {p.end}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}
          {canEdit && (
            <div className="flex flex-wrap items-center gap-3 pt-1">
              <Button disabled={!body || preview.isError || !!exists} loading={create.isPending} loadingText="Creating…" onClick={() => body && create.mutate(body)}>
                Create Daily Periods
              </Button>
              {exists && <p className="text-sm text-muted">There are already Daily Periods called “{name.trim()}”. Use another name, or change them in Daily Periods.</p>}
              {create.data && (
                <Button asChild variant="outline">
                  <Link to="/timetable/setup?tab=periods">Go To Daily Periods</Link>
                </Button>
              )}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
