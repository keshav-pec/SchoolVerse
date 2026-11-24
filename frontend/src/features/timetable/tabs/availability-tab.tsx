import { useEffect, useRef, useState } from 'react';
import { Copy, Users } from 'lucide-react';
import {
  AVAILABILITY_KIND_LABELS,
  WEEKDAY_LABELS,
  minutesToClock,
  type AvailabilityBulkResultDTO,
  type AvailabilityKind,
  type BellPeriodDTO,
  type FacultyAvailabilityDTO,
  type PlanTeacherDTO,
  type TimetablePlanDTO,
  type Weekday,
  type WorkloadRulesDTO,
  type WorkloadValuesDTO,
} from '@shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ComboboxField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { useAvailability, useBellSchedules, usePlanTeachers, useTimetableMutation, useWorkload } from '../api';
import { AVAILABILITY_INTRO, TIPS } from '../help-copy';

interface Cell {
  weekday: Weekday;
  startMin: number;
  endMin: number;
  kind: AvailabilityKind;
}

/** Click order: available → not available → prefers → prefers not → available again. */
const NEXT: Record<string, AvailabilityKind | null> = { '': 'UNAVAILABLE', UNAVAILABLE: 'PREFERRED', PREFERRED: 'NOT_PREFERRED', NOT_PREFERRED: null };
const TONE: Record<string, string> = {
  '': 'bg-white text-muted hover:bg-brand-soft/50',
  UNAVAILABLE: 'bg-danger-soft text-danger border-danger/40',
  PREFERRED: 'bg-success-soft text-success border-success/40',
  NOT_PREFERRED: 'bg-warning-soft text-warning border-warning/40',
};
const LABEL: Record<string, string> = { '': 'Available', ...AVAILABILITY_KIND_LABELS };

const overlaps = (r: Cell, p: Pick<BellPeriodDTO, 'startMin' | 'endMin'>) => r.endMin > p.startMin && r.startMin < p.endMin;

/** Sets one period of one day to a kind, keeping the parts of a longer row that lie outside it. */
export function setCell(rows: Cell[], weekday: Weekday, period: Pick<BellPeriodDTO, 'startMin' | 'endMin'>, kind: AvailabilityKind | null): Cell[] {
  const out: Cell[] = [];
  for (const r of rows) {
    if (r.weekday !== weekday || !overlaps(r, period)) {
      out.push(r);
      continue;
    }
    if (r.startMin < period.startMin) out.push({ ...r, endMin: period.startMin });
    if (r.endMin > period.endMin) out.push({ ...r, startMin: period.endMin });
  }
  if (kind) out.push({ weekday, startMin: period.startMin, endMin: period.endMin, kind });
  return out;
}

type Status = 'idle' | 'saving' | 'saved' | 'error';
const StatusText = ({ status, error }: { status: Status; error?: string }) => (
  <span className="text-sm font-semibold" role="status" aria-live="polite">
    {status === 'saving' && <span className="text-muted">Saving…</span>}
    {status === 'saved' && <span className="text-success">Saved</span>}
    {status === 'error' && <span className="text-danger">{error ?? 'Could not save.'}</span>}
  </span>
);

// ───────────────────────────────────────────────────────────── the weekly grid

