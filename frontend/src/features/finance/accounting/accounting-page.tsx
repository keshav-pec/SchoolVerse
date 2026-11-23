import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { CircleCheck, Plus, TriangleAlert, X } from 'lucide-react';
import type { Permission } from '@shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { PageHeader } from '@/components/sv/page-header';
import { Pager } from '@/components/sv/pager';
import { Money, MoneyField } from '@/components/finance/money';
import { ReportTable } from '@/components/finance/report-table';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { useBankAccounts, useChart, useFinanceMutation } from '../api';
import { useApprovalFlow } from '../approval-flow';
import { JournalModal } from '../bill-drawer';
import { todayLocal } from '../collect/shared';
import { useFinanceYear } from '../context';
import { ACCOUNTING_INTRO, REPORTS_INTRO } from '../help-copy';
import { bookApi, useCollectionReport, useFinancialReport, useGeneralLedger, useJournals, useTrialBalance } from '../ops-api';
import { CloseTab } from './close-tab';

/** A hand-made entry. Debits must equal credits. Needs a second person; a closed month refuses it. */
function ManualEntry({ onClose }: { onClose: () => void }) {
  const chart = useChart();
  const [date, setDate] = useState(todayLocal());
  const [memo, setMemo] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState([{ accountId: '', debit: null as number | null, credit: null as number | null }, { accountId: '', debit: null as number | null, credit: null as number | null }]);
  const flow = useApprovalFlow();
  const save = useFinanceMutation((approvalId: string | undefined) => bookApi.manualJournal({ accountingDate: date, memo: memo.trim(), reason: reason.trim(), lines: lines.map((l) => ({ accountId: l.accountId, debitPaise: l.debit ?? 0, creditPaise: l.credit ?? 0 })), ...(approvalId ? { approvalId } : {}) }), { quiet: true, success: (j) => `Entry ${j.number} is in the books.` });
  const dr = lines.reduce((s, l) => s + (l.debit ?? 0), 0);
  const cr = lines.reduce((s, l) => s + (l.credit ?? 0), 0);
  const ok = dr > 0 && dr === cr && lines.every((l) => l.accountId && ((l.debit ?? 0) > 0) !== ((l.credit ?? 0) > 0)) && memo.trim() && reason.trim();
  const accounts = (chart.data ?? []).filter((a) => a.status === 'ACTIVE').map((a) => ({ value: a.accountId, label: a.name, hint: a.code }));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="New hand-made entry"
      description="For corrections the system cannot make by itself. Each line is a debit or a credit, and they must add up the same."
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!ok} loading={save.isPending} loadingText="Saving…" onClick={() => void flow.run((a) => save.mutateAsync(a)).then((r) => r && onClose())}>
            {flow.label('Save Entry')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Date" type="date" required value={date} onChange={(e) => setDate(e.target.value)} hint="A date in a closed month is refused." />
          <TextField label="Description" required value={memo} onChange={(e) => setMemo(e.target.value)} maxLength={200} />
        </div>
        {lines.map((l, i) => (
          <div key={i} className="grid items-end gap-2 sm:grid-cols-[1fr_140px_140px_40px]">
            <ComboboxField label="Account" value={l.accountId} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, accountId: v } : x)))} placeholder="Choose…" searchPlaceholder="Search accounts…" options={accounts} />
            <MoneyField label="Debit" value={l.debit} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, debit: v } : x)))} />
            <MoneyField label="Credit" value={l.credit} onChange={(v) => setLines(lines.map((x, j) => (j === i ? { ...x, credit: v } : x)))} />
            <Button size="icon-sm" variant="ghost" disabled={lines.length <= 2} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`Remove line ${i + 1}`}>
              <X />
            </Button>
          </div>
        ))}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button size="sm" variant="ghost" onClick={() => setLines([...lines, { accountId: '', debit: null, credit: null }])}>
            <Plus /> Add Line
          </Button>
          <p className={`text-sm font-semibold ${dr === cr && dr > 0 ? 'text-success' : 'text-danger'}`}>
            Debits {formatMoney(dr)} · Credits {formatMoney(cr)}
          </p>
        </div>
        <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        {flow.banner}
        {flow.errorBox}
      </div>
    </Modal>
  );
}

