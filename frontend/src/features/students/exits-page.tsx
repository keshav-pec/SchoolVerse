import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { StudentDirectoryDTO } from '@shared';
import { CircleCheck, DoorOpen } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { useAttention, useStudents } from './api';
import { useStudentContext } from './context';
import { EXITS_INTRO } from './help-copy';
import { placementText, StudentStatusPill } from './student-bits';

function Section({ title, count, children, empty }: { title: string; count: number | undefined; children: ReactNode; empty: string }) {
  return (
    <Card className="p-0" aria-label={title}>
      <h2 className="flex items-center gap-2 border-b border-line px-4 py-3 text-base font-bold">
        {title} {count !== undefined && <Badge tone={count > 0 ? 'warning' : 'success'}>{count}</Badge>}
      </h2>
      {count === 0 ? (
        <p className="flex items-center gap-2 px-4 py-4 text-sm text-muted">
          <CircleCheck className="size-4 text-success" aria-hidden="true" /> {empty}
        </p>
      ) : (
        children
      )}
    </Card>
  );
}

function StudentRows({ rows }: { rows: StudentDirectoryDTO[] }) {
  return (
    <ul className="divide-y divide-line">
      {rows.map((s) => (
        <li key={s.studentId} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <Link to={`/students/${s.studentId}?tab=exit`} className="text-sm font-semibold text-ink hover:text-brand hover:underline">
              {s.fullName}
            </Link>
            <p className="text-[13px] text-muted">
              <span className="font-mono">{s.admissionNumber ?? '—'}</span> · {placementText(s.classSection, s.rollNumber)}
            </p>
          </div>
          <StudentStatusPill status={s.status} />
          <Button asChild size="sm" variant="outline">
            <Link to={`/students/${s.studentId}?tab=exit`}>Open Exit</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}

/** `/students/exits`: students leaving or gone this year, and exits or certificates still to finish. */
export function ExitsPage() {
  const ctx = useStudentContext();
  const scope = { academicSessionId: ctx.sessionId, locationId: ctx.locationId, pageSize: 100 };
  const enabled = Boolean(ctx.sessionId);
  const leaving = useStudents({ ...scope, status: 'WITHDRAWAL_INITIATED' }, enabled);
  const left = useStudents({ ...scope, status: 'WITHDRAWN,TRANSFERRED_OUT,COMPLETED_SCHOOLING' }, enabled);
  const attention = useAttention({ academicSessionId: ctx.sessionId, locationId: ctx.locationId }, enabled);
  const toFinish = attention.data?.groups.find((g) => g.key === 'EXIT')?.items ?? [];

  if (ctx.loading || leaving.isLoading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading">
        <Skeleton className="h-32 rounded-card" />
        <Skeleton className="h-32 rounded-card" />
      </div>
    );
  }

  return (
    <>
      <PageHeader eyebrow="Students" title="Transfers & Exits" description="Who is leaving, who has left, and what is still to finish." />
      <TabIntro title="About this page" className="mb-4">
        {EXITS_INTRO}
      </TabIntro>
      <div className="space-y-4">
        <Section title="To finish" count={attention.data ? toFinish.length : undefined} empty="No exit or transfer certificate is waiting.">
          {attention.isError ? (
            <ErrorState error={attention.error} onRetry={() => void attention.refetch()} retrying={attention.isFetching} />
          ) : (
            <ul className="divide-y divide-line">
              {toFinish.map((item) => (
                <li key={item.key} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <DoorOpen className="size-4 text-warning" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold">{item.fullName}</p>
                    <p className="text-[13px] text-muted">{item.message}</p>
                  </div>
                  <Button asChild size="sm" variant="outline">
                    <Link to={`/students/${item.studentId}?tab=exit`}>Open Exit</Link>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Section>
        <Section title="Leaving soon" count={leaving.data?.total} empty="Nobody is leaving. Start a withdrawal from a student’s Transfers & Exit tab.">
          {leaving.isError ? <ErrorState error={leaving.error} onRetry={() => void leaving.refetch()} retrying={leaving.isFetching} /> : <StudentRows rows={leaving.data?.items ?? []} />}
        </Section>
        <Section title="Left this year" count={left.data?.total} empty="Nobody has left this year.">
          {left.isError ? <ErrorState error={left.error} onRetry={() => void left.refetch()} retrying={left.isFetching} /> : <StudentRows rows={left.data?.items ?? []} />}
        </Section>
      </div>
    </>
  );
}
