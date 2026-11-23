import { useState } from 'react';
import { Alert } from '@/components/ui/alert';
import { ApprovalBanner } from '@/components/finance/approval-banner';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/**
 * The "needs a second person" pattern, shared by every screen that may answer `APPROVAL_REQUIRED` (cancel a receipt, return a
 * cheque, ignore a bank line, close or reopen a month, a hand-made entry, a salary change). The first try creates the request and
 * the screen shows "Waiting for an approver". Once someone approves it in Settings > Approvals, the same button (now "… Again")
 * sends the approval id with the request and the change goes through.
 *
 *   const flow = useApprovalFlow();
 *   await flow.run((approvalId) => api.cancel(id, { reason, approvalId }));
 */
export function useApprovalFlow() {
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** Runs the change. Returns the result, or `null` when it is waiting for approval or failed (the banner or error says which). */
  async function run<R>(send: (approvalId: string | undefined) => Promise<R>): Promise<R | null> {
    setError(null);
    try {
      const result = await send(approvalId ?? undefined);
      setApprovalId(null);
      setMessage(null);
      return result;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') {
        const id = (e.details as { approvalId?: string } | undefined)?.approvalId ?? null;
        setApprovalId(id);
        setMessage(e.message);
      } else setError(messageFor(e));
      return null;
    }
  }

  const reset = () => {
    setApprovalId(null);
    setMessage(null);
    setError(null);
  };

  const banner = approvalId ? <ApprovalBanner approval={{ summary: message ?? 'This needs a second person to say yes.', requestedByName: null, decision: 'PENDING', decisionReason: null }} /> : null;
  /** The button word after the first try: "Cancel Receipt" becomes "Cancel Receipt Again" once the approver has decided. */
  const label = (base: string) => (approvalId ? `${base} Again` : base);
  const errorBox = error ? <Alert tone="danger">{error}</Alert> : null;
  return { approvalId, waiting: approvalId !== null, banner, error, errorBox, setError, run, reset, label };
}
