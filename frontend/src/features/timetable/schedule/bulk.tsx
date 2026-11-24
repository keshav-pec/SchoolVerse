import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, DoorClosed, Lock, LockOpen, MoveRight, Trash2, X } from 'lucide-react';
import { ENTRY_TYPE_LABELS, WEEKDAY_LABELS, type BellResolutionRowDTO, type EntryType, type GridCellDTO, type GridDTO, type Weekday } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { Modal } from '@/components/sv/modal';
import { TT } from '../api';
import { useLessonActions } from './actions';
import { calls, withOptions, type Body } from './api';
import { useEditor } from './editor';
import { ChoicePicker } from './pickers';

/** Several lessons at once: a bar with Move, Clear, Mark Fixed, Change Room, and the whole-section actions from the toolbar. */

export function SelectionBar({ cells, grid, onClear }: { cells: GridCellDTO[]; grid: GridDTO; onClear: () => void }) {
  const { versionId, exec } = useEditor();
  const [moving, setMoving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [room, setRoom] = useState(false);
  const items = cells.map((c) => ({ entryId: c.entryId }));
  const run = (label: string, op: string, extra: Body = {}) => exec(label, (o) => calls.bulk(withOptions({ versionId, op, items, mode: 'APPLY_VALID', ...extra }, o))).then((r) => r && onClear());
  const first = cells[0]!;
  return (
    <div role="toolbar" aria-label="Selected lessons" className="flex flex-wrap items-center gap-2 rounded-xl border border-brand/30 bg-brand-soft/60 px-3 py-2 text-sm">
      <span className="font-semibold">{cells.length} selected</span>
      <Button size="sm" variant="outline" onClick={() => setMoving(true)}>
        <MoveRight /> Move
      </Button>
      <Button size="sm" variant="outline" onClick={() => setClearing(true)}>
        <Trash2 /> Clear
      </Button>
      <Button size="sm" variant="outline" onClick={() => void run(`Fixed ${cells.length} lessons`, 'MARK_FIXED')}>
        <Lock /> Mark Fixed
      </Button>
      <Button size="sm" variant="outline" onClick={() => void run(`Unlocked ${cells.length} lessons`, 'UNLOCK')}>
        <LockOpen /> Unlock
      </Button>
      <Button size="sm" variant="outline" onClick={() => setRoom(true)}>
        <DoorClosed /> Change Room
      </Button>
      <Button size="sm" variant="ghost" className="ml-auto" onClick={onClear}>
        <X /> Clear Selection
      </Button>
      <MoveMany open={moving} onClose={() => setMoving(false)} cells={cells} grid={grid} onDone={onClear} />
      <ConfirmDialog
        open={clearing}
        onOpenChange={setClearing}
        title={`Clear ${cells.length} lessons?`}
        description="They are removed from the timetable. You can undo it right after."
        confirmLabel="Clear Lessons"
        loadingLabel="Clearing…"
        tone="danger"
        onConfirm={async () => {
          await run(`Cleared ${cells.length} lessons`, 'CLEAR', { mode: 'ALL_OR_NOTHING' });
        }}
      />
      <ChoicePicker
        kind="spaces"
        open={room}
        onClose={() => setRoom(false)}
        allowNone
        target={{ versionId, weekday: first.weekday, periodId: first.periodId, sectionId: first.sections[0]?.sectionOfferingId, groupId: first.teachingGroupId ?? undefined, subjectOfferingId: first.subjectOfferingId ?? undefined, excludeEntryId: first.entryId }}
        onPick={(id) => {
          setRoom(false);
          void run(`Changed the room of ${cells.length} lessons`, 'SET_ROOM', { physicalSpaceId: id });
        }}
      />
    </div>
  );
}

/** "9 of 10 can move. 1 clashes (reason)", with Move 9 Only. The preview asks the same checker the save uses. */
function MoveMany({ open, onClose, cells, grid, onDone }: { open: boolean; onClose: () => void; cells: GridCellDTO[]; grid: GridDTO; onDone: () => void }) {
  const { versionId, exec } = useEditor();
  const [day, setDay] = useState<Weekday>(grid.days[0]?.weekday ?? 'MON');
  const ops = cells.map((c) => ({ op: 'move', entryId: c.entryId, weekday: day, periodId: c.periodId }));
  const preview = useQuery({ queryKey: [...TT, 'move-many', versionId, day, cells.map((c) => c.entryId)], queryFn: () => calls.check(versionId, ops), enabled: open && cells.length > 0 });
  const good = preview.data ? preview.data.perOp.filter((p) => p.blockers === 0).length : 0;
  const all = preview.data?.ok ?? false;
  const go = async (mode: 'ALL_OR_NOTHING' | 'APPLY_VALID') => {
    onClose();
    const done = await exec(`Moved lessons to ${WEEKDAY_LABELS[day]}`, (o) => calls.bulk(withOptions({ versionId, op: 'MOVE', mode, items: ops.map(({ entryId, weekday, periodId }) => ({ entryId, weekday, periodId })) }, o)));
    if (done) onDone();
  };
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title="Move lessons to another day"
      description="They keep their periods. Choose the day, then check what fits."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {all ? (
            <Button onClick={() => void go('ALL_OR_NOTHING')}>Move All {cells.length}</Button>
          ) : (
            <Button disabled={good === 0 || !preview.data} onClick={() => void go('APPLY_VALID')}>
              Move {good} Only
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-3">
        <ComboboxField label="Move to" value={day} onChange={(v) => setDay(v as Weekday)} options={grid.days.map((d) => ({ value: d.weekday, label: d.label }))} searchPlaceholder="Search days…" />
        {preview.isLoading && <Skeleton className="h-12 rounded-xl" role="status" aria-label="Checking" />}
        {preview.data && (
          <Alert tone={all ? 'success' : good > 0 ? 'warning' : 'danger'} title={preview.data.summary}>
            {!all && preview.data.blockers[0] ? preview.data.blockers[0].message : null}
          </Alert>
        )}
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── whole-section actions (toolbar menu)

export type SectionAction = 'copy-section' | 'copy-day' | 'clear-section' | 'fixed-period' | null;

export function SectionActions({ action, onClose, grid, sectionId, classOfferingId, sections }: { action: SectionAction; onClose: () => void; grid: GridDTO; sectionId: string; classOfferingId: string | undefined; sections: BellResolutionRowDTO[] }) {
  const { versionId, exec } = useEditor();
  const actions = useLessonActions();
  const [targets, setTargets] = useState<string[]>([]);
  const [from, setFrom] = useState<Weekday>(grid.days[0]?.weekday ?? 'MON');
  const [days, setDays] = useState<Weekday[]>([]);
  const [kind, setKind] = useState<EntryType>('ASSEMBLY');
  const [name, setName] = useState('');
  const [scope, setScope] = useState<'section' | 'class' | 'school'>('class');
  const [periodId, setPeriodId] = useState('');
  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
  const close = () => {
    setTargets([]);
    setDays([]);
    onClose();
  };
  const own = sections.filter((s) => s.sectionOfferingId !== sectionId);
  const lessonPeriods = (grid.days[0]?.periods ?? []).filter((p) => p.schedulable);
  const scoped = scope === 'section' ? [sectionId] : scope === 'class' ? sections.filter((s) => s.classOfferingId === classOfferingId).map((s) => s.sectionOfferingId) : sections.map((s) => s.sectionOfferingId);
  const sectionLessons = grid.cells.filter((c) => !c.teachingGroupId);

  return (
    <>
      <Modal
        open={action === 'copy-section'}
        onOpenChange={(o) => !o && close()}
        title="Copy This Section To…"
        description="The week is copied to the sections you choose. Teachers and Home Classrooms are worked out for each one. Lessons that clash are skipped and listed."
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={targets.length === 0}
              onClick={() => {
                close();
                void exec('Copied the week', (o) => calls.bulk(withOptions({ versionId, op: 'DUPLICATE_TO', fromSectionId: sectionId, toSectionIds: targets, mode: 'APPLY_VALID' }, o)));
              }}
            >
              <Copy /> Copy Week
            </Button>
          </>
        }
      >
        <ul className="grid gap-1.5 sm:grid-cols-2" aria-label="Sections">
          {own.map((s) => (
            <li key={s.sectionOfferingId}>
              <label className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm font-semibold">
                <input type="checkbox" className="size-4" checked={targets.includes(s.sectionOfferingId)} onChange={() => setTargets((t) => toggle(t, s.sectionOfferingId))} />
                {s.label}
              </label>
            </li>
          ))}
        </ul>
      </Modal>

      <Modal
        open={action === 'copy-day'}
        onOpenChange={(o) => !o && close()}
        title="Copy A Day To…"
        description="Every lesson of one day is copied to the days you choose."
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={days.length === 0}
              onClick={() => {
                close();
                void exec('Copied the day', (o) => calls.bulk(withOptions({ versionId, op: 'DUPLICATE_TO', fromWeekday: from, toWeekdays: days, sectionId, mode: 'APPLY_VALID' }, o)));
              }}
            >
              <Copy /> Copy Day
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <ComboboxField label="Copy from" value={from} onChange={(v) => setFrom(v as Weekday)} options={grid.days.map((d) => ({ value: d.weekday, label: d.label }))} searchPlaceholder="Search days…" />
          <div className="flex flex-wrap gap-2" role="group" aria-label="Copy to">
            {grid.days.filter((d) => d.weekday !== from).map((d) => (
              <label key={d.weekday} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold">
                <input type="checkbox" className="size-4" checked={days.includes(d.weekday)} onChange={() => setDays((x) => toggle(x, d.weekday))} />
                {d.label}
              </label>
            ))}
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={action === 'clear-section'}
        onOpenChange={(o) => !o && close()}
        title="Clear this whole section?"
        description={`All ${sectionLessons.length} lessons of this section are removed. Fixed periods ask to be unlocked first. You can undo it right after.`}
        confirmLabel="Clear Section"
        loadingLabel="Clearing…"
        tone="danger"
        onConfirm={async () => {
          await exec('Cleared the section', (o) => calls.bulk(withOptions({ versionId, op: 'CLEAR', items: sectionLessons.map((c) => ({ entryId: c.entryId })), mode: 'ALL_OR_NOTHING' }, o)));
        }}
      />

      <Modal
        open={action === 'fixed-period'}
        onOpenChange={(o) => !o && close()}
        title="Add Fixed Period"
        description="One period every chosen day, such as Assembly. It is locked, so Smart Draft never moves it."
        footer={
          <>
            <Button variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={days.length === 0 || !periodId}
              onClick={async () => {
                close();
                for (const d of days) {
                  await actions.add(`Add ${name || ENTRY_TYPE_LABELS[kind]} on ${WEEKDAY_LABELS[d]}`, { weekday: d, periodId, entryType: kind, activityName: name.trim() || ENTRY_TYPE_LABELS[kind], sectionOfferingIds: scoped, isFixed: true });
                }
              }}
            >
              Add Fixed Period
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <ComboboxField label="Kind" value={kind} onChange={(v) => setKind(v as EntryType)} options={(['ASSEMBLY', 'LIBRARY', 'SPORTS', 'CLUB', 'HOMEROOM', 'OTHER'] as EntryType[]).map((v) => ({ value: v, label: ENTRY_TYPE_LABELS[v] }))} searchPlaceholder="Search…" />
            <TextField label="Name" hint="Optional." value={name} onChange={(e) => setName(e.target.value)} />
            <ComboboxField label="Period" value={periodId} onChange={setPeriodId} options={lessonPeriods.map((p) => ({ value: p.periodId, label: p.periodName, hint: `${p.start}–${p.end}` }))} placeholder="Choose a period" searchPlaceholder="Search periods…" />
            <ComboboxField
              label="For"
              value={scope}
              onChange={(v) => setScope(v as typeof scope)}
              options={[
                { value: 'section', label: 'This section only' },
                { value: 'class', label: 'Every section of this class' },
                { value: 'school', label: 'Every section at this campus' },
              ]}
              searchPlaceholder="Search…"
            />
          </div>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Days">
            {grid.days.map((d) => (
              <label key={d.weekday} className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-sm font-semibold">
                <input type="checkbox" className="size-4" checked={days.includes(d.weekday)} onChange={() => setDays((x) => toggle(x, d.weekday))} />
                {d.label}
              </label>
            ))}
          </div>
          <p className="text-sm text-muted" data-testid="fixed-preview">
            {scoped.length} section{scoped.length === 1 ? '' : 's'} get it on {days.length} day{days.length === 1 ? '' : 's'}.
          </p>
        </div>
      </Modal>
    </>
  );
}
