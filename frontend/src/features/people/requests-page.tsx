import { useState } from 'react';
import { Link } from 'react-router';
import { CHANGE_FIELD_LABELS, type ChangeRequestStatus, type ProfileChangeRequestDTO } from '@shared';
import { DecideRequestDialog, RequestList, RequestStatusTabs } from '@/components/sv/change-requests';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { useChangeRequests, usePendingRequestCount, usePeopleMutation } from './api';

function Decide({ request, mode, onClose }: { request: ProfileChangeRequestDTO; mode: 'approve' | 'reject'; onClose: () => void }) {
  const field = CHANGE_FIELD_LABELS[request.fieldCategory];
  const decide = usePeopleMutation((body: object) => api.post(`/profile-change-requests/${request.changeRequestId}/${mode}`, body), {
    quiet: true,
    success: mode === 'approve' ? `${field} updated for ${request.employeeName}.` : 'Request rejected.',
  });
  return (
    <DecideRequestDialog
      mode={mode}
      title={`${mode === 'approve' ? 'Approve' : 'Reject'} ${request.employeeName}’s change?`}
      approveText={
        <>
          {field} will change to <strong className="text-ink">{request.proposedDisplay}</strong> straight away.
        </>
      }
      rejectText="Nothing changes. They will see your note."
      rejectHint="Shown to the employee."
      rejectNeedsNote="Say why, so they know what to fix."
      onDecide={(body) => decide.mutateAsync(body)}
      onClose={onClose}
    />
  );
}

/** `/people/requests`: changes to legal name, date of birth, IDs and bank details wait here for a decision. Values are masked. */
export function RequestsPage() {
  const [status, setStatus] = useState<ChangeRequestStatus>('PENDING');
  const q = useChangeRequests(status);
  const pending = usePendingRequestCount(true);
  const [deciding, setDeciding] = useState<{ request: ProfileChangeRequestDTO; mode: 'approve' | 'reject' } | null>(null);
  const items = q.data ?? [];

  return (
    <>
      <PageHeader eyebrow="People" title="Change requests" description="Staff ask here to change details they can’t edit themselves." />
      <TabIntro title="Change requests" className="mb-4">
        <p>Staff can’t change their legal name, date of birth, IDs or bank details on their own. They send a request, and it waits here for you.</p>
        <p>
          <b>Approve</b> updates their record straight away. <b>Reject</b> changes nothing; write a short note so they know what to fix. IDs and bank numbers show only the last few digits.
        </p>
      </TabIntro>
      <RequestStatusTabs status={status} onChange={setStatus} pending={pending.data} />
      <RequestList
        query={q}
        status={status}
        emptyPending="When someone asks to change their legal name, date of birth, ID or bank details, it shows up here."
        onDecide={(id, mode) => setDeciding({ request: items.find((r) => r.changeRequestId === id)!, mode })}
        items={items.map((r) => ({
          id: r.changeRequestId,
          who: (
            <>
              <Link to={`/people/${r.employeeId}`} className="hover:text-brand hover:underline">
                {r.employeeName}
              </Link>{' '}
              <span className="font-mono text-xs text-muted">{r.employeeCode}</span>
            </>
          ),
          whoName: r.employeeName,
          field: CHANGE_FIELD_LABELS[r.fieldCategory],
          askedAt: r.requestedAt,
          oldValue: r.currentDisplay,
          newValue: r.proposedDisplay,
          reason: r.reason,
          status: r.status,
          decidedAt: r.decidedAt,
          decidedByName: r.decidedByName,
          decisionNote: r.decisionNote,
        }))}
      />
      {deciding && <Decide request={deciding.request} mode={deciding.mode} onClose={() => setDeciding(null)} />}
    </>
  );
}
