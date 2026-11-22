import type { SpaceDTO } from '@shared';
import { TriangleAlert } from 'lucide-react';
import { cn } from '@/lib/utils';
import { seatsText, SpaceStatusPill, whereOf } from './space-bits';

/**
 * The rooms of the selected building or floor. With a checkbox on each row for the multi-select bar (admins only). Under 768px the
 * rows turn into small cards, so nothing needs sideways scrolling.
 */
export function RoomTable({
  rooms,
  selected,
  onToggle,
  onToggleAll,
  openId,
  onOpen,
  selectable,
  showWhere,
}: {
  rooms: SpaceDTO[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: (checked: boolean) => void;
  openId: string | null;
  onOpen: (id: string) => void;
  selectable: boolean;
  showWhere: boolean;
}) {
  const allChecked = rooms.length > 0 && rooms.every((r) => selected.has(r.spaceId));
  return (
    <table className="w-full text-left text-sm" aria-label="Rooms">
      <thead className="border-b border-line bg-canvas text-[12px] font-bold tracking-wide text-muted uppercase max-md:sr-only">
        <tr>
          {selectable && (
            <th scope="col" className="w-10 px-3 py-2">
              <input type="checkbox" aria-label="Select all rooms on this page" checked={allChecked} onChange={(e) => onToggleAll(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
            </th>
          )}
          <th scope="col" className="px-3 py-2">Room</th>
          <th scope="col" className="px-3 py-2">Type</th>
          <th scope="col" className="px-3 py-2">Seats</th>
          <th scope="col" className="px-3 py-2">Status</th>
          {showWhere && <th scope="col" className="px-3 py-2">Where</th>}
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {rooms.map((r) => {
          const missing = r.warnings.some((w) => w.code === 'MISSING_ACADEMIC_CAPACITY');
          return (
            <tr
              key={r.spaceId}
              onClick={() => onOpen(r.spaceId)}
              data-open={openId === r.spaceId ? 'true' : undefined}
              className={cn('cursor-pointer hover:bg-canvas/70 max-md:flex max-md:flex-wrap max-md:items-center max-md:gap-x-3 max-md:gap-y-1 max-md:px-3 max-md:py-3', openId === r.spaceId && 'bg-brand-soft/50')}
            >
              {selectable && (
                <td className="px-3 py-2.5 max-md:p-0" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`Select ${r.spaceName}`} checked={selected.has(r.spaceId)} onChange={() => onToggle(r.spaceId)} className="size-4 accent-[var(--color-brand)]" />
                </td>
              )}
              <td className="px-3 py-2.5 max-md:min-w-0 max-md:flex-1 max-md:p-0">
                <button type="button" onClick={(e) => { e.stopPropagation(); onOpen(r.spaceId); }} className="text-left font-semibold text-ink outline-none hover:text-brand focus-visible:underline">
                  {r.spaceName}
                </button>
                <span className="ml-2 font-mono text-xs text-muted">{r.spaceCode}</span>
              </td>
              <td className="px-3 py-2.5 text-muted max-md:p-0">{r.type.name}</td>
              <td className="px-3 py-2.5 max-md:p-0">
                <span className="inline-flex items-center gap-1.5">
                  <span className="font-semibold tabular-nums">{seatsText(r)}</span>
                  <span className="sr-only">seats</span>
                  {missing && <TriangleAlert className="size-4 text-warning" aria-label="Seats not set" />}
                </span>
              </td>
              <td className="px-3 py-2.5 max-md:p-0">
                <SpaceStatusPill space={r} />
              </td>
              {showWhere && <td className="px-3 py-2.5 text-muted max-md:p-0">{whereOf(r)}</td>}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
