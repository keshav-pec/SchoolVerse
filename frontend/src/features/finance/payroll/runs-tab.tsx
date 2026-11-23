import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Calculator, CircleCheck, FileText, Lock, PauseCircle, Play, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import type { PayrollRunDTO, RunEmployeeDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent } from '@/components/ui/drawer';
import { TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { Pager } from '@/components/sv/pager';
import { ImpactPreview } from '@/components/finance/impact-preview';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/money';
import { useStudentContext } from '../../students/context';
import { openPdf, useFinanceMutation } from '../api';
import { ErrorBanner } from '../error-banner';
import { PAYROLL_EXCEPTION_LABELS, PAYROLL_INTRO, RUN_TYPE_LABELS, TIP_CORRECTION_RUN, TIP_EMPLOYER_COST } from '../help-copy';
import { payApi, usePayrollRuns, useRunEmployees, useRunExceptions, useRunLines } from '../ops-api';
import { MonthPicker, monthName, usePayrollMonth } from './shared';

const KIND_LABEL: Record<string, string> = { EARNING: 'Pay', ARREAR: 'Arrears', DEDUCTION: 'Deductions', RECOVERY: 'Advance recovery', EMPLOYER_COST: 'Paid by the school (not from salary)' };

/** Salary Explanation: every line with its formula in words and the rule version, then the sum. */
export function SalaryDrawer({ runId, row, onClose }: { runId: string; row: RunEmployeeDTO | null; onClose: () => void }) {
  const lines = useRunLines(runId, row?.employeeId);
  const groups = ['EARNING', 'ARREAR', 'DEDUCTION', 'RECOVERY', 'EMPLOYER_COST'];
  return (
    <Drawer open={row !== null} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title="Salary explanation" description={row ? `${row.employeeName} · ${row.employeeCode}${row.paidDays ? ` · paid days ${row.paidDays}` : ''}` : ''}>
        <DrawerBody className="space-y-4">
          {lines.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading" />}
          {lines.isError && <ErrorState error={lines.error} onRetry={() => void lines.refetch()} retrying={lines.isFetching} />}
          {row && lines.data && (
            <>
              {groups.map((g) => {
                const these = lines.data.filter((l) => l.kind === g);
                if (these.length === 0) return null;
                return (
                  <section key={g} aria-label={KIND_LABEL[g]}>
                    <h3 className="mb-1 flex items-center gap-1 text-sm font-bold">
                      {KIND_LABEL[g]} {g === 'EMPLOYER_COST' && <InfoTip label="About employer cost">{TIP_EMPLOYER_COST}</InfoTip>}
                    </h3>
                    <ul className="divide-y divide-line rounded-xl border border-line">
                      {these.map((l) => (
                        <li key={l.lineId} className="px-3 py-2 text-sm">
                          <p className="flex justify-between gap-3">
                            <b>{l.label}</b>
                            <Money paise={l.amountPaise} />
                          </p>
                          <p className="text-[13px] text-muted">{l.formula}</p>
                        </li>
                      ))}
                    </ul>
                  </section>
                );
              })}
              <p className="rounded-xl bg-canvas px-4 py-3 text-[15px] font-bold" data-testid="salary-sum">
                Gross {formatMoney(row.grossPaise)} − Deductions {formatMoney(row.deductionsPaise)} = Net {formatMoney(row.netPaise)}
              </p>
            </>
          )}
        </DrawerBody>
      </DrawerContent>
    </Drawer>
  );
}

function Tile({ label, paise, tip }: { label: string; paise: number; tip?: ReactNode }) {
  return (
    <div className="rounded-xl border border-line bg-white px-4 py-3" role="group" aria-label={label}>
      <p className="flex items-center gap-1 text-[13px] font-semibold text-muted">
        {label} {tip}
      </p>
      <p className="text-xl font-extrabold tabular-nums">{formatMoney(paise)}</p>
    </div>
  );
}

/** Where each payroll problem is fixed. */
function fixFor(code: string, row: RunEmployeeDTO): { label: string; to: string } | null {
  if (code === 'MISSING_INPUT') return { label: 'Add Days', to: '?tab=inputs' };
  if (code === 'NO_SALARY_ASSIGNED') return { label: 'Set Salary', to: '?tab=setup' };
  if (code === 'PENDING_REVISION') return { label: 'Approve Change', to: '/finance/settings?tab=approvals' };
  if (code === 'BANK_UNVERIFIED') return { label: 'Add Bank Details', to: `/people/${row.employeeId}?tab=personal` };
  if (code === 'RULE_UNAPPROVED') return { label: 'Check Rules', to: '?tab=setup' };
  return null;
}

function HoldDialog({ runId, row, onClose }: { runId: string; row: RunEmployeeDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const run = useFinanceMutation(() => payApi.patchEmployee(runId, row.employeeId, { hold: !row.held, reason: reason.trim() }), { success: row.held ? 'Released. Calculate again to include them.' : 'On hold. They are left out of this payment.' });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={row.held ? `Release ${row.employeeName}` : `Hold ${row.employeeName}’s salary`}
      description={row.held ? 'They will be paid with everyone else.' : 'Their salary is kept back this month. You can release it later.'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!reason.trim()} loading={run.isPending} loadingText="Saving…" onClick={() => run.mutate(undefined, { onSuccess: onClose })}>
            {row.held ? 'Release' : 'Hold Salary'}
          </Button>
        </>
      }
    >
      <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
    </Modal>
  );
}

/** Needs action first: each person with what is wrong and a short fix, without opening a form per person. */
function NeedsAction({ run, onExplain, onHold }: { run: PayrollRunDTO; onExplain: (r: RunEmployeeDTO) => void; onHold: (r: RunEmployeeDTO) => void }) {
  const { can } = useAuth();
  const ex = useRunExceptions(run.runId, can('payroll:run:prepare'));
  if (!can('payroll:run:prepare')) return null;
  if (ex.isLoading) return <Skeleton className="h-24" />;
  const items = ex.data?.items ?? [];
  if (items.length === 0) return null;
  return (
    <Card aria-label="Needs action">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TriangleAlert className="size-5 text-warning" aria-hidden="true" /> Needs action · {items.length}
        </CardTitle>
      </CardHeader>
      <ul className="divide-y divide-line" aria-label="People who need action">
        {items.map((r) => (
          <li key={r.rowId} className="space-y-1 py-2.5 text-sm">
            <p className="flex flex-wrap items-center gap-x-3">
              <b>{r.employeeName}</b>
              <span className="text-muted">
                {r.employeeCode}
                {r.designationName ? ` · ${r.designationName}` : ''}
              </span>
              <span className="ml-auto flex gap-2">
                {can('payroll:salary:view_sensitive') && r.grossPaise > 0 && (
                  <Button size="sm" variant="ghost" onClick={() => onExplain(r)}>
                    Explain
                  </Button>
                )}
                <Button size="sm" variant="outline" onClick={() => onHold(r)} aria-label={`${r.held ? 'Release' : 'Hold'} ${r.employeeName}`}>
                  <PauseCircle /> {r.held ? 'Release' : 'Hold'}
                </Button>
              </span>
            </p>
            {r.exceptions.map((e) => {
              const fix = fixFor(e.code, r);
              return (
                <p key={e.code} className="flex flex-wrap items-center gap-x-2 text-[13px]">
                  <span className={e.level === 'BLOCKER' ? 'font-semibold text-danger' : 'font-semibold text-warning'}>{PAYROLL_EXCEPTION_LABELS[e.code] ?? e.code}:</span>
                  <span>{e.message}</span>
                  <span className="text-muted">{e.fixHint}</span>
                  {fix && (
                    <Link to={fix.to} className="font-semibold text-brand hover:underline">
                      {fix.label}
                    </Link>
                  )}
                </p>
              );
            })}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function ReadyRows({ run, onExplain }: { run: PayrollRunDTO; onExplain: (r: RunEmployeeDTO) => void }) {
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState(false);
  const rows = useRunEmployees(run.runId, { status: 'READY', page }, open);
  const pages = Math.max(1, Math.ceil((rows.data?.total ?? 0) / 50));
  return (
    <details className="rounded-card border border-line bg-white p-4" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="cursor-pointer text-base font-bold">
        <CircleCheck className="mr-1.5 inline size-5 text-success" aria-hidden="true" />
        Ready · {run.counts.ready}
      </summary>
      {open && rows.isLoading && <Skeleton className="mt-2 h-20" />}
      {rows.data && (
        <ul className="mt-2 divide-y divide-line text-sm" aria-label="Ready">
          {rows.data.items.map((r) => (
            <li key={r.rowId}>
              <button type="button" className="flex w-full flex-wrap items-center gap-x-3 py-2 text-left hover:bg-canvas" onClick={() => onExplain(r)} aria-label={`Explain ${r.employeeName}'s salary`}>
                <b>{r.employeeName}</b>
                <span className="text-muted">{[r.employeeCode, r.designationName].filter(Boolean).join(' · ')}</span>
                <span className="ml-auto">
                  Net <Money paise={r.netPaise} strong />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {pages > 1 && <Pager page={page} pages={pages} onPage={setPage} />}
    </details>
  );
}

/** One run: headline, totals with the change from last month, exceptions first, then the buttons that move it on. */
function RunView({ run }: { run: PayrollRunDTO }) {
  const { can } = useAuth();
  const [explain, setExplain] = useState<RunEmployeeDTO | null>(null);
  const [hold, setHold] = useState<RunEmployeeDTO | null>(null);
  const [finalizing, setFinalizing] = useState(false);
  const [ack, setAck] = useState(false);
  const calc = useFinanceMutation(() => payApi.calculate(run.runId), { success: 'Calculated again.' });
  const approve = useFinanceMutation(() => payApi.approve(run.runId), { quiet: true, success: 'Approved. It can be finalised now.' });
  const finalize = useFinanceMutation(() => payApi.finalize(run.runId, { version: run.version, ...(ack ? { acknowledgeDemoRules: true } : {}) }), { quiet: true, success: 'Payroll finalised. Make the payment batch next.' });
  const cancel = useFinanceMutation(() => payApi.cancel(run.runId), { success: 'Run cancelled.' });
  const [statementBusy, setStatementBusy] = useState(false);
  const t = run.totals;
  const editable = run.state === 'DRAFT' || run.state === 'CALCULATED';
  const statement = async () => {
    setStatementBusy(true);
    try {
      await openPdf(`/payroll/runs/${run.runId}/settlement-statement`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setStatementBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${run.counts.needAction === 0 ? 'border-success/25 bg-success-soft' : 'border-warning/25 bg-warning-soft'}`}>
        <p className="text-[15px] font-semibold" data-testid="payroll-headline" aria-live="polite">
          {run.headline}
        </p>
        <span className="flex flex-wrap gap-2">
          <FinanceStatusPill status={run.state} />
          {run.state === 'FINALIZED' && <FinanceStatusPill status={run.payoutStatus} />}
          {run.type !== 'MONTHLY' && <FinanceStatusPill status="DRAFT" label={RUN_TYPE_LABELS[run.type]} />}
        </span>
      </div>
      {run.warnings.map((w) => (
        <Alert key={w} tone="danger" title="Demo values">
          {w}
        </Alert>
      ))}
      <section aria-label="Payroll totals" className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Gross" paise={t.grossPaise} />
        <Tile label="Deductions" paise={t.deductionsPaise} />
        <Tile label="Employer cost" paise={t.employerCostPaise} tip={<InfoTip label="About employer cost">{TIP_EMPLOYER_COST}</InfoTip>} />
        <Tile label="Net pay" paise={t.netPaise} />
      </section>
      {run.changeSentence && <p className="text-sm text-muted">{run.changeSentence}</p>}

      <div className="flex flex-wrap gap-2">
        {editable && can('payroll:run:prepare') && (
          <Button variant="outline" loading={calc.isPending} loadingText="Calculating…" onClick={() => calc.mutate(undefined)}>
            <Calculator /> Calculate Again
          </Button>
        )}
        {run.state === 'CALCULATED' && can('payroll:run:approve') && (
          <Button loading={approve.isPending} loadingText="Approving…" onClick={() => approve.mutate(undefined)}>
            <CircleCheck /> Approve
          </Button>
        )}
        {run.state === 'APPROVED' && can('payroll:run:approve') && (
          <Button onClick={() => setFinalizing(true)}>
            <Lock /> Finalize Payroll
          </Button>
        )}
        {run.type === 'FULL_FINAL' && can('payroll:salary:view_sensitive') && (
          <Button variant="outline" onClick={() => void statement()} loading={statementBusy} loadingText="Opening…">
            <FileText /> Settlement Statement
          </Button>
        )}
        {editable && can('payroll:run:prepare') && (
          <Button variant="ghost" loading={cancel.isPending} loadingText="Cancelling…" onClick={() => cancel.mutate(undefined)}>
            Cancel Run
          </Button>
        )}
      </div>
      {run.state === 'CALCULATED' && (
        <p className="text-sm text-muted">
          {run.counts.needAction > 0 ? 'Fix the people below, then a different person with approval rights approves it.' : 'Ready for approval. A different person with approval rights presses Approve.'}
        </p>
      )}
      {approve.error && <ErrorBanner error={approve.error} />}

      <NeedsAction run={run} onExplain={setExplain} onHold={setHold} />
      {can('payroll:salary:view_sensitive') ? <ReadyRows run={run} onExplain={setExplain} /> : <p className="text-sm text-muted">You can see the totals. The list of people and their pay needs salary access.</p>}

      <SalaryDrawer runId={run.runId} row={explain} onClose={() => setExplain(null)} />
      {hold && <HoldDialog runId={run.runId} row={hold} onClose={() => setHold(null)} />}
      <ConfirmDialog
        open={finalizing}
        onOpenChange={(o) => {
          setFinalizing(o);
          if (!o) setAck(false);
        }}
        title={`Finalize ${monthName(run.month)} payroll?`}
        description={
          <span className="flex items-center gap-1">
            This cannot be edited later. Use a correction run. <InfoTip label="About correction runs">{TIP_CORRECTION_RUN}</InfoTip>
          </span>
        }
        confirmLabel="Finalize Payroll"
        loadingLabel="Finalising…"
        onConfirm={async () => {
          await finalize.mutateAsync(undefined);
        }}
      >
        <ImpactPreview
          title="What goes into the books"
          lines={[
            { label: 'Salary expense (gross + employer cost)', value: formatMoney(t.grossPaise + t.employerCostPaise) },
            { label: 'Salaries to pay (net)', value: formatMoney(t.netPaise) },
            { label: 'Deductions and contributions to pay over', value: formatMoney(t.deductionsPaise + t.employerCostPaise) },
          ]}
          note="Nobody is paid yet. Payment happens from the bank, and is recorded in Payments."
        />
        {run.warnings.length > 0 && (
          <label className="mt-3 flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 size-5 accent-[var(--color-brand)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
            I understand the PF, ESI and Professional Tax rules are demo values, not approved by our accountant.
          </label>
        )}
      </ConfirmDialog>
    </div>
  );
}

/** Payroll Runs (FUX-11): the month's run, exception first. */
export function RunsTab() {
  const { can } = useAuth();
  const [month] = usePayrollMonth();
  const ctx = useStudentContext();
  const runs = usePayrollRuns({ month });
  // A monthly run is for the campus in the bar at the top: the people who work there.
  const start = useFinanceMutation(async () => {
    const run = await payApi.createRun({ month, ...(ctx.locationId ? { locationId: ctx.locationId } : {}) });
    return payApi.calculate(run.runId);
  }, { success: 'Payroll calculated.' });
  const live = (runs.data?.items ?? []).filter((r) => r.state !== 'CANCELLED');
  const [picked, setPicked] = useState<string | null>(null);
  const run = live.find((r) => r.runId === picked) ?? live.find((r) => r.type === 'MONTHLY') ?? live[0];
  return (
    <div className="space-y-4">
      <TabIntro title="Payroll Runs">{PAYROLL_INTRO}</TabIntro>
      <div className="flex flex-wrap items-center gap-2">
        <MonthPicker />
        {live.length > 1 &&
          live.map((r) => (
            <Button key={r.runId} size="sm" variant={r.runId === run?.runId ? 'default' : 'outline'} onClick={() => setPicked(r.runId)}>
              {RUN_TYPE_LABELS[r.type]} · {r.number}
            </Button>
          ))}
      </div>
      {runs.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading" />}
      {runs.isError && <ErrorState error={runs.error} onRetry={() => void runs.refetch()} retrying={runs.isFetching} />}
      {runs.data && !run && (
        <EmptyState
          title={`No payroll for ${monthName(month)} yet`}
          description={`Start it for ${ctx.location?.displayName ?? 'this campus'} and SchoolVerse works out every salary. You only look at the people who need action.`}
          action={
            can('payroll:run:prepare') ? (
              <Button loading={start.isPending} loadingText="Calculating…" onClick={() => start.mutate(undefined)}>
                <Play /> Start {monthName(month)} Payroll
              </Button>
            ) : undefined
          }
        />
      )}
      {start.error && <ErrorBanner error={start.error} />}
      {run && <RunView key={run.runId} run={run} />}
    </div>
  );
}
