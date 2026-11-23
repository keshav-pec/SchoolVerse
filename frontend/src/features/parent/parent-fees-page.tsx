import { Link } from 'react-router';
import { Landmark, ReceiptText, ShieldOff } from 'lucide-react';
import type { ParentStudentFeesDTO } from '@shared';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { Money } from '@/components/finance/money';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { Button } from '@/components/ui/button';
import { useParentChildFees, useParentFees } from '../finance/api';

/** What the school asks the family to pay, in the plainest words: a total, then each child's bills with the maths. */
function ChildFees({ studentId, name }: { studentId: string; name: string }) {
  const q = useParentChildFees(studentId);
  if (q.isLoading) return <Skeleton className="h-32 rounded-card" role="status" aria-label={`Loading fees for ${name}`} />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const d: ParentStudentFeesDTO = q.data;
  return (
    <section className="rounded-card border border-line bg-white p-4 shadow-card" aria-label={`Fees for ${name}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-extrabold">{name}</h2>
        <p className="text-sm">
          {d.outstandingPaise > 0 ? (
            <>
              Due <Money paise={d.outstandingPaise} strong /> {d.overduePaise > 0 && <span className="font-semibold text-danger">· {formatMoney(d.overduePaise)} is late</span>}
            </>
          ) : (
            <span className="font-semibold text-success">Nothing is due</span>
          )}
        </p>
      </div>
      {d.advancePaise > 0 && <p className="mt-1 text-sm text-muted">The school is holding {formatMoney(d.advancePaise)} for {name}. It will be used for the next bills.</p>}
      {d.bills.length === 0 ? (
        <p className="mt-3 text-sm text-muted">No bills yet.</p>
      ) : (
        <ul className="mt-3 space-y-3" aria-label={`Bills for ${name}`}>
          {d.bills.map((b) => (
            <li key={b.documentId} className="rounded-xl border border-line px-3 py-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <b className="text-sm">{b.number}</b>
                <FinanceStatusPill status={b.status} />
                {b.overdue && <FinanceStatusPill status="OVERDUE" />}
                <span className="ml-auto text-sm text-muted">Pay by {formatDateOnly(b.dueDate)}</span>
              </div>
              <ul className="mt-2 space-y-1.5 text-sm">
                {b.lines.map((l, i) => (
                  <li key={`${b.documentId}-${i}`}>
                    <p className="flex justify-between gap-3">
                      <span>{l.description}</span>
                      <Money paise={l.totalPaise} />
                    </p>
                    {(l.discountPaise > 0 || l.taxPaise > 0) && (
                      <p className="text-[13px] text-muted">
                        {l.discountPaise > 0 && <>Discount −{formatMoney(l.discountPaise)} </>}
                        {l.taxPaise > 0 && <>· GST +{formatMoney(l.taxPaise)}</>}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
              <p className="mt-2 flex justify-between border-t border-line pt-2 text-sm font-bold">
                <span>Bill total <Money paise={b.totalPaise} /></span>
                <span>{b.balancePaise > 0 ? <>Still to pay <Money paise={b.balancePaise} strong /></> : 'Paid'}</span>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** `/parent/fees`: the family's total, each child's bills, and how to pay. Receipts and reporting a payment come in a later release. */
export function ParentFeesPage() {
  const q = useParentFees();
  const kids = q.data?.children ?? [];
  const total = kids.reduce((s, c) => s + c.outstandingPaise, 0);
  // The school's payment details come with each child's fees; the first child that has them is enough for the family.
  const first = kids[0];
  const pay = useParentChildFees(first?.studentId);

  if (q.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (kids.length === 0)
    return (
      <EmptyState
        illustration={<ShieldOff className="size-14 text-muted" aria-hidden="true" />}
        title="No fees to show"
        description="The school has not allowed fees to be shown for your children yet. Please contact the school office."
        action={
          <Button asChild variant="outline" className="min-h-11">
            <Link to="/parent">Go To Home</Link>
          </Button>
        }
      />
    );

  const how = pay.data?.howToPay ?? null;
  return (
    <div className="space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-[22px] font-extrabold">
          <ReceiptText className="size-6 text-brand" aria-hidden="true" /> Fees
        </h1>
        <p className="mt-1 text-[17px]" aria-live="polite" data-testid="family-total">
          {total > 0 ? (
            <>
              <b>Total due {formatMoney(total)}</b>
              <span className="text-muted"> · {kids.filter((c) => c.outstandingPaise > 0).map((c) => `${c.studentName.split(' ')[0]} ${formatMoney(c.outstandingPaise)}`).join(' · ')}</span>
            </>
          ) : (
            <b className="text-success">Nothing is due. Thank you!</b>
          )}
        </p>
      </div>

      {how && (
        <section className="rounded-card border border-brand/20 bg-brand-soft/60 p-4" aria-label="How to pay">
          <h2 className="flex items-center gap-2 text-base font-extrabold">
            <Landmark className="size-5 text-brand" aria-hidden="true" /> How to pay
          </h2>
          <p className="mt-1 text-sm">{how.instructions}</p>
          <dl className="mt-2 grid gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[13px] text-muted">Bank</dt>
              <dd className="font-semibold">{how.bankName}</dd>
            </div>
            {how.holderName && (
              <div>
                <dt className="text-[13px] text-muted">Account name</dt>
                <dd className="font-semibold">{how.holderName}</dd>
              </div>
            )}
            <div>
              <dt className="text-[13px] text-muted">Account number</dt>
              <dd className="font-semibold tabular-nums">•••• {how.accountLast4}</dd>
            </div>
            <div>
              <dt className="text-[13px] text-muted">IFSC</dt>
              <dd className="font-semibold">{how.ifsc}</dd>
            </div>
          </dl>
        </section>
      )}

      {kids.map((c) => (
        <ChildFees key={c.studentId} studentId={c.studentId} name={c.studentName} />
      ))}
      <p className="text-center text-[13px] text-muted">Reporting a payment and receipts are coming soon.</p>
    </div>
  );
}
