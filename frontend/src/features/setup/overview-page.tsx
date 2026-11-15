import type { ComponentType } from 'react';
import { Link, useLocation } from 'react-router';
import { AUDIT_ACTION_LABELS, type AuditEventDTO, type SetupItemDTO } from '@shared';
import { ArrowRight, Building2, CalendarDays, Check, CircleDashed, Clock, Crown, DoorOpen, GraduationCap, History, MapPinned, PartyPopper, Sparkles } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCurrentSchool } from '../school-profile/api';
import { useRecentActivity, useSetupStatus } from './api';
import { CompletionRing } from './completion-ring';

const ITEM_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  academic_structure: GraduationCap,
  buildings_rooms: DoorOpen,
  academic_calendar: CalendarDays,
};

function Stat({ icon: Icon, label, children, hint, tone }: { icon: ComponentType<{ className?: string }>; label: string; children: React.ReactNode; hint?: React.ReactNode; tone: string }) {
  return (
    <Card className="flex items-start gap-4">
      <span className={cn('grid size-11 shrink-0 place-items-center rounded-xl', tone)}>
        <Icon className="size-5" />
      </span>
      <div className="min-w-0">
        <p className="text-sm text-muted">{label}</p>
        <p className="text-xl leading-tight font-extrabold break-words text-ink">{children}</p>
        {hint && <p className="mt-0.5 truncate text-[13px] text-muted">{hint}</p>}
      </div>
    </Card>
  );
}

