import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ListChecks, MoreHorizontal, Undo2 } from 'lucide-react';
import type { CheckResultDTO, GridCellDTO, GridPeriodDTO, GridView, TimetablePlanDTO, TimetableVersionDTO, Weekday } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { PageHeader } from '@/components/sv/page-header';
import { ErrorState } from '@/components/sv/error-state';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { useCampusRooms } from '../../spaces/api';
import { useStudentContext } from '../../students/context';
import { TT, useBellResolution, useGroups, usePlanTeachers, useTimetableMutation } from '../api';
import { ops } from '../ops/api';
import { CreatePlanCard, useTimetablePlan } from '../context';
import { TIPS } from '../help-copy';
import { AddLesson, type AddTarget } from './add-lesson';
import { useLessonActions } from './actions';
import { calls, useAttention, useGrid, useVersion, useVersions } from './api';
import { SectionActions, SelectionBar, type SectionAction } from './bulk';
import { SwapConfirm } from './dialogs';
import { EditorProvider, SaveIndicator, useEditor } from './editor';
import { ScheduleGrid, slotKey, type SlotColours } from './grid';
import { Inspector } from './inspector';
import { SmartRail } from './rail';
import { RunResultCard, SmartDraftAgain, type RunResult } from './runs';
import { StartPage } from './start';

const VIEWS: { id: GridView; label: string }[] = [
  { id: 'section', label: 'Section' },
  { id: 'teacher', label: 'Teacher' },
  { id: 'room', label: 'Room' },
  { id: 'group', label: 'Group' },
];

const isOpen = (v: TimetableVersionDTO) => v.status === 'DRAFT' || v.status === 'READY';

/** `/timetable/schedule`. No draft yet: the Start page. Otherwise the workspace. */
export function SchedulePage() {
  const { plan, loading } = useTimetablePlan();
  const versions = useVersions(plan?.planId);
  const [result, setResult] = useState<RunResult | null>(null);
  const open = versions.data?.find(isOpen);
  // With no draft, the published timetable is shown read-only, with a way to make a revision.
  const published = versions.data?.find((v) => v.phase === 'ACTIVE') ?? versions.data?.find((v) => v.phase === 'UPCOMING');

  return (
    <>
      <PageHeader eyebrow="Timetable" title="Schedule" description="Build the weekly timetable. Every change is checked for clashes before it is saved." />
      {(loading || versions.isLoading) && <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />}
      {versions.isError && <ErrorState error={versions.error} onRetry={() => void versions.refetch()} />}
      {!loading && !plan && <CreatePlanCard />}
      {plan && versions.data && !open && !published && <StartPage plan={plan} onResult={setResult} />}
      {plan && !open && published && (
        <EditorProvider versionId={published.versionId}>
          <PublishedBanner version={published} />
          <Workspace plan={plan} version={published} result={result} onResult={setResult} />
        </EditorProvider>
      )}
      {plan && open && (
        <EditorProvider versionId={open.versionId}>
          <Workspace plan={plan} version={open} result={result} onResult={setResult} />
        </EditorProvider>
      )}
    </>
  );
}

/** "This timetable is published. To change it, create a revision." */
function PublishedBanner({ version }: { version: TimetableVersionDTO }) {
  const { can } = useAuth();
  const navigate = useNavigate();
  const revise = useTimetableMutation(() => ops.clone(version.versionId), { success: 'Revision made. You can change it now.' });
  return (
    <Alert tone="info" title="This timetable is published" className="mb-3">
      <span className="flex flex-wrap items-center gap-3">
        <span>To change it, create a revision. Nothing changes for anyone until you publish the revision.</span>
        {can('timetable:draft:create') && (
          <Button size="sm" loading={revise.isPending} loadingText="Making a copy…" onClick={() => revise.mutate(undefined, { onSuccess: () => navigate('/timetable/schedule') })}>
            Create Revision
          </Button>
        )}
      </span>
    </Alert>
  );
}

