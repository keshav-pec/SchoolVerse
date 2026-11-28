import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { DailyScheduleDTO, EffectiveItemDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ComboboxField, TextareaField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { messageFor } from '@/lib/errors';
import { TT, useBellResolution } from '../api';
import { DAILY_TIPS } from '../help-copy';
import { newRequestId } from '../schedule/api';
import { ops } from './api';
import { ClashNote, clashOf, OneDayDialog, type ClashState, type DayLesson } from './change-dialog';
import { titleOf } from './effective-view';

export const lessonOf = (i: EffectiveItemDTO): DayLesson => ({ entryId: i.entryId, date: i.date, label: `${i.sections.map((s) => s.label).join(' + ') || i.groupName || ''} ${titleOf(i)}`.trim(), when: `${i.periodName}, ${i.start}–${i.end}`, sectionId: i.sections[0]?.sectionOfferingId, start: i.startMin, end: i.endMin });

/** Cancellations & Swaps: cancel a lesson, a class or the whole day, swap two periods of one section, or reach the rarer one-day changes. */
export function CancelTab({ planId, locationId, day, date }: { planId: string; locationId: string; day: DailyScheduleDTO | undefined; date: string }) {
  const qc = useQueryClient();
  const resolution = useBellResolution(planId);
  const live = useMemo(() => (day?.lessons ?? []).filter((l) => l.state !== 'CANCELLED').map(lessonOf), [day]);
  const [lessonId, setLessonId] = useState('');
  const [reason, setReason] = useState('');
  const [wholeReason, setWholeReason] = useState('');
  const [sections, setSections] = useState<string[]>([]);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [swapSection, setSwapSection] = useState('');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [clash, setClash] = useState<ClashState | null>(null);
  const [more, setMore] = useState<DayLesson | null>(null);
  const [moreId, setMoreId] = useState('');

  const refresh = () => qc.invalidateQueries({ queryKey: TT });
  const sectionLessons = live.filter((l) => l.sectionId === swapSection);
  const target = sections.length > 0 ? (day?.lessons ?? []).filter((l) => l.state !== 'CANCELLED' && l.sections.some((s) => sections.includes(s.sectionOfferingId))).length : live.length;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setClash(null);
    try {
      await fn();
      toast.success(ok);
      await refresh();
    } catch (err) {
      const c = clashOf(err);
      if (c) setClash(c);
      else toast.error(messageFor(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-[13px] text-muted">The weekly timetable is not changed. Cancelling a change puts the lesson back.</p>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4 sm:p-5" aria-label="Cancel a lesson">
          <h2 className="text-lg font-bold">Cancel A Lesson</h2>
          <ComboboxField label="Lesson" value={lessonId} onChange={setLessonId} options={live.map((l) => ({ value: l.entryId, label: l.label, hint: l.when }))} placeholder="Choose…" searchPlaceholder="Search lessons…" />
          <TextareaField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} rows={2} />
          <Button disabled={!lessonId || !reason.trim()} loading={busy} loadingText="Saving…" onClick={() => void run(() => ops.createOverride({ type: 'CLASS_CANCELLED', entryId: lessonId, date, reason: reason.trim() }).then(() => { setLessonId(''); setReason(''); }), 'Lesson cancelled.')}>
            Cancel Lesson
          </Button>
        </Card>

        <Card className="space-y-3 p-4 sm:p-5" aria-label="Cancel a class or the day">
          <h2 className="text-lg font-bold">Cancel A Class Or The Whole Day</h2>
          <fieldset className="space-y-1">
            <legend className="text-sm font-semibold">Which classes? (leave empty for the whole campus)</legend>
            <div className="flex max-h-32 flex-wrap gap-x-4 gap-y-1 overflow-y-auto">
              {(resolution.data?.rows ?? []).map((s) => (
                <label key={s.sectionOfferingId} className="flex items-center gap-1.5 text-sm">
                  <input type="checkbox" className="size-4 accent-brand" checked={sections.includes(s.sectionOfferingId)} onChange={(e) => setSections((c) => (e.target.checked ? [...c, s.sectionOfferingId] : c.filter((x) => x !== s.sectionOfferingId)))} />
                  {s.label}
                </label>
              ))}
            </div>
          </fieldset>
          <TextareaField label="Reason" required hint="Example: Heavy rain." value={wholeReason} onChange={(e) => setWholeReason(e.target.value)} rows={2} />
          <Button variant="outline" disabled={!wholeReason.trim() || target === 0} onClick={() => setConfirm(true)}>
            {sections.length > 0 ? 'Cancel These Classes' : 'Cancel The Whole Day'}
          </Button>
        </Card>
      </div>

      <Card className="space-y-3 p-4 sm:p-5" aria-label="Swap two periods">
        <h2 className="flex items-center gap-1.5 text-lg font-bold">
          Swap Two Periods <InfoTip label="About swapping">{DAILY_TIPS.swap}</InfoTip>
        </h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <ComboboxField label="Section" value={swapSection} onChange={(v) => { setSwapSection(v); setA(''); setB(''); }} options={(resolution.data?.rows ?? []).map((s) => ({ value: s.sectionOfferingId, label: s.label }))} placeholder="Choose…" searchPlaceholder="Search sections…" />
          <ComboboxField label="First period" value={a} onChange={setA} options={sectionLessons.filter((l) => l.entryId !== b).map((l) => ({ value: l.entryId, label: l.label, hint: l.when }))} placeholder="Choose…" searchPlaceholder="Search…" />
          <ComboboxField label="Second period" value={b} onChange={setB} options={sectionLessons.filter((l) => l.entryId !== a).map((l) => ({ value: l.entryId, label: l.label, hint: l.when }))} placeholder="Choose…" searchPlaceholder="Search…" />
        </div>
        {a && b && (
          <p className="text-sm" data-testid="swap-preview">
            {sectionLessons.find((l) => l.entryId === a)?.label} ({sectionLessons.find((l) => l.entryId === a)?.when}) ↔ {sectionLessons.find((l) => l.entryId === b)?.label} ({sectionLessons.find((l) => l.entryId === b)?.when})
          </p>
        )}
        {clash && <ClashNote clash={clash} />}
        <Button disabled={!a || !b} loading={busy} loadingText="Checking…" onClick={() => void run(() => ops.createOverride({ type: 'PERIOD_SWAP', entryId: a, otherEntryId: b, date }).then(() => { setA(''); setB(''); }), 'Periods swapped for this day.')}>
          Swap Periods
        </Button>
      </Card>

      <details className="rounded-card border border-line bg-white p-4 sm:p-5">
        <summary className="cursor-pointer text-base font-bold">More One-Day Changes</summary>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <ComboboxField label="Lesson" containerClassName="w-72" value={moreId} onChange={setMoreId} options={live.map((l) => ({ value: l.entryId, label: l.label, hint: l.when }))} placeholder="Choose…" searchPlaceholder="Search lessons…" hint="Special activity, another subject, or joining another lesson." />
          <Button variant="outline" disabled={!moreId} onClick={() => setMore(live.find((l) => l.entryId === moreId) ?? null)}>
            Choose A Change
          </Button>
        </div>
      </details>

      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={sections.length > 0 ? 'Cancel these classes for the day?' : 'Cancel the whole day?'}
        description={`${target} lessons will be cancelled on ${date}. The weekly timetable is not changed. Each one can be brought back.`}
        confirmLabel="Cancel Lessons"
        loadingLabel="Cancelling…"
        tone="danger"
        onConfirm={async () => {
          const res = await ops.cancelLessons({ planId, date, reason: wholeReason.trim(), ...(sections.length > 0 ? { sectionIds: sections } : {}), requestId: newRequestId() });
          toast.success(res.message);
          setWholeReason('');
          setSections([]);
          await refresh();
        }}
      />
      {more && <OneDayDialog planId={planId} locationId={locationId} lesson={more} dayLessons={live} initial="SPECIAL_ACTIVITY" open onClose={() => { setMore(null); setMoreId(''); }} />}
    </div>
  );
}
