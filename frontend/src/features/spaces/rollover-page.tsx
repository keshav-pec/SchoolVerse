import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { RolloverCommitDTO, RolloverRowDTO } from '@shared';
import { ArrowRight, ChevronDown, ChevronRight, CircleCheck, Info, Repeat, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { messageFor } from '@/lib/errors';
import { useStudentContext } from '../students/context';
import { useRolloverCommit, useRolloverPreview } from './allocation-api';
import { ROLLOVER_INTRO, ROLLOVER_NOTE, ROLLOVER_REASON_LABELS } from './help-copy';
import { PickRoomDialog, type PickTarget } from './room-picker';
import { nextSessionOf } from './rollover-banner';

function Exceptions({ rows, onPick }: { rows: RolloverRowDTO[]; onPick: (t: PickTarget) => void }) {
  const groups = Object.keys(ROLLOVER_REASON_LABELS)
    .map((reason) => ({ reason, rows: rows.filter((r) => r.reason === reason) }))
    .filter((g) => g.rows.length > 0);
  return (
    <Card className="p-0" aria-label="Needs a look">
      <CardHeader className="mb-0 border-b border-line px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TriangleAlert className="size-4 text-warning" aria-hidden="true" /> Needs a look <Badge tone="warning">{rows.length}</Badge>
        </CardTitle>
      </CardHeader>
      {groups.map((g) => (
        <section key={g.reason} aria-label={ROLLOVER_REASON_LABELS[g.reason]} className="border-b border-line last:border-b-0">
          <h3 className="bg-canvas px-4 py-1.5 text-[12px] font-bold tracking-wide text-muted uppercase">{ROLLOVER_REASON_LABELS[g.reason]}</h3>
          <ul className="divide-y divide-line">
            {g.rows.map((r) => (
              <li key={r.fromSection.sectionOfferingId} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="rollover-exception">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-semibold">
                    {r.fromSection.label} <ArrowRight className="inline size-3.5 text-muted" aria-hidden="true" /> {r.toSection?.label ?? '—'}
                    <span className="ml-2 font-normal text-muted">was in {r.room.spaceName}</span>
                  </p>
                  <p className="text-[13px] text-muted">{r.message}</p>
                </div>
                {r.toSection ? (
                  <Button size="sm" variant="outline" onClick={() => onPick({ sectionOfferingId: r.toSection!.sectionOfferingId, label: r.toSection!.label, strength: r.toSection!.strength, suggestedRoomId: r.suggestedRoom?.spaceId ?? null })}>
                    Pick Another Room
                  </Button>
                ) : (
                  <Button size="sm" variant="link" asChild>
                    <Link to="/academics">Go To Academic Setup</Link>
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </Card>
  );
}

function ReadyRows({ rows }: { rows: RolloverRowDTO[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-0" aria-label="Ready to carry forward">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left text-base font-bold">
        {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
        Ready <Badge tone="success">{rows.length}</Badge>
      </button>
      {open && (
        <ul className="divide-y divide-line border-t border-line">
          {rows.map((r) => (
            <li key={r.fromSection.sectionOfferingId} className="flex flex-wrap gap-x-3 px-4 py-2 text-sm">
              <b>{r.toSection?.label}</b>
              <span>{r.room.spaceName}</span>
              <span className="text-muted">{r.toSection ? `${r.toSection.strength} students` : ''}{r.room.academicCapacity !== null ? ` · ${r.room.academicCapacity} seats` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Result({ result, toCode }: { result: RolloverCommitDTO; toCode: string }) {
  return (
    <Card className="p-4 sm:p-5" aria-label="Result" data-testid="rollover-result">
      <p className="flex items-center gap-2 text-base font-bold">
        <CircleCheck className="size-5 text-success" aria-hidden="true" /> {result.message}
      </p>
      <ul className="mt-2 space-y-0.5 text-sm text-muted">
        <li>{result.carried} copied to {toCode}.</li>
        {result.alreadyDone > 0 && <li>{result.alreadyDone} already had a room. Nothing changed for them.</li>}
        {result.skipped > 0 && <li>{result.skipped} could not be copied. They are listed under Needs a look.</li>}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button asChild size="sm" variant="outline">
          <Link to="/spaces/allocation?tab=current">Open Current Rooms</Link>
        </Button>
      </div>
    </Card>
  );
}

/** `/spaces/rollover`: carry last year's section-to-room links into the new year. Exceptions first; the ready rows are collapsed. */
export function RolloverPage() {
  const ctx = useStudentContext();
  const [params, setParams] = useSearchParams();
  const fromId = params.get('from') ?? ctx.sessionId ?? '';
  const from = ctx.sessions.find((s) => s.academicSessionId === fromId);
  const toId = params.get('to') ?? nextSessionOf(ctx.sessions, from)?.academicSessionId ?? '';
  const to = ctx.sessions.find((s) => s.academicSessionId === toId);
  const preview = useRolloverPreview({ fromSessionId: fromId || undefined, toSessionId: toId || undefined, locationId: ctx.locationId });
  const commit = useRolloverCommit();
  const [result, setResult] = useState<RolloverCommitDTO | null>(null);
  const [pick, setPick] = useState<PickTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (key: 'from' | 'to', value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    if (key === 'from') next.delete('to');
    setParams(next, { replace: true });
    setResult(null);
  };
  const sessionOptions = ctx.sessions.map((s) => ({ value: s.academicSessionId, label: s.code, hint: s.status.charAt(0) + s.status.slice(1).toLowerCase() }));
  const toOptions = sessionOptions.map((o) => {
    const s = ctx.sessions.find((x) => x.academicSessionId === o.value)!;
    const closed = s.status === 'CLOSED' || s.status === 'ARCHIVED';
    return { ...o, disabled: o.value === fromId || closed, hint: o.value === fromId ? 'Same year' : closed ? 'Closed' : o.hint };
  });
  const data = preview.data;
  const review = data?.rows.filter((r) => r.status === 'REVIEW') ?? [];
  const ready = data?.rows.filter((r) => r.status === 'READY') ?? [];

  return (
    <>
      <PageHeader eyebrow="Campus" title="Rollover" description="Carry Home Classrooms into the next school year." />
      <TabIntro title="How this works" className="mb-4">
        {ROLLOVER_INTRO}
      </TabIntro>
      {ctx.loading ? (
        <Skeleton className="h-32 rounded-card" role="status" aria-label="Loading" />
      ) : ctx.sessions.length < 2 ? (
        <Card>
          <EmptyState
            illustration={<Repeat className="size-14 text-brand" aria-hidden="true" />}
            title="There is only one school year"
            description="Make next year in Academic Setup first (Copy From Last Year). Then come back here."
            action={
              <Button asChild variant="outline">
                <Link to="/academics">Go To Academic Setup</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <Card className="p-4 sm:p-5">
            <div className="grid gap-3 sm:grid-cols-2">
              <ComboboxField label="From" value={fromId} onChange={(v) => set('from', v)} options={sessionOptions} searchPlaceholder="Search years…" placeholder="Choose…" />
              <ComboboxField label="To" value={toId} onChange={(v) => set('to', v)} options={toOptions} searchPlaceholder="Search years…" placeholder="Choose…" />
            </div>
            <p className="mt-3 flex items-center gap-2 text-[13px] text-muted">
              <Info className="size-4 shrink-0 text-brand" aria-hidden="true" /> {ROLLOVER_NOTE} Campus: {ctx.location?.displayName}.
            </p>
          </Card>

          {!toId ? (
            <Alert tone="info">Choose the year to carry the rooms into.</Alert>
          ) : preview.isLoading ? (
            <Skeleton className="h-32 rounded-card" role="status" aria-label="Loading" />
          ) : preview.isError || !data ? (
            <ErrorState error={preview.error} onRetry={() => void preview.refetch()} retrying={preview.isFetching} />
          ) : data.total === 0 ? (
            <Card>
              <EmptyState
                illustration={<Repeat className="size-14 text-brand" aria-hidden="true" />}
                title={`${from?.code ?? 'This year'} has no Home Classrooms to copy`}
                description="Give the sections their rooms in Classroom Allocation first."
                action={
                  <Button asChild variant="outline">
                    <Link to="/spaces/allocation">Go To Classroom Allocation</Link>
                  </Button>
                }
              />
            </Card>
          ) : (
            <>
              {result ? (
                <Result result={result} toCode={to?.code ?? ''} />
              ) : (
                <Card className="p-4 sm:p-5" aria-label="Summary">
                  <p className="text-base" data-testid="rollover-summary">
                    <b>
                      {data.ready} of {data.total}
                    </b>{' '}
                    mappings can be carried forward.{data.review > 0 && <b className="text-warning"> {data.review} need{data.review === 1 ? 's' : ''} a look.</b>}
                    {data.done > 0 && <span className="text-muted"> {data.done} already done.</span>}
                  </p>
                  {data.ready > 0 && (
                    <Button
                      className="mt-3"
                      size="lg"
                      loading={commit.isPending}
                      loadingText="Carrying forward…"
                      onClick={async () => {
                        setError(null);
                        try {
                          const r = await commit.mutateAsync({ fromSessionId: fromId, toSessionId: toId, locationId: ctx.locationId! });
                          setResult(r);
                          toast.success(r.message);
                        } catch (err) {
                          setError(messageFor(err));
                        }
                      }}
                    >
                      <Repeat /> Carry Forward {data.ready} Assignment{data.ready === 1 ? '' : 's'}
                    </Button>
                  )}
                  {error && (
                    <Alert tone="danger" className="mt-3">
                      {error}
                    </Alert>
                  )}
                </Card>
              )}
              {review.length > 0 && <Exceptions rows={review} onPick={setPick} />}
              {ready.length > 0 && <ReadyRows rows={ready} />}
            </>
          )}
          {pick && ctx.locationId && toId && <PickRoomDialog target={pick} locationId={ctx.locationId} sessionId={toId} onClose={() => setPick(null)} />}
        </div>
      )}
    </>
  );
}