function JournalsTab() {
  const [page, setPage] = useState(1);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useJournals({ page, from: from || undefined, to: to || undefined });
  const [open, setOpen] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 25));
  return (
    <div className="space-y-4">
      <TabIntro title="Journals">{ACCOUNTING_INTRO}</TabIntro>
      <div className="flex flex-wrap items-end gap-3">
        <TextField label="From" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(1); }} containerClassName="w-44" />
        <TextField label="To" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(1); }} containerClassName="w-44" />
        <Can permission="finance:accounting:post">
          <Button className="ml-auto" variant="outline" onClick={() => setAdding(true)}>
            <Plus /> New Entry
          </Button>
        </Can>
      </div>
      {list.isLoading && <Skeleton className="h-32" />}
      {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
      {list.data && list.data.items.length === 0 && <EmptyState title="No entries" description="Entries appear when bills, payments, salaries or expenses are booked." />}
      {list.data && list.data.items.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white" aria-label="Journals">
          {list.data.items.map((j) => (
            <li key={j.journalId}>
              <button type="button" className="flex w-full flex-wrap items-center gap-x-3 px-4 py-2.5 text-left text-sm hover:bg-canvas" onClick={() => setOpen(j.journalId)}>
                <span className="w-24 text-muted">{formatDateOnly(j.accountingDate)}</span>
                <b>{j.number}</b>
                <span className="min-w-0 flex-1 truncate">{j.memo}</span>
                {j.reversedById && <span className="text-muted">reversed</span>}
                <Money paise={j.totalPaise} strong />
              </button>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
      <JournalModal journalId={open} onClose={() => setOpen(null)} />
      {adding && <ManualEntry onClose={() => setAdding(false)} />}
    </div>
  );
}

function LedgerTab() {
  const chart = useChart();
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const gl = useGeneralLedger({ accountId: accountId || undefined, from: from || undefined, to: to || undefined });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <ComboboxField label="Account" value={accountId} onChange={setAccountId} placeholder="Choose…" searchPlaceholder="Search accounts…" options={(chart.data ?? []).map((a) => ({ value: a.accountId, label: a.name, hint: a.code }))} containerClassName="w-80" />
        <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} containerClassName="w-44" />
        <TextField label="To" type="date" value={to} onChange={(e) => setTo(e.target.value)} containerClassName="w-44" />
      </div>
      {!accountId && <p className="text-sm text-muted">Choose an account to see every entry on it with the running balance.</p>}
      {gl.isLoading && accountId && <Skeleton className="h-32" />}
      {gl.data && (
        <Card className="overflow-x-auto p-0 sm:p-0">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-canvas text-left text-[13px] text-muted">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Entry</th>
                <th className="px-3 py-2 text-right">Debit</th>
                <th className="px-3 py-2 text-right">Credit</th>
                <th className="px-3 py-2 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              <tr className="bg-canvas/50 font-semibold">
                <td className="px-3 py-2" colSpan={4}>
                  Opening balance
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(gl.data.openingPaise)}</td>
              </tr>
              {gl.data.rows.map((r) => (
                <tr key={`${r.journalId}-${r.balancePaise}`}>
                  <td className="px-3 py-2 text-muted">{formatDateOnly(r.date)}</td>
                  <td className="px-3 py-2">
                    <button type="button" className="font-semibold text-brand hover:underline" onClick={() => setOpen(r.journalId)}>
                      {r.number}
                    </button>{' '}
                    {r.memo}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.debitPaise ? formatMoney(r.debitPaise) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.creditPaise ? formatMoney(r.creditPaise) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.balancePaise)}</td>
                </tr>
              ))}
              <tr className="bg-canvas/50 font-bold">
                <td className="px-3 py-2" colSpan={4}>
                  Closing balance
                </td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(gl.data.closingPaise)}</td>
              </tr>
            </tbody>
          </table>
        </Card>
      )}
      <JournalModal journalId={open} onClose={() => setOpen(null)} />
    </div>
  );
}

