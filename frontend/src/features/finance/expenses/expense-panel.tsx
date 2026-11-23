import { useState } from 'react';
import { CircleCheck, Hourglass } from 'lucide-react';
import type { ExpenseDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { MoneyField } from '@/components/finance/money';
import { formatMoney, percentTextToBps } from '@/lib/money';
import { useStudentContext } from '../../students/context';
import { useBankAccounts, useCashAccounts, useFinanceMutation } from '../api';
import { ChoiceCards, todayLocal } from '../collect/shared';
import { ErrorBanner } from '../error-banner';
import { EXPENSE_MODE_LABELS, TIP_ITC } from '../help-copy';
import { spendApi, useExpenseCategories, useVendors } from '../ops-api';

type Itc = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'NEEDS_REVIEW';

/**
 * Add Expense: one fast panel. Amount → Category → Date → Vendor → Receipt photo. The legal entity, campus, month and account are
 * filled in for you. Tax lines appear only when the purchase has GST, with the ITC choice.
 */
export function ExpensePanel() {
  const ctx = useStudentContext();
  const categories = useExpenseCategories();
  const vendors = useVendors();
  const banks = useBankAccounts();
  const cash = useCashAccounts();
  const [amount, setAmount] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [vendorId, setVendorId] = useState('');
  const [description, setDescription] = useState('');
  const [mode, setMode] = useState<'BANK' | 'CASH' | 'UNPAID'>('BANK');
  const [from, setFrom] = useState('');
  const [gst, setGst] = useState(false);
  const [rate, setRate] = useState('18');
  const [itc, setItc] = useState<Itc>('NEEDS_REVIEW');
  const [photo, setPhoto] = useState<File | null>(null);
  const [saved, setSaved] = useState<ExpenseDTO | null>(null);
  const save = useFinanceMutation(async (body: Record<string, unknown>) => {
    const e = await spendApi.createExpense(body);
    if (photo) {
      const form = new FormData();
      form.append('file', photo);
      return spendApi.attachEvidence(e.expenseId, form).catch(() => e);
    }
    return e;
  }, { quiet: true });

  const category = categories.data?.find((c) => c.categoryId === categoryId);
  const activeBanks = (banks.data ?? []).filter((b) => b.status === 'ACTIVE');
  const activeCash = (cash.data ?? []).filter((c) => c.status === 'ACTIVE');
  const account = from || (mode === 'BANK' ? activeBanks.find((b) => b.purpose === 'OPERATING')?.bankAccountId ?? activeBanks[0]?.bankAccountId : activeCash[0]?.cashAccountId) || '';
  const bps = gst ? percentTextToBps(rate) ?? 0 : 0;
  const taxPaise = amount ? Math.round((amount * bps) / 10000) : 0;
  const ready = !!amount && !!categoryId && !!date && !!ctx.locationId && (mode !== 'UNPAID' || !!vendorId) && (mode !== 'BANK' || !!account);

  const reset = () => {
    setSaved(null);
    setAmount(null);
    setDescription('');
    setVendorId('');
    setGst(false);
    setPhoto(null);
  };
  const submit = () =>
    save.mutate(
      {
        categoryId,
        taxableValuePaise: amount,
        date,
        description: description.trim() || category?.name || 'Expense',
        ...(vendorId ? { vendorId } : {}),
        locationId: ctx.locationId,
        paymentMode: mode,
        ...(mode === 'BANK' ? { bankAccountId: account } : mode === 'CASH' && account ? { cashAccountId: account } : {}),
        gstRateBps: bps,
        ...(gst ? { itcStatus: itc } : {}),
      },
      { onSuccess: setSaved },
    );

  if (saved)
    return (
      <Card aria-label="Expense saved">
        {saved.needsApproval && !saved.approved ? (
          <Alert tone="warning" title={`${saved.number} · Waiting for approval`}>
            <span className="flex items-start gap-1.5">
              <Hourglass className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {formatMoney(saved.totalPaise)} is over the limit, so a different person must approve it before it is booked.
            </span>
          </Alert>
        ) : saved.waitingForItc ? (
          <Alert tone="warning" title={`${saved.number} · Waiting for a tax decision`}>
            Someone must decide whether to claim the GST before this is booked. Open Tax & GST.
          </Alert>
        ) : (
          <Alert tone="success" title={`${saved.number} is booked`}>
            <span className="flex items-start gap-1.5">
              <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" /> {formatMoney(saved.totalPaise)} for {saved.categoryName}.
            </span>
          </Alert>
        )}
        <Button className="mt-3" onClick={reset}>
          Add Another
        </Button>
      </Card>
    );

  return (
    <Card aria-label="Add expense">
      <CardHeader>
        <CardTitle>Add Expense</CardTitle>
      </CardHeader>
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <MoneyField label="Amount" required value={amount} onChange={setAmount} hint={gst ? 'Before GST.' : undefined} />
          <ComboboxField
            label="Category"
            required
            value={categoryId}
            onChange={setCategoryId}
            placeholder="Choose…"
            searchPlaceholder="Search categories…"
            options={(categories.data ?? []).filter((c) => c.status === 'ACTIVE').map((c) => ({ value: c.categoryId, label: c.name, hint: c.accountName ?? undefined }))}
          />
          <TextField label="Date" type="date" required value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} />
          <ComboboxField label="Vendor" value={vendorId} onChange={setVendorId} placeholder="No vendor" searchPlaceholder="Search vendors…" options={[{ value: '', label: 'No vendor' }, ...(vendors.data ?? []).filter((v) => v.status === 'ACTIVE').map((v) => ({ value: v.vendorId, label: v.name, hint: v.gstin ?? undefined }))]} hint={mode === 'UNPAID' ? 'Needed when it is not paid yet.' : 'Optional.'} />
          <TextField label="What for?" value={description} onChange={(e) => setDescription(e.target.value)} hint="Optional. Example: Electricity bill October." maxLength={150} />
          <div className="space-y-1.5">
            <label htmlFor="expense-photo" className="text-sm font-semibold text-ink">
              Receipt photo
            </label>
            <input id="expense-photo" type="file" accept="image/*,application/pdf" capture="environment" className="block w-full text-sm" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
            <p className="text-[13px] text-muted">Optional. A photo of the bill or receipt.</p>
          </div>
        </div>
        <ChoiceCards<'BANK' | 'CASH' | 'UNPAID'>
          label="How was it paid?"
          value={mode}
          onChange={(m) => {
            setMode(m);
            setFrom('');
          }}
          className="sm:grid-cols-3"
          options={(['BANK', 'CASH', 'UNPAID'] as const).map((m) => ({ value: m, label: EXPENSE_MODE_LABELS[m]! }))}
        />
        {mode !== 'UNPAID' && (
          <ComboboxField
            label={mode === 'BANK' ? 'Bank account' : 'Cash box'}
            value={account}
            onChange={setFrom}
            searchPlaceholder="Search…"
            options={mode === 'BANK' ? activeBanks.map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked })) : activeCash.map((c) => ({ value: c.cashAccountId, label: c.label }))}
            containerClassName="max-w-sm"
          />
        )}
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={gst} onChange={(e) => setGst(e.target.checked)} />
          This bill has GST
        </label>
        {gst && (
          <section aria-label="GST on this purchase" className="space-y-3 rounded-xl border border-line p-3">
            <div className="flex flex-wrap items-end gap-3">
              <TextField label="GST rate %" value={rate} onChange={(e) => setRate(e.target.value)} containerClassName="w-28" inputMode="decimal" />
              <p className="pb-2 text-sm">
                GST {formatMoney(taxPaise)} · total {formatMoney((amount ?? 0) + taxPaise)}
              </p>
            </div>
            <p className="flex items-center gap-1 text-sm font-semibold">
              Claim this GST back? <InfoTip label="About ITC">{TIP_ITC}</InfoTip>
            </p>
            <ChoiceCards<Itc>
              label="ITC choice"
              value={itc}
              onChange={setItc}
              className="sm:grid-cols-3"
              options={[
                { value: 'ELIGIBLE', label: 'Claim', hint: 'Set off against GST owed' },
                { value: 'NOT_ELIGIBLE', label: 'Don’t Claim', hint: 'Added to the cost' },
                { value: 'NEEDS_REVIEW', label: 'Decide Later', hint: 'Waits for the accountant' },
              ]}
            />
          </section>
        )}
        {!ctx.locationId && <Alert tone="warning">Choose a campus in the bar at the top first.</Alert>}
        {save.error && <ErrorBanner error={save.error} />}
        <Button disabled={!ready} loading={save.isPending} loadingText="Saving…" onClick={submit}>
          Save Expense
        </Button>
      </div>
    </Card>
  );
}
