import { useMemo, useState, type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Lock, Plus, ShieldCheck, TriangleAlert } from 'lucide-react';
import type { GridCellDTO, GridDTO, GridPeriodDTO, SlotStatus, Weekday } from '@shared';
import { cn } from '@/lib/utils';

/** `Monday|periodId` → what dropping a lesson there would do, from the slot map. */
export type SlotColours = Map<string, { status: SlotStatus; reason: string | null }>;
export const slotKey = (weekday: Weekday, periodId: string) => `${weekday}|${periodId}`;

interface Row {
  key: string;
  startMin: number;
  label: string;
  time: string;
  byDay: Map<Weekday, GridPeriodDTO>;
  lessonRow: boolean;
}

function rowsOf(grid: GridDTO): Row[] {
  const rows = new Map<string, Row>();
  for (const day of grid.days) {
    for (const p of day.periods) {
      const key = `${p.startMin}-${p.endMin}`;
      const row = rows.get(key) ?? { key, startMin: p.startMin, label: p.periodName, time: `${p.start}–${p.end}`, byDay: new Map(), lessonRow: false };
      row.byDay.set(day.weekday, p);
      row.lessonRow ||= p.schedulable;
      rows.set(key, row);
    }
  }
  return [...rows.values()].sort((a, b) => a.startMin - b.startMin);
}

/** The second and third lines under the subject depend on whose week this is. */
function detailsOf(cell: GridCellDTO, view: GridDTO['view']): string[] {
  const teachers = cell.teachers.map((t) => t.fullName).join(', ');
  const sections = cell.sections.map((s) => s.label).join(' + ');
  if (view === 'teacher') return [sections || cell.groupName || '', cell.roomName ?? ''].filter(Boolean);
  if (view === 'room') return [sections || cell.groupName || '', teachers].filter(Boolean);
  return [teachers, cell.roomName ?? ''].filter(Boolean);
}

const titleOf = (cell: GridCellDTO) => cell.groupName ?? cell.subjectName ?? cell.activityName ?? 'Lesson';

export interface ScheduleGridProps {
  grid: GridDTO;
  /** Can a lesson be dragged, added or changed? */
  editable: boolean;
  selectedId: string | null;
  multi: ReadonlySet<string>;
  draggingId: string | null;
  colours: SlotColours | null;
  onSelect: (cell: GridCellDTO, event: { shift: boolean }) => void;
  onAdd?: (weekday: Weekday, period: GridPeriodDTO) => void;
  onDragStart: (cell: GridCellDTO) => void;
  onDragEnd: () => void;
  onDrop: (cell: GridCellDTO, weekday: Weekday, period: GridPeriodDTO, occupant: GridCellDTO | undefined) => void;
  dayActions?: (weekday: Weekday) => ReactNode;
}

