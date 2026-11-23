import { useState } from 'react';
import { Printer, Search } from 'lucide-react';
import { toast } from 'sonner';
import type { ReceiptDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { TextareaField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Pager } from '@/components/sv/pager';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { openPdf, useFinanceMutation } from '../api';
import { useApprovalFlow } from '../approval-flow';
import { METHOD_LABELS, RECEIPTS_INTRO } from '../help-copy';
import { collectApi, useReceipts } from '../ops-api';

function CancelDialog({ receipt, onClose }: { receipt: ReceiptDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const flow = useApprovalFlow();
  const run = useFinanceMutation((approvalId: string | undefined) => collectApi.cancelReceipt(receipt.receiptId, { reason: reason.trim(), ...(approvalId ? { approvalId } : {}) }), { quiet: true, success: `Receipt ${receipt.number} is cancelled.` });
  const submit = async () => {
    if (await flow.run((approvalId) => run.mutateAsync(approvalId))) onClose();
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Cancel receipt ${receipt.number}`}
      description={`${formatMoney(receipt.amountPaise)} received on ${formatDateOnly(receipt.receivedOn)}. The receipt stays in the records, marked cancelled, and the bills it paid become unpaid again.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Keep Receipt
          </Button>
          <Button variant="destructive" disabled={!reason.trim()} loading={run.isPending} loadingText="Cancelling…" onClick={() => void submit()}>
            {flow.label('Cancel Receipt')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Entered for the wrong student." maxLength={300} />
        <p className="text-[13px] text-muted">Big amounts need a second person to say yes.</p>
        {flow.banner}
        {flow.errorBox}
      </div>
    </Modal>
  );
}

/** Every receipt: search, open the PDF, cancel with a reason. A receipt never changes; a cancel is a separate record. */
export function ReceiptsTab() {
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 300);
  const [page, setPage] = useState(1);
  const list = useReceipts({ q: q || undefined, page });
  const [cancel, setCancel] = useState<ReceiptDTO | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  const open = async (id: string) => {
    setOpening(id);
    try {
      await openPdf(`/finance/receipts/${id}/pdf`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setOpening(null);
    }
  };
  return (
    <div className="space-y-4">
      <TabIntro title="Receipts">{RECEIPTS_INTRO}</TabIntro>
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input
          aria-label="Search receipts"
          className="pl-10"
          placeholder="Receipt number or reference…"
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setPage(1);
          }}
        />
      </div>
      {list.isLoading && <Skeleton className="h-32" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      {list.data && list.data.items.length === 0 && <EmptyState title={q ? 'No receipt matches' : 'No receipts yet'} description="A receipt is made when cash is taken, a transfer is verified or a cheque clears." />}
      {list.data && list.data.items.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white" aria-label="Receipts">
          {list.data.items.map((r) => (
            <li key={r.receiptId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-sm">
              <b>{r.number}</b>
              <Money paise={r.amountPaise} strong />
              <span className="text-muted">
                {formatDateOnly(r.receivedOn)} · {METHOD_LABELS[r.method] ?? r.method} · {[...new Set(r.lines.map((l) => l.studentName))].join(', ') || r.payerName || 'Advance'}
              </span>
              <FinanceStatusPill status={r.status} />
              {r.cancelledReason && <span className="text-muted">“{r.cancelledReason}”</span>}
              <span className="ml-auto flex gap-2">
                <Button size="sm" variant="outline" onClick={() => void open(r.receiptId)} loading={opening === r.receiptId} loadingText="Opening…" aria-label={`Open receipt ${r.number}`}>
                  <Printer /> Open
                </Button>
                {r.status === 'ISSUED' && (
                  <Can permission="finance:receipt:cancel">
                    <Button size="sm" variant="outline" onClick={() => setCancel(r)} aria-label={`Cancel receipt ${r.number}`}>
                      Cancel
                    </Button>
                  </Can>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
      {cancel && <CancelDialog receipt={cancel} onClose={() => setCancel(null)} />}
    </div>
  );
}
