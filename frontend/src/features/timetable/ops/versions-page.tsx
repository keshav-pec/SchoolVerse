import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { ArrowRight, GitCompareArrows, Plus } from 'lucide-react';
import { VERSION_PHASE_LABELS, type TimetableVersionDTO, type VersionPhase } from '@shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { formatDateOnly } from '@/lib/format';
import { useVersions } from '../schedule/api';
import { useTimetableMutation } from '../api';
import { CreatePlanCard, useTimetablePlan } from '../context';
import { DAILY_TIPS, VERSIONS_INTRO } from '../help-copy';
import { ops, useCompare } from './api';

export const PHASE_TONE: Record<VersionPhase, 'neutral' | 'brand' | 'success' | 'warning' | 'danger'> = { DRAFT: 'warning', READY: 'brand', UPCOMING: 'brand', ACTIVE: 'success', SUPERSEDED: 'neutral', DISCARDED: 'neutral' };
export const phaseLabel = (v: Pick<TimetableVersionDTO, 'phase'>) => (v.phase === 'ACTIVE' ? 'Published' : v.phase === 'UPCOMING' ? 'Upcoming' : v.phase === 'READY' ? 'Ready' : VERSION_PHASE_LABELS[v.phase]);
const isOpen = (v: TimetableVersionDTO) => v.phase === 'DRAFT' || v.phase === 'READY';
const isPublished = (v: TimetableVersionDTO) => v.phase === 'ACTIVE' || v.phase === 'UPCOMING' || v.phase === 'SUPERSEDED';

