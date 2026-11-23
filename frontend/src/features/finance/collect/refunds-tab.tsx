import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { RefundDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Pager } from '@/components/sv/pager';
import { ApprovalBanner } from '@/components/finance/approval-banner';
import { ImpactPreview } from '@/components/finance/impact-preview';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useBankAccounts, useCashAccounts, useFinanceMutation, useStudentAccount } from '../api';
import { ErrorBanner } from '../error-banner';
import { REFUNDS_INTRO } from '../help-copy';
import { collectApi, useRefundable, useRefunds } from '../ops-api';
import { StudentPicker, type PickedStudent } from '../student-picker';
import { todayLocal } from './shared';

const STATE_LABEL: Record<string, string> = { ELIGIBLE: 'Waiting for Approval', REQUESTED: 'Requested', APPROVED: 'Approved · Not Paid Yet', PAID: 'Paid', REJECTED: 'Rejected' };

/** New Refund: the refundable amount and why first, then the amount and reason, then a preview. Opened here or from a student's account. */
export function RefundDrawer({ open, onClose, studentId }: { open: boolean; onClose: () => void; studentId?: string }) {
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title="New refund" description="Give back money the school holds for a student.">
        {open && <RefundForm onClose={onClose} studentId={studentId} />}
      </DrawerContent>
    </Drawer>
  );
}

function RefundForm({ onClose, studentId }: { onClose: () => void; studentId?: string }) {
  const preset = useStudentAccount(studentId);
  const [picked, setPicked] = useState<PickedStudent | null>(null);
  const student = picked ?? (preset.data ? { studentId: preset.data.studentId, studentName: preset.data.studentName, admissionNumber: preset.data.admissionNumber, className: preset.data.className } : null);
  const refundable = useRefundable(student?.studentId);
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [saved, setSaved] = useState<RefundDTO | null>(null);
  const save = useFinanceMutation((body: Record<string, unknown>) => collectApi.createRefund(body), { quiet: true });
  const max = refundable.data?.refundablePaise ?? 0;
  const tooMuch = amount !== null && amount > max;

  if (saved)
    return (
      <>
        <DrawerBody className="space-y-3">
          <ApprovalBanner approval={{ summary: `Refund ${saved.number} of ${formatMoney(saved.amountPaise)} for ${saved.studentName}.`, requestedByName: saved.requestedByName, decision: 'PENDING', decisionReason: null }} />
          <p className="text-sm">After a different person approves it, record the payment here once the money has left the bank. Approving is not paying.</p>
        </DrawerBody>
        <DrawerFooter>
          <Button onClick={onClose}>Done</Button>
        </DrawerFooter>
      </>
    );

  return (
    <>
      <DrawerBody className="space-y-4">
        {!studentId && <StudentPicker value={picked} onChange={setPicked} label="Which student?" />}
        {studentId && student && (
          <p className="rounded-xl bg-canvas px-4 py-3 text-sm">
            <b>{student.studentName}</b> · {student.className ?? 'No class'}
          </p>
        )}
        {student && refundable.isLoading && <Skeleton className="h-16" />}
        {refundable.data && (
          <Alert tone={max > 0 ? 'info' : 'warning'} title={`Can refund up to ${formatMoney(max)}`}>
            {refundable.data.sentence}
          </Alert>
        )}
        {refundable.data && max > 0 && (
          <>
            <MoneyField label="Amount to refund" required value={amount} onChange={setAmount} error={tooMuch ? `At most ${formatMoney(max)}.` : undefined} />
            <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Student left; return the unused advance." maxLength={300} />
            {amount !== null && amount > 0 && !tooMuch && (
              <ImpactPreview
                lines={[
                  { label: 'Refund', value: formatMoney(amount) },
                  { label: 'Still held for the student', value: formatMoney(max - amount) },
                ]}
                note="Nothing leaves the bank now. A different person approves it, then someone records the payment."
              />
            )}
          </>
        )}
        {save.error && <ErrorBanner error={save.error} />}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={!student || !amount || tooMuch || !reason.trim()}
          loading={save.isPending}
          loadingText="Saving…"
          onClick={() => save.mutate({ studentId: student!.studentId, amountPaise: amount, reason: reason.trim() }, { onSuccess: setSaved })}
        >
          Ask For Refund
        </Button>
      </DrawerFooter>
    </>
  );
}

