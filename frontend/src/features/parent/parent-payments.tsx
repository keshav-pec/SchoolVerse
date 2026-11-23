import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Download, Hourglass, Send, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import type { ClaimDTO, ParentFeeSummaryDTO, ReceiptDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { MoneyField } from '@/components/finance/money';
import { openPdf } from '@/features/finance/api';
import { todayLocal } from '@/features/finance/collect/shared';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';

const KEY = ['parent', 'fees'] as const;
export const useParentClaims = () => useQuery({ queryKey: [...KEY, 'claims'], queryFn: () => api.get<ClaimDTO[]>('/parent/payment-claims'), staleTime: 0 });
export const useParentReceipts = () => useQuery({ queryKey: [...KEY, 'receipts'], queryFn: () => api.get<ReceiptDTO[]>('/parent/fees/receipts'), staleTime: 0 });

/**
 * Report a Payment: the parent says "I paid" with the UPI or bank reference and, if they like, a screenshot. It is never shown as
 * paid at once: it says "Awaiting school verification" until the school sees the money in its bank.
 */
export function ReportPayment({ kids }: { kids: ParentFeeSummaryDTO['children'] }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [studentId, setStudentId] = useState(kids.find((k) => k.outstandingPaise > 0)?.studentId ?? kids[0]?.studentId ?? '');
  const due = kids.find((k) => k.studentId === studentId)?.outstandingPaise ?? 0;
  const [amount, setAmount] = useState<number | null>(due || null);
  const [method, setMethod] = useState('UPI');
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [reference, setReference] = useState('');
  const [shot, setShot] = useState<File | null>(null);
  const [done, setDone] = useState<ClaimDTO | null>(null);
  const send = useMutation({
    mutationFn: async () => {
      const claim = await api.post<ClaimDTO>('/parent/payment-claims', { students: [{ studentId, amountPaise: amount }], method, amountPaise: amount, paidOn, reference: reference.trim() });
      if (shot) {
        const form = new FormData();
        form.append('file', shot);
        await api.post(`/parent/payment-claims/${claim.claimId}/proof`, form).catch(() => toast.error('The screenshot could not be attached, but your report is saved.'));
      }
      return claim;
    },
    onSuccess: (c) => {
      setDone(c);
      void qc.invalidateQueries({ queryKey: KEY });
    },
  });
  if (!open)
    return (
      <Button className="min-h-12 w-full sm:w-auto" onClick={() => { setOpen(true); setDone(null); }}>
        <Send /> Report a Payment
      </Button>
    );
  return (
    <section aria-label="Report a payment" className="space-y-3 rounded-card border border-line bg-white p-4 shadow-card">
      <h2 className="text-lg font-extrabold">Report a payment</h2>
      {done ? (
        <>
          <Alert tone="warning" title="Awaiting school verification">
            Thank you. The school will check {formatMoney(done.amountPaise)} in its bank. The receipt appears here after that. This usually takes a day or two.
          </Alert>
          <Button variant="outline" className="min-h-11" onClick={() => setOpen(false)}>
            Done
          </Button>
        </>
      ) : (
        <>
          <p className="text-sm text-muted">Tell us about a payment you made by UPI or bank transfer. Cash is paid at the school office.</p>
          {kids.length > 1 && (
            <ComboboxField
              label="For which child?"
              value={studentId}
              onChange={(v) => {
                setStudentId(v);
                setAmount(kids.find((k) => k.studentId === v)?.outstandingPaise || null);
              }}
              searchPlaceholder="Search…"
              options={kids.map((k) => ({ value: k.studentId, label: k.studentName, hint: k.outstandingPaise > 0 ? `${formatMoney(k.outstandingPaise)} due` : 'nothing due' }))}
            />
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <MoneyField label="Amount you paid" required value={amount} onChange={setAmount} />
            <TextField label="Date you paid" type="date" required value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} />
            <ComboboxField
              label="How did you pay?"
              value={method}
              onChange={setMethod}
              searchPlaceholder="Search…"
              options={[
                { value: 'UPI', label: 'UPI' },
                { value: 'NEFT', label: 'Bank transfer' },
              ]}
            />
            <TextField label="UPI or bank reference (UTR)" required value={reference} onChange={(e) => setReference(e.target.value)} hint="The 12-digit number on your payment screen." maxLength={60} />
          </div>
          <div className="space-y-1">
            <label htmlFor="claim-shot" className="text-sm font-semibold">
              Screenshot
            </label>
            <input id="claim-shot" type="file" accept="image/*,application/pdf" className="block w-full text-sm" onChange={(e) => setShot(e.target.files?.[0] ?? null)} />
            <p className="text-[13px] text-muted">Optional. A screenshot helps, but the school still checks the bank.</p>
          </div>
          {send.error && <Alert tone="danger">{messageFor(send.error)}</Alert>}
          <div className="flex flex-wrap gap-2">
            <Button className="min-h-11" disabled={!studentId || !amount || !reference.trim() || !paidOn} loading={send.isPending} loadingText="Sending…" onClick={() => send.mutate()}>
              Send Report
            </Button>
            <Button variant="outline" className="min-h-11" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

function ReceiptButton({ receipt }: { receipt: ReceiptDTO }) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      className="min-h-10"
      loading={busy}
      loadingText="Opening…"
      onClick={async () => {
        setBusy(true);
        try {
          await openPdf(`/parent/fees/receipts/${receipt.receiptId}/pdf`);
        } catch (e) {
          toast.error(messageFor(e));
        } finally {
          setBusy(false);
        }
      }}
      aria-label={`Download receipt ${receipt.number}`}
    >
      <Download /> Receipt {receipt.number}
    </Button>
  );
}

/** The family's payment reports with a plain status, and every receipt, newest first. */
export function PaymentsAndReceipts() {
  const claims = useParentClaims();
  const receipts = useParentReceipts();
  const list = claims.data ?? [];
  const rcpts = receipts.data ?? [];
  const receiptFor = (c: ClaimDTO) => rcpts.find((r) => c.collectionId && r.collectionId === c.collectionId) ?? null;
  return (
    <>
      {list.length > 0 && (
        <section aria-label="Your payment reports" className="rounded-card border border-line bg-white p-4 shadow-card">
          <h2 className="mb-2 text-lg font-extrabold">Your payment reports</h2>
          <ul className="divide-y divide-line">
            {list.map((c) => {
              const r = receiptFor(c);
              return (
                <li key={c.claimId} className="space-y-1 py-2.5 text-sm">
                  <p className="flex flex-wrap items-center gap-x-2">
                    <b>{formatMoney(c.amountPaise)}</b>
                    <span className="text-muted">
                      paid {formatDateOnly(c.paidOn)} · {c.students.map((s) => s.studentName).join(', ')}
                      {c.reference ? ` · ref ${c.reference}` : ''}
                    </span>
                  </p>
                  {c.status === 'VERIFIED' ? (
                    <p className="flex flex-wrap items-center gap-2 font-semibold text-success">
                      <CircleCheck className="size-4" aria-hidden="true" /> Payment verified · Receipt available {r && <ReceiptButton receipt={r} />}
                    </p>
                  ) : c.status === 'REJECTED' ? (
                    <p className="flex items-center gap-2 font-semibold text-danger">
                      <XCircle className="size-4" aria-hidden="true" /> Not accepted{c.rejectReason ? `: ${c.rejectReason}` : ''}. Please contact the school office.
                    </p>
                  ) : (
                    <p className="flex items-center gap-2 font-semibold text-warning">
                      <Hourglass className="size-4" aria-hidden="true" /> Awaiting school verification
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <section aria-label="Receipts" className="rounded-card border border-line bg-white p-4 shadow-card">
        <h2 className="mb-2 text-lg font-extrabold">Receipts</h2>
        {receipts.isLoading ? (
          <Skeleton className="h-16" />
        ) : rcpts.length === 0 ? (
          <p className="text-sm text-muted">No receipts yet. A receipt appears after the school receives a payment.</p>
        ) : (
          <ul className="divide-y divide-line">
            {rcpts.map((r) => (
              <li key={r.receiptId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <span className="min-w-0 flex-1">
                  <b>{formatMoney(r.amountPaise)}</b> <span className="text-muted">· {formatDateOnly(r.receivedOn)} · {[...new Set(r.lines.map((l) => l.studentName))].join(', ') || 'Advance'}</span>
                  {r.status === 'CANCELLED' && <span className="block text-danger">Cancelled by the school{r.cancelledReason ? `: ${r.cancelledReason}` : ''}</span>}
                </span>
                {r.status === 'ISSUED' && <ReceiptButton receipt={r} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