function Compare({ version, previous }: { version: TimetableVersionDTO; previous: TimetableVersionDTO | undefined }) {
  const diff = useCompare(version.versionId, previous?.versionId);
  if (diff.isLoading) return <Skeleton className="mt-3 h-16" role="status" aria-label="Comparing" />;
  if (diff.isError) return <ErrorState error={diff.error} onRetry={() => void diff.refetch()} />;
  if (!diff.data) return null;
  return (
    <div className="mt-3 rounded-xl border border-line bg-canvas/60 p-3 text-sm" aria-label="Changes">
      <p className="font-semibold">{diff.data.summary}</p>
      {diff.data.toVersionName && <p className="text-[13px] text-muted">Compared with {diff.data.toVersionName}.</p>}
      <ul className="mt-2 space-y-1">
        {diff.data.changes.slice(0, 40).map((c, i) => (
          <li key={`${c.entryId ?? 'x'}-${i}`} className="text-[13px]">
            <Badge tone={c.kind === 'ADDED' ? 'success' : c.kind === 'REMOVED' ? 'danger' : 'brand'}>{c.kind === 'ADDED' ? 'Added' : c.kind === 'REMOVED' ? 'Removed' : c.kind === 'MOVED' ? 'Moved' : 'Changed'}</Badge> <b>{c.label}</b> {c.was && c.now ? `${c.was} → ${c.now}` : (c.was ?? c.now)}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Row({ version, previous, openDraft }: { version: TimetableVersionDTO; previous: TimetableVersionDTO | undefined; openDraft: TimetableVersionDTO | undefined }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [compare, setCompare] = useState(false);
  const [discard, setDiscard] = useState(false);
  const revise = useTimetableMutation(() => ops.clone(version.versionId), { success: 'Revision made. Change it, then publish it.' });
  const discardIt = useTimetableMutation(() => ops.discard(version.versionId), { success: 'Draft discarded.' });
  const canDraft = can('timetable:draft:create');
  return (
    <Card className="p-4 sm:p-5" aria-label={version.versionName}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-base font-bold">
            {version.versionName}
            <Badge tone={PHASE_TONE[version.phase]}>{phaseLabel(version)}</Badge>
          </p>
          <p className="text-sm text-muted">
            {version.effectiveFrom ? `From ${formatDateOnly(version.effectiveFrom)}${version.effectiveTo ? ` to ${formatDateOnly(version.effectiveTo)}` : ''}` : 'Not published'} · {version.entryCount} lessons
            {version.publishedByName ? ` · published by ${version.publishedByName}` : ''}
          </p>
          {isPublished(version) && (version.publishedUnplacedCount > 0 || version.publishedWarningCount > 0) && (
            <p className="text-[13px] text-muted">
              Published with {version.publishedUnplacedCount} periods not placed and {version.publishedWarningCount} warnings.
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {isOpen(version) && (
            <>
              <Button asChild variant="outline" size="sm">
                <Link to="/timetable/schedule">Open Draft</Link>
              </Button>
              {(can('timetable:review') || can('timetable:publish')) && (
                <Button asChild size="sm">
                  <Link to={`/timetable/versions/${version.versionId}/publish`}>
                    Review And Publish <ArrowRight />
                  </Link>
                </Button>
              )}
              {canDraft && (
                <Button variant="ghost" size="sm" onClick={() => setDiscard(true)}>
                  Discard Draft
                </Button>
              )}
            </>
          )}
          {(version.phase === 'ACTIVE' || version.phase === 'UPCOMING') && (
            <>
              {canDraft &&
                (openDraft ? (
                  <Button asChild variant="outline" size="sm">
                    <Link to="/timetable/schedule">Open Draft</Link>
                  </Button>
                ) : (
                  <Button size="sm" loading={revise.isPending} loadingText="Making a copy…" onClick={() => revise.mutate(undefined, { onSuccess: () => navigate('/timetable/schedule') })}>
                    <Plus /> Create Revision
                  </Button>
                ))}
              <Button asChild variant="outline" size="sm">
                <Link to="/timetable/views">View</Link>
              </Button>
            </>
          )}
          {(previous || version.sourceVersionId) && version.phase !== 'DISCARDED' && (
            <Button variant="ghost" size="sm" aria-expanded={compare} onClick={() => setCompare((c) => !c)}>
              <GitCompareArrows /> Compare
            </Button>
          )}
        </div>
      </div>
      {compare && <Compare version={version} previous={previous} />}
      <ConfirmDialog
        open={discard}
        onOpenChange={setDiscard}
        title="Discard this draft?"
        description="The draft stays in the list as history. It can no longer be changed or published."
        confirmLabel="Discard Draft"
        loadingLabel="Discarding…"
        tone="danger"
        onConfirm={async () => {
          await discardIt.mutateAsync(undefined);
        }}
      />
    </Card>
  );
}

/** `/timetable/versions`: every version with its phase, and what you can do with it. */
export function VersionsPage() {
  const { plan, loading } = useTimetablePlan();
  const versions = useVersions(plan?.planId);
  const list = versions.data ?? [];
  const openDraft = list.find(isOpen);
  return (
    <>
      <PageHeader eyebrow="Timetable" title="Versions" description="Every timetable that was built, and the one the school follows now." />
      <div className="space-y-4">
        <TabIntro title="How this works">
          {VERSIONS_INTRO}
          <p className="flex items-center gap-1.5 text-[13px]">
            What is a revision? <InfoTip label="About revisions">{DAILY_TIPS.revision}</InfoTip> What does superseded mean? <InfoTip label="About superseded">{DAILY_TIPS.superseded}</InfoTip>
          </p>
        </TabIntro>
        {(loading || versions.isLoading) && <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading" />}
        {!loading && !plan && <CreatePlanCard />}
        {versions.isError && <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />}
        {plan && versions.data && list.length === 0 && (
          <Card className="space-y-2 p-6 text-center">
            <h2 className="text-lg font-extrabold">No timetable yet</h2>
            <p className="text-sm text-muted">Build the first one in the Schedule.</p>
            <Button asChild className="mx-auto">
              <Link to="/timetable/schedule">Go To Schedule</Link>
            </Button>
          </Card>
        )}
        {plan && list.map((v, i) => <Row key={v.versionId} version={v} previous={list.slice(i + 1).find((o) => o.phase !== 'DISCARDED' && o.phase !== 'DRAFT' && o.phase !== 'READY')} openDraft={openDraft} />)}
      </div>
    </>
  );
}
