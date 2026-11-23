import type { ReactNode } from 'react';
import { Eye } from 'lucide-react';
import { cn } from '@/lib/utils';

/** "What will change": the rupee effect, shown before the person presses the confirm button. */
export function ImpactPreview({ title = 'What will change', lines, note, className }: { title?: string; lines: { label: string; value: ReactNode }[]; note?: ReactNode; className?: string }) {
  return (
    <section aria-label={title} className={cn('rounded-xl border border-brand/20 bg-brand-soft/60 px-4 py-3 text-sm', className)}>
      <p className="mb-2 flex items-center gap-2 font-semibold text-ink">
        <Eye className="size-4 text-brand" aria-hidden="true" /> {title}
      </p>
      <dl className="space-y-1">
        {lines.map((l) => (
          <div key={l.label} className="flex items-baseline justify-between gap-4">
            <dt className="text-ink/80">{l.label}</dt>
            <dd className="text-right font-semibold text-ink">{l.value}</dd>
          </div>
        ))}
      </dl>
      {note && <p className="mt-2 text-[13px] text-muted">{note}</p>}
    </section>
  );
}