/** Record Payment: the money really left. Needs the account it left from and the bank reference. */
function DisburseDialog({ refund, onClose }: { refund: RefundDTO; onClose: () => void }) {
  const banks = useBankAccounts();
  const cash = useCashAccounts();
  const [from, setFrom] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [note, setNote] = useState('');
  const run = useFinanceMutation((body: Record<string, unknown>) => collectApi.disburseRefund(refund.refundId, body), { success: `Refund ${refund.number} is recorded as paid.` });
  const [kind, id] = from.split(':') as ['bank' | 'cash' | '', string];
  const options = [
    ...(banks.data ?? []).filter((b) => b.status === 'ACTIVE').map((b) => ({ value: `bank:${b.bankAccountId}`, label: b.label, hint: b.accountNumberMasked })),
    ...(cash.data ?? []).filter((c) => c.status === 'ACTIVE').map((c) => ({ value: `cash:${c.cashAccountId}`, label: c.label, hint: 'cash' })),
  ];
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Record refund ${refund.number} as paid`}
      description={`${formatMoney(refund.amountPaise)} to ${refund.recipientName ?? refund.studentName}. Do this only after the money has left the bank.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!from || (kind === 'bank' && !reference.trim())}
            loading={run.isPending}
            loadingText="Saving…"
            onClick={() =>
              run.mutate(
                { ...(kind === 'bank' ? { bankAccountId: id, reference: reference.trim() } : { cashAccountId: id }), paidOn, ...(note.trim() ? { evidenceNote: note.trim() } : {}) },
                { onSuccess: onClose },
              )
            }
          >
            Record Payment
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ComboboxField label="Paid from" required value={from} onChange={setFrom} placeholder="Choose…" searchPlaceholder="Search accounts…" options={options} />
        {kind === 'bank' && <TextField label="Bank reference (UTR)" required value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />}
        <TextField label="Paid on" type="date" required value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} />
        <TextareaField label="Proof note" value={note} onChange={(e) => setNote(e.target.value)} hint="Optional. Example: NEFT screenshot saved in the office file." maxLength={300} />
        {run.error && <ErrorBanner error={run.error} />}
      </div>
    </Modal>
  );
}

const FILTERS = [
  { id: '', label: 'All' },
  { id: 'ELIGIBLE', label: 'Waiting for Approval' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'PAID', label: 'Paid' },
  { id: 'REJECTED', label: 'Rejected' },
] as const;

export function RefundsTab() {
  const { can } = useAuth();
  const [state, setState] = useState('');
  const [page, setPage] = useState(1);
  const list = useRefunds({ state: state || undefined, page });
  const [newOpen, setNewOpen] = useState(false);
  const [paying, setPaying] = useState<RefundDTO | null>(null);
  const [rejecting, setRejecting] = useState<RefundDTO | null>(null);
  const [reason, setReason] = useState('');
  const approve = useFinanceMutation((id: string) => collectApi.approveRefund(id), { success: 'Approved. Now pay it from the bank, then record the payment.' });
  const reject = useFinanceMutation((v: { id: string; reason: string }) => collectApi.rejectRefund(v.id, v.reason), { success: 'Refund rejected.' });
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  return (
    <div className="space-y-4">
      <TabIntro title="Refunds">{REFUNDS_INTRO}</TabIntro>
      <div className="flex flex-wrap items-center gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={state === f.id}
            onClick={() => {
              setState(f.id);
              setPage(1);
            }}
            className={cn('rounded-lg border px-3 py-1.5 text-sm font-semibold', state === f.id ? 'border-brand bg-brand text-white' : 'border-line bg-white hover:border-brand/40')}
          >
            {f.label}
          </button>
        ))}
        <Can permission="finance:refund:request">
          <Button size="sm" className="ml-auto" onClick={() => setNewOpen(true)}>
            <Plus /> New Refund
          </Button>
        </Can>
      </div>
      {list.isLoading && <Skeleton className="h-32" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      {list.data && list.data.items.length === 0 && <EmptyState title="No refunds" description="A refund gives back an unused advance or a refundable deposit." />}
      {list.data && list.data.items.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white" aria-label="Refunds">
          {list.data.items.map((r) => (
            <li key={r.refundId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <b>{r.number}</b>
              <Money paise={r.amountPaise} strong />
              <span className="text-muted">
                {r.studentName} · {r.reason}
                {r.requestedByName ? ` · asked by ${r.requestedByName}` : ''}
                {r.paidOn ? ` · paid ${formatDateOnly(r.paidOn)}${r.paidReference ? ` (${r.paidReference})` : ''}` : ''}
              </span>
              <FinanceStatusPill status={r.state === 'ELIGIBLE' ? 'PENDING' : r.state === 'APPROVED' ? 'RECORDED' : r.state} label={STATE_LABEL[r.state]} />
              <span className="ml-auto flex gap-2">
                {(r.state === 'ELIGIBLE' || r.state === 'REQUESTED') && can('finance:refund:approve') && (
                  <>
                    <Button size="sm" loading={approve.isPending && approve.variables === r.refundId} loadingText="Approving…" onClick={() => approve.mutate(r.refundId)} aria-label={`Approve refund ${r.number}`}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRejecting(r)} aria-label={`Reject refund ${r.number}`}>
                      Reject
                    </Button>
                  </>
                )}
                {r.state === 'APPROVED' && can('finance:refund:disburse') && (
                  <Button size="sm" onClick={() => setPaying(r)} aria-label={`Record payment for refund ${r.number}`}>
                    Record Payment
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
      <RefundDrawer open={newOpen} onClose={() => setNewOpen(false)} />
      {paying && <DisburseDialog refund={paying} onClose={() => setPaying(null)} />}
      {rejecting && (
        <Modal
          open
          onOpenChange={(o) => !o && setRejecting(null)}
          title={`Reject refund ${rejecting.number}`}
          description="The money stays held for the student."
          footer={
            <>
              <Button variant="outline" onClick={() => setRejecting(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={!reason.trim()}
                loading={reject.isPending}
                loadingText="Rejecting…"
                onClick={() =>
                  reject.mutate(
                    { id: rejecting.refundId, reason: reason.trim() },
                    {
                      onSuccess: () => {
                        setRejecting(null);
                        setReason('');
                      },
                    },
                  )
                }
              >
                Reject
              </Button>
            </>
          }
        >
          <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </Modal>
      )}
    </div>
  );
}
