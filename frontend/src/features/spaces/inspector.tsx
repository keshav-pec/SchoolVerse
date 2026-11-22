import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  SPACE_FEATURES,
  SPACE_STATUS_LABELS,
  SPACE_SUITABILITY_TAGS,
  SPACE_TARGET_STATUSES,
  type AvailabilityBlockDTO,
  type SpaceContextDTO,
  type SpaceFeatureCode,
  type SpaceStatus,
  type SuitabilityTagCode,
} from '@shared';
import { Archive, ArrowRightLeft, CalendarOff, Check, ChevronDown, ChevronRight, History, LoaderCircle, MoreHorizontal, Pencil, Replace } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { FieldShell, TextField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { api, ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { SP, useBlocks, useSpace, useSpaceHistory, useSpaceMutation, useSpaceTypes } from './api';
import { CAPACITY_HELP, FEATURES_HELP, HOME_CLASSROOM_HELP, SCHEDULABLE_HELP, SPACE_TYPE_HELP, STATUS_HELP, TAGS_HELP } from './help-copy';
import { ArchiveDialog, ConvertTypeDialog, MoveDialog, UnavailableDialog } from './inspector-dialogs';
import { CheckGroup } from './space-controls';
import { SpaceStatusPill } from './space-bits';

// ───────────────────────────────────────────────────────────── autosave

type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'conflict' } | { kind: 'error'; message: string };

/**
 * Saves one safe field at a time. Shows “Saving…” then “Saved”, and an Undo button in a toast. If someone else changed the room in
 * the meantime the server says so, and the field offers to reload instead of overwriting their work.
 */
function useAutosave(spaceId: string) {
  const qc = useQueryClient();
  const [state, setState] = useState<SaveState>({ kind: 'idle' });
  const currentVersion = () => qc.getQueryData<SpaceContextDTO>([...SP, 'space', spaceId])?.version ?? 0;

  useEffect(() => {
    if (state.kind !== 'saved') return;
    const t = setTimeout(() => setState({ kind: 'idle' }), 2500);
    return () => clearTimeout(t);
  }, [state]);

  const refresh = () => qc.invalidateQueries({ queryKey: SP });

  /** `undo` puts the old value back. It is offered for 8 seconds in a toast. */
  const run = async (label: string, change: () => Promise<unknown>, undo?: () => Promise<unknown>): Promise<boolean> => {
    setState({ kind: 'saving' });
    try {
      await change();
      await refresh();
      setState({ kind: 'saved' });
      toast.success(label, {
        duration: 8000,
        action: undo
          ? {
              label: 'Undo',
              onClick: () => {
                setState({ kind: 'saving' });
                undo()
                  .then(refresh)
                  .then(() => setState({ kind: 'saved' }))
                  .catch((err) => {
                    setState({ kind: 'error', message: messageFor(err) });
                    toast.error(messageFor(err));
                  });
              },
            }
          : undefined,
      });
      return true;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') setState({ kind: 'conflict' });
      else setState({ kind: 'error', message: messageFor(err) });
      return false;
    }
  };

  /** Changes fields of the room with the version we last saw. */
  const patch = (changes: Record<string, unknown>) => api.patch(`/physical-spaces/${spaceId}`, { version: currentVersion(), ...changes });
  const reload = () => {
    setState({ kind: 'idle' });
    void refresh();
  };
  return { state, run, patch, reload, currentVersion };
}

function SaveIndicator({ state, onReload }: { state: SaveState; onReload: () => void }) {
  return (
    <p className="min-h-5 text-xs" aria-live="polite" data-testid="save-state">
      {state.kind === 'saving' && (
        <span className="inline-flex items-center gap-1 text-muted">
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden="true" /> Saving…
        </span>
      )}
      {state.kind === 'saved' && (
        <span className="inline-flex items-center gap-1 text-success">
          <Check className="size-3.5" aria-hidden="true" /> Saved
        </span>
      )}
      {state.kind === 'conflict' && (
        <span className="text-danger">
          Someone changed this.{' '}
          <button type="button" onClick={onReload} className="font-semibold underline">
            Reload
          </button>
        </span>
      )}
      {state.kind === 'error' && <span className="text-danger">{state.message}</span>}
    </p>
  );
}

// ───────────────────────────────────────────────────────────── small controls

/** A text box that saves when you leave it (or press Enter). */
function AutosaveText({ id, label, value, onSave, disabled, hint, error, labelAside, inputMode, placeholder, bare }: { id?: string; label: string; value: string; onSave: (next: string) => void; disabled?: boolean; hint?: ReactNode; error?: string; labelAside?: ReactNode; inputMode?: 'numeric'; placeholder?: string; bare?: boolean }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (bare)
    return (
      <div className="space-y-1">
        <Input
          id={id}
          aria-label={label}
          aria-invalid={!!error || undefined}
          value={draft}
          disabled={disabled}
          inputMode={inputMode}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() !== value) onSave(draft.trim());
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          }}
        />
        {(error || hint) && <p className={error ? 'text-[13px] text-danger' : 'text-[13px] text-muted'}>{error ?? hint}</p>}
      </div>
    );
  return (
    <TextField
      id={id}
      label={label}
      hint={hint}
      error={error}
      labelAside={labelAside}
      value={draft}
      disabled={disabled}
      inputMode={inputMode}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft.trim() !== value) onSave(draft.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Reads “40” or “” as a seat count. Anything else is a problem the person can fix. */
function parseSeats(text: string): { ok: true; value: number | null } | { ok: false; message: string } {
  if (text.trim() === '') return { ok: true, value: null };
  if (!/^\d+$/.test(text.trim()) || Number(text) < 1) return { ok: false, message: 'Enter a whole number above zero. Example: 40.' };
  return { ok: true, value: Number(text) };
}

/** A number box for seats. Empty means “use the type’s number” where that exists. */
function SeatsInput({ id, label, value, onSave, hint, labelAside, disabled, emptyMeans, bare }: { id?: string; label: string; value: number | null; onSave: (next: number | null) => void; hint?: ReactNode; labelAside?: ReactNode; disabled?: boolean; emptyMeans?: string; bare?: boolean }) {
  const [error, setError] = useState<string | undefined>();
  return (
    <AutosaveText
      id={id}
      label={label}
      value={value === null ? '' : String(value)}
      inputMode="numeric"
      bare={bare}
      disabled={disabled}
      labelAside={labelAside}
      error={error}
      hint={error ? undefined : (hint ?? (value === null ? emptyMeans : undefined))}
      onSave={(text) => {
        const parsed = parseSeats(text);
        if (!parsed.ok) return setError(parsed.message);
        setError(undefined);
        onSave(parsed.value);
      }}
    />
  );
}

/**
 * A setting the room gets from its type. It shows the value and “from Standard Classroom”. Only after “Customize” does it become
 * editable, so an exception is always a deliberate choice. “Use … default” goes back.
 */
function InheritedRow({
  label,
  aside,
  source,
  typeName,
  canEdit,
  read,
  edit,
  onReset,
  forceEdit,
}: {
  label: string;
  aside?: ReactNode;
  source: 'TYPE_DEFAULT' | 'OVERRIDE';
  typeName: string;
  canEdit: boolean;
  read: ReactNode;
  edit: ReactNode;
  onReset: () => void;
  /** Nothing to inherit (no default), so go straight to editing. */
  forceEdit?: boolean;
}) {
  const [customizing, setCustomizing] = useState(false);
  const id = useId();
  // Back to the type's value (a reset, or Undo): the field goes back to read-only.
  useEffect(() => {
    if (source === 'TYPE_DEFAULT') setCustomizing(false);
  }, [source]);
  const editing = canEdit && (source === 'OVERRIDE' || customizing || forceEdit);
  return (
    <FieldShell id={id} label={label} labelAside={aside}>
      {editing ? (
        <div className="space-y-1.5">
          {edit}
          {source === 'OVERRIDE' && (
            <button
              type="button"
              onClick={() => {
                setCustomizing(false);
                onReset();
              }}
              className="text-[13px] font-semibold text-brand hover:underline"
            >
              Use {typeName} default
            </button>
          )}
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span className="font-semibold">{read}</span>
          {source === 'TYPE_DEFAULT' && <span className="text-xs text-muted">from {typeName}</span>}
          {canEdit && source === 'TYPE_DEFAULT' && (
            <button type="button" onClick={() => setCustomizing(true)} className="text-[13px] font-semibold text-brand hover:underline">
              Customize
            </button>
          )}
        </div>
      )}
    </FieldShell>
  );
}

const YES_NO = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
];
const featureLabel = (c: SpaceFeatureCode) => SPACE_FEATURES.find((f) => f.code === c)?.label ?? c;
const tagText = (tags: readonly SuitabilityTagCode[]) => (tags.length === 0 ? 'None' : tags.map((t) => SPACE_SUITABILITY_TAGS.find((x) => x.code === t)?.label ?? t).join(', '));

