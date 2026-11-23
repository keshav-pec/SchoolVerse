import { useState, type ComponentType, type ReactNode } from 'react';
import { CircleCheck, Download, Hourglass, Printer, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import type { CollectionResultDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Money } from '@/components/finance/money';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { openPdf } from '../api';
import { METHOD_LABELS } from '../help-copy';

/** Today in the school's own time, as `YYYY-MM-DD`. */
export const todayLocal = () => new Date().toLocaleDateString('en-CA');

/** A row of big tap targets for a pick-one choice that has only a few options (payment method, ITC decision). */
export function ChoiceCards<T extends string>({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: string; hint?: string; Icon?: ComponentType<{ className?: string }> }[];
  className?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} className={cn('grid grid-cols-2 gap-2 sm:grid-cols-4', className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cn('flex min-h-14 flex-col items-start justify-center rounded-xl border px-3 py-2 text-left text-sm transition-colors', on ? 'border-brand bg-brand-soft text-ink ring-2 ring-brand/20' : 'border-line bg-white hover:border-brand/40')}
          >
            <span className="flex items-center gap-1.5 font-semibold">
              {o.Icon && <o.Icon className="size-4 text-brand" />}
              {o.label}
            </span>
            {o.hint && <span className="text-xs text-muted">{o.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * The result of saving a payment, with no page change: the receipt (cash, a cleared cheque, a verified transfer) or the
 * acknowledgement (a payment that still waits for the bank), and the buttons to print, share or download it.
 */
export function PaymentResultCard({ result, onNext }: { result: CollectionResultDTO; onNext?: () => void }) {
  const [busy, setBusy] = useState(false);
  const c = result.collection;
  const r = result.receipt;
  const open = async () => {
    if (!r) return;
    setBusy(true);
    try {
      await openPdf(`/finance/receipts/${r.receiptId}/pdf`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    const text = r
      ? `Receipt ${r.number}: ${formatMoney(r.amountPaise)} received on ${r.receivedOn} by ${METHOD_LABELS[r.method] ?? r.method}.`
      : `Payment ${c.provisionalNumber ?? ''} of ${formatMoney(c.amountPaise)} is recorded and waits for the school to check it.`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        toast.success('Copied. You can paste it in a message.');
      }
    } catch {
      // the person closed the share sheet
    }
  };
  return (
    <section aria-label="Payment saved" className={cn('rounded-card border p-4', r ? 'border-success/30 bg-success-soft' : 'border-sun/40 bg-sun-soft')}>
      <p className="flex items-center gap-2 text-lg font-extrabold">
        {r ? <CircleCheck className="size-6 text-success" aria-hidden="true" /> : <Hourglass className="size-6 text-warning" aria-hidden="true" />}
        {r ? <>Receipt {r.number}</> : <>Recorded · {c.provisionalNumber ?? 'waiting for the bank'}</>}
      </p>
      <p className="mt-1 text-sm" data-testid="payment-result">
        {result.repeated && <b>This payment was already saved. Nothing was added twice. </b>}
        <Money paise={c.amountPaise} strong /> by {METHOD_LABELS[c.method] ?? c.method}
        {c.students.length ? ` for ${c.students.map((s) => s.studentName).join(' and ')}` : ''}.{' '}
        {r ? 'The bills are paid.' : c.method === 'CHEQUE' ? 'A receipt is made only after the cheque clears.' : 'This will wait for verification. The receipt comes after the money is checked in the bank.'}
        {r && r.advancePaise > 0 && <> {formatMoney(r.advancePaise)} is kept as an advance.</>}
      </p>
      {r && r.lines.length > 0 && (
        <ul className="mt-2 space-y-0.5 text-sm" aria-label="What was paid">
          {r.lines.map((l, i) => (
            <li key={`${l.documentNumber}-${i}`} className="flex justify-between gap-3">
              <span>
                {l.studentName} · {l.documentNumber}
              </span>
              <Money paise={l.amountPaise} />
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {r && (
          <>
            <Button size="sm" variant="outline" onClick={() => void open()} loading={busy} loadingText="Opening…">
              <Printer /> Print
            </Button>
            <Button size="sm" variant="outline" onClick={() => void open()} disabled={busy}>
              <Download /> Download
            </Button>
          </>
        )}
        <Button size="sm" variant="outline" onClick={() => void share()}>
          <Share2 /> Share
        </Button>
        {onNext && (
          <Button size="sm" onClick={onNext}>
            Next Payment
          </Button>
        )}
      </div>
    </section>
  );
}

/** A labelled pair for a definition list in a card. */
export function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="font-semibold">{children}</dd>
    </div>
  );
}
