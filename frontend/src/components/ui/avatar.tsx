import { cn, initialsOf } from '@/lib/utils';

const GRADIENTS = [
  'from-brand to-lavender',
  'from-coral to-sun',
  'from-mint to-brand',
  'from-lavender to-coral',
  'from-sun to-mint',
];

function hash(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

/** Playful gradient avatar — the colour is stable per name. */
export function Avatar({ name, label, className }: { name: string; label?: string; className?: string }) {
  const gradient = GRADIENTS[hash(name) % GRADIENTS.length];
  return (
    <span
      aria-hidden="true"
      className={cn('grid size-9 shrink-0 place-items-center rounded-full bg-gradient-to-br text-[13px] font-bold text-white shadow-sm', gradient, className)}
    >
      {label ?? initialsOf(name)}
    </span>
  );
}
