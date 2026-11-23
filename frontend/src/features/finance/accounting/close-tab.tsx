import { useState } from 'react';
import { Link } from 'react-router';
import { CircleCheck, Lock, LockOpen, TriangleAlert } from 'lucide-react';
import type { OpeningPreviewDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { CsvFileField } from '@/components/sv/csv-import';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { formatDateTime } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { useFinanceMutation } from '../api';
import { useApprovalFlow } from '../approval-flow';
import { todayLocal } from '../collect/shared';
import { useFinanceYear } from '../context';
import { ErrorBanner } from '../error-banner';
import { CLOSE_INTRO, TIP_CLOSE_PERIOD } from '../help-copy';
import { bookApi, useCloseReadiness } from '../ops-api';
import { monthName } from '../payroll/shared';

const LEVEL: Record<string, { label: string; tone: 'danger' | 'warning' | 'neutral' }> = {
  BLOCKER: { label: 'Must fix', tone: 'danger' },
  WARNING: { label: 'Can accept', tone: 'warning' },
  INFO: { label: 'Good to know', tone: 'neutral' },
};

/** Opening balances: one CSV, a balance check before anything is saved, and the same file twice adds nothing. */
function OpeningBalances() {
  const [file, setFile] = useState<File | null>(null);
  const [asOf, setAsOf] = useState(todayLocal());
  const [preview, setPreview] = useState<OpeningPreviewDTO | null>(null);
  const form = () => {
    const f = new FormData();
    f.append('file', file!);
    f.append('asOf', asOf);
    return f;
  };
  const check = useFinanceMutation(() => bookApi.previewOpening(form()), { quiet: true });
  const commit = useFinanceMutation(() => bookApi.commitOpening(form()), { success: 'Opening balances are in the books.' });
  return (
    <Card aria-label="Opening balances">
      <CardHeader>
        <HelpHeading title="Opening balances (import)" help={<p>Balances carried over from the old books on the day you start using SchoolVerse. One CSV with the columns kind, reference, debit, credit. Kinds: ACCOUNT, STUDENT, VENDOR, ADVANCE.</p>} />
      </CardHeader>
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <CsvFileField id="opening-file" hint="Example row: ACCOUNT, 1100, 250000, 0" onFile={(f) => { setFile(f); setPreview(null); }} />
          <TextField label="Balances as on" type="date" required value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </div>
        <Button variant="outline" disabled={!file} loading={check.isPending} loadingText="Checking…" onClick={() => check.mutate(undefined, { onSuccess: setPreview })}>
          Check File
        </Button>
        {check.error && <ErrorBanner error={check.error} />}
        {preview && (
          <div className="space-y-2">
            <Alert tone={preview.balanced && preview.problems.length === 0 ? 'success' : 'warning'} title={preview.balanced ? 'The accounts balance' : 'The accounts do not balance'}>
              {preview.rows} rows · debits {formatMoney(preview.accountDebitPaise)} · credits {formatMoney(preview.accountCreditPaise)} · students owe {formatMoney(preview.studentPaise)} · owed to vendors {formatMoney(preview.vendorPaise)}
              {preview.committed && ' · This file was already imported.'}
            </Alert>
            {preview.problems.length > 0 && (
              <ul className="list-disc pl-5 text-sm text-danger" aria-label="Row problems">
                {preview.problems.map((p) => (
                  <li key={p.row}>
                    Row {p.row}: {p.message}
                  </li>
                ))}
              </ul>
            )}
            {preview.balanced && preview.problems.length === 0 && !preview.committed && (
              <Can permission="finance:accounting:post">
                <Button loading={commit.isPending} loadingText="Importing…" onClick={() => commit.mutate(undefined, { onSuccess: setPreview })}>
                  Import Opening Balances
                </Button>
              </Can>
            )}
            {commit.error && <ErrorBanner error={commit.error} />}
          </div>
        )}
      </div>
    </Card>
  );
}

/** Close tab (FUX-13): pick a month; the readiness card lists each item with its level and a Fix button. Closing needs a second person. */
export function CloseTab() {
  const { year } = useFinanceYear();
  const periods = year?.periods ?? [];
  const lastMonth = todayLocal().slice(0, 7);
  const [periodId, setPeriodId] = useState<string>(() => periods.filter((p) => p.code < lastMonth && p.state === 'OPEN')[0]?.periodId ?? periods[0]?.periodId ?? '');
  const id = periodId || periods[0]?.periodId;
  const r = useCloseReadiness(id);
  const [warnReason, setWarnReason] = useState('');
  const [reopenReason, setReopenReason] = useState('');
  const closeFlow = useApprovalFlow();
  const reopenFlow = useApprovalFlow();
  const close = useFinanceMutation((approvalId: string | undefined) => bookApi.closePeriod(id!, { ...(warnReason.trim() ? { warningReason: warnReason.trim() } : {}), ...(approvalId ? { approvalId } : {}) }), { quiet: true, success: 'The month is closed.' });
  const reopen = useFinanceMutation((approvalId: string | undefined) => bookApi.reopenPeriod(id!, { reason: reopenReason.trim(), ...(approvalId ? { approvalId } : {}) }), { quiet: true, success: 'The month is open again.' });
  const lock = useFinanceMutation(() => bookApi.lockPeriod(id!), { success: 'The month is locked for good.' });
  const d = r.data;
  return (
    <div className="space-y-4">
      <TabIntro title="Close a month">{CLOSE_INTRO}</TabIntro>
      <div className="flex flex-wrap items-center gap-2">
        <Combobox aria-label="Month to close" className="h-10 w-56" value={id ?? ''} onChange={(v) => { setPeriodId(v); closeFlow.reset(); reopenFlow.reset(); }} options={periods.map((p) => ({ value: p.periodId, label: monthName(p.code), hint: p.state === 'OPEN' ? undefined : p.state.toLowerCase() }))} searchPlaceholder="Search months…" placeholder="No months yet" />
        <InfoTip label="About closing a month">{TIP_CLOSE_PERIOD}</InfoTip>
      </div>
      {r.isLoading && <Skeleton className="h-40" />}
      {r.isError && <ErrorState error={r.error} onRetry={() => void r.refetch()} retrying={r.isFetching} />}
      {d && (
        <Card aria-label="Close readiness">
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {d.blockers ? <TriangleAlert className="size-5 text-warning" aria-hidden="true" /> : <CircleCheck className="size-5 text-success" aria-hidden="true" />} Close readiness <FinanceStatusPill status={d.state} />
            </CardTitle>
          </CardHeader>
          <p className="mb-3 text-[15px] font-semibold" data-testid="close-headline">
            {d.headline}
          </p>
          {d.state !== 'OPEN' && d.closedByName && (
            <p className="mb-3 text-sm text-muted">
              {d.state === 'LOCKED' ? 'Locked' : 'Closed'} by {d.closedByName}
              {d.closedAt ? ` on ${formatDateTime(d.closedAt)}` : ''}.
            </p>
          )}
          <ul className="divide-y divide-line" aria-label="Close checks">
            {d.checks.map((c) => (
              <li key={c.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                <Badge tone={c.count === 0 ? 'success' : LEVEL[c.level]!.tone}>{c.count === 0 ? 'Done' : LEVEL[c.level]!.label}</Badge>
                <b>{c.title}</b>
                <span className="min-w-0 flex-1 text-muted">{c.sentence}</span>
                {c.count > 0 && c.fix && (
                  <Button asChild size="sm" variant="outline">
                    <Link to={c.fix.path}>Fix</Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
          <Can permission="finance:period:close">
            <div className="mt-4 space-y-3 border-t border-line pt-3">
              {d.state === 'OPEN' && (
                <>
                  {d.warnings > 0 && <TextareaField label="Why is it fine to close with the items marked “Can accept”?" value={warnReason} onChange={(e) => setWarnReason(e.target.value)} maxLength={300} />}
                  {closeFlow.banner}
                  {closeFlow.errorBox}
                  {close.error && !closeFlow.error && !closeFlow.waiting && <ErrorBanner error={close.error} />}
                  <Button disabled={!d.canClose || (d.warnings > 0 && !warnReason.trim())} loading={close.isPending} loadingText="Closing…" onClick={() => void closeFlow.run((a) => close.mutateAsync(a))}>
                    <Lock /> {closeFlow.label('Close Period')}
                  </Button>
                  {!d.canClose && <p className="text-[13px] text-muted">Fix the “Must fix” items first.</p>}
                </>
              )}
              {d.state === 'CLOSED' && (
                <>
                  <TextareaField label="Why reopen it?" required value={reopenReason} onChange={(e) => setReopenReason(e.target.value)} hint="Example: A September bank charge was found late." maxLength={300} />
                  {reopenFlow.banner}
                  {reopenFlow.errorBox}
                  <div className="flex flex-wrap gap-2">
                    <Button variant="outline" disabled={!reopenReason.trim()} loading={reopen.isPending} loadingText="Reopening…" onClick={() => void reopenFlow.run((a) => reopen.mutateAsync(a))}>
                      <LockOpen /> {reopenFlow.label('Reopen (Needs Approval)')}
                    </Button>
                    <Button variant="ghost" loading={lock.isPending} loadingText="Locking…" onClick={() => lock.mutate(undefined)}>
                      Lock For Good
                    </Button>
                  </div>
                </>
              )}
              {d.state === 'LOCKED' && <p className="text-sm text-muted">A locked month can never be opened again.</p>}
            </div>
          </Can>
        </Card>
      )}
      <OpeningBalances />
    </div>
  );
}
