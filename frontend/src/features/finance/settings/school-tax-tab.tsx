import { useState } from 'react';
import { Plus } from 'lucide-react';
import { LEGAL_FORMS, TAX_CATEGORIES, TAX_EXAMPLE_NOTE, type LegalEntityDTO, type LegalForm, type TaxCategory, type TaxCodeDTO, type TaxProfileDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { bpsToPercentText, percentTextToBps } from '@/lib/money';
import { financeApi, useFinanceMutation, useLegalEntity, useTaxCodes, useTaxProfile } from '../api';
import { SCHOOL_TAX_INTRO, TAX_CATEGORY_LABELS, TIP_TAX_CODE } from '../help-copy';
import { GST_STATE_OPTIONS } from '../states';

const FORM_LABELS: Record<LegalForm, string> = { TRUST: 'Trust', SOCIETY: 'Society', COMPANY: 'Company', PROPRIETORSHIP: 'Proprietorship', OTHER: 'Other' };

/** School & Tax: the legal name and state, GST (optional), and the tax codes the fee types use. */
export function SchoolTaxTab() {
  const entity = useLegalEntity();
  const profile = useTaxProfile();
  return (
    <div className="space-y-4">
      <TabIntro title="School & Tax" need="required">
        {SCHOOL_TAX_INTRO}
      </TabIntro>
      {(entity.isLoading || profile.isLoading) && <Skeleton className="h-48" role="status" aria-label="Loading" />}
      {entity.isError && <ErrorState error={entity.error} onRetry={() => void entity.refetch()} retrying={entity.isFetching} />}
      {entity.data && profile.data && <SchoolForm key={`${entity.data.name}-${profile.data.gstin ?? ''}-${profile.data.stateCode ?? ''}`} entity={entity.data} profile={profile.data} />}
      <TaxCodes />
    </div>
  );
}

function SchoolForm({ entity, profile }: { entity: LegalEntityDTO; profile: TaxProfileDTO }) {
  const { can } = useAuth();
  const [name, setName] = useState(entity.name);
  const [legalForm, setLegalForm] = useState<LegalForm>(entity.legalForm);
  const [address, setAddress] = useState(entity.address ?? '');
  const [pan, setPan] = useState('');
  const [stateCode, setStateCode] = useState(profile.stateCode ?? entity.stateCode ?? '');
  const [gst, setGst] = useState(profile.gstRegistered);
  const [gstin, setGstin] = useState(profile.gstin ?? '');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const save = useFinanceMutation(
    async () => {
      await financeApi.updateEntity({ name: name.trim(), legalForm, address: address.trim() || null, stateCode: stateCode || null, ...(pan.trim() ? { pan: pan.trim().toUpperCase() } : {}) });
      return financeApi.updateTaxProfile({ gstRegistered: gst, gstin: gst ? gstin.trim().toUpperCase() : null, stateCode: stateCode || null });
    },
    { success: 'School details saved.', quiet: true },
  );
  const canEdit = can('finance:setup:manage') && can('finance:tax:manage');
  return (
    <Card aria-label="School details">
      <CardHeader>
        <HelpHeading title="School details" help={<p>This is the school’s legal name as it will appear on bills. The state decides how GST is split: CGST + SGST inside the state.</p>} />
      </CardHeader>
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Legal name" required value={name} onChange={(e) => setName(e.target.value)} disabled={!canEdit} maxLength={150} />
        <ComboboxField label="Kind of organisation" value={legalForm} onChange={(v) => setLegalForm(v as LegalForm)} disabled={!canEdit} options={LEGAL_FORMS.map((f) => ({ value: f, label: FORM_LABELS[f] }))} searchPlaceholder="Search…" />
        <ComboboxField label="State" required value={stateCode} onChange={setStateCode} disabled={!canEdit} placeholder="Choose…" searchPlaceholder="Search states…" options={GST_STATE_OPTIONS} hint="Needed so tax can be worked out." />
        <TextField label="PAN" value={pan} onChange={(e) => setPan(e.target.value)} disabled={!canEdit} placeholder={entity.pan ?? 'ABCDE1234F'} hint={entity.pan ? `Saved as ${entity.pan}. Type a new one only to change it.` : 'Optional.'} maxLength={10} error={fields.pan} />
        <TextareaField containerClassName="sm:col-span-2" label="Address" value={address} onChange={(e) => setAddress(e.target.value)} disabled={!canEdit} hint="Optional. Printed on bills." maxLength={300} />
      </div>
      <div className="mt-4 rounded-xl border border-line px-4 py-3">
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-0.5 size-5 accent-[var(--color-brand)]" checked={gst} onChange={(e) => setGst(e.target.checked)} disabled={!canEdit} />
          <span>
            <b>The school is registered for GST</b>
            <span className="block text-[13px] text-muted">Leave this off if the school has no GSTIN. GST setup is optional then.</span>
          </span>
        </label>
        {gst && <TextField containerClassName="mt-3 max-w-sm" label="GSTIN" required value={gstin} onChange={(e) => setGstin(e.target.value.toUpperCase())} disabled={!canEdit} hint="15 letters and numbers, like 03AAAAA0000A1Z5." maxLength={15} error={fields.gstin} />}
      </div>
      {error && (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      )}
      <Can permission={['finance:setup:manage', 'finance:tax:manage']}>
        <div className="mt-4 flex justify-end">
          <Button
            disabled={name.trim() === '' || !stateCode || (gst && gstin.trim() === '')}
            loading={save.isPending}
            loadingText="Saving…"
            onClick={async () => {
              setError(null);
              setFields({});
              try {
                await save.mutateAsync();
              } catch (e) {
                const f = (e as { fieldErrors?: Record<string, string> }).fieldErrors ?? {};
                setFields(f);
                setError(Object.keys(f).length ? null : messageFor(e));
              }
            }}
          >
            Save Changes
          </Button>
        </div>
      </Can>
    </Card>
  );
}

function TaxCodes() {
  const codes = useTaxCodes();
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<TaxCodeDTO | null>(null);
  const end = useFinanceMutation((c: TaxCodeDTO) => financeApi.updateTaxCode(c.taxCodeId, { status: 'ENDED' }), { success: 'Tax code ended.', quiet: true });
  return (
    <Card aria-label="Tax codes">
      <CardHeader>
        <HelpHeading title="Tax codes" help={TIP_TAX_CODE} helpLabel="About tax codes" />
        <Can permission="finance:tax:manage">
          <Button variant="outline" onClick={() => setAdding(true)}>
            <Plus /> Add Tax Code
          </Button>
        </Can>
      </CardHeader>
      <Alert tone="warning" title="These are examples" className="mb-3">
        {TAX_EXAMPLE_NOTE} Most school tuition is usually exempt, but not everything is.
      </Alert>
      {codes.isLoading && <Skeleton className="h-24" />}
      {codes.isError && <ErrorState error={codes.error} onRetry={() => void codes.refetch()} retrying={codes.isFetching} />}
      <ul className="divide-y divide-line" aria-label="Tax codes">
        {codes.data?.map((c) => (
          <li key={c.taxCodeId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
            <div className="min-w-0 flex-1">
              <p className="font-semibold">
                {c.name} <span className="font-mono text-[13px] font-normal text-muted">{c.code}</span>
              </p>
              <p className="text-[13px] text-muted">
                {TAX_CATEGORY_LABELS[c.category]}
                {c.category === 'TAXABLE' ? ` · ${bpsToPercentText(c.rateBps)}%` : ''}
                {c.hsnSac ? ` · HSN/SAC ${c.hsnSac}` : ''} · {c.note || TAX_EXAMPLE_NOTE}
              </p>
            </div>
            {c.inUse && <Badge tone="neutral">In use</Badge>}
            <FinanceStatusPill status={c.status === 'ENDED' ? 'ENDED' : 'ACTIVE'} />
            {c.status === 'ACTIVE' && (
              <Can permission="finance:tax:manage">
                <Button size="sm" variant="outline" onClick={() => setEnding(c)} aria-label={`End ${c.name}`}>
                  End
                </Button>
              </Can>
            )}
          </li>
        ))}
      </ul>
      <AddTaxCode open={adding} onClose={() => setAdding(false)} />
      <ConfirmDialog
        open={ending !== null}
        onOpenChange={(o) => !o && setEnding(null)}
        title="End this tax code?"
        description="Fee types that already use it keep it on old bills. You cannot choose it for new fee types after this. A tax code is never deleted."
        confirmLabel="End Tax Code"
        loadingLabel="Ending…"
        tone="danger"
        onConfirm={async () => {
          await end.mutateAsync(ending!);
        }}
      />
    </Card>
  );
}

function AddTaxCode({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [category, setCategory] = useState<TaxCategory>('TAXABLE');
  const [rate, setRate] = useState('');
  const [hsn, setHsn] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useFinanceMutation((body: Record<string, unknown>) => financeApi.createTaxCode(body), { success: 'Tax code added.', quiet: true });
  const bps = category === 'TAXABLE' ? percentTextToBps(rate) : 0;
  const ready = /^[A-Za-z0-9_]{2,24}$/.test(code.trim()) && name.trim() !== '' && bps !== null && (category !== 'TAXABLE' || bps > 0);
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Add a tax code" description="Confirm the right code with your accountant.">
      <div className="space-y-3">
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: GST 12%." maxLength={100} />
        <TextField label="Short code" required value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} hint="Capital letters, numbers or underscores. Example: GST_12." maxLength={24} />
        <ComboboxField label="Kind" value={category} onChange={(v) => setCategory(v as TaxCategory)} options={TAX_CATEGORIES.map((c) => ({ value: c, label: TAX_CATEGORY_LABELS[c] ?? c }))} searchPlaceholder="Search…" />
        {category === 'TAXABLE' && <TextField label="Tax rate (%)" required value={rate} onChange={(e) => setRate(e.target.value)} inputMode="decimal" hint="Example: 18 for 18%." />}
        <TextField label="HSN / SAC code" value={hsn} onChange={(e) => setHsn(e.target.value)} hint="Optional." maxLength={12} />
        <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} hint="Optional." maxLength={200} />
        {error && <Alert tone="danger">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!ready}
            loading={add.isPending}
            loadingText="Adding…"
            onClick={async () => {
              setError(null);
              try {
                await add.mutateAsync({ code: code.trim().toUpperCase(), name: name.trim(), category, rateBps: bps ?? 0, ...(hsn.trim() ? { hsnSac: hsn.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
                setCode('');
                setName('');
                setRate('');
                onClose();
              } catch (e) {
                setError(messageFor(e));
              }
            }}
          >
            Add Tax Code
          </Button>
        </div>
      </div>
    </Modal>
  );
}
