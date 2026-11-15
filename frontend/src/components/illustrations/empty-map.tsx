import { cn } from '@/lib/utils';

/** "Let's put your school on the map" — empty Locations illustration. */
export function EmptyMap({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 240 180" className={cn('h-auto w-full', className)} aria-hidden="true">
      <rect x="28" y="38" width="184" height="116" rx="16" fill="#EEF4FF" />
      <path d="M28 96c30-18 52 14 82-4s58-26 102-6v64a16 16 0 0 1-16 16H44a16 16 0 0 1-16-16Z" fill="#E5F8F0" />
      <path d="M60 154c10-26 34-30 50-52 14-18 40-26 70-22" fill="none" stroke="#244FD4" strokeWidth="3" strokeLinecap="round" strokeDasharray="2 8" />
      <g className="animate-float">
        <path d="M150 28c-16 0-28 12-28 27 0 20 28 44 28 44s28-24 28-44c0-15-12-27-28-27Z" fill="#FF7A59" />
        <circle cx="150" cy="55" r="10" fill="#fff" />
        <path d="M145 56l4 4 7-9" fill="none" stroke="#FF7A59" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      </g>
      <ellipse cx="150" cy="108" rx="14" ry="4" fill="#0D1F3D" opacity=".12" />
      <circle cx="62" cy="62" r="5" fill="#FFC940" />
      <circle cx="198" cy="132" r="4" fill="#8B7CF6" />
    </svg>
  );
}
