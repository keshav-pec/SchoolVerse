import type { ReactNode } from 'react';
import { Lightbulb } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { InfoTip } from '@/components/ui/tooltip';

/**
 * Plain-language intro at the top of a session tab: what this tab is for and whether it must be set up.
 * Written for front-office staff, so: short sentences, an example, and when it's safe to skip.
 */
export function TabIntro({ title, need, children }: { title: string; need: 'required' | 'optional'; children: ReactNode }) {
  return (
    <aside aria-label={`About ${title}`} className="flex gap-3 rounded-xl border border-brand/15 bg-brand-soft/60 px-4 py-3 text-sm">
      <Lightbulb className="mt-0.5 size-[18px] shrink-0 text-brand" aria-hidden="true" />
      <div className="min-w-0 space-y-1">
        <p className="flex flex-wrap items-center gap-2 font-semibold text-ink">
          {title}
          <Badge tone={need === 'required' ? 'brand' : 'neutral'}>{need === 'required' ? 'Required' : 'Optional'}</Badge>
        </p>
        <div className="space-y-1 text-ink/80">{children}</div>
      </div>
    </aside>
  );
}

/** A section heading with an "i" help card beside it. */
export function HelpHeading({ title, help, helpLabel, className = 'text-lg font-bold' }: { title: string; help: ReactNode; helpLabel?: string; className?: string }) {
  return (
    <h2 className={`flex items-center gap-1.5 ${className}`}>
      {title}
      <InfoTip label={helpLabel ?? `About ${title.toLowerCase()}`}>{help}</InfoTip>
    </h2>
  );
}
