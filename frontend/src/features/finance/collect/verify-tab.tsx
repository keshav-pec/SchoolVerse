import { useState } from 'react';
import { Ban, CircleCheck, Image, Landmark, TriangleAlert, Zap } from 'lucide-react';
import { toast } from 'sonner';
import type { CollectionResultDTO, VerificationItemDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Money, MoneyField } from '@/components/finance/money';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { useBankAccounts, useFinanceMutation } from '../api';
import { ErrorBanner } from '../error-banner';
import { FLAG_LABELS, METHOD_LABELS, TIP_CLAIM_VS_COLLECTION, TIP_VERIFY, VERIFY_INTRO } from '../help-copy';
import { collectApi, openBlob, useVerificationQueue } from '../ops-api';
import { PaymentResultCard, todayLocal } from './shared';

const verifyCall = (item: VerificationItemDTO, body: Record<string, unknown>) => (item.kind === 'CLAIM' ? collectApi.verifyClaim(item.id, body) : collectApi.verify(item.id, body));
const rejectCall = (item: VerificationItemDTO, reason: string): Promise<unknown> => (item.kind === 'CLAIM' ? collectApi.rejectClaim(item.id, reason) : collectApi.reject(item.id, reason));

/** Verify (or Mismatch): the amount the person sees in the bank, the date, and the bank line when there is one. */
function VerifyDialog({ item, mismatch, onClose, onDone }: { item: VerificationItemDTO; mismatch: boolean; onClose: () => void; onDone: (r: CollectionResultDTO) => void }) {
  const banks = useBankAccounts();
  const [seen, setSeen] = useState<number | null>(mismatch ? null : item.amountPaise);
  const [seenOn, setSeenOn] = useState(todayLocal());
  const [note, setNote] = useState('');
  const [bankId, setBankId] = useState(item.suggestion?.bankAccountId ?? '');
  const [useLine, setUseLine] = useState(Boolean(item.suggestion));
  const [error, setError] = useState<unknown>(null);
  const run = useFinanceMutation((body: Record<string, unknown>) => verifyCall(item, body), { quiet: true });
  const differs = seen !== null && seen !== item.amountPaise;
  const submit = async () => {
    setError(null);
    try {
      const res = await run.mutateAsync({
        amountSeenPaise: seen,
        evidence: { seenOn, ...(note.trim() ? { note: note.trim() } : {}), ...(useLine && item.suggestion ? { statementLineId: item.suggestion.lineId } : {}) },
        ...(bankId ? { bankAccountId: bankId } : {}),
        ...(differs ? { useSeenAmount: true } : {}),
      });
      onDone(res);
    } catch (e) {
      setError(e);
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={mismatch ? 'The amount is different' : 'Verify this payment'}
      description={`${item.students.map((s) => s.studentName).join(', ')} · reported ${formatMoney(item.amountPaise)} by ${METHOD_LABELS[item.method] ?? item.method}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!seen || !seenOn} loading={run.isPending} loadingText="Saving…" onClick={() => void submit()}>
            {differs ? `Verify ${seen ? formatMoney(seen) : ''}` : 'Verify'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm">{mismatch ? 'Enter the amount you actually see in the bank. Only that amount is received and applied to the bills.' : 'Check the bank first. Verify only if you can see this money there.'}</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <MoneyField label="Amount seen in the bank" value={seen} onChange={setSeen} required labelAside={<InfoTip label="About verify">{TIP_VERIFY}</InfoTip>} />
          <TextField label="Seen on" type="date" required value={seenOn} max={todayLocal()} onChange={(e) => setSeenOn(e.target.value)} />
        </div>
        {differs && <Alert tone="warning">Reported {formatMoney(item.amountPaise)}, seen {formatMoney(seen!)}. Only {formatMoney(seen!)} will be received.</Alert>}
        <ComboboxField label="Bank account" value={bankId} onChange={setBankId} placeholder="The usual fees account" searchPlaceholder="Search accounts…" options={(banks.data ?? []).filter((b) => b.status === 'ACTIVE').map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))} hint="Optional." />
        {item.suggestion && (
          <label className="flex items-start gap-2 rounded-xl border border-line px-3 py-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-5 accent-[var(--color-brand)]" checked={useLine} onChange={(e) => setUseLine(e.target.checked)} />
            <span>
              Link to the bank line: <b>{item.suggestion.sentence}</b>
            </span>
          </label>
        )}
        <TextareaField label="Note" value={note} onChange={(e) => setNote(e.target.value)} hint="Optional. Example: Seen in the bank app at 11 am." maxLength={300} />
        {error !== null && <ErrorBanner error={error} />}
      </div>
    </Modal>
  );
}

function RejectDialog({ item, onClose }: { item: VerificationItemDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const run = useFinanceMutation((r: string) => rejectCall(item, r), { quiet: true });
  const [error, setError] = useState<unknown>(null);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Reject this payment report"
      description="Nothing is received and no bill changes. The family sees the reason."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={!reason.trim()}
            loading={run.isPending}
            loadingText="Rejecting…"
            onClick={() =>
              run.mutate(reason.trim(), {
                onSuccess: () => {
                  toast.success('Rejected. Nothing was received.');
                  onClose();
                },
                onError: setError,
              })
            }
          >
            Reject
          </Button>
        </>
      }
    >
      <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: No such payment in the bank on that date." maxLength={300} />
      {error !== null && <ErrorBanner error={error} className="mt-3" />}
    </Modal>
  );
}

function QueueRow({ item, onVerify, onMismatch, onReject, onFast, fastBusy }: { item: VerificationItemDTO; onVerify: () => void; onMismatch: () => void; onReject: () => void; onFast: () => void; fastBusy: boolean }) {
  const [proofBusy, setProofBusy] = useState(false);
  const who = item.kind === 'CLAIM' ? (item.reportedByParent ? 'Parent reported' : 'Staff reported') : 'Entered at the counter';
  const proof = async () => {
    setProofBusy(true);
    try {
      await openBlob(`/finance/payment-claims/${item.id}/proof`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setProofBusy(false);
    }
  };
  return (
    <li className="space-y-2 rounded-xl border border-line bg-white px-4 py-3" aria-label={`${item.students.map((s) => s.studentName).join(' and ')} ${formatMoney(item.amountPaise)}`}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Money paise={item.amountPaise} strong className="text-lg" />
        <b>{item.students.map((s) => s.studentName).join(', ')}</b>
        <Badge tone="neutral">{who}</Badge>
        <span className="text-sm text-muted">
          {METHOD_LABELS[item.method] ?? item.method} · paid {formatDateOnly(item.date)}
          {item.reference ? ` · ref ${item.reference}` : ''}
          {item.reportedByName ? ` · by ${item.reportedByName}` : ''}
        </span>
      </div>
      {item.flags.map((f) => (
        <p key={f} className="flex items-center gap-1.5 text-sm font-semibold text-danger">
          <TriangleAlert className="size-4 shrink-0" aria-hidden="true" /> {FLAG_LABELS[f] ?? f}
        </p>
      ))}
      {item.suggestion ? (
        <p className={`flex items-center gap-1.5 text-sm ${item.suggestion.exact ? 'text-success' : 'text-warning'}`} data-testid="suggested-line">
          <Landmark className="size-4 shrink-0" aria-hidden="true" /> {item.suggestion.sentence}
        </p>
      ) : (
        <p className="text-[13px] text-muted">No bank line found yet. Check the bank app, or import the latest statement in Banking.</p>
      )}
      <div className="flex flex-wrap gap-2">
        {item.suggestion?.exact && (
          <Button size="sm" onClick={onFast} loading={fastBusy} loadingText="Verifying…">
            <Zap /> Fast Verify
          </Button>
        )}
        <Button size="sm" variant={item.suggestion?.exact ? 'outline' : 'default'} onClick={onVerify}>
          <CircleCheck /> Verify
        </Button>
        <Button size="sm" variant="outline" onClick={onMismatch}>
          Mismatch
        </Button>
        <Button size="sm" variant="outline" onClick={onReject}>
          <Ban /> Reject
        </Button>
        {item.hasProof && (
          <Button size="sm" variant="ghost" onClick={() => void proof()} loading={proofBusy} loadingText="Opening…">
            <Image /> See Proof
          </Button>
        )}
      </div>
    </li>
  );
}

/** Waiting for Verification: one queue for claims and counter payments, oldest first, with the bank line that looks like each one. */
export function VerifyTab() {
  const q = useVerificationQueue();
  const [dialog, setDialog] = useState<{ item: VerificationItemDTO; mode: 'verify' | 'mismatch' | 'reject' } | null>(null);
  const [done, setDone] = useState<CollectionResultDTO | null>(null);
  const [fastId, setFastId] = useState<string | null>(null);
  const fast = useFinanceMutation((item: VerificationItemDTO) => verifyCall(item, { amountSeenPaise: item.amountPaise, evidence: { seenOn: todayLocal(), statementLineId: item.suggestion!.lineId }, bankAccountId: item.suggestion!.bankAccountId }), { quiet: true });

  const runFast = (item: VerificationItemDTO) => {
    setFastId(item.id);
    fast.mutate(item, { onSuccess: setDone, onError: (e) => toast.error(messageFor(e)), onSettled: () => setFastId(null) });
  };

  return (
    <div className="space-y-4">
      <TabIntro title="Waiting for Verification">{VERIFY_INTRO}</TabIntro>
      {done && (
        <div className="space-y-2">
          <PaymentResultCard result={done} />
          <Button size="sm" variant="ghost" onClick={() => setDone(null)}>
            Hide
          </Button>
        </div>
      )}
      {q.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {q.data && (
        <>
          <p className="flex items-center gap-1.5 text-[15px]" aria-live="polite">
            <b className="text-lg">{q.data.total}</b> waiting · oldest first <InfoTip label="About claims and payments">{TIP_CLAIM_VS_COLLECTION}</InfoTip>
          </p>
          {q.data.items.length === 0 ? (
            <EmptyState title="Nothing is waiting" description="Payments that parents or staff report appear here until someone checks them in the bank." />
          ) : (
            <ul className="space-y-3" aria-label="Payments waiting for verification">
              {q.data.items.map((item) => (
                <QueueRow
                  key={item.id}
                  item={item}
                  onVerify={() => setDialog({ item, mode: 'verify' })}
                  onMismatch={() => setDialog({ item, mode: 'mismatch' })}
                  onReject={() => setDialog({ item, mode: 'reject' })}
                  onFast={() => runFast(item)}
                  fastBusy={fastId === item.id}
                />
              ))}
            </ul>
          )}
        </>
      )}
      {dialog && dialog.mode !== 'reject' && (
        <VerifyDialog
          key={`${dialog.item.id}-${dialog.mode}`}
          item={dialog.item}
          mismatch={dialog.mode === 'mismatch'}
          onClose={() => setDialog(null)}
          onDone={(r) => {
            setDialog(null);
            setDone(r);
          }}
        />
      )}
      {dialog?.mode === 'reject' && <RejectDialog item={dialog.item} onClose={() => setDialog(null)} />}
    </div>
  );
}
