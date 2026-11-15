import { useEffect, useState } from 'react';
import { animate, motion } from 'motion/react';

function prefersReducedMotion() {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** Counts up to `value` once, or jumps straight there for people who prefer reduced motion. */
function useCountUp(value: number) {
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));
  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    const controls = animate(0, value, { duration: 1.1, ease: 'easeOut', onUpdate: (v) => setShown(Math.round(v)) });
    return () => controls.stop();
  }, [value]);
  return shown;
}

/** Animated setup-completion ring. The number is also exposed as a labelled progressbar. */
export function CompletionRing({ percent, size = 148 }: { percent: number; size?: number }) {
  const stroke = 13;
  const r = (size - stroke) / 2;
  const shown = useCountUp(percent);
  return (
    <div role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} aria-label="Setup completion" className="relative" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden="true">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-brand-soft)" strokeWidth={stroke} />
        <motion.circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--color-brand)"
          strokeWidth={stroke}
          strokeLinecap="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: percent / 100 }}
          transition={{ duration: prefersReducedMotion() ? 0 : 1.1, ease: 'easeOut' }}
        />
      </svg>
      <div className="absolute inset-0 grid place-items-center text-center">
        <div>
          <p className="font-display text-[34px] leading-none font-extrabold text-ink tabular-nums">
            {shown}
            <span className="text-xl">%</span>
          </p>
          <p className="mt-1 text-xs font-semibold text-muted">complete</p>
        </div>
      </div>
    </div>
  );
}
