import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, BookOpen, CalendarRange, Check, CircleDashed, GraduationCap, Layers, Library, MapPinned, Plus, Users } from 'lucide-react';
import type { AcademicOverviewDTO, AcademicSessionDTO } from '@shared';
import { LostPlanet } from '@/components/illustrations/lost-planet';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useOverview, useSessions } from './api';
import { CreateSessionDrawer } from './create-session-drawer';
import { SessionPill } from './session-pill';

function Stat({ icon: Icon, label, value, hint }: { icon: typeof Users; label: string; value: React.ReactNode; hint?: string }) {
  return (
    <Card className="flex items-start gap-3 p-4 sm:p-4">
      <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-brand-soft text-brand">
        <Icon className="size-5" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-muted">{label}</p>
        <p className="text-xl leading-tight font-extrabold">{value}</p>
        {hint && <p className="truncate text-xs text-muted">{hint}</p>}
      </div>
    </Card>
  );
}

function Checklist({ overview }: { overview: AcademicOverviewDTO }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Configuration checklist</CardTitle>
          <CardDescription>What’s ready and what still needs attention.</CardDescription>
        </div>
      </CardHeader>
      <ul className="grid gap-2 sm:grid-cols-2">
        {overview.checklist.map((item) => (
          <li key={item.key} className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-2.5">
            <span className={cn('grid size-7 shrink-0 place-items-center rounded-full', item.status === 'completed' ? 'bg-success-soft text-success' : item.status === 'pending' ? 'bg-warning-soft text-warning' : 'bg-ink/6 text-muted')}>
              {item.status === 'completed' ? <Check className="size-4" aria-label="Done" /> : <CircleDashed className="size-4" aria-label={item.status === 'optional' ? 'Optional' : 'To do'} />}
            </span>
            <div className="min-w-0">
              <p className="text-sm font-semibold">{item.label}</p>
              <p className="truncate text-[13px] text-muted">{item.detail}</p>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SessionsList({ sessions }: { sessions: AcademicSessionDTO[] }) {
  return (
    <Card className="p-0 sm:p-0">
      <div className="border-b border-line px-5 py-4 sm:px-6">
        <CardTitle>Academic sessions</CardTitle>
      </div>
      <ul className="divide-y divide-line">
        {sessions.map((s) => (
          <li key={s.academicSessionId}>
            <Link to={`/academics/sessions/${s.academicSessionId}`} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-4 outline-none hover:bg-canvas focus-visible:bg-brand-soft sm:px-6">
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{s.name}</p>
                <p className="text-[13px] text-muted">
                  {s.code} · {formatDateOnly(s.startDate)} to {formatDateOnly(s.endDate)} · {s.locations.length} location{s.locations.length === 1 ? '' : 's'}
                </p>
              </div>
              <SessionPill status={s.status} />
              <ArrowRight className="size-4 text-muted" aria-hidden="true" />
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Academics → Academic Setup. Admin dashboard: the current session, boards, counts and checklist. */
export function AcademicsPage() {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const sessions = useSessions();
  const list = sessions.data ?? [];
  // The ACTIVE session, else the newest draft / published plan.
  const focus = list.find((s) => s.status === 'ACTIVE') ?? list.find((s) => s.status === 'PUBLISHED') ?? list.find((s) => s.status === 'DRAFT') ?? list[0];
  const overview = useOverview(focus?.academicSessionId);

  const header = (
    <PageHeader
      eyebrow="Academics"
      title="Academic Setup"
      description="Plan the year once: sessions, grades, sections, subjects and the rules students choose within."
      actions={
        <>
          <Button asChild variant="outline">
            <Link to="/academics/subjects">
              <Library /> Subject master
            </Link>
          </Button>
          <Can permission="academic:manage">
            <Button onClick={() => setCreating(true)}>
              <Plus /> Create Academic Session
            </Button>
          </Can>
        </>
      }
    />
  );

  if (sessions.isLoading) {
    return (
      <>
        {header}
        <div role="status" aria-label="Loading academic setup" className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-20 rounded-card" />
            ))}
          </div>
          <Skeleton className="h-64 rounded-card" />
        </div>
      </>
    );
  }
  if (sessions.isError) return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} retrying={sessions.isFetching} />;

  const drawer = <CreateSessionDrawer open={creating} onOpenChange={setCreating} sessions={list} onCreated={(id) => navigate(`/academics/sessions/${id}`)} />;

  if (list.length === 0) {
    return (
      <>
        {header}
        <Card>
          <EmptyState
            illustration={<LostPlanet className="w-48" />}
            title="No academic session yet. Let’s plan your first year"
            description="A session holds your grades, sections and subjects for one year. Start blank, or copy a previous one later."
            action={
              <Can permission="academic:manage">
                <Button onClick={() => setCreating(true)}>
                  <Plus /> Create Academic Session
                </Button>
              </Can>
            }
          />
        </Card>
        {drawer}
      </>
    );
  }

  const counts = overview.data?.counts;
  return (
    <>
      {header}
      {focus && (
        <div className="space-y-6">
          <Card className="flex flex-wrap items-center gap-4">
            <span className="grid size-12 place-items-center rounded-xl bg-brand-soft text-brand">
              <CalendarRange className="size-6" aria-hidden="true" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-bold tracking-[0.14em] text-brand uppercase">{focus.status === 'ACTIVE' ? 'Current session' : 'Latest plan'}</p>
              <h2 className="text-xl font-extrabold">{focus.name}</h2>
              <p className="text-sm text-muted">
                {formatDateOnly(focus.startDate)} to {formatDateOnly(focus.endDate)}
              </p>
            </div>
            <SessionPill status={focus.status} />
            <Button asChild>
              <Link to={`/academics/sessions/${focus.academicSessionId}`}>
                Open setup <ArrowRight />
              </Link>
            </Button>
          </Card>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat icon={GraduationCap} label="Grades" value={counts?.grades ?? '…'} hint={counts ? `${counts.sections} sections` : undefined} />
            <Stat icon={BookOpen} label="Subjects offered" value={counts?.subjects ?? '…'} />
            <Stat icon={Layers} label="Programmes" value={counts?.programmes ?? '…'} hint={counts ? `${counts.choiceGroups} choice group${counts.choiceGroups === 1 ? '' : 's'}` : undefined} />
            <Stat icon={MapPinned} label="Board per location" value={overview.data ? overview.data.boards.length : '…'} hint={overview.data?.boards.map((b) => `${b.locationCode ?? ''}: ${b.boardCode ?? ''}`).join(' · ')} />
          </div>

          {overview.isError ? <ErrorState error={overview.error} onRetry={() => void overview.refetch()} retrying={overview.isFetching} /> : overview.data ? <Checklist overview={overview.data} /> : <Skeleton className="h-48 rounded-card" />}
        </div>
      )}
      <div className="mt-6">
        <SessionsList sessions={list} />
      </div>
      {drawer}
    </>
  );
}
