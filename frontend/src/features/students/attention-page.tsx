import { Link } from 'react-router';
import type { AttentionGroupDTO, AttentionItemDTO } from '@shared';
import { CircleCheck, ListChecks, Users } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { useAttention } from './api';
import { useStudentContext } from './context';
import { ATTENTION_INTRO, FIX_LABELS } from './help-copy';

/** Where "Fix" goes: the student's page with the right drawer open, or the parent's page. */
export function fixLink(item: AttentionItemDTO): string {
  if (item.fix === 'OPEN_FAMILY' && item.personId) return `/families/${item.personId}`;
  if (item.fix === 'REVIEW_PROMOTION') return '/students/promotion';
  if (item.fix === 'OPEN_STUDENT') return `/students/${item.studentId}`;
  return `/students/${item.studentId}?fix=${item.fix}`;
}

function Group({ group }: { group: AttentionGroupDTO }) {
  return (
    <Card className="p-0" aria-label={group.title}>
      <CardHeader className="mb-0 border-b border-line px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {group.title}
          <Badge tone={group.items.length > 0 ? 'warning' : 'success'}>{group.items.length}</Badge>
        </CardTitle>
      </CardHeader>
      {group.items.length === 0 ? (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted">
          <CircleCheck className="size-4 text-success" aria-hidden="true" /> Nothing to fix here.
        </p>
      ) : (
        <ul className="divide-y divide-line">
          {group.items.map((item) => (
            <li key={item.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {item.studentId ? (
                    <Link to={`/students/${item.studentId}`} className="text-ink hover:text-brand hover:underline">
                      {item.fullName}
                    </Link>
                  ) : (
                    <Link to={`/families/${item.personId}`} className="text-ink hover:text-brand hover:underline">
                      {item.fullName}
                    </Link>
                  )}
                  {item.classSection && <span className="ml-2 font-normal text-muted">{item.classSection.label}</span>}
                </p>
                <p className="text-[13px] text-muted">{item.message}</p>
              </div>
              <Button asChild size="sm" variant="outline">
                <Link to={fixLink(item)}>{FIX_LABELS[item.fix] ?? 'Fix'}</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** `/students/attention`: what still needs doing, grouped by kind of work. Each row has a Fix button. */
export function AttentionPage() {
  const ctx = useStudentContext();
  const q = useAttention({ academicSessionId: ctx.sessionId, locationId: ctx.locationId }, Boolean(ctx.sessionId));
  const groups = q.data?.groups ?? [];
  const fixNow = groups.filter((g) => !g.followUp);
  const clear = fixNow.filter((g) => g.items.length === 0);
  const followUp = groups.filter((g) => g.followUp && g.items.length > 0);

  return (
    <>
      <PageHeader eyebrow="Students" title="Needs Attention" description="Things to finish, so every student is fully set up." />
      <TabIntro title="About this list" className="mb-4">
        {ATTENTION_INTRO}
      </TabIntro>
      {q.isLoading || ctx.loading ? (
        <div className="space-y-4" role="status" aria-label="Loading">
          <Skeleton className="h-32 rounded-card" />
          <Skeleton className="h-32 rounded-card" />
        </div>
      ) : q.isError || !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="space-y-4">
          {q.data.counts.needsAttention === 0 ? (
            <Card>
              <EmptyState
                illustration={<ListChecks className="size-14 text-success" aria-hidden="true" />}
                title="Everything is in order"
                description="No student needs attention for this year and campus."
                action={
                  <Button asChild variant="outline">
                    <Link to="/students">
                      <Users /> Go To Students
                    </Link>
                  </Button>
                }
              />
            </Card>
          ) : (
            fixNow.filter((g) => g.items.length > 0).map((g) => <Group key={g.key} group={g} />)
          )}
          {q.data.counts.needsAttention > 0 && clear.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted" data-testid="all-clear">
              <CircleCheck className="size-4 text-success" aria-hidden="true" /> Nothing to fix in: {clear.map((g) => g.title).join(' · ')}
            </p>
          )}
          {followUp.length > 0 && (
            <section aria-label="Follow up" className="space-y-4 pt-2">
              <div>
                <h2 className="text-lg font-bold">Follow up</h2>
                <p className="text-sm text-muted">Not urgent, and not counted in the badge. Work through these when you have time.</p>
              </div>
              {followUp.map((g) => (
                <Group key={g.key} group={g} />
              ))}
            </section>
          )}
        </div>
      )}
    </>
  );
}
