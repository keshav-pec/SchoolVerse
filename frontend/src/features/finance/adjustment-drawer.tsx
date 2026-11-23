import { useState } from 'react';
import { CircleCheck } from 'lucide-react';
import type { AdjustmentResultDTO, ApprovalRequestDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { ApprovalBanner } from '@/components/finance/approval-banner';
import { ImpactPreview } from '@/components/finance/impact-preview';
import { Money, MoneyField } from '@/components/finance/money';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { financeApi, useDocument, useFeeHeads, useFinanceMutation } from './api';
import { ADJUSTMENT_TYPE_LABELS, TIP_ISSUED_BILL } from './help-copy';

type Kind = 'CREDIT_NOTE' | 'WAIVER' | 'LATE_FEE_REVERSAL' | 'DEBIT_NOTE';

/**
 * New Adjustment, started from one bill. It shows the maths and the new balance BEFORE saving. There is no box that edits a
 * balance: a credit note lowers what is owed, a debit note adds a charge, and the bill itself never changes.
 */
export function AdjustmentDrawer({ documentId, onClose }: { documentId: string | null; onClose: () => void }) {
  return (
    <Drawer open={documentId !== null} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title="New adjustment" description="Correct a bill with a credit note or a debit note.">
        {documentId && <AdjustmentForm key={documentId} documentId={documentId} onClose={onClose} />}
      </DrawerContent>
    </Drawer>
  );
}

function AdjustmentForm({ documentId, onClose }: { documentId: string; onClose: () => void }) {
  const q = useDocument(documentId);
  const heads = useFeeHeads();
  const [kind, setKind] = useState<Kind>('CREDIT_NOTE');
  const [picked, setPicked] = useState<Record<string, number | null>>({});
  const [feeHeadId, setFeeHeadId] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState<number | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [approval, setApproval] = useState<{ id: string; waiting: Pick<ApprovalRequestDTO, 'summary' | 'requestedByName' | 'decision' | 'decisionReason'> } | null>(null);
  const [result, setResult] = useState<AdjustmentResultDTO | null>(null);
  const save = useFinanceMutation((body: Record<string, unknown>) => financeApi.createAdjustment(documentId, body), { quiet: true });

  const d = q.data;
  if (q.isLoading) return <DrawerBody><Skeleton className="h-48" role="status" aria-label="Loading" /></DrawerBody>;
  if (q.isError || !d) return <DrawerBody><ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /></DrawerBody>;

  if (d.kind === 'CREDIT_NOTE')
    return (
      <DrawerBody>
        <Alert tone="info" title="This is already a credit note">
          A credit note cannot be adjusted again. Open the bill it belongs to instead.
        </Alert>
      </DrawerBody>
    );

  const isDebit = kind === 'DEBIT_NOTE';
  const kinds: Kind[] = d.kind === 'LATE_FEE' ? ['CREDIT_NOTE', 'WAIVER', 'LATE_FEE_REVERSAL', 'DEBIT_NOTE'] : ['CREDIT_NOTE', 'WAIVER', 'DEBIT_NOTE'];
  const creditTotal = Object.values(picked).reduce<number>((s, v) => s + (v ?? 0), 0);
  const change = isDebit ? (amount ?? 0) : creditTotal;
  const newBalance = isDebit ? d.balancePaise + change : Math.max(0, d.balancePaise - change);
  const advance = !isDebit && change > d.balancePaise ? change - d.balancePaise : 0;

  const lineError = (lineId: string, total: number) => {
    const v = picked[lineId];
    if (v === null || v === undefined) return undefined;
    if (v <= 0) return 'Enter more than zero.';
    if (v > total) return `At most ${formatMoney(total)}.`;
    return undefined;
  };
  const creditLines = Object.entries(picked).filter(([, v]) => v !== undefined);
  const ready = reason.trim().length > 0 && (isDebit ? !!feeHeadId && description.trim().length > 0 && !!amount && amount > 0 : creditLines.length > 0 && creditLines.every(([, v]) => v !== null && v > 0) && d.lines.every((l) => !lineError(l.lineId, l.totalPaise)));

  const submit = async (approvalId?: string) => {
    setError(null);
    const body = isDebit
      ? { type: kind, reason: reason.trim(), lines: [{ feeHeadId, description: description.trim(), amountPaise: amount }] }
      : { type: kind, reason: reason.trim(), lines: creditLines.map(([lineId, v]) => ({ lineId, amountPaise: v })), ...(approvalId ? { approvalId } : {}) };
    try {
      setResult(await save.mutateAsync(body));
    } catch (e) {
      if (e instanceof ApiError && e.code === 'APPROVAL_REQUIRED') {
        const id = (e.details as { approvalId?: string } | undefined)?.approvalId;
        setApproval({ id: id ?? '', waiting: { summary: e.message, requestedByName: null, decision: 'PENDING', decisionReason: null } });
      } else setError(messageFor(e));
    }
  };

  if (result)
    return (
      <>
        <DrawerBody className="space-y-4">
          <Alert tone="success" title={`${ADJUSTMENT_TYPE_LABELS[result.type] ?? 'Adjustment'} ${result.newDocumentNumber} is saved`}>
            <span className="flex items-start gap-1.5">
              <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              The bill {d.number} now has <Money paise={result.billBalancePaise} strong /> left to pay.
              {result.advancePaise > 0 && <> {formatMoney(result.advancePaise)} is kept as an advance for the student.</>}
            </span>
          </Alert>
        </DrawerBody>
        <DrawerFooter>
          <Button onClick={onClose}>Done</Button>
        </DrawerFooter>
      </>
    );

  return (
    <>
      <DrawerBody className="space-y-4">
        <p className="rounded-xl bg-canvas px-4 py-3 text-sm">
          Bill <b>{d.number}</b> for <b>{d.studentName}</b>: total <Money paise={d.totalPaise} />, left to pay <Money paise={d.balancePaise} strong />.{' '}
          <InfoTip label="About an issued bill">{TIP_ISSUED_BILL}</InfoTip>
        </p>
        <ComboboxField
          label="What do you want to do?"
          value={kind}
          onChange={(v) => {
            setKind(v as Kind);
            setApproval(null);
            setError(null);
          }}
          options={kinds.map((k) => ({ value: k, label: ADJUSTMENT_TYPE_LABELS[k] ?? k, hint: k === 'DEBIT_NOTE' ? 'adds a charge' : 'lowers the bill' }))}
          searchPlaceholder="Search…"
          hint={isDebit ? 'A debit note adds a new charge to the family’s account.' : 'A credit note lowers what the family has to pay. The bill itself stays as it was.'}
        />

        {!isDebit ? (
          <fieldset className="space-y-2">
            <legend className="mb-1 text-sm font-semibold">Which fees?</legend>
            {d.lines.map((l) => {
              const on = picked[l.lineId] !== undefined;
              return (
                <div key={l.lineId} className="rounded-xl border border-line px-3 py-2">
                  <label className="flex items-center gap-3 text-sm">
                    <input
                      type="checkbox"
                      className="size-5 accent-[var(--color-brand)]"
                      checked={on}
                      onChange={(e) =>
                        setPicked((p) => {
                          const next = { ...p };
                          if (e.target.checked) next[l.lineId] = l.totalPaise;
                          else delete next[l.lineId];
                          return next;
                        })
                      }
                    />
                    <span className="min-w-0 flex-1">{l.description}</span>
                    <Money paise={l.totalPaise} />
                  </label>
                  {on && (
                    <MoneyField
                      label={`Amount to take off “${l.description}”`}
                      value={picked[l.lineId] ?? null}
                      onChange={(v) => setPicked((p) => ({ ...p, [l.lineId]: v }))}
                      error={lineError(l.lineId, l.totalPaise)}
                      containerClassName="mt-2"
                    />
                  )}
                </div>
              );
            })}
          </fieldset>
        ) : (
          <div className="space-y-3">
            <ComboboxField
              label="Fee type"
              required
              value={feeHeadId}
              onChange={setFeeHeadId}
              placeholder="Choose…"
              searchPlaceholder="Search fee types…"
              options={(heads.data ?? []).filter((h) => h.status === 'ACTIVE').map((h) => ({ value: h.feeHeadId, label: h.name, hint: h.code }))}
            />
            <TextField label="What is it for?" required value={description} onChange={(e) => setDescription(e.target.value)} hint="Example: Lost library book." maxLength={150} />
            <MoneyField label="Amount" required value={amount} onChange={setAmount} hint="Tax is added by the system if the fee type is taxable." />
          </div>
        )}

        <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="This is written in the record, so someone can read it later." maxLength={300} />

        <ImpactPreview
          lines={[
            { label: 'Left to pay now', value: formatMoney(d.balancePaise) },
            { label: isDebit ? 'Charge added' : 'Taken off', value: formatMoney(change) },
            { label: 'Left to pay after', value: formatMoney(newBalance) },
          ]}
          note={
            advance > 0
              ? `${formatMoney(advance)} is more than is left to pay, so it will be kept as an advance for the student.`
              : isDebit
                ? 'A new debit note will be made. The old bill does not change.'
                : 'A new credit note will be made. The old bill does not change.'
          }
        />

        {approval && (
          <div className="space-y-2">
            <ApprovalBanner approval={{ ...approval.waiting, summary: 'This amount needs a second person to approve it. The request was sent.' }} />
            <p className="text-sm text-muted">After it is approved, press <b>Save Again</b>. Nothing has been changed yet.</p>
          </div>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={() => void submit(approval?.id || undefined)} disabled={!ready} loading={save.isPending} loadingText="Saving…">
          {approval ? 'Save Again' : isDebit ? 'Save Debit Note' : 'Save Credit Note'}
        </Button>
      </DrawerFooter>
    </>
  );
}
