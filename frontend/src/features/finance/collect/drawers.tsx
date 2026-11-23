import { useState } from 'react';
import { BellRing } from 'lucide-react';
import type { ClaimDTO, ReminderPreviewDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { Money, MoneyField } from '@/components/finance/money';
import { formatMoney } from '@/lib/money';
import { useStudentContext } from '../../students/context';
import { useFinanceMutation } from '../api';
import { ErrorBanner } from '../error-banner';
import { TIP_CLAIM_VS_COLLECTION } from '../help-copy';
import { collectApi } from '../ops-api';
import { todayLocal } from './shared';

/**
 * Report Claim (staff): a parent says they paid by UPI or bank transfer, at the office or on the phone. It goes into the
 * Waiting for Verification queue. Nothing is received until someone sees the money in the bank.
 */
export function ClaimDrawer({ student, open, onClose }: { student: { studentId: string; studentName: string }; open: boolean; onClose: () => void }) {
  const [amount, setAmount] = useState<number | null>(null);
  const [method, setMethod] = useState('UPI');
  const [paidOn, setPaidOn] = useState(todayLocal());
  const [reference, setReference] = useState('');
  const [saved, setSaved] = useState<ClaimDTO | null>(null);
  const save = useFinanceMutation((body: Record<string, unknown>) => collectApi.createClaim(body), { quiet: true });
  const close = () => {
    setSaved(null);
    setAmount(null);
    setReference('');
    onClose();
  };
  return (
    <Drawer open={open} onOpenChange={(o) => !o && close()}>
      <DrawerContent title="Report a payment" description={`The family of ${student.studentName} says they paid. It waits until someone checks the bank.`}>
        <DrawerBody className="space-y-4">
          {saved ? (
            <Alert tone="warning" title="Awaiting school verification">
              {formatMoney(saved.amountPaise)} is in the Waiting for Verification list.
              {saved.flags.includes('DUPLICATE_SUSPECTED') && ' It looks like a payment reported before, so it is marked for a careful check.'}
            </Alert>
          ) : (
            <>
              <p className="flex items-center gap-1.5 text-sm text-muted">
                A report is not money yet. <InfoTip label="About claims and payments">{TIP_CLAIM_VS_COLLECTION}</InfoTip>
              </p>
              <MoneyField label="Amount paid" required value={amount} onChange={setAmount} />
              <ComboboxField
                label="How did they pay?"
                value={method}
                onChange={setMethod}
                searchPlaceholder="Search…"
                options={[
                  { value: 'UPI', label: 'UPI' },
                  { value: 'NEFT', label: 'Bank transfer (NEFT)' },
                  { value: 'IMPS', label: 'Bank transfer (IMPS)' },
                  { value: 'BANK_DEPOSIT', label: 'Paid into bank' },
                ]}
              />
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Date paid" type="date" required value={paidOn} max={todayLocal()} onChange={(e) => setPaidOn(e.target.value)} />
                <TextField label="Reference (UTR)" value={reference} onChange={(e) => setReference(e.target.value)} hint="From the parent’s payment screen." maxLength={60} />
              </div>
              {save.error && <ErrorBanner error={save.error} />}
            </>
          )}
        </DrawerBody>
        <DrawerFooter>
          {saved ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button
                disabled={!amount || !paidOn}
                loading={save.isPending}
                loadingText="Saving…"
                onClick={() => save.mutate({ students: [{ studentId: student.studentId, amountPaise: amount }], method, amountPaise: amount, paidOn, ...(reference.trim() ? { reference: reference.trim() } : {}) }, { onSuccess: setSaved })}
              >
                Report Payment
              </Button>
            </>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** Reminders: preview who will be reminded and how many rupees, then send. Only families with an email get one. */
export function RemindersDrawer({ open, onClose, highlightStudentId }: { open: boolean; onClose: () => void; highlightStudentId?: string }) {
  const ctx = useStudentContext();
  const [days, setDays] = useState('7');
  const [preview, setPreview] = useState<ReminderPreviewDTO | null>(null);
  const body = { minDaysOverdue: Number(days) || 0, ...(ctx.locationId ? { locationId: ctx.locationId } : {}) };
  const look = useFinanceMutation(() => collectApi.previewReminders(body), { quiet: true });
  const send = useFinanceMutation(() => collectApi.sendReminders(body), { success: (r) => `Sent ${r.sent} reminder${r.sent === 1 ? '' : 's'}.${r.skipped ? ` ${r.skipped} had no email.` : ''}` });
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title="Send reminders" description="A polite email to families whose bills are late.">
        <DrawerBody className="space-y-4">
          <div className="flex items-end gap-2">
            <TextField label="Late by at least (days)" type="number" min={0} max={365} value={days} onChange={(e) => { setDays(e.target.value); setPreview(null); }} containerClassName="w-48" />
            <Button variant="outline" loading={look.isPending} loadingText="Checking…" onClick={() => look.mutate(undefined, { onSuccess: setPreview })}>
              See Who
            </Button>
          </div>
          {look.error && <ErrorBanner error={look.error} />}
          {preview && (
            <>
              <p className="text-[15px]" aria-live="polite">
                <b>{preview.count}</b> {preview.count === 1 ? 'family' : 'families'} · <b>{formatMoney(preview.totalPaise)}</b> late
              </p>
              <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm" aria-label="Who will be reminded">
                {preview.items.map((i) => (
                  <li key={i.studentId} className={`flex flex-wrap items-center gap-x-3 px-3 py-2 ${i.studentId === highlightStudentId ? 'bg-brand-soft' : ''}`}>
                    <b>{i.studentName}</b>
                    <span className="text-muted">
                      {i.guardianName ?? 'No parent'} · {i.guardianEmail ?? 'no email, will be skipped'} · {i.oldestDaysLate} days late
                    </span>
                    <Money paise={i.overduePaise} strong className="ml-auto" />
                  </li>
                ))}
              </ul>
            </>
          )}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button disabled={!preview || preview.count === 0} loading={send.isPending} loadingText="Sending…" onClick={() => send.mutate(undefined, { onSuccess: onClose })}>
            <BellRing /> Send {preview?.count ?? ''} Reminders
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
