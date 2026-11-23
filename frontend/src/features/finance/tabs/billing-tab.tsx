import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, FileCheck2, Receipt, RefreshCw, SearchCheck } from 'lucide-react';
import type { BillingCommitDTO, BillingReason, BillingRowDTO, LateFeePreviewDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { ExceptionHeader } from '@/components/finance/exception-header';
import { ImpactPreview } from '@/components/finance/impact-preview';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { formatMoney, formatMoneyShort } from '@/lib/money';
import { useClassOfferings } from '../../academic/api';
import { useStudentContext } from '../../students/context';
import { financeApi, useBillingRuns, useFinanceMutation, useRun, useRunRows } from '../api';
import { useFinanceYear } from '../context';
import { ErrorBanner } from '../error-banner';
import { BILLING_INTRO, REASON_GROUP_TITLE, REASON_TEXT } from '../help-copy';

const today = () => new Date().toISOString().slice(0, 10);
const monthLabel = (periodKey: string) => new Date(`${periodKey}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const newKey = () => globalThis.crypto?.randomUUID?.() ?? `key-${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** Where the person goes to fix a row. Skip is always possible. */
function fixLink(reason: BillingReason | null): { label: string; to: string } | null {
  if (reason === 'NO_PLAN' || reason === 'PLAN_CONFLICT') return { label: 'Choose Plan', to: '/finance/fees?tab=plans' };
  if (reason === 'TAX_CODE_MISSING') return { label: 'Add Tax Code', to: '/finance/fees?tab=plans' };
  if (reason === 'PERIOD_CLOSED') return { label: 'Open Periods', to: '/finance/settings?tab=years' };
  return null;
}

/** Billing (FUX-04): check the month, look only at what needs a look, issue. A second run for the same month makes no new bills. */
export function BillingTab() {
  const ctx = useStudentContext();
  const { year } = useFinanceYear();
  const offerings = useClassOfferings(ctx.sessionId, ctx.locationId);
  const runs = useBillingRuns(ctx.sessionId);

  const periods = useMemo(() => (year?.periods ?? []).map((p) => ({ value: p.code, label: monthLabel(p.code), hint: p.state === 'OPEN' ? undefined : 'closed' })), [year]);
  const thisMonth = today().slice(0, 7);
  const [period, setPeriod] = useState('');
  const periodKey = period || (periods.find((p) => p.value === thisMonth)?.value ?? periods[0]?.value ?? thisMonth);
  const [classIds, setClassIds] = useState<string[]>([]);
  const [issueDate, setIssueDate] = useState(today());
  const [dueDate, setDueDate] = useState('');
  const [custom, setCustom] = useState(false);

  const [runId, setRunId] = useState<string | undefined>();
  const [attempt, setAttempt] = useState<string>(newKey);
  const [issuing, setIssuing] = useState(false);
  const [result, setResult] = useState<BillingCommitDTO | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [skipRow, setSkipRow] = useState<BillingRowDTO | null>(null);
  const [lateFees, setLateFees] = useState(false);

  const run = useRun(runId);
  const rows = useRunRows(runId, { status: 'NEEDS_ATTENTION' }, !!runId);
  const ready = useRunRows(runId, { status: 'READY' }, !!runId && (run.data?.counts.ready ?? 0) > 0);

  const create = useFinanceMutation((body: Record<string, unknown>) => financeApi.createRun(body), { quiet: true });
  const check = useFinanceMutation((id: string) => financeApi.checkRun(id), { quiet: true });
  const commit = useFinanceMutation((v: { id: string; ready: number; total: number; key: string }) => financeApi.commitRun(v.id, { confirmedReadyCount: v.ready, confirmedTotalPaise: v.total }, v.key), { quiet: true });

  const runCheck = async () => {
    setError(null);
    setResult(null);
    try {
      const made = await create.mutateAsync({
        sessionId: ctx.sessionId,
        locationId: ctx.locationId,
        ...(classIds.length ? { classIds } : {}),
        periodKey,
        issueDate,
        ...(custom && dueDate ? { dueDate } : {}),
      });
      setRunId(made.runId);
      setAttempt(newKey());
      await check.mutateAsync(made.runId);
    } catch (e) {
      setError(e);
    }
  };
  const checkAgain = async () => {
    if (!runId) return;
    setError(null);
    try {
      await check.mutateAsync(runId);
    } catch (e) {
      setError(e);
    }
  };

  const r = run.data;
  const groups = useMemo(() => {
    const m = new Map<string, BillingRowDTO[]>();
    for (const row of rows.data?.items ?? []) m.set(row.reasonCode ?? 'OTHER', [...(m.get(row.reasonCode ?? 'OTHER') ?? []), row]);
    return [...m.entries()];
  }, [rows.data]);
  const checked = r && r.state !== 'DRAFT';

  return (
    <div className="space-y-4">
      <TabIntro title="Billing" need="required">
        {BILLING_INTRO}
      </TabIntro>

      <Card aria-label="Bill run">
        <CardHeader>
          <HelpHeading title="Bill run" help={<p>Pick the month and the classes. <b>Check</b> looks at every student without making any bill. You issue the bills only after you have seen the result.</p>} />
        </CardHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <ComboboxField label="Month" value={periodKey} onChange={setPeriod} options={periods.length ? periods : [{ value: periodKey, label: monthLabel(periodKey) }]} searchPlaceholder="Search months…" hint={year ? `Financial year ${year.code}.` : 'Add a financial year in Settings first.'} />
          <TextField label="Bill date" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </div>
        <fieldset className="mt-3 space-y-2">
          <legend className="text-sm font-semibold">Which classes?</legend>
          <p className="text-[13px] text-muted">{ctx.location?.displayName ?? 'This campus'}. Leave all unticked for every class.</p>
          <div className="flex flex-wrap gap-2">
            {(offerings.data ?? []).map((o) => {
              const on = classIds.includes(o.classId);
              return (
                <label key={o.classOfferingId} className={`flex min-h-10 cursor-pointer items-center gap-2 rounded-pill border px-3 text-sm ${on ? 'border-brand bg-brand-soft font-semibold text-brand' : 'border-line bg-white'}`}>
                  <input type="checkbox" className="sr-only" checked={on} onChange={(e) => setClassIds(e.target.checked ? [...classIds, o.classId] : classIds.filter((c) => c !== o.classId))} />
                  {o.displayName}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="mt-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="size-5 accent-[var(--color-brand)]" checked={custom} onChange={(e) => setCustom(e.target.checked)} /> Different due date? (optional)
          </label>
          {custom && <TextField containerClassName="mt-2 max-w-xs" label="Due date for every bill" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} hint="Leave empty to use the due day in each fee plan." />}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <Can permission="finance:billing:create">
            <Button onClick={() => void runCheck()} loading={create.isPending || check.isPending} loadingText="Checking…" disabled={!ctx.sessionId || !ctx.locationId || !year}>
              <SearchCheck /> Check
            </Button>
          </Can>
          <Can permission="finance:billing:create">
            <Button variant="outline" onClick={() => setLateFees(true)}>
              <Receipt /> Late Fee Preview
            </Button>
          </Can>
        </div>
        <ErrorBanner error={error} className="mt-3" />
      </Card>

      {runId && run.isLoading && <Skeleton className="h-24" role="status" aria-label="Loading" />}
      {runId && run.isError && <ErrorState error={run.error} onRetry={() => void run.refetch()} retrying={run.isFetching} />}

      {r && checked && (
        <Card aria-label="Check result">
          <CardHeader>
            <h2 className="text-lg font-bold">
              {monthLabel(r.periodKey)} <FinanceStatusPill status={r.state} />
            </h2>
            <Button variant="outline" size="sm" onClick={() => void checkAgain()} loading={check.isPending} loadingText="Checking…" disabled={r.state === 'ISSUED' || r.state === 'CANCELLED'}>
              <RefreshCw /> Check Again
            </Button>
          </CardHeader>
          <ExceptionHeader
            ready={r.state === 'ISSUED' ? r.counts.issued : r.counts.ready}
            attention={r.counts.needsAttention}
            totalPaise={r.state === 'ISSUED' ? undefined : r.totalPaise}
            readyWord={r.state === 'ISSUED' ? 'issued' : 'ready'}
            action={
              r.state !== 'ISSUED' && r.state !== 'CANCELLED' ? (
                <Can permission="finance:billing:approve" fallback={<p className="text-[13px] text-muted">Only an approver can issue the bills.</p>}>
                  <Button disabled={r.counts.ready === 0} onClick={() => setIssuing(true)}>
                    <FileCheck2 /> {`Issue ${r.counts.ready.toLocaleString('en-IN')} Bills`}
                  </Button>
                </Can>
              ) : undefined
            }
          />
          {result && (
            <Alert tone={result.failed ? 'warning' : 'success'} className="mt-3" title={`Issued ${result.issued} bill${result.issued === 1 ? '' : 's'} for ${formatMoney(result.totalPaise)}`}>
              <span className="flex items-start gap-1.5">
                <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                {result.alreadyIssued > 0 ? `${result.alreadyIssued} were already issued before. ` : ''}
                {result.failed > 0 ? `${result.failed} could not be made. Press Check Again to see why. ` : 'Running this again is safe. Nobody is billed twice.'}
              </span>
            </Alert>
          )}

          {r.counts.needsAttention > 0 && (
            <section aria-label="Needs a look" className="mt-4 space-y-3">
              <h3 className="text-base font-bold">Needs a look</h3>
              {rows.isLoading && <Skeleton className="h-16" />}
              {groups.map(([reason, items]) => {
                const fix = fixLink(reason as BillingReason);
                return (
                  <div key={reason} className="rounded-xl border border-warning/30">
                    <p className="flex items-center justify-between gap-2 rounded-t-xl bg-warning-soft px-3 py-2 text-sm font-bold">
                      <span>{REASON_GROUP_TITLE[reason] ?? 'Other'}</span>
                      <span>{items.length}</span>
                    </p>
                    <ul className="divide-y divide-line">
                      {items.map((row) => (
                        <li key={row.rowId} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                          <div className="min-w-0 flex-1">
                            <p className="font-semibold">
                              {row.studentName} <span className="font-normal text-muted">· {row.className ?? 'No class'}</span>
                            </p>
                            <p className="text-[13px] text-muted">{row.reasonText ?? REASON_TEXT[reason] ?? ''}{row.fixHint ? ` ${row.fixHint}` : ''}</p>
                          </div>
                          {fix && (
                            <Button asChild size="sm" variant="secondary">
                              <Link to={fix.to}>{fix.label}</Link>
                            </Button>
                          )}
                          <Can permission="finance:billing:create">
                            <Button size="sm" variant="outline" onClick={() => setSkipRow(row)} aria-label={`Skip ${row.studentName}`}>
                              Skip
                            </Button>
                          </Can>
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </section>
          )}

          {r.counts.ready > 0 && (
            <details className="mt-4 rounded-xl border border-line px-3 py-2 text-sm">
              <summary className="cursor-pointer font-semibold">
                {r.counts.ready.toLocaleString('en-IN')} ready · show a few
              </summary>
              <ul className="mt-2 divide-y divide-line">
                {(ready.data?.items ?? []).slice(0, 5).map((row) => (
                  <li key={row.rowId} className="flex items-center justify-between gap-2 py-1.5">
                    <span>
                      {row.studentName} <span className="text-muted">· {row.className ?? 'No class'}</span>
                    </span>
                    <Money paise={row.totalPaise} />
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Card>
      )}

      <Card aria-label="Past runs">
        <CardHeader>
          <HelpHeading title="Past runs" help={<p>Every bill run for this school year. A month that is already issued will not make bills twice.</p>} />
        </CardHeader>
        {runs.isLoading && <Skeleton className="h-16" />}
        {runs.data?.items.length === 0 && <p className="text-sm text-muted">No bill runs yet.</p>}
        <ul className="divide-y divide-line text-sm">
          {runs.data?.items.map((x) => (
            <li key={x.runId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <b>{monthLabel(x.periodKey)}</b>
              <FinanceStatusPill status={x.state} />
              <span className="text-muted">
                {x.counts.issued} issued · {x.counts.needsAttention} need attention · {x.counts.skipped} skipped
              </span>
              <span className="ml-auto text-muted">{formatMoneyShort(x.totalPaise)}</span>
              {x.state !== 'ISSUED' && x.state !== 'CANCELLED' && (
                <Button size="sm" variant="ghost" onClick={() => { setRunId(x.runId); setResult(null); setAttempt(newKey()); }} aria-label={`Open the ${monthLabel(x.periodKey)} run`}>
                  Open
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>

      {r && (
        <ConfirmDialog
          open={issuing}
          onOpenChange={setIssuing}
          title={`Issue ${r.counts.ready.toLocaleString('en-IN')} bills?`}
          description="Issued bills cannot be edited. A mistake is fixed with a credit note."
          confirmLabel="Issue Bills"
          loadingLabel="Issuing…"
          onConfirm={async () => {
            const done = await commit.mutateAsync({ id: r.runId, ready: r.counts.ready, total: r.totalPaise, key: attempt });
            setResult(done);
          }}
        >
          <ImpactPreview
            lines={[
              { label: 'Bills to make', value: r.counts.ready.toLocaleString('en-IN') },
              { label: 'Total billed', value: formatMoney(r.totalPaise) },
              { label: 'Left out for now', value: `${r.counts.needsAttention + r.counts.skipped} students` },
            ]}
            note="If this is pressed twice, or the page is closed halfway, nobody is billed twice."
          />
        </ConfirmDialog>
      )}
      <SkipModal runId={runId} row={skipRow} onClose={() => setSkipRow(null)} />
      <LateFeeDrawer open={lateFees} onClose={() => setLateFees(false)} />
    </div>
  );
}

function SkipModal({ runId, row, onClose }: { runId: string | undefined; row: BillingRowDTO | null; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const skip = useFinanceMutation((v: { rowId: string; reason: string }) => financeApi.skipRow(runId!, v.rowId, v.reason), { success: 'Left out of this run.' });
  return (
    <Modal
      open={row !== null}
      onOpenChange={(o) => {
        if (!o) {
          setReason('');
          onClose();
        }
      }}
      title="Leave this student out?"
      description={row ? `${row.studentName} will not get a bill in this run. They stay on the list, so nobody is forgotten.` : undefined}
    >
      <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Left the school this month." maxLength={300} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={reason.trim() === ''}
          loading={skip.isPending}
          loadingText="Saving…"
          onClick={() =>
            skip.mutate(
              { rowId: row!.rowId, reason: reason.trim() },
              {
                onSuccess: () => {
                  setReason('');
                  onClose();
                },
              },
            )
          }
        >
          Skip Student
        </Button>
      </div>
    </Modal>
  );
}

/** "38 bills would get a late fee, ₹4,200", with each sum in words. Apply makes one late-fee bill per overdue bill, never two. */
function LateFeeDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const ctx = useStudentContext();
  const [asOf, setAsOf] = useState(today());
  const [preview, setPreview] = useState<LateFeePreviewDTO | null>(null);
  const [done, setDone] = useState<{ created: number; skipped: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const look = useFinanceMutation(() => financeApi.previewLateFees({ asOf, ...(ctx.locationId ? { locationId: ctx.locationId } : {}) }), { quiet: true });
  const apply = useFinanceMutation(() => financeApi.commitLateFees({ asOf, ...(ctx.locationId ? { locationId: ctx.locationId } : {}) }), { quiet: true });
  const fresh = (preview?.items ?? []).filter((i) => !i.alreadyCharged);
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title="Late fee preview" description="See which overdue bills would get a late fee, before anything is charged.">
        <DrawerBody className="space-y-4">
          <TextField label="Count late fees up to" type="date" value={asOf} onChange={(e) => { setAsOf(e.target.value); setPreview(null); setDone(null); }} />
          <Button
            variant="secondary"
            loading={look.isPending}
            loadingText="Looking…"
            onClick={async () => {
              setError(null);
              setDone(null);
              try {
                setPreview(await look.mutateAsync());
              } catch (e) {
                setError(e);
              }
            }}
          >
            Preview Late Fees
          </Button>
          <ErrorBanner error={error} />
          {preview && (
            <>
              <p className="text-[15px]" aria-live="polite">
                <b>{fresh.length}</b> bill{fresh.length === 1 ? '' : 's'} would get a late fee, <b>{formatMoney(fresh.reduce((s, i) => s + i.feePaise, 0))}</b>.
                {preview.items.length > fresh.length && <span className="text-muted"> {preview.items.length - fresh.length} already have one.</span>}
              </p>
              <ul className="divide-y divide-line rounded-xl border border-line text-sm" aria-label="Bills that would get a late fee">
                {preview.items.slice(0, 30).map((i) => (
                  <li key={i.billId} className="px-3 py-2">
                    <p className="flex items-center justify-between gap-2">
                      <span className="font-semibold">
                        {i.studentName} <span className="font-normal text-muted">· {i.billNumber}</span>
                      </span>
                      <Money paise={i.feePaise} strong />
                    </p>
                    <p className="text-[13px] text-muted">{i.alreadyCharged ? 'Already charged.' : i.formula}</p>
                  </li>
                ))}
              </ul>
            </>
          )}
          {done && (
            <Alert tone="success" title={`${done.created} late fee${done.created === 1 ? '' : 's'} added`}>
              {done.skipped > 0 ? `${done.skipped} were left out because they were already charged or their month is closed.` : 'Each overdue bill can only get this late fee once.'}
            </Alert>
          )}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Can permission="finance:billing:approve">
            <Button
              disabled={fresh.length === 0}
              loading={apply.isPending}
              loadingText="Applying…"
              onClick={async () => {
                setError(null);
                try {
                  setDone(await apply.mutateAsync());
                  setPreview(null);
                } catch (e) {
                  setError(e);
                }
              }}
            >
              Apply Late Fees
            </Button>
          </Can>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
