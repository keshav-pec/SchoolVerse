import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import type { ApprovalPolicyDTO, ApprovalRequestDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ComboboxField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Pager } from '@/components/sv/pager';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { financeApi, useApprovalPolicies, useApprovals, useFinanceMutation } from '../api';
import { APPROVAL_ACTION_LABELS, APPROVALS_INTRO } from '../help-copy';

/** Approvals: the rules (when a second person must say yes) and the requests waiting for a decision. */
export function ApprovalsTab() {
  const [decision, setDecision] = useState<'PENDING' | ''>('PENDING');
  const [page, setPage] = useState(1);
  const list = useApprovals({ decision: decision || undefined, page });
  const policies = useApprovalPolicies();
  const [deciding, setDeciding] = useState<{ request: ApprovalRequestDTO; verdict: 'APPROVE' | 'REJECT' } | null>(null);
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.pageSize ?? 25)));

  return (
    <div className="space-y-4">
      <TabIntro title="Approvals" need="required">
        {APPROVALS_INTRO}
      </TabIntro>

      <Card aria-label="Requests">
        <CardHeader>
          <HelpHeading title="Requests" help={<p>A request keeps what was asked, what it would change in rupees, and why. Approving lets the change happen once. The person who asked usually cannot approve their own request.</p>} />
          <ComboboxField
            label="Show"
            containerClassName="w-48"
            value={decision}
            onChange={(v) => {
              setDecision(v as typeof decision);
              setPage(1);
            }}
            options={[
              { value: 'PENDING', label: 'Waiting for a decision' },
              { value: '', label: 'All requests' },
            ]}
            searchPlaceholder="Search…"
          />
        </CardHeader>
        {list.isLoading && <Skeleton className="h-24" role="status" aria-label="Loading" />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
        {list.data?.items.length === 0 && (
          <p className="flex items-center gap-2 text-sm text-muted">
            <CircleCheck className="size-4 text-success" aria-hidden="true" /> {decision === 'PENDING' ? 'Nothing is waiting for a decision.' : 'No requests yet.'}
          </p>
        )}
        <ul className="divide-y divide-line" aria-label="Approval requests">
          {list.data?.items.map((r) => (
            <li key={r.approvalId} className="space-y-1 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <b>{APPROVAL_ACTION_LABELS[r.action] ?? r.action}</b>
                <FinanceStatusPill status={r.decision} />
                {r.amountPaise > 0 && <Money paise={r.amountPaise} strong />}
                <span className="ml-auto text-[13px] text-muted">
                  {r.requestedByName ?? 'Someone'} · {formatDateTime(r.createdAt)}
                </span>
              </div>
              <p>{r.summary}</p>
              {r.impact && <p className="rounded-lg bg-brand-soft/60 px-3 py-1.5 text-[13px]">What will change: {r.impact}</p>}
              {r.reason && <p className="text-[13px] text-muted">Reason: {r.reason}</p>}
              {r.decision !== 'PENDING' && r.decidedByName && (
                <p className="text-[13px] text-muted">
                  Decided by {r.decidedByName}
                  {r.decisionReason ? `: ${r.decisionReason}` : ''}
                </p>
              )}
              {r.decision === 'PENDING' && (
                <Can permission="finance:view">
                  <div className="flex gap-2 pt-1">
                    <Button size="sm" onClick={() => setDeciding({ request: r, verdict: 'APPROVE' })} aria-label={`Approve: ${r.summary}`}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setDeciding({ request: r, verdict: 'REJECT' })} aria-label={`Reject: ${r.summary}`}>
                      Reject
                    </Button>
                  </div>
                </Can>
              )}
            </li>
          ))}
        </ul>
        {pages > 1 && (
          <div className="mt-3 flex justify-end">
            <Pager page={page} pages={pages} onPage={setPage} />
          </div>
        )}
      </Card>

      <Card aria-label="Approval rules">
        <CardHeader>
          <HelpHeading title="Rules" help={<p>For each kind of change, choose the amount above which a second person must approve. Leave the amount empty to ask for approval every time.</p>} />
        </CardHeader>
        {policies.isLoading && <Skeleton className="h-24" />}
        {policies.isError && <ErrorState error={policies.error} onRetry={() => void policies.refetch()} retrying={policies.isFetching} />}
        {policies.data?.length === 0 && <Alert tone="info">No rules yet. Press “Use The Standard Chart” in Chart of Accounts, or use the standard setup from the Setup Checklist, to add the default rules.</Alert>}
        <ul className="divide-y divide-line" aria-label="Rules">
          {policies.data?.map((p) => (
            <PolicyRow key={`${p.policyId}-${p.thresholdPaise}-${p.needsDifferentApprover}-${p.enabled}`} policy={p} />
          ))}
        </ul>
      </Card>

      <DecideDialog target={deciding} onClose={() => setDeciding(null)} />
    </div>
  );
}

