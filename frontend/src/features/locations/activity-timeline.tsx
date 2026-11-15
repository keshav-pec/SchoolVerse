import { AUDIT_ACTION_LABELS, ROLE_LABELS, type AuditEventDTO } from '@shared';
import { ArrowRight, Archive, CirclePlus, Crown, History, PauseCircle, PencilLine, Play, Trash2 } from 'lucide-react';
import type { ComponentType } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { fieldLabel, formatAuditValue, formatDateTime, formatRelative } from '@/lib/format';
import { useAuditTrail } from './api';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'location.created': CirclePlus,
  'location.updated': PencilLine,
  'location.activated': Play,
  'location.deactivated': PauseCircle,
  'location.archived': Archive,
  'location.primary_set': Crown,
  'location.primary_unset': Crown,
  'location.deleted': Trash2,
};

function actorLabel(e: AuditEventDTO) {
  if (e.actor.role === 'SYSTEM') return 'SchoolVerse';
  return e.actor.name ?? ROLE_LABELS[e.actor.role];
}

/** Extra context from the event metadata ("Replaced Chandigarh Campus as Primary"). */
function contextLine(e: AuditEventDTO): string | null {
  const m = e.metadata;
  if (e.action === 'location.primary_set' && typeof m.previousPrimaryName === 'string') return `Replaced ${m.previousPrimaryName}${m.previousPrimaryCode ? ` (${m.previousPrimaryCode})` : ''} as Primary.`;
  if (e.action === 'location.primary_unset' && typeof m.newPrimaryName === 'string') return `${m.newPrimaryName}${m.newPrimaryCode ? ` (${m.newPrimaryCode})` : ''} is the new Primary Location.`;
  return null;
}

function Diff({ change }: { change: AuditEventDTO['changes'][number] }) {
  const { field } = change;
  return (
    <li className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
      <span className="font-semibold text-ink">{fieldLabel(field)}:</span>
      <span className="rounded bg-danger-soft px-1.5 py-0.5 text-danger line-through decoration-danger/40">{formatAuditValue(field, change.from)}</span>
      <ArrowRight className="size-3.5 text-muted" aria-label="changed to" />
      <span className="rounded bg-success-soft px-1.5 py-0.5 font-medium text-success">{formatAuditValue(field, change.to)}</span>
    </li>
  );
}

export function ActivityTimeline({ entityType, entityId, enabled }: { entityType: string; entityId: string; enabled: boolean }) {
  const q = useAuditTrail(entityType, entityId, enabled);
  const events = q.data?.pages.flatMap((p) => p.items) ?? [];

  if (q.isLoading) {
    return (
      <div className="space-y-5" role="status" aria-label="Loading activity">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="size-9 rounded-full" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-40" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (events.length === 0) return <EmptyState illustration={<History className="size-12 text-muted" aria-hidden="true" />} title="No activity yet" description="Changes to this location will show up here." />;

  return (
    <div>
      <ol className="relative space-y-6 before:absolute before:top-2 before:bottom-2 before:left-[17px] before:w-px before:bg-line" aria-label="Activity">
        {events.map((e) => {
          const Icon = ICONS[e.action] ?? History;
          const ctx = contextLine(e);
          return (
            <li key={e.auditEventId} className="relative flex gap-3">
              <span className="relative z-10 grid size-9 shrink-0 place-items-center rounded-full border border-line bg-white text-brand">
                <Icon className="size-4" />
              </span>
              <div className="min-w-0 flex-1 pt-0.5">
                <p className="text-sm font-semibold text-ink">{AUDIT_ACTION_LABELS[e.action] ?? e.action}</p>
                <p className="text-[13px] text-muted">
                  {actorLabel(e)} · <time dateTime={e.occurredAt} title={formatDateTime(e.occurredAt)}>{formatRelative(e.occurredAt)}</time>
                </p>
                {ctx && <p className="mt-1 text-[13px] text-muted">{ctx}</p>}
                {e.changes.length > 0 && e.action !== 'location.created' && (
                  <ul className="mt-2 space-y-1.5" aria-label="Changes">
                    {e.changes.map((c) => (
                      <Diff key={c.field} change={c} />
                    ))}
                  </ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      {q.hasNextPage && (
        <div className="mt-6 text-center">
          <Button variant="outline" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage} loadingText="Loading…">
            Load older activity
          </Button>
        </div>
      )}
    </div>
  );
}
