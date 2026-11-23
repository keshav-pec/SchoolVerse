import { Link, useParams, useSearchParams } from 'react-router';
import { useQueries } from '@tanstack/react-query';
import { ArrowLeft, Sparkles } from 'lucide-react';
import type { StatementImportDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { PageHeader } from '@/components/sv/page-header';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { api } from '@/lib/api';
import { formatDateOnly } from '@/lib/format';
import { formatMoney } from '@/lib/money';
import { FIN, useBankAccounts, useFinanceMutation } from '../api';
import { bankApi, useStatementLines } from '../ops-api';

/** `/finance/banking/imports/:id`: what one statement file brought in, and a button to match it. */
export function StatementImportPage() {
  const { importId } = useParams();
  const [params] = useSearchParams();
  const banks = useBankAccounts();
  const accountIds = params.get('account') ? [params.get('account')!] : (banks.data ?? []).map((b) => b.bankAccountId);
  const lists = useQueries({ queries: accountIds.map((id) => ({ queryKey: [...FIN, 'imports', id], queryFn: () => api.get<StatementImportDTO[]>(`/finance/bank-accounts/${id}/statements`) })) });
  const imp = lists.flatMap((l) => l.data ?? []).find((i) => i.importId === importId);
  const lines = useStatementLines({ bankAccountId: imp?.bankAccountId }, !!imp);
  const auto = useFinanceMutation(() => bankApi.autoMatch(imp!.bankAccountId), { success: (r) => `${r.confirmed} matched by the system · ${r.suggested} suggested · ${r.unmatched} not matched.` });
  const inFile = (lines.data?.items ?? []).filter((l) => l.importId === importId);
  const back = (
    <Button asChild variant="ghost" size="sm" className="-ml-2">
      <Link to={`/finance/banking${imp ? `?account=${imp.bankAccountId}` : ''}`}>
        <ArrowLeft /> Back To Banking
      </Link>
    </Button>
  );
  if (banks.isLoading || lists.some((l) => l.isLoading)) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />;
  if (!imp) return <>{back}<EmptyState title="Statement not found" description="It may belong to another bank account." /></>;
  return (
    <div className="space-y-4">
      {back}
      <PageHeader
        eyebrow="Bank statement"
        title={imp.fileName}
        description={`${formatDateOnly(imp.fromDate)} to ${formatDateOnly(imp.toDate)}`}
        actions={
          <Button loading={auto.isPending} loadingText="Matching…" onClick={() => auto.mutate(undefined)}>
            <Sparkles /> Match Now
          </Button>
        }
      />
      <p className="text-[15px]" data-testid="import-summary">
        <b>{imp.rowCount}</b> lines · <b>{imp.keptCount}</b> new · <b>{imp.skippedCount}</b> already imported
        {imp.suspectedDuplicates > 0 && <> · <b className="text-danger">{imp.suspectedDuplicates}</b> look like duplicates</>} · money in {formatMoney(imp.creditsPaise)} · money out {formatMoney(imp.debitsPaise)}
      </p>
      {imp.suspectedDuplicates > 0 && <Alert tone="warning">Some lines look like the same money twice. They are kept, and shown under Possible duplicates for a person to check.</Alert>}
      <Card>
        <CardHeader>
          <CardTitle>Lines from this file</CardTitle>
        </CardHeader>
        {lines.isLoading ? (
          <Skeleton className="h-24" />
        ) : inFile.length === 0 ? (
          <p className="text-sm text-muted">No new lines: everything in this file was already imported.</p>
        ) : (
          <ul className="divide-y divide-line text-sm" aria-label="Statement lines">
            {inFile.map((l) => (
              <li key={l.lineId} className="flex flex-wrap items-center gap-x-3 py-2">
                <span className="w-24 text-muted">{formatDateOnly(l.date)}</span>
                <span className="min-w-0 flex-1">
                  {l.description}
                  {l.reference && <span className="text-muted"> · {l.reference}</span>}
                </span>
                <Money paise={l.creditPaise > 0 ? l.creditPaise : -l.debitPaise} strong />
                <FinanceStatusPill status={l.status} />
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
