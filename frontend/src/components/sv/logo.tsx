import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={cn('size-10', className)} aria-hidden="true">
      <rect width="64" height="64" rx="16" fill="#244FD4" />
      <circle cx="32" cy="33" r="13" fill="#fff" />
      <path d="M25 31.5 32 28l7 3.5-7 3.5-7-3.5Z" fill="#244FD4" />
      <path d="M28 33.6v3.1c0 1 1.8 2 4 2s4-1 4-2v-3.1L32 35.5l-4-1.9Z" fill="#244FD4" />
      <ellipse cx="32" cy="33" rx="23" ry="7.5" fill="none" stroke="#FFC940" strokeWidth="4" transform="rotate(-18 32 33)" />
      <circle cx="47" cy="16" r="4" fill="#FFC940" />
    </svg>
  );
}

export function Logo({ tone = 'dark', className }: { tone?: 'dark' | 'light'; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className={cn('font-display text-[22px] leading-none font-extrabold tracking-tight', tone === 'light' ? 'text-white' : 'text-ink')}>
        School<span className={tone === 'light' ? 'text-sun' : 'text-brand'}>Verse</span>
      </span>
    </span>
  );
}
