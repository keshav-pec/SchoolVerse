import { useEffect, useMemo, useState } from 'react';
import { Copy, Pencil, Plus, Star, Trash2 } from 'lucide-react';
import {
  BELL_KINDS,
  BELL_KIND_LABELS,
  PERIOD_TYPES,
  PERIOD_TYPE_LABELS,
  WEEKDAYS,
  WEEKDAY_LABELS,
  clockToMinutes,
  minutesToClock,
  type BellAssignmentsDTO,
  type BellBulkResultDTO,
  type BellPeriodDTO,
  type BellScheduleDTO,
  type PeriodType,
  type TimetablePlanDTO,
  type Weekday,
} from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { useClassOfferings } from '../../academic/api';
import { useStudentContext } from '../../students/context';
import { useBellAssignments, useBellResolution, useBellSchedules, useTimetableMutation } from '../api';
import { PERIODS_INTRO, TIPS } from '../help-copy';
import { Timeline, TimelineLegend } from '../timeline';

const typeOptions = PERIOD_TYPES.map((t) => ({ value: t, label: PERIOD_TYPE_LABELS[t] }));
const kindOptions = BELL_KINDS.map((k) => ({ value: k, label: BELL_KIND_LABELS[k] }));
const TIME = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Does `start`–`end` fit this period's slot without touching the others? Returns the reason in words, or null. */
export function periodProblem(others: Pick<BellPeriodDTO, 'periodName' | 'startMin' | 'endMin' | 'start' | 'end'>[], start: string, end: string): string | null {
  if (!TIME.test(start) || !TIME.test(end)) return 'Enter the times like 08:30.';
  const s = clockToMinutes(start)!;
  const e = clockToMinutes(end)!;
  if (e <= s) return 'A period must end after it starts.';
  const clash = others.find((o) => s < o.endMin && e > o.startMin);
  return clash ? `This overlaps ${clash.periodName} (${clash.start} to ${clash.end}).` : null;
}

// ───────────────────────────────────────────────────────────── one period row

function PeriodRow({ period, others, canEdit }: { period: BellPeriodDTO; others: BellPeriodDTO[]; canEdit: boolean }) {
  const [name, setName] = useState(period.periodName);
  const [start, setStart] = useState(period.start);
  const [end, setEnd] = useState(period.end);
  const [type, setType] = useState<PeriodType>(period.periodType);
  useEffect(() => {
    setName(period.periodName);
    setStart(period.start);
    setEnd(period.end);
    setType(period.periodType);
  }, [period]);
  const problem = periodProblem(others, start, end);
  const save = useTimetableMutation((patch: Record<string, unknown>) => api.patch<BellPeriodDTO>(`/bell-schedule-periods/${period.periodId}`, patch), { success: (r) => (r.usedByEntries > 0 ? `Saved. ${r.usedByEntries} lessons use this period.` : 'Saved.') });
  const remove = useTimetableMutation(() => api.delete<void>(`/bell-schedule-periods/${period.periodId}`), { success: 'Period removed.', quiet: true });
  const [confirm, setConfirm] = useState(false);
  const commit = (patch: Record<string, unknown>) => {
    if (problem && ('start' in patch || 'end' in patch)) return;
    save.mutate(patch);
  };
  return (
    <div className={cn('rounded-xl border bg-white p-3', problem ? 'border-danger bg-danger-soft/40' : 'border-line')}>
      <div className="grid grid-cols-2 items-end gap-2 sm:grid-cols-[minmax(0,1.4fr)_7rem_7rem_minmax(0,1fr)_auto]">
        <TextField label="Name" value={name} disabled={!canEdit} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name.trim() !== period.periodName && commit({ periodName: name.trim() })} containerClassName="col-span-2 sm:col-span-1" />
        <TextField label="From" type="time" value={start} disabled={!canEdit} onChange={(e) => setStart(e.target.value)} onBlur={() => start !== period.start && commit({ start })} aria-invalid={!!problem || undefined} />
        <TextField label="To" type="time" value={end} disabled={!canEdit} onChange={(e) => setEnd(e.target.value)} onBlur={() => end !== period.end && commit({ end })} aria-invalid={!!problem || undefined} />
        <ComboboxField
          label="Kind"
          value={type}
          disabled={!canEdit}
          onChange={(v) => {
            setType(v as PeriodType);
            commit({ periodType: v });
          }}
          options={typeOptions}
          searchPlaceholder="Search kinds…"
        />
        {canEdit && (
          <Button variant="ghost" size="icon" aria-label={`Remove ${period.periodName}`} onClick={() => setConfirm(true)}>
            <Trash2 />
          </Button>
        )}
      </div>
      {problem && (
        <p className="mt-2 text-sm font-semibold text-danger" role="alert">
          {problem}
        </p>
      )}
      {!problem && !period.schedulable && <p className="mt-1 text-[13px] text-muted">No lessons go here.</p>}
      <ConfirmDialog open={confirm} onOpenChange={setConfirm} title={`Remove ${period.periodName}?`} description="Lessons placed in this period would have nowhere to go, so we only remove it when nothing uses it." confirmLabel="Remove Period" loadingLabel="Removing…" tone="danger" onConfirm={async () => void (await remove.mutateAsync(undefined))} />
    </div>
  );
}

