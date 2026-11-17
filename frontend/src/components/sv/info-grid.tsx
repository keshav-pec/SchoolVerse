import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A label above a value, in a responsive grid. Empty values show a dash. */
export function InfoGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <dl className={cn('grid gap-x-8 gap-y-4 sm:grid-cols-2 lg:grid-cols-3', className)}>
      {children}
    </dl>
  );
}

export function InfoItem({
  label,
  children,
  className,
}: {
  label: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-semibold break-words">
        {children || <span className="font-normal text-muted">—</span>}
      </dd>
    </div>
  );
}
