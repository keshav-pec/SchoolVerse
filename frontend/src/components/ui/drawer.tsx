import type { ComponentProps, ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Drawer = Primitive.Root;

/** Right-hand panel for multi-step flows and edit forms. Full width on phones. */
export function DrawerContent({
  className,
  children,
  title,
  description,
  ...props
}: Omit<ComponentProps<typeof Primitive.Content>, 'title'> & { title: string; description?: string; children: ReactNode }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-navy/50 backdrop-blur-[2px]" />
      <Primitive.Content
        className={cn('fixed inset-y-0 right-0 z-50 flex w-full max-w-[560px] flex-col bg-white shadow-pop outline-none', className)}
        {...props}
      >
        <header className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <Primitive.Title className="text-xl font-extrabold text-ink">{title}</Primitive.Title>
            {description ? (
              <Primitive.Description className="mt-0.5 text-sm text-muted">{description}</Primitive.Description>
            ) : (
              <Primitive.Description className="sr-only">{title}</Primitive.Description>
            )}
          </div>
          <Primitive.Close className="-mr-2 grid size-9 shrink-0 place-items-center rounded-lg text-muted hover:bg-ink/5 hover:text-ink" aria-label="Close panel">
            <X className="size-5" />
          </Primitive.Close>
        </header>
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DrawerBody({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex-1 overflow-y-auto px-5 py-5 sm:px-6', className)} {...props} />;
}

export function DrawerFooter({ className, ...props }: ComponentProps<'footer'>) {
  return <footer className={cn('flex flex-col-reverse gap-2 border-t border-line bg-white px-5 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6', className)} {...props} />;
}
