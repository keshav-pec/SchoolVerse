import { useState } from 'react';
import { Link } from 'react-router';
import type { SpaceAttentionGroupDTO, SpaceAttentionRowDTO } from '@shared';
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
import { useAssignment, useSpaceAttention } from './allocation-api';
import { fixLink } from './attention';
import { ATTENTION_INTRO, FIX_LABELS } from './help-copy';
import { PickRoomDialog } from './room-picker';

/** "Choose Larger Room" for a section that outgrew its room: loads the row, then opens the room picker with only big-enough rooms. */
function LargerRoomFix({ row, locationId, sessionId, onClose }: { row: SpaceAttentionRowDTO; locationId: string; sessionId: string; onClose: () => void }) {
  const q = useAssignment(row.assignmentId);
  if (!q.data) return null;
  const a = q.data;
  return (
    <PickRoomDialog
      title="Choose a larger room"
      target={{ sectionOfferingId: a.section.sectionOfferingId, label: a.section.label, strength: a.section.strength, assignmentId: a.assignmentId, currentRoom: { spaceId: a.room.spaceId, spaceName: a.room.spaceName }, suggestedRoomId: row.suggestedRoom?.spaceId ?? null, largerOnly: true }}
      locationId={locationId}
      sessionId={sessionId}
      onClose={onClose}
    />
  );
}

function Group({ group, onLarger }: { group: SpaceAttentionGroupDTO; onLarger: (row: SpaceAttentionRowDTO) => void }) {
  return (
    <Card className="p-0" aria-label={group.title}>
      <CardHeader className="mb-0 border-b border-line px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {group.title}
          <Badge tone="warning">{group.count}</Badge>
        </CardTitle>
      </CardHeader>
      <ul className="divide-y divide-line">
        {group.rows.map((row) => {
          const to = fixLink(row);
          const label = FIX_LABELS[row.fix] ?? 'Fix';
          return (
            <li key={row.rowId} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{row.title}</p>
                <p className="text-[13px] text-muted">{row.detail}</p>
                {row.suggestedRoom && (
                  <p className="text-[13px] text-muted">
                    Suggested: <b className="text-ink">{row.suggestedRoom.spaceName}</b>
                    {row.suggestedRoom.academicCapacity !== null && ` (${row.suggestedRoom.academicCapacity} seats)`}
                  </p>
                )}
              </div>
              {to ? (
                <Button asChild size="sm" variant="outline">
                  <Link to={to}>{label}</Link>
                </Button>
              ) : (
                <Button size="sm" variant="outline" onClick={() => onLarger(row)}>
                  {label}
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {group.count > group.rows.length && <p className="border-t border-line px-4 py-2 text-[13px] text-muted">Showing the first {group.rows.length} of {group.count}.</p>}
    </Card>
  );
}

/** `/spaces/attention`: every exception at this campus and school year, grouped by kind of work. Each row has the Fix that solves it. */
export function SpaceAttentionPage() {
  const ctx = useStudentContext();
  const q = useSpaceAttention(ctx.locationId, ctx.sessionId, !ctx.loading);
  const [larger, setLarger] = useState<SpaceAttentionRowDTO | null>(null);
  const groups = q.data?.groups ?? [];
  const open = groups.filter((g) => g.count > 0);
  const clear = groups.filter((g) => g.count === 0);
  const sessionId = q.data?.academicSessionId ?? ctx.sessionId;

  return (
    <>
      <PageHeader eyebrow="Campus" title="Needs Attention" description="Things to finish, so every room and class is ready." />
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
      ) : q.data.counts.needsAttention === 0 ? (
        <Card>
          <EmptyState
            illustration={<ListChecks className="size-14 text-success" aria-hidden="true" />}
            title="Nothing needs attention"
            description="Every section has a room that fits, and every room is set up."
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
            <Group key={g.group} group={g} onLarger={setLarger} />
          ))}
          {clear.length > 0 && (
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted" data-testid="all-clear">
              <CircleCheck className="size-4 text-success" aria-hidden="true" /> Nothing to fix in: {clear.map((g) => g.title).join(' · ')}
            </p>
          )}
        </div>
      )}
      {larger && ctx.locationId && sessionId && <LargerRoomFix row={larger} locationId={ctx.locationId} sessionId={sessionId} onClose={() => setLarger(null)} />}
    </>
  );
}
