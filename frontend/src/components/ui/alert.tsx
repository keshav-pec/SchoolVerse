import type { ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';

const tones = {
  info: { cls: 'border-brand/20 bg-brand-soft text-ink', Icon: Info, icon: 'text-brand' },
  success: { cls: 'border-success/20 bg-success-soft text-ink', Icon: CircleCheck, icon: 'text-success' },
  warning: { cls: 'border-warning/20 bg-warning-soft text-ink', Icon: TriangleAlert, icon: 'text-warning' },
  danger: { cls: 'border-danger/20 bg-danger-soft text-ink', Icon: CircleAlert, icon: 'text-danger' },
} as const;

export function Alert({ tone = 'info', title, children, className }: { tone?: keyof typeof tones; title?: string; children?: ReactNode; className?: string }) {
  const { cls, Icon, icon } = tones[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cn('flex gap-3 rounded-xl border px-4 py-2.5 text-sm', cls, className)}>
      <Icon className={cn('mt-0.5 size-[18px] shrink-0', icon)} aria-hidden="true" />
      <div className="min-w-0">
        {title && <p className="font-semibold">{title}</p>}
        {children && <div className={cn(title && 'mt-0.5 text-muted')}>{children}</div>}
      </div>
    </div>
  );
}
