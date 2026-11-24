import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Repeat } from 'lucide-react';
import { WEEKDAY_LABELS, type CheckResultDTO, type GridCellDTO, type GridDTO, type RuleCode, type Weekday } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Modal } from '@/components/sv/modal';
import { ErrorState } from '@/components/sv/error-state';
import { TT } from '../api';
import { TIPS } from '../help-copy';
import { useLessonActions } from './actions';
import { calls } from './api';
import { useEditor } from './editor';

/** Rules that "Fix This For Me" can fix, so the button only shows where it can help. */
export const FIXABLE_RULES: readonly RuleCode[] = ['TEACHER_UNAVAILABLE', 'TEACHER_NOT_PREFERRED', 'MAX_PER_DAY', 'TEACHER_LOAD', 'ROOM_UNAVAILABLE', 'ROOM_TOO_SMALL', 'ROOM_NOT_SUITABLE', 'NOT_HOME_ROOM'];

/** Shows the concrete change and says it is already checked, before anything is applied. */
export function FixThisForMe({ entryId, rule, open, onClose }: { entryId: string; rule: RuleCode; open: boolean; onClose: () => void }) {
  const { versionId, exec } = useEditor();
  const fixes = useQuery({ queryKey: [...TT, 'fixes', versionId, entryId, rule], queryFn: () => calls.fixes(versionId, entryId, rule), enabled: open });
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Fix This For Me" description="Each fix below has already been checked, so applying it will not make a clash.">
      {fixes.isLoading && <Skeleton className="h-24 rounded-xl" role="status" aria-label="Looking for fixes" />}
      {fixes.isError && <ErrorState error={fixes.error} onRetry={() => void fixes.refetch()} />}
      {fixes.data && fixes.data.suggestions.length === 0 && <Alert tone="info">{fixes.data.message ?? 'There is no automatic fix for this.'}</Alert>}
      <ul className="space-y-2" aria-label="Fixes">
        {fixes.data?.suggestions.map((s) => (
          <li key={s.suggestionToken} className="flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 text-sm">
              <p className="font-semibold">{s.label}</p>
              <p className="text-[13px] text-muted">{s.why}</p>
            </div>
            <Button
              size="sm"
              onClick={() => {
                onClose();
                void exec(s.label, (o) => calls.applyFix(versionId, s.suggestionToken, o.requestId));
              }}
            >
              Apply This Fix
            </Button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

/** Where to move a lesson, for touch and keyboard (and anyone who prefers not to drag). */
export function MoveTo({ cell, grid, open, onClose }: { cell: GridCellDTO; grid: GridDTO; open: boolean; onClose: () => void }) {
  const actions = useLessonActions();
  const [day, setDay] = useState<Weekday>(cell.weekday);
  const [periodId, setPeriodId] = useState(cell.periodId);
  useEffect(() => {
    if (open) {
      setDay(cell.weekday);
      setPeriodId(cell.periodId);
    }
  }, [open, cell.weekday, cell.periodId]);
  const periods = (grid.days.find((d) => d.weekday === day)?.periods ?? []).filter((p) => p.schedulable);
  const same = day === cell.weekday && periodId === cell.periodId;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Move To…"
      description="Choose the day and period. It is checked before it is saved."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={same || !periodId}
            onClick={() => {
              onClose();
              void actions.move(cell, day, periodId);
            }}
          >
            Move Lesson
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <ComboboxField
          label="Day"
          value={day}
          onChange={(v) => {
            setDay(v as Weekday);
            const first = grid.days.find((d) => d.weekday === v)?.periods.find((p) => p.schedulable);
            if (first && !grid.days.find((d) => d.weekday === v)?.periods.some((p) => p.periodId === periodId)) setPeriodId(first.periodId);
          }}
          options={grid.days.map((d) => ({ value: d.weekday, label: d.label }))}
          searchPlaceholder="Search days…"
        />
        <ComboboxField label="Period" value={periodId} onChange={setPeriodId} options={periods.map((p) => ({ value: p.periodId, label: p.periodName, hint: `${p.start}–${p.end}` }))} searchPlaceholder="Search periods…" />
      </div>
    </Modal>
  );
}

/** Dropping a lesson on another lesson. Both sides were checked together before this opens. */
export function SwapConfirm({ a, b, check, open, onClose }: { a: GridCellDTO; b: GridCellDTO; check: CheckResultDTO | null; open: boolean; onClose: () => void }) {
  const actions = useLessonActions();
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Swap These Two"
      description={
        <span className="flex items-center gap-1.5">
          Both lessons trade places.
          <InfoTip label="About swapping">{TIPS.swap}</InfoTip>
        </span>
      }
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              onClose();
              void actions.swap(a, b);
            }}
          >
            <Repeat /> Swap These Two
          </Button>
        </>
      }
    >
      <ul className="space-y-2 text-sm">
        {[a, b].map((c, i) => (
          <li key={c.entryId} className="rounded-xl border border-line p-3">
            <p className="font-semibold">{c.groupName ?? c.subjectName ?? c.activityName}</p>
            <p className="text-[13px] text-muted">
              {WEEKDAY_LABELS[c.weekday]}, {c.periodName} → {WEEKDAY_LABELS[[b, a][i]!.weekday]}, {[b, a][i]!.periodName}
            </p>
          </li>
        ))}
      </ul>
      {check && check.warnings.length > 0 && (
        <Alert tone="warning" className="mt-3" title="It works, with a warning">
          {check.warnings.map((w) => w.message).join(' ')}
        </Alert>
      )}
    </Modal>
  );
}

