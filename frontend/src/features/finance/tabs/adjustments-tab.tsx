import { useState } from 'react';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Pager } from '@/components/sv/pager';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { formatDateOnly } from '@/lib/format';
import { useStudentContext } from '../../students/context';
import { useDocuments, useStudentBills } from '../api';
import { AdjustmentDrawer } from '../adjustment-drawer';
import { BillDrawer, JournalModal } from '../bill-drawer';
import { ADJUSTMENTS_INTRO } from '../help-copy';
import { StudentPicker, type PickedStudent } from '../student-picker';

/** Adjustments: credit notes and debit notes already made, and "New Adjustment", which starts from one of a student's bills. */
export function AdjustmentsTab() {
  const ctx = useStudentContext();
  const [kind, setKind] = useState<'CREDIT_NOTE' | 'DEBIT_NOTE'>('CREDIT_NOTE');
  const [page, setPage] = useState(1);
  const list = useDocuments({ kind, page, locationId: ctx.locationId });
  const [finding, setFinding] = useState(false);
  const [adjustId, setAdjustId] = useState<string | null>(null);
  const [billId, setBillId] = useState<string | null>(null);
  const [journalId, setJournalId] = useState<string | null>(null);
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.pageSize ?? 25)));

  return (
    <div className="space-y-4">
      <TabIntro title="Adjustments">{ADJUSTMENTS_INTRO}</TabIntro>
      <Card>
        <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
          <ComboboxField
            label="Show"
            containerClassName="w-52"
            value={kind}
            onChange={(v) => {
              setKind(v as typeof kind);
              setPage(1);
            }}
            options={[
              { value: 'CREDIT_NOTE', label: 'Credit notes', hint: 'less to pay' },
              { value: 'DEBIT_NOTE', label: 'Debit notes', hint: 'more to pay' },
            ]}
            searchPlaceholder="Search…"
          />
          <Can permission="finance:adjustment:create">
            <Button onClick={() => setFinding(true)}>
              <Plus /> New Adjustment
            </Button>
          </Can>
        </div>
        {list.isLoading && <Skeleton className="h-24" role="status" aria-label="Loading" />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
        {list.data?.items.length === 0 && (
          <EmptyState title={kind === 'CREDIT_NOTE' ? 'No credit notes yet' : 'No debit notes yet'} description="To correct a bill, press New Adjustment. The bill itself is never edited." />
        )}
        <ul className="divide-y divide-line text-sm" aria-label={kind === 'CREDIT_NOTE' ? 'Credit notes' : 'Debit notes'}>
          {list.data?.items.map((d) => (
            <li key={d.documentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
              <button type="button" className="font-semibold text-brand hover:underline" onClick={() => setBillId(d.documentId)}>
                {d.number}
              </button>
              <span>{d.studentName}</span>
              <span className="text-muted">{formatDateOnly(d.issueDate)}</span>
              <FinanceStatusPill status={d.status} />
              <span className="ml-auto">
                <Money paise={d.totalPaise} strong />
              </span>
            </li>
          ))}
        </ul>
        {pages > 1 && (
          <div className="mt-3 flex justify-end">
            <Pager page={page} pages={pages} onPage={setPage} />
          </div>
        )}
      </Card>
      <FindBill
        open={finding}
        onClose={() => setFinding(false)}
        onPick={(id) => {
          setFinding(false);
          setAdjustId(id);
        }}
      />
      <AdjustmentDrawer documentId={adjustId} onClose={() => setAdjustId(null)} />
      <BillDrawer documentId={billId} onClose={() => setBillId(null)} onOpenJournal={setJournalId} />
      <JournalModal journalId={journalId} onClose={() => setJournalId(null)} />
    </div>
  );
}

function FindBill({ open, onClose, onPick }: { open: boolean; onClose: () => void; onPick: (documentId: string) => void }) {
  const [student, setStudent] = useState<PickedStudent | null>(null);
  const bills = useStudentBills(student?.studentId);
  return (
    <Modal open={open} onOpenChange={(o) => !o && onClose()} title="Which bill?" description="Find the student, then pick the bill you want to correct.">
      <div className="space-y-4">
        <StudentPicker value={student} onChange={setStudent} />
        {student && bills.isLoading && <Skeleton className="h-16" />}
        {student && bills.data?.items.length === 0 && <p className="text-sm text-muted">This student has no bills yet.</p>}
        <ul className="divide-y divide-line rounded-xl border border-line empty:hidden" aria-label="Bills of this student">
          {bills.data?.items
            .filter((b) => b.kind !== 'CREDIT_NOTE' && b.status !== 'CANCELLED')
            .map((b) => (
              <li key={b.documentId}>
                <button type="button" className="flex w-full items-center gap-3 px-3 py-2 text-left text-sm hover:bg-brand-soft/60 focus-visible:bg-brand-soft/60 focus-visible:outline-none" onClick={() => onPick(b.documentId)}>
                  <span className="font-semibold">{b.number}</span>
                  <span className="text-muted">due {formatDateOnly(b.dueDate)}</span>
                  <span className="ml-auto">
                    left <Money paise={b.balancePaise} strong />
                  </span>
                </button>
              </li>
            ))}
        </ul>
      </div>
    </Modal>
  );
}
