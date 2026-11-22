import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router';
import { SPACE_STATUS_LABELS, type SpaceTreeDTO } from '@shared';
import { Building2, Copy, DoorOpen, Download, FileUp, Hammer, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Combobox } from '@/components/ui/combobox';
import { Drawer, DrawerBody, DrawerContent } from '@/components/ui/drawer';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { PageHeader } from '@/components/sv/page-header';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { useAuth } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { InfoTip } from '@/components/ui/tooltip';
import { useSpaceAttention } from './allocation-api';
import { useStudentContext } from '../students/context';
import { exportUrl, useSpaces, useSpaceTree, useSpaceTypes, type SpaceListParams } from './api';
import { BulkBar } from './bulk-bar';
import { BuildPanel, type BuildTab } from './build-panel';
import { CopyStructureDialog } from './copy-dialog';
import { ROOMS_READONLY_INTRO, WORKSPACE_INTRO } from './help-copy';
import { Inspector } from './inspector';
import { RoomTable } from './room-table';
import { SpaceTree, type Selection } from './space-tree';
import { StructureHeader } from './structure-header';
import { useMediaQuery } from './use-media-query';

const PAGE_SIZE = 50;
const LIVE = 'DRAFT,ACTIVE,TEMPORARILY_UNAVAILABLE,RESTRICTED,INACTIVE';