// ───────────────────────────────────────────────────────────── availability and history

function Closures({ space, canManage, onAdd }: { space: SpaceContextDTO; canManage: boolean; onAdd: () => void }) {
  const blocks = useBlocks(space.spaceId);
  const cancel = useSpaceMutation((id: string) => api.post(`/availability-blocks/${id}/cancel`), { success: 'Closure cancelled.' });
  const list = blocks.data ?? [];
  return (
    <section aria-label="Unavailable dates" className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-bold">Unavailable dates</h3>
        {canManage && (
          <Button size="sm" variant="outline" onClick={onAdd}>
            <CalendarOff /> Make Unavailable
          </Button>
        )}
      </div>
      {blocks.isLoading ? (
        <Skeleton className="h-10" />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted">No closures planned. The room can be used on every day.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.map((b: AvailabilityBlockDTO) => (
            <li key={b.blockId} className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">
                  {formatDateTime(b.startDatetime)} → {formatDateTime(b.endDatetime)}
                </p>
                {b.reason && <p className="text-[13px] text-muted">{b.reason}</p>}
              </div>
              <Badge tone={b.phase === 'NOW' ? 'danger' : 'neutral'}>{b.phase === 'NOW' ? 'Now' : b.phase === 'UPCOMING' ? 'Coming up' : 'Past'}</Badge>
              {canManage && b.phase !== 'PAST' && (
                <Button size="sm" variant="ghost" onClick={() => cancel.mutate(b.blockId)} loading={cancel.isPending && cancel.variables === b.blockId} loadingText="Cancelling…">
                  Cancel
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function HistoryList({ spaceId }: { spaceId: string }) {
  const q = useSpaceHistory(spaceId, true);
  if (q.isLoading) return <Skeleton className="h-10" />;
  if (q.isError) return <p className="text-sm text-danger">{messageFor(q.error)}</p>;
  const rows = q.data ?? [];
  if (rows.length === 0) return <p className="text-sm text-muted">Nothing yet. Renames, type changes and moves show here.</p>;
  const NAMES = { RENAME: 'Renamed', TYPE_CONVERSION: 'Type changed', MOVE: 'Moved' } as const;
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {rows.map((c) => (
        <li key={c.changeId} className="px-3 py-2 text-sm">
          <p className="font-semibold">
            {NAMES[c.type]}: {c.from ?? '—'} → {c.to ?? '—'}
          </p>
          <p className="text-[13px] text-muted">
            {formatDateTime(c.occurredAt)}
            {c.reason ? ` · ${c.reason}` : ''}
          </p>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────────────────────────────────────── the inspector

type Dialog = null | { kind: 'convert'; typeId: string } | { kind: 'archive' } | { kind: 'move' } | { kind: 'unavailable' };

/**
 * The panel that opens when a room is clicked: no separate edit page. It first shows Name, Type, Seats, Status and Home Section.
 * “More settings” holds the rest. Safe fields save as you go. Faculty see the same facts with no controls.
 */
export function Inspector({ spaceId, onClose }: { spaceId: string; onClose: () => void }) {
  const q = useSpace(spaceId);
  const types = useSpaceTypes();
  const { can } = useAuth();
  const save = useAutosave(spaceId);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [more, setMore] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const nameId = useId();
  const typeRef = useRef<HTMLDivElement>(null);

  if (q.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading room" />;
  if (q.isError || !q.data) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const space = q.data;
  const canEdit = can('space:edit') && space.status !== 'ARCHIVED';
  const archived = space.status === 'ARCHIVED';
  const typeName = space.type.name;
  const typeOptions = (types.data ?? []).filter((t) => t.status === 'ACTIVE' && t.isOutdoor === space.type.isOutdoor).map((t) => ({ value: t.spaceTypeId, label: t.name, hint: t.isSystem ? undefined : 'Custom' }));
  const inactiveOrOther = !SPACE_TARGET_STATUSES.includes(space.status as (typeof SPACE_TARGET_STATUSES)[number]);
  const statusOptions = [
    ...(inactiveOrOther ? [{ value: space.status, label: SPACE_STATUS_LABELS[space.status], disabled: true }] : []),
    ...SPACE_TARGET_STATUSES.map((s) => ({ value: s, label: SPACE_STATUS_LABELS[s] })),
  ];

  /** One field change with its Undo. `field` names the value that goes back. */
  const change = (label: string, changes: Record<string, unknown>, back: Record<string, unknown>) => save.run(label, () => save.patch(changes), () => save.patch(back));
  const setStatus = (to: SpaceStatus) => {
    const from = space.status;
    const back = SPACE_TARGET_STATUSES.includes(from as (typeof SPACE_TARGET_STATUSES)[number]) ? () => api.post(`/physical-spaces/${spaceId}/status`, { to: from }) : undefined;
    return save.run(`Status changed to ${SPACE_STATUS_LABELS[to]}.`, () => api.post(`/physical-spaces/${spaceId}/status`, { to }), back);
  };
  const overrideValue = (value: boolean, source: string) => (source === 'OVERRIDE' ? value : null);

  return (
    <aside aria-label={`Room ${space.spaceName}`} className="space-y-4">
      <header className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-extrabold">{space.spaceName}</h2>
          <p className="text-[13px] text-muted">
            <span className="font-mono">{space.spaceCode}</span> · {space.path}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <SpaceStatusPill space={space} />
            <SaveIndicator state={save.state} onReload={save.reload} />
          </div>
        </div>
        {can('space:edit') && !archived && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon-sm" aria-label="More actions">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setTimeout(() => document.getElementById(nameId)?.focus(), 50)}>
                <Pencil className="size-4" /> Rename Room
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => setTimeout(() => typeRef.current?.querySelector('button')?.focus(), 50)}>
                <Replace className="size-4" /> Change Type
              </DropdownMenuItem>
              {can('space:availability:manage') && (
                <DropdownMenuItem onSelect={() => setDialog({ kind: 'unavailable' })}>
                  <CalendarOff className="size-4" /> Make Unavailable
                </DropdownMenuItem>
              )}
              {can('space:archive') && !space.type.isOutdoor && (
                <DropdownMenuItem onSelect={() => setDialog({ kind: 'move' })}>
                  <ArrowRightLeft className="size-4" /> Move Room
                </DropdownMenuItem>
              )}
              {can('space:archive') && (
                <DropdownMenuItem onSelect={() => setDialog({ kind: 'archive' })} className="text-danger">
                  <Archive className="size-4" /> Archive Room
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button variant="ghost" size="icon-sm" onClick={onClose} aria-label="Close room panel" className="xl:hidden">
          ✕
        </Button>
      </header>

      {archived && <Alert tone="info">This room is archived. It is kept for history and cannot be changed.</Alert>}
      {!space.effectiveStatus.available && space.status === 'ACTIVE' && (
        <Alert tone="warning" title="This room cannot be used right now">
          {space.effectiveStatus.reason}
        </Alert>
      )}
      {space.warnings.map((w) => (
        <Alert key={w.code} tone="warning">
          {w.message}
        </Alert>
      ))}

      <div className="space-y-4">
        <AutosaveText
          id={nameId}
          label="Name"
          value={space.spaceName}
          disabled={!canEdit}
          onSave={(next) => {
            if (!next) return void toast.error('A room needs a name.');
            void change('Room renamed.', { spaceName: next }, { spaceName: space.spaceName });
          }}
        />

        <div ref={typeRef}>
          <FieldShell id="space-type" label="Type" labelAside={<InfoTip label="About the room type">{SPACE_TYPE_HELP}</InfoTip>}>
            <Combobox
              id="space-type"
              value={space.type.spaceTypeId}
              disabled={!canEdit}
              onChange={(v) => v !== space.type.spaceTypeId && setDialog({ kind: 'convert', typeId: v })}
              options={typeOptions.some((o) => o.value === space.type.spaceTypeId) ? typeOptions : [...typeOptions, { value: space.type.spaceTypeId, label: typeName, hint: undefined }]}
              searchPlaceholder="Search types…"
            />
          </FieldShell>
        </div>

        <InheritedRow
          label="Seats for classes"
          aside={<InfoTip label="About seats">{CAPACITY_HELP}</InfoTip>}
          source={space.academicCapacity.source}
          typeName={typeName}
          canEdit={canEdit && !space.type.isOutdoor}
          forceEdit={space.academicCapacity.value === null}
          read={space.academicCapacity.value ?? 'Not set'}
          onReset={() => void change(`Seats now follow ${typeName}.`, { academicCapacity: null }, { academicCapacity: space.academicCapacity.value })}
          edit={
            <SeatsInput
              id="academic-capacity"
              label="Seats for classes"
              bare
              value={space.academicCapacity.value}
              emptyMeans="Example: 40. The number of students planned for this room."
              onSave={(next) => {
                if (next === space.academicCapacity.value) return;
                void change(next === null ? `Seats now follow ${typeName}.` : 'Seats saved.', { academicCapacity: next }, { academicCapacity: space.academicCapacity.source === 'OVERRIDE' ? space.academicCapacity.value : null });
              }}
            />
          }
        />

        <FieldShell id="space-status" label="Status" labelAside={<InfoTip label="About status">{STATUS_HELP}</InfoTip>}>
          <Combobox id="space-status" value={space.status} disabled={!canEdit} onChange={(v) => v !== space.status && void setStatus(v as SpaceStatus)} options={statusOptions} searchPlaceholder="Search…" />
        </FieldShell>

        <FieldShell id="home-section" label="Home section" labelAside={<InfoTip label="About home classrooms">{HOME_CLASSROOM_HELP}</InfoTip>}>
          <p id="home-section" className="text-sm font-semibold">
            {space.homeClassroom?.label ?? <span className="font-normal text-muted">No section sits here yet.</span>}
          </p>
        </FieldShell>
      </div>

      <div>
        <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="flex items-center gap-1 text-sm font-bold text-brand">
          {more ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />} More settings
        </button>
        {more && (
          <div className="mt-3 space-y-4 rounded-xl border border-line p-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <SeatsInput
                label="Physical capacity"
                value={space.physicalCapacity}
                disabled={!canEdit}
                hint="How many people fit safely."
                onSave={(next) => void change('Capacity saved.', { physicalCapacity: next }, { physicalCapacity: space.physicalCapacity })}
              />
              <SeatsInput label="Exam capacity" value={space.examCapacity} disabled={!canEdit} hint="Seats with desks spread out." onSave={(next) => void change('Exam capacity saved.', { examCapacity: next }, { examCapacity: space.examCapacity })} />
            </div>

            <FieldShell id="space-features" label="Features" labelAside={<InfoTip label="About features">{FEATURES_HELP}</InfoTip>}>
              <CheckGroup
                legend="Features"
                options={SPACE_FEATURES}
                selected={space.features}
                disabled={!canEdit}
                onChange={(next) => void change('Features saved.', { features: next }, { features: space.features })}
              />
            </FieldShell>

            <InheritedRow
              label="Suitable for"
              aside={<InfoTip label="About suitable for">{TAGS_HELP}</InfoTip>}
              source={space.suitabilityTags.source}
              typeName={typeName}
              canEdit={canEdit}
              read={tagText(space.suitabilityTags.value)}
              onReset={() => void change(`Now follows ${typeName}.`, { suitabilityOverrides: null }, { suitabilityOverrides: space.suitabilityTags.value })}
              edit={
                <CheckGroup
                  legend="Suitable for"
                  options={SPACE_SUITABILITY_TAGS}
                  selected={space.suitabilityTags.value}
                  onChange={(next) => void change('Saved.', { suitabilityOverrides: next }, { suitabilityOverrides: space.suitabilityTags.source === 'OVERRIDE' ? space.suitabilityTags.value : null })}
                />
              }
            />

            <InheritedRow
              label="Can be timetabled"
              aside={<InfoTip label="About timetabling">{SCHEDULABLE_HELP}</InfoTip>}
              source={space.schedulable.source}
              typeName={typeName}
              canEdit={canEdit}
              read={space.schedulable.value ? 'Yes' : 'No'}
              onReset={() => void change(`Now follows ${typeName}.`, { schedulableOverride: null }, { schedulableOverride: space.schedulable.value })}
              edit={
                <Combobox
                  aria-label="Can be timetabled"
                  value={space.schedulable.value ? 'yes' : 'no'}
                  onChange={(v) => void change('Saved.', { schedulableOverride: v === 'yes' }, { schedulableOverride: overrideValue(space.schedulable.value, space.schedulable.source) })}
                  options={YES_NO}
                  searchPlaceholder="Search…"
                />
              }
            />

            <InheritedRow
              label="Can be a home classroom"
              aside={<InfoTip label="About home classrooms">{HOME_CLASSROOM_HELP}</InfoTip>}
              source={space.homeClassroomEligible.source}
              typeName={typeName}
              canEdit={canEdit}
              read={space.homeClassroomEligible.value ? 'Yes' : 'No'}
              onReset={() => void change(`Now follows ${typeName}.`, { homeClassroomEligibleOverride: null }, { homeClassroomEligibleOverride: space.homeClassroomEligible.value })}
              edit={
                <Combobox
                  aria-label="Can be a home classroom"
                  value={space.homeClassroomEligible.value ? 'yes' : 'no'}
                  onChange={(v) => void change('Saved.', { homeClassroomEligibleOverride: v === 'yes' }, { homeClassroomEligibleOverride: overrideValue(space.homeClassroomEligible.value, space.homeClassroomEligible.source) })}
                  options={YES_NO}
                  searchPlaceholder="Search…"
                />
              }
            />

            {space.features.length > 0 && !canEdit && <p className="text-sm text-muted">Has: {space.features.map(featureLabel).join(', ')}.</p>}
          </div>
        )}
      </div>

      <Closures space={space} canManage={can('space:availability:manage') && !archived} onAdd={() => setDialog({ kind: 'unavailable' })} />

      {can('space:audit:view') && (
        <section aria-label="History">
          <button type="button" onClick={() => setShowHistory((v) => !v)} aria-expanded={showHistory} className="flex items-center gap-1.5 text-sm font-bold text-brand">
            <History className="size-4" /> {showHistory ? 'Hide history' : 'Show history'}
          </button>
          {showHistory && (
            <div className="mt-2">
              <HistoryList spaceId={spaceId} />
            </div>
          )}
        </section>
      )}

      {dialog?.kind === 'convert' && <ConvertTypeDialog space={space} toTypeId={dialog.typeId} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'archive' && (
        <ArchiveDialog
          space={space}
          onClose={() => setDialog(null)}
          onArchived={() => {
            setDialog(null);
            toast.success(`${space.spaceName} was archived. It stays in the history.`);
            onClose();
          }}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          space={space}
          onClose={() => setDialog(null)}
          onArchiveInstead={() => setDialog({ kind: 'archive' })}
        />
      )}
      {dialog?.kind === 'unavailable' && <UnavailableDialog space={space} onClose={() => setDialog(null)} onMakeInactive={async () => void (await api.post(`/physical-spaces/${spaceId}/status`, { to: 'INACTIVE' }))} />}
    </aside>
  );
}

