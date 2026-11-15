import { useState, type ReactNode } from 'react';
import { AlertDialog as Primitive } from 'radix-ui';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';

interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** Name the effect of the action in plain words. */
  description: ReactNode;
  children?: ReactNode;
  confirmLabel: string;
  loadingLabel: string;
  tone?: 'default' | 'danger';
  /** Throw to keep the dialog open and show the error inside it. */
  onConfirm: () => Promise<void> | void;
  icon?: ReactNode;
}

export function ConfirmDialog({ open, onOpenChange, title, description, children, confirmLabel, loadingLabel, tone = 'default', onConfirm, icon }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    if (!next) setError(null);
    onOpenChange(next);
  };

  const confirm = async () => {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setPending(false);
    }
  };

  return (
    <Primitive.Root open={open} onOpenChange={handleOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="fixed inset-0 z-50 bg-navy/50 backdrop-blur-[2px]" />
        <Primitive.Content className="fixed top-1/2 left-1/2 z-50 w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-card border border-line bg-white p-6 shadow-pop outline-none">
          <div className="flex gap-4">
            {icon && <div className={cn('grid size-11 shrink-0 place-items-center rounded-xl', tone === 'danger' ? 'bg-danger-soft text-danger' : 'bg-brand-soft text-brand')}>{icon}</div>}
            <div className="min-w-0">
              <Primitive.Title className="text-lg font-extrabold text-ink">{title}</Primitive.Title>
              <Primitive.Description asChild>
                <div className="mt-1.5 text-[15px] text-muted">{description}</div>
              </Primitive.Description>
            </div>
          </div>
          {children && <div className="mt-4">{children}</div>}
          {error && (
            <Alert tone="danger" className="mt-4">
              {error}
            </Alert>
          )}
          <div className="mt-6 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Primitive.Cancel asChild>
              <Button variant="outline" disabled={pending}>
                Cancel
              </Button>
            </Primitive.Cancel>
            <Button variant={tone === 'danger' ? 'destructive' : 'default'} onClick={confirm} loading={pending} loadingText={loadingLabel}>
              {confirmLabel}
            </Button>
          </div>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
