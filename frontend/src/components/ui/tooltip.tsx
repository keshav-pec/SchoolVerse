import { useState, type ComponentProps, type ReactNode } from 'react';
import { Info } from 'lucide-react';
import { Tooltip as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const TooltipProvider = Primitive.Provider;

/** Wrap a focusable element. `content` must not be the only place critical info lives. */
export function Tooltip({ content, children, side = 'top', className }: { content: ReactNode; children: ReactNode; side?: ComponentProps<typeof Primitive.Content>['side']; className?: string }) {
  return (
    <Primitive.Root delayDuration={150}>
      <Primitive.Trigger asChild>{children}</Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content side={side} sideOffset={6} className={cn('z-[60] max-w-xs rounded-lg bg-navy px-3 py-2 text-[13px] leading-snug text-white shadow-pop', className)}>
          {content}
          <Primitive.Arrow className="fill-navy" />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}

/**
 * The "i" help card: a small info icon that explains a section or field in plain words.
 * Opens on hover, keyboard focus or a tap (so it also works on touch screens).
 */
export function InfoTip({ label, children, side = 'top', className }: { label: string; children: ReactNode; side?: ComponentProps<typeof Primitive.Content>['side']; className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Primitive.Root delayDuration={100} open={open} onOpenChange={setOpen}>
      <Primitive.Trigger asChild>
        <button
          type="button"
          aria-label={label}
          onClick={(e) => {
            e.preventDefault();
            setOpen(true);
          }}
          className={cn('inline-grid size-5 shrink-0 place-items-center rounded-full align-middle text-muted hover:bg-brand-soft hover:text-brand focus-visible:outline-2 focus-visible:outline-brand', className)}
        >
          <Info className="size-4" aria-hidden="true" />
        </button>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content
          side={side}
          sideOffset={6}
          collisionPadding={12}
          className="z-[60] max-w-sm space-y-1.5 rounded-lg bg-navy px-3.5 py-3 text-[13px] leading-relaxed font-normal text-white shadow-pop [&_b]:font-semibold [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-4"
        >
          {children}
          <Primitive.Arrow className="fill-navy" />
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