function ChecklistGroup({ title, tone, icon: Icon, items }: { title: string; tone: string; icon: ComponentType<{ className?: string }>; items: SetupItemDTO[] }) {
  if (items.length === 0) return null;
  return (
    <section aria-label={title}>
      <h3 className="mb-2 flex items-center gap-2 text-[11px] font-bold tracking-[0.12em] text-muted uppercase">
        <Icon className="size-3.5" aria-hidden="true" /> {title} <span className="rounded-pill bg-ink/6 px-1.5 py-0.5 text-[10px]">{items.length}</span>
      </h3>
      <ul className="space-y-2">
        {items.map((item) => {
          const Glyph = item.status === 'completed' ? Check : (ITEM_ICONS[item.key] ?? CircleDashed);
          return (
            <li key={item.key} className="flex items-center gap-3 rounded-xl border border-line px-3.5 py-3">
              <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', tone)}>
                <Glyph className="size-4" aria-hidden="true" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{item.label}</p>
                <p className="truncate text-[13px] text-muted">{item.description}</p>
              </div>
              {item.status === 'pending' && item.href && (
                <Button asChild variant="outline" size="sm">
                  <Link to={item.href}>Fix</Link>
                </Button>
              )}
              {item.status === 'completed' && <Badge tone="success">Done</Badge>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function subjectOf(e: AuditEventDTO): string | null {
  const name = e.changes.find((c) => c.field === 'displayName')?.to ?? e.metadata.displayName ?? e.metadata.primaryLocationName ?? e.metadata.newPrimaryName ?? e.metadata.identifierType;
  return typeof name === 'string' ? name : null;
}

function ActivityFeed() {
  const q = useRecentActivity(true);
  const events = (q.data?.items ?? []).filter((e) => e.entityType !== 'user' && e.entityType !== 'tenant');
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Recent activity</CardTitle>
          <CardDescription>The latest changes to your school setup.</CardDescription>
        </div>
        <History className="size-5 text-muted" aria-hidden="true" />
      </CardHeader>
      {q.isLoading && (
        <div className="space-y-3" role="status" aria-label="Loading activity">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      )}
      {q.isError && <p className="text-sm text-muted">Activity couldn’t be loaded right now.</p>}
      {q.isSuccess && events.length === 0 && <p className="text-sm text-muted">Nothing yet. Changes will show up here.</p>}
      {events.length > 0 && (
        <ul className="space-y-3.5" aria-label="Recent activity">
          {events.map((e) => {
            const subject = subjectOf(e);
            return (
              <li key={e.auditEventId} className="flex items-start gap-3">
                <span className="mt-1.5 size-2 shrink-0 rounded-full bg-brand" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold">
                    {AUDIT_ACTION_LABELS[e.action] ?? e.action}
                    {subject && <span className="font-normal text-muted"> · {subject}</span>}
                  </p>
                  <p className="flex items-center gap-1 text-[13px] text-muted">
                    <Clock className="size-3" aria-hidden="true" /> {e.actor.name ?? 'SchoolVerse'} · {formatRelative(e.occurredAt)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Settings → School Setup → Overview. A configuration dashboard, not an analytics dashboard (PRD §14). */
export function OverviewPage() {
  const { can } = useAuth();
  const location = useLocation();
  const school = useCurrentSchool();
  const status = useSetupStatus(school.data?.schoolId);
  const justCompleted = (location.state as { justCompleted?: boolean } | null)?.justCompleted;

  if (school.isLoading || (school.data && status.isLoading)) {
    return (
      <>
        <PageHeader eyebrow="School Setup" title="Overview" />
        <div role="status" aria-label="Loading overview" className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3">
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-24 rounded-card" />
            <Skeleton className="h-24 rounded-card" />
          </div>
          <Skeleton className="h-72 rounded-card" />
        </div>
      </>
    );
  }
  if (school.isError) return <ErrorState error={school.error} onRetry={() => void school.refetch()} retrying={school.isFetching} />;
  if (status.isError) return <ErrorState error={status.error} onRetry={() => void status.refetch()} retrying={status.isFetching} />;
  const data = status.data;
  if (!data) return <ErrorState error={null} />;

  const completed = data.items.filter((i) => i.status === 'completed');
  const pending = data.items.filter((i) => i.status === 'pending');
  const { summary, nextStep } = data;
  const NextIcon = nextStep ? (ITEM_ICONS[nextStep.key] ?? Sparkles) : Sparkles;

  return (
    <>
      <PageHeader eyebrow="School Setup" title="Overview" description="Where your school’s configuration stands, and what to set up next." />

      {justCompleted && (
        <Alert tone="success" className="mb-6" title="School setup is complete 🎉">
          <span className="inline-flex items-center gap-1.5">
            <PartyPopper className="size-4" aria-hidden="true" /> Your school, Primary Location and campuses are ready for the rest of SchoolVerse.
          </span>
        </Alert>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Stat icon={Building2} label="School name" tone="bg-brand-soft text-brand">
          {summary.schoolName}
        </Stat>
        <Stat icon={Crown} label="Primary Location" tone="bg-sun-soft text-[#7a5300]" hint={summary.primaryLocation?.locationCode}>
          {summary.primaryLocation ? (
            <Link to={`/school-setup/locations/${summary.primaryLocation.locationId}`} className="hover:text-brand hover:underline">
              {summary.primaryLocation.displayName}
            </Link>
          ) : (
            'Not set'
          )}
        </Stat>
        <Stat icon={MapPinned} label="Active Locations" tone="bg-mint-soft text-success" hint={summary.draftLocations > 0 ? `${summary.draftLocations} draft${summary.draftLocations === 1 ? '' : 's'} not live yet` : `${summary.totalLocations} in total`}>
          {summary.activeLocations}
        </Stat>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Setup checklist</CardTitle>
                <CardDescription>What’s done and what needs attention.</CardDescription>
              </div>
            </CardHeader>
            <div className="space-y-6">
              <ChecklistGroup title="Completed" tone="bg-success-soft text-success" icon={Check} items={completed} />
              <ChecklistGroup title="Pending" tone="bg-warning-soft text-warning" icon={CircleDashed} items={pending} />
            </div>
          </Card>
          {can('audit:view') && <ActivityFeed />}
        </div>

        <div className="space-y-6">
          <Card className="flex flex-col items-center text-center">
            <h2 className="mb-4 text-lg font-bold">Setup completion</h2>
            <CompletionRing percent={data.completionPercent} />
            <p className="mt-4 text-sm text-muted">
              School Setup itself is <strong className="text-ink">{data.coreCompletionPercent}%</strong> done. The rest unlocks as the next modules arrive.
            </p>
          </Card>

          {nextStep && nextStep.status !== 'upcoming' && (
            <Card className="border-brand/25 bg-brand-soft">
              <p className="text-[11px] font-bold tracking-[0.14em] text-brand uppercase">Next up</p>
              <div className="mt-2 flex items-start gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-white text-brand">
                  <NextIcon className="size-5" />
                </span>
                <div>
                  <h2 className="text-lg font-bold">{nextStep.label}</h2>
                  <p className="mt-0.5 text-sm text-muted">{nextStep.description}</p>
                </div>
              </div>
              {nextStep.href && (
                <Button asChild className="mt-4 w-full">
                  <Link to={nextStep.href}>
                    Take me there <ArrowRight />
                  </Link>
                </Button>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
