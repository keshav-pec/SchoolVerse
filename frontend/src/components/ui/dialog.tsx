import type { ComponentProps, ReactNode } from 'react';
import { X } from 'lucide-react';
import { Dialog as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export const Dialog = Primitive.Root;
export const DialogTrigger = Primitive.Trigger;
export const DialogClose = Primitive.Close;

export function DialogContent({
  className,
  children,
  title,
  description,
  hideTitle,
  ...props
}: Omit<ComponentProps<typeof Primitive.Content>, 'title'> & { title: string; description?: ReactNode; hideTitle?: boolean }) {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-navy/50 backdrop-blur-[2px]" />
      <Primitive.Content
        className={cn(
          'fixed top-1/2 left-1/2 z-50 max-h-[90dvh] w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-card border border-line bg-white p-6 shadow-pop outline-none',
          className,
        )}
        aria-describedby={description ? undefined : undefined}
        {...props}
      >
        <Primitive.Title className={cn('pr-8 text-xl font-extrabold text-ink', hideTitle && 'sr-only')}>{title}</Primitive.Title>
        {description ? (
          <Primitive.Description asChild>
            <div className="mt-1.5 text-[15px] text-muted">{description}</div>
          </Primitive.Description>
        ) : (
          <Primitive.Description className="sr-only">{title}</Primitive.Description>
        )}
        {children}
        <Primitive.Close className="absolute top-4 right-4 grid size-9 place-items-center rounded-lg text-muted hover:bg-ink/5 hover:text-ink" aria-label="Close dialog">
          <X className="size-5" />
        </Primitive.Close>
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />;
}
