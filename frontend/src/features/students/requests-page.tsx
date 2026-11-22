import { useState } from 'react';
import { Link } from 'react-router';
import type { ChangeRequestStatus, StudentChangeRequestDTO } from '@shared';
import { DecideRequestDialog, RequestList, RequestStatusTabs } from '@/components/sv/change-requests';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { useStudentMutation } from './api';
import { REQUESTS_INTRO } from './help-copy';
import { usePendingStudentRequests, useStudentChangeRequests } from './lifecycle-api';

function Decide({ request, mode, onClose }: { request: StudentChangeRequestDTO; mode: 'approve' | 'reject'; onClose: () => void }) {
  const decide = useStudentMutation((body: object) => api.post(`/student-change-requests/${request.changeRequestId}/${mode}`, body), {
    quiet: true,
    success: mode === 'approve' ? `${request.fieldLabel} updated for ${request.studentName}.` : 'Request rejected. The parent will see your note.',
  });
  return (
    <DecideRequestDialog
      mode={mode}
      title={`${mode === 'approve' ? 'Approve' : 'Reject'} ${request.requestedByName}’s request?`}
      approveText={
        <>
          {request.fieldLabel} for {request.studentName} will change to <strong className="text-ink">{request.newValue}</strong> straight away.
        </>
      }
      rejectText="Nothing changes. The parent sees your note."
      rejectHint="Shown to the parent. Example: Please bring the birth certificate to the office."
      rejectNeedsNote="Say why, so the parent knows what to do."
      onDecide={(body) => decide.mutateAsync(body)}
      onClose={onClose}
    />
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
      <RequestStatusTabs status={status} onChange={setStatus} pending={pending.data} />
      <RequestList
        query={q}
        status={status}
        emptyPending="When a parent asks to correct a name, a date of birth or their phone number, it shows up here."
        onDecide={(id, mode) => setDeciding({ request: items.find((r) => r.changeRequestId === id)!, mode })}
        items={items.map((r) => ({
          id: r.changeRequestId,
          who: (
            <>
              <Link to={`/students/${r.studentId}`} className="hover:text-brand hover:underline">
                {r.studentName}
              </Link>
              <span className="font-normal text-muted"> · asked by {r.requestedByName}</span>
            </>
          ),
          whoName: r.studentName,
          field: r.fieldLabel,
          askedAt: r.createdAt,
          oldValue: r.oldValue,
          newValue: r.newValue,
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
