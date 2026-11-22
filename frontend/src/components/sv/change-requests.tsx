import { useState, type ReactNode } from 'react';
import type { ChangeRequestStatus } from '@shared';
import { ArrowRight, CircleCheck, CircleX, Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextareaField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { FormProblem } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The pieces shared by the change-request queues (staff profile changes, parent requests): the status filter, one request card,
 * and the Approve / Reject dialog. Each queue keeps its own wording and API calls.
 */

const STATUS: Record<ChangeRequestStatus, { label: string; tone: 'warning' | 'success' | 'danger' | 'neutral' }> = {
  PENDING: { label: 'Pending', tone: 'warning' },
  APPROVED: { label: 'Approved', tone: 'success' },
  REJECTED: { label: 'Rejected', tone: 'danger' },
  CANCELLED: { label: 'Cancelled', tone: 'neutral' },
};
const STATUSES = Object.keys(STATUS) as ChangeRequestStatus[];

export function RequestStatusBadge({ status }: { status: ChangeRequestStatus }) {
  return (
    <Badge tone={STATUS[status].tone} data-status={status}>
      {STATUS[status].label}
    </Badge>
  );
}

/** Pending / Approved / Rejected / Cancelled, with the pending count on the first. */
export function RequestStatusTabs({ status, onChange, pending }: { status: ChangeRequestStatus; onChange: (status: ChangeRequestStatus) => void; pending?: number }) {
  return (
    <div role="tablist" aria-label="Request status" className="mb-4 flex flex-wrap gap-2">
      {STATUSES.map((s) => (
        <button
          key={s}
          role="tab"
          aria-selected={status === s}
          type="button"
          onClick={() => onChange(s)}
          className={cn('rounded-pill border px-4 py-2 text-sm font-semibold', status === s ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-white text-muted hover:text-ink')}
        >
          {STATUS[s].label}
          {s === 'PENDING' && (pending ?? 0) > 0 ? ` (${pending})` : ''}
        </button>
      ))}
    </div>
  );
}

export interface RequestLine {
  id: string;
  /** The name (linked) and anything after it, e.g. “· asked by Ravi”. */
  who: ReactNode;
  /** Used in the Approve / Reject button labels: “Approve Asha’s Date of birth”. */
  whoName: string;
  field: string;
  askedAt: string;
  oldValue: string | null;
  newValue: string;
  reason?: string | null;
  status: ChangeRequestStatus;
  decidedAt?: string | null;
  decidedByName?: string | null;
  decisionNote?: string | null;
}

interface QueryState {
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isFetching: boolean;
  refetch: () => unknown;
}

/** The queue: loading, error, empty, or one card per request with Approve and Reject while it is pending. */
export function RequestList({
  query,
  items,
  status,
  emptyPending,
  onDecide,
}: {
  query: QueryState;
  items: RequestLine[];
  status: ChangeRequestStatus;
  /** What shows up here, said when nothing is pending. */
  emptyPending: string;
  onDecide: (id: string, mode: 'approve' | 'reject') => void;
}) {
  return (
    <Card className="p-0">
      {query.isLoading ? (
        <div role="status" aria-label="Loading requests" className="space-y-3 p-4">
          <Skeleton className="h-20" />
          <Skeleton className="h-20" />
        </div>
      ) : query.isError ? (
        <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />
      ) : items.length === 0 ? (
        <EmptyState
          illustration={<Inbox className="size-12 text-muted" aria-hidden="true" />}
          title={status === 'PENDING' ? 'Nothing waiting' : 'Nothing here'}
          description={status === 'PENDING' ? emptyPending : undefined}
        />
      ) : (
        <ul className="divide-y divide-line" aria-label="Change requests">
          {items.map((r) => (
            <li key={r.id} className="space-y-3 p-4 sm:p-5">
              <div className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{r.who}</p>
                  <p className="text-[13px] text-muted">
                    {r.field} · asked {formatDateTime(r.askedAt)}
                  </p>
                </div>
                <RequestStatusBadge status={r.status} />
              </div>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="rounded bg-canvas px-2 py-1 text-muted">{r.oldValue || 'Not on file'}</span>
                <ArrowRight className="size-4 text-muted" aria-label="change to" />
                <span className="rounded bg-brand-soft px-2 py-1 font-semibold text-brand">{r.newValue}</span>
              </div>
              {r.reason && <p className="text-sm text-muted">“{r.reason}”</p>}
              {r.status !== 'PENDING' && r.decidedAt && (
                <p className="text-[13px] text-muted">
                  {STATUS[r.status].label} {formatDateTime(r.decidedAt)}
                  {r.decidedByName ? ` by ${r.decidedByName}` : ''}
                  {r.decisionNote ? ` · ${r.decisionNote}` : ''}
                </p>
              )}
              {r.status === 'PENDING' && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => onDecide(r.id, 'approve')} aria-label={`Approve ${r.whoName}’s ${r.field}`}>
                    <CircleCheck /> Approve
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => onDecide(r.id, 'reject')} aria-label={`Reject ${r.whoName}’s ${r.field}`}>
                    <CircleX /> Reject
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Approve (note optional) or Reject (note required, shown to whoever asked). */
export function DecideRequestDialog({
  mode,
  title,
  approveText,
  rejectText,
  rejectHint,
  rejectNeedsNote,
  onDecide,
  onClose,
}: {
  mode: 'approve' | 'reject';
  title: string;
  approveText: ReactNode;
  rejectText: string;
  rejectHint: string;
  /** The message when Reject is pressed with no note. */
  rejectNeedsNote: string;
  onDecide: (body: { note?: string }) => Promise<unknown>;
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const approve = mode === 'approve';
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone={approve ? 'default' : 'danger'}
      icon={approve ? <CircleCheck className="size-5" /> : <CircleX className="size-5" />}
      title={title}
      description={approve ? approveText : rejectText}
      confirmLabel={approve ? 'Approve' : 'Reject'}
      loadingLabel={approve ? 'Approving…' : 'Rejecting…'}
      onConfirm={async () => {
        if (!approve && !note.trim()) throw new FormProblem(rejectNeedsNote);
        await onDecide(note.trim() ? { note: note.trim() } : {});
      }}
    >
      {approve ? (
        <TextField label="Note" hint="Optional." value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      ) : (
        <TextareaField label="Note" required hint={rejectHint} value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      )}
    </ConfirmDialog>
  );
}
