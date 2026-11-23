import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { AdvanceDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { ImpactPreview } from '@/components/finance/impact-preview';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { formatMoney } from '@/lib/money';
import { useBankAccounts, useFinanceMutation } from '../api';
import { ErrorBanner } from '../error-banner';
import { ADVANCES_INTRO } from '../help-copy';
import { payApi, useAdvances, useCompensations } from '../ops-api';
import { todayLocal } from '../collect/shared';
import { monthName, monthOptions } from './shared';

function NewAdvance({ onClose }: { onClose: () => void }) {
  const comp = useCompensations();
  const [employeeId, setEmployeeId] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [parts, setParts] = useState('6');
  const [start, setStart] = useState(todayLocal().slice(0, 7));
  const [reason, setReason] = useState('');
  const save = useFinanceMutation((body: Record<string, unknown>) => payApi.createAdvance(body), { success: 'Advance saved. A person with approval rights approves it next.' });
  const n = Math.max(1, Number(parts) || 1);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="New salary advance"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!employeeId || !amount || !reason.trim()} loading={save.isPending} loadingText="Saving…" onClick={() => save.mutate({ employeeId, principalPaise: amount, installments: n, startMonth: start, reason: reason.trim() }, { onSuccess: onClose })}>
            Save Advance
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <ComboboxField label="Who?" required value={employeeId} onChange={setEmployeeId} placeholder="Choose…" searchPlaceholder="Search people…" options={[...new Map((comp.data ?? []).map((c) => [c.employeeId, { value: c.employeeId, label: c.employeeName, hint: c.employeeCode }])).values()]} />
        <div className="grid gap-3 sm:grid-cols-3">
          <MoneyField label="Amount" required value={amount} onChange={setAmount} />
          <TextField label="Paid back in (months)" type="number" min={1} max={60} required value={parts} onChange={(e) => setParts(e.target.value)} />
          <ComboboxField label="First recovery" value={start} onChange={setStart} searchPlaceholder="Search months…" options={monthOptions().reverse()} />
        </div>
        {amount ? <ImpactPreview title="Recovery plan" lines={[{ label: 'Each month', value: formatMoney(Math.ceil(amount / n)) }, { label: 'From', value: monthName(start) }]} note="Taken from the salary each month until it is paid back." /> : null}
        <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Medical emergency." maxLength={200} />
        {save.error && <ErrorBanner error={save.error} />}
      </div>
    </Modal>
  );
}

function PayDialog({ advance, mode, onClose }: { advance: AdvanceDTO; mode: 'pay' | 'repay'; onClose: () => void }) {
  const banks = useBankAccounts();
  const [bankId, setBankId] = useState('');
  const [reference, setReference] = useState('');
  const [amount, setAmount] = useState<number | null>(mode === 'repay' ? advance.remainingPaise : null);
  const run = useFinanceMutation(
    () => (mode === 'pay' ? payApi.payAdvance(advance.advanceId, { bankAccountId: bankId, reference: reference.trim(), paidOn: todayLocal() }) : payApi.repayAdvance(advance.advanceId, { bankAccountId: bankId, amountPaise: amount, ...(reference.trim() ? { reference: reference.trim() } : {}), paidOn: todayLocal() })),
    { success: mode === 'pay' ? 'Recorded as paid out.' : 'Repayment recorded.' },
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={mode === 'pay' ? `Pay out ${advance.employeeName}’s advance` : `${advance.employeeName} pays back early`}
      description={mode === 'pay' ? `${formatMoney(advance.principalPaise)}. Record this after the money has left the bank.` : `Still to pay back: ${formatMoney(advance.remainingPaise)}.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!bankId || (mode === 'pay' && !reference.trim()) || (mode === 'repay' && !amount)} loading={run.isPending} loadingText="Saving…" onClick={() => run.mutate(undefined, { onSuccess: onClose })}>
            {mode === 'pay' ? 'Record Payment' : 'Record Repayment'}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {mode === 'repay' && <MoneyField label="Amount paid back" required value={amount} onChange={setAmount} />}
        <ComboboxField label="Bank account" required value={bankId} onChange={setBankId} placeholder="Choose…" searchPlaceholder="Search accounts…" options={(banks.data ?? []).filter((b) => b.status === 'ACTIVE').map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))} />
        <TextField label="Bank reference" required={mode === 'pay'} value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
        {run.error && <ErrorBanner error={run.error} />}
      </div>
    </Modal>
  );
}

export function AdvancesTab() {
  const { can } = useAuth();
  const list = useAdvances();
  const [adding, setAdding] = useState(false);
  const [paying, setPaying] = useState<{ advance: AdvanceDTO; mode: 'pay' | 'repay' } | null>(null);
  const approve = useFinanceMutation((id: string) => payApi.approveAdvance(id), { success: 'Advance approved. Pay it out from the bank, then record it.' });
  return (
    <div className="space-y-4">
      <TabIntro title="Advances">{ADVANCES_INTRO}</TabIntro>
      <Can permission="payroll:input:manage">
        <Button size="sm" onClick={() => setAdding(true)}>
          <Plus /> New Advance
        </Button>
      </Can>
      {list.isLoading && <Skeleton className="h-24" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      {list.data && list.data.length === 0 && <EmptyState title="No advances" description="Money given early to a staff member appears here with what is left to recover." />}
      {list.data && list.data.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white" aria-label="Advances">
          {list.data.map((a) => (
            <li key={a.advanceId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <b>{a.employeeName}</b>
              <Money paise={a.principalPaise} strong />
              <span className="text-muted">
                {a.installments} × {formatMoney(a.installmentPaise)} from {monthName(a.startMonth)} · left <b className="text-ink">{formatMoney(a.remainingPaise)}</b> · {a.reason}
              </span>
              <FinanceStatusPill status={a.state} />
              <span className="ml-auto flex gap-2">
                {a.state === 'REQUESTED' && can('payroll:run:approve') && (
                  <Button size="sm" variant="outline" loading={approve.isPending && approve.variables === a.advanceId} loadingText="Saving…" onClick={() => approve.mutate(a.advanceId)} aria-label={`Approve ${a.employeeName}'s advance`}>
                    Approve
                  </Button>
                )}
                {a.state === 'APPROVED' && can('payroll:disbursement:manage') && (
                  <Button size="sm" onClick={() => setPaying({ advance: a, mode: 'pay' })}>
                    Record Payment
                  </Button>
                )}
                {a.state === 'PAID_OUT' && a.remainingPaise > 0 && can('payroll:disbursement:manage') && (
                  <Button size="sm" variant="outline" onClick={() => setPaying({ advance: a, mode: 'repay' })}>
                    Early Repayment
                  </Button>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {adding && <NewAdvance onClose={() => setAdding(false)} />}
      {paying && <PayDialog advance={paying.advance} mode={paying.mode} onClose={() => setPaying(null)} />}
    </div>
  );
}
