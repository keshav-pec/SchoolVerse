import { useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { CircleCheck, Clock, FileUp, Printer, Sparkles, TriangleAlert, Undo2 } from 'lucide-react';
import type { MatchDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { TextField, TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { CsvFileField } from '@/components/sv/csv-import';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { PageHeader } from '@/components/sv/page-header';
import { Money } from '@/components/finance/money';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { useBankAccounts, useFinanceMutation } from '../api';
import { ErrorBanner } from '../error-banner';
import { BANKING_INTRO, TIP_RECONCILE, TIP_TIMING_DIFFERENCE } from '../help-copy';
import { bankApi, useMatches, useReconExceptions, useReconSummary } from '../ops-api';
import { Inspector, type ExceptionItem } from './inspector';

/** Import Statement: a CSV from the bank. Columns are found by name and remembered for this account. Importing the same file again adds nothing. */
function ImportDialog({ bankAccountId, onClose }: { bankAccountId: string; onClose: () => void }) {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [opening, setOpening] = useState('');
  const [closing, setClosing] = useState('');
  const run = useFinanceMutation((form: FormData) => bankApi.importStatement(bankAccountId, form), { quiet: true });
  const submit = () => {
    if (!file) return;
    const form = new FormData();
    form.append('file', file);
    if (opening.trim()) form.append('openingBalance', opening.trim());
    if (closing.trim()) form.append('closingBalance', closing.trim());
    run.mutate(form, { onSuccess: (imp) => navigate(`/finance/banking/imports/${imp.importId}?account=${bankAccountId}`) });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Import a bank statement"
      description="Download the statement from your bank as a CSV file and upload it here."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!file} loading={run.isPending} loadingText="Importing…" onClick={submit}>
            Import Statement
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <CsvFileField id="statement-file" hint="Most bank formats work: the date, description, reference and amount columns are found by their names." onFile={setFile} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Opening balance" value={opening} onChange={(e) => setOpening(e.target.value)} hint="Optional. Used to check the file adds up." inputMode="decimal" />
          <TextField label="Closing balance" value={closing} onChange={(e) => setClosing(e.target.value)} hint="Optional." inputMode="decimal" />
        </div>
        <p className="text-[13px] text-muted">The same file twice is safe: lines already imported are skipped.</p>
        {run.error && <ErrorBanner error={run.error} />}
      </div>
    </Modal>
  );
}

function UndoDialog({ match, onClose }: { match: MatchDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const run = useFinanceMutation((r: string) => bankApi.reverse(match.matchId, r), { success: 'Undone. The line is back in the list.' });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Undo this match"
      description="The bank line goes back to the exception list. Nothing else changes."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={!reason.trim()} loading={run.isPending} loadingText="Undoing…" onClick={() => run.mutate(reason.trim(), { onSuccess: onClose })}>
            Undo Match
          </Button>
        </>
      }
    >
      <TextareaField label="Why?" required value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
    </Modal>
  );
}

/** The books-vs-bank statement, ready to print: each part of the difference with what it is. */
function ReconStatement({ bankAccountId }: { bankAccountId: string }) {
  const q = useReconSummary(bankAccountId);
  if (q.isLoading) return <Skeleton className="h-32" />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const s = q.data;
  const Row = ({ label, paise, strong }: { label: string; paise: number | null; strong?: boolean }) => (
    <p className={`flex justify-between gap-3 py-1 ${strong ? 'font-bold' : ''}`}>
      <span>{label}</span>
      <span className="tabular-nums">{paise === null ? 'Not given' : formatMoney(paise)}</span>
    </p>
  );
  return (
    <section aria-label="Reconciliation statement" className="space-y-2 text-sm print:text-black">
      <p className="text-muted">As on {formatDateOnly(s.asOf)}</p>
      <Row label="Balance in the school’s books" paise={s.balancePerBooksPaise} strong />
      {s.inBooksNotInBank.map((x) => (
        <Row key={x.label} label={`  In the books, not in the bank yet: ${x.label}`} paise={x.amountPaise} />
      ))}
      {s.inBankNotInBooks.map((x) => (
        <Row key={x.label} label={`  In the bank, not in the books yet: ${x.label}`} paise={x.amountPaise} />
      ))}
      <Row label="Balance the bank shows" paise={s.balancePerBankPaise} strong />
      <p className={`rounded-xl px-3 py-2 ${s.explained ? 'bg-success-soft text-success' : 'bg-warning-soft text-warning'}`}>{s.sentence}</p>
    </section>
  );
}

/**
 * `/finance/banking` (FUX-10): pick an account; the headline says how many lines were imported and matched and how many need a
 * person; **Resolve N Exceptions** walks through them in the inspector. Timing differences sit apart and calm. Matches the system
 * made by itself are folded away, each with Undo.
 */
export function BankingPage() {
  const [params, setParams] = useSearchParams();
  const banks = useBankAccounts();
  const active = (banks.data ?? []).filter((b) => b.status === 'ACTIVE');
  const bankAccountId = params.get('account') ?? active[0]?.bankAccountId;
  const ex = useReconExceptions(bankAccountId);
  const matches = useMatches(bankAccountId);
  const [importing, setImporting] = useState(false);
  const [inspecting, setInspecting] = useState<ExceptionItem | null>(null);
  const [undo, setUndo] = useState<MatchDTO | null>(null);
  const [statement, setStatement] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const auto = useFinanceMutation(() => bankApi.autoMatch(bankAccountId!), { success: (r) => `${r.confirmed} matched by the system · ${r.suggested} suggested · ${r.unmatched} not matched.` });

  const items = (ex.data?.groups ?? []).flatMap((g) => g.items);
  const exceptions = items.length;
  const systemDone = (matches.data ?? []).filter((m) => m.auto && m.state === 'CONFIRMED');

  if (banks.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />;
  if (active.length === 0)
    return (
      <>
        <PageHeader eyebrow="Finance" title="Banking" />
        <EmptyState
          title="No bank account yet"
          description="Add the school’s bank account first. Then you can import its statements here."
          action={
            <Button asChild>
              <Link to="/finance/settings?tab=bank">Go To Bank & Cash</Link>
            </Button>
          }
        />
      </>
    );

  const c = ex.data?.counts;
  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Banking"
        description="Match the bank statement with the school’s records."
        actions={
          <>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <FileUp /> Import Statement
            </Button>
            <Button variant="outline" loading={auto.isPending} loadingText="Matching…" onClick={() => auto.mutate(undefined)}>
              <Sparkles /> Match Automatically
            </Button>
          </>
        }
      />
      <div className="space-y-4">
        <TabIntro title="Banking">{BANKING_INTRO}</TabIntro>
        <div className="flex flex-wrap items-center gap-3">
          <Combobox
            aria-label="Bank account"
            className="h-10 w-72"
            value={bankAccountId ?? ''}
            onChange={(v) => setParams({ account: v })}
            options={active.map((b) => ({ value: b.bankAccountId, label: b.label, hint: b.accountNumberMasked }))}
            searchPlaceholder="Search accounts…"
          />
          <InfoTip label="About reconcile">{TIP_RECONCILE}</InfoTip>
        </div>

        {ex.isLoading && <Skeleton className="h-20" />}
        {ex.isError && <ErrorState error={ex.error} onRetry={() => void ex.refetch()} retrying={ex.isFetching} />}
        {c && (
          <div className={`flex flex-wrap items-center justify-between gap-3 rounded-xl border px-4 py-3 ${exceptions === 0 ? 'border-success/25 bg-success-soft' : 'border-warning/25 bg-warning-soft'}`}>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px]" data-testid="recon-headline" aria-live="polite">
              {exceptions === 0 ? <CircleCheck className="size-5 text-success" aria-hidden="true" /> : <TriangleAlert className="size-5 text-warning" aria-hidden="true" />}
              {(
                [
                  [c.imported, 'imported'],
                  [c.matched, 'matched'],
                  [c.waitingForVerification, 'waiting for verification'],
                  [c.amountMismatches, 'amount mismatches'],
                  [c.possibleDuplicates, 'possible duplicates'],
                  ...(c.unmatched > 0 ? [[c.unmatched, 'not matched'] as const] : []),
                ] as const
              ).map(([n, word], i) => (
                <span key={word}>
                  {i > 0 && " · "}
                  <b>{n}</b> {word}
                </span>
              ))}
            </p>
            {exceptions > 0 ? (
              <Button
                onClick={() => {
                  setInspecting(items[0]!);
                  listRef.current?.scrollIntoView({ behavior: 'smooth' });
                }}
              >
                Resolve {exceptions} {exceptions === 1 ? 'Exception' : 'Exceptions'}
              </Button>
            ) : (
              <span className="text-sm font-semibold text-success">Everything is matched.</span>
            )}
          </div>
        )}

        <div ref={listRef} className="space-y-4">
          {ex.data?.groups
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <Card key={g.key} aria-label={g.title}>
                <CardHeader>
                  <CardTitle>
                    {g.title} <span className="text-muted">· {g.items.length}</span>
                  </CardTitle>
                </CardHeader>
                <ul className="divide-y divide-line" aria-label={g.title}>
                  {g.items.map((it) => (
                    <li key={it.line.lineId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-sm">
                      <span className="w-24 shrink-0 text-muted">{formatDateOnly(it.line.date)}</span>
                      <span className="min-w-0 flex-1">
                        {it.line.description || 'No description'}
                        {it.line.reference && <span className="text-muted"> · ref {it.line.reference}</span>}
                        <span className="block text-[13px] text-muted">{it.hint}</span>
                      </span>
                      <Money paise={it.line.creditPaise > 0 ? it.line.creditPaise : -it.line.debitPaise} strong />
                      <Button size="sm" variant="outline" onClick={() => setInspecting(it)} aria-label={`Check the line of ${formatMoney(it.line.creditPaise || it.line.debitPaise)} on ${formatDateOnly(it.line.date)}`}>
                        Check
                      </Button>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
        </div>

        {(ex.data?.timingDifferences.length ?? 0) > 0 && (
          <Card aria-label="Timing differences" className="border-line bg-canvas">
            <CardHeader>
              <HelpHeading title={<span className="flex items-center gap-2"><Clock className="size-4 text-muted" aria-hidden="true" /> Timing differences · {ex.data!.timingDifferences.length}</span>} help={TIP_TIMING_DIFFERENCE} helpLabel="About timing differences" className="text-base font-bold" />
            </CardHeader>
            <p className="mb-2 text-[13px] text-muted">Recorded by the school, not in the bank yet. These usually clear by themselves.</p>
            <ul className="space-y-1 text-sm">
              {ex.data!.timingDifferences.map((t) => (
                <li key={t.id} className="flex justify-between gap-3">
                  <span>
                    {t.label} <span className="text-muted">· {formatDateOnly(t.date)}</span>
                  </span>
                  <Money paise={t.amountPaise} />
                </li>
              ))}
            </ul>
          </Card>
        )}

        <details className="rounded-card border border-line bg-white p-4">
          <summary className="cursor-pointer text-base font-bold">Matched by the system · {systemDone.length}</summary>
          {systemDone.length === 0 ? (
            <p className="mt-2 text-sm text-muted">Nothing yet. Import a statement and press Match Automatically.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line text-sm" aria-label="Matched by the system">
              {systemDone.map((m) => (
                <li key={m.matchId} className="flex flex-wrap items-center gap-x-3 py-2">
                  <span className="min-w-0 flex-1">
                    {m.targets.map((t) => t.label).join(', ')} <span className="text-muted">· {m.reasons.join(', ').toLowerCase()}</span>
                  </span>
                  <Money paise={m.linesPaise} />
                  <Button size="sm" variant="ghost" onClick={() => setUndo(m)} aria-label={`Undo the match for ${m.targets.map((t) => t.label).join(', ')}`}>
                    <Undo2 /> Undo
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </details>

        <Card>
          <CardHeader>
            <HelpHeading title="Reconciliation statement" help={<p>Shows why the school’s books and the bank differ today, part by part. Print it for the auditor.</p>} />
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setStatement((v) => !v)} aria-expanded={statement}>
                {statement ? 'Hide' : 'Show Statement'}
              </Button>
              {statement && (
                <Button size="sm" variant="outline" onClick={() => window.print()}>
                  <Printer /> Print
                </Button>
              )}
            </div>
          </CardHeader>
          {statement && bankAccountId && <ReconStatement bankAccountId={bankAccountId} />}
        </Card>
      </div>
      {importing && bankAccountId && <ImportDialog bankAccountId={bankAccountId} onClose={() => setImporting(false)} />}
      {inspecting && bankAccountId && <Inspector key={inspecting.line.lineId} item={inspecting} bankAccountId={bankAccountId} onClose={() => setInspecting(null)} />}
      {undo && <UndoDialog match={undo} onClose={() => setUndo(null)} />}
    </>
  );
}
