import type { ComponentProps, ReactNode } from 'react';
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
