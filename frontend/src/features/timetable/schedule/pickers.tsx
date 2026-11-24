import { Check, DoorClosed, UserRound } from 'lucide-react';
import type { ChoiceDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Modal } from '@/components/sv/modal';
import { ErrorState } from '@/components/sv/error-state';
import { cn } from '@/lib/utils';
import { useChoices, type SlotTarget } from './api';

/**
 * A short list of teachers or rooms for one slot. Valid choices come first; the rest are greyed with the reason ("Busy: teaching 8-B",
 * "Under maintenance", "Too small"), so nobody has to guess why a choice is not offered.
 */
export function ChoicePicker({
  kind,
  target,
  open,
  onClose,
  currentId,
  allowNone,
  onPick,
}: {
  kind: 'faculty' | 'spaces';
  target: SlotTarget | null;
  open: boolean;
  onClose: () => void;
  currentId?: string | null;
  /** Rooms only: a lesson may have no room. */
  allowNone?: boolean;
  onPick: (id: string | null) => void;
}) {
  const choices = useChoices(kind, open ? target : null);
  const title = kind === 'faculty' ? 'Choose a teacher' : 'Choose a room';
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title={title} description="Choices that work are first. The others show why they cannot be used.">
      {choices.isLoading && <Skeleton className="h-40 rounded-xl" role="status" aria-label="Loading choices" />}
      {choices.isError && <ErrorState error={choices.error} onRetry={() => void choices.refetch()} />}
      {choices.data && (
        <ul className="space-y-1.5" aria-label={title}>
          {allowNone && kind === 'spaces' && (
            <li>
              <Button variant="outline" size="sm" className="w-full justify-start" onClick={() => onPick(null)}>
                No room
              </Button>
            </li>
          )}
          {choices.data.map((c) => (
            <Choice key={c.id} choice={c} kind={kind} current={c.id === currentId} onPick={() => onPick(c.id)} />
          ))}
        </ul>
      )}
    </Modal>
  );
}

function Choice({ choice, kind, current, onPick }: { choice: ChoiceDTO; kind: 'faculty' | 'spaces'; current: boolean; onPick: () => void }) {
  const Icon = kind === 'faculty' ? UserRound : DoorClosed;
  return (
    <li>
      <button
        type="button"
        disabled={!choice.ok}
        onClick={onPick}
        className={cn('flex w-full items-start gap-2 rounded-xl border px-3 py-2 text-left text-sm', choice.ok ? 'border-line bg-white hover:border-brand hover:bg-brand-soft/40' : 'cursor-not-allowed border-line bg-ink/[0.03] text-muted')}
      >
        <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2 font-semibold">
            {choice.name}
            {choice.recommended && choice.ok && <span className="rounded-pill bg-success-soft px-2 py-0.5 text-[11px] font-semibold text-success">Recommended</span>}
            {current && <Check className="size-4 text-brand" aria-label="Current choice" />}
          </span>
          {!choice.ok && choice.reason && <span className="block text-[13px]">{choice.reason}</span>}
          {choice.ok && choice.detail && <span className="block text-[13px] text-muted">{choice.detail}</span>}
        </span>
      </button>
    </li>
  );
}
