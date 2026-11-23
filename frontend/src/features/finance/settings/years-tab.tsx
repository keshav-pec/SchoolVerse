import { useState } from 'react';
import { CalendarPlus } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { financeApi, useFinanceMutation, useFinancialYears } from '../api';
import { YEARS_INTRO } from '../help-copy';

const monthName = (code: string) => new Date(`${code}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'short', timeZone: 'UTC' });

/** The next year after the last one added, in the form 2027-28. */
function nextCode(codes: string[]): string {
  const last = [...codes].sort().at(-1);
  const m = last ? /^(\d{4})-\d{2}$/.exec(last) : null;
  const start = m ? Number(m[1]) + 1 : new Date().getFullYear();
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/** Years & Periods: each financial year with its 12 months. Adding a year makes the months for you. */
export function YearsTab() {
  const years = useFinancialYears();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const add = useFinanceMutation((c: string) => financeApi.createYear(c), { success: 'Financial year added with its 12 months.', quiet: true });
  const suggestion = nextCode((years.data ?? []).map((y) => y.code));
  const value = code || suggestion;
  return (
    <div className="space-y-4">
      <TabIntro title="Years & Periods" need="required">
        {YEARS_INTRO}
      </TabIntro>
      <Can permission="finance:setup:manage">
        <Card aria-label="Add a financial year">
          <CardHeader>
            <HelpHeading title="Add a financial year" help={<p>A year runs from April to March. Write it like 2026-27. The 12 months are made for you.</p>} />
          </CardHeader>
          <div className="flex flex-wrap items-end gap-3">
            <TextField label="Year" value={value} onChange={(e) => setCode(e.target.value)} hint="Example: 2026-27." maxLength={7} containerClassName="w-48" />
            <Button
              loading={add.isPending}
              loadingText="Adding…"
              onClick={async () => {
                setError(null);
                try {
                  await add.mutateAsync(value.trim());
                  setCode('');
                } catch (e) {
                  setError(messageFor(e));
                }
              }}
            >
              <CalendarPlus /> Add Year
            </Button>
          </div>
          {error && (
            <Alert tone="danger" className="mt-3">
              {error}
            </Alert>
          )}
        </Card>
      </Can>
      {years.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading" />}
      {years.isError && <ErrorState error={years.error} onRetry={() => void years.refetch()} retrying={years.isFetching} />}
      {years.data?.length === 0 && (
        <Card>
          <EmptyState title="No financial year yet" description="Add the current year above. Bills and payments need an open month to be recorded in." />
        </Card>
      )}
      {years.data?.map((y) => (
        <Card key={y.financialYearId} aria-label={`Financial year ${y.code}`}>
          <CardHeader>
            <h2 className="text-lg font-bold">FY {y.code}</h2>
            <p className="text-sm text-muted">
              {formatDateOnly(y.startDate)} to {formatDateOnly(y.endDate)}
            </p>
          </CardHeader>
          <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6" aria-label={`Months of ${y.code}`}>
            {y.periods.map((p) => (
              <li key={p.periodId} className="rounded-xl border border-line px-3 py-2 text-sm">
                <p className="font-semibold">
                  {monthName(p.code)} <span className="font-normal text-muted">{p.code.slice(0, 4)}</span>
                </p>
                <FinanceStatusPill status={p.state} />
              </li>
            ))}
          </ul>
        </Card>
      ))}
      <p className="text-[13px] text-muted">Closing a month, and the checks before it, are added in a later release. Until then every month stays open.</p>
    </div>
  );
}
