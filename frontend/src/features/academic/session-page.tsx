import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { ArrowLeft, History, Info, Layers, ListChecks, Lock, Network } from 'lucide-react';
import { BookOpen, CalendarRange, GraduationCap } from 'lucide-react';
import type { SessionStatus, ValidationResultDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Skeleton } from '@/components/ui/skeleton';
import { ComboboxField } from '@/components/ui/field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { useSession, useSessions } from './api';
import { LifecycleButtons } from './lifecycle-buttons';
import { SessionPill } from './session-pill';
import { GradesTab } from './tabs/grades-tab';
import { HistoryTab } from './tabs/history-tab';
import { OverviewTab } from './tabs/overview-tab';
import { ProgrammesTab } from './tabs/programmes-tab';
import { RulesTab } from './tabs/rules-tab';
import { SubjectsTab } from './tabs/subjects-tab';
import { TermsTab } from './tabs/terms-tab';

export interface TabProps {
  sessionId: string;
  status: SessionStatus;
  locationId: string;
  readOnly: boolean;
}

/** Session setup: a checklist page with one tab per area, a location switcher and the lifecycle buttons. */
export function SessionPage() {
  const { sessionId } = useParams();
  const { can } = useAuth();
  const q = useSession(sessionId);
  const sessions = useSessions();
  const [tab, setTab] = useState('overview');
  const [chosenLocation, setChosenLocation] = useState<string>('');
  const [validation, setValidation] = useState<ValidationResultDTO | null>(null);

  if (q.isLoading) {
    return (
      <div role="status" aria-label="Loading session" className="space-y-4">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-96 rounded-card" />
      </div>
    );
  }
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;

  const session = q.data;
  const locationId = chosenLocation || session.locations[0]?.locationId || '';
  const closed = session.status === 'CLOSED' || session.status === 'ARCHIVED';
  const readOnly = closed || !can('academic:manage');
  const errors = validation?.summary.errors ?? session.lastValidation?.errors ?? 0;
  const nextPlan = (sessions.data ?? []).find((s) => s.previousSessionId === session.academicSessionId);
  const tabProps: TabProps = { sessionId: session.academicSessionId, status: session.status, locationId, readOnly };

  return (
    <>
      <Link to="/academics" className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand">
        <ArrowLeft className="size-4" /> Academic Setup
      </Link>
      <PageHeader
        eyebrow={`${session.code} · ${formatDateOnly(session.startDate)} to ${formatDateOnly(session.endDate)}`}
        title={
          <span className="flex flex-wrap items-center gap-3">
            {session.name} <SessionPill status={session.status} />
          </span>
        }
        actions={<LifecycleButtons session={session} validationErrors={errors} />}
      />

      <div className="mb-6 space-y-3">
        {closed && (
          <Alert tone="warning" title={`This session is ${session.status.toLowerCase()}`}>
            <span className="inline-flex items-center gap-1.5">
              <Lock className="size-4" aria-hidden="true" /> It is read-only. Everything stays viewable, but nothing can be changed.
            </span>
          </Alert>
        )}
        {session.status === 'ACTIVE' && (
          <Alert tone="info" title="This session is active">
            Removing or deactivating structure is restricted while other records depend on it. Make that change in the next session’s plan.{' '}
            {nextPlan ? (
              <Link to={`/academics/sessions/${nextPlan.academicSessionId}`} className="font-semibold text-brand underline">
                Open the next plan
              </Link>
            ) : (
              'Use Clone to start one.'
            )}
          </Alert>
        )}
        {session.warnings.map((w) => (
          <Alert key={w.academicSessionId} tone="warning">
            {w.message}
          </Alert>
        ))}
      </div>

      {session.locations.length > 1 && (
        <div className="mb-4 max-w-xs">
          <ComboboxField
            label="Location"
            value={locationId}
            onChange={setChosenLocation}
            hint="Grades and subjects differ per location."
            options={session.locations.map((l) => ({ value: l.locationId, label: l.locationName ?? '', hint: l.boardCode ?? undefined }))}
            searchPlaceholder="Search locations…"
          />
        </div>
      )}

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Session setup">
          <TabsTrigger value="overview"><ListChecks /> Overview</TabsTrigger>
          <TabsTrigger value="grades"><GraduationCap /> Grades &amp; Sections</TabsTrigger>
          <TabsTrigger value="subjects"><BookOpen /> Subjects</TabsTrigger>
          <TabsTrigger value="rules"><Network /> Choice Rules</TabsTrigger>
          <TabsTrigger value="programmes"><Layers /> Programmes</TabsTrigger>
          <TabsTrigger value="terms"><CalendarRange /> Terms</TabsTrigger>
          {can('audit:view') && (
            <TabsTrigger value="history"><History /> History</TabsTrigger>
          )}
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab session={session} readOnly={readOnly} validation={validation} onValidated={setValidation} onGoTo={setTab} />
        </TabsContent>
        <TabsContent value="grades">{locationId ? <GradesTab {...tabProps} /> : <NoLocation />}</TabsContent>
        <TabsContent value="subjects">{locationId ? <SubjectsTab {...tabProps} /> : <NoLocation />}</TabsContent>
        <TabsContent value="rules">{locationId ? <RulesTab {...tabProps} /> : <NoLocation />}</TabsContent>
        <TabsContent value="programmes">{locationId ? <ProgrammesTab {...tabProps} /> : <NoLocation />}</TabsContent>
        <TabsContent value="terms"><TermsTab session={session} readOnly={readOnly} /></TabsContent>
        {can('audit:view') && (
          <TabsContent value="history"><HistoryTab sessionId={session.academicSessionId} /></TabsContent>
        )}
      </Tabs>
    </>
  );
}

function NoLocation() {
  return (
    <Alert tone="info">
      <span className="inline-flex items-center gap-1.5">
        <Info className="size-4" aria-hidden="true" /> This session has no locations yet.
      </span>
    </Alert>
  );
}
