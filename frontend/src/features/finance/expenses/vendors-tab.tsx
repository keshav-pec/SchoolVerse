import { useState } from 'react';
import { Plus } from 'lucide-react';
import { AGING_BUCKETS, type VendorDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { formatDateOnly } from '@/lib/format';
import { formatMoney, percentTextToBps } from '@/lib/money';
import { useStudentContext } from '../../students/context';
import { useBankAccounts, useFinanceMutation } from '../api';
import { useApprovalFlow } from '../approval-flow';
import { todayLocal } from '../collect/shared';
import { ErrorBanner } from '../error-banner';
import { GST_STATE_OPTIONS } from '../states';
import { AGING_LABELS, VENDORS_INTRO } from '../help-copy';
import { spendApi, useExpenseCategories, usePayablesAging, useVendorBills, useVendors } from '../ops-api';

function VendorDialog({ vendor, onClose }: { vendor: VendorDTO | null; onClose: () => void }) {
  const [f, setF] = useState({ name: vendor?.name ?? '', gstin: vendor?.gstin ?? '', stateCode: vendor?.stateCode ?? '', pan: '', contactName: vendor?.contactName ?? '', phone: vendor?.phone ?? '', bankAccountNumber: '', bankIfsc: '', bankName: vendor?.bankName ?? '' });
  const flow = useApprovalFlow();
  const save = useFinanceMutation((approvalId: string | undefined) => {
    const body: Record<string, unknown> = { name: f.name.trim(), gstin: f.gstin.trim() || null, stateCode: f.stateCode || null, contactName: f.contactName.trim() || null, phone: f.phone.trim() || null, bankName: f.bankName.trim() || null };
    if (f.pan.trim()) body.pan = f.pan.trim();
    if (f.bankAccountNumber.trim()) body.bankAccountNumber = f.bankAccountNumber.trim();
    if (f.bankIfsc.trim()) body.bankIfsc = f.bankIfsc.trim();
    if (approvalId) body.approvalId = approvalId;
    return vendor ? spendApi.updateVendor(vendor.vendorId, body) : spendApi.createVendor(body);
  }, { quiet: true, success: 'Vendor saved.' });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={vendor ? `Edit ${vendor.name}` : 'New vendor'}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            {flow.waiting ? 'Close' : 'Cancel'}
          </Button>
          {!flow.waiting && (
            <Button disabled={!f.name.trim()} loading={save.isPending} loadingText="Saving…" onClick={() => void flow.run((id) => save.mutateAsync(id)).then((r) => r && onClose())}>
              Save Vendor
            </Button>
          )}
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name" required value={f.name} onChange={set('name')} maxLength={100} />
        <TextField label="GSTIN" value={f.gstin} onChange={set('gstin')} hint="Optional. 15 letters and numbers." maxLength={15} />
        <ComboboxField label="State" value={f.stateCode} onChange={(v) => setF({ ...f, stateCode: v })} placeholder="Choose…" searchPlaceholder="Search states…" options={GST_STATE_OPTIONS} hint="Decides CGST + SGST or IGST." />
        <TextField label="PAN" value={f.pan} onChange={set('pan')} hint={vendor?.pan ? `Saved: ${vendor.pan}. Leave empty to keep it.` : 'Optional.'} maxLength={10} />
        <TextField label="Contact person" value={f.contactName} onChange={set('contactName')} maxLength={80} />
        <TextField label="Phone" value={f.phone} onChange={set('phone')} maxLength={20} />
        <TextField label="Bank account number" value={f.bankAccountNumber} onChange={set('bankAccountNumber')} hint={vendor?.bankAccountMasked ? `Saved: ${vendor.bankAccountMasked}. A change needs approval.` : 'Optional.'} inputMode="numeric" maxLength={20} />
        <TextField label="IFSC" value={f.bankIfsc} onChange={set('bankIfsc')} hint={vendor?.bankIfsc ? `Saved: ${vendor.bankIfsc}.` : 'Optional.'} maxLength={11} />
        <TextField label="Bank name" value={f.bankName} onChange={set('bankName')} maxLength={60} />
      </div>
      <div className="mt-3 space-y-2">
        {flow.waiting && <Alert tone="warning" title="Needs approval">Nothing has changed yet. The new bank details apply by themselves once a different person approves them in Settings → Approvals. To change other details now, save them with the bank fields left empty.</Alert>}
        {flow.errorBox}
      </div>
    </Modal>
  );
}

