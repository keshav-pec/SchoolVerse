import { cn } from '@/lib/utils';

export function LostPlanet({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 180" className={cn('h-auto w-full', className)} aria-hidden="true">
      <circle cx="120" cy="92" r="52" fill="#EEF4FF" />
      <circle cx="120" cy="92" r="38" fill="#244FD4" />
      <circle cx="106" cy="80" r="7" fill="#1c3eac" />
      <circle cx="134" cy="104" r="5" fill="#1c3eac" />
      <ellipse cx="120" cy="92" rx="70" ry="18" fill="none" stroke="#FFC940" strokeWidth="6" transform="rotate(-16 120 92)" />
      <g className="animate-float">
        <path d="M188 30l3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#FF7A59" />
      </g>
      <path d="M40 40l2 5 5 2-5 2-2 5-2-5-5-2 5-2Z" fill="#8B7CF6" />
      <circle cx="54" cy="140" r="4" fill="#2BC48A" />
      <circle cx="196" cy="136" r="3" fill="#8B7CF6" />
    </svg>
  );
}