export function ScheduleGrid({ grid, editable, selectedId, multi, draggingId, colours, onSelect, onAdd, onDragStart, onDragEnd, onDrop, dayActions }: ScheduleGridProps) {
  const rows = useMemo(() => rowsOf(grid), [grid]);
  const [mobileDay, setMobileDay] = useState<Weekday | null>(null);
  const activeDay = mobileDay ?? grid.days[0]?.weekday;
  const byCell = useMemo(() => {
    const map = new Map<string, GridCellDTO[]>();
    for (const c of grid.cells) map.set(slotKey(c.weekday, c.periodId), [...(map.get(slotKey(c.weekday, c.periodId)) ?? []), c]);
    return map;
  }, [grid.cells]);
  const dragged = draggingId ? grid.cells.find((c) => c.entryId === draggingId) : undefined;

  const dayClass = (day: Weekday) => cn(day !== activeDay && 'hidden md:table-cell');

  return (
    <div className="space-y-2">
      <div className="flex gap-1 md:hidden" role="tablist" aria-label="Day">
        {grid.days.map((d) => (
          <button
            key={d.weekday}
            type="button"
            role="tab"
            aria-selected={d.weekday === activeDay}
            onClick={() => setMobileDay(d.weekday)}
            className={cn('flex-1 rounded-lg border px-2 py-2 text-sm font-semibold', d.weekday === activeDay ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-white text-muted')}
          >
            {d.label.slice(0, 3)}
          </button>
        ))}
      </div>
      <div className="overflow-x-auto rounded-card border border-line bg-white">
        <table className="w-full min-w-0 table-fixed border-collapse text-sm" aria-label="Weekly timetable">
          <thead>
            <tr className="bg-canvas text-left">
              <th scope="col" className="w-24 px-2 py-2 text-[13px] font-semibold text-muted">
                Period
              </th>
              {grid.days.map((d) => (
                <th key={d.weekday} scope="col" className={cn('border-l border-line px-2 py-2 text-[13px] font-bold', dayClass(d.weekday))}>
                  <span className="flex items-center justify-between gap-1">
                    {d.label}
                    {dayActions?.(d.weekday)}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) =>
              row.lessonRow ? (
                <tr key={row.key} className="border-t border-line align-top">
                  <th scope="row" className="px-2 py-2 text-left text-[13px] font-semibold">
                    {row.label}
                    <span className="block text-[12px] font-normal text-muted">{row.time}</span>
                  </th>
                  {grid.days.map((d) => {
                    const period = row.byDay.get(d.weekday);
                    return (
                      <td key={d.weekday} className={cn('border-l border-line p-1', dayClass(d.weekday))}>
                        {period && period.schedulable ? (
                          <Slot
                            grid={grid}
                            weekday={d.weekday}
                            period={period}
                            cells={byCell.get(slotKey(d.weekday, period.periodId)) ?? []}
                            editable={editable}
                            selectedId={selectedId}
                            multi={multi}
                            draggingId={draggingId}
                            dragged={dragged}
                            colour={colours?.get(slotKey(d.weekday, period.periodId))}
                            onSelect={onSelect}
                            onAdd={onAdd}
                            onDragStart={onDragStart}
                            onDragEnd={onDragEnd}
                            onDrop={onDrop}
                          />
                        ) : (
                          <div className="min-h-12 rounded-lg bg-ink/[0.03] px-2 py-1 text-[12px] text-muted">{period?.periodName ?? '—'}</div>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ) : (
                <tr key={row.key} className="border-t border-line bg-ink/[0.03]">
                  <th scope="row" className="px-2 py-1.5 text-left text-[12px] font-semibold text-muted">
                    {row.label}
                  </th>
                  <td colSpan={grid.days.length} className="px-2 py-1.5 text-[12px] text-muted">
                    {row.time}
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface SlotProps {
  grid: GridDTO;
  weekday: Weekday;
  period: GridPeriodDTO;
  cells: GridCellDTO[];
  editable: boolean;
  selectedId: string | null;
  multi: ReadonlySet<string>;
  draggingId: string | null;
  dragged: GridCellDTO | undefined;
  colour: { status: SlotStatus; reason: string | null } | undefined;
  onSelect: ScheduleGridProps['onSelect'];
  onAdd: ScheduleGridProps['onAdd'];
  onDragStart: ScheduleGridProps['onDragStart'];
  onDragEnd: ScheduleGridProps['onDragEnd'];
  onDrop: ScheduleGridProps['onDrop'];
}

const COLOUR: Record<SlotStatus, string> = {
  OK: 'bg-success-soft ring-2 ring-success/50',
  WARNING: 'bg-warning-soft ring-2 ring-warning/50',
  BLOCKED: 'bg-ink/10 opacity-70 ring-1 ring-ink/20',
};

function Slot({ grid, weekday, period, cells, editable, selectedId, multi, draggingId, dragged, colour, onSelect, onAdd, onDragStart, onDragEnd, onDrop }: SlotProps) {
  const [over, setOver] = useState(false);
  const occupant = cells.find((c) => c.entryId !== draggingId);
  const dropping = draggingId !== null && editable;
  const status = dropping && !occupant ? colour?.status : undefined;

  const handleDrop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    if (dragged && !(dragged.weekday === weekday && dragged.periodId === period.periodId)) onDrop(dragged, weekday, period, occupant);
  };

  return (
    <div
      data-testid={`slot-${weekday}-${period.periodCode}`}
      data-slot-status={status ?? (dropping && occupant ? 'SWAP' : undefined)}
      title={status === 'BLOCKED' ? (colour?.reason ?? undefined) : undefined}
      className={cn('group relative min-h-12 rounded-lg transition', status && COLOUR[status], dropping && occupant && 'ring-2 ring-dashed ring-brand/40', over && 'outline-2 outline-brand')}
      onDragOver={dropping ? (e) => {
        e.preventDefault();
        setOver(true);
      } : undefined}
      onDragLeave={() => setOver(false)}
      onDrop={dropping ? handleDrop : undefined}
    >
      {cells.map((cell) => (
        <Lesson key={cell.entryId} cell={cell} view={grid.view} editable={editable} selected={selectedId === cell.entryId} picked={multi.has(cell.entryId)} onSelect={onSelect} onDragStart={onDragStart} onDragEnd={onDragEnd} />
      ))}
      {cells.length === 0 && (
        <>
          {status === 'BLOCKED' && colour?.reason && <span className="block px-1.5 py-1 text-[11px] leading-tight text-muted">{colour.reason}</span>}
          {editable && onAdd && !dropping && (
            <button
              type="button"
              onClick={() => onAdd(weekday, period)}
              aria-label={`Add a lesson on ${grid.days.find((d) => d.weekday === weekday)?.label}, ${period.periodName}`}
              className="absolute inset-0 grid place-items-center rounded-lg text-[13px] font-semibold text-brand opacity-0 transition hover:bg-brand-soft/60 focus-visible:opacity-100 group-hover:opacity-100"
            >
              <span className="flex items-center gap-1">
                <Plus className="size-3.5" aria-hidden="true" /> Add
              </span>
            </button>
          )}
        </>
      )}
    </div>
  );
}

function Lesson({ cell, view, editable, selected, picked, onSelect, onDragStart, onDragEnd }: { cell: GridCellDTO; view: GridDTO['view']; editable: boolean; selected: boolean; picked: boolean; onSelect: ScheduleGridProps['onSelect']; onDragStart: ScheduleGridProps['onDragStart']; onDragEnd: ScheduleGridProps['onDragEnd'] }) {
  const details = detailsOf(cell, view);
  const overridden = cell.issueList.some((i) => i.overriddenReason);
  const problems = cell.issues.clash + cell.issues.warning;
  const label = [titleOf(cell), ...details, cell.isFixed ? 'fixed' : '', problems > 0 ? `${problems} warning${problems === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ');
  const choose = (e: MouseEvent | KeyboardEvent) => onSelect(cell, { shift: e.shiftKey });
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={label}
      aria-pressed={selected || picked}
      draggable={editable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', cell.entryId);
        e.dataTransfer.effectAllowed = 'move';
        onDragStart(cell);
      }}
      onDragEnd={onDragEnd}
      onClick={choose}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          choose(e);
        }
      }}
      className={cn(
        'relative z-10 w-full cursor-pointer rounded-lg border bg-white px-2 py-1.5 text-left text-[13px] leading-snug shadow-sm outline-none focus-visible:ring-4 focus-visible:ring-brand/25',
        cell.issues.clash > 0 ? 'border-danger' : problems > 0 ? 'border-warning' : 'border-line',
        (selected || picked) && 'border-brand bg-brand-soft/60 ring-2 ring-brand/40',
        editable && 'active:cursor-grabbing',
      )}
    >
      <span className="flex items-start justify-between gap-1">
        <span className="font-bold text-ink">{titleOf(cell)}</span>
        <span className="flex shrink-0 items-center gap-0.5">
          {cell.isFixed && <Lock className="size-3.5 text-muted" aria-label="Fixed" />}
          {overridden && <ShieldCheck className="size-3.5 text-brand" aria-label="Allowed by a person with permission" />}
          {problems > 0 && <TriangleAlert className={cn('size-3.5', cell.issues.clash > 0 ? 'text-danger' : 'text-warning')} aria-label="Needs a look" />}
        </span>
      </span>
      {details.map((d) => (
        <span key={d} className="block truncate text-[12px] text-muted">
          {d}
        </span>
      ))}
    </div>
  );
}
