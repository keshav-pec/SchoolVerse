import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

/**
 * A centred dialog with room for a form or a result, and a footer for its buttons. Use `ConfirmDialog` for a plain yes/no; use
 * this when the dialog shows more than one step, or answers with something to read.
 */
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-navy/50 backdrop-blur-[2px]" />
        <Primitive.Content
          className={cn('fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col rounded-card border border-line bg-white shadow-pop outline-none', className)}
        >
          <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
            <div className="min-w-0">
              <Primitive.Title className="text-lg font-extrabold text-ink">{title}</Primitive.Title>
              {description ? (
                <Primitive.Description asChild>
                  <div className="mt-0.5 text-sm text-muted">{description}</div>
                </Primitive.Description>
              ) : (
                <Primitive.Description className="sr-only">{title}</Primitive.Description>
              )}
            </div>
            <Primitive.Close className="-mr-2 grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-ink/5 hover:text-ink" aria-label="Close">
              <X className="size-5" />
            </Primitive.Close>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          {footer && <footer className="flex flex-col-reverse gap-2 border-t border-line px-5 py-3 sm:flex-row sm:justify-end">{footer}</footer>}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
