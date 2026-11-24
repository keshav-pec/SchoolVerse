import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, History, Sparkles } from 'lucide-react';
import type { TimetablePlanDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { TabIntro } from '@/components/sv/help';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { TT, useReadiness } from '../api';
import { START_INTRO, TIPS } from '../help-copy';
import { calls, newRequestId, usePreviousSession } from './api';
import type { RunResult } from './runs';

/** The Start page. A timetable is never a blank grid: pick how to fill it, and fix only what is left. */
export function StartPage({ plan, onResult }: { plan: TimetablePlanDTO; onResult: (result: RunResult) => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const previous = usePreviousSession(plan.planId);
  const readiness = useReadiness(plan.planId);
  const canDraft = can('timetable:draft:create');
  const done = () => void qc.invalidateQueries({ queryKey: TT });

  const preview = useQuery({ queryKey: [...TT, 'copy-preview', plan.planId], queryFn: () => calls.copyPrevious(plan.planId, 'PREVIEW'), enabled: previous.data?.available === true });
  const reuse = useMutation({
    mutationFn: () => calls.copyPrevious(plan.planId, 'COMMIT', newRequestId()),
    onSuccess: (copy) => {
      onResult({ kind: 'copy', copy });
      done();
    },
    onError: (e) => toast.error(messageFor(e)),
  });
  const smart = useMutation({
    mutationFn: async () => {
      const draft = await calls.createDraft(plan.planId);
      return calls.smartDraft(draft.versionId, { mode: 'FILL_GAPS', requestId: newRequestId() });
    },
    onSuccess: (run) => {
      onResult({ kind: 'draft', run });
      done();
    },
    onError: (e) => {
      toast.error(messageFor(e));
      done();
    },
  });
  const empty = useMutation({ mutationFn: () => calls.createDraft(plan.planId), onSuccess: done, onError: (e) => toast.error(messageFor(e)) });
  const r = readiness.data;
  const blockers = r ? r.areas.flatMap((a) => a.items.filter((i) => i.severity === 'BLOCKER')) : [];
  const busy = reuse.isPending || smart.isPending || empty.isPending;

  return (
    <div className="space-y-4">
      <TabIntro title="Start your timetable">{START_INTRO}</TabIntro>
      {!canDraft && <Alert tone="warning">You can look at the timetable, but only a Scheduling Coordinator or School Admin can start it.</Alert>}
      <div className="grid gap-4 lg:grid-cols-2">
        {previous.data?.available && (
          <Card className="flex flex-col gap-3 p-5" aria-label="Reuse Last Year">
            <h2 className="flex items-center gap-2 text-lg font-extrabold">
              <History className="size-5 text-brand" aria-hidden="true" /> Reuse Last Year
            </h2>
            <p className="text-sm text-muted">{previous.data.message}. We carry over what still fits. Anything that changed (a new teacher, a room, a section) is listed for you to decide.</p>
            {preview.isLoading && <Skeleton className="h-10 rounded-lg" role="status" aria-label="Checking last year" />}
            {preview.data && (
              <p className="rounded-xl bg-brand-soft/60 px-3 py-2 text-sm font-semibold" data-testid="copy-preview">
                {preview.data.summary}
              </p>
            )}
            <Button className="mt-auto self-start" disabled={!canDraft || busy} loading={reuse.isPending} loadingText="Copying…" onClick={() => reuse.mutate()}>
              Reuse Last Year
            </Button>
          </Card>
        )}
        <Card className="flex flex-col gap-3 border-brand/40 p-5" aria-label="Prepare Smart Draft">
          <h2 className="flex items-center gap-2 text-lg font-extrabold">
            <Sparkles className="size-5 text-brand" aria-hidden="true" /> Prepare Smart Draft
            <span className="rounded-pill bg-brand-soft px-2 py-0.5 text-[11px] font-semibold text-brand">Recommended</span>
          </h2>
          <p className="text-sm text-muted">SchoolVerse builds the timetable from your setup, with no clashes. It will use:</p>
          {readiness.isLoading && <Skeleton className="h-10 rounded-lg" role="status" aria-label="Checking setup" />}
          {r && (
            <p className="rounded-xl bg-canvas px-3 py-2 text-sm font-semibold" data-testid="smart-uses">
              {r.counts.sections} sections, {r.counts.teachers} teachers, {r.counts.homeClassrooms} Home Classrooms, {r.counts.specialRooms} special rooms
            </p>
          )}
          {r && !r.canSmartDraft && (
            <Alert tone="warning" title="Finish these first">
              <ul className="mt-1 space-y-1">
                {(blockers.length > 0 ? blockers : []).map((b) => (
                  <li key={b.key} className="flex flex-wrap items-center gap-2">
                    {b.message}
                    <Button asChild size="sm" variant="outline">
                      <Link to={b.fix.path}>
                        {b.fix.label} <ArrowRight />
                      </Link>
                    </Button>
                  </li>
                ))}
                {blockers.length === 0 && r.smartDraftBlockedBy.map((m) => <li key={m}>{m}</li>)}
              </ul>
            </Alert>
          )}
          <Button className="mt-auto self-start" disabled={!canDraft || !can('timetable:smart_draft:run') || !r?.canSmartDraft || busy} loading={smart.isPending} loadingText="Building…" onClick={() => smart.mutate()}>
            Prepare Smart Draft
          </Button>
        </Card>
      </div>
      <p className="text-sm text-muted">
        Or{' '}
        <Button variant="link" className="inline h-auto p-0 text-sm" disabled={!canDraft || busy} onClick={() => empty.mutate()}>
          Start Empty
        </Button>{' '}
        <InfoTip label="About starting empty">{TIPS.startEmpty}</InfoTip>
      </p>
    </div>
  );
}
