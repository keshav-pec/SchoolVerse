import type { ComponentProps } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle } from 'lucide-react';
import { Slot } from 'radix-ui';
import { cn } from '@/lib/utils';

export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 rounded-control text-sm font-semibold whitespace-nowrap transition-all duration-150 outline-none select-none focus-visible:ring-4 focus-visible:ring-brand/25 disabled:pointer-events-none disabled:opacity-55 active:scale-[0.98] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*=size-])]:size-4',
  {
    variants: {
      variant: {
        default: 'bg-brand text-white shadow-brand hover:bg-brand-hover hover:-translate-y-px',
        outline: 'border border-control bg-white text-ink hover:bg-canvas hover:border-ink/40',
        secondary: 'bg-brand-soft text-brand hover:bg-[#e1ebff]',
        ghost: 'text-ink hover:bg-ink/5',
        destructive: 'bg-danger text-white hover:bg-[#a11e2e]',
        link: 'h-auto px-0 text-brand underline-offset-4 hover:underline',
        sun: 'bg-sun text-navy shadow-[0_8px_20px_-8px_rgb(255_201_64/0.8)] hover:-translate-y-px hover:bg-[#ffbf1f]',
      },
      size: {
        default: 'h-11 px-5',
        sm: 'h-9 px-3.5 text-[13px]',
        lg: 'h-12 px-6 text-[15px]',
        icon: 'size-11',
        'icon-sm': 'size-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    /** Shows a spinner, disables repeat clicks and exposes aria-busy. */
    loading?: boolean;
    /** Must name the ongoing action, e.g. "Signing you in…". */
    loadingText?: string;
  };

export function Button({ className, variant, size, asChild = false, loading, loadingText, disabled, children, type = 'button', ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : 'button';
  return (
    <Comp
      data-slot="button"
      type={asChild ? undefined : type}
      className={cn(buttonVariants({ variant, size }), className)}
      disabled={asChild ? undefined : disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <LoaderCircle className="animate-spin" aria-hidden="true" />
          {loadingText ?? children}
        </>
      ) : (
        children
      )}
    </Comp>
  );
}
