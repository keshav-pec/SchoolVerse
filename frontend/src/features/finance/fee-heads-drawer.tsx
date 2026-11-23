import { useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { FEE_CATEGORIES, PRICE_MODES, type FeeCategory, type FeeHeadDTO, type PriceMode } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { ErrorState } from '@/components/sv/error-state';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { messageFor } from '@/lib/errors';
import { financeApi, useChart, useFeeHeads, useFinanceMutation, useTaxCodes } from './api';
import { FEE_CATEGORY_LABELS, TIP_FEE_HEAD, TIP_PRICE_INCLUDES_TAX, TIP_TAX_CODE } from './help-copy';

/** The fee types (heads) of the school, in a side drawer inside Fee Plans. Used fee types can be switched off, never deleted. */
export function FeeHeadsDrawer({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const heads = useFeeHeads();
  const [editing, setEditing] = useState<FeeHeadDTO | 'new' | null>(null);
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="Fee types" description="Each kind of charge, such as Tuition or Transport.">
        {editing ? (
          <HeadForm key={editing === 'new' ? 'new' : editing.feeHeadId} head={editing === 'new' ? null : editing} onDone={() => setEditing(null)} />
        ) : (
          <>
            <DrawerBody className="space-y-3">
              <p className="flex items-center gap-1 text-sm text-muted">
                What is a fee type? <InfoTip label="About a fee type">{TIP_FEE_HEAD}</InfoTip>
              </p>
              {heads.isLoading && <Skeleton className="h-32" role="status" aria-label="Loading" />}
              {heads.isError && <ErrorState error={heads.error} onRetry={() => void heads.refetch()} retrying={heads.isFetching} />}
              {heads.data?.length === 0 && <p className="text-sm text-muted">No fee types yet. Add Tuition first.</p>}
              <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Fee types">
                {heads.data?.map((h) => (
                  <li key={h.feeHeadId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">
                        {h.name} <span className="font-mono text-[13px] font-normal text-muted">{h.code}</span>
                      </p>
                      <p className="text-[13px] text-muted">
                        {FEE_CATEGORY_LABELS[h.category]} · {h.taxCodeName ?? (h.isRefundableDeposit ? 'Refundable deposit, not income' : 'No tax setting yet')}
                      </p>
                    </div>
                    {!h.taxCodeId && !h.isRefundableDeposit && <Badge tone="warning">Needs a tax code</Badge>}
                    {h.isOptional && <Badge tone="neutral">Optional</Badge>}
                    <FinanceStatusPill status={h.status} />
                    <Can permission="finance:fee_plan:manage">
                      <Button size="sm" variant="outline" onClick={() => setEditing(h)} aria-label={`Edit ${h.name}`}>
                        <Pencil /> Edit
                      </Button>
                    </Can>
                  </li>
                ))}
              </ul>
            </DrawerBody>
            <DrawerFooter>
              <Can permission="finance:fee_plan:manage">
                <Button onClick={() => setEditing('new')}>
                  <Plus /> Add Fee Type
                </Button>
              </Can>
            </DrawerFooter>
          </>
        )}
      </DrawerContent>
    </Drawer>
  );
}

function HeadForm({ head, onDone }: { head: FeeHeadDTO | null; onDone: () => void }) {
  const chart = useChart();
  const taxCodes = useTaxCodes();
  const [name, setName] = useState(head?.name ?? '');
  const [code, setCode] = useState(head?.code ?? '');
  const [category, setCategory] = useState<FeeCategory>(head?.category ?? 'OTHER');
  const [deposit, setDeposit] = useState(head?.isRefundableDeposit ?? false);
  const [accountId, setAccountId] = useState(head?.incomeAccountId ?? '');
  const [taxCodeId, setTaxCodeId] = useState(head?.taxCodeId ?? '');
  const [priceMode, setPriceMode] = useState<PriceMode>(head?.priceMode ?? 'EXCLUSIVE');
  const [recurring, setRecurring] = useState(head?.isRecurring ?? false);
  const [optional, setOptional] = useState(head?.isOptional ?? false);
  const [active, setActive] = useState(head ? head.status === 'ACTIVE' : true);
  const [error, setError] = useState<string | null>(null);
  const save = useFinanceMutation((body: Record<string, unknown>) => (head ? financeApi.updateFeeHead(head.feeHeadId, body) : financeApi.createFeeHead(body)), { success: head ? 'Fee type saved.' : 'Fee type added.', quiet: true });

  const wanted = deposit ? 'LIABILITY' : 'INCOME';
  const accounts = (chart.data ?? []).filter((a) => a.type === wanted && a.isPostable && a.status === 'ACTIVE');
  const ready = name.trim() !== '' && (head ? true : /^[A-Za-z0-9_]{2,20}$/.test(code.trim())) && accountId !== '' && (deposit || taxCodeId !== '');

  const submit = async () => {
    setError(null);
    try {
      await save.mutateAsync(
        head
          ? { name: name.trim(), category, incomeAccountId: accountId, taxCodeId: taxCodeId || null, priceMode, isRecurring: recurring, isOptional: optional, status: active ? 'ACTIVE' : 'INACTIVE' }
          : { code: code.trim().toUpperCase(), name: name.trim(), category, incomeAccountId: accountId, taxCodeId: taxCodeId || null, priceMode, isRecurring: recurring, isOptional: optional, isRefundableDeposit: deposit },
      );
      onDone();
    } catch (e) {
      setError(messageFor(e));
    }
  };

  return (
    <>
      <DrawerBody className="space-y-4">
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: Tuition Fee." maxLength={80} />
        {!head && <TextField label="Short code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} hint="Capital letters or numbers. Example: TUITION." maxLength={20} />}
        <ComboboxField label="Kind of fee" value={category} onChange={(v) => setCategory(v as FeeCategory)} options={FEE_CATEGORIES.map((c) => ({ value: c, label: FEE_CATEGORY_LABELS[c] ?? c }))} searchPlaceholder="Search…" />
        {!head && (
          <label className="flex items-start gap-3 text-sm">
            <input type="checkbox" className="mt-0.5 size-5 accent-[var(--color-brand)]" checked={deposit} onChange={(e) => { setDeposit(e.target.checked); setAccountId(''); }} />
            <span>
              <b>Refundable deposit</b>
              <span className="block text-[13px] text-muted">The money is held for the student and given back later. It is not income, and it has no tax.</span>
            </span>
          </label>
        )}
        <ComboboxField
          label={deposit ? 'Where the deposit is held' : 'Income account'}
          required
          value={accountId}
          onChange={setAccountId}
          placeholder="Choose…"
          searchPlaceholder="Search accounts…"
          options={accounts.map((a) => ({ value: a.accountId, label: a.name, hint: a.code }))}
          hint={chart.data && accounts.length === 0 ? 'No account is available. Use the standard chart in Settings first.' : 'This is where the money is recorded.'}
        />
        {!deposit && (
          <>
            <ComboboxField
              label="Tax code"
              required
              labelAside={<InfoTip label="About the tax code">{TIP_TAX_CODE}</InfoTip>}
              value={taxCodeId}
              onChange={setTaxCodeId}
              placeholder="Choose…"
              searchPlaceholder="Search tax codes…"
              options={(taxCodes.data ?? []).filter((c) => c.status === 'ACTIVE').map((c) => ({ value: c.taxCodeId, label: c.name, hint: c.rateBps ? `${c.rateBps / 100}%` : undefined }))}
              hint="A fee type with no tax code cannot be billed."
            />
            <ComboboxField
              label="Is tax added on top?"
              labelAside={<InfoTip label="About price and tax">{TIP_PRICE_INCLUDES_TAX}</InfoTip>}
              value={priceMode}
              onChange={(v) => setPriceMode(v as PriceMode)}
              options={PRICE_MODES.map((m) => ({ value: m, label: m === 'EXCLUSIVE' ? 'Tax added on top' : 'Price includes tax' }))}
              searchPlaceholder="Search…"
            />
          </>
        )}
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={recurring} onChange={(e) => setRecurring(e.target.checked)} /> Charged again and again, such as every month
        </label>
        <label className="flex items-center gap-3 text-sm">
          <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={optional} onChange={(e) => setOptional(e.target.checked)} /> Optional. A student pays it only if chosen, like Transport
        </label>
        {head && (
          <label className="flex items-center gap-3 text-sm">
            <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={active} onChange={(e) => setActive(e.target.checked)} /> Switched on
          </label>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onDone}>
          Back
        </Button>
        <Button disabled={!ready} loading={save.isPending} loadingText="Saving…" onClick={() => void submit()}>
          {head ? 'Save Changes' : 'Add Fee Type'}
        </Button>
      </DrawerFooter>
    </>
  );
}