// ───────────────────────────────────────────────────────────── insert a period

function InsertPeriod({ schedule, before, after, onClose }: { schedule: BellScheduleDTO; before: BellPeriodDTO | null; after: BellPeriodDTO | null; onClose: () => void }) {
  const start0 = before ? before.end : after ? minutesToClock(Math.max(0, after.startMin - 45)) : '08:00';
  const end0 = after ? after.start : minutesToClock(Math.min(1440, (before?.endMin ?? 480) + 45));
  const [name, setName] = useState('');
  const [start, setStart] = useState(start0);
  const [end, setEnd] = useState(end0);
  const [type, setType] = useState<PeriodType>('TEACHING');
  const problem = periodProblem(schedule.periods, start, end);
  const add = useTimetableMutation(() => api.post(`/bell-schedules/${schedule.bellScheduleId}/periods`, { periodName: name.trim() || (type === 'TEACHING' ? 'New Period' : PERIOD_TYPE_LABELS[type]), start, end, periodType: type }), { success: 'Period added.' });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Insert Period"
      description={before ? `After ${before.periodName}.` : 'At the start of the day.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!!problem} loading={add.isPending} loadingText="Adding…" onClick={async () => void (await add.mutateAsync(undefined).then(onClose, () => undefined))}>
            Add Period
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} hint="Optional. Example: Zero Period." />
        <div className="grid grid-cols-2 gap-3">
          <TextField label="From" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="To" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        <ComboboxField label="Kind" value={type} onChange={(v) => setType(v as PeriodType)} options={typeOptions} searchPlaceholder="Search kinds…" />
        {problem && <p className="text-sm font-semibold text-danger" role="alert">{problem}</p>}
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── a template

function ScheduleEditor({ schedule, plan, canEdit, onDeleted }: { schedule: BellScheduleDTO; plan: TimetablePlanDTO; canEdit: boolean; onDeleted: () => void }) {
  const [insert, setInsert] = useState<{ before: BellPeriodDTO | null; after: BellPeriodDTO | null } | null>(null);
  const [copy, setCopy] = useState<'copy' | 'rename' | null>(null);
  const [confirm, setConfirm] = useState(false);
  const makeDefault = useTimetableMutation(() => api.post(`/timetable-plans/${plan.planId}/bell-assignments/bulk`, { bellScheduleId: schedule.bellScheduleId, scope: 'DEFAULT' }), { success: `${schedule.name} is now the school default.` });
  const remove = useTimetableMutation(() => api.delete<void>(`/bell-schedules/${schedule.bellScheduleId}`), { success: 'Daily Periods removed.', quiet: true });
  const periods = schedule.periods;
  return (
    <Card className="space-y-3 p-4 sm:p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex flex-wrap items-center gap-2 text-lg font-bold">
          {schedule.name}
          <Badge tone="neutral">{BELL_KIND_LABELS[schedule.kind]}</Badge>
          {schedule.isDefault && <Badge tone="brand">School default</Badge>}
          <span className="text-sm font-medium text-muted">{schedule.lessonPeriods} lesson periods</span>
        </h3>
        {canEdit && (
          <div className="flex flex-wrap gap-2">
            {!schedule.isDefault && (
              <Button variant="outline" size="sm" loading={makeDefault.isPending} onClick={() => makeDefault.mutate(undefined)}>
                <Star /> Make School Default
              </Button>
            )}
            <Button variant="outline" size="sm" onClick={() => setCopy('rename')}>
              <Pencil /> Edit Name
            </Button>
            <Button variant="outline" size="sm" onClick={() => setCopy('copy')}>
              <Copy /> Make A Copy
            </Button>
            <Button variant="outline" size="sm" onClick={() => setConfirm(true)}>
              <Trash2 /> Remove
            </Button>
          </div>
        )}
      </div>
      <Timeline periods={periods.map((p) => ({ key: p.periodId, name: p.periodName, start: p.start, end: p.end, startMin: p.startMin, endMin: p.endMin, periodType: p.periodType }))} />
      <TimelineLegend />
      {periods.length === 0 && <p className="text-sm text-muted">No periods yet. Add the first one below.</p>}
      <ul className="space-y-1" aria-label={`Periods of ${schedule.name}`}>
        {canEdit && (
          <li>
            <Button variant="ghost" size="sm" onClick={() => setInsert({ before: null, after: periods[0] ?? null })}>
              <Plus /> Insert Period
            </Button>
          </li>
        )}
        {periods.map((p, i) => (
          <li key={p.periodId} className="space-y-1">
            <PeriodRow period={p} others={periods.filter((o) => o.periodId !== p.periodId)} canEdit={canEdit} />
            {canEdit && (
              <Button variant="ghost" size="sm" aria-label={`Insert a period after ${p.periodName}`} onClick={() => setInsert({ before: p, after: periods[i + 1] ?? null })}>
                <Plus /> Insert Period
              </Button>
            )}
          </li>
        ))}
      </ul>
      {insert && <InsertPeriod schedule={schedule} before={insert.before} after={insert.after} onClose={() => setInsert(null)} />}
      {copy && <NameModal schedule={schedule} mode={copy} onClose={() => setCopy(null)} />}
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={`Remove ${schedule.name}?`}
        description="If classes use these Daily Periods, choose other ones for them first. We will tell you."
        confirmLabel="Remove Daily Periods"
        loadingLabel="Removing…"
        tone="danger"
        onConfirm={async () => {
          await remove.mutateAsync(undefined);
          onDeleted();
        }}
      />
    </Card>
  );
}

function NameModal({ schedule, mode, onClose }: { schedule: BellScheduleDTO; mode: 'copy' | 'rename'; onClose: () => void }) {
  const [name, setName] = useState(mode === 'copy' ? `${schedule.name} copy` : schedule.name);
  const [kind, setKind] = useState<string>(mode === 'copy' ? 'JUNIOR' : schedule.kind);
  const save = useTimetableMutation(
    () => (mode === 'copy' ? api.post(`/bell-schedules/${schedule.bellScheduleId}/duplicate`, { name: name.trim(), kind }) : api.patch(`/bell-schedules/${schedule.bellScheduleId}`, { name: name.trim(), kind })),
    { success: mode === 'copy' ? 'Copy made.' : 'Saved.' },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={mode === 'copy' ? 'Make A Copy' : 'Edit Name'}
      description={mode === 'copy' ? 'The copy has the same periods. Change them after. Use it for Junior classes or Saturday.' : undefined}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!name.trim()} loading={save.isPending} loadingText="Saving…" onClick={async () => void (await save.mutateAsync(undefined).then(onClose, () => undefined))}>
            {mode === 'copy' ? 'Make Copy' : 'Save Name'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextField label="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <ComboboxField label="Kind" value={kind} onChange={setKind} options={kindOptions} searchPlaceholder="Search kinds…" />
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── who uses which

function WhoUsesWhich({ plan, schedules, assignments, canEdit }: { plan: TimetablePlanDTO; schedules: BellScheduleDTO[]; assignments: BellAssignmentsDTO; canEdit: boolean }) {
  const ctx = useStudentContext();
  const classes = useClassOfferings(ctx.sessionId, ctx.locationId);
  const resolution = useBellResolution(plan.planId);
  const [template, setTemplate] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [someDays, setSomeDays] = useState(false);
  const [days, setDays] = useState<Weekday[]>([]);
  const [sectionTemplate, setSectionTemplate] = useState('');
  const [sectionId, setSectionId] = useState('');
  const nameOf = useMemo(() => new Map(schedules.map((s) => [s.bellScheduleId, s.name])), [schedules]);
  const options = schedules.map((s) => ({ value: s.bellScheduleId, label: s.name, hint: BELL_KIND_LABELS[s.kind] }));
  const list = classes.data ?? [];

  const apply = useTimetableMutation((body: Record<string, unknown>) => api.post<BellBulkResultDTO>(`/timetable-plans/${plan.planId}/bell-assignments/bulk`, body), {
    success: (r) => (r.defaultSet ? 'School default changed.' : `Daily Periods set for ${r.applied} ${r.applied === 1 ? 'item' : 'items'}.`),
  });
  const usesOf = (classOfferingId: string): string => {
    const rows = assignments.items.filter((a) => a.scope === 'CLASS' && a.classOfferingId === classOfferingId);
    if (rows.length === 0) return `School default (${nameOf.get(assignments.defaultBellScheduleId ?? '') ?? 'none yet'})`;
    return rows.map((r) => `${nameOf.get(r.bellScheduleId) ?? 'Unknown'}${r.weekdays.length ? ` on ${r.weekdays.map((d) => WEEKDAY_LABELS[d].slice(0, 3)).join(', ')}` : ''}`).join(', ');
  };
  const sectionRows = assignments.items.filter((a) => a.scope === 'SECTION');
  const sectionOptions = (resolution.data?.rows ?? []).map((r) => ({ value: r.sectionOfferingId, label: r.label, hint: r.className }));

  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <HelpHeading title="Who uses which" help={<p>Pick the Daily Periods for many classes in one go. Example: Regular for Classes 3 to 12, Junior for Nursery to Class 2. A class without its own choice uses the school default.</p>} />
      {resolution.data && resolution.data.missing.length > 0 && (
        <Alert tone="warning" title={`${resolution.data.missing.length} ${resolution.data.missing.length === 1 ? 'section has' : 'sections have'} no Daily Periods`}>
          {resolution.data.missing.map((m) => m.label).join(', ')}. Choose a school default below, or pick Daily Periods for these classes.
        </Alert>
      )}
      {canEdit && (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <ComboboxField label="School default" value={assignments.defaultBellScheduleId ?? ''} onChange={(v) => v && apply.mutate({ bellScheduleId: v, scope: 'DEFAULT' })} options={options} placeholder="Choose Daily Periods" searchPlaceholder="Search Daily Periods…" hint="Used by every class that has no choice of its own." />
        </div>
      )}
      {classes.isLoading && <Skeleton className="h-24" role="status" aria-label="Loading classes" />}
      {list.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-canvas text-left text-[13px] text-muted">
              <tr>
                {canEdit && (
                  <th scope="col" className="w-10 p-2">
                    <input
                      type="checkbox"
                      aria-label="Select all classes"
                      className="size-4 accent-brand"
                      checked={picked.length === list.length}
                      onChange={(e) => setPicked(e.target.checked ? list.map((c) => c.classOfferingId) : [])}
                    />
                  </th>
                )}
                <th scope="col" className="p-2 font-semibold">Class</th>
                <th scope="col" className="p-2 font-semibold">Uses</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {list.map((c) => (
                <tr key={c.classOfferingId}>
                  {canEdit && (
                    <td className="p-2">
                      <input
                        type="checkbox"
                        aria-label={`Choose ${c.displayName}`}
                        className="size-4 accent-brand"
                        checked={picked.includes(c.classOfferingId)}
                        onChange={(e) => setPicked(e.target.checked ? [...picked, c.classOfferingId] : picked.filter((x) => x !== c.classOfferingId))}
                      />
                    </td>
                  )}
                  <th scope="row" className="p-2 text-left font-semibold">{c.displayName}</th>
                  <td className="p-2 text-muted">{usesOf(c.classOfferingId)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canEdit && list.length > 0 && (
        <div className="space-y-3 rounded-xl border border-line bg-canvas/60 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <ComboboxField label="Apply these Daily Periods" value={template} onChange={setTemplate} options={options} placeholder="Choose Daily Periods" searchPlaceholder="Search Daily Periods…" containerClassName="min-w-56 flex-1" />
            <Button variant="outline" onClick={() => setPicked(list.map((c) => c.classOfferingId))}>
              Select All
            </Button>
            <Button variant="outline" onClick={() => setPicked([])}>
              Clear
            </Button>
          </div>
          <label className="flex items-center gap-2 text-sm font-semibold">
            <input type="checkbox" className="size-4 accent-brand" checked={someDays} onChange={(e) => setSomeDays(e.target.checked)} />
            Only on some days? (optional)
          </label>
          {someDays && (
            <div className="flex flex-wrap gap-2" role="group" aria-label="Days">
              {WEEKDAYS.filter((d) => plan.operatingDays.includes(d)).map((d) => (
                <button key={d} type="button" aria-pressed={days.includes(d)} onClick={() => setDays(days.includes(d) ? days.filter((x) => x !== d) : [...days, d])} className={cn('min-h-9 rounded-control border px-3 text-sm font-semibold', days.includes(d) ? 'border-brand bg-brand text-white' : 'border-control bg-white')}>
                  {WEEKDAY_LABELS[d].slice(0, 3)}
                </button>
              ))}
            </div>
          )}
          <Button disabled={!template || picked.length === 0 || (someDays && days.length === 0)} loading={apply.isPending} loadingText="Saving…" onClick={() => apply.mutate({ bellScheduleId: template, scope: 'CLASS', classOfferingIds: picked, ...(someDays ? { weekdays: days } : {}) })}>
            Apply To {picked.length} {picked.length === 1 ? 'Class' : 'Classes'}
          </Button>
        </div>
      )}
      {canEdit && (
        <details className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-semibold">Different for one section</summary>
          <div className="mt-3 space-y-3">
            <p className="text-sm text-muted">Use this only when one section follows other Daily Periods than its class.</p>
            {sectionRows.length > 0 && (
              <ul className="space-y-1 text-sm" aria-label="Sections with their own Daily Periods">
                {sectionRows.map((r) => (
                  <li key={r.assignmentId}>
                    {sectionOptions.find((s) => s.value === r.sectionOfferingId)?.label ?? 'A section'}: {nameOf.get(r.bellScheduleId)}
                  </li>
                ))}
              </ul>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <ComboboxField label="Section" value={sectionId} onChange={setSectionId} options={sectionOptions} placeholder="Choose section" searchPlaceholder="Search sections…" />
              <ComboboxField label="Daily Periods" value={sectionTemplate} onChange={setSectionTemplate} options={options} placeholder="Choose Daily Periods" searchPlaceholder="Search Daily Periods…" />
            </div>
            <Button disabled={!sectionId || !sectionTemplate} loading={apply.isPending} loadingText="Saving…" onClick={() => apply.mutate({ bellScheduleId: sectionTemplate, scope: 'SECTION', sectionOfferingIds: [sectionId] })}>
              Save For This Section
            </Button>
          </div>
        </details>
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── the tab

export function PeriodsTab({ plan, canEdit }: { plan: TimetablePlanDTO; canEdit: boolean }) {
  const bells = useBellSchedules(plan.planId);
  const assignments = useBellAssignments(plan.planId);
  const [chosen, setChosen] = useState('');
  const schedules = bells.data ?? [];
  const current = schedules.find((s) => s.bellScheduleId === chosen) ?? schedules.find((s) => s.isDefault) ?? schedules[0];

  return (
    <div className="space-y-4">
      <TabIntro title="Daily Periods" need="required">
        {PERIODS_INTRO}
      </TabIntro>
      {bells.isLoading && <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading Daily Periods" />}
      {bells.isError && <ErrorState error={bells.error} onRetry={() => void bells.refetch()} />}
      {bells.data && schedules.length === 0 && (
        <EmptyState title="No Daily Periods yet" description="Make them in School Week: choose the times, then press Create Daily Periods." action={<Button asChild><a href="/timetable/setup?tab=week">Go To School Week</a></Button>} />
      )}
      {current && (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <div className="min-w-56">
              <HelpHeading title="Which Daily Periods" className="mb-1 text-sm font-semibold" help={TIPS.dailyPeriods} />
              <Combobox aria-label="Which Daily Periods" value={current.bellScheduleId} onChange={setChosen} options={schedules.map((s) => ({ value: s.bellScheduleId, label: s.name, hint: s.isDefault ? 'School default' : BELL_KIND_LABELS[s.kind] }))} searchPlaceholder="Search Daily Periods…" />
            </div>
          </div>
          <ScheduleEditor key={current.bellScheduleId} schedule={current} plan={plan} canEdit={canEdit} onDeleted={() => setChosen('')} />
        </>
      )}
      {schedules.length > 0 && assignments.data && <WhoUsesWhich plan={plan} schedules={schedules} assignments={assignments.data} canEdit={canEdit} />}
      {assignments.isError && <Alert tone="danger">{messageFor(assignments.error)}</Alert>}
    </div>
  );
}
