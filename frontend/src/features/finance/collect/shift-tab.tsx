import { useState } from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { ShiftDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { useBankAccounts, useFinanceMutation } from '../api';
import { ErrorBanner } from '../error-banner';
import { SHIFT_INTRO } from '../help-copy';
import { collectApi, useMyShift, useShifts } from '../ops-api';
import { Fact, todayLocal } from './shared';
import { OpenShiftStep } from './take-payment';

/** The result of closing a shift. Kept by the tab, because the shift itself disappears from "your shift" once it is closed. */
function ClosedShift({ closed }: { closed: ShiftDTO }) {
  return (
    <Alert tone={closed.variancePaise === 0 ? 'success' : 'warning'} title="Shift closed">
      {closed.sentence ?? `Expected ${formatMoney(closed.expectedPaise)}, counted ${formatMoney(closed.countedPaise ?? 0)}.`}
      {closed.state === 'CLOSED' && ' A supervisor will sign it off.'}
    </Alert>
  );
}

function CloseShift({ shift, onClosed }: { shift: ShiftDTO; onClosed: (s: ShiftDTO) => void }) {
  const [counted, setCounted] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const close = useFinanceMutation((body: { countedPaise: number; note?: string }) => collectApi.closeShift(shift.shiftId, body), { quiet: true });
  const variance = counted === null ? null : counted - shift.expectedPaise;
  return (
    <section aria-label="Close your shift" className="space-y-3">
      <MoneyField label="Cash you counted in the drawer" required value={counted} onChange={setCounted} hint="Count every note and coin, including the float." />
      {variance !== null && (
        <p className={`flex items-center gap-2 rounded-xl px-4 py-3 text-sm ${variance === 0 ? 'bg-success-soft text-success' : 'bg-danger-soft text-danger'}`} data-testid="shift-variance" aria-live="polite">
          {variance === 0 ? <CircleCheck className="size-4" aria-hidden="true" /> : <TriangleAlert className="size-4" aria-hidden="true" />}
          Expected {formatMoney(shift.expectedPaise)} · counted {formatMoney(counted!)} ·{' '}
          {variance === 0 ? 'it matches.' : variance < 0 ? `${formatMoney(-variance)} short.` : `${formatMoney(variance)} extra.`}
        </p>
      )}
      {variance !== null && variance !== 0 && <TextareaField label="Why is it different?" required value={note} onChange={(e) => setNote(e.target.value)} hint="Example: Gave ₹100 change twice by mistake." maxLength={300} />}
      {close.error && <ErrorBanner error={close.error} />}
      <Button
        disabled={counted === null || (variance !== 0 && !note.trim())}
        loading={close.isPending}
        loadingText="Closing…"
        onClick={() => close.mutate({ countedPaise: counted!, ...(note.trim() ? { note: note.trim() } : {}) }, { onSuccess: onClosed })}
      >
        Close Shift
      </Button>
    </section>
  );
}

/** For supervisors: closed shifts to sign off, and cash to take to the bank. */
function SupervisorPanel() {
  const closed = useShifts({ state: 'CLOSED' });
  const signed = useShifts({ state: 'SIGNED_OFF' });
  const banks = useBankAccounts();
  const signOff = useFinanceMutation((id: string) => collectApi.signOff(id), { success: 'Signed off.' });
  const [picked, setPicked] = useState<string[]>([]);
  const [bankId, setBankId] = useState('');
  const [reference, setReference] = useState('');
  const deposit = useFinanceMutation((body: Record<string, unknown>) => collectApi.createDeposit(body), { success: 'Deposit recorded. It will be matched with the bank statement.' });
  const toDeposit = (signed.data?.items ?? []).filter((s) => (s.countedPaise ?? 0) - s.depositedPaise > 0);
  const total = toDeposit.filter((s) => picked.includes(s.shiftId)).reduce((sum, s) => sum + (s.countedPaise ?? 0) - s.depositedPaise, 0);
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Shifts to sign off</CardTitle>
        </CardHeader>
        {closed.isLoading ? (
          <Skeleton className="h-16" />
        ) : (closed.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">No shift is waiting. A shift whose cash matched is signed off by itself.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Shifts to sign off">
            {closed.data!.items.map((s) => (
              <li key={s.shiftId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <b>{s.cashierName}</b>
                <span className="text-muted">{s.sentence}</span>
                {s.varianceNote && <span className="text-muted">“{s.varianceNote}”</span>}
                <Button size="sm" className="ml-auto" loading={signOff.isPending && signOff.variables === s.shiftId} loadingText="Saving…" onClick={() => signOff.mutate(s.shiftId)} aria-label={`Sign off ${s.cashierName}'s shift`}>
                  Sign Off
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Cash to deposit in the bank</CardTitle>
        </CardHeader>
        {toDeposit.length === 0 ? (
          <p className="text-sm text-muted">No counted cash is waiting to go to the bank.</p>
        ) : (
          <div className="space-y-3">
            <ul className="space-y-1" aria-label="Cash to deposit">
              {toDeposit.map((s) => (
                <li key={s.shiftId}>
                  <label className="flex items-center gap-3 text-sm">
                    <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={picked.includes(s.shiftId)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, s.shiftId] : p.filter((x) => x !== s.shiftId)))} />
                    {s.cashierName} · {formatDateTime(s.closedAt)} <Money paise={(s.countedPaise ?? 0) - s.depositedPaise} strong className="ml-auto" />
                  </label>
                </li>
              ))}
            </ul>
            <div className="grid gap-3 sm:grid-cols-2">
              <ComboboxField label="Deposited into" value={bankId} onChange={setBankId} placeholder="Choose…" searchPlaceholder="Search accounts…" options={(banks.data ?? []).filter((b) => b.status === 'ACTIVE').map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))} />
              <TextField label="Deposit slip number" value={reference} onChange={(e) => setReference(e.target.value)} hint="Optional." maxLength={60} />
            </div>
            <Button
              disabled={total <= 0 || !bankId}
              loading={deposit.isPending}
              loadingText="Saving…"
              onClick={() => deposit.mutate({ shiftIds: picked, bankAccountId: bankId, amountPaise: total, depositedOn: todayLocal(), ...(reference.trim() ? { reference: reference.trim() } : {}) }, { onSuccess: () => setPicked([]) })}
            >
              Record Deposit of {formatMoney(total)}
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

/** My Shift: open, see what came in, close with the counted cash. The expected-vs-counted difference is shown in rupees. */
export function ShiftTab() {
  const { can } = useAuth();
  const mine = useMyShift(can('finance:cashier:shift'));
  const s = mine.data;
  const [closed, setClosed] = useState<ShiftDTO | null>(null);
  return (
    <div className="space-y-4">
      <TabIntro title="My Shift">{SHIFT_INTRO}</TabIntro>
      <Can permission="finance:cashier:shift">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">Your shift {s && <FinanceStatusPill status={s.state} />}</CardTitle>
          </CardHeader>
          {mine.isLoading && <Skeleton className="h-24" />}
          {mine.isError && <ErrorState error={mine.error} onRetry={() => void mine.refetch()} retrying={mine.isFetching} />}
          {closed && <ClosedShift closed={closed} />}
          {!mine.isLoading && !s && <div className={closed ? 'mt-3' : undefined}><OpenShiftStep /></div>}
          {s && (
            <div className="space-y-4">
              <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Fact label="Opened">{formatDateTime(s.openedAt)}</Fact>
                <Fact label="Float at start">{formatMoney(s.openingPaise)}</Fact>
                <Fact label="Cash taken">{formatMoney(s.collectedPaise)}</Fact>
                <Fact label="Cash paid out">{formatMoney(s.refundedPaise)}</Fact>
              </dl>
              <p className="rounded-xl bg-canvas px-4 py-3 text-[15px]">
                The drawer should have <b>{formatMoney(s.expectedPaise)}</b> now.
              </p>
              <CloseShift
                shift={s}
                onClosed={(c) => setClosed(c)}
              />
            </div>
          )}
        </Card>
      </Can>
      <Can permission="finance:cashier:supervise">
        <SupervisorPanel />
      </Can>
    </div>
  );
}
