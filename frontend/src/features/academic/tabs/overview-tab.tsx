import { ArrowRight, Check, CircleAlert, CircleDashed, Info, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { AcademicSessionDTO, ValidationIssueDTO, ValidationResultDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { sessionCall, useAcademicMutation, useOverview } from '../api';
import { LifecycleButtons } from '../lifecycle-buttons';
import { HelpHeading } from '../help';
import { TAB_FOR_ENTITY, TAB_LABELS } from '../tab-links';

const GROUPS = [
  { level: 'ERROR', title: 'Errors', hint: 'These block publishing.', tone: 'danger', Icon: CircleAlert },
  { level: 'WARNING', title: 'Warnings', hint: 'Worth a look, but they never block publishing.', tone: 'warning', Icon: TriangleAlert },
  { level: 'INFO', title: 'Suggestions', hint: 'Optional setup ideas.', tone: 'info', Icon: Info },
] as const;

/** Validation results grouped as Error / Warning / Info, each linked to the tab where it can be fixed. */
export function ValidationPanel({ result, onGoTo }: { result: ValidationResultDTO; onGoTo: (tab: string) => void }) {
  if (result.issues.length === 0) {
    return (
      <Alert tone="success" title="Everything checks out">
        No errors, warnings or suggestions. This session is ready to publish.
      </Alert>
    );
  }
  return (
    <div className="space-y-5" aria-label="Validation results">
      {GROUPS.map(({ level, title, hint, tone, Icon }) => {
        const issues: ValidationIssueDTO[] = result.issues.filter((i) => i.level === level);
        if (issues.length === 0) return null;
        return (
          <section key={level} aria-label={title}>
            <h3 className="mb-2 flex items-center gap-2 text-sm font-bold">
              <Icon className={cn('size-4', tone === 'danger' ? 'text-danger' : tone === 'warning' ? 'text-warning' : 'text-brand')} aria-hidden="true" />
              {title} ({issues.length}) <span className="font-normal text-muted">· {hint}</span>
            </h3>
            <ul className="space-y-2">
              {issues.map((issue, i) => {
                const tab = TAB_FOR_ENTITY[issue.entityType];
                return (
                  <li key={`${issue.code}-${issue.entityId}-${i}`} className="flex flex-wrap items-center gap-3 rounded-xl border border-line bg-white px-4 py-2.5 text-sm">
                    <span className="min-w-0 flex-1">{issue.message}</span>
                    {tab && tab !== 'overview' && (
                      <Button variant="ghost" size="sm" onClick={() => onGoTo(tab)}>
                        Go To {TAB_LABELS[tab]} <ArrowRight />
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

export function OverviewTab({
  session,
  readOnly,
  validation,
  onValidated,
  onGoTo,
}: {
  session: AcademicSessionDTO;
  readOnly: boolean;
  validation: ValidationResultDTO | null;
  onValidated: (result: ValidationResultDTO) => void;
  onGoTo: (tab: string) => void;
}) {
  const { can } = useAuth();
  const overview = useOverview(session.academicSessionId, can('academic:view_config'));
  const validate = useAcademicMutation((_: void) => sessionCall.validate(session.academicSessionId), { success: (r) => (r.canPublish ? 'Validation passed.' : `Validation found ${r.summary.errors} error${r.summary.errors === 1 ? '' : 's'}.`) });
  const errors = validation?.summary.errors ?? session.lastValidation?.errors ?? 0;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <HelpHeading
              title="Setup checklist"
              helpLabel="How to use the checklist"
              help={
                <>
                  <p>Work through the tabs above from left to right. This list shows what’s done.</p>
                  <ul>
                    <li><b>Green tick</b>: done.</li>
                    <li><b>Orange circle</b>: still to do before you can publish.</li>
                    <li><b>Grey circle</b>: optional. Skip it if your school doesn’t need it.</li>
                  </ul>
                  <p>Required: Classes &amp; Sections and Subjects. Optional: Subject Choice Rules, Programmes and Terms.</p>
                </>
              }
            />
            <CardDescription>Everything a session needs before it can be published.</CardDescription>
          </div>
        </CardHeader>
        {overview.isLoading ? (
          <Skeleton className="h-32" role="status" aria-label="Loading checklist" />
        ) : overview.isError ? (
          <ErrorState error={overview.error} onRetry={() => void overview.refetch()} retrying={overview.isFetching} />
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2">
            {overview.data?.checklist.map((item) => (
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
        )}
        <ul className="mt-4 flex flex-wrap gap-2 text-sm" aria-label="Locations and boards">
          {session.locations.map((l) => (
            <li key={l.locationId} className="rounded-pill bg-brand-soft px-3 py-1 font-medium text-brand">
              {l.locationName} · {l.boardCode} {l.ruleVersionName}
              {l.affiliationNumber ? ` · ${l.affiliationNumber}` : ''}
            </li>
          ))}
        </ul>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <HelpHeading
              title="Validation"
              helpLabel="What is validation?"
              help={
                <>
                  <p>Validation checks the whole setup for mistakes before you publish, such as a class with no sections.</p>
                  <ul>
                    <li><b>Errors</b> must be fixed before publishing.</li>
                    <li><b>Warnings</b> and <b>suggestions</b> are advice only.</li>
                  </ul>
                  <p>Each item has a button that takes you to the tab where you fix it.</p>
                </>
              }
            />
            <CardDescription>
              {session.lastValidation ? `Last run ${new Date(session.lastValidation.at).toLocaleString('en-IN')}: ${session.lastValidation.errors} error(s), ${session.lastValidation.warnings} warning(s).` : 'Not validated yet.'}
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-start gap-2">
            {!readOnly && can('academic:publish') && (
              <Button variant="outline" onClick={() => validate.mutate(undefined, { onSuccess: onValidated })} loading={validate.isPending} loadingText="Validating…">
                <ShieldCheck /> Validate
              </Button>
            )}
            {!readOnly && can('academic:publish') && <LifecycleButtons session={session} validationErrors={errors} only="publish" />}
          </div>
        </CardHeader>
        {validate.isError && <Alert tone="danger" className="mb-4">{messageFor(validate.error)}</Alert>}
        {validation ? <ValidationPanel result={validation} onGoTo={onGoTo} /> : <p className="text-sm text-muted">Run validation to see errors, warnings and suggestions.</p>}
      </Card>
    </div>
  );
}
