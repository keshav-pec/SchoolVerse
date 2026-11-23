import { Link } from 'react-router';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent } from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { openPdf, useDocument, useJournal } from './api';
import { ADJUSTMENT_TYPE_LABELS, TIP_ISSUED_BILL } from './help-copy';
import { Modal } from '@/components/sv/modal';

/** One bill with its lines, the tax split, and a link to the entry in the books. An issued bill is read-only. */
export function BillDrawer({ documentId, onClose, onOpenJournal }: { documentId: string | null; onClose: () => void; onOpenJournal?: (journalId: string) => void }) {
  const q = useDocument(documentId ?? undefined);
  const [busy, setBusy] = useState(false);
  const d = q.data;
  const download = async () => {
    if (!d) return;
    setBusy(true);
    try {
      await openPdf(`/finance/fee-documents/${d.documentId}/pdf`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Drawer open={documentId !== null} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title={d ? `${d.kind === 'CREDIT_NOTE' ? 'Credit note' : d.kind === 'DEBIT_NOTE' ? 'Debit note' : d.isTaxInvoice ? 'Tax invoice' : 'Fee bill'} ${d.number}` : 'Bill'} description={d?.studentName}>
        <DrawerBody className="space-y-4">
          {q.isLoading && <Skeleton className="h-48" role="status" aria-label="Loading" />}
          {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
          {d && (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <FinanceStatusPill status={d.status} />
                {d.overdue && <FinanceStatusPill status="OVERDUE" />}
                <span className="text-sm text-muted">
                  Issued {formatDateOnly(d.issueDate)} · Due {formatDateOnly(d.dueDate)}
                </span>
                <InfoTip label="About an issued bill">{TIP_ISSUED_BILL}</InfoTip>
              </div>
              <div className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-canvas text-left text-[13px] text-muted">
                    <tr>
                      <th className="px-3 py-2 font-semibold">What</th>
                      <th className="px-3 py-2 text-right font-semibold">Price</th>
                      <th className="px-3 py-2 text-right font-semibold">Discount</th>
                      <th className="px-3 py-2 text-right font-semibold">Tax</th>
                      <th className="px-3 py-2 text-right font-semibold">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {d.lines.map((l) => (
                      <tr key={l.lineId}>
                        <td className="px-3 py-2">
                          <p className="font-medium">{l.description}</p>
                          {l.explanation && <p className="text-[13px] text-muted">{l.explanation}</p>}
                          {l.taxPaise > 0 && (
                            <p className="text-[13px] text-muted">
                              CGST <Money paise={l.cgstPaise} /> · SGST <Money paise={l.sgstPaise} />
                              {l.igstPaise > 0 && (
                                <>
                                  {' '}
                                  · IGST <Money paise={l.igstPaise} />
                                </>
                              )}
                            </p>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Money paise={l.basePaise} />
                        </td>
                        <td className="px-3 py-2 text-right">{l.discountPaise > 0 ? <Money paise={-l.discountPaise} /> : '—'}</td>
                        <td className="px-3 py-2 text-right">{l.taxPaise > 0 ? <Money paise={l.taxPaise} /> : '—'}</td>
                        <td className="px-3 py-2 text-right">
                          <Money paise={l.totalPaise} strong />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <dl className="grid grid-cols-3 gap-3 text-sm">
                <div className="rounded-xl bg-canvas px-3 py-2">
                  <dt className="text-[13px] text-muted">Total</dt>
                  <dd className="font-bold">
                    <Money paise={d.totalPaise} />
                  </dd>
                </div>
                <div className="rounded-xl bg-canvas px-3 py-2">
                  <dt className="text-[13px] text-muted">Paid</dt>
                  <dd className="font-bold">
                    <Money paise={d.paidPaise} />
                  </dd>
                </div>
                <div className="rounded-xl bg-canvas px-3 py-2">
                  <dt className="text-[13px] text-muted">Left to pay</dt>
                  <dd className="font-bold">
                    <Money paise={d.balancePaise} />
                  </dd>
                </div>
              </dl>
              {d.history.length > 0 && (
                <section aria-label="Changes made with a note">
                  <h3 className="mb-1 text-sm font-bold">Corrections to this bill</h3>
                  <ul className="space-y-1 text-sm">
                    {d.history.map((h) => (
                      <li key={h.adjustmentId} className="rounded-lg bg-canvas px-3 py-2">
                        <b>{ADJUSTMENT_TYPE_LABELS[h.type] ?? h.type}</b> <Money paise={h.amountPaise} /> · {h.reason}
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => void download()} loading={busy} loadingText="Opening…">
                  <Download /> Download PDF
                </Button>
                {d.journalId && onOpenJournal && (
                  <Button variant="ghost" onClick={() => onOpenJournal(d.journalId!)}>
                    See The Entry In The Books
                  </Button>
                )}
              </div>
            </>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

/** One entry in the books: what was debited and credited. Needs accounting access, so others see a plain message. */
/** Where a journal's source record lives, so an entry can be traced back to the bill, receipt, payslip or expense it came from. */
const SOURCE_PAGE: Record<string, { word: string; path: (id: string) => string }> = {
  collection: { word: 'Payment', path: () => '/finance/collect?tab=receipts' },
  refund: { word: 'Refund', path: () => '/finance/collect?tab=refunds' },
  cash_deposit: { word: 'Cash deposit', path: () => '/finance/collect?tab=shift' },
  student: { word: 'Student account', path: (id) => `/finance/fees/students/${id}` },
  payroll_run: { word: 'Payroll run', path: () => '/finance/payroll?tab=runs' },
  payroll_batch: { word: 'Salary payment', path: () => '/finance/payroll?tab=payments' },
  employee_advance: { word: 'Salary advance', path: () => '/finance/payroll?tab=advances' },
  expense: { word: 'Expense', path: () => '/finance/expenses' },
  vendor_bill: { word: 'Vendor bill', path: () => '/finance/expenses?tab=vendors' },
  vendor_payment: { word: 'Vendor payment', path: () => '/finance/expenses?tab=vendors' },
  gst_payment: { word: 'GST payment', path: () => '/finance/tax' },
  bank_statement_line: { word: 'Bank line', path: () => '/finance/banking' },
};

export function JournalModal({ journalId, onClose }: { journalId: string | null; onClose: () => void }) {
  const { can } = useAuth();
  const allowed = can('finance:accounting:view');
  const q = useJournal(allowed ? (journalId ?? undefined) : undefined);
  const j = q.data;
  return (
    <Modal open={journalId !== null} onOpenChange={(o) => !o && onClose()} title={j ? `Entry ${j.number}` : 'Entry in the books'} description={j?.memo} className="max-w-2xl">
      {!allowed && <Alert tone="info">Only people with accounting access can open entries in the books. Ask your School Admin if you need this.</Alert>}
      {allowed && q.isLoading && <Skeleton className="h-32" role="status" aria-label="Loading" />}
      {allowed && q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {j && (
        <div className="space-y-3">
          <p className="text-sm text-muted">
            Dated {formatDateOnly(j.accountingDate)}. {j.source ? `From ${j.source.label}.` : ''} An entry in the books never changes. A mistake is fixed with a new entry that cancels it.
          </p>
          {j.source && SOURCE_PAGE[j.source.type] && (
            <p className="text-sm">
              Came from:{' '}
              <Link to={SOURCE_PAGE[j.source.type]!.path(j.source.id)} className="font-semibold text-brand hover:underline" onClick={onClose}>
                Open {SOURCE_PAGE[j.source.type]!.word}
              </Link>
            </p>
          )}
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-sm">
              <thead className="bg-canvas text-left text-[13px] text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">Account</th>
                  <th className="px-3 py-2 text-right font-semibold">Debit</th>
                  <th className="px-3 py-2 text-right font-semibold">Credit</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {j.lines.map((l, i) => (
                  <tr key={`${l.accountId}-${i}`}>
                    <td className="px-3 py-2">
                      <span className="font-mono text-[13px] text-muted">{l.accountCode}</span> {l.accountName}
                    </td>
                    <td className="px-3 py-2 text-right">{l.debitPaise ? <Money paise={l.debitPaise} /> : '—'}</td>
                    <td className="px-3 py-2 text-right">{l.creditPaise ? <Money paise={l.creditPaise} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}
