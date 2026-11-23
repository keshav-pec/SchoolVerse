import { Hourglass } from 'lucide-react';
import type { ApprovalRequestDTO } from '@shared';
import { Alert } from '@/components/ui/alert';

/** "Waiting for an approver": shown when a change cannot go ahead until a different person says yes. */
export function ApprovalBanner({ approval, className }: { approval: Pick<ApprovalRequestDTO, 'summary' | 'requestedByName' | 'decision' | 'decisionReason'>; className?: string }) {
  if (approval.decision === 'REJECTED')
    return (
      <Alert tone="danger" title="This was not approved" className={className}>
        {approval.decisionReason ? `Reason: ${approval.decisionReason}` : approval.summary}
      </Alert>
    );
  if (approval.decision === 'APPROVED')
    return (
      <Alert tone="success" title="Approved. You can go ahead now." className={className}>
        {approval.summary}
      </Alert>
    );
  return (
    <Alert tone="warning" title="Waiting for an approver" className={className}>
      <span className="flex items-start gap-1.5">
        <Hourglass className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {approval.summary}
          {approval.requestedByName ? ` Asked by ${approval.requestedByName}.` : ''} A different person with approval rights must say yes first.
        </span>
      </span>
    </Alert>
  );
}
