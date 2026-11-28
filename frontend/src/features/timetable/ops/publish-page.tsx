import { useMemo, useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { ArrowLeft, CircleCheck, TriangleAlert } from 'lucide-react';
import { RULE_LABELS, type RuleCode, type ValidationClashDTO, type ValidationWarningDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useTimetableMutation } from '../api';
import { useTimetablePlan } from '../context';
import { DAILY_TIPS, PUBLISH_INTRO } from '../help-copy';
import { EditorProvider } from '../schedule/editor';
import { FIXABLE_RULES, FixThisForMe } from '../schedule/dialogs';
import { useVersion, useVersions } from '../schedule/api';
import { ops, useCompare, useValidation } from './api';
import { todayIso } from './views-page';

const addDay = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Where a lesson is in the Schedule, so "Open" lands on it. */
const cellLink = (p: { sectionOfferingId: string | null; teachingGroupId: string | null; entryId: string }) =>
  `/timetable/schedule?${p.teachingGroupId ? `view=group&id=${p.teachingGroupId}` : `view=section&id=${p.sectionOfferingId ?? ''}`}&entry=${p.entryId}`;

function Bar({ placed, needed }: { placed: number; needed: number }) {
  const pct = needed > 0 ? Math.round((placed / needed) * 100) : 0;
  return (
    <div className="h-2 w-full overflow-hidden rounded-pill bg-ink/8" role="img" aria-label={`${placed} of ${needed} placed`}>
      <div className={cn('h-full rounded-pill', pct >= 100 ? 'bg-success' : 'bg-brand')} style={{ width: `${pct}%` }} />
    </div>
  );
}

function ClashRow({ clash }: { clash: ValidationClashDTO }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-danger/30 bg-danger-soft/30 p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{clash.label}</p>
        <p className="text-[13px] text-muted">{clash.issues[0]?.message}</p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to={cellLink(clash)}>Open</Link>
      </Button>
    </li>
  );
}

function WarningRow({ w, onFix }: { w: ValidationWarningDTO; onFix: (w: ValidationWarningDTO) => void }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 text-sm">
        <p className="font-semibold">{w.label}</p>
        <p className="text-[13px] text-muted">{w.message}</p>
      </div>
      <div className="flex gap-2">
        <Button asChild variant="outline" size="sm">
          <Link to={cellLink(w)}>Open</Link>
        </Button>
        {FIXABLE_RULES.includes(w.rule as RuleCode) && (
          <Button size="sm" onClick={() => onFix(w)}>
            Fix This For Me
          </Button>
        )}
      </div>
    </li>
  );
}

/** `/timetable/versions/:id/publish`: one short list ("All 36 sections complete. 0 clashes. 6 warnings."), then the details, then the button. */
export function PublishPage() {
  const { id } = useParams();
  const { plan } = useTimetablePlan();
  if (!id) return <Navigate to="/timetable/versions" replace />;
  return (
    <EditorProvider versionId={id}>
      <Review versionId={id} planId={plan?.planId} />
    </EditorProvider>
  );
}

