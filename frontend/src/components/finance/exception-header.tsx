import type { ReactNode } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { formatMoneyShort } from '@/lib/money';
import { cn } from '@/lib/utils';

const count = (n: number) => n.toLocaleString('en-IN');

/**
 * The headline of an exception-first screen: "**2,796** ready · **54** need attention · ₹1.18 crore", with the one main button beside
 * it. People look at the exceptions; the normal rows stay collapsed.
 */
export function ExceptionHeader({
  ready,
  attention,
  totalPaise,
  readyWord = 'ready',
  action,
  className,
}: {
  ready: number;
  attention: number;
  totalPaise?: number;
  readyWord?: string;
  action?: ReactNode;
  className?: string;
}) {
  const clear = attention === 0;
  return (
    <div className={cn('flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3', clear ? 'border-success/25 bg-success-soft' : 'border-warning/25 bg-warning-soft', className)}>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px] text-ink" aria-live="polite">
        {clear ? <CircleCheck className="size-5 text-success" aria-hidden="true" /> : <TriangleAlert className="size-5 text-warning" aria-hidden="true" />}
        <span>
          <b className="text-lg">{count(ready)}</b> {readyWord}
        </span>
        <span aria-hidden="true">·</span>
        <span>
          <b className="text-lg">{count(attention)}</b> {attention === 1 ? 'needs attention' : 'need attention'}
        </span>
        {totalPaise !== undefined && (
          <>
            <span aria-hidden="true">·</span>
            <span className="font-semibold">{formatMoneyShort(totalPaise)}</span>
          </>
        )}
      </p>
      {action}
    </div>
  );
}
