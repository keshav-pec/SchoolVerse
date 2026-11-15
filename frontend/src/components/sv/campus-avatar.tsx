import { cn } from '@/lib/utils';

const GRADIENTS = ['from-brand to-lavender', 'from-coral to-sun', 'from-mint to-brand', 'from-lavender to-coral', 'from-sun to-mint'];

function hash(value: string) {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const SIZES = { sm: 'size-9 rounded-[10px] text-[11px]', md: 'size-11 rounded-xl text-xs', lg: 'size-16 rounded-2xl text-lg' } as const;

/** Gradient tile showing the location code (e.g. MOH). Colour is stable per code and purely decorative. */
export function CampusAvatar({ code, size = 'md', className }: { code: string; size?: keyof typeof SIZES; className?: string }) {
  return (
    <span aria-hidden="true" className={cn('grid shrink-0 place-items-center bg-gradient-to-br font-extrabold tracking-wide text-white shadow-sm', GRADIENTS[hash(code) % GRADIENTS.length], SIZES[size], className)}>
      {code.slice(0, 4)}
    </span>
  );
}
