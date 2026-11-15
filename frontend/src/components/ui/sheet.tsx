import type { ComponentProps, ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Sheet = Primitive.Root;
export const SheetTrigger = Primitive.Trigger;
export const SheetClose = Primitive.Close;

/** Off-canvas panel (used for the mobile sidebar). */
export function SheetContent({
  className,
  children,
  title,
  side = 'left',
  ...props
}: ComponentProps<typeof Primitive.Content> & { title: string; side?: 'left' | 'right'; children: ReactNode }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-40 bg-navy/50 backdrop-blur-[2px]" />
      <Primitive.Content
        className={cn('fixed inset-y-0 z-50 flex w-[280px] max-w-[85vw] flex-col shadow-pop outline-none', side === 'left' ? 'left-0' : 'right-0', className)}
        aria-describedby={undefined}
        {...props}
      >
        <Primitive.Title className="sr-only">{title}</Primitive.Title>
        {children}
        <Primitive.Close className="absolute top-4 right-3 grid size-9 place-items-center rounded-lg text-navy-text hover:bg-white/10" aria-label="Close menu">
          <X className="size-5" />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}
