import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { AffectedLessonDTO, OverrideBulkResultDTO, SubstituteChoiceDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { TT, usePlanTeachers } from '../api';
import { newRequestId } from '../schedule/api';
import { DAILY_TIPS } from '../help-copy';
import { ops, useImpact, useSubstituteRecommendations, type AbsenceInput } from './api';
import { OneDayDialog, type DayLesson } from './change-dialog';

const keyOf = (i: { entryId: string; date: string }) => `${i.entryId}|${i.date}`;

function Result({ result, onClose }: { result: OverrideBulkResultDTO; onClose: () => void }) {
  return (
    <Alert tone={result.failed.length === 0 ? 'success' : 'warning'} title={result.message}>
      {result.failed.length > 0 && (
        <ul className="mt-1 list-disc space-y-0.5 pl-4" aria-label="Not saved">
          {result.failed.map((f) => (
            <li key={`${f.entryId}-${f.date}`}>
              <b>{f.label}</b> ({formatDateOnly(f.date)}): {f.message}
            </li>
          ))}
        </ul>
      )}
      <Button variant="ghost" size="sm" className="mt-1" onClick={onClose}>
        Dismiss
      </Button>
    </Alert>
  );
}

/** Substitutions: a teacher is away, so list their periods, suggest someone for each, and apply the ticked ones in one go. */
export function SubstitutionsTab({ planId, locationId, date }: { planId: string; locationId: string; date: string }) {
  const qc = useQueryClient();
  const teachers = usePlanTeachers(planId);
  const [employeeId, setEmployeeId] = useState('');
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState('');
  const [range, setRange] = useState(false);
  const [partial, setPartial] = useState(false);
  const [start, setStart] = useState('08:00');
  const [end, setEnd] = useState('10:00');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [result, setResult] = useState<OverrideBulkResultDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [single, setSingle] = useState<DayLesson | null>(null);

  useEffect(() => setFrom(date), [date]);

  const input: AbsenceInput | null = employeeId ? { planId, employeeId, dateFrom: from, ...(range && to ? { dateTo: to } : {}), ...(partial ? { start, end } : {}) } : null;
  const impact = useImpact(input);
  const open = useMemo(() => (impact.data?.items ?? []).filter((i) => !i.covered), [impact.data]);
  const openKeys = useMemo(() => open.map(keyOf).join(','), [open]);
  const recs = useSubstituteRecommendations(planId, useMemo(() => open.map((i) => ({ entryId: i.entryId, date: i.date })), [open]));
  const recOf = (i: AffectedLessonDTO) => recs.data?.find((r) => r.entryId === i.entryId && r.date === i.date);

  // Tick every period that still needs someone, whenever the list changes.
  useEffect(() => {
    setTicked(new Set(openKeys ? openKeys.split(',') : []));
  }, [openKeys]);

  const pickedFor = (i: AffectedLessonDTO): string | null => chosen[keyOf(i)] ?? recOf(i)?.recommended?.employeeId ?? null;
  const toApply = open.filter((i) => ticked.has(keyOf(i)) && pickedFor(i));

  const apply = async () => {
    if (!input) return;
    setBusy(true);
    try {
      await ops.recordAbsence(input);
      const res = await ops.bulkSubstitutions({ planId, items: toApply.map((i) => ({ entryId: i.entryId, date: i.date, substituteEmployeeId: pickedFor(i)! })), requestId: newRequestId() });
      setResult(res);
      if (res.done > 0) toast.success(res.message);
      await qc.invalidateQueries({ queryKey: TT });
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  };
  const recordOnly = async () => {
    if (!input) return;
    setBusy(true);
    try {
      await ops.recordAbsence(input);
      toast.success('Absence written down. Teachers who are away are not suggested for those hours.');
      await qc.invalidateQueries({ queryKey: TT });
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  const choices = (i: AffectedLessonDTO): SubstituteChoiceDTO[] => {
    const r = recOf(i);
    return [r?.recommended, ...(r?.alternatives ?? [])].filter((c): c is SubstituteChoiceDTO => !!c);
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4 sm:p-5">
        <h2 className="flex items-center gap-1.5 text-lg font-bold">
          Teacher Absent <InfoTip label="About substitutes">{DAILY_TIPS.substitute}</InfoTip>
        </h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <ComboboxField label="Teacher" value={employeeId} onChange={setEmployeeId} options={(teachers.data ?? []).map((t) => ({ value: t.employeeId, label: t.fullName, hint: t.employeeCode }))} placeholder="Choose…" searchPlaceholder="Search teachers…" />
          <TextField label={range ? 'From' : 'Date'} type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          {range && <TextField label="To" type="date" value={to || from} min={from} onChange={(e) => setTo(e.target.value)} />}
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4 accent-brand" checked={range} onChange={(e) => setRange(e.target.checked)} /> Away for several days? (optional)
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="size-4 accent-brand" checked={partial} onChange={(e) => setPartial(e.target.checked)} /> Only some periods? (optional)
          </label>
        </div>
        {partial && (
          <div className="grid max-w-md grid-cols-2 gap-3">
            <TextField label="From time" type="time" value={start} onChange={(e) => setStart(e.target.value)} />
            <TextField label="To time" type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        )}
        <p className="text-[13px] text-muted">The weekly timetable is not changed.</p>
      </Card>

      {result && <Result result={result} onClose={() => setResult(null)} />}
      {input && impact.isLoading && <Skeleton className="h-32 rounded-card" role="status" aria-label="Finding the periods" />}
      {impact.isError && <ErrorState error={impact.error} onRetry={() => void impact.refetch()} />}
      {impact.data && (
        <Card className="space-y-3 p-4 sm:p-5" aria-label="Affected periods">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h3 className="text-base font-bold">{impact.data.employeeName}</h3>
              <p className="text-sm text-muted" data-testid="impact-summary">
                {impact.data.summary}
              </p>
            </div>
            {open.length > 0 && (
              <span className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" disabled={busy} onClick={() => void recordOnly()}>
                  Record Absence Only
                </Button>
                <Button size="sm" disabled={toApply.length === 0} loading={busy} loadingText="Saving…" onClick={() => void apply()}>
                  Apply Suggestions{toApply.length > 0 ? ` (${toApply.length})` : ''}
                </Button>
              </span>
            )}
          </div>
          <ul className="space-y-2">
            {impact.data.items.map((i) => {
              const k = keyOf(i);
              const options = choices(i);
              const picked = options.find((o) => o.employeeId === pickedFor(i));
              return (
                <li key={k} className="flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <input type="checkbox" className="mt-1 size-4 accent-brand" aria-label={`Tick ${i.label}, ${i.periodName}, ${i.date}`} disabled={i.covered} checked={ticked.has(k)} onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
                    <div className="min-w-0 text-sm">
                      <p className="font-semibold">
                        {i.label} <span className="font-normal text-muted">· {formatDateOnly(i.date)} · {i.periodName}, {i.start}–{i.end}</span>
                      </p>
                      {i.covered ? (
                        <p className="text-[13px] text-success">{i.state === 'CANCELLED' ? 'Cancelled' : `Covered by ${i.coveredBy ?? 'someone'}`}</p>
                      ) : recs.isLoading ? (
                        <p className="text-[13px] text-muted">Looking for a teacher…</p>
                      ) : picked ? (
                        <p className="text-[13px]" data-testid="suggestion">
                          <Badge tone="brand">Suggested</Badge> <b>{picked.fullName}</b> <span className="text-muted">· {picked.why}</span>
                        </p>
                      ) : (
                        <p className="text-[13px] text-warning">{recOf(i)?.message ?? 'No teacher is free for this period.'}</p>
                      )}
                    </div>
                  </div>
                  {!i.covered && (
                    <span className="flex shrink-0 flex-wrap gap-2">
                      {options.length > 1 && (
                        <Combobox aria-label={`Teacher for ${i.label}`} className="h-9 w-44" value={pickedFor(i) ?? ''} onChange={(v) => setChosen((c) => ({ ...c, [k]: v }))} options={options.map((o) => ({ value: o.employeeId, label: o.fullName, hint: o.match === 'SUBJECT' ? 'teaches it' : undefined }))} searchPlaceholder="Search…" />
                      )}
                      <Button variant="outline" size="sm" onClick={() => setSingle({ entryId: i.entryId, date: i.date, label: i.label, when: `${i.periodName}, ${i.start}–${i.end}` })}>
                        Choose Someone Else
                      </Button>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {single && <OneDayDialog planId={planId} locationId={locationId} lesson={single} dayLessons={[]} initial="SUBSTITUTE_FACULTY" onlyType open onClose={() => setSingle(null)} />}
    </div>
  );
}
