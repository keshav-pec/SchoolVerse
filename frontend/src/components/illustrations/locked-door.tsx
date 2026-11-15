import { cn } from '@/lib/utils';

export function LockedDoor({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 180" className={cn('h-auto w-full', className)} aria-hidden="true">
      <circle cx="120" cy="96" r="70" fill="#EEF4FF" />
      <rect x="82" y="44" width="76" height="112" rx="10" fill="#244FD4" />
      <rect x="92" y="56" width="56" height="90" rx="6" fill="#1c3eac" />
      <rect x="100" y="94" width="40" height="32" rx="7" fill="#FFC940" />
      <path d="M108 94v-8a12 12 0 0 1 24 0v8" fill="none" stroke="#FFC940" strokeWidth="6" />
      <circle cx="120" cy="108" r="4" fill="#0d1f3d" />
      <rect x="118" y="110" width="4" height="9" rx="2" fill="#0d1f3d" />
      <g className="animate-float">
        <path d="M184 46l3 8 8 3-8 3-3 8-3-8-8-3 8-3Z" fill="#FF7A59" />
      </g>
      <circle cx="52" cy="60" r="5" fill="#2BC48A" />
    </svg>
  );
}
