import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import type { BulkAssignmentResultDTO, HomeClassroomDTO, RecommendationDTO, RecommendationSetDTO, UnresolvedSectionDTO } from '@shared';
import { Building2, ChevronDown, ChevronRight, CircleCheck, DoorOpen, GraduationCap, History, Repeat, Sparkles, TriangleAlert } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { TextareaField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { toast } from 'sonner';
import { useStudentContext } from '../students/context';
import { isLiveRow, useAssignments, useBulkAssign, useEndAssignment, useRecommendations } from './allocation-api';
import { ALLOCATION_INTRO, BEST_FIT_HELP, CONTINUITY_HELP, PHASE_LABELS, SHIFT_HELP, SOURCE_LABELS, UNRESOLVED_LABELS } from './help-copy';
import { PickRoomDialog, useAssignFlow, type PickTarget } from './room-picker';
import { RolloverBanner } from './rollover-banner';

const MANAGE = 'space:section_assignment:manage' as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const niceDate = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
const todayIso = () => new Date().toLocaleDateString('en-CA');

// ───────────────────────────────────────────────────────────── summary

function Summary({ set }: { set: RecommendationSetDTO }) {
  const s = set.summary;
  return (
    <Card className="p-4 sm:p-5" aria-label="Summary">
      <p className="text-base" data-testid="allocation-summary">
        We found <b>{plural(s.sections, 'section')}</b> and <b>{plural(s.eligibleRooms, 'eligible room')}</b>.{' '}
        {s.ready + s.needsReview === 0 ? (
          <b>Every section has a Home Classroom.</b>
        ) : (
          <>
            <b>{s.ready} {s.ready === 1 ? 'is' : 'are'} ready.</b> {s.needsReview > 0 && <b className="text-warning">{s.needsReview} need{s.needsReview === 1 ? 's' : ''} your attention.</b>}
          </>
        )}
      </p>
      {s.alreadyAssigned > 0 && (
        <p className="mt-1 text-sm text-muted">
          {plural(s.alreadyAssigned, 'section')} already {s.alreadyAssigned === 1 ? 'has' : 'have'} a room. See <Link to="?tab=current" className="font-semibold text-brand hover:underline">Current Rooms</Link>.
        </p>
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── needs a look

function KeepClosestDialog({ row, onClose }: { row: UnresolvedSectionDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const flow = useAssignFlow(onClose);
  const room = row.closestRoom!;
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Keep this room anyway?"
      description={`${row.section.label} · ${room.spaceName}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!reason.trim()}
            loading={flow.busy}
            loadingText="Saving…"
            onClick={async () => {
              setError(null);
              const r = await flow.run({ kind: 'assign', body: { sectionOfferingId: row.section.sectionOfferingId, physicalSpaceId: room.spaceId, capacityOverride: { reason: reason.trim() } }, sectionLabel: row.section.label, roomName: room.spaceName });
              if (!r.ok && r.message) setError(r.message);
            }}
          >
            Keep Room
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Alert tone="warning">
          {row.section.label} has <b>{row.section.strength} students</b>, but {room.spaceName} holds <b>{room.academicCapacity ?? '?'}</b>.
        </Alert>
        <TextareaField label="Why keep this room?" hint="Required. Example: Extra desks added." value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} autoFocus />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

function NeedsLook({ rows, onPick }: { rows: UnresolvedSectionDTO[]; onPick: (target: PickTarget) => void }) {
  const [keep, setKeep] = useState<UnresolvedSectionDTO | null>(null);
  const { can } = useAuth();
  return (
    <Card className="p-0" aria-label="Needs a look">
      <CardHeader className="mb-0 border-b border-line px-4 py-3">
        <CardTitle className="flex items-center gap-2 text-base">
          <TriangleAlert className="size-4 text-warning" aria-hidden="true" /> Needs a look <Badge tone="warning">{rows.length}</Badge>
        </CardTitle>
      </CardHeader>
      <ul className="divide-y divide-line">
        {rows.map((row) => {
          const target: PickTarget = { sectionOfferingId: row.section.sectionOfferingId, label: row.section.label, strength: row.section.strength };
          return (
            <li key={row.section.sectionOfferingId} className="flex flex-wrap items-center gap-3 px-4 py-3" data-testid="needs-look-row">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">
                  {row.section.label}
                  <span className="ml-2 font-normal text-muted">{UNRESOLVED_LABELS[row.reason] ?? row.reason}</span>
                </p>
                <p className="text-[13px] text-muted">{row.message}</p>
              </div>
              {can(MANAGE) && (
                <div className="flex flex-wrap gap-2">
                  {row.reason !== 'NO_ELIGIBLE_ROOM' && (
                    <Button size="sm" onClick={() => onPick({ ...target, largerOnly: true })}>
                      Choose Larger Room
                    </Button>
                  )}
                  {row.closestRoom && (
                    <Button size="sm" variant="outline" onClick={() => setKeep(row)}>
                      Keep Room Anyway
                    </Button>
                  )}
                  <Button size="sm" variant="outline" onClick={() => onPick({ ...target, suggestedRoomId: row.closestRoom?.spaceId ?? null })}>
                    Pick Another Room
                  </Button>
                  {row.reason === 'NO_ELIGIBLE_ROOM' && (
                    <Button size="sm" variant="link" asChild>
                      <Link to="/spaces">Go To Space Setup</Link>
                    </Button>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {keep && <KeepClosestDialog row={keep} onClose={() => setKeep(null)} />}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── recommended

function Recommended({ rows, onReview }: { rows: RecommendationDTO[]; onReview: (target: PickTarget) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <Card className="p-0" aria-label="Recommended">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="flex w-full items-center gap-2 px-4 py-3 text-left text-base font-bold">
        {open ? <ChevronDown className="size-4" aria-hidden="true" /> : <ChevronRight className="size-4" aria-hidden="true" />}
        Recommended <Badge tone="success">{rows.length}</Badge>
        <span className="ml-auto flex items-center gap-1 text-[13px] font-normal text-muted">
          How we pick <InfoTip label="About best fit">{BEST_FIT_HELP}</InfoTip>
          <InfoTip label="About continuity">{CONTINUITY_HELP}</InfoTip>
        </span>
      </button>
      {open && (
        <div className="overflow-x-auto border-t border-line">
          <table className="w-full text-left text-sm" aria-label="Recommended rooms">
            <thead className="border-b border-line bg-canvas text-[12px] font-bold tracking-wide text-muted uppercase max-md:sr-only">
              <tr>
                <th scope="col" className="px-3 py-2">Section</th>
                <th scope="col" className="px-3 py-2">Students</th>
                <th scope="col" className="px-3 py-2">Room</th>
                <th scope="col" className="px-3 py-2">Seats</th>
                <th scope="col" className="px-3 py-2">Why</th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">Review</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.section.sectionOfferingId} className="max-md:flex max-md:flex-wrap max-md:gap-x-3 max-md:px-3 max-md:py-2">
                  <td className="px-3 py-2 font-semibold max-md:p-0">{r.section.label}</td>
                  <td className="px-3 py-2 tabular-nums max-md:p-0">{r.section.strength}</td>
                  <td className="px-3 py-2 max-md:p-0">
                    {r.room.spaceName}
                    {r.replacesAssignmentId && <Badge tone="sun" className="ml-2">Replaces a closed room</Badge>}
                  </td>
                  <td className="px-3 py-2 tabular-nums max-md:p-0">{r.room.academicCapacity ?? '—'}</td>
                  <td className="px-3 py-2 text-[13px] text-muted max-md:w-full max-md:p-0">
                    {r.reasons.join(' · ')}
                    {r.warnings.map((w) => (
                      <span key={w.code} className="mt-0.5 flex items-center gap-1 text-warning">
                        <TriangleAlert className="size-3.5" aria-hidden="true" /> {w.message}
                      </span>
                    ))}
                  </td>
                  <td className="px-3 py-2 text-right max-md:p-0">
                    <Can permission={MANAGE}>
                      <Button size="sm" variant="link" onClick={() => onReview({ sectionOfferingId: r.section.sectionOfferingId, label: r.section.label, strength: r.section.strength, suggestedRoomId: r.room.spaceId, assignmentId: r.replacesAssignmentId })} aria-label={`Review ${r.section.label}`}>
                        Review
                      </Button>
                    </Can>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── accept all

function AcceptDialog({ rows, onClose }: { rows: RecommendationDTO[]; onClose: () => void }) {
  const bulk = useBulkAssign();
  const [result, setResult] = useState<BulkAssignmentResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);

  const accept = async () => {
    setError(null);
    const items = rows.map((r) => ({ sectionOfferingId: r.section.sectionOfferingId, physicalSpaceId: r.room.spaceId, ...(r.replacesAssignmentId ? { replaceExisting: true } : {}) }));
    const merged: BulkAssignmentResultDTO = { source: 'SYSTEM_RECOMMENDED', done: [], alreadyDone: [], failed: [], message: '' };
    try {
      for (let i = 0; i < items.length; i += 200) {
        const part = await bulk.mutateAsync({ items: items.slice(i, i + 200), source: 'SYSTEM_RECOMMENDED' });
        merged.done.push(...part.done);
        merged.alreadyDone.push(...part.alreadyDone);
        merged.failed.push(...part.failed);
      }
      setResult(merged);
      if (merged.done.length > 0) toast.success(`${plural(merged.done.length, 'section')} got a Home Classroom.`);
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={result ? 'Done' : `Accept ${plural(rows.length, 'recommended assignment')}?`}
      footer={
        result ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button loading={bulk.isPending} loadingText="Saving…" onClick={() => void accept()}>
              Accept {rows.length}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3 text-sm" data-testid="bulk-result">
          <p className="flex items-center gap-2">
            <CircleCheck className="size-4 text-success" aria-hidden="true" /> <b>{plural(result.done.length, 'section')}</b> now {result.done.length === 1 ? 'has' : 'have'} a Home Classroom.
          </p>
          {result.alreadyDone.length > 0 && <p className="text-muted">{plural(result.alreadyDone.length, 'section')} already had that room. Nothing changed for them.</p>}
          {result.failed.length > 0 && (
            <section aria-label="Not saved">
              <p className="mb-1 font-bold text-danger">{plural(result.failed.length, 'section')} could not be saved:</p>
              <ul className="list-disc space-y-1 pl-5">
                {result.failed.map((f) => (
                  <li key={f.sectionOfferingId}>
                    <b>{f.label ?? 'A section'}</b>: {f.message}
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-muted">They stay in Needs a look. Pick a room for each one.</p>
            </section>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-sm">
          <p>
            Each of the <b>{plural(rows.length, 'section')}</b> gets the room shown in the Recommended list, from today until the end of the school year.
          </p>
          <p className="text-muted">A section that cannot be saved is skipped and shown to you. The rest are still saved. Running this again is safe.</p>
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}

function SuggestionsTab({ sessionId, locationId, readOnly, openSectionId }: { sessionId: string; locationId: string; readOnly: boolean; openSectionId: string | null }) {
  const q = useRecommendations(sessionId, locationId);
  const [pick, setPick] = useState<PickTarget | null>(null);
  const [accepting, setAccepting] = useState(false);
  const [params, setParams] = useSearchParams();

  // "Assign Room" from Needs Attention lands here with ?section=: open that section's room picker once the list has loaded.
  const fromLink = useMemo<PickTarget | null>(() => {
    if (!openSectionId || !q.data) return null;
    const rec = q.data.recommendations.find((r) => r.section.sectionOfferingId === openSectionId);
    if (rec) return { sectionOfferingId: openSectionId, label: rec.section.label, strength: rec.section.strength, suggestedRoomId: rec.room.spaceId, assignmentId: rec.replacesAssignmentId };
    const un = q.data.unresolved.find((r) => r.section.sectionOfferingId === openSectionId);
    if (un) return { sectionOfferingId: openSectionId, label: un.section.label, strength: un.section.strength, suggestedRoomId: un.closestRoom?.spaceId ?? null };
    return null;
  }, [openSectionId, q.data]);
  const target = pick ?? fromLink;
  const closePick = () => {
    setPick(null);
    if (openSectionId) {
      params.delete('section');
      setParams(params, { replace: true });
    }
  };

  if (q.isLoading) {
    return (
      <div className="space-y-4" role="status" aria-label="Loading">
        <Skeleton className="h-20 rounded-card" />
        <Skeleton className="h-40 rounded-card" />
      </div>
    );
  }
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const set = q.data;

  if (set.summary.sections === 0) {
    return (
      <Card>
        <EmptyState
          illustration={<GraduationCap className="size-14 text-brand" aria-hidden="true" />}
          title="No sections in this school year yet"
          description="Add classes and sections for this campus first. Then come back to give each one a room."
          action={
            <Button asChild variant="outline">
              <Link to="/academics">Go To Academic Setup</Link>
            </Button>
          }
        />
      </Card>
    );
  }
  if (set.summary.eligibleRooms === 0 && set.summary.alreadyAssigned === 0) {
    return (
      <Card>
        <EmptyState
          illustration={<Building2 className="size-14 text-brand" aria-hidden="true" />}
          title="No classrooms at this campus yet"
          description="Add rooms that can be a Home Classroom (with seats for classes). Then we can suggest a room for each section."
          action={
            <Button asChild variant="outline">
              <Link to="/spaces">Go To Space Setup</Link>
            </Button>
          }
        />
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <Summary set={set} />
      {set.recommendations.length > 0 && !readOnly && (
        <Can permission={MANAGE}>
          <div className="flex flex-wrap items-center gap-3">
            <Button size="lg" onClick={() => setAccepting(true)}>
              <Sparkles /> Accept {plural(set.recommendations.length, 'Recommended Assignment')}
            </Button>
            <span className="text-[13px] text-muted">You can change any room later.</span>
          </div>
        </Can>
      )}
      {set.unresolved.length > 0 && <NeedsLook rows={set.unresolved} onPick={setPick} />}
      {set.recommendations.length > 0 && <Recommended rows={set.recommendations} onReview={setPick} />}
      {set.recommendations.length === 0 && set.unresolved.length === 0 && (
        <Alert tone="success" title="All done">
          Every section has a Home Classroom. Open Current Rooms to change one.
        </Alert>
      )}
      {target && !readOnly && <PickRoomDialog target={target} locationId={locationId} sessionId={sessionId} onClose={closePick} />}
      {accepting && <AcceptDialog rows={set.recommendations} onClose={() => setAccepting(false)} />}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── current rooms

function EndDialog({ row, onClose }: { row: HomeClassroomDTO; onClose: () => void }) {
  const end = useEndAssignment();
  const [date, setDate] = useState(() => {
    const t = todayIso();
    return t < row.effectiveFrom ? row.effectiveFrom : t;
  });
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="End this Home Classroom?"
      description={`${row.section.label} · ${row.room.spaceName}`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            loading={end.isPending}
            loadingText="Ending…"
            onClick={async () => {
              setError(null);
              try {
                await end.mutateAsync({ assignmentId: row.assignmentId, effectiveTo: date, ...(reason.trim() ? { reason: reason.trim() } : {}) });
                toast.success(`${row.section.label} leaves ${row.room.spaceName} after ${niceDate(date)}.`);
                onClose();
              } catch (err) {
                setError(messageFor(err));
              }
            }}
          >
            End Assignment
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">The section keeps the room until this day. The record stays in History.</p>
        <TextField label="Last day in this room" type="date" value={date} min={row.effectiveFrom} onChange={(e) => setDate(e.target.value)} required />
        <TextareaField label="Reason" hint="Optional. Example: Room needed for the new lab." value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

function SectionHistory({ sectionOfferingId }: { sectionOfferingId: string }) {
  const q = useAssignments({ sectionOfferingId });
  if (q.isLoading) return <Skeleton className="h-10" />;
  const rows = q.data?.items ?? [];
  return (
    <ol className="space-y-1 text-[13px]" aria-label="History">
      {rows.map((r) => (
        <li key={r.assignmentId} className="flex flex-wrap gap-x-2">
          <b>{r.room.spaceName}</b>
          <span className="text-muted">
            {niceDate(r.effectiveFrom)} – {r.effectiveTo ? niceDate(r.effectiveTo) : 'end of year'}
          </span>
          <Badge tone={r.phase === 'ACTIVE' ? 'success' : 'neutral'}>{PHASE_LABELS[r.phase]}</Badge>
          <span className="text-muted">{SOURCE_LABELS[r.source]}</span>
          {r.reason && <span className="text-muted">· {r.reason}</span>}
          {r.capacityOverride && <span className="text-warning">Kept on purpose: {r.capacityOverride.reason}</span>}
        </li>
      ))}
    </ol>
  );
}

function CurrentTab({ sessionId, locationId, readOnly }: { sessionId: string; locationId: string; readOnly: boolean }) {
  const q = useAssignments({ academicSessionId: sessionId, locationId });
  const [replace, setReplace] = useState<PickTarget | null>(null);
  const [ending, setEnding] = useState<HomeClassroomDTO | null>(null);
  const [history, setHistory] = useState<string | null>(null);
  const { can } = useAuth();
  const rows = useMemo(() => (q.data?.items ?? []).filter(isLiveRow).sort((a, b) => a.section.label.localeCompare(b.section.label, 'en', { numeric: true }) || a.effectiveFrom.localeCompare(b.effectiveFrom)), [q.data]);

  if (q.isLoading) return <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          illustration={<DoorOpen className="size-14 text-brand" aria-hidden="true" />}
          title="No Home Classrooms yet"
          description="Accept the suggested rooms first. They will show here."
          action={
            <Button asChild variant="outline">
              <Link to="?tab=suggestions">Go To Suggestions</Link>
            </Button>
          }
        />
      </Card>
    );
  }
  const manage = can(MANAGE) && !readOnly;
  return (
    <Card className="p-0">
      <CardHeader className="mb-0 flex flex-row flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-3">
        <HelpHeading title={`Section → Room (${rows.length})`} help={SHIFT_HELP} helpLabel="Why can two sections not share a room?" className="text-base font-bold" />
      </CardHeader>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm" aria-label="Current rooms">
          <thead className="border-b border-line bg-canvas text-[12px] font-bold tracking-wide text-muted uppercase max-md:sr-only">
            <tr>
              <th scope="col" className="px-3 py-2">Section</th>
              <th scope="col" className="px-3 py-2">Students</th>
              <th scope="col" className="px-3 py-2">Room</th>
              <th scope="col" className="px-3 py-2">Seats</th>
              <th scope="col" className="px-3 py-2">From</th>
              <th scope="col" className="px-3 py-2">How</th>
              <th scope="col" className="px-3 py-2">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((r) => (
              <tr key={r.assignmentId} className="align-top max-md:flex max-md:flex-wrap max-md:gap-x-3 max-md:px-3 max-md:py-2">
                <td className="px-3 py-2.5 font-semibold max-md:p-0">
                  {r.section.label}
                  {history === r.section.sectionOfferingId && (
                    <div className="mt-2 font-normal">
                      <SectionHistory sectionOfferingId={r.section.sectionOfferingId} />
                    </div>
                  )}
                </td>
                <td className="px-3 py-2.5 tabular-nums max-md:p-0">{r.section.strength}</td>
                <td className="px-3 py-2.5 max-md:p-0">
                  {r.room.spaceName}
                  {r.phase === 'PLANNED' && <Badge className="ml-2">Starts later</Badge>}
                  {r.warnings.map((w) => (
                    <span key={w.code} className="mt-0.5 flex items-center gap-1 text-[13px] text-warning">
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" /> {w.message}
                    </span>
                  ))}
                </td>
                <td className="px-3 py-2.5 tabular-nums max-md:p-0">{r.room.academicCapacity ?? '—'}</td>
                <td className="px-3 py-2.5 text-muted max-md:p-0">{niceDate(r.effectiveFrom)}</td>
                <td className="px-3 py-2.5 text-muted max-md:p-0">{SOURCE_LABELS[r.source]}</td>
                <td className="px-3 py-2.5 max-md:w-full max-md:p-0">
                  <div className="flex flex-wrap justify-end gap-1.5 max-md:justify-start">
                    <Button size="sm" variant="ghost" onClick={() => setHistory(history === r.section.sectionOfferingId ? null : r.section.sectionOfferingId)} aria-expanded={history === r.section.sectionOfferingId} aria-label={`History of ${r.section.label}`}>
                      <History /> History
                    </Button>
                    {manage && (
                      <>
                        <Button size="sm" variant="outline" onClick={() => setReplace({ sectionOfferingId: r.section.sectionOfferingId, label: r.section.label, strength: r.section.strength, assignmentId: r.assignmentId, currentRoom: { spaceId: r.room.spaceId, spaceName: r.room.spaceName } })} aria-label={`Replace room of ${r.section.label}`}>
                          <Repeat /> Replace Room
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEnding(r)} aria-label={`End assignment of ${r.section.label}`}>
                          End Assignment
                        </Button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {replace && <PickRoomDialog target={replace} locationId={locationId} sessionId={sessionId} onClose={() => setReplace(null)} />}
      {ending && <EndDialog row={ending} onClose={() => setEnding(null)} />}
    </Card>
  );
}

// ───────────────────────────────────────────────────────────── page

/** `/spaces/allocation`: a Home Classroom for every section. Opens with suggestions, never with an empty table. */
export function AllocationPage() {
  const ctx = useStudentContext();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'current' ? 'current' : 'suggestions';
  const readOnly = ctx.session?.status === 'CLOSED' || ctx.session?.status === 'ARCHIVED';

  return (
    <>
      <PageHeader eyebrow="Campus" title="Classroom Allocation" description="Give every section its Home Classroom." />
      <TabIntro title="How this works" className="mb-4">
        {ALLOCATION_INTRO}
      </TabIntro>
      {ctx.loading ? (
        <Skeleton className="h-32 rounded-card" role="status" aria-label="Loading" />
      ) : !ctx.sessionId || !ctx.locationId ? (
        <Card>
          <EmptyState
            illustration={<GraduationCap className="size-14 text-brand" aria-hidden="true" />}
            title="No school year yet"
            description="Set up a school year in Academic Setup first."
            action={
              <Button asChild variant="outline">
                <Link to="/academics">Go To Academic Setup</Link>
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="space-y-4">
          <RolloverBanner />
          {readOnly && <Alert tone="info">{ctx.session?.code} is closed, so its rooms can only be looked at.</Alert>}
          <Tabs
            value={tab}
            onValueChange={(v) => {
              const next = new URLSearchParams(params);
              next.set('tab', v);
              next.delete('section');
              setParams(next, { replace: true });
            }}
          >
            <TabsList>
              <TabsTrigger value="suggestions">Suggestions</TabsTrigger>
              <TabsTrigger value="current">Current Rooms</TabsTrigger>
            </TabsList>
            <TabsContent value="suggestions" className="mt-4">
              <SuggestionsTab sessionId={ctx.sessionId} locationId={ctx.locationId} readOnly={readOnly} openSectionId={params.get('section')} />
            </TabsContent>
            <TabsContent value="current" className="mt-4">
              <CurrentTab sessionId={ctx.sessionId} locationId={ctx.locationId} readOnly={readOnly} />
            </TabsContent>
          </Tabs>
        </div>
      )}
    </>
  );
}