function TrialTab() {
  const [asOf, setAsOf] = useState(todayLocal());
  const tb = useTrialBalance({ asOf });
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <TextField label="As on" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} containerClassName="w-44" />
        {tb.data && (
          <p className={`flex items-center gap-1.5 pb-2 font-semibold ${tb.data.balanced ? 'text-success' : 'text-danger'}`} data-testid="trial-balanced">
            {tb.data.balanced ? <CircleCheck className="size-5" aria-hidden="true" /> : <TriangleAlert className="size-5" aria-hidden="true" />}
            {tb.data.balanced ? 'Balanced' : 'Not balanced. Please tell the accountant.'}
          </p>
        )}
      </div>
      {tb.isLoading && <Skeleton className="h-40" />}
      {tb.isError && <ErrorState error={tb.error} onRetry={() => void tb.refetch()} retrying={tb.isFetching} />}
      {tb.data && (
        <Card className="overflow-x-auto p-0 sm:p-0">
          <table className="w-full min-w-[560px] text-sm" aria-label="Trial balance">
            <thead className="bg-canvas text-left text-[13px] text-muted">
              <tr>
                <th className="px-3 py-2">Account</th>
                <th className="px-3 py-2 text-right">Debit</th>
                <th className="px-3 py-2 text-right">Credit</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {tb.data.rows.map((r) => (
                <tr key={r.accountId}>
                  <td className="px-3 py-2">
                    <span className="font-mono text-[13px] text-muted">{r.code}</span> {r.name}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.debitPaise ? formatMoney(r.debitPaise) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.creditPaise ? formatMoney(r.creditPaise) : '—'}</td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-canvas font-bold">
              <tr>
                <td className="px-3 py-2">Total</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(tb.data.totalDebitPaise)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{formatMoney(tb.data.totalCreditPaise)}</td>
              </tr>
            </tfoot>
          </table>
        </Card>
      )}
    </div>
  );
}

const REPORTS: { value: string; label: string; source: 'books' | 'collections'; dates: 'range' | 'asOf'; bank?: boolean }[] = [
  { value: 'income-and-expenditure', label: 'Income and expenditure', source: 'books', dates: 'range' },
  { value: 'balance-sheet', label: 'Balance sheet', source: 'books', dates: 'asOf' },
  { value: 'trial-balance', label: 'Trial balance', source: 'books', dates: 'asOf' },
  { value: 'cashbook', label: 'Cash book', source: 'books', dates: 'range' },
  { value: 'bankbook', label: 'Bank book', source: 'books', dates: 'range', bank: true },
  { value: 'ar-aging', label: 'Fees owed, by age', source: 'books', dates: 'asOf' },
  { value: 'ap-aging', label: 'Owed to vendors, by age', source: 'books', dates: 'asOf' },
  { value: 'income-by-fee-head-and-location', label: 'Fee income by fee type and campus', source: 'books', dates: 'range' },
  { value: 'payroll-expense-and-liability', label: 'Salary cost and dues', source: 'books', dates: 'range' },
  { value: 'collections-summary', label: 'Money received (summary)', source: 'books', dates: 'range' },
  { value: 'outstanding', label: 'Outstanding fees', source: 'books', dates: 'asOf' },
  { value: 'by-day', label: 'Money received by day', source: 'collections', dates: 'range' },
  { value: 'by-method', label: 'Money received by method', source: 'collections', dates: 'range' },
  { value: 'by-class', label: 'Money received by class', source: 'collections', dates: 'range' },
  { value: 'by-fee-head', label: 'Money received by fee type', source: 'collections', dates: 'range' },
  { value: 'by-cashier', label: 'Money received by cashier', source: 'collections', dates: 'range' },
  { value: 'pending-verification', label: 'Waiting for verification', source: 'collections', dates: 'range' },
  { value: 'cheque-register', label: 'Cheque register', source: 'collections', dates: 'range' },
  { value: 'advances', label: 'Advances held', source: 'collections', dates: 'range' },
  { value: 'refund-register', label: 'Refund register', source: 'collections', dates: 'range' },
];