function Review({ versionId, planId }: { versionId: string; planId: string | undefined }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const versions = useVersions(planId);
  const live = useVersion(versionId);
  const version = live.data ?? versions.data?.find((v) => v.versionId === versionId);
  const open = version?.status === 'DRAFT' || version?.status === 'READY';
  const validation = useValidation(versionId, version?.rev, !!version && open);
  const compare = useCompare(versionId, undefined, !!version?.sourceVersionId);
  const running = versions.data?.find((v) => v.phase === 'ACTIVE');
  const [startsOn, setStartsOn] = useState(todayIso());
  const [tick, setTick] = useState(false);
  const [fix, setFix] = useState<ValidationWarningDTO | null>(null);
  const v = validation.data;

  const ready = useTimetableMutation(() => ops.markReady(versionId), { success: 'Marked ready for review.' });
  const publish = useTimetableMutation(() => ops.publish(versionId, { effectiveFrom: startsOn, acknowledgeWarnings: tick }), { success: (r) => r.message });

  const later = startsOn > todayIso();
  const reasons = useMemo(() => {
    if (!v) return [];
    const out: string[] = [];
    if (v.entryCount === 0) out.push('Nothing is placed yet.');
    if (v.clashCount > 0) out.push(`${v.clashCount} ${v.clashCount === 1 ? 'clash' : 'clashes'} must be fixed first.`);
    return out;
  }, [v]);

  if (!version && (versions.isLoading || live.isLoading)) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />;
  if (!version) return <ErrorState error={live.error ?? versions.error} onRetry={() => void live.refetch()} />;
  const blockedByTick = !!v?.needsAcknowledge && !tick;

  return (
    <>
      <PageHeader
        eyebrow="Timetable"
        title="Review And Publish"
        description={`${version.versionName}. Check everything, then publish.`}
        actions={
          <Button asChild variant="outline">
            <Link to="/timetable/versions">
              <ArrowLeft /> Versions
            </Link>
          </Button>
        }
      />
      <div className="space-y-4">
        <TabIntro title="How this works">{PUBLISH_INTRO}</TabIntro>
        {!open && (
          <Alert tone="info" title="This timetable is not a draft any more">
            It was {version.phase === 'DISCARDED' ? 'discarded' : 'published'}, so there is nothing to publish.{' '}
            <Link to="/timetable/versions" className="font-semibold text-brand underline">
              Go To Versions
            </Link>
          </Alert>
        )}
        {open && validation.isLoading && <Skeleton className="h-40 rounded-card" role="status" aria-label="Checking the timetable" />}
        {open && validation.isError && <ErrorState error={validation.error} onRetry={() => void validation.refetch()} />}
        {open && v && (
          <>
            <Card className={cn('space-y-3 p-4 sm:p-5', v.canPublish ? 'border-success/40 bg-success-soft/30' : 'border-danger/40 bg-danger-soft/30')}>
              <h2 className="flex items-center gap-2 text-xl font-extrabold" aria-live="polite" data-testid="validation-summary">
                {v.canPublish ? <CircleCheck className="size-6 text-success" aria-hidden="true" /> : <TriangleAlert className="size-6 text-danger" aria-hidden="true" />}
                {v.summary}
              </h2>
              {v.unplacedCount > 0 && <p className="text-sm text-muted">{v.unplacedCount} periods are not placed yet.</p>}
              <div className="grid gap-3 sm:grid-cols-[14rem_1fr] sm:items-end">
                <TextField label="Starts on" type="date" min={todayIso()} value={startsOn} onChange={(e) => e.target.value && setStartsOn(e.target.value)} labelAside={<InfoTip label="About the start day">{DAILY_TIPS.startsOn}</InfoTip>} />
                <p className="text-sm text-muted" data-testid="starts-note">
                  {later && running ? `The current timetable runs until ${formatDateOnly(addDay(startsOn, -1))}.` : later ? `It starts on ${formatDateOnly(startsOn)}.` : 'It is used from today.'}
                </p>
              </div>
              {v.needsAcknowledge && (
                <label className="flex items-start gap-2 text-sm">
                  <input type="checkbox" className="mt-0.5 size-4 accent-brand" checked={tick} onChange={(e) => setTick(e.target.checked)} />
                  <span>
                    I know {v.unplacedCount} periods are not placed{v.warningCount > 0 ? ` and there are ${v.warningCount} warnings` : ''}, and I want to publish.
                  </span>
                </label>
              )}
              {reasons.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5 text-sm text-danger" aria-label="Why it cannot be published">
                  {reasons.map((r) => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
              )}
              <div className="flex flex-wrap gap-2">
                {can('timetable:review') && version.status === 'DRAFT' && (
                  <Button variant="outline" disabled={!v.canPublish} loading={ready.isPending} loadingText="Checking…" onClick={() => ready.mutate(undefined)}>
                    Mark Ready For Review
                  </Button>
                )}
                {can('timetable:publish') && (
                  <Button disabled={!v.canPublish || blockedByTick} loading={publish.isPending} loadingText="Publishing…" onClick={() => publish.mutate(undefined, { onSuccess: () => navigate('/timetable/versions') })}>
                    Publish
                  </Button>
                )}
                {version.status === 'READY' && <Badge tone="brand">Ready for review</Badge>}
              </div>
            </Card>

            {v.clashCount > 0 && (
              <Card className="space-y-2 p-4 sm:p-5" aria-label="Clashes">
                <h2 className="text-lg font-bold">Clashes to fix ({v.clashCount})</h2>
                <ul className="space-y-2">{v.clashes.map((c) => <ClashRow key={c.entryId} clash={c} />)}</ul>
              </Card>
            )}

            <Card className="space-y-3 p-4 sm:p-5" aria-label="Sections">
              <h2 className="text-lg font-bold">Sections</h2>
              <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {v.sections.map((s) => (
                  <li key={s.sectionOfferingId} className="space-y-1 rounded-xl border border-line p-3">
                    <p className="flex items-center justify-between text-sm font-semibold">
                      {s.label}
                      <span className={cn('text-[13px]', s.left === 0 && !s.empty ? 'text-success' : 'text-muted')}>{s.empty ? 'Nothing placed' : `${s.placed} of ${s.needed}`}</span>
                    </p>
                    <Bar placed={s.placed} needed={s.needed} />
                  </li>
                ))}
              </ul>
            </Card>

            <Card className="space-y-3 p-4 sm:p-5" aria-label="Warnings">
              <h2 className="text-lg font-bold">Warnings ({v.warningCount})</h2>
              {v.warnings.length === 0 && <p className="text-sm text-muted">No warnings.</p>}
              {v.warnings.map((g) => (
                <details key={g.rule} className="rounded-xl border border-line">
                  <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">
                    {RULE_LABELS[g.rule]} <Badge tone="warning">{g.count}</Badge>
                  </summary>
                  <ul className="space-y-2 p-3 pt-1">{g.items.map((w) => <WarningRow key={`${w.entryId}-${w.message}`} w={w} onFix={setFix} />)}</ul>
                </details>
              ))}
            </Card>

            {version.sourceVersionId && (
              <Card className="space-y-2 p-4 sm:p-5" aria-label="What changed">
                <h2 className="text-lg font-bold">What Changed</h2>
                {compare.isLoading && <Skeleton className="h-16" role="status" aria-label="Comparing" />}
                {compare.data && (
                  <>
                    <p className="text-sm font-semibold">{compare.data.summary}</p>
                    <ul className="space-y-1">
                      {compare.data.changes.map((c, i) => (
                        <li key={`${c.entryId ?? 'x'}-${i}`} className="text-sm">
                          <Badge tone={c.kind === 'ADDED' ? 'success' : c.kind === 'REMOVED' ? 'danger' : 'brand'}>{c.kind === 'ADDED' ? 'Added' : c.kind === 'REMOVED' ? 'Removed' : c.kind === 'MOVED' ? 'Moved' : 'Changed'}</Badge> <b>{c.label}</b> {c.was && c.now ? `${c.was} → ${c.now}` : (c.was ?? c.now)}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </Card>
            )}
          </>
        )}
      </div>
      {fix && <FixThisForMe entryId={fix.entryId} rule={fix.rule} open onClose={() => setFix(null)} />}
    </>
  );
}
