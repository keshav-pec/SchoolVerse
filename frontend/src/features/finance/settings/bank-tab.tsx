import { useState } from 'react';
import { Eye, Landmark, Pencil, Plus, Wallet } from 'lucide-react';
import { BANK_PURPOSES, type BankAccountDTO, type BankPurpose, type CashAccountDTO, type MasterLocationDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useActiveLocations } from '../../academic/api';
import { financeApi, useBankAccounts, useCashAccounts, useFinanceMutation } from '../api';
import { BANK_INTRO, BANK_PURPOSE_LABELS } from '../help-copy';

const campusNames = (ids: string[], locations: MasterLocationDTO[]) => (ids.length === 0 ? 'Every campus' : ids.map((id) => locations.find((l) => l.locationId === id)?.displayName ?? 'A campus').join(', '));

/** Campus chips: leave all unticked for "every campus". */
function CampusChips({ value, onChange, locations }: { value: string[]; onChange: (ids: string[]) => void; locations: MasterLocationDTO[] }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-semibold">Which campuses use it?</legend>
      <p className="text-[13px] text-muted">Leave all unticked for every campus.</p>
      <div className="flex flex-wrap gap-2">
        {locations.map((l) => {
          const on = value.includes(l.locationId);
          return (
            <label key={l.locationId} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-pill border px-3 text-sm ${on ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-line bg-white'}`}>
              <input type="checkbox" className="sr-only" checked={on} onChange={(e) => onChange(e.target.checked ? [...value, l.locationId] : value.filter((i) => i !== l.locationId))} />
              {l.displayName}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

/** Bank & Cash: the school's bank accounts and cash boxes. The full account number stays hidden. */
export function BankTab() {
  const banks = useBankAccounts();
  const cash = useCashAccounts();
  const locations = useActiveLocations();
  const [editing, setEditing] = useState<BankAccountDTO | 'new' | null>(null);
  const [revealing, setRevealing] = useState<BankAccountDTO | null>(null);
  const [cashEdit, setCashEdit] = useState<CashAccountDTO | 'new' | null>(null);
  const locs = locations.data ?? [];

  return (
    <div className="space-y-4">
      <TabIntro title="Bank & Cash" need="required">
        {BANK_INTRO}
      </TabIntro>
      <Card>
        <CardHeader>
          <HelpHeading title="Bank accounts" help={<p>Fees and salaries move through these accounts. Changing the account number or IFSC needs a second person to approve.</p>} />
          <Can permission="finance:setup:manage">
            <Button onClick={() => setEditing('new')}>
              <Plus /> Add Bank Account
            </Button>
          </Can>
        </CardHeader>
        {banks.isLoading && <Skeleton className="h-28" role="status" aria-label="Loading" />}
        {banks.isError && <ErrorState error={banks.error} onRetry={() => void banks.refetch()} retrying={banks.isFetching} />}
        {banks.data?.length === 0 && <EmptyState title="No bank account yet" description="Add the account where the school receives fees. Parents are shown where to pay from it." />}
        <ul className="grid gap-3 md:grid-cols-2" aria-label="Bank accounts">
          {banks.data?.map((b) => (
            <li key={b.bankAccountId} className="rounded-xl border border-line p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-bold">
                    <Landmark className="size-4 text-brand" aria-hidden="true" /> {b.label}
                  </p>
                  <p className="text-sm text-muted">{b.bankName}</p>
                </div>
                <FinanceStatusPill status={b.status} />
              </div>
              <p className="mt-2 text-lg font-bold tracking-wider tabular-nums" aria-label={`Account number ending ${b.accountNumberMasked.slice(-4)}`}>
                {b.accountNumberMasked}
              </p>
              <p className="text-[13px] text-muted">
                IFSC {b.ifsc} · {BANK_PURPOSE_LABELS[b.purpose]} · {campusNames(b.locationIds, locs)}
              </p>
              {b.pendingApprovalId && (
                <Alert tone="warning" className="mt-2" title="A change is waiting for approval">
                  The account number or IFSC will change after a second person approves it.
                </Alert>
              )}
              <div className="mt-3 flex flex-wrap gap-2">
                <Can permission="finance:setup:manage">
                  <Button size="sm" variant="outline" onClick={() => setRevealing(b)} aria-label={`Show the full number of ${b.label}`}>
                    <Eye /> Show
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(b)} aria-label={`Edit ${b.label}`}>
                    <Pencil /> Edit
                  </Button>
                </Can>
              </div>
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <HelpHeading title="Cash boxes" help={<p>Where cash from the fee counter is kept until it is deposited in the bank.</p>} />
          <Can permission="finance:setup:manage">
            <Button variant="outline" onClick={() => setCashEdit('new')}>
              <Plus /> Add Cash Box
            </Button>
          </Can>
        </CardHeader>
        {cash.data?.length === 0 && <p className="text-sm text-muted">No cash box yet.</p>}
        <ul className="divide-y divide-line text-sm" aria-label="Cash boxes">
          {cash.data?.map((c) => (
            <li key={c.cashAccountId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <Wallet className="size-4 text-brand" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <b>{c.label}</b> <span className="text-muted">· {campusNames(c.locationIds, locs)}</span>
              </span>
              <FinanceStatusPill status={c.status} />
              <Can permission="finance:setup:manage">
                <Button size="sm" variant="outline" onClick={() => setCashEdit(c)} aria-label={`Edit ${c.label}`}>
                  <Pencil /> Edit
                </Button>
              </Can>
            </li>
          ))}
        </ul>
      </Card>

      <BankModal target={editing} onClose={() => setEditing(null)} locations={locs} />
      <RevealModal bank={revealing} onClose={() => setRevealing(null)} />
      <CashModal target={cashEdit} onClose={() => setCashEdit(null)} locations={locs} />
    </div>
  );
}

function BankModal({ target, onClose, locations }: { target: BankAccountDTO | 'new' | null; onClose: () => void; locations: MasterLocationDTO[] }) {
  return (
    <Modal open={target !== null} onOpenChange={(o) => !o && onClose()} title={target === 'new' ? 'Add a bank account' : 'Edit bank account'} description="The full number is kept safe. Only the last four digits are shown." className="max-w-xl">
      {target && <BankForm key={target === 'new' ? 'new' : target.bankAccountId} bank={target === 'new' ? null : target} onClose={onClose} locations={locations} />}
    </Modal>
  );
}

function BankForm({ bank, onClose, locations }: { bank: BankAccountDTO | null; onClose: () => void; locations: MasterLocationDTO[] }) {
  const [label, setLabel] = useState(bank?.label ?? '');
  const [bankName, setBankName] = useState(bank?.bankName ?? '');
  const [holder, setHolder] = useState(bank?.holderName ?? '');
  const [number, setNumber] = useState('');
  const [ifsc, setIfsc] = useState(bank?.ifsc ?? '');
  const [purpose, setPurpose] = useState<BankPurpose>(bank?.purpose ?? 'FEES');
  const [campuses, setCampuses] = useState<string[]>(bank?.locationIds ?? []);
  const [active, setActive] = useState(bank ? bank.status === 'ACTIVE' : true);
  const [error, setError] = useState<unknown>(null);
  const [waiting, setWaiting] = useState(false);
  const save = useFinanceMutation(
    async () => {
      if (!bank) return financeApi.createBank({ label: label.trim(), bankName: bankName.trim(), holderName: holder.trim() || null, accountNumber: number.trim(), ifsc: ifsc.trim().toUpperCase(), purpose, locationIds: campuses });
      await financeApi.updateBank(bank.bankAccountId, { label: label.trim(), bankName: bankName.trim(), holderName: holder.trim() || null, purpose, locationIds: campuses, status: active ? 'ACTIVE' : 'INACTIVE' });
      const wantsNumber = number.trim() !== '';
      const wantsIfsc = ifsc.trim().toUpperCase() !== bank.ifsc;
      if (wantsNumber || wantsIfsc) return financeApi.updateBank(bank.bankAccountId, { ...(wantsNumber ? { accountNumber: number.trim() } : {}), ...(wantsIfsc ? { ifsc: ifsc.trim().toUpperCase() } : {}) });
      return null;
    },
    { success: bank ? 'Bank account saved.' : 'Bank account added.', quiet: true },
  );
  const ready = label.trim() !== '' && bankName.trim() !== '' && (bank ? true : /^\d{6,20}$/.test(number.trim()) && ifsc.trim() !== '');

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Name for this account" required value={label} onChange={(e) => setLabel(e.target.value)} hint="Example: Fee collection account." maxLength={80} />
        <TextField label="Bank" required value={bankName} onChange={(e) => setBankName(e.target.value)} hint="Example: State Bank of India." maxLength={100} />
        <TextField label="Account holder" value={holder} onChange={(e) => setHolder(e.target.value)} hint="Optional." maxLength={100} />
        <ComboboxField label="Used for" value={purpose} onChange={(v) => setPurpose(v as BankPurpose)} options={BANK_PURPOSES.map((p) => ({ value: p, label: BANK_PURPOSE_LABELS[p] ?? p }))} searchPlaceholder="Search…" />
        <TextField
          label={bank ? 'New account number' : 'Account number'}
          required={!bank}
          value={number}
          onChange={(e) => setNumber(e.target.value.replace(/\s/g, ''))}
          inputMode="numeric"
          autoComplete="off"
          hint={bank ? 'Leave empty to keep the same number. Changing it needs approval.' : '6 to 20 digits.'}
          maxLength={20}
        />
        <TextField label="IFSC" required={!bank} value={ifsc} onChange={(e) => setIfsc(e.target.value.toUpperCase())} hint={bank ? 'Changing the IFSC needs approval.' : 'Example: SBIN0001234.'} maxLength={11} />
      </div>
      <CampusChips value={campuses} onChange={setCampuses} locations={locations} />
      {bank && (
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={active} onChange={(e) => setActive(e.target.checked)} /> Switched on
        </label>
      )}
      {waiting && (
        <Alert tone="warning" title="This needs approval">
          The other details were saved. The account number or IFSC will change after a second person approves it in Settings → Approvals.
        </Alert>
      )}
      {!waiting && !!error && <Alert tone="danger">{messageFor(error)}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          {waiting ? 'Close' : 'Cancel'}
        </Button>
        {!waiting && (
          <Button
            disabled={!ready}
            loading={save.isPending}
            loadingText="Saving…"
            onClick={async () => {
              setError(null);
              try {
                await save.mutateAsync();
                onClose();
              } catch (e) {
                if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') setWaiting(true);
                else setError(e);
              }
            }}
          >
            {bank ? 'Save Changes' : 'Add Bank Account'}
          </Button>
        )}
      </div>
    </div>
  );
}

/** Show the full number: it needs a reason, and the school writes the reason down. */
function RevealModal({ bank, onClose }: { bank: BankAccountDTO | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [number, setNumber] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reveal = useFinanceMutation((v: { id: string; reason: string }) => financeApi.revealBank(v.id, v.reason), { quiet: true });
  const close = () => {
    setReason('');
    setNumber(null);
    setError(null);
    onClose();
  };
  return (
    <Modal open={bank !== null} onOpenChange={(o) => !o && close()} title="Show the full account number" description={bank ? `${bank.label} · ${bank.accountNumberMasked}` : undefined}>
      {number ? (
        <div className="space-y-3">
          <p className="rounded-xl bg-canvas px-4 py-3 text-xl font-bold tracking-wider tabular-nums" data-testid="revealed-number">
            {number}
          </p>
          <p className="text-[13px] text-muted">This is hidden again when you close this box.</p>
          <div className="flex justify-end">
            <Button onClick={close}>Hide And Close</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <TextareaField label="Why do you need to see it?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="The reason is written in the school’s record." maxLength={300} />
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={reason.trim() === ''}
              loading={reveal.isPending}
              loadingText="Opening…"
              onClick={async () => {
                setError(null);
                try {
                  setNumber((await reveal.mutateAsync({ id: bank!.bankAccountId, reason: reason.trim() })).accountNumber);
                } catch (e) {
                  setError(messageFor(e));
                }
              }}
            >
              Show Number
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function CashModal({ target, onClose, locations }: { target: CashAccountDTO | 'new' | null; onClose: () => void; locations: MasterLocationDTO[] }) {
  return (
    <Modal open={target !== null} onOpenChange={(o) => !o && onClose()} title={target === 'new' ? 'Add a cash box' : 'Edit cash box'}>
      {target && <CashForm key={target === 'new' ? 'new' : target.cashAccountId} cash={target === 'new' ? null : target} onClose={onClose} locations={locations} />}
    </Modal>
  );
}

function CashForm({ cash, onClose, locations }: { cash: CashAccountDTO | null; onClose: () => void; locations: MasterLocationDTO[] }) {
  const [label, setLabel] = useState(cash?.label ?? '');
  const [campuses, setCampuses] = useState<string[]>(cash?.locationIds ?? []);
  const [active, setActive] = useState(cash ? cash.status === 'ACTIVE' : true);
  const [error, setError] = useState<string | null>(null);
  const save = useFinanceMutation(() => (cash ? financeApi.updateCash(cash.cashAccountId, { label: label.trim(), locationIds: campuses, status: active ? 'ACTIVE' : 'INACTIVE' }) : financeApi.createCash({ label: label.trim(), locationIds: campuses })), { success: 'Cash box saved.', quiet: true });
  return (
    <div className="space-y-3">
      <TextField label="Name" required value={label} onChange={(e) => setLabel(e.target.value)} hint="Example: Front office cash." maxLength={80} />
      <CampusChips value={campuses} onChange={setCampuses} locations={locations} />
      {cash && (
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={active} onChange={(e) => setActive(e.target.checked)} /> Switched on
        </label>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={label.trim() === ''}
          loading={save.isPending}
          loadingText="Saving…"
          onClick={async () => {
            setError(null);
            try {
              await save.mutateAsync();
              onClose();
            } catch (e) {
              setError(messageFor(e));
            }
          }}
        >
          Save Cash Box
        </Button>
      </div>
    </div>
  );
}