function BillDialog({ onClose }: { onClose: () => void }) {
  const ctx = useStudentContext();
  const vendors = useVendors();
  const categories = useExpenseCategories();
  const [vendorId, setVendorId] = useState('');
  const [number, setNumber] = useState('');
  const [date, setDate] = useState(todayLocal());
  const [due, setDue] = useState(todayLocal());
  const [lines, setLines] = useState([{ description: '', categoryId: '', amount: null as number | null, rate: '0' }]);
  const save = useFinanceMutation((body: Record<string, unknown>) => spendApi.createBill(body), { success: (b) => (b.needsApproval ? `Bill ${b.number} saved. It waits for approval.` : `Bill ${b.number} saved.`) });
  const ready = vendorId && number.trim() && ctx.locationId && lines.every((l) => l.description.trim() && l.categoryId && l.amount);
  const total = lines.reduce((s, l) => s + (l.amount ?? 0) + Math.round(((l.amount ?? 0) * (percentTextToBps(l.rate) ?? 0)) / 10000), 0);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Vendor bill"
      description="A bill the school must pay later."
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            loading={save.isPending}
            loadingText="Saving…"
            onClick={() => save.mutate({ vendorId, vendorBillNumber: number.trim(), date, dueDate: due, locationId: ctx.locationId, lines: lines.map((l) => ({ description: l.description.trim(), categoryId: l.categoryId, taxableValuePaise: l.amount, gstRateBps: percentTextToBps(l.rate) ?? 0 })) }, { onSuccess: onClose })}
          >
            Save Bill of {formatMoney(total)}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          <ComboboxField label="Vendor" required value={vendorId} onChange={setVendorId} placeholder="Choose…" searchPlaceholder="Search vendors…" options={(vendors.data ?? []).filter((v) => v.status === 'ACTIVE').map((v) => ({ value: v.vendorId, label: v.name }))} />
          <TextField label="Their bill number" required value={number} onChange={(e) => setNumber(e.target.value)} maxLength={40} />
          <TextField label="Bill date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          <TextField label="Pay by" type="date" required value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid gap-2 rounded-xl border border-line p-2 sm:grid-cols-[1fr_200px_140px_90px]">
            <TextField label="What" required value={l.description} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} maxLength={120} />
            <ComboboxField label="Category" required value={l.categoryId} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, categoryId: v } : x)))} placeholder="Choose…" searchPlaceholder="Search…" options={(categories.data ?? []).map((c) => ({ value: c.categoryId, label: c.name }))} />
            <MoneyField label="Amount" required value={l.amount} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, amount: v } : x)))} />
            <TextField label="GST %" value={l.rate} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, rate: e.target.value } : x)))} inputMode="decimal" />
          </div>
        ))}
        <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { description: '', categoryId: '', amount: null, rate: '0' }])}>
          <Plus /> Add Line
        </Button>
        {save.error && <ErrorBanner error={save.error} />}
      </div>
    </Modal>
  );
}

