import { useState } from 'react';
import { CircleCheck, Download, Info } from 'lucide-react';
import { toast } from 'sonner';
import type { DisbursementBatchDTO, PayrollRunDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { useBankAccounts, useFinanceMutation } from '../api';
import { ErrorBanner } from '../error-banner';
import { PAYMENTS_INTRO, RUN_TYPE_LABELS } from '../help-copy';
import { downloadFile, payApi, useBatches, useCompensations, usePayrollRuns } from '../ops-api';
import { todayLocal } from '../collect/shared';
import { MonthPicker, monthName, usePayrollMonth } from './shared';

/** Record Payment: what the bank actually paid. Everyone is marked paid by default; untick a person whose payment failed. */
function RecordDialog({ batch, onClose }: { batch: DisbursementBatchDTO; onClose: () => void }) {
  const pending = batch.items.filter((i) => i.status === 'PENDING');
  const [failed, setFailed] = useState<Record<string, string>>({});
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const run = useFinanceMutation((body: Record<string, unknown>) => payApi.record(batch.batchId, body), { success: 'Recorded. A second person checks it next.' });
  const body = {
    items: pending.map((i) => (failed[i.employeeId] !== undefined ? { employeeId: i.employeeId, status: 'FAILED', reason: failed[i.employeeId] || 'Failed at the bank', mode: i.mode } : { employeeId: i.employeeId, status: 'PAID', reference: reference.trim(), paidOn, mode: i.mode })),
    ...(note.trim() ? { evidenceNote: note.trim() } : {}),
  };
  const paidTotal = pending.filter((i) => failed[i.employeeId] === undefined).reduce((s, i) => s + i.amountPaise, 0);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record the salary payment"
      description="Do this after the bank has paid. Use the reference from the bank’s confirmation."
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!reference.trim() || pending.length === 0} loading={run.isPending} loadingText="Saving…" onClick={() => run.mutate(body, { onSuccess: onClose })}>
            Record {formatMoney(paidTotal)} Paid
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Paid on" type="date" required value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} />
          <TextField label="Bank reference" required value={reference} onChange={(e) => setReference(e.target.value)} hint="Example: the batch number on the bank’s confirmation." maxLength={60} />
        </div>
        <TextareaField label="Proof note" value={note} onChange={(e) => setNote(e.target.value)} hint="Optional. Example: Bank confirmation saved in the salary file." maxLength={300} />
        <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm" aria-label="People in this payment">
          {pending.map((i) => (
            <li key={i.itemId} className="flex flex-wrap items-center gap-3 px-3 py-2">
              <label className="flex min-w-48 flex-1 items-center gap-2">
                <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={failed[i.employeeId] === undefined} onChange={(e) => setFailed((p) => (e.target.checked ? Object.fromEntries(Object.entries(p).filter(([k]) => k !== i.employeeId)) : { ...p, [i.employeeId]: '' }))} aria-label={`${i.employeeName} was paid`} />
                {i.employeeName}
              </label>
              <Money paise={i.amountPaise} />
              {failed[i.employeeId] !== undefined && <TextField label="Why did it fail?" value={failed[i.employeeId]} onChange={(e) => setFailed((p) => ({ ...p, [i.employeeId]: e.target.value }))} containerClassName="w-full" maxLength={200} />}
            </li>
          ))}
        </ul>
        {run.error && <ErrorBanner error={run.error} />}
      </div>
    </Modal>
  );
}

