import { PERIOD_TYPE_LABELS, type PeriodType } from '@shared';
import { cn } from '@/lib/utils';

export interface TimelinePeriod {
  key: string;
  name: string;
  start: string;
  end: string;
  startMin: number;
  endMin: number;
  periodType: PeriodType;
  /** Shown red, with the reason as the tooltip. */
  problem?: string | null;
}

const TONE: Record<PeriodType, string> = {
  TEACHING: 'bg-brand text-white',
  HOMEROOM: 'bg-lavender-soft text-[#5b4bd1]',
  ACTIVITY: 'bg-mint-soft text-[#08754f]',
  ASSEMBLY: 'bg-sun-soft text-[#7a5300]',
  BREAK: 'bg-coral-soft text-[#b4401f]',
  LUNCH: 'bg-coral-soft text-[#b4401f]',
  NON_INSTRUCTIONAL: 'bg-ink/10 text-ink',
};

/**
 * The school day as one bar: every period is a block as wide as it is long. It is a picture of the list below it, so it is hidden
 * from screen readers (`aria-hidden`); the list and table carry the same facts.
 */
export function Timeline({ periods, className }: { periods: TimelinePeriod[]; className?: string }) {
  if (periods.length === 0) return null;
  const from = Math.min(...periods.map((p) => p.startMin));
  const to = Math.max(...periods.map((p) => p.endMin));
  const span = Math.max(1, to - from);
  return (
    <div className={cn('space-y-1', className)} aria-hidden="true">
      <div className="relative flex h-12 w-full overflow-hidden rounded-xl border border-line bg-canvas">
        {periods.map((p) => (
          <div
            key={p.key}
            title={`${p.name}, ${p.start} to ${p.end}${p.problem ? `. ${p.problem}` : ''}`}
            style={{ left: `${((p.startMin - from) / span) * 100}%`, width: `${((p.endMin - p.startMin) / span) * 100}%` }}
            className={cn('absolute inset-y-0 grid place-items-center overflow-hidden border-r border-white/70 text-[11px] font-bold', TONE[p.periodType], p.problem && 'bg-danger text-white ring-2 ring-danger')}
          >
            <span className="truncate px-0.5">{p.name.replace(/^Period /, 'P')}</span>
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[11px] font-semibold text-muted">
        <span>{periods.find((p) => p.startMin === from)?.start}</span>
        <span>{periods.find((p) => p.endMin === to)?.end}</span>
      </div>
    </div>
  );
}

export function TimelineLegend() {
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[12px] text-muted" aria-label="Colours">
      {(['TEACHING', 'BREAK', 'ASSEMBLY'] as const).map((t) => (
        <li key={t} className="flex items-center gap-1.5">
          <span className={cn('inline-block size-3 rounded', TONE[t])} aria-hidden="true" />
          {t === 'BREAK' ? 'Break or lunch' : PERIOD_TYPE_LABELS[t]}
        </li>
      ))}
    </ul>
  );
}
