import { useMemo, useState } from 'react';
import type { SpaceTreeDTO } from '@shared';
import { Building2, ChevronDown, ChevronRight, Layers, MapPin, Search, Trees } from 'lucide-react';
import { cn } from '@/lib/utils';
import { StatusDot } from './space-bits';

/** What the middle of the workspace is showing. */
export type Selection = { kind: 'all' } | { kind: 'building'; buildingId: string } | { kind: 'floor'; buildingId: string; floorId: string } | { kind: 'outdoor' };

export const sameSelection = (a: Selection, b: Selection) =>
  a.kind === b.kind && (a.kind === 'building' || a.kind === 'floor' ? a.buildingId === (b as typeof a).buildingId : true) && (a.kind === 'floor' ? a.floorId === (b as typeof a).floorId : true);

function Row({ active, depth, onClick, children, label }: { active: boolean; depth: number; onClick: () => void; children: React.ReactNode; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      aria-label={label}
      style={{ paddingLeft: 8 + depth * 14 }}
      className={cn('flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-sm outline-none hover:bg-ink/5 focus-visible:ring-2 focus-visible:ring-brand/40', active && 'bg-brand-soft font-semibold text-brand')}
    >
      {children}
    </button>
  );
}

/** Location → Building → Floor, with a status dot and the number of rooms beside each. Click one to see its rooms. */
export function SpaceTree({ tree, selection, onSelect }: { tree: SpaceTreeDTO; selection: Selection; onSelect: (s: Selection) => void }) {
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const toggle = (id: string) => setOpen((o) => ({ ...o, [id]: !(o[id] ?? true) }));

  const buildings = useMemo(
    () =>
      tree.buildings
        .map((b) => ({ ...b, floors: q && !b.buildingName.toLowerCase().includes(q) ? b.floors.filter((f) => f.floorName.toLowerCase().includes(q)) : b.floors }))
        .filter((b) => !q || b.buildingName.toLowerCase().includes(q) || b.floors.length > 0),
    [tree.buildings, q],
  );

  return (
    <nav aria-label="Campus structure" className="space-y-2">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search buildings…"
          aria-label="Search buildings and floors"
          className="h-9 w-full rounded-lg border border-control bg-white pr-2 pl-8 text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20"
        />
      </div>
      <Row active={selection.kind === 'all'} depth={0} onClick={() => onSelect({ kind: 'all' })} label={`${tree.locationName}, ${tree.totals.rooms} rooms`}>
        <MapPin className="size-4 shrink-0 text-brand" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">{tree.locationName}</span>
        <span className="text-xs text-muted">{tree.totals.rooms}</span>
      </Row>
      <ul className="space-y-0.5">
        {buildings.map((b) => {
          const expanded = q ? true : (open[b.buildingId] ?? true);
          return (
            <li key={b.buildingId}>
              <div className="flex items-center">
                <button type="button" onClick={() => toggle(b.buildingId)} aria-label={`${expanded ? 'Collapse' : 'Expand'} ${b.buildingName}`} aria-expanded={expanded} className="ml-1 grid size-6 shrink-0 place-items-center rounded text-muted hover:bg-ink/5">
                  {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                </button>
                <div className="min-w-0 flex-1">
                  <Row active={selection.kind === 'building' && selection.buildingId === b.buildingId} depth={0} onClick={() => onSelect({ kind: 'building', buildingId: b.buildingId })} label={`${b.buildingName}, ${b.roomCount} rooms`}>
                    <StatusDot status={b.status} />
                    <Building2 className="size-4 shrink-0 text-muted" aria-hidden="true" />
                    <span className="min-w-0 flex-1 truncate">{b.buildingName}</span>
                    <span className="text-xs text-muted">{b.roomCount}</span>
                  </Row>
                </div>
              </div>
              {expanded && (
                <ul className="space-y-0.5">
                  {b.floors.map((f) => (
                    <li key={f.floorId}>
                      <Row active={selection.kind === 'floor' && selection.floorId === f.floorId} depth={2} onClick={() => onSelect({ kind: 'floor', buildingId: b.buildingId, floorId: f.floorId })} label={`${f.floorName}, ${f.roomCount} rooms`}>
                        <StatusDot status={f.status} unavailable={!!f.unavailableBecause} />
                        <Layers className="size-4 shrink-0 text-muted" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate">{f.floorName}</span>
                        <span className="text-xs text-muted">{f.roomCount}</span>
                      </Row>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
        {tree.outdoorCount > 0 && !q && (
          <li>
            <Row active={selection.kind === 'outdoor'} depth={0} onClick={() => onSelect({ kind: 'outdoor' })} label={`Outdoor spaces, ${tree.outdoorCount}`}>
              <Trees className="size-4 shrink-0 text-muted" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate">Outdoor spaces</span>
              <span className="text-xs text-muted">{tree.outdoorCount}</span>
            </Row>
          </li>
        )}
      </ul>
      {q && buildings.length === 0 && <p className="px-2 text-sm text-muted">No building or floor matches.</p>}
    </nav>
  );
}
