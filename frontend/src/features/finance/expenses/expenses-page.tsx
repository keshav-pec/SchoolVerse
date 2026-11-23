import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { Paperclip } from 'lucide-react';
import type { ExpenseDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { PageHeader } from '@/components/sv/page-header';
import { Pager } from '@/components/sv/pager';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { useFinanceMutation } from '../api';
import { EXPENSES_INTRO } from '../help-copy';
import { spendApi, useExpenses } from '../ops-api';
import { ExpensePanel } from './expense-panel';
import { VendorsTab } from './vendors-tab';

function ExpensesTab() {
  const { can } = useAuth();
  const [page, setPage] = useState(1);
  const list = useExpenses({ page });
  const [rejecting, setRejecting] = useState<ExpenseDTO | null>(null);
  const [reason, setReason] = useState('');
  const approve = useFinanceMutation((id: string) => spendApi.approveExpense(id), { success: 'Approved and booked.' });
  const reject = useFinanceMutation((v: { id: string; reason: string }) => spendApi.rejectExpense(v.id, v.reason), { success: 'Rejected.' });
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  return (
    <div className="space-y-4">
      <TabIntro title="Expenses">{EXPENSES_INTRO}</TabIntro>
      <Can permission="finance:expense:record">
        <ExpensePanel />
      </Can>
      <Card aria-label="Recent expenses">
        <CardHeader>
          <CardTitle>Recent expenses</CardTitle>
        </CardHeader>
        {list.isLoading && <Skeleton className="h-24" />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
        {list.data && list.data.items.length === 0 && <EmptyState title="No expenses yet" description="Add the first one above." />}
        {list.data && list.data.items.length > 0 && (
          <ul className="divide-y divide-line text-sm" aria-label="Expenses">
            {list.data.items.map((e) => (
              <li key={e.expenseId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <b>{e.number}</b>
                <Money paise={e.totalPaise} strong />
                <span className="min-w-0 flex-1 text-muted">
                  {formatDateOnly(e.date)} · {e.categoryName}
                  {e.vendorName ? ` · ${e.vendorName}` : ''} · {e.description}
                  {e.createdByName ? ` · by ${e.createdByName}` : ''}
                </span>
                {e.hasEvidence && <Paperclip className="size-4 text-muted" aria-label="Has a receipt photo" />}
                <FinanceStatusPill status={e.state} label={e.state === 'PENDING' ? (e.needsApproval && !e.approved ? 'Waiting for Approval' : e.waitingForItc ? 'Tax Decision Needed' : 'Waiting') : undefined} />
                {e.state === 'PENDING' && e.needsApproval && !e.approved && can('finance:expense:approve') && (
                  <span className="flex gap-2">
                    <Button size="sm" loading={approve.isPending && approve.variables === e.expenseId} loadingText="Saving…" onClick={() => approve.mutate(e.expenseId)} aria-label={`Approve ${e.number}`}>
                      Approve
                    </Button>
                    <Button size="sm" variant="outline" onClick={() => setRejecting(e)} aria-label={`Reject ${e.number}`}>
                      Reject
                    </Button>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
      </Card>
      {rejecting && (
        <Modal
          open
          onOpenChange={(o) => !o && setRejecting(null)}
          title={`Reject ${rejecting.number}`}
          footer={
            <>
              <Button variant="outline" onClick={() => setRejecting(null)}>
                Cancel
              </Button>
              <Button variant="destructive" disabled={!reason.trim()} loading={reject.isPending} loadingText="Rejecting…" onClick={() => reject.mutate({ id: rejecting.expenseId, reason: reason.trim() }, { onSuccess: () => setRejecting(null) })}>
                Reject
              </Button>
            </>
          }
        >
          <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </Modal>
      )}
    </div>
  );
}

/** `/finance/expenses`: tabs Expenses and Vendors & Bills (`?tab=vendors`). */
export function ExpensesPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'vendors' ? 'vendors' : 'expenses';
  return (
    <>
      <PageHeader eyebrow="Finance" title="Expenses" description="Money the school spends, and what it owes to suppliers." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label="Expenses sections">
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
          <TabsTrigger value="vendors">Vendors & Bills</TabsTrigger>
        </TabsList>
        <TabsContent value="expenses">{tab === 'expenses' && <ExpensesTab />}</TabsContent>
        <TabsContent value="vendors">{tab === 'vendors' && <VendorsTab />}</TabsContent>
      </Tabs>
    </>
  );
}
