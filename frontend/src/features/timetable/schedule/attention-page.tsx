import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, CircleCheck, Wand2 } from 'lucide-react';
import { RUN_ITEM_REASON_LABELS, type AcceptGroupResultDTO, type RuleCode, type RunItemDTO, type RunItemReason, type ScheduleAttentionDTO, type ScheduleAttentionRowDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { TT } from '../api';
import { CreatePlanCard, useTimetablePlan } from '../context';
import { ATTENTION_INTRO } from '../help-copy';
import { useLessonActions } from './actions';
import { calls, useAttention, useExplain, useRunItems, useVersions } from './api';
import { FIXABLE_RULES, FixThisForMe } from './dialogs';
import { EditorProvider, SaveIndicator, useEditor } from './editor';

/** `/timetable/attention`: the short list of what is still to fix, each row with the one right button. */
export function AttentionPage() {
  const { plan, loading } = useTimetablePlan();
  const versions = useVersions(plan?.planId);
  const open = versions.data?.find((v) => v.status === 'DRAFT' || v.status === 'READY');
  return (
    <>
      <PageHeader eyebrow="Timetable" title="Needs Attention" description="What is still to fix before the timetable is complete." />
      <div className="space-y-4">
        <TabIntro title="How this works">{ATTENTION_INTRO}</TabIntro>
        {(loading || versions.isLoading) && <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />}
        {!loading && !plan && <CreatePlanCard />}
        {plan && versions.data && !open && (
          <EmptyState title="There is no draft timetable yet" description="Start one first. Smart Draft or last year’s timetable fill most of it." action={<Button asChild><Link to="/timetable/schedule">Go To Schedule</Link></Button>} />
        )}
        {open && (
          <EditorProvider versionId={open.versionId}>
            <Body versionId={open.versionId} />
          </EditorProvider>
        )}
      </div>
    </>
  );
}

const ruleOf = (row: ScheduleAttentionRowDTO): RuleCode | null => {
  const m = /^health:[^:]+:([A-Z_]+)$/.exec(row.rowId);
  return m && FIXABLE_RULES.includes(m[1] as RuleCode) ? (m[1] as RuleCode) : null;
};

function scheduleLink(row: ScheduleAttentionRowDTO, focus?: 'teacher' | 'room' | 'move') {
  const q = new URLSearchParams({ view: row.sectionOfferingId ? 'section' : 'group' });
  const id = row.sectionOfferingId ?? row.teachingGroupId;
  if (id) q.set('id', id);
  if (row.entryId) q.set('entry', row.entryId);
  if (focus) q.set('focus', focus);
  return `/timetable/schedule?${q.toString()}`;
}

function Body({ versionId }: { versionId: string }) {
  const attention = useAttention(versionId);
  const items = useRunItems(versionId);
  const [accepted, setAccepted] = useState<AcceptGroupResultDTO | null>(null);
  const qc = useQueryClient();
  const reasonOf = new Map((items.data ?? []).map((i) => [i.itemId, i]));

  const group = useMutation({
    mutationFn: ({ runId, reason }: { runId: string; reason: RunItemReason }) => calls.acceptGroup(runId, reason),
    onSuccess: (r) => {
      setAccepted(r);
      void qc.invalidateQueries({ queryKey: TT });
    },
    onError: (e) => toast.error(messageFor(e)),
  });

  if (attention.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />;
  if (attention.isError) return <ErrorState error={attention.error} onRetry={() => void attention.refetch()} />;
  const data = attention.data as ScheduleAttentionDTO;

  // Last year's items that can be accepted in one click, grouped by why they need a look.
  const byReason = new Map<RunItemReason, RunItemDTO[]>();
  for (const i of items.data ?? []) if (i.hasSuggestion) byReason.set(i.reason, [...(byReason.get(i.reason) ?? []), i]);

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-semibold" data-testid="attention-progress">
          {data.progress}
        </p>
        <span className="flex items-center gap-2">
          <SaveIndicator />
          <Button asChild variant="outline" size="sm">
            <Link to="/timetable/schedule">Open Schedule</Link>
          </Button>
        </span>
      </div>
      {data.total === 0 && (
        <Card className="flex items-center gap-3 border-success/40 bg-success-soft/40 p-5">
          <CircleCheck className="size-7 text-success" aria-hidden="true" />
          <div>
            <h2 className="text-lg font-extrabold">Nothing needs attention</h2>
            <p className="text-sm text-muted">Every lesson is placed and nothing clashes.</p>
          </div>
        </Card>
      )}
      {data.groups
        .filter((g) => g.count > 0)
        .map((g) => (
          <Card key={g.group} className="space-y-3 p-4 sm:p-5" aria-label={g.label}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="flex items-center gap-2 text-base font-bold">
                {g.label} <Badge tone="warning">{g.count}</Badge>
              </h2>
              {g.group === 'LAST_YEAR' && (
                <span className="flex flex-wrap gap-2">
                  {[...byReason].map(([reason, list]) => (
                    <Button key={reason} size="sm" variant="outline" loading={group.isPending} loadingText="Accepting…" onClick={() => group.mutate({ runId: list[0]!.runId, reason })}>
                      Accept All {list.length} {reason === 'TEACHER_CHANGED' ? 'Teacher Changes' : reason === 'ROOM_PROBLEM' ? 'Room Changes' : RUN_ITEM_REASON_LABELS[reason]}
                    </Button>
                  ))}
                </span>
              )}
            </div>
            <ul className="space-y-2">
              {g.rows.map((row) => (
                <Row key={row.rowId} row={row} versionId={versionId} item={row.runItemId ? reasonOf.get(row.runItemId) : undefined} />
              ))}
            </ul>
          </Card>
        ))}
      <Modal open={accepted !== null} onOpenChange={(o) => !o && setAccepted(null)} title="Accepted" footer={<Button onClick={() => setAccepted(null)}>Done</Button>}>
        {accepted && (
          <div className="space-y-3">
            <p className="text-sm font-semibold">{accepted.accepted} accepted.</p>
            {accepted.failed.length > 0 && (
              <Alert tone="warning" title={`${accepted.failed.length} could not be accepted`}>
                <ul className="mt-1 list-disc space-y-1 pl-5">
                  {accepted.failed.map((f) => (
                    <li key={f.itemId}>{f.message}</li>
                  ))}
                </ul>
              </Alert>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

function Row({ row, versionId, item }: { row: ScheduleAttentionRowDTO; versionId: string; item: RunItemDTO | undefined }) {
  const { can } = useAuth();
  const editor = useEditor();
  const actions = useLessonActions();
  const qc = useQueryClient();
  const [why, setWhy] = useState(false);
  const [fix, setFix] = useState(false);
  const [applying, setApplying] = useState(false);
  const rule = ruleOf(row);
  const explain = useExplain(versionId, { sectionId: row.sectionOfferingId ?? undefined, groupId: row.teachingGroupId ?? undefined, subjectOfferingId: row.subjectOfferingId ?? undefined }, why);
  const canEdit = can('timetable:entry:edit');
  const refresh = () => void qc.invalidateQueries({ queryKey: TT });
  const accept = useMutation({ mutationFn: () => calls.acceptItem(row.runItemId!), onSuccess: () => { toast.success('Accepted.'); refresh(); }, onError: (e) => toast.error(messageFor(e)) });
  const dismiss = useMutation({ mutationFn: () => calls.dismissItem(row.runItemId!), onSuccess: () => { toast.success('Dismissed.'); refresh(); }, onError: (e) => toast.error(messageFor(e)) });

  const place = () =>
    row.slot &&
    actions.add(`Add ${row.title}`, { weekday: row.slot.weekday, periodId: row.slot.periodId, entryType: 'SUBJECT', subjectOfferingId: row.subjectOfferingId, ...(row.teachingGroupId ? { teachingGroupId: row.teachingGroupId } : { sectionOfferingIds: [row.sectionOfferingId] }) });

  return (
    <li className="flex flex-col gap-2 rounded-xl border border-line bg-white p-3 text-sm sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <p className="font-semibold">{row.title}</p>
        <p className="text-[13px] text-muted">{row.message}</p>
        {row.slot && <p className="text-[13px] font-semibold text-brand">Best slot: {row.slot.label}</p>}
        {why && explain.data && (
          <p className="mt-1 rounded-lg bg-canvas px-2 py-1.5 text-[13px]" data-testid="why-text">
            {explain.data.message}
            {explain.data.bestFix && <span className="block font-semibold">Best fix: {explain.data.bestFix.label}</span>}
          </p>
        )}
        {why && explain.isLoading && <Skeleton className="mt-1 h-8 rounded-lg" role="status" aria-label="Working it out" />}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {row.fix === 'PLACE_SLOT' && row.slot && canEdit && (
          <Button size="sm" onClick={() => void place()}>
            Place
          </Button>
        )}
        {row.rowId.startsWith('unplaced:') && (
          <Button size="sm" variant="outline" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
            Why?
          </Button>
        )}
        {row.fix === 'APPLY_FIX' && row.suggestionToken && canEdit && (
          <Button size="sm" variant="outline" onClick={() => setApplying(true)}>
            <Wand2 /> Fix This For Me
          </Button>
        )}
        {rule && canEdit && row.entryId && row.fix !== 'APPLY_FIX' && (
          <Button size="sm" variant="outline" onClick={() => setFix(true)}>
            <Wand2 /> Fix This For Me
          </Button>
        )}
        {(row.fix === 'MOVE_ENTRY' || row.fix === 'PICK_TEACHER' || row.fix === 'PICK_ROOM') && row.entryId && (
          <Button asChild size="sm" variant="outline">
            <Link to={scheduleLink(row, row.fix === 'MOVE_ENTRY' ? 'move' : row.fix === 'PICK_TEACHER' ? 'teacher' : 'room')}>{row.fixLabel}</Link>
          </Button>
        )}
        {row.fix === 'PLACE_SLOT' && !row.slot && (
          <Button asChild size="sm" variant="outline">
            <Link to={scheduleLink(row)}>
              Open In Schedule <ArrowRight />
            </Link>
          </Button>
        )}
        {(row.fix === 'ASSIGN_CLASSES' || (row.fix === 'PICK_TEACHER' && !row.entryId)) && (
          <Button asChild size="sm" variant="outline">
            <Link to="/people">Go To Assign Classes</Link>
          </Button>
        )}
        {row.fix === 'CLASSROOM_ALLOCATION' && (
          <Button asChild size="sm" variant="outline">
            <Link to="/spaces/allocation">{row.fixLabel}</Link>
          </Button>
        )}
        {(row.fix === 'SPACE_SETUP' || (row.fix === 'PICK_ROOM' && !row.entryId)) && (
          <Button asChild size="sm" variant="outline">
            <Link to="/spaces">Go To Space Setup</Link>
          </Button>
        )}
        {row.fix === 'ACCEPT_MAPPING' && canEdit && (
          <>
            <Button size="sm" loading={accept.isPending} loadingText="Accepting…" disabled={item ? !item.hasSuggestion : false} onClick={() => accept.mutate()}>
              Accept
            </Button>
            <Button size="sm" variant="ghost" loading={dismiss.isPending} loadingText="Dismissing…" onClick={() => dismiss.mutate()}>
              Dismiss
            </Button>
          </>
        )}
      </div>
      {rule && row.entryId && fix && <FixThisForMe entryId={row.entryId} rule={rule} open onClose={() => setFix(false)} />}
      <ConfirmDialog
        open={applying}
        onOpenChange={setApplying}
        title="Fix This For Me"
        description={`${row.fixLabel}. This change has already been checked, so it will not make a clash.`}
        confirmLabel="Apply This Fix"
        loadingLabel="Applying…"
        onConfirm={async () => {
          await editor.exec(row.fixLabel, (o) => calls.applyFix(versionId, row.suggestionToken!, o.requestId));
        }}
      />
    </li>
  );
}
