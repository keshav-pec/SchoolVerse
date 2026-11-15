import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export const inputClass =
  'h-11 w-full min-w-0 rounded-control border border-control bg-white px-3.5 text-base text-ink transition-[border,box-shadow] outline-none placeholder:text-muted/70 hover:border-ink/50 focus:border-brand focus:ring-4 focus:ring-brand/15 disabled:cursor-not-allowed disabled:bg-canvas disabled:opacity-70 aria-invalid:border-danger aria-invalid:focus:ring-danger/15 sm:text-sm';

export function Input({ className, ...props }: ComponentProps<'input'>) {
  return <input data-slot="input" className={cn(inputClass, className)} {...props} />;
}
