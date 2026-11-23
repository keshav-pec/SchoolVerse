import { useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { Money, MoneyField } from '@/components/finance/money';
import { ReportTable } from '@/components/finance/report-table';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { bpsToPercentText, formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useBankAccounts, useFinanceMutation } from './api';
import { todayLocal } from './collect/shared';
import { ErrorBanner } from './error-banner';
import { TAX_INTRO, TIP_ITC } from './help-copy';
import { spendApi, useGstPayments, useGstReport, useTaxLines, useTaxReviewQueue } from './ops-api';
import { MonthPicker, usePayrollMonth } from './payroll/shared';

const REPORTS = [
  { id: 'outward-summary', label: 'Outward Summary' },
  { id: 'exempt-and-nil-summary', label: 'Exempt Fees' },
  { id: 'itc-register', label: 'ITC Register' },
  { id: 'liability-summary', label: 'Liability Summary' },
  { id: 'hsn-summary', label: 'HSN Summary' },
];

/** Purchase lines waiting for the ITC decision: tick some, choose Claim or Don't Claim, give the reason once. */
function ItcReview() {
  const lines = useTaxLines({ itcStatus: 'NEEDS_REVIEW' });
  const [picked, setPicked] = useState<string[]>([]);
  const [reason, setReason] = useState('');
  const decide = useFinanceMutation((decision: 'ELIGIBLE' | 'NOT_ELIGIBLE') => spendApi.reviewItc({ lineIds: picked, decision, reason: reason.trim() }), { success: (r) => `${r.updated} ${r.updated === 1 ? 'line' : 'lines'} decided.` });
  const items = lines.data?.items ?? [];
  if (lines.isLoading) return <Skeleton className="h-16" />;
  if (items.length === 0) return null;
  return (
    <section aria-label="Purchase lines to decide" className="space-y-2 rounded-xl border border-line p-3">
      <p className="flex items-center gap-1 text-sm font-semibold">
        Claim the GST on these purchases? <InfoTip label="About ITC">{TIP_ITC}</InfoTip>
      </p>
      <ul className="divide-y divide-line text-sm">
        {items.map((l) => (
          <li key={l.lineId}>
            <label className="flex flex-wrap items-center gap-x-3 py-1.5">
              <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={picked.includes(l.lineId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, l.lineId] : p.filter((x) => x !== l.lineId)))} aria-label={`Choose ${l.sourceNumber}`} />
              <b>{l.sourceNumber}</b>
              <span className="min-w-0 flex-1 text-muted">
                {formatDateOnly(l.date)} · {l.vendorName ?? 'No vendor'} · {formatMoney(l.taxableValuePaise)} at {bpsToPercentText(l.rateBps)}%
              </span>
              <span>
                GST <Money paise={l.taxPaise} strong />
              </span>
            </label>
          </li>
        ))}
      </ul>
      <TextareaField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Used for the school office, not for exempt teaching." maxLength={300} />
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={!picked.length || !reason.trim()} loading={decide.isPending && decide.variables === 'ELIGIBLE'} loadingText="Saving…" onClick={() => decide.mutate('ELIGIBLE', { onSuccess: () => setPicked([]) })}>
          Claim
        </Button>
        <Button size="sm" variant="outline" disabled={!picked.length || !reason.trim()} loading={decide.isPending && decide.variables === 'NOT_ELIGIBLE'} loadingText="Saving…" onClick={() => decide.mutate('NOT_ELIGIBLE', { onSuccess: () => setPicked([]) })}>
          Don’t Claim
        </Button>
      </div>
    </section>
  );
}

