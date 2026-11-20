import { useState } from 'react';
import { Link } from 'react-router';
import {
  CHANGE_FIELD_LABELS,
  type ChangeRequestStatus,
  type ProfileChangeRequestDTO,
} from '@shared';
import { ArrowRight, CircleCheck, CircleX, Inbox } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextareaField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useChangeRequests, usePendingRequestCount, usePeopleMutation } from './api';

const FILTERS: { value: ChangeRequestStatus; label: string }[] = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

export function RequestStatusBadge({ status }: { status: ChangeRequestStatus }) {
  const tone =
    status === 'PENDING'
      ? 'warning'
      : status === 'APPROVED'
        ? 'success'
        : status === 'REJECTED'
          ? 'danger'
          : 'neutral';
  const label = {
    PENDING: 'Pending',
    APPROVED: 'Approved',
    REJECTED: 'Rejected',
    CANCELLED: 'Cancelled',
  }[status];
  return (
    <Badge tone={tone} data-status={status}>
      {label}
    </Badge>
  );
}

function Decide({
  request,
  mode,
  onClose,
}: {
  request: ProfileChangeRequestDTO;
  mode: 'approve' | 'reject';
  onClose: () => void;
}) {
  const [note, setNote] = useState('');
  const decide = usePeopleMutation(
    (body: object) => api.post(`/profile-change-requests/${request.changeRequestId}/${mode}`, body),
    {
      quiet: true,
      success:
        mode === 'approve'
          ? `${CHANGE_FIELD_LABELS[request.fieldCategory]} updated for ${request.employeeName}.`
          : 'Request rejected.',
    },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone={mode === 'reject' ? 'danger' : 'default'}
      icon={
        mode === 'approve' ? <CircleCheck className="size-5" /> : <CircleX className="size-5" />
      }
      title={
        mode === 'approve'
          ? `Approve ${request.employeeName}’s change?`
          : `Reject ${request.employeeName}’s change?`
      }
      description={
        mode === 'approve' ? (
          <>
            {CHANGE_FIELD_LABELS[request.fieldCategory]} will change to{' '}
            <strong className="text-ink">{request.proposedDisplay}</strong> straight away.
          </>
        ) : (
          'Nothing changes. They will see your note.'
        )
      }
      confirmLabel={mode === 'approve' ? 'Approve' : 'Reject'}
      loadingLabel={mode === 'approve' ? 'Approving…' : 'Rejecting…'}
      onConfirm={async () => {
        if (mode === 'reject' && !note.trim())
          throw new FormProblem('Say why, so they know what to fix.');
        await decide.mutateAsync(note.trim() ? { note: note.trim() } : {});
      }}
    >
      {mode === 'reject' ? (
        <TextareaField
          label="Note"
          required
          hint="Shown to the employee."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
        />
      ) : (
        <TextField
          label="Note"
          hint="Optional."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={300}
        />
      )}
    </ConfirmDialog>
  );
}

/** `/people/requests`: changes to legal name, date of birth, IDs and bank details wait here for a decision. Values are masked. */
export function RequestsPage() {
  const [status, setStatus] = useState<ChangeRequestStatus>('PENDING');
  const q = useChangeRequests(status);
  const pending = usePendingRequestCount(true);
  const [deciding, setDeciding] = useState<{
    request: ProfileChangeRequestDTO;
    mode: 'approve' | 'reject';
  } | null>(null);
  const items = q.data ?? [];

  return (
    <>
      <PageHeader
        eyebrow="People"
        title="Change requests"
        description="Staff ask here to change details they can’t edit themselves."
      />
      <TabIntro title="Change requests" className="mb-4">
        <p>
          Staff can’t change their legal name, date of birth, IDs or bank details on their own. They
          send a request, and it waits here for you.
        </p>
        <p>
          <b>Approve</b> updates their record straight away. <b>Reject</b> changes nothing; write a
          short note so they know what to fix. IDs and bank numbers show only the last few digits.
        </p>
      </TabIntro>
      <div role="tablist" aria-label="Request status" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={status === f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            className={cn(
              'rounded-pill border px-4 py-2 text-sm font-semibold',
              status === f.value
                ? 'border-brand bg-brand-soft text-brand'
                : 'border-line bg-white text-muted hover:text-ink',
            )}
          >
            {f.label}
            {f.value === 'PENDING' && (pending.data ?? 0) > 0 ? ` (${pending.data})` : ''}
          </button>
        ))}
      </div>
      <Card className="p-0">
        {q.isLoading ? (
          <div role="status" aria-label="Loading requests" className="space-y-3 p-4">
            <Skeleton className="h-20" />
            <Skeleton className="h-20" />
          </div>
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : items.length === 0 ? (
          <EmptyState
            illustration={<Inbox className="size-12 text-muted" aria-hidden="true" />}
            title={status === 'PENDING' ? 'Nothing waiting' : 'Nothing here'}
            description={
              status === 'PENDING'
                ? 'When someone asks to change their legal name, date of birth, ID or bank details, it shows up here.'
                : undefined
            }
          />
        ) : (
          <ul className="divide-y divide-line" aria-label="Change requests">
            {items.map((r) => (
              <li key={r.changeRequestId} className="space-y-3 p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      <Link
                        to={`/people/${r.employeeId}`}
                        className="hover:text-brand hover:underline"
                      >
                        {r.employeeName}
                      </Link>{' '}
                      <span className="font-mono text-xs text-muted">{r.employeeCode}</span>
                    </p>
                    <p className="text-[13px] text-muted">
                      {CHANGE_FIELD_LABELS[r.fieldCategory]} · asked {formatDateTime(r.requestedAt)}
                    </p>
                  </div>
                  <RequestStatusBadge status={r.status} />
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="rounded bg-canvas px-2 py-1 text-muted">
                    {r.currentDisplay ?? 'Not on file'}
                  </span>
                  <ArrowRight className="size-4 text-muted" aria-label="change to" />
                  <span className="rounded bg-brand-soft px-2 py-1 font-semibold text-brand">
                    {r.proposedDisplay}
                  </span>
                </div>
                {r.reason && <p className="text-sm text-muted">“{r.reason}”</p>}
                {r.status !== 'PENDING' && r.decidedAt && (
                  <p className="text-[13px] text-muted">
                    {r.status === 'APPROVED'
                      ? 'Approved'
                      : r.status === 'REJECTED'
                        ? 'Rejected'
                        : 'Cancelled'}{' '}
                    {formatDateTime(r.decidedAt)}
                    {r.decidedByName ? ` by ${r.decidedByName}` : ''}
                    {r.decisionNote ? ` · ${r.decisionNote}` : ''}
                  </p>
                )}
                {r.status === 'PENDING' && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      onClick={() => setDeciding({ request: r, mode: 'approve' })}
                      aria-label={`Approve ${r.employeeName}’s ${CHANGE_FIELD_LABELS[r.fieldCategory]}`}
                    >
                      <CircleCheck /> Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => setDeciding({ request: r, mode: 'reject' })}
                      aria-label={`Reject ${r.employeeName}’s ${CHANGE_FIELD_LABELS[r.fieldCategory]}`}
                    >
                      <CircleX /> Reject
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {deciding && (
        <Decide request={deciding.request} mode={deciding.mode} onClose={() => setDeciding(null)} />
      )}
    </>
  );
}
