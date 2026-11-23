import { Link } from 'react-router';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { useStudentContext } from '../students/context';
import { ATTENTION_INTRO } from './help-copy';
import { useFinanceAttention } from './ops-api';

/** The sidebar badge: how many finance things need a person. */
export function useFinanceAttentionCount() {
  const { can } = useAuth();
  const q = useFinanceAttention({}, can('finance:view'));
  return q.data?.total ?? 0;
}

/** `/finance/attention`: every group that needs a person, each row with the Fix that opens the exact screen. */
export function FinanceAttentionPage() {
  const ctx = useStudentContext();
  const q = useFinanceAttention({ locationId: ctx.locationId, sessionId: ctx.sessionId });
  const groups = (q.data?.groups ?? []).filter((g) => g.count > 0);
  return (
    <>
      <PageHeader eyebrow="Finance" title="Needs Attention" description={q.data ? `${q.data.total} ${q.data.total === 1 ? 'thing needs' : 'things need'} a person.` : undefined} />
      <div className="space-y-4">
        <TabIntro title="Needs Attention">{ATTENTION_INTRO}</TabIntro>
        {q.isLoading && <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />}
        {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
        {q.data && groups.length === 0 && <EmptyState illustration={<CircleCheck className="size-14 text-success" aria-hidden="true" />} title="Nothing needs attention." description="Everything in Finance is up to date." />}
        {groups.map((g) => (
          <Card key={g.key} aria-label={g.title}>
            <CardHeader>
              <CardTitle>
                {g.title} <span className="text-muted">· {g.count}</span>
              </CardTitle>
            </CardHeader>
            <ul className="divide-y divide-line">
              {g.items.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <span className="min-w-0 flex-1">{i.label}</span>
                  {i.fix && (
                    <Button asChild size="sm" variant="outline">
                      <Link to={i.fix.path} aria-label={`${i.fix.label}: ${i.label}`}>
                        {i.fix.label}
                      </Link>
                    </Button>
                  )}
                </li>
              ))}
            </ul>
            {g.count > g.items.length && <p className="mt-2 text-[13px] text-muted">Showing {g.items.length} of {g.count}.</p>}
          </Card>
        ))}
      </div>
    </>
  );
}