function ReportsTab() {
  const { year } = useFinanceYear();
  const banks = useBankAccounts();
  const [type, setType] = useState('income-and-expenditure');
  const [from, setFrom] = useState(year?.startDate ?? '');
  const [to, setTo] = useState(todayLocal());
  const [bankId, setBankId] = useState('');
  const def = REPORTS.find((r) => r.value === type)!;
  const bank = bankId || banks.data?.[0]?.bankAccountId;
  const params: Record<string, string | undefined> = def.dates === 'asOf' ? { asOf: to } : { from: from || undefined, to: to || undefined, ...(def.bank ? { bankAccountId: bank } : {}) };
  const books = useFinancialReport(type, params, def.source === 'books' && (!def.bank || !!bank));
  const coll = useCollectionReport(type, params, def.source === 'collections');
  const query = def.source === 'books' ? books : coll;
  const path = `${def.source === 'books' ? '/finance/reports' : '/finance/collection-reports'}/${type}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v) as [string, string][]).toString()}`;
  return (
    <div className="space-y-4">
      <TabIntro title="Reports">{REPORTS_INTRO}</TabIntro>
      <div className="flex flex-wrap items-end gap-3">
        <ComboboxField label="Report" value={type} onChange={setType} searchPlaceholder="Search reports…" options={REPORTS.map((r) => ({ value: r.value, label: r.label, hint: r.source === 'books' ? 'books' : 'money received' }))} containerClassName="w-80" />
        {def.dates === 'range' && <TextField label="From" type="date" value={from} onChange={(e) => setFrom(e.target.value)} containerClassName="w-44" />}
        <TextField label={def.dates === 'asOf' ? 'As on' : 'To'} type="date" value={to} onChange={(e) => setTo(e.target.value)} containerClassName="w-44" />
        {def.bank && <Combobox aria-label="Bank account" className="h-11 w-60" value={bank ?? ''} onChange={setBankId} options={(banks.data ?? []).map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))} searchPlaceholder="Search accounts…" />}
      </div>
      <Card>
        <ReportTable query={query} csvPath={path} fileName={`${type}.csv`} />
      </Card>
    </div>
  );
}

const TABS: { id: string; label: string; any: Permission[] }[] = [
  { id: 'journals', label: 'Journals', any: ['finance:accounting:view'] },
  { id: 'ledger', label: 'Ledger', any: ['finance:accounting:view'] },
  { id: 'trial', label: 'Trial Balance', any: ['finance:accounting:view'] },
  { id: 'close', label: 'Close', any: ['finance:period:close', 'finance:accounting:post', 'finance:accounting:view'] },
  { id: 'reports', label: 'Reports', any: ['finance:report:view', 'finance:accounting:view'] },
];

/** `/finance/accounting`: tabs Journals, Ledger, Trial Balance, Close, Reports (`?tab=close`). */
export function AccountingPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => t.any.some(can));
  const tab = tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id ?? 'reports';
  return (
    <>
      <PageHeader eyebrow="Finance" title="Accounting & Reports" description="The books, closing a month, and the reports." />
      <Tabs value={tab} onValueChange={(v) => setParams({ tab: v })}>
        <TabsList aria-label="Accounting sections">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="journals">{tab === 'journals' && <JournalsTab />}</TabsContent>
        <TabsContent value="ledger">{tab === 'ledger' && <LedgerTab />}</TabsContent>
        <TabsContent value="trial">{tab === 'trial' && <TrialTab />}</TabsContent>
        <TabsContent value="close">{tab === 'close' && <CloseTab />}</TabsContent>
        <TabsContent value="reports">{tab === 'reports' && <ReportsTab />}</TabsContent>
      </Tabs>
    </>
  );
}