/** `/timetable/start`: the same Start page. If a draft already exists it goes to the schedule. */
export function StartRoute() {
  const { plan, loading } = useTimetablePlan();
  const versions = useVersions(plan?.planId);
  const [result, setResult] = useState<RunResult | null>(null);
  if (versions.data?.some(isOpen)) return <Navigate to="/timetable/schedule" replace />;
  return (
    <>
      <PageHeader eyebrow="Timetable" title="Start" description="Choose how to fill the timetable." />
      {(loading || versions.isLoading) && <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />}
      {!loading && !plan && <CreatePlanCard />}
      {plan && versions.data && <StartPage plan={plan} onResult={setResult} />}
      {result && <RunResultCard result={result} onDismiss={() => setResult(null)} />}
    </>
  );
}

function Workspace({ plan, version, result, onResult }: { plan: TimetablePlanDTO; version: TimetableVersionDTO; result: RunResult | null; onResult: (r: RunResult | null) => void }) {
  const { can } = useAuth();
  const ctx = useStudentContext();
  const qc = useQueryClient();
  const editor = useEditor();
  const actions = useLessonActions();
  const [params, setParams] = useSearchParams();
  const view = (VIEWS.some((v) => v.id === params.get('view')) ? params.get('view') : 'section') as GridView;
  const resolution = useBellResolution(plan.planId);
  const teachers = usePlanTeachers(plan.planId);
  const groups = useGroups(plan.planId);
  const rooms = useCampusRooms(plan.locationId, view === 'room');
  const sections = useMemo(() => resolution.data?.rows ?? [], [resolution.data]);

  const options = useMemo(() => {
    if (view === 'teacher') return (teachers.data ?? []).map((t) => ({ value: t.employeeId, label: t.fullName, hint: t.employeeCode }));
    if (view === 'room') return (rooms.data?.items ?? []).map((r) => ({ value: r.spaceId, label: r.spaceName, hint: undefined as string | undefined }));
    if (view === 'group') return (groups.data ?? []).map((g) => ({ value: g.groupId, label: g.name, hint: g.subjectName ?? undefined }));
    return sections.map((s) => ({ value: s.sectionOfferingId, label: s.label, hint: s.className }));
  }, [view, teachers.data, rooms.data, groups.data, sections]);
  const id = params.get('id') && options.some((o) => o.value === params.get('id')) ? (params.get('id') as string) : options[0]?.value;

  const grid = useGrid(version.versionId, view, id);
  const live = useVersion(version.versionId);
  const attention = useAttention(version.versionId);
  const lastRev = useRef<number | null>(null);
  useEffect(() => {
    const rev = live.data?.rev;
    if (rev === undefined) return;
    if (lastRev.current !== null && lastRev.current !== rev) void qc.invalidateQueries({ queryKey: [...TT] });
    lastRev.current = rev;
  }, [live.data?.rev, qc]);

  const set = (patch: Record<string, string | null>) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null) next.delete(k);
        else next.set(k, v);
      }
      return next;
    });

  const [selectedId, setSelectedId] = useState<string | null>(params.get('entry'));
  const [multi, setMulti] = useState<Set<string>>(new Set());
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [colours, setColours] = useState<SlotColours | null>(null);
  const [adding, setAdding] = useState<AddTarget | null>(null);
  const [swap, setSwap] = useState<{ a: GridCellDTO; b: GridCellDTO; check: CheckResultDTO } | null>(null);
  const [section, setSection] = useState<SectionAction>(null);
  const [again, setAgain] = useState(false);

  const g = grid.data;
  const selected = g?.cells.find((c) => c.entryId === selectedId) ?? null;
  const picked = g ? g.cells.filter((c) => multi.has(c.entryId)) : [];
  const editable = !!g && (g.status === 'DRAFT' || g.status === 'READY') && can('timetable:entry:edit');
  const section0 = sections.find((s) => s.sectionOfferingId === id);
  const classId = view === 'section' ? section0?.classOfferingId : undefined;
  const classes = useMemo(() => [...new Map(sections.map((s) => [s.classOfferingId, s.className])).entries()].map(([value, label]) => ({ value, label })), [sections]);

  const onSelect = (cell: GridCellDTO, { shift }: { shift: boolean }) => {
    if (shift) {
      setMulti((m) => {
        const next = new Set(m);
        if (next.size === 0 && selectedId) next.add(selectedId);
        if (next.has(cell.entryId)) next.delete(cell.entryId);
        else next.add(cell.entryId);
        return next;
      });
      setSelectedId(null);
    } else {
      setMulti(new Set());
      setSelectedId(cell.entryId);
    }
  };

  const onDragStart = (cell: GridCellDTO) => {
    setDraggingId(cell.entryId);
    setColours(null);
    void calls
      .slotMap(version.versionId, cell.entryId)
      .then((map) => setColours(new Map(map.days.flatMap((d) => d.slots.map((s) => [slotKey(d.weekday, s.periodId), { status: s.status, reason: s.reason }] as const)))))
      .catch(() => setColours(null));
  };
  const onDragEnd = () => {
    setDraggingId(null);
    setColours(null);
  };

  const onDrop = async (cell: GridCellDTO, weekday: Weekday, period: GridPeriodDTO, occupant: GridCellDTO | undefined) => {
    onDragEnd();
    if (occupant) {
      const check = await calls.check(version.versionId, [
        { op: 'move', entryId: cell.entryId, weekday, periodId: period.periodId },
        { op: 'move', entryId: occupant.entryId, weekday: cell.weekday, periodId: cell.periodId },
      ]);
      if (check.ok) setSwap({ a: cell, b: occupant, check });
      else editor.showClash({ title: 'Swap', message: check.summary, blockers: check.blockers, alternatives: [] });
      return;
    }
    if (colours?.get(slotKey(weekday, period.periodId))?.status === 'BLOCKED') {
      const check = await calls.check(version.versionId, [{ op: 'move', entryId: cell.entryId, weekday, periodId: period.periodId }]);
      editor.showClash({ title: 'Move', message: check.summary, blockers: check.blockers, alternatives: check.alternatives, apply: actions.applyAlternative(cell) });
      return;
    }
    await actions.move(cell, weekday, period.periodId);
  };

  return (
    <div className="space-y-3">
      {result && <RunResultCard result={result} onDismiss={() => onResult(null)} />}
      <p className="text-sm font-semibold text-muted" data-testid="context-line">
        {[ctx.session?.code || ctx.session?.name, ctx.location?.displayName, ...(view === 'section' && section0 ? [section0.className, section0.label] : [])].filter(Boolean).join(' · ')}
      </p>

      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="View" className="flex rounded-control border border-line bg-white p-0.5">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" role="tab" aria-selected={view === v.id} onClick={() => set({ view: v.id, id: null, entry: null })} className={cn('rounded-lg px-3 py-1.5 text-sm font-semibold', view === v.id ? 'bg-brand text-white' : 'text-muted hover:text-ink')}>
              {v.label}
            </button>
          ))}
        </div>
        {view === 'section' && classes.length > 0 && (
          <Combobox
            aria-label="Class"
            className="h-9 w-40"
            value={classId ?? ''}
            onChange={(c) => set({ id: sections.find((s) => s.classOfferingId === c)?.sectionOfferingId ?? null, entry: null })}
            options={classes}
            searchPlaceholder="Search classes…"
          />
        )}
        <Combobox
          aria-label={view === 'section' ? 'Section' : VIEWS.find((v) => v.id === view)!.label}
          className="h-9 w-48"
          value={id ?? ''}
          onChange={(v) => set({ id: v, entry: null })}
          options={view === 'section' ? options.filter((o) => sections.find((s) => s.sectionOfferingId === o.value)?.classOfferingId === classId) : options}
          searchPlaceholder="Search…"
          placeholder={options.length === 0 ? 'Nothing to show' : 'Choose'}
        />
        <span className="ml-auto flex items-center gap-2">
          <SaveIndicator />
          <Button variant="outline" size="sm" disabled={!editor.canUndo} onClick={() => void editor.undoLast()}>
            <Undo2 /> Undo Last Change
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to="/timetable/attention">
              <ListChecks /> Needs Attention{attention.data ? ` (${attention.data.total})` : ''}
            </Link>
          </Button>
          {editable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" aria-label="More actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {can('timetable:smart_draft:run') && <DropdownMenuItem onSelect={() => setAgain(true)}>Run Smart Draft Again</DropdownMenuItem>}
                {view === 'section' && (
                  <>
                    <DropdownMenuItem onSelect={() => setSection('fixed-period')}>Add Fixed Period</DropdownMenuItem>
                    {can('timetable:bulk:manage') && (
                      <>
                        <DropdownMenuItem onSelect={() => setSection('copy-section')}>Copy This Section To…</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setSection('copy-day')}>Copy A Day To…</DropdownMenuItem>
                        <DropdownMenuItem onSelect={() => setSection('clear-section')}>Clear Section</DropdownMenuItem>
                      </>
                    )}
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </span>
      </div>

      {grid.isError && <ErrorState error={grid.error} onRetry={() => void grid.refetch()} />}
      {!g && !grid.isError && <Skeleton className="h-96 rounded-card" role="status" aria-label="Loading the week" />}
      {!id && options.length === 0 && <p className="rounded-xl border border-line bg-white p-4 text-sm text-muted">{view === 'group' ? 'No Teaching Groups yet. Make one in Timetable Setup.' : view === 'room' ? 'No rooms at this campus yet.' : 'Nothing to show yet.'}</p>}

      {g && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0 space-y-3">
            {g.coverage && (
              <p className="flex items-center gap-2 text-sm font-semibold" data-testid="coverage-line">
                {g.coverage.line}
                <InfoTip label="About fixed periods">{TIPS.fixedPeriod}</InfoTip>
              </p>
            )}
            {g.workload && (
              <p className="text-sm font-semibold" data-testid="workload-line">
                {g.workload.week} periods this week · longest run {g.workload.longestRun}
              </p>
            )}
            {picked.length > 0 && <SelectionBar cells={picked} grid={g} onClear={() => setMulti(new Set())} />}
            <ScheduleGrid
              grid={g}
              editable={editable && (view === 'section' || view === 'group' || view === 'teacher' || view === 'room')}
              selectedId={selected?.entryId ?? null}
              multi={multi}
              draggingId={draggingId}
              colours={colours}
              onSelect={onSelect}
              onAdd={editable && (view === 'section' || view === 'group') && can('timetable:entry:create') ? (weekday, period) => setAdding({ weekday, period }) : undefined}
              onDragStart={onDragStart}
              onDragEnd={onDragEnd}
              onDrop={(c, d, p, o) => void onDrop(c, d, p, o)}
            />
          </div>
          <aside className="space-y-3">
            {selected && <Inspector cell={selected} grid={g} onClose={() => setSelectedId(null)} focus={params.get('focus') as 'teacher' | 'room' | 'move' | null} />}
            <SmartRail grid={g} attention={attention.data} sectionId={view === 'section' ? id : undefined} canEdit={editable && can('timetable:entry:create')} />
          </aside>
        </div>
      )}

      {g && <AddLesson target={adding} grid={g} sectionId={view === 'section' ? id : undefined} classOfferingId={classId} sections={sections} onClose={() => setAdding(null)} />}
      {swap && <SwapConfirm open a={swap.a} b={swap.b} check={swap.check} onClose={() => setSwap(null)} />}
      {g && id && view === 'section' && <SectionActions action={section} onClose={() => setSection(null)} grid={g} sectionId={id} classOfferingId={classId} sections={sections} />}
      <SmartDraftAgain open={again} onClose={() => setAgain(false)} lessons={live.data?.entryCount ?? version.entryCount} onResult={(run) => onResult({ kind: 'draft', run })} />
    </div>
  );
}
