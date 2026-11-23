import { BookOpenCheck, CircleCheck, TriangleAlert } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent } from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { useExplanation } from '@/features/finance/api';
import { formatMoney } from '@/lib/money';
import { Money } from './money';

/**
 * "Explain This Balance": the sum written out line by line. Every part that came from a bill or a journal can be opened. The total
 * at the bottom must equal the amount the account says is owed; if it ever does not, the drawer says so instead of hiding it.
 */
export function ExplainDrawer({
  studentId,
  open,
  onOpenChange,
  outstandingPaise,
  onOpenBill,
  onOpenJournal,
}: {
  studentId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the account page says is owed, to check the explanation against. */
  outstandingPaise?: number;
  onOpenBill?: (documentId: string) => void;
  onOpenJournal?: (journalId: string) => void;
}) {
  const q = useExplanation(studentId, open);
  const data = q.data;
  const matches = data !== undefined && outstandingPaise !== undefined ? data.totalPaise === outstandingPaise : undefined;
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="Explain this balance" description="Every part of the amount, in the order it happened.">
        <DrawerBody className="space-y-4">
          {q.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading" />}
          {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
          {data && (
            <>
              <Alert tone="info" title="In one sentence">
                <span data-testid="explain-sentence">{data.sentence}</span>
              </Alert>
              {data.lines.length === 0 ? (
                <p className="text-sm text-muted">Nothing has been billed yet, so there is nothing to explain.</p>
              ) : (
                <ol className="divide-y divide-line rounded-xl border border-line" aria-label="Parts of the balance">
                  {data.lines.map((l, i) => (
                    <li key={`${i}-${l.label}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5 text-sm">
                      <span className={l.sign === '+' ? 'font-bold text-ink' : 'font-bold text-success'} aria-label={l.sign === '+' ? 'plus' : 'minus'}>
                        {l.sign === '+' ? '+' : '−'}
                      </span>
                      <span className="min-w-0 flex-1">{l.label}</span>
                      <Money paise={l.amountPaise} strong />
                      <span className="flex gap-1">
                        {l.documentId && onOpenBill && (
                          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => onOpenBill(l.documentId!)} aria-label={`Open the bill for ${l.label}`}>
                            Bill
                          </Button>
                        )}
                        {l.journalId && onOpenJournal && (
                          <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => onOpenJournal(l.journalId!)} aria-label={`Open the entry for ${l.label}`}>
                            Entry
                          </Button>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="flex items-center justify-between rounded-xl bg-canvas px-4 py-3 text-[15px] font-bold">
                <span className="flex items-center gap-2">
                  <BookOpenCheck className="size-4 text-brand" aria-hidden="true" /> Left to pay
                </span>
                <span data-testid="explain-total">{formatMoney(data.totalPaise)}</span>
              </p>
              {matches === true && (
                <p className="flex items-center gap-2 text-sm text-success">
                  <CircleCheck className="size-4" aria-hidden="true" /> This matches the amount on the student’s account.
                </p>
              )}
              {matches === false && (
                <Alert tone="danger" title="This does not match the account">
                  <span className="flex items-start gap-1.5">
                    <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                    The account shows {formatMoney(outstandingPaise!)}. Please tell the school’s accountant.
                  </span>
                </Alert>
              )}
            </>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}