function Grid({ plan, teacher, periods, initial, canEdit, onStatus }: { plan: TimetablePlanDTO; teacher: PlanTeacherDTO; periods: BellPeriodDTO[]; initial: FacultyAvailabilityDTO; canEdit: boolean; onStatus: (s: Status, e?: string) => void }) {
  const [rows, setRows] = useState<Cell[]>(() => initial.rows.map((r) => ({ weekday: r.weekday, startMin: r.startMin, endMin: r.endMin, kind: r.kind })));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef(false);
  // A copy from another teacher changes the rows behind our back; take them in unless a click of ours is still waiting to be saved.
  useEffect(() => {
    if (!pending.current) setRows(initial.rows.map((r) => ({ weekday: r.weekday, startMin: r.startMin, endMin: r.endMin, kind: r.kind })));
  }, [initial]);
  const save = useTimetableMutation((next: Cell[]) => api.put<FacultyAvailabilityDTO>(`/faculty-availability/${teacher.employeeId}`, { planId: plan.planId, rows: next.map((r) => ({ weekday: r.weekday, start: minutesToClock(r.startMin), end: minutesToClock(r.endMin), kind: r.kind })) }), { quiet: true });
  const latest = useRef(rows);
  latest.current = rows;
  // Leaving the grid (another teacher, another tab) must not lose a click that is still waiting for its save.
  useEffect(
    () => () => {
      if (timer.current && pending.current) {
        clearTimeout(timer.current);
        save.mutate(latest.current);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const click = (weekday: Weekday, p: BellPeriodDTO) => {
    const current = rows.find((r) => r.weekday === weekday && overlaps(r, p))?.kind ?? '';
    const next = setCell(rows, weekday, p, NEXT[current] ?? null);
    setRows(next);
    pending.current = true;
    onStatus('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      save.mutate(next, {
        onSuccess: () => {
          pending.current = false;
          onStatus('saved');
        },
        onError: (e) => {
          pending.current = false;
          onStatus('error', messageFor(e));
        },
      });
    }, 350);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[32rem] border-separate border-spacing-1 text-sm">
        <caption className="sr-only">Availability of {teacher.fullName}. Click a box to change it.</caption>
        <thead>
          <tr>
            <th scope="col" className="p-1 text-left text-[13px] text-muted">Period</th>
            {plan.operatingDays.map((d) => (
              <th key={d} scope="col" className="p-1 text-center text-[13px] font-semibold">{WEEKDAY_LABELS[d].slice(0, 3)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {periods.map((p) => (
            <tr key={p.periodId}>
              <th scope="row" className="p-1 text-left font-semibold whitespace-nowrap">
                {p.periodName}
                <span className="block text-[12px] font-normal text-muted">{p.start}–{p.end}</span>
              </th>
              {plan.operatingDays.map((d) => {
                const kind = rows.find((r) => r.weekday === d && overlaps(r, p))?.kind ?? '';
                return (
                  <td key={d} className="p-0">
                    <button
                      type="button"
                      disabled={!canEdit}
                      onClick={() => click(d, p)}
                      aria-label={`${WEEKDAY_LABELS[d]} ${p.periodName}: ${LABEL[kind]}`}
                      className={cn('h-11 w-full min-w-14 rounded-lg border border-line text-[12px] font-semibold transition-colors focus-visible:ring-4 focus-visible:ring-brand/25 focus-visible:outline-none disabled:cursor-default', TONE[kind])}
                    >
                      {kind ? LABEL[kind] : ''}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── copy

function CopyModal({ plan, teacher, teachers, mode, onClose }: { plan: TimetablePlanDTO; teacher: PlanTeacherDTO; teachers: PlanTeacherDTO[]; mode: 'to-more' | 'from-other'; onClose: () => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const others = teachers.filter((t) => t.employeeId !== teacher.employeeId);
  const copy = useTimetableMutation(
    () => api.post<AvailabilityBulkResultDTO>('/faculty-availability/copy', mode === 'to-more' ? { planId: plan.planId, fromEmployeeId: teacher.employeeId, toEmployeeIds: picked } : { planId: plan.planId, fromEmployeeId: from, toEmployeeIds: [teacher.employeeId] }),
    { success: (r) => `Copied to ${r.teachers} ${r.teachers === 1 ? 'teacher' : 'teachers'}.` },
  );
  const ready = mode === 'to-more' ? picked.length > 0 : !!from;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={mode === 'to-more' ? 'Apply To More Teachers' : 'Copy From Teacher'}
      description={mode === 'to-more' ? `Give the teachers you pick the same times as ${teacher.fullName}. Their own times are replaced.` : `${teacher.fullName}’s times are replaced by the other teacher’s.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ready} loading={copy.isPending} loadingText="Copying…" onClick={async () => void (await copy.mutateAsync(undefined).then(onClose, () => undefined))}>
            {mode === 'to-more' ? 'Apply To Teachers' : 'Copy Times'}
          </Button>
        </>
      }
    >
      {mode === 'from-other' ? (
        <ComboboxField label="Copy from" value={from} onChange={setFrom} options={others.map((t) => ({ value: t.employeeId, label: t.fullName, hint: t.employeeCode }))} placeholder="Choose teacher" searchPlaceholder="Search teachers…" />
      ) : (
        <div className="space-y-2">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setPicked(others.map((t) => t.employeeId))}>
              Select All
            </Button>
            <Button variant="outline" size="sm" onClick={() => setPicked([])}>
              Clear
            </Button>
          </div>
          <ul className="grid gap-1 sm:grid-cols-2">
            {others.map((t) => (
              <li key={t.employeeId}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4 accent-brand" checked={picked.includes(t.employeeId)} onChange={(e) => setPicked(e.target.checked ? [...picked, t.employeeId] : picked.filter((x) => x !== t.employeeId))} />
                  {t.fullName}
                </label>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── workload

const FIELDS: { key: keyof WorkloadValuesDTO; label: string; teacherOnly?: boolean }[] = [
  { key: 'maxPerDay', label: 'Most periods in a day' },
  { key: 'maxConsecutive', label: 'Most periods in a row' },
  { key: 'maxPerWeek', label: 'Most periods in a week' },
  { key: 'preferredFreePerDay', label: 'Free periods wanted each day', teacherOnly: true },
];

function LimitInput({ label, value, placeholder, canEdit, onSave }: { label: string; value: number | null; placeholder: string; canEdit: boolean; onSave: (value: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value));
  useEffect(() => setText(value === null ? '' : String(value)), [value]);
  return (
    <label className="space-y-1 text-sm font-semibold">
      <span>{label}</span>
      <Input
        type="number"
        min={0}
        max={80}
        value={text}
        disabled={!canEdit}
        placeholder={placeholder}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const next = text.trim() === '' ? null : Number(text);
          if (next !== value && (next === null || Number.isInteger(next))) onSave(next);
        }}
      />
    </label>
  );
}

function Workload({ plan, teacher, rules, canEdit, onStatus }: { plan: TimetablePlanDTO; teacher: PlanTeacherDTO; rules: WorkloadRulesDTO; canEdit: boolean; onStatus: (s: Status, e?: string) => void }) {
  const mine = rules.teachers.find((t) => t.employeeId === teacher.employeeId);
  const save = useTimetableMutation((body: Record<string, unknown>) => api.put<WorkloadRulesDTO>('/faculty-workload-rules', { planId: plan.planId, ...body }), { quiet: true });
  const run = (body: Record<string, unknown>) => {
    onStatus('saving');
    save.mutate(body, { onSuccess: () => onStatus('saved'), onError: (e) => onStatus('error', messageFor(e)) });
  };
  const hint = (key: keyof WorkloadValuesDTO) => {
    const d = rules.planDefault[key];
    return d === null || d === undefined ? 'Using school default' : `Using school default (${d})`;
  };
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <HelpHeading title="Workload limits" help={TIPS.weeklyLimits} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {FIELDS.map((f) => (
          <LimitInput key={f.key} label={f.label} value={mine?.own[f.key] ?? null} placeholder={f.teacherOnly ? 'No wish' : hint(f.key)} canEdit={canEdit} onSave={(v) => run({ employeeId: teacher.employeeId, [f.key]: v })} />
        ))}
      </div>
      {canEdit && (
        <details className="rounded-xl border border-line p-3">
          <summary className="cursor-pointer text-sm font-semibold">School default limits</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {FIELDS.filter((f) => !f.teacherOnly).map((f) => (
              <LimitInput key={f.key} label={f.label} value={rules.planDefault[f.key as 'maxPerDay']} placeholder="No limit" canEdit onSave={(v) => run({ employeeId: null, [f.key]: v })} />
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── the tab

export function AvailabilityTab({ plan, canEdit }: { plan: TimetablePlanDTO; canEdit: boolean }) {
  const teachers = usePlanTeachers(plan.planId);
  const bells = useBellSchedules(plan.planId);
  const workload = useWorkload(plan.planId);
  const [chosen, setChosen] = useState('');
  const [status, setStatus] = useState<{ s: Status; e?: string }>({ s: 'idle' });
  const [copy, setCopy] = useState<'to-more' | 'from-other' | null>(null);
  const list = teachers.data ?? [];
  const teacher = list.find((t) => t.employeeId === chosen) ?? list[0];
  const availability = useAvailability(plan.planId, teacher?.employeeId);
  const main = (bells.data ?? []).find((b) => b.isDefault) ?? bells.data?.[0];
  const periods = (main?.periods ?? []).filter((p) => p.schedulable);

  return (
    <div className="space-y-4">
      <TabIntro title="Teacher Availability" need="optional">
        {AVAILABILITY_INTRO}
      </TabIntro>
      {teachers.isLoading && <Skeleton className="h-32 rounded-card" role="status" aria-label="Loading teachers" />}
      {teachers.isError && <ErrorState error={teachers.error} onRetry={() => void teachers.refetch()} />}
      {teachers.data && list.length === 0 && <EmptyState title="No teachers at this campus yet" description="Add teachers and give them this campus in People. Then come back here." action={<Button asChild variant="outline"><a href="/people">Go To People</a></Button>} />}
      {teacher && (
        <>
          <Card className="space-y-4 p-4 sm:p-5">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <ComboboxField label="Teacher" value={teacher.employeeId} onChange={(v) => { setChosen(v); setStatus({ s: 'idle' }); }} options={list.map((t) => ({ value: t.employeeId, label: t.fullName, hint: t.hasAvailabilityRows ? 'Has times set' : t.employeeCode }))} searchPlaceholder="Search teachers…" containerClassName="min-w-60" />
              <div className="flex flex-wrap items-center gap-2">
                <StatusText status={status.s} error={status.e} />
                {canEdit && (
                  <>
                    <Button variant="outline" size="sm" onClick={() => setCopy('to-more')} disabled={list.length < 2}>
                      <Users /> Apply To More Teachers
                    </Button>
                    <Button variant="outline" size="sm" onClick={() => setCopy('from-other')} disabled={list.length < 2}>
                      <Copy /> Copy From Teacher
                    </Button>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-semibold">Click a box to change it:</span>
              {(['', 'UNAVAILABLE', 'PREFERRED', 'NOT_PREFERRED'] as const).map((k) => (
                <Badge key={k || 'ok'} tone={k === 'UNAVAILABLE' ? 'danger' : k === 'PREFERRED' ? 'success' : k === 'NOT_PREFERRED' ? 'warning' : 'neutral'}>
                  {LABEL[k]}
                </Badge>
              ))}
              <InfoTip label="About these choices">{TIPS.notPreferred}</InfoTip>
            </div>
            {periods.length === 0 && !bells.isLoading && <EmptyState title="Set up Daily Periods first" description="The grid shows the periods of the school day, so it needs Daily Periods." action={<Button asChild variant="outline"><a href="/timetable/setup?tab=week">Go To School Week</a></Button>} />}
            {availability.isLoading && <Skeleton className="h-48" role="status" aria-label="Loading availability" />}
            {availability.isError && <ErrorState error={availability.error} onRetry={() => void availability.refetch()} />}
            {availability.data && periods.length > 0 && <Grid key={teacher.employeeId} plan={plan} teacher={teacher} periods={periods} initial={availability.data} canEdit={canEdit} onStatus={(s, e) => setStatus({ s, e })} />}
          </Card>
          {workload.data && <Workload key={teacher.employeeId} plan={plan} teacher={teacher} rules={workload.data} canEdit={canEdit} onStatus={(s, e) => setStatus({ s, e })} />}
          {copy && (
            <CopyModal
              plan={plan}
              teacher={teacher}
              teachers={list}
              mode={copy}
              onClose={() => setCopy(null)}
            />
          )}
        </>
      )}
    </div>
  );
}
