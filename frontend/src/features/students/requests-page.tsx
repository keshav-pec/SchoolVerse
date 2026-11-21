import { useState } from 'react';
import { Link } from 'react-router';
import type { ChangeRequestStatus, StudentChangeRequestDTO } from '@shared';
import { ArrowRight, CircleCheck, CircleX, Inbox } from 'lucide-react';
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
import { RequestStatusBadge } from '../people/requests-page';
import { useStudentMutation } from './api';
import { REQUESTS_INTRO } from './help-copy';
import { usePendingStudentRequests, useStudentChangeRequests } from './lifecycle-api';

const FILTERS: { value: ChangeRequestStatus; label: string }[] = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'CANCELLED', label: 'Cancelled' },
];

function Decide({ request, mode, onClose }: { request: StudentChangeRequestDTO; mode: 'approve' | 'reject'; onClose: () => void }) {
  const [note, setNote] = useState('');
  const decide = useStudentMutation((body: object) => api.post(`/student-change-requests/${request.changeRequestId}/${mode}`, body), {
    quiet: true,
    success: mode === 'approve' ? `${request.fieldLabel} updated for ${request.studentName}.` : 'Request rejected. The parent will see your note.',
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone={mode === 'reject' ? 'danger' : 'default'}
      icon={mode === 'approve' ? <CircleCheck className="size-5" /> : <CircleX className="size-5" />}
      title={mode === 'approve' ? `Approve ${request.requestedByName}’s request?` : `Reject ${request.requestedByName}’s request?`}
      description={
        mode === 'approve' ? (
          <>
            {request.fieldLabel} for {request.studentName} will change to <strong className="text-ink">{request.newValue}</strong> straight away.
          </>
        ) : (
          'Nothing changes. The parent sees your note.'
        )
      }
      confirmLabel={mode === 'approve' ? 'Approve' : 'Reject'}
      loadingLabel={mode === 'approve' ? 'Approving…' : 'Rejecting…'}
      onConfirm={async () => {
        if (mode === 'reject' && !note.trim()) throw new FormProblem('Say why, so the parent knows what to do.');
        await decide.mutateAsync(note.trim() ? { note: note.trim() } : {});
      }}
    >
      {mode === 'reject' ? (
        <TextareaField label="Note" required hint="Shown to the parent. Example: Please bring the birth certificate to the office." value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      ) : (
        <TextField label="Note" hint="Optional." value={note} onChange={(e) => setNote(e.target.value)} maxLength={300} />
      )}
    </ConfirmDialog>
  );
}

/** `/students/requests`: changes parents asked for (legal name, date of birth, their own contact). Values are masked. */
export function StudentRequestsPage() {
  const [status, setStatus] = useState<ChangeRequestStatus>('PENDING');
  const q = useStudentChangeRequests(status);
  const pending = usePendingStudentRequests(true);
  const [deciding, setDeciding] = useState<{ request: StudentChangeRequestDTO; mode: 'approve' | 'reject' } | null>(null);
  const items = q.data?.items ?? [];

  return (
    <>
      <PageHeader eyebrow="Students" title="Parent requests" description="Parents ask here to correct details they can’t edit themselves." />
      <TabIntro title="About parent requests" className="mb-4">
        {REQUESTS_INTRO}
      </TabIntro>
      <div role="tablist" aria-label="Request status" className="mb-4 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            role="tab"
            aria-selected={status === f.value}
            type="button"
            onClick={() => setStatus(f.value)}
            className={cn('rounded-pill border px-4 py-2 text-sm font-semibold', status === f.value ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-white text-muted hover:text-ink')}
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
            description={status === 'PENDING' ? 'When a parent asks to correct a name, a date of birth or their phone number, it shows up here.' : undefined}
          />
        ) : (
          <ul className="divide-y divide-line" aria-label="Change requests">
            {items.map((r) => (
              <li key={r.changeRequestId} className="space-y-3 p-4 sm:p-5">
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">
                      <Link to={`/students/${r.studentId}`} className="hover:text-brand hover:underline">
                        {r.studentName}
                      </Link>
                      <span className="font-normal text-muted"> · asked by {r.requestedByName}</span>
                    </p>
                    <p className="text-[13px] text-muted">
                      {r.fieldLabel} · asked {formatDateTime(r.createdAt)}
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
                    {r.status === 'APPROVED' ? 'Approved' : r.status === 'REJECTED' ? 'Rejected' : 'Cancelled'} {formatDateTime(r.decidedAt)}
                    {r.decidedByName ? ` by ${r.decidedByName}` : ''}
                    {r.decisionNote ? ` · ${r.decisionNote}` : ''}
                  </p>
                )}
                {r.status === 'PENDING' && (
                  <div className="flex flex-wrap gap-2">
                    <Button size="sm" onClick={() => setDeciding({ request: r, mode: 'approve' })} aria-label={`Approve ${r.studentName}’s ${r.fieldLabel}`}>
                      <CircleCheck /> Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeciding({ request: r, mode: 'reject' })} aria-label={`Reject ${r.studentName}’s ${r.fieldLabel}`}>
                      <CircleX /> Reject
                    </Button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {deciding && <Decide request={deciding.request} mode={deciding.mode} onClose={() => setDeciding(null)} />}
    </>
  );
}
