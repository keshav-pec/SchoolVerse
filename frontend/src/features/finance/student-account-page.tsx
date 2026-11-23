import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, BellRing, BookOpenCheck, Download, FilePlus2, IndianRupee, SlidersHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import type { FeePlanItemDTO, StudentAccountDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { ExplainDrawer } from '@/components/finance/explain-drawer';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { AdjustmentDrawer } from './adjustment-drawer';
import { ClaimDrawer, RemindersDrawer } from './collect/drawers';
import { RefundDrawer } from './collect/refunds-tab';
import { BillDrawer, JournalModal } from './bill-drawer';
import { financeApi, openPdf, useFeePlans, useFinanceMutation, useLedger, useStudentAccount, useStudentBills, useUpcoming } from './api';
import { FREQUENCY_LABELS, LEDGER_KIND_LABELS, TIP_ADVANCE, TIP_EXPECTED_LATER, TIP_OUTSTANDING } from './help-copy';

function Amount({ label, paise, note, tip, tone }: { label: string; paise: number; note: string; tip?: ReactNode; tone?: 'danger' | 'success' }) {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-3" role="group" aria-label={label}>
      <p className="flex items-center gap-1 text-[13px] font-semibold text-muted">
        {label}
        {tip && <InfoTip label={`About ${label.toLowerCase()}`}>{tip}</InfoTip>}
      </p>
      <p className={`text-xl font-extrabold tabular-nums ${tone === 'danger' && paise > 0 ? 'text-danger' : tone === 'success' && paise > 0 ? 'text-success' : 'text-ink'}`}>{formatMoney(paise)}</p>
      <p className="text-xs text-muted">{note}</p>
    </div>
  );
}

/** Money actions for one student. Each button shows only for people allowed to use it; the server checks again. */
function MoneyActions({ studentId, studentName }: { studentId: string; studentName: string }) {
  const [claim, setClaim] = useState(false);
  const [refund, setRefund] = useState(false);
  const [remind, setRemind] = useState(false);
  return (
    <div className="flex flex-wrap gap-2">
      <Can permission="finance:collection:record">
        <Button asChild size="sm">
          <Link to={`/finance/collect?tab=take&student=${studentId}`}>
            <IndianRupee /> Collect
          </Link>
        </Button>
        <Button size="sm" variant="outline" onClick={() => setClaim(true)}>
          Report Claim
        </Button>
      </Can>
      <Can permission="finance:refund:request">
        <Button size="sm" variant="outline" onClick={() => setRefund(true)}>
          Refund
        </Button>
      </Can>
      <Can permission="finance:billing:create">
        <Button size="sm" variant="outline" onClick={() => setRemind(true)}>
          <BellRing /> Send Reminder
        </Button>
      </Can>
      <ClaimDrawer student={{ studentId, studentName }} open={claim} onClose={() => setClaim(false)} />
      <RefundDrawer studentId={studentId} open={refund} onClose={() => setRefund(false)} />
      <RemindersDrawer open={remind} onClose={() => setRemind(false)} highlightStudentId={studentId} />
    </div>
  );
}