/** Campus totals. Admins also see how much of the work the system did (rooms accepted from suggestions) and how complete setup is. */
function Kpis({ tree, sessionId }: { tree: SpaceTreeDTO; sessionId: string | undefined }) {
  const { can } = useAuth();
  const attention = useSpaceAttention(tree.locationId, sessionId, can('space:edit'));
  const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`);
  const items: [string, string | number, ReactNode?][] = [
    ['Buildings', tree.totals.buildings],
    ['Floors', tree.totals.floors],
    ['Rooms', tree.totals.rooms],
    ['Can be timetabled', tree.totals.schedulableRooms],
  ];
  if (attention.data) {
    items.push(['Recommended automatically', pct(attention.data.kpis.recommendedAutomaticallyPercent), 'Home Classrooms that came from our suggestions this school year.']);
    items.push(['Setup completeness', pct(attention.data.kpis.setupCompletenessPercent), 'Rooms that have everything they need, such as seats for classes.']);
  }
  return (
    <dl className={cn('mb-4 grid grid-cols-2 gap-3', items.length > 4 ? 'sm:grid-cols-3 xl:grid-cols-6' : 'sm:grid-cols-4')} aria-label="Campus totals">
      {items.map(([label, n, help]) => (
        <div key={label} className="rounded-xl border border-line bg-white px-4 py-2.5">
          <dt className="flex items-center gap-1 text-xs font-semibold text-muted">
            {label}
            {help && <InfoTip label={`About ${label.toLowerCase()}`}>{help}</InfoTip>}
          </dt>
          <dd className="text-xl font-extrabold tabular-nums">{n}</dd>
        </div>
      ))}
    </dl>
  );
}

/** First visit: a campus with no buildings. Three clear ways to start. */
function StartCards({ onBuild, onCopy }: { onBuild: () => void; onCopy: () => void }) {
  return (
    <Card>
      <EmptyState
        illustration={<Building2 className="size-14 text-brand" aria-hidden="true" />}
        title="Let’s set up your campus"
        description="There are no rooms here yet. Pick the way that suits you."
        className="max-w-none pb-4"
      />
      <div className="mx-auto grid max-w-4xl gap-3 pb-4 sm:grid-cols-3">
        <button type="button" onClick={onBuild} className="rounded-xl border-2 border-brand bg-brand-soft/50 p-4 text-left outline-none hover:bg-brand-soft focus-visible:ring-4 focus-visible:ring-brand/25">
          <Hammer className="mb-2 size-6 text-brand" aria-hidden="true" />
          <span className="block text-sm font-bold">Build Campus Structure</span>
          <span className="mt-0.5 block text-[13px] text-muted">Add a building, its floors and rooms in a few steps. Best for most schools.</span>
          <span className="mt-2 inline-block rounded-pill bg-brand px-2 py-0.5 text-[11px] font-bold text-white">Recommended</span>
        </button>
        <Link to="/spaces/imports" className="rounded-xl border border-line p-4 outline-none hover:border-brand/50 focus-visible:ring-4 focus-visible:ring-brand/25">
          <FileUp className="mb-2 size-6 text-brand" aria-hidden="true" />
          <span className="block text-sm font-bold">Import Spreadsheet</span>
          <span className="mt-0.5 block text-[13px] text-muted">Already have a list of rooms in a CSV file? Upload it.</span>
        </Link>
        <button type="button" onClick={onCopy} className="rounded-xl border border-line p-4 text-left outline-none hover:border-brand/50 focus-visible:ring-4 focus-visible:ring-brand/25">
          <Copy className="mb-2 size-6 text-brand" aria-hidden="true" />
          <span className="block text-sm font-bold">Copy From Another Location</span>
          <span className="mt-0.5 block text-[13px] text-muted">Your other campus has the same layout? Copy it.</span>
        </button>
      </div>
    </Card>
  );
}

/**
 * `/spaces`: one workspace. The campus tree is on the left, the rooms of the selected building or floor in the middle, and a room
 * opens in a panel on the right: no separate edit page. Faculty get the same screen with no controls.
 */
export function WorkspacePage() {
  const ctx = useStudentContext();
  const { can } = useAuth();
  const canEdit = can('space:edit');
  const canCreate = can('space:create');
  const [params, setParams] = useSearchParams();
  const roomId = params.get('room');
  const wide = useMediaQuery('(min-width: 1280px)');

  const treeQ = useSpaceTree(ctx.locationId);
  const types = useSpaceTypes();
  const [selection, setSelection] = useState<Selection>({ kind: 'all' });
  const [search, setSearch] = useState('');
  const [typeId, setTypeId] = useState('');
  const [status, setStatus] = useState('');
  const [timetabled, setTimetabled] = useState('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [build, setBuild] = useState<{ tab: BuildTab } | null>(null);
  const [copying, setCopying] = useState(false);
  const debounced = useDebouncedValue(search.trim(), 300);

  const listParams: SpaceListParams = {
    locationId: ctx.locationId,
    ...(selection.kind === 'building' || selection.kind === 'floor' ? { buildingId: selection.buildingId } : {}),
    ...(selection.kind === 'floor' ? { floorId: selection.floorId } : {}),
    ...(selection.kind === 'outdoor' ? { outdoor: true } : {}),
    q: debounced || undefined,
    spaceTypeId: typeId || undefined,
    status: status === 'ARCHIVED' ? 'ARCHIVED' : status || LIVE,
    schedulable: timetabled === '' ? undefined : timetabled === 'yes',
    missingCapacity: timetabled === 'missing' ? true : undefined,
    page,
    pageSize: PAGE_SIZE,
  };
  if (timetabled === 'missing') delete listParams.schedulable;
  const listQ = useSpaces(listParams, Boolean(ctx.locationId));
  const filterKey = JSON.stringify({ ...listParams, page: 0 });
  useEffect(() => {
    setPage(1);
    setSelected(new Set());
  }, [filterKey]);
  useEffect(() => setSelected(new Set()), [page]);

  // A different campus starts at the top of the tree again.
  useEffect(() => setSelection({ kind: 'all' }), [ctx.locationId]);

  const openRoom = (id: string | null) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (id) next.set('room', id);
        else next.delete('room');
        return next;
      },
      { replace: true },
    );

  const tree = treeQ.data;
  const rooms = useMemo(() => listQ.data?.items ?? [], [listQ.data]);
  const total = listQ.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const isEmptyCampus = !!tree && tree.buildings.length === 0 && tree.totals.rooms === 0 && tree.outdoorCount === 0;
  const filtered = Boolean(debounced || typeId || status || timetabled);
  const inspector = roomId ? <Inspector spaceId={roomId} onClose={() => openRoom(null)} /> : null;

  const typeOptions = [{ value: '', label: 'All types' }, ...(types.data ?? []).map((t) => ({ value: t.spaceTypeId, label: t.name }))];
  const statusOptions = [{ value: '', label: 'All except archived' }, ...(['ACTIVE', 'DRAFT', 'TEMPORARILY_UNAVAILABLE', 'RESTRICTED', 'INACTIVE', 'ARCHIVED'] as const).map((s) => ({ value: s, label: SPACE_STATUS_LABELS[s] }))];
  const timetableOptions = [
    { value: '', label: 'All rooms' },
    { value: 'yes', label: 'Can be timetabled' },
    { value: 'no', label: 'Cannot be timetabled' },
    { value: 'missing', label: 'Seats not set' },
  ];

  return (
    <>
      <PageHeader
        eyebrow="Campus"
        title={canEdit ? 'Space Setup' : 'Rooms'}
        description={canEdit ? 'Your campus: buildings, floors and rooms.' : 'The rooms you can use at your campus.'}
        actions={
          canCreate ? (
            <>
              <Button onClick={() => setBuild({ tab: 'building' })}>
                <Hammer /> Build Campus Structure
              </Button>
              {can('space:export') && (
                <Button asChild variant="outline">
                  <a href={exportUrl({ ...listParams })} download>
                    <Download /> Export Rooms
                  </a>
                </Button>
              )}
            </>
          ) : undefined
        }
      />
      <TabIntro title={canEdit ? 'About Space Setup' : 'About rooms'} className="mb-4">
        {canEdit ? WORKSPACE_INTRO : ROOMS_READONLY_INTRO}
      </TabIntro>

      {ctx.loading || treeQ.isLoading ? (
        <div className="space-y-3" role="status" aria-label="Loading">
          <Skeleton className="h-16 rounded-card" />
          <Skeleton className="h-72 rounded-card" />
        </div>
      ) : !ctx.locationId ? null : treeQ.isError || !tree ? (
        <ErrorState error={treeQ.error} onRetry={() => void treeQ.refetch()} retrying={treeQ.isFetching} />
      ) : isEmptyCampus ? (
        canCreate ? (
          <StartCards onBuild={() => setBuild({ tab: 'building' })} onCopy={() => setCopying(true)} />
        ) : (
          <Card>
            <EmptyState illustration={<DoorOpen className="size-14 text-muted" aria-hidden="true" />} title="No rooms yet" description="The school office has not added rooms for this campus yet." />
          </Card>
        )
      ) : (
        <>
          <Kpis tree={tree} sessionId={ctx.sessionId} />
          <div className={wide && inspector ? 'grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)_380px]' : 'grid gap-4 lg:grid-cols-[250px_minmax(0,1fr)]'}>
            <Card className="h-fit p-3 sm:p-3">
              <SpaceTree
                tree={tree}
                selection={selection}
                onSelect={(s) => {
                  setSelection(s);
                }}
              />
            </Card>

            <div className="min-w-0 space-y-3">
              {(selection.kind === 'building' || selection.kind === 'floor') && (
                <Card className="p-3 sm:p-3">
                  <StructureHeader selection={selection} tree={tree} locationId={ctx.locationId} canEdit={canEdit} onAddRooms={() => setBuild({ tab: 'rooms' })} />
                </Card>
              )}
              <Card className="p-0">
                <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
                  <div className="relative min-w-[180px] flex-1">
                    <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                    <input
                      type="search"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Search by room, code or section…"
                      aria-label="Search rooms"
                      className="h-9 w-full rounded-lg border border-control bg-white pr-2 pl-8 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
                    />
                  </div>
                  <Combobox aria-label="Room type" className="h-9 w-44" value={typeId} onChange={setTypeId} options={typeOptions} searchPlaceholder="Search types…" />
                  <Combobox aria-label="Room status" className="h-9 w-48" value={status} onChange={setStatus} options={statusOptions} searchPlaceholder="Search…" />
                  <Combobox aria-label="Timetable filter" className="h-9 w-48" value={timetabled} onChange={setTimetabled} options={timetableOptions} searchPlaceholder="Search…" />
                </div>
                {canEdit && selected.size > 0 && (
                  <div className="border-b border-line p-3">
                    <BulkBar ids={[...selected]} onClear={() => setSelected(new Set())} />
                  </div>
                )}
                {listQ.isLoading ? (
                  <Skeleton className="m-4 h-40" role="status" aria-label="Loading rooms" />
                ) : listQ.isError ? (
                  <ErrorState error={listQ.error} onRetry={() => void listQ.refetch()} retrying={listQ.isFetching} />
                ) : rooms.length === 0 ? (
                  <EmptyState
                    illustration={<DoorOpen className="size-12 text-muted" aria-hidden="true" />}
                    title={filtered ? 'No room matches' : 'No rooms here yet'}
                    description={filtered ? 'Try a different search or clear the filters.' : canCreate ? 'Add rooms with the Room Generator.' : 'No rooms are listed here.'}
                    action={
                      filtered ? (
                        <Button
                          variant="outline"
                          onClick={() => {
                            setSearch('');
                            setTypeId('');
                            setStatus('');
                            setTimetabled('');
                          }}
                        >
                          Clear Filters
                        </Button>
                      ) : canCreate ? (
                        <Button onClick={() => setBuild({ tab: 'rooms' })}>
                          <Hammer /> Add Rooms
                        </Button>
                      ) : undefined
                    }
                  />
                ) : (
                  <RoomTable
                    rooms={rooms}
                    selected={selected}
                    selectable={can('space:bulk_manage')}
                    showWhere={selection.kind === 'all' || selection.kind === 'outdoor'}
                    openId={roomId}
                    onOpen={openRoom}
                    onToggle={(id) =>
                      setSelected((s) => {
                        const next = new Set(s);
                        if (next.has(id)) next.delete(id);
                        else next.add(id);
                        return next;
                      })
                    }
                    onToggleAll={(checked) => setSelected(checked ? new Set(rooms.map((r) => r.spaceId)) : new Set())}
                  />
                )}
                {pages > 1 && (
                  <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-2">
                    <p className="text-sm text-muted">{total} rooms</p>
                    <div className="flex items-center gap-2">
                      <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                        Previous
                      </Button>
                      <span className="text-sm text-muted">
                        Page {page} of {pages}
                      </span>
                      <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </Card>
            </div>

            {wide && inspector && <Card className="h-fit lg:sticky lg:top-4">{inspector}</Card>}
          </div>
        </>
      )}

      {!wide && roomId && (
        <Drawer open onOpenChange={(o) => !o && openRoom(null)}>
          <DrawerContent title="Room details" description="Changes to names, seats and features save as you go.">
            <DrawerBody>{inspector}</DrawerBody>
          </DrawerContent>
        </Drawer>
      )}

      {build && tree && ctx.locationId && (
        <BuildPanel
          open
          tree={tree}
          locationId={ctx.locationId}
          initialTab={build.tab}
          onClose={() => setBuild(null)}
          onDone={(s) => {
            setSelection(s);
            setBuild(null);
          }}
        />
      )}
      {copying && ctx.locationId && <CopyStructureDialog locationId={ctx.locationId} locationName={ctx.location?.displayName ?? 'this campus'} onClose={() => setCopying(false)} />}
    </>
  );
}
