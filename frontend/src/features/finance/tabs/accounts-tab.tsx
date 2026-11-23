import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ArrowLeft, Search, UsersRound } from 'lucide-react';
import { AGING_BUCKETS } from '@shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Pager } from '@/components/sv/pager';
import { Money } from '@/components/finance/money';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { formatMoney } from '@/lib/money';
import { cn } from '@/lib/utils';
import { useClassOfferings } from '../../academic/api';
import { useStudentContext } from '../../students/context';
import { useAccounts, useFamily, useOutstanding } from '../api';
import { AssignmentPanel } from '../assignment-panel';
import { ACCOUNTS_INTRO, AGING_LABELS } from '../help-copy';

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-[5.5rem]">
      <p className="text-[11px] font-semibold tracking-wide text-muted uppercase md:sr-only">{label}</p>
      <p className="text-sm tabular-nums">{children}</p>
    </div>
  );
}

/** Accounts: every student with Billed, Paid, Outstanding and Overdue, found by name, admission number or parent. */
export function AccountsTab() {
  const [params, setParams] = useSearchParams();
  const family = params.get('family');
  if (family) return <FamilyView guardianId={family} onBack={() => setParams((p) => { p.delete('family'); return p; })} />;
  return <AccountList />;
}

function AccountList() {
  const ctx = useStudentContext();
  const offerings = useClassOfferings(ctx.sessionId, ctx.locationId);
  const [text, setText] = useState('');
  const [classId, setClassId] = useState('');
  const [bucket, setBucket] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebouncedValue(text.trim(), 300);
  const list = useAccounts({ locationId: ctx.locationId, academicSessionId: ctx.sessionId, classOfferingId: classId || undefined, q: q || undefined, page });
  const aging = useOutstanding({ locationId: ctx.locationId, bucket: bucket || undefined });
  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / (list.data?.pageSize ?? 25)));
  const reset = () => setPage(1);

  return (
    <div className="space-y-4">
      <TabIntro title="Accounts">{ACCOUNTS_INTRO}</TabIntro>
      <Can permission="finance:fee_plan:manage">
        <AssignmentPanel />
      </Can>

      <Card aria-label="Who owes what">
        <h2 className="mb-2 text-lg font-bold">Who owes what</h2>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5" role="group" aria-label="Late bills by age">
          {AGING_BUCKETS.map((b) => {
            const row = aging.data?.buckets.find((x) => x.bucket === b);
            const on = bucket === b;
            return (
              <button
                key={b}
                type="button"
                aria-pressed={on}
                onClick={() => setBucket(on ? '' : b)}
                className={cn('rounded-xl border px-3 py-2 text-left transition-colors', on ? 'border-brand bg-brand-soft' : 'border-line bg-white hover:border-brand/40')}
              >
                <span className="block text-[13px] font-semibold text-muted">{AGING_LABELS[b]}</span>
                <span className="block text-base font-extrabold tabular-nums">{formatMoney(row?.totalPaise ?? 0)}</span>
                <span className="block text-xs text-muted">{row?.count ?? 0} bills</span>
              </button>
            );
          })}
        </div>
        {bucket && (
          <div className="mt-3">
            <div className="mb-1 flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold">{AGING_LABELS[bucket]}</h3>
              <Button size="sm" variant="ghost" onClick={() => setBucket('')}>
                Clear Filter
              </Button>
            </div>
            {aging.data?.rows.length === 0 && <p className="text-sm text-muted">Nobody is in this group.</p>}
            <ul className="divide-y divide-line text-sm" aria-label="Students in this group">
              {aging.data?.rows.map((r) => (
                <li key={r.studentId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <Link to={`/finance/fees/students/${r.studentId}`} className="font-semibold text-brand hover:underline">
                    {r.studentName}
                  </Link>
                  <span className="text-muted">{r.className ?? 'No class'}</span>
                  <span className="ml-auto flex gap-4">
                    <span>
                      Owes <Money paise={r.outstandingPaise} strong />
                    </span>
                    <span className="text-danger">
                      Overdue <Money paise={r.overduePaise} />
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <div className="relative min-w-[14rem] flex-1">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <Input
              aria-label="Search students"
              className="pl-9"
              placeholder="Search by name, admission number or parent…"
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                reset();
              }}
            />
          </div>
          <Combobox
            aria-label="Class"
            className="h-11 w-48"
            value={classId}
            onChange={(v) => {
              setClassId(v);
              reset();
            }}
            options={[{ value: '', label: 'All classes' }, ...(offerings.data ?? []).map((o) => ({ value: o.classOfferingId, label: o.displayName }))]}
            searchPlaceholder="Search classes…"
          />
        </div>

        {list.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading" />}
        {list.isError && <ErrorState error={list.error} onRetry={() => void list.refetch()} retrying={list.isFetching} />}
        {list.data?.items.length === 0 && <EmptyState title={q ? 'No student found' : 'No students yet'} description={q ? 'Check the spelling, or try the admission number or a parent’s name.' : 'Students appear here once they are placed in a class this year.'} />}
        {(list.data?.items.length ?? 0) > 0 && (
          <>
            <div className="hidden grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))] gap-3 border-b border-line px-2 pb-2 text-[13px] font-semibold text-muted md:grid" aria-hidden="true">
              <span>Student</span>
              <span>Billed</span>
              <span>Paid</span>
              <span>Outstanding</span>
              <span>Overdue</span>
            </div>
            <ul className="divide-y divide-line" aria-label="Student accounts">
              {list.data!.items.map((s) => (
                <li key={s.studentId} className="grid gap-x-3 gap-y-2 px-2 py-3 md:grid-cols-[minmax(0,1.6fr)_repeat(4,minmax(0,1fr))] md:items-center">
                  <div className="min-w-0">
                    <Link to={`/finance/fees/students/${s.studentId}`} className="font-semibold text-brand hover:underline">
                      {s.studentName}
                    </Link>
                    <p className="text-[13px] text-muted">
                      {s.admissionNumber ?? 'No admission number'} · {s.className ?? 'No class'}
                      {s.guardianName && (
                        <>
                          {' · '}
                          {s.guardianPersonId ? (
                            <Link to={`/finance/fees?tab=accounts&family=${s.guardianPersonId}`} className="hover:underline" aria-label={`Open the family of ${s.guardianName}`}>
                              {s.guardianName}
                            </Link>
                          ) : (
                            s.guardianName
                          )}
                        </>
                      )}
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-2 md:contents">
                    <Cell label="Billed">{formatMoney(s.billedPaise)}</Cell>
                    <Cell label="Paid">{formatMoney(s.paidPaise)}</Cell>
                    <Cell label="Outstanding">
                      <b>{formatMoney(s.outstandingPaise)}</b>
                    </Cell>
                    <Cell label="Overdue">
                      <span className={s.overduePaise > 0 ? 'font-semibold text-danger' : ''}>{formatMoney(s.overduePaise)}</span>
                    </Cell>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">Every amount is worked out from the bills and payments. It cannot be edited here.</p>
            {pages > 1 && (
              <div className="mt-3 flex items-center justify-between gap-2">
                <p className="text-sm text-muted">{list.data!.total} students</p>
                <Pager page={page} pages={pages} onPage={setPage} />
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

/** A family is a view: each child's own account, added up on screen. There is no family ledger. */
function FamilyView({ guardianId, onBack }: { guardianId: string; onBack: () => void }) {
  const q = useFamily(guardianId);
  return (
    <div className="space-y-4">
      <Button variant="ghost" size="sm" className="-ml-2" onClick={onBack}>
        <ArrowLeft /> Back To Accounts
      </Button>
      {q.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {q.data && (
        <Card aria-label="Family">
          <h2 className="flex items-center gap-2 text-lg font-bold">
            <UsersRound className="size-5 text-brand" aria-hidden="true" /> {q.data.guardianName}’s family
          </h2>
          <p className="mb-3 text-sm text-muted">Each child has a separate account. The total below only adds them up on screen.</p>
          <ul className="divide-y divide-line" aria-label="Children">
            {q.data.children.map((c) => (
              <li key={c.studentId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
                <Link to={`/finance/fees/students/${c.studentId}`} className="min-w-0 flex-1 font-semibold text-brand hover:underline">
                  {c.studentName} <span className="font-normal text-muted">· {c.className ?? 'No class'}</span>
                </Link>
                <span>
                  Owes <Money paise={c.outstandingPaise} strong />
                </span>
                <span className="text-muted">
                  Overdue <Money paise={c.overduePaise} />
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-xl bg-canvas px-4 py-3 text-[15px] font-bold" aria-label="Family total">
            <span>Total owed by the family</span>
            <Money paise={q.data.totals.outstandingPaise} strong />
          </div>
        </Card>
      )}
    </div>
  );
}