function PolicyRow({ policy }: { policy: ApprovalPolicyDTO }) {
  const { can } = useAuth();
  const [threshold, setThreshold] = useState<number | null>(policy.thresholdPaise);
  const [different, setDifferent] = useState(policy.needsDifferentApprover);
  const [enabled, setEnabled] = useState(policy.enabled);
  const [confirm, setConfirm] = useState(false);
  const save = useFinanceMutation((v: { reason?: string }) => financeApi.updatePolicy(policy.policyId, { thresholdPaise: threshold, needsDifferentApprover: different, enabled, ...(v.reason ? { reason: v.reason } : {}) }), { success: 'Rule saved.', quiet: true });
  const [reason, setReason] = useState('');
  const dirty = threshold !== policy.thresholdPaise || different !== policy.needsDifferentApprover || enabled !== policy.enabled;
  const weaker = (!different && policy.needsDifferentApprover) || (!enabled && policy.enabled);
  const editable = can('finance:setup:manage');
  return (
    <li className="space-y-2 py-3 text-sm">
      <p className="flex flex-wrap items-center gap-2">
        <b>{APPROVAL_ACTION_LABELS[policy.action] ?? policy.action}</b>
        <span className="text-muted">{policy.description}</span>
      </p>
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        <MoneyField label="Ask for approval above" value={threshold} onChange={setThreshold} disabled={!editable} hint={threshold === null ? 'Empty means every time.' : undefined} containerClassName="w-52" />
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={different} onChange={(e) => setDifferent(e.target.checked)} disabled={!editable} /> Needs a different person
          <InfoTip label="About a different person">
            <p>When this is on, the person who asked cannot approve their own request. Turning it off is written in the record.</p>
          </InfoTip>
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} disabled={!editable} /> Rule is on
        </label>
        {editable && (
          <Button size="sm" className="mb-1.5" disabled={!dirty} loading={save.isPending} loadingText="Saving…" onClick={() => (weaker ? setConfirm(true) : save.mutate({}))} aria-label={`Save rule for ${APPROVAL_ACTION_LABELS[policy.action] ?? policy.action}`}>
            Save Rule
          </Button>
        )}
      </div>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title="Make this rule weaker?"
        description="Fewer checks means a mistake or misuse is easier. This change is written in the school’s record with your name."
        confirmLabel="Save Anyway"
        loadingLabel="Saving…"
        tone="danger"
        onConfirm={async () => {
          await save.mutateAsync({ reason: reason.trim() || undefined });
        }}
      >
        <TextareaField label="Why?" value={reason} onChange={(e) => setReason(e.target.value)} hint="Optional, but please write it down." maxLength={300} />
      </ConfirmDialog>
    </li>
  );
}

function DecideDialog({ target, onClose }: { target: { request: ApprovalRequestDTO; verdict: 'APPROVE' | 'REJECT' } | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const decide = useFinanceMutation((v: { id: string; verdict: 'APPROVE' | 'REJECT'; reason: string }) => financeApi.decideApproval(v.id, { decision: v.verdict, ...(v.reason ? { reason: v.reason } : {}) }), { quiet: true });
  const approve = target?.verdict === 'APPROVE';
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          onClose();
        }
      }}
      title={approve ? 'Approve this request?' : 'Reject this request?'}
      description={target ? `${target.request.summary}${target.request.impact ? ` ${target.request.impact}` : ''}` : ''}
      confirmLabel={approve ? 'Approve' : 'Reject'}
      loadingLabel="Saving…"
      tone={approve ? 'default' : 'danger'}
      onConfirm={async () => {
        await decide.mutateAsync({ id: target!.request.approvalId, verdict: target!.verdict, reason: reason.trim() });
        setReason('');
      }}
    >
      <TextareaField label="Note" value={reason} onChange={(e) => setReason(e.target.value)} hint={approve ? 'Optional.' : 'Optional. The person who asked will see it.'} maxLength={300} />
    </ConfirmDialog>
  );
}