function BatchCard({ batch }: { batch: DisbursementBatchDTO }) {
  const { can } = useAuth();
  const [recording, setRecording] = useState(false);
  const [busy, setBusy] = useState(false);
  const verify = useFinanceMutation(() => payApi.verify(batch.batchId), { quiet: true, success: 'Checked. The salaries are paid.' });
  const recordedNotVerified = batch.items.filter((i) => i.status === 'PAID' && !i.verified);
  const file = async () => {
    setBusy(true);
    try {
      await downloadFile(`/payroll/disbursements/${batch.batchId}/bank-file`, `salary-${batch.month}.csv`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card aria-label={`Payment batch for ${monthName(batch.month)}`}>
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {formatMoney(batch.totalPaise)} to {batch.items.length} people <FinanceStatusPill status={batch.state} />
        </CardTitle>
      </CardHeader>
      <p className="text-sm">
        Paid {formatMoney(batch.paidPaise)} · checked {formatMoney(batch.verifiedPaise)} · not paid yet {formatMoney(batch.totalPaise - batch.paidPaise)}
      </p>
      {batch.skipped.length > 0 && (
        <Alert tone="warning" title={`${batch.skipped.length} left out of the bank file`} className="mt-2">
          {batch.skipped.map((s) => `${s.employeeName}: ${s.reason}`).join(' · ')}
        </Alert>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="outline" onClick={() => void file()} loading={busy} loadingText="Preparing…">
          <Download /> Download Bank File
        </Button>
        {batch.items.some((i) => i.status === 'PENDING') && can('payroll:disbursement:manage') && (
          <Button onClick={() => setRecording(true)}>Record Payment</Button>
        )}
        {recordedNotVerified.length > 0 && can('payroll:disbursement:verify') && (
          <Button loading={verify.isPending} loadingText="Checking…" onClick={() => verify.mutate(undefined)}>
            <CircleCheck /> Verify {recordedNotVerified.length} Payments
          </Button>
        )}
      </div>
      <p className="mt-2 flex items-center gap-1.5 text-[13px] text-muted" data-testid="bank-file-note">
        <Info className="size-3.5" aria-hidden="true" /> Making the file does not pay anyone. Upload it in your bank, then record what the bank paid.
      </p>
      {recordedNotVerified.length > 0 && !can('payroll:disbursement:verify') && <p className="mt-1 text-[13px] text-muted">Waiting for a second person to check the payment.</p>}
      {verify.error && <ErrorBanner error={verify.error} className="mt-2" />}
      <details className="mt-3">
        <summary className="cursor-pointer text-sm font-semibold">See each person</summary>
        <ul className="mt-2 divide-y divide-line text-sm">
          {batch.items.map((i) => (
            <li key={i.itemId} className="flex flex-wrap items-center gap-x-3 py-1.5">
              <span className="min-w-0 flex-1">{i.employeeName}</span>
              <Money paise={i.amountPaise} />
              <FinanceStatusPill status={i.status === 'PAID' && i.verified ? 'VERIFIED' : i.status === 'PAID' ? 'RECORDED' : i.status} label={i.status === 'PAID' && !i.verified ? 'Paid · Not Checked' : undefined} />
            </li>
          ))}
        </ul>
      </details>
      {recording && <RecordDialog batch={batch} onClose={() => setRecording(false)} />}
    </Card>
  );
}

function RunPayments({ run }: { run: PayrollRunDTO }) {
  const batches = useBatches(run.runId);
  const banks = useBankAccounts();
  const [bankId, setBankId] = useState('');
  const build = useFinanceMutation((bank: string) => payApi.buildBatch(run.runId, bank), { success: 'Payment batch made. Download the bank file next.' });
  const active = (banks.data ?? []).filter((b) => b.status === 'ACTIVE');
  const salaryBank = (active.find((b) => b.purpose === 'SALARY') ?? active[0])?.bankAccountId;
  const chosen = bankId || salaryBank || '';
  return (
    <div className="space-y-3">
      <p className="flex flex-wrap items-center gap-2 text-[15px]">
        <b>
          {RUN_TYPE_LABELS[run.type]} {run.number}
        </b>{' '}
        · net {formatMoney(run.totals.netPaise)} <FinanceStatusPill status={run.payoutStatus} />
      </p>
      {batches.isLoading && <Skeleton className="h-24" />}
      {(batches.data ?? []).map((b) => (
        <BatchCard key={b.batchId} batch={b} />
      ))}
      {run.payoutStatus !== 'PAID' && (
        <Can permission="payroll:disbursement:manage">
          <div className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-line p-3">
            <ComboboxField label="Pay from" value={chosen} onChange={setBankId} placeholder="Choose…" searchPlaceholder="Search accounts…" options={(banks.data ?? []).filter((b) => b.status === 'ACTIVE').map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))} containerClassName="w-72" />
            <Button disabled={!chosen} loading={build.isPending} loadingText="Making…" onClick={() => build.mutate(chosen)}>
              Create Payment Batch
            </Button>
          </div>
          {build.error && <ErrorBanner error={build.error} />}
        </Can>
      )}
    </div>
  );
}

/** Full & Final: settle an employee who has left. It makes a run of its own, which then goes through Runs and Payments like any other. */
function FullFinalCard() {
  const comp = useCompensations();
  const [employeeId, setEmployeeId] = useState('');
  const [lastDay, setLastDay] = useState(todayLocal());
  const [leaveDays, setLeaveDays] = useState('0');
  const [leaveRate, setLeaveRate] = useState<number | null>(0);
  const [bonus, setBonus] = useState<number | null>(0);
  const [gratuity, setGratuity] = useState<number | null>(0);
  const start = useFinanceMutation(() => payApi.fullFinal(employeeId, { lastWorkingDay: lastDay, leaveEncashmentDays: Number(leaveDays) || 0, leaveEncashmentRatePaise: leaveRate ?? 0, bonusPaise: bonus ?? 0, gratuityPaise: gratuity ?? 0 }), {
    success: (r) => `Full & final run ${r.number} is ready. Review it in Payroll Runs for ${monthName(r.month)}.`,
  });
  return (
    <Card aria-label="Full and final">
      <CardHeader>
        <HelpHeading title="Full & final settlement" help={<p>For someone who has left: last salary, leave encashment, bonus and gratuity, less any advance still owed. Steps: Prepare, Review, Approve, Statement, Pay, Verify.</p>} />
      </CardHeader>
      <div className="grid gap-3 sm:grid-cols-3">
        <ComboboxField label="Who has left?" value={employeeId} onChange={setEmployeeId} placeholder="Choose…" searchPlaceholder="Search people…" options={[...new Map((comp.data ?? []).map((c) => [c.employeeId, { value: c.employeeId, label: c.employeeName, hint: c.employeeCode }])).values()]} />
        <TextField label="Last working day" type="date" value={lastDay} onChange={(e) => setLastDay(e.target.value)} />
        <TextField label="Leave days to pay" type="number" min={0} value={leaveDays} onChange={(e) => setLeaveDays(e.target.value)} />
        <MoneyField label="Pay per leave day" value={leaveRate} onChange={setLeaveRate} />
        <MoneyField label="Bonus" value={bonus} onChange={setBonus} hint="Optional." />
        <MoneyField label="Gratuity" value={gratuity} onChange={setGratuity} hint="Optional." />
      </div>
      <Button className="mt-3" disabled={!employeeId} loading={start.isPending} loadingText="Preparing…" onClick={() => start.mutate(undefined)}>
        Prepare Settlement
      </Button>
      {start.error && <ErrorBanner error={start.error} className="mt-2" />}
    </Card>
  );
}

export function PaymentsTab() {
  const [month] = usePayrollMonth();
  const runs = usePayrollRuns({ month });
  const finals = (runs.data?.items ?? []).filter((r) => r.state === 'FINALIZED');
  return (
    <div className="space-y-4">
      <TabIntro title="Payments">{PAYMENTS_INTRO}</TabIntro>
      <MonthPicker />
      {runs.isLoading && <Skeleton className="h-24" />}
      {runs.data && finals.length === 0 && <EmptyState title={`Nothing to pay for ${monthName(month)} yet`} description="A payroll run must be finalised before it can be paid." />}
      {finals.map((r) => (
        <RunPayments key={r.runId} run={r} />
      ))}
      <Can permission="payroll:settlement:manage">
        <FullFinalCard />
      </Can>
    </div>
  );
}
