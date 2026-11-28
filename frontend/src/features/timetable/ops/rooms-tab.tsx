import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { OverrideBulkResultDTO, RoomImpactItemDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { useCampusRooms } from '../../spaces/api';
import { TT } from '../api';
import { newRequestId } from '../schedule/api';
import { ops, useRoomImpact, useRoomRecommendations } from './api';
import { OneDayDialog, type DayLesson } from './change-dialog';

const keyOf = (i: { entryId: string; date: string }) => `${i.entryId}|${i.date}`;

/** Room Changes: pick the room that cannot be used, see the lessons in it, and move them to rooms that are free and suitable. */
export function RoomsTab({ planId, locationId, date }: { planId: string; locationId: string; date: string }) {
  const qc = useQueryClient();
  const rooms = useCampusRooms(locationId);
  const [roomId, setRoomId] = useState('');
  const [from, setFrom] = useState(date);
  const [to, setTo] = useState('');
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [chosen, setChosen] = useState<Record<string, string>>({});
  const [result, setResult] = useState<OverrideBulkResultDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [single, setSingle] = useState<DayLesson | null>(null);
  useEffect(() => setFrom(date), [date]);

  const impact = useRoomImpact(roomId ? { planId, physicalSpaceId: roomId, dateFrom: from, ...(to ? { dateTo: to } : {}) } : null);
  const items = useMemo(() => impact.data?.items ?? [], [impact.data]);
  const keys = useMemo(() => items.map(keyOf).join(','), [items]);
  const recs = useRoomRecommendations(planId, useMemo(() => items.map((i) => ({ entryId: i.entryId, date: i.date })), [items]), roomId || undefined);
  const recOf = (i: RoomImpactItemDTO) => recs.data?.find((r) => r.entryId === i.entryId && r.date === i.date);
  useEffect(() => setTicked(new Set(keys ? keys.split(',') : [])), [keys]);
  const pickedFor = (i: RoomImpactItemDTO) => chosen[keyOf(i)] ?? recOf(i)?.recommended?.physicalSpaceId ?? null;
  const toApply = items.filter((i) => ticked.has(keyOf(i)) && pickedFor(i));

  const apply = async () => {
    setBusy(true);
    try {
      const res = await ops.applyRoomChanges({ planId, items: toApply.map((i) => ({ entryId: i.entryId, date: i.date, physicalSpaceId: pickedFor(i)! })), requestId: newRequestId() });
      setResult(res);
      if (res.done > 0) toast.success(res.message);
      await qc.invalidateQueries({ queryKey: TT });
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card className="space-y-3 p-4 sm:p-5">
        <h2 className="text-lg font-bold">Room Cannot Be Used</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <ComboboxField label="Room" value={roomId} onChange={setRoomId} options={(rooms.data?.items ?? []).map((r) => ({ value: r.spaceId, label: r.spaceName }))} placeholder="Choose…" searchPlaceholder="Search rooms…" />
          <TextField label="From" type="date" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
          <TextField label="To (optional)" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
        <p className="text-[13px] text-muted">The weekly timetable is not changed. Mark the room closed in Space Setup if it is closed for the whole day.</p>
      </Card>
      {result && (
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
        </Alert>
      )}
      {roomId && impact.isLoading && <Skeleton className="h-32 rounded-card" role="status" aria-label="Finding the lessons" />}
      {impact.isError && <ErrorState error={impact.error} onRetry={() => void impact.refetch()} />}
      {impact.data && (
        <Card className="space-y-3 p-4 sm:p-5" aria-label="Affected lessons">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold" data-testid="room-impact-summary">
              {impact.data.summary}
            </p>
            {items.length > 0 && (
              <Button size="sm" disabled={toApply.length === 0} loading={busy} loadingText="Saving…" onClick={() => void apply()}>
                Apply Suggestions{toApply.length > 0 ? ` (${toApply.length})` : ''}
              </Button>
            )}
          </div>
          <ul className="space-y-2">
            {items.map((i) => {
              const k = keyOf(i);
              const r = recOf(i);
              const options = [r?.recommended, ...(r?.alternatives ?? [])].filter((o) => !!o);
              const picked = options.find((o) => o!.physicalSpaceId === pickedFor(i));
              return (
                <li key={k} className="flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="flex min-w-0 gap-3">
                    <input type="checkbox" className="mt-1 size-4 accent-brand" aria-label={`Tick ${i.label}, ${i.periodName}, ${i.date}`} checked={ticked.has(k)} onChange={(e) => setTicked((s) => { const n = new Set(s); if (e.target.checked) n.add(k); else n.delete(k); return n; })} />
                    <div className="min-w-0 text-sm">
                      <p className="font-semibold">
                        {i.label} <span className="font-normal text-muted">· {formatDateOnly(i.date)} · {i.periodName}, {i.start}–{i.end}</span>
                      </p>
                      {recs.isLoading ? (
                        <p className="text-[13px] text-muted">Looking for a room…</p>
                      ) : picked ? (
                        <p className="text-[13px]" data-testid="room-suggestion">
                          <Badge tone="brand">Suggested</Badge> <b>{picked.name}</b> <span className="text-muted">· {picked.why}</span>
                        </p>
                      ) : (
                        <p className="text-[13px] text-warning">{r?.message ?? 'No other room is free.'}</p>
                      )}
                    </div>
                  </div>
                  <span className="flex shrink-0 flex-wrap gap-2">
                    {options.length > 1 && <Combobox aria-label={`Room for ${i.label}`} className="h-9 w-44" value={pickedFor(i) ?? ''} onChange={(v) => setChosen((c) => ({ ...c, [k]: v }))} options={options.map((o) => ({ value: o!.physicalSpaceId, label: o!.name }))} searchPlaceholder="Search…" />}
                    <Button variant="outline" size="sm" onClick={() => setSingle({ entryId: i.entryId, date: i.date, label: i.label, when: `${i.periodName}, ${i.start}–${i.end}` })}>
                      Pick A Room
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {single && <OneDayDialog planId={planId} locationId={locationId} lesson={single} dayLessons={[]} initial="ROOM_CHANGE" onlyType open onClose={() => setSingle(null)} />}
    </div>
  );
}
