import { Bus, Check } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface RouteStop {
  key: string;
  label: string;
}

/**
 * The wizard's progress bar: a school-bus route with one stop per step.
 * The bus drives to the current stop. Finished stops are tappable to go back.
 */
export function BusRoute({ stops, current, onJump }: { stops: readonly RouteStop[]; current: number; onJump?: (step: number) => void }) {
  const last = stops.length - 1;
  const position = (current - 1) / last;
  return (
    <nav aria-label="Setup progress">
      <ol className="relative flex items-start justify-between">
        {/* road + the part already driven */}
        <span aria-hidden="true" className="absolute inset-x-5 top-[43px] h-1.5 rounded-full bg-[repeating-linear-gradient(90deg,var(--color-line)_0_10px,transparent_10px_16px)] sm:inset-x-12" />
        <span aria-hidden="true" className="absolute inset-x-5 top-[43px] h-1.5 sm:inset-x-12">
          <motion.span className="block h-full origin-left rounded-full bg-brand" initial={false} animate={{ scaleX: position }} transition={{ type: 'spring', stiffness: 120, damping: 20 }} />
        </span>
        {/* the bus drives to the current stop */}
        <span aria-hidden="true" className="pointer-events-none absolute inset-x-5 top-0 z-20 h-8 sm:inset-x-12">
          <motion.span className="absolute top-0 -ml-4 text-sun" initial={false} animate={{ left: `${position * 100}%` }} transition={{ type: 'spring', stiffness: 120, damping: 18 }}>
            <Bus className="size-8 fill-sun stroke-navy drop-shadow" strokeWidth={1.6} />
          </motion.span>
        </span>

        {stops.map((stop, i) => {
          const n = i + 1;
          const done = n < current;
          const active = n === current;
          return (
            <li key={stop.key} className="relative z-10 flex w-10 flex-col items-center sm:w-24" aria-current={active ? 'step' : undefined}>
              <button
                type="button"
                disabled={!done || !onJump}
                onClick={() => onJump?.(n)}
                aria-label={`Step ${n}: ${stop.label}${done ? ' (completed, go back)' : active ? ' (current)' : ''}`}
                className={cn(
                  'mt-[34px] grid size-6 place-items-center rounded-full border-2 text-[11px] font-bold transition-colors',
                  done ? 'border-brand bg-brand text-white hover:bg-brand-hover' : active ? 'border-brand bg-white text-brand ring-4 ring-brand/15' : 'border-line bg-white text-muted',
                )}
              >
                {done ? <Check className="size-3.5" aria-hidden="true" /> : n}
              </button>
              <span className={cn('mt-2 hidden text-center text-xs leading-tight font-semibold sm:block', active ? 'text-ink' : 'text-muted')}>{stop.label}</span>
            </li>
          );
        })}
      </ol>
      <p className="mt-3 text-center text-sm font-semibold text-ink sm:hidden">
        Step {current} of {stops.length}: {stops[current - 1]?.label}
      </p>
    </nav>
  );
}
