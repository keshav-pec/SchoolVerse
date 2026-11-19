import { useState, type ComponentType } from 'react';
import { Link, useLocation } from 'react-router';
import { AUDIT_ACTION_LABELS, type AuditEventDTO, type SetupItemDTO } from '@shared';
import { ArrowRight, Building2, CalendarDays, Check, ChevronDown, ChevronRight, ChevronUp, CircleDashed, Clock, Crown, DoorOpen, GraduationCap, History, MapPinned, PartyPopper, Sparkles } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
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

/** Every item that can be worked on today. Each row opens the screen that fixes (or shows) it. */
function Checklist({ items }: { items: SetupItemDTO[] }) {
  return (
    <ul className="grid gap-2.5" aria-label="Setup checklist">
      {items.map((item) => {
        const done = item.status === 'completed';
        const Glyph = done ? Check : (ITEM_ICONS[item.key] ?? CircleDashed);
        const tone = done ? 'bg-success-soft text-success' : item.status === 'pending' ? 'bg-warning-soft text-warning' : 'bg-brand-soft text-brand';
        const state = done ? 'Done' : item.status === 'pending' ? 'Needs attention' : 'Not started';
        const body = (
          <>
            <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', tone)}>
              <Glyph className="size-4" aria-hidden="true" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{item.label}</span>
              <span className="block truncate text-[13px] text-muted">{item.description}</span>
            </span>
            <span className="hidden shrink-0 text-xs font-semibold text-muted sm:inline">{state}</span>
            {item.href && <ChevronRight className="size-4 shrink-0 text-muted" aria-hidden="true" />}
          </>
        );
        const row = 'flex items-center gap-3 rounded-xl border border-line px-3.5 py-3';
        return (
          <li key={item.key} data-status={item.status}>
            {item.href ? (
              <Link to={item.href} className={cn(row, 'transition-colors hover:border-brand/40 hover:bg-brand-soft/40 focus-visible:ring-2 focus-visible:ring-brand focus-visible:outline-none')} aria-label={`${item.label}: ${state}`}>
                {body}
              </Link>
            ) : (
              <div className={row}>{body}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function subjectOf(e: AuditEventDTO): string | null {
  const name = e.changes.find((c) => c.field === 'displayName')?.to ?? e.metadata.displayName ?? e.metadata.primaryLocationName ?? e.metadata.newPrimaryName ?? e.metadata.identifierType;
  return typeof name === 'string' ? name : null;
}

const ACTIVITY_PREVIEW = 5;

function ActivityFeed() {
  const q = useRecentActivity(true);
  const [expanded, setExpanded] = useState(false);
  const events = (q.data?.items ?? []).filter((e) => e.entityType !== 'user' && e.entityType !== 'tenant');
  const visible = expanded ? events : events.slice(0, ACTIVITY_PREVIEW);
  const hidden = events.length - ACTIVITY_PREVIEW;
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
          {visible.map((e) => {
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
      {hidden > 0 && (
        <Button variant="ghost" size="sm" className="mt-3 w-full" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? (
            <>
              Show less <ChevronUp />
            </>
          ) : (
            <>
              Show {hidden} more <ChevronDown />
            </>
          )}
        </Button>
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

  // Modules that aren't built yet have nothing to open, and the percentage already ignores them.
  const checklist = data.items.filter((i) => !(i.status === 'upcoming' && !i.href));
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

      <Card className="mt-6">
        <div className="grid items-center gap-6 md:grid-cols-[auto_minmax(0,1fr)] md:gap-10">
          <div className="flex flex-col items-center text-center">
            <h2 className="mb-4 text-lg font-bold">Setup completion</h2>
            <CompletionRing percent={data.completionPercent} />
            <p className="mt-4 max-w-[200px] text-sm text-muted">
              {data.completionPercent === 100 ? 'Everything available is set up.' : `${checklist.filter((i) => i.status === 'completed').length} of ${checklist.length} steps done.`}
            </p>
          </div>
          <div>
            <h2 className="text-lg font-bold">Setup checklist</h2>
            <p className="mb-3 text-sm text-muted">Open any item to review or finish it.</p>
            <Checklist items={checklist} />
          </div>
        </div>
      </Card>

      {(can('audit:view') || (nextStep && nextStep.status !== 'upcoming')) && (
        <div className="mt-6 space-y-6">
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
          {can('audit:view') && <ActivityFeed />}
        </div>
      )}
    </>
  );
}
