import { useState } from 'react';
import type { CollectionDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Pager } from '@/components/sv/pager';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useFinanceMutation } from '../api';
import { useApprovalFlow } from '../approval-flow';
import { ErrorBanner } from '../error-banner';
import { CHEQUES_INTRO } from '../help-copy';
import { collectApi, useCollections } from '../ops-api';
import { todayLocal } from './shared';

const STATES = [
  { id: 'RECEIVED', label: 'Received' },
  { id: 'DEPOSITED', label: 'Deposited' },
  { id: 'CLEARED', label: 'Cleared' },
  { id: 'RETURNED', label: 'Returned' },
] as const;

function ClearDialog({ cheque, onClose }: { cheque: CollectionDTO; onClose: () => void }) {
  const [date, setDate] = useState(todayLocal());
  const run = useFinanceMutation(() => collectApi.clear(cheque.collectionId, { clearedOn: date }), { success: (r) => (r.receipt ? `Cleared. Receipt ${r.receipt.number} is issued.` : 'Cleared.') });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Cheque ${cheque.cheque?.number ?? ''} cleared`}
      description="Do this only when the money shows in the school’s bank. The receipt is made now and the bills are paid."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={run.isPending} loadingText="Saving…" disabled={!date} onClick={() => run.mutate(undefined, { onSuccess: onClose })}>
            Mark Cleared
          </Button>
        </>
      }
    >
      <TextField label="Cleared on" type="date" required value={date} max={todayLocal()} onChange={(e) => setDate(e.target.value)} />
      {run.error && <ErrorBanner error={run.error} className="mt-3" />}
    </Modal>
  );
}

function ReturnDialog({ cheque, onClose }: { cheque: CollectionDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [charge, setCharge] = useState<number | null>(null);
  const flow = useApprovalFlow();
  const run = useFinanceMutation((approvalId: string | undefined) => collectApi.returnCheque(cheque.collectionId, { reason: reason.trim(), returnedOn: todayLocal(), ...(charge ? { chargePaise: charge } : {}), ...(approvalId ? { approvalId } : {}) }), {
    quiet: true,
    success: 'Marked returned. The bills are unpaid again.',
  });
  const submit = async () => {
    const done = await flow.run((approvalId) => run.mutateAsync(approvalId));
    if (done) onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Cheque ${cheque.cheque?.number ?? ''} returned`}
      description={cheque.status === 'CLEARED' ? 'The money is taken back and the bills it paid become unpaid again. The receipt is cancelled.' : 'No receipt was made, so only the cheque is marked returned.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!reason.trim()} loading={run.isPending} loadingText="Saving…" onClick={() => void submit()}>
            {flow.label('Mark Returned')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextareaField label="Why did the bank return it?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Not enough money in the account." maxLength={200} />
        <MoneyField label="Bank charge to add to the family’s account" value={charge} onChange={setCharge} hint="Optional. Example: ₹500 for a returned cheque." />
        {flow.banner}
        {flow.errorBox}
      </div>
    </Modal>
  );
}

/** Cheques by state, with Deposit, Clear and Return. A receipt is made only after a cheque clears. */
export function ChequesTab() {
  const [state, setState] = useState<(typeof STATES)[number]['id']>('RECEIVED');
  const [page, setPage] = useState(1);
  const list = useCollections({ method: 'CHEQUE', status: state, page });
  const [clearing, setClearing] = useState<CollectionDTO | null>(null);
  const [returning, setReturning] = useState<CollectionDTO | null>(null);
  const deposit = useFinanceMutation((id: string) => collectApi.deposit(id, { depositedOn: todayLocal() }), { success: 'Marked as deposited in the bank.' });
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));

  return (
    <div className="space-y-4">
      <TabIntro title="Cheques">{CHEQUES_INTRO}</TabIntro>
      <div role="tablist" aria-label="Cheque state" className="flex flex-wrap gap-2">
        {STATES.map((s) => (
          <button
            key={s.id}
            type="button"
            role="tab"
            aria-selected={state === s.id}
            onClick={() => {
              setState(s.id);
              setPage(1);
            }}
            className={cn('rounded-lg border px-3 py-1.5 text-sm font-semibold', state === s.id ? 'border-brand bg-brand text-white' : 'border-line bg-white hover:border-brand/40')}
          >
            {s.label}
          </button>
        ))}
      </div>
      {list.isLoading && <Skeleton className="h-32" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      {list.data && list.data.items.length === 0 && <EmptyState title="No cheques here" description="Cheques taken at the counter appear here until they clear." />}
      {list.data && list.data.items.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white" aria-label="Cheques">
          {list.data.items.map((c) => (
            <li key={c.collectionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <Money paise={c.amountPaise} strong />
              <b>Cheque {c.cheque?.number}</b>
              <span className="text-muted">
                {c.cheque?.bankName} · dated {formatDateOnly(c.cheque?.chequeDate)} · {c.students.map((s) => s.studentName).join(', ')}
                {c.provisionalNumber ? ` · ${c.provisionalNumber}` : ''}
              </span>
              <FinanceStatusPill status={c.status} />
              {c.receiptNumber && <span className="text-success">Receipt {c.receiptNumber}</span>}
              {c.returnedReason && <span className="text-danger">“{c.returnedReason}”</span>}
              <Can permission="finance:collection:verify">
                <span className="ml-auto flex flex-wrap gap-2">
                  {c.status === 'RECEIVED' && (
                    <Button size="sm" variant="outline" loading={deposit.isPending && deposit.variables === c.collectionId} loadingText="Saving…" onClick={() => deposit.mutate(c.collectionId)}>
                      Deposit
                    </Button>
                  )}
                  {(c.status === 'RECEIVED' || c.status === 'DEPOSITED') && (
                    <Button size="sm" onClick={() => setClearing(c)} aria-label={`Clear cheque ${c.cheque?.number} for ${formatMoney(c.amountPaise)}`}>
                      Clear
                    </Button>
                  )}
                  {(c.status === 'RECEIVED' || c.status === 'DEPOSITED' || c.status === 'CLEARED') && (
                    <Button size="sm" variant="outline" onClick={() => setReturning(c)} aria-label={`Return cheque ${c.cheque?.number}`}>
                      Return
                    </Button>
                  )}
                </span>
              </Can>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
      {clearing && <ClearDialog cheque={clearing} onClose={() => setClearing(null)} />}
      {returning && <ReturnDialog cheque={returning} onClose={() => setReturning(null)} />}
    </div>
  );
}