function GstPayments({ month }: { month: string }) {
  const { can } = useAuth();
  const list = useGstPayments(month, can('finance:tax:manage'));
  const banks = useBankAccounts();
  const [f, setF] = useState({ kind: 'PAY_LIABILITY', head: 'CGST', bankAccountId: '', challanRef: '', paidOn: todayLocal() });
  const [amount, setAmount] = useState<number | null>(null);
  const save = useFinanceMutation((body: Record<string, unknown>) => spendApi.createGstPayment(body), { success: 'Recorded.' });
  const pay = f.kind === 'PAY_LIABILITY';
  return (
    <Card aria-label="GST payments">
      <CardHeader>
        <HelpHeading title="GST payments" help={<p>Record tax paid to the government with the challan number, or GST owed that is set off by claimed ITC.</p>} />
      </CardHeader>
      {(list.data ?? []).length > 0 && (
        <ul className="mb-3 divide-y divide-line text-sm">
          {list.data!.map((p) => (
            <li key={p.paymentId} className="flex flex-wrap gap-x-3 py-1.5">
              <b>{p.head}</b>
              <span className="flex-1 text-muted">
                {p.kind === 'USE_ITC' ? 'Set off with ITC' : 'Paid'} · {formatDateOnly(p.paidOn)}
                {p.challanRef ? ` · challan ${p.challanRef}` : ''}
              </span>
              <Money paise={p.amountPaise} strong />
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <ComboboxField
          label="What"
          value={f.kind}
          onChange={(v) => setF({ ...f, kind: v })}
          searchPlaceholder="Search…"
          options={[
            { value: 'PAY_LIABILITY', label: 'Tax paid to the government' },
            { value: 'USE_ITC', label: 'Set off with claimed ITC' },
          ]}
        />
        <ComboboxField label="Tax" value={f.head} onChange={(v) => setF({ ...f, head: v })} searchPlaceholder="Search…" options={['CGST', 'SGST', 'IGST'].map((h) => ({ value: h, label: h }))} />
        <MoneyField label="Amount" required value={amount} onChange={setAmount} />
        {pay && <ComboboxField label="Paid from" required value={f.bankAccountId} onChange={(v) => setF({ ...f, bankAccountId: v })} placeholder="Choose…" searchPlaceholder="Search accounts…" options={(banks.data ?? []).filter((b) => b.status === 'ACTIVE').map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))} />}
        {pay && <TextField label="Challan number" value={f.challanRef} onChange={(e) => setF({ ...f, challanRef: e.target.value })} maxLength={60} />}
        <TextField label="Date" type="date" value={f.paidOn} max={todayLocal()} onChange={(e) => setF({ ...f, paidOn: e.target.value })} />
      </div>
      {save.error && <ErrorBanner error={save.error} className="mt-2" />}
      <Button
        className="mt-3"
        size="sm"
        disabled={!amount || (pay && !f.bankAccountId)}
        loading={save.isPending}
        loadingText="Saving…"
        onClick={() => save.mutate({ month, kind: f.kind, head: f.head, amountPaise: amount, paidOn: f.paidOn, ...(pay ? { bankAccountId: f.bankAccountId, ...(f.challanRef.trim() ? { challanRef: f.challanRef.trim() } : {}) } : {}) }, { onSuccess: () => setAmount(null) })}
      >
        Record
      </Button>
    </Card>
  );
}

/** `/finance/tax`: Needs Review first, then the month's summaries. Every download says it is a working copy, not a filed return. */
export function TaxPage() {
  const [month] = usePayrollMonth();
  const queue = useTaxReviewQueue();
  const [report, setReport] = useState('outward-summary');
  const r = useGstReport(report, month);
  const groups = (queue.data?.groups ?? []).filter((g) => g.count > 0);
  return (
    <>
      <PageHeader eyebrow="Finance" title="Tax & GST" description="The month’s GST working, purchase tax decisions and payments." />
      <div className="space-y-4">
        <TabIntro title="Tax & GST">
          {TAX_INTRO}{' '}
          <InfoTip label="About GST for schools">
            <p>Schools often have mostly exempt fees. Your accountant decides what to claim.</p>
          </InfoTip>
        </TabIntro>
        <MonthPicker />
        <Card aria-label="Needs review">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              {groups.length ? <TriangleAlert className="size-5 text-warning" aria-hidden="true" /> : <CircleCheck className="size-5 text-success" aria-hidden="true" />} Needs Review
            </CardTitle>
          </CardHeader>
          {queue.isLoading && <Skeleton className="h-16" />}
          {queue.isError && <ErrorState error={queue.error} onRetry={() => void queue.refetch()} retrying={queue.isFetching} />}
          {queue.data && groups.length === 0 && <p className="text-sm text-success">Nothing needs review.</p>}
          {groups.length > 0 && (
            <>
              <p className="mb-2 text-[15px]" data-testid="tax-headline">
                {groups.map((g) => `${g.count} ${g.title.toLowerCase()}`).join(', ')}
              </p>
              <ul className="mb-3 space-y-1 text-sm">
                {groups
                  .filter((g) => g.key !== 'ITC_NEEDS_REVIEW')
                  .flatMap((g) => g.items.map((i) => ({ ...i, group: g.title })))
                  .map((i) => (
                    <li key={i.id} className="flex flex-wrap gap-x-2">
                      <span>{i.label}</span>
                      {i.fix && (
                        <Link to={i.fix.path} className="font-semibold text-brand hover:underline">
                          {i.fix.label}
                        </Link>
                      )}
                    </li>
                  ))}
              </ul>
              <Can permission="finance:tax:review">
                <ItcReview />
              </Can>
            </>
          )}
        </Card>

        <Card aria-label="GST summaries">
          <div role="tablist" aria-label="GST report" className="mb-3 flex flex-wrap gap-2">
            {REPORTS.map((x) => (
              <button key={x.id} type="button" role="tab" aria-selected={report === x.id} onClick={() => setReport(x.id)} className={cn('rounded-lg border px-3 py-1.5 text-sm font-semibold', report === x.id ? 'border-brand bg-brand text-white' : 'border-line bg-white hover:border-brand/40')}>
                {x.label}
              </button>
            ))}
          </div>
          <ReportTable query={r} csvPath={`/finance/tax/reports/${report}?month=${month}`} fileName={`gst-${report}-${month}-working-copy.csv`} csvLabel="Download CSV (Working copy — not a filed return)" extraNote={<Alert tone="info">Working copy — not a filed return.</Alert>} />
        </Card>

        <Can permission="finance:tax:manage">
          <GstPayments month={month} />
        </Can>
      </div>
    </>
  );
}
