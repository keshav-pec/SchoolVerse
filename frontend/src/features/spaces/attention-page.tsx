import { Link } from 'react-router';
import { CircleCheck, ListChecks, Building2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { useStudentContext } from '../students/context';
import { useCampusRooms } from './api';
import { buildAttention, countAttention, fixLink, type AttentionGroup } from './attention';
import { ATTENTION_INTRO, FIX_LABELS } from './help-copy';

function Group({ group }: { group: AttentionGroup }) {
  return (
    <Card className="p-0" aria-label={group.title}>
      <CardHeader className="mb-0 border-b border-line px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {group.title}
          <Badge tone="warning">{group.items.length}</Badge>
        </CardTitle>
      </CardHeader>
      <ul className="divide-y divide-line">
        {group.items.map((item) => (
          <li key={item.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {item.name}
                <span className="ml-2 font-normal text-muted">{item.where}</span>
              </p>
              <p className="text-[13px] text-muted">{item.message}</p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link to={fixLink(item)}>{FIX_LABELS[item.fix] ?? 'Fix'}</Link>
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** `/spaces/attention`: rooms that still need something, grouped by kind of work. Each row has a Fix button that opens the room. */
export function SpaceAttentionPage() {
  const ctx = useStudentContext();
  const q = useCampusRooms(ctx.locationId);
  const groups = q.data ? buildAttention(q.data.items) : [];
  const total = countAttention(groups);
  const open = groups.filter((g) => g.items.length > 0);
  const clear = groups.filter((g) => g.items.length === 0);

  return (
    <>
      <PageHeader eyebrow="Campus" title="Needs Attention" description="Things to finish, so every room is ready to use." />
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
      ) : total === 0 ? (
        <Card>
          <EmptyState
            illustration={<ListChecks className="size-14 text-success" aria-hidden="true" />}
            title="Everything is in order"
            description="No room needs attention at this campus."
            action={
              <Button asChild variant="outline">
                <Link to="/spaces">
                  <Building2 /> Go To Space Setup
                </Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          {open.map((g) => (
            <Group key={g.key} group={g} />
          ))}
          {clear.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted" data-testid="all-clear">
              <CircleCheck className="size-4 text-success" aria-hidden="true" /> Nothing to fix in: {clear.map((g) => g.title).join(' · ')}
            </p>
          )}
          {q.data.total > q.data.items.length && <p className="text-sm text-muted">Showing the first {q.data.items.length} of {q.data.total} rooms.</p>}
        </div>
      )}
    </>
  );
}