/** Pay a vendor: partial amounts allowed. Each open bill gets the amount you type; the total is what left the bank. */
function PayDialog({ vendor, onClose }: { vendor: VendorDTO; onClose: () => void }) {
  const bills = useVendorBills({ vendorId: vendor.vendorId, open: true });
  const banks = useBankAccounts();
  const [amounts, setAmounts] = useState<Record<string, number | null>>({});
  const [bankId, setBankId] = useState('');
  const [reference, setReference] = useState('');
  const [paidOn, setPaidOn] = useState(todayLocal());
  const pay = useFinanceMutation((body: Record<string, unknown>) => spendApi.payVendor(body), { success: (p) => `Payment ${p.number} recorded.` });
  const allocations = Object.entries(amounts).filter(([, v]) => v && v > 0).map(([billId, amountPaise]) => ({ billId, amountPaise }));
  const total = allocations.reduce((s, a) => s + (a.amountPaise ?? 0), 0);
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Pay ${vendor.name}`}
      description={`Owed ${formatMoney(vendor.payablePaise)}. Record this after the money has left the bank.`}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!bankId || !reference.trim() || allocations.length === 0} loading={pay.isPending} loadingText="Saving…" onClick={() => pay.mutate({ vendorId: vendor.vendorId, bankAccountId: bankId, reference: reference.trim(), paidOn, allocations }, { onSuccess: onClose })}>
            Record Payment of {formatMoney(total)}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        {bills.isLoading && <Skeleton className="h-16" />}
        {(bills.data?.items ?? []).map((b) => (
          <div key={b.billId} className="flex flex-wrap items-end gap-3 rounded-xl border border-line px-3 py-2 text-sm">
            <span className="min-w-40 flex-1">
              <b>{b.number}</b> <span className="text-muted">· their no. {b.vendorBillNumber} · due {formatDateOnly(b.dueDate)}</span>
              <span className="block">Left {formatMoney(b.balancePaise)}</span>
            </span>
            <MoneyField label={`Pay on ${b.number}`} value={amounts[b.billId] ?? null} onChange={(v) => setAmounts({ ...amounts, [b.billId]: v })} containerClassName="w-40" error={(amounts[b.billId] ?? 0) > b.balancePaise ? 'More than is left.' : undefined} />
            <Button size="sm" variant="ghost" onClick={() => setAmounts({ ...amounts, [b.billId]: b.balancePaise })}>
              All
            </Button>
          </div>
        ))}
        <div className="grid gap-3 sm:grid-cols-3">
          <ComboboxField label="Paid from" required value={bankId} onChange={setBankId} placeholder="Choose…" searchPlaceholder="Search accounts…" options={(banks.data ?? []).filter((b) => b.status === 'ACTIVE').map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))} />
          <TextField label="Bank reference" required value={reference} onChange={(e) => setReference(e.target.value)} maxLength={60} />
          <TextField label="Paid on" type="date" value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} />
        </div>
        {pay.error && <ErrorBanner error={pay.error} />}
      </div>
    </Modal>
  );
}

export function VendorsTab() {
  const vendors = useVendors();
  const bills = useVendorBills({ open: true });
  const aging = usePayablesAging();
  const [editing, setEditing] = useState<VendorDTO | null | 'new'>(null);
  const [billing, setBilling] = useState(false);
  const [paying, setPaying] = useState<VendorDTO | null>(null);
  const approve = useFinanceMutation((id: string) => spendApi.approveBill(id), { success: 'Bill approved and booked.' });
  return (
    <div className="space-y-4">
      <TabIntro title="Vendors & Bills">{VENDORS_INTRO}</TabIntro>
      <div className="flex flex-wrap gap-2">
        <Can permission="finance:vendor:manage">
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus /> New Vendor
          </Button>
        </Can>
        <Button size="sm" variant="outline" onClick={() => setBilling(true)}>
          <Plus /> Vendor Bill
        </Button>
      </div>
      <Card aria-label="Vendors">
        <CardHeader>
          <CardTitle>Vendors</CardTitle>
        </CardHeader>
        {vendors.isLoading ? (
          <Skeleton className="h-16" />
        ) : (vendors.data?.length ?? 0) === 0 ? (
          <EmptyState title="No vendors yet" description="Add the shops and suppliers the school buys from." />
        ) : (
          <ul className="divide-y divide-line text-sm" aria-label="Vendor list">
            {vendors.data!.map((v) => (
              <li key={v.vendorId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <b>{v.name}</b>
                <span className="min-w-0 flex-1 text-muted">
                  {[v.gstin, v.contactName, v.phone, v.bankAccountMasked ? `bank ${v.bankAccountMasked}` : null].filter(Boolean).join(' · ')}
                </span>
                {v.pendingApprovalId && <FinanceStatusPill status="PENDING" label="Bank change needs approval" />}
                <span>
                  Owed <Money paise={v.payablePaise} strong />
                </span>
                <Can permission="finance:vendor:manage">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(v)} aria-label={`Edit ${v.name}`}>
                    Edit
                  </Button>
                  {v.payablePaise > 0 && (
                    <Button size="sm" variant="outline" onClick={() => setPaying(v)} aria-label={`Pay ${v.name}`}>
                      Pay
                    </Button>
                  )}
                </Can>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card aria-label="Open bills">
        <CardHeader>
          <CardTitle>Bills not fully paid</CardTitle>
        </CardHeader>
        {(bills.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">No open bills.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {bills.data!.items.map((b) => (
              <li key={b.billId} className="flex flex-wrap items-center gap-x-3 py-2">
                <b>{b.number}</b>
                <span className="min-w-0 flex-1 text-muted">
                  {b.vendorName} · due {formatDateOnly(b.dueDate)} · total {formatMoney(b.totalPaise)}
                </span>
                <FinanceStatusPill status={b.state} />
                {b.waitingForItc && <FinanceStatusPill status="NEEDS_REVIEW" label="Tax decision needed" />}
                <span>
                  Left <Money paise={b.balancePaise} strong />
                </span>
                {b.state === 'PENDING' && b.needsApproval && !b.approved && (
                  <Can permission="finance:expense:approve">
                    <Button size="sm" variant="outline" loading={approve.isPending && approve.variables === b.billId} loadingText="Saving…" onClick={() => approve.mutate(b.billId)} aria-label={`Approve bill ${b.number}`}>
                      Approve
                    </Button>
                  </Can>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card aria-label="What the school owes, by age">
        <CardHeader>
          <CardTitle>What the school owes, by age</CardTitle>
        </CardHeader>
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {AGING_BUCKETS.map((k) => (
            <div key={k} className="rounded-xl bg-canvas px-3 py-2">
              <dt className="text-[13px] text-muted">{AGING_LABELS[k]}</dt>
              <dd className="font-bold tabular-nums">{formatMoney(aging.data?.buckets.find((b) => b.bucket === k)?.totalPaise ?? 0)}</dd>
            </div>
          ))}
        </dl>
      </Card>
      {editing && <VendorDialog vendor={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {billing && <BillDialog onClose={() => setBilling(false)} />}
      {paying && <PayDialog vendor={paying} onClose={() => setPaying(null)} />}
    </div>
  );
}
