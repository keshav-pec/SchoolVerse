import type { ReactNode } from 'react';
import { Check, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/** Shared pieces of the step-by-step "Add …" drawers (location, employee): the progress bar and the review step. */

export interface DrawerStep {
  key: string;
  label: string;
  /** Form fields on this step, so a server error can send the person back to the right step. */
  fields: readonly string[];
}

/** The step that owns a field (`address.city` belongs to the step with `address`). Unknown fields go to the first step. */
export function stepOfField(steps: readonly DrawerStep[], field: string): number {
  const i = steps.findIndex((s) => s.fields.includes(field) || s.fields.some((f) => field.startsWith(`${f}.`)));
  return i === -1 ? 0 : i;
}

export function DrawerStepper({ steps, current, onJump }: { steps: readonly DrawerStep[]; current: number; onJump: (i: number) => void }) {
  // With many steps only the current label fits on a phone.
  const compact = steps.length > 3;
  return (
    <ol className="flex items-center gap-1 border-b border-line bg-canvas px-5 py-3 sm:px-6" aria-label="Progress">
      {steps.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step.key} className="flex flex-1 items-center gap-1 last:flex-none">
            <button
              type="button"
              disabled={i > current}
              onClick={() => onJump(i)}
              aria-current={active ? 'step' : undefined}
              className={cn('flex items-center gap-2 rounded-lg py-1 pr-1 text-sm font-semibold outline-none', active ? 'text-brand' : done ? 'text-ink' : 'text-muted')}
            >
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold',
                  active ? 'bg-brand text-white' : done ? 'bg-success text-white' : 'bg-ink/10 text-muted',
                )}
              >
                {done ? <Check className="size-3.5" aria-hidden="true" /> : i + 1}
              </span>
              <span className={cn(compact && !active && 'hidden sm:inline')}>{step.label}</span>
            </button>
            {i < steps.length - 1 && <span aria-hidden="true" className={cn('h-0.5 flex-1 rounded-full', done ? 'bg-success' : 'bg-ink/10')} />}
          </li>
        );
      })}
    </ol>
  );
}

export function ReviewCard({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold">{title}</h3>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${title}`}>
          <Pencil /> Edit
        </Button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[150px_1fr]">{children}</dl>
    </section>
  );
}

export function ReviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 font-medium break-words">{value || '—'}</dd>
    </>
  );
}
