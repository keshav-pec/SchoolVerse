import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-pill px-2.5 py-1 text-[13px] leading-none font-semibold whitespace-nowrap [&_svg]:size-[13px] [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'bg-ink/6 text-ink',
        brand: 'bg-brand-soft text-brand',
        success: 'bg-success-soft text-success',
        warning: 'bg-warning-soft text-warning',
        danger: 'bg-danger-soft text-danger',
        sun: 'bg-sun-soft text-[#7a5300]',
        lavender: 'bg-lavender-soft text-[#5b4bd1]',
        mint: 'bg-mint-soft text-[#08754f]',
        coral: 'bg-coral-soft text-[#b4401f]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export function Badge({ className, tone, ...props }: ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
