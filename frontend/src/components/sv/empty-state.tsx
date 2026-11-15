import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function EmptyState({ illustration, title, description, action, className }: { illustration?: ReactNode; title: string; description?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto flex max-w-md flex-col items-center px-4 py-10 text-center', className)}>
      {illustration}
      <h2 className="mt-4 text-xl font-extrabold text-ink">{title}</h2>
      {description && <p className="mt-1.5 text-[15px] text-muted">{description}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