/** Choose the optional fees (like Transport) for this student. Needs a reason, which is written in the record. */
function FeeOptionsDrawer({ account, open, onOpenChange }: { account: StudentAccountDTO; open: boolean; onOpenChange: (o: boolean) => void }) {
  const a = account.assignment;
  const plans = useFeePlans(a?.sessionId);
  const version = plans.data?.flatMap((p) => [p.publishedVersion, p.latestVersion]).find((v) => v?.versionId === a?.planVersionId) ?? null;
  const optional: FeePlanItemDTO[] = version?.items.filter((i) => i.isOptional) ?? [];
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [reason, setReason] = useState('');
  const save = useFinanceMutation((body: Record<string, unknown>) => financeApi.updateAssignment(account.studentId, body), { success: 'Fee options saved.' });
  const current = chosen ?? a?.optionalItemIds ?? [];
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      <DrawerContent title="Fee options" description="Extra fees this student pays, such as Transport.">
        <DrawerBody className="space-y-4">
          {!a && <Alert tone="warning" title="No fee plan yet">This student has no fee plan, so there are no options. Assign a plan first from the Fee Plans tab.</Alert>}
          {a && optional.length === 0 && <p className="text-sm text-muted">The plan “{a.planName}” has no optional fees.</p>}
          {optional.map((i) => (
            <label key={i.itemId} className="flex items-center gap-3 rounded-xl border border-line px-3 py-2.5 text-sm">
              <input
                type="checkbox"
                className="size-5 accent-[var(--color-brand)]"
                checked={current.includes(i.itemId)}
                onChange={(e) => setChosen(e.target.checked ? [...current, i.itemId] : current.filter((x) => x !== i.itemId))}
              />
              <span className="min-w-0 flex-1">
                {i.feeHeadName}
                <span className="block text-[13px] text-muted">{FREQUENCY_LABELS[i.frequency]}</span>
              </span>
              <Money paise={i.amountPaise} strong />
            </label>
          ))}
          {a && optional.length > 0 && <TextareaField label="Why are you changing this?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Parent asked for the school bus." maxLength={300} />}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!a || optional.length === 0 || reason.trim() === '' || chosen === null}
            loading={save.isPending}
            loadingText="Saving…"
            onClick={() => save.mutate({ optionalItemIds: current, reason: reason.trim() }, { onSuccess: () => onOpenChange(false) })}
          >
            Save Options
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** `/finance/fees/students/:studentId` — one student's money: six amounts, timeline, bills, expected later. */
export function StudentAccountPage() {
  const { studentId } = useParams();
  const account = useStudentAccount(studentId);
  const ledger = useLedger(studentId);
  const bills = useStudentBills(studentId);
  const upcoming = useUpcoming(studentId);
  const [explain, setExplain] = useState(false);
  const [billId, setBillId] = useState<string | null>(null);
  const [journalId, setJournalId] = useState<string | null>(null);
  const [adjustId, setAdjustId] = useState<string | null>(null);
  const [options, setOptions] = useState(false);
  const [statementBusy, setStatementBusy] = useState(false);

  if (account.isLoading) return <Skeleton className="h-72 rounded-card" role="status" aria-label="Loading" />;
  if (account.isError || !account.data) return <ErrorState error={account.error} onRetry={() => void account.refetch()} retrying={account.isFetching} />;
  const a = account.data;

  const statement = async () => {
    setStatementBusy(true);
    try {
      await openPdf(`/finance/students/${a.studentId}/statement/pdf`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setStatementBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm" className="-ml-2">
        <Link to="/finance/fees?tab=accounts">
          <ArrowLeft /> Back To Accounts
        </Link>
      </Button>
      <PageHeader
        eyebrow="Student account"
        title={a.studentName}
        description={`${a.admissionNumber ?? 'No admission number'} · ${a.className ?? 'No class'}${a.assignment ? ` · Plan: ${a.assignment.planName}` : ' · No fee plan yet'}`}
        actions={
          <>
            <Button onClick={() => setExplain(true)}>
              <BookOpenCheck /> Explain This Balance
            </Button>
            <Button variant="outline" onClick={() => void statement()} loading={statementBusy} loadingText="Opening…">
              <Download /> Download Statement
            </Button>
            <Can permission="finance:fee_plan:manage">
              <Button variant="outline" onClick={() => setOptions(true)}>
                <SlidersHorizontal /> Fee Options
              </Button>
            </Can>
          </>
        }
      />

      {!a.assignment && (
        <Alert tone="warning" title="This student has no fee plan">
          Bills cannot be made until a plan is assigned. Go to Student Fees → Fee Plans and assign the class.
        </Alert>
      )}

      <section aria-label="Amounts on this account" className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Amount label="Billed" paise={a.billedPaise} note="posted · all bills issued" />
        <Amount label="Concession" paise={a.concessionPaise} note="posted · discounts already taken off" />
        <Amount label="Tax" paise={a.taxPaise} note="posted · GST inside the bills" />
        <Amount label="Paid" paise={a.paidPaise} note="posted · money received" tone="success" />
        <Amount label="Outstanding" paise={a.outstandingPaise} note="posted · still to pay" tip={TIP_OUTSTANDING} tone="danger" />
        <Amount label="Overdue" paise={a.overduePaise} note="posted · past the due date" tone="danger" />
      </section>
      <section aria-label="Held and expected amounts" className="grid gap-3 sm:grid-cols-2">
        <Amount label="Advance held" paise={a.advancePaise} note="posted · money held, not income" tip={TIP_ADVANCE} />
        <Amount label="Expected later" paise={a.expectedLaterPaise} note="expected later · not counted as owed" tip={TIP_EXPECTED_LATER} />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Money</CardTitle>
        </CardHeader>
        <MoneyActions studentId={a.studentId} studentName={a.studentName} />
      </Card>

      <Card>
        <CardHeader>
          <HelpHeading title="Bills" help={<p>Every bill for this student. Open one to see its lines, tax and PDF. To correct a bill, use New Adjustment.</p>} />
        </CardHeader>
        {bills.isLoading ? (
          <Skeleton className="h-24" />
        ) : (bills.data?.items.length ?? 0) === 0 ? (
          <EmptyState title="No bills yet" description="Bills appear here after the monthly bill run is issued." />
        ) : (
          <ul className="divide-y divide-line" aria-label="Bills">
            {bills.data!.items.map((b) => (
              <li key={b.documentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                <button type="button" className="font-semibold text-brand hover:underline" onClick={() => setBillId(b.documentId)}>
                  {b.number}
                </button>
                <span className="text-muted">Due {formatDateOnly(b.dueDate)}</span>
                <FinanceStatusPill status={b.status} />
                {b.overdue && <FinanceStatusPill status="OVERDUE" />}
                <span className="ml-auto flex items-center gap-3">
                  <span>
                    <Money paise={b.totalPaise} /> <span className="text-muted">· left</span> <Money paise={b.balancePaise} strong />
                  </span>
                  <Can permission="finance:adjustment:create">
                    {b.kind !== 'CREDIT_NOTE' && b.status !== 'CANCELLED' && (
                      <Button size="sm" variant="outline" onClick={() => setAdjustId(b.documentId)} aria-label={`New adjustment on ${b.number}`}>
                        <FilePlus2 /> Adjust
                      </Button>
                    )}
                  </Can>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <CardHeader>
          <HelpHeading title="Timeline" help={<p>Bills, discounts, payments and corrections in the order they happened. Open any line to see where it came from.</p>} />
        </CardHeader>
        {ledger.isLoading ? (
          <Skeleton className="h-24" />
        ) : (ledger.data?.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">Nothing has happened on this account yet.</p>
        ) : (
          <ol className="space-y-2" aria-label="Timeline">
            {[...ledger.data!].reverse().map((e) => (
              <li key={e.entryId} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-canvas px-3 py-2 text-sm">
                <span className="w-24 shrink-0 text-muted">{formatDateOnly(e.date)}</span>
                <b>{LEDGER_KIND_LABELS[e.kind] ?? e.kind}</b>
                <span className="min-w-0 flex-1 text-muted">{e.description}</span>
                <Money paise={e.amountPaise} strong />
                {e.documentId && (
                  <Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setBillId(e.documentId)} aria-label={`Open ${e.documentNumber ?? 'the bill'}`}>
                    {e.documentNumber ?? 'Bill'}
                  </Button>
                )}
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Card>
        <CardHeader>
          <HelpHeading title="Expected later" help={TIP_EXPECTED_LATER} />
        </CardHeader>
        {upcoming.isLoading ? (
          <Skeleton className="h-16" />
        ) : (upcoming.data?.items.length ?? 0) === 0 ? (
          <p className="text-sm text-muted">No future bills are planned for this student.</p>
        ) : (
          <ul className="divide-y divide-line text-sm" aria-label="Expected later">
            {upcoming.data!.items.map((u) => (
              <li key={u.periodKey} className="flex flex-wrap items-center gap-x-3 py-2">
                <b>{u.periodKey}</b>
                <span className="text-muted">due {formatDateOnly(u.dueDate)}</span>
                <span className="min-w-0 flex-1 text-muted">{u.lines.map((l) => l.description).join(', ')}</span>
                <Money paise={u.totalPaise} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ExplainDrawer studentId={a.studentId} open={explain} onOpenChange={setExplain} outstandingPaise={a.outstandingPaise} onOpenBill={setBillId} onOpenJournal={setJournalId} />
      <BillDrawer documentId={billId} onClose={() => setBillId(null)} onOpenJournal={setJournalId} />
      <JournalModal journalId={journalId} onClose={() => setJournalId(null)} />
      <AdjustmentDrawer documentId={adjustId} onClose={() => setAdjustId(null)} />
      <FeeOptionsDrawer key={`${a.studentId}-${options}`} account={a} open={options} onOpenChange={setOptions} />
    </div>
  );
}
