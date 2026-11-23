import { useState } from 'react';
import { FINANCE_BUNDLES, FINANCE_BUNDLE_LABELS, ROLE_LABELS, type FinanceAccessDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { messageFor } from '@/lib/errors';
import { financeApi, useFinanceAccess, useFinanceMutation } from '../api';
import { ACCESS_INTRO, TIP_BUNDLES } from '../help-copy';

/** One line for each job, in plain words. */
const JOB_LINE: Record<(typeof FINANCE_BUNDLES)[number], string> = {
  COLLECTOR: 'Cashier – can take fees',
  FEE_MANAGER: 'Fee Manager – plans, bills and concessions',
  ACCOUNTANT: 'Accountant – books, bank and tax',
  PAYROLL_OFFICER: 'Payroll Officer – salaries',
  APPROVER: 'Approver – says yes to big changes',
  AUDITOR: 'Auditor – view only',
};

/** Access: tick the finance jobs of each staff member. A change works straight away. */
export function AccessTab() {
  const q = useFinanceAccess(true);
  const [error, setError] = useState<string | null>(null);
  const save = useFinanceMutation((v: { user: FinanceAccessDTO; bundles: string[] }) => financeApi.setAccess(v.user.userId, { bundles: v.bundles, locationIds: v.user.locationIds }), { success: 'Access saved.', quiet: true });

  return (
    <div className="space-y-4">
      <TabIntro title="Access" need="required">
        {ACCESS_INTRO}
      </TabIntro>
      <Card>
        <CardHeader>
          <HelpHeading title="Who can do what" help={TIP_BUNDLES} />
        </CardHeader>
        {error && (
          <Alert tone="danger" className="mb-3">
            {error}
          </Alert>
        )}
        {q.isLoading && <Skeleton className="h-40" role="status" aria-label="Loading" />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
        {q.data?.length === 0 && <EmptyState title="No staff logins yet" description="Only staff logins can hold a finance job. Add a staff member in People, give them a login, then come back." />}
        <ul className="divide-y divide-line" aria-label="Staff and their finance jobs">
          {q.data?.map((u) => {
            const isAdmin = u.role === 'SCHOOL_ADMIN';
            return (
              <li key={u.userId} className="py-3">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <b>{u.fullName}</b>
                  <span className="text-muted">{u.email}</span>
                  <Badge tone={isAdmin ? 'brand' : 'neutral'}>{ROLE_LABELS[u.role]}</Badge>
                </p>
                {isAdmin ? (
                  <p className="mt-1 text-[13px] text-muted">The School Admin can already do everything in Finance.</p>
                ) : (
                  <fieldset className="mt-2 grid gap-2 sm:grid-cols-2" aria-label={`Finance jobs for ${u.fullName}`}>
                    {FINANCE_BUNDLES.map((b) => {
                      const on = u.bundles.includes(b);
                      return (
                        <label key={b} className="flex items-start gap-3 rounded-xl border border-line px-3 py-2 text-sm">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-5 accent-[var(--color-brand)]"
                            checked={on}
                            disabled={save.isPending}
                            onChange={async (e) => {
                              setError(null);
                              try {
                                await save.mutateAsync({ user: u, bundles: e.target.checked ? [...u.bundles, b] : u.bundles.filter((x) => x !== b) });
                              } catch (err) {
                                setError(messageFor(err));
                              }
                            }}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-semibold">{JOB_LINE[b]}</span>
                            <span className="block text-[13px] text-muted">{FINANCE_BUNDLE_LABELS[b].help}</span>
                          </span>
                        </label>
                      );
                    })}
                  </fieldset>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-3 flex items-center gap-1 text-[13px] text-muted">
          A job never gives access to a campus the person does not work at. <InfoTip label="About campus access">
            <p>Each person sees finance records only for the campuses they work at, whatever jobs they hold.</p>
          </InfoTip>
        </p>
      </Card>
    </div>
  );
}
