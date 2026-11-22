import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BLOCK_REASON_CODES,
  BLOCK_REASON_LABELS,
  BLOCK_TYPES,
  MAX_BLOCK_DAYS,
  SPACE_SUITABILITY_TAGS,
  type ArchiveSpaceResultDTO,
  type ReplaceRoomResultDTO,
  type AvailabilityBlockDTO,
  type SpaceDTO,
  type TypeConversionPreviewDTO,
} from '@shared';
import { ArrowRight, Archive, Info } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextareaField, TextField } from '@/components/ui/field';
import { Modal } from '@/components/sv/modal';
import { Skeleton } from '@/components/ui/skeleton';
import { api, ApiError } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { SP, useBuildings, useFloors, useSpaceMutation } from './api';
import { useReplaceRoom } from './allocation-api';
import { roomOptions, usePickerData } from './room-picker';
import { useOptionalStudentContext } from '../students/context';
import { ARCHIVE_TEXT, LONG_CLOSURE_TEXT } from './help-copy';

// ───────────────────────────────────────────────────────────── change of type

const tagLabel = (code: string) => SPACE_SUITABILITY_TAGS.find((t) => t.code === code)?.label ?? code;
function showValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (v === null || v === undefined) return 'Not set';
  if (Array.isArray(v)) return v.length === 0 ? 'None' : v.map((x) => tagLabel(String(x))).join(', ');
  return String(v);
}

/** Shows what changes when a room becomes another type, then converts it once confirmed. */
export function ConvertTypeDialog({ space, toTypeId, onClose }: { space: SpaceDTO; toTypeId: string; onClose: () => void }) {
  const preview = useQuery({
    queryKey: [...SP, 'convert', space.spaceId, toTypeId],
    queryFn: () => api.post<TypeConversionPreviewDTO>(`/physical-spaces/${space.spaceId}/convert-type/preview`, { spaceTypeId: toTypeId }),
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);
  const convert = useSpaceMutation((body: object) => api.patch(`/physical-spaces/${space.spaceId}`, body), { quiet: true });
  const data = preview.data;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Change the room type?"
      description={data ? `${space.spaceName} will change from ${data.from.name} to ${data.to.name}.` : space.spaceName}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!data}
            loading={convert.isPending}
            loadingText="Changing…"
            onClick={async () => {
              setError(null);
              try {
                await convert.mutateAsync({ version: space.version, spaceTypeId: toTypeId, confirm: true });
                onClose();
              } catch (err) {
                setError(messageFor(err));
              }
            }}
          >
            Change Type
          </Button>
        </>
      }
    >
      {preview.isLoading ? (
        <Skeleton className="h-24" role="status" aria-label="Loading" />
      ) : preview.isError || !data ? (
        <Alert tone="danger">{messageFor(preview.error)}</Alert>
      ) : (
        <div className="space-y-4">
          <section aria-label="What changes">
            <h3 className="mb-1.5 text-sm font-bold">What changes</h3>
            {data.changes.length === 0 ? (
              <p className="text-sm text-muted">Nothing changes. Only the type name does.</p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {data.changes.map((c) => (
                  <li key={c.field} className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold">{c.label}:</span> {showValue(c.from)} <ArrowRight className="size-3.5 text-muted" aria-hidden="true" /> <b>{showValue(c.to)}</b>
                  </li>
                ))}
              </ul>
            )}
          </section>
          {data.rechecks.length > 0 && (
            <section aria-label="What will be checked again">
              <h3 className="mb-1.5 text-sm font-bold">What we will check again</h3>
              <ul className="list-disc space-y-1 pl-5 text-sm text-muted">
                {data.rechecks.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            </section>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── archive

/**
 * Archives a room, or explains why it cannot be archived yet: what depends on it, a room that could take over, and the next steps.
 * The server never answers with a raw error here.
 */
export function ArchiveDialog({ space, onClose, onArchived }: { space: SpaceDTO; onClose: () => void; onArchived: () => void }) {
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<ArchiveSpaceResultDTO | null>(null);
  const [done, setDone] = useState<ReplaceRoomResultDTO | null>(null);
  const [error, setError] = useState<string | null>(null);
  const archive = useSpaceMutation((body: object) => api.post<ArchiveSpaceResultDTO>(`/physical-spaces/${space.spaceId}/archive`, body), { quiet: true });

  if (done) {
    return (
      <Modal
        open
        onOpenChange={(open) => {
          if (open) return;
          if (done.archived) onArchived();
          else onClose();
        }}
        title={done.archived ? 'Room archived' : done.mode === 'AFTER_SESSION' ? 'Archive planned' : 'Sections moved'}
        description={space.spaceName}
        footer={<Button onClick={() => (done.archived ? onArchived() : onClose())}>Done</Button>}
      >
        <div className="space-y-3 text-sm" data-testid="replace-result">
          <Alert tone="success">{done.message}</Alert>
          {done.moved.length > 0 && (
            <section aria-label="What moved">
              <h3 className="mb-1.5 font-bold">{done.mode === 'NOW' ? 'What moved' : 'Keeps this room until then'}</h3>
              <ul className="list-disc space-y-1 pl-5">
                {done.moved.map((m) => (
                  <li key={m.assignmentId}>
                    {m.label}: {m.fromRoom}
                    {done.mode === 'NOW' && (
                      <>
                        {' '}
                        <ArrowRight className="inline size-3.5" aria-hidden="true" /> <b>{m.toRoom}</b>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {done.dependencies.length > 0 && (
            <p className="text-muted">Still in the way: {done.dependencies.map((d) => d.label).join(' ')}</p>
          )}
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={result ? 'This room is still in use' : 'Archive this room?'}
      className={result ? 'max-w-xl' : undefined}
      description={space.spaceName}
      footer={
        result ? (
          <Button onClick={onClose}>Close</Button>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              loading={archive.isPending}
              loadingText="Archiving…"
              onClick={async () => {
                setError(null);
                try {
                  const r = await archive.mutateAsync(reason.trim() ? { reason: reason.trim() } : {});
                  if (r.archived) onArchived();
                  else setResult(r);
                } catch (err) {
                  setError(messageFor(err));
                }
              }}
            >
              <Archive /> Archive Room
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-4">
          <Alert tone="warning">{result.message}</Alert>
          <section aria-label="What depends on this room">
            <h3 className="mb-1.5 text-sm font-bold">What depends on this room</h3>
            <ul className="list-disc space-y-1 pl-5 text-sm">
              {result.dependencies.map((d) => (
                <li key={`${d.kind}:${d.label}`}>{d.label}</li>
              ))}
            </ul>
          </section>
          {result.suggestedReplacementName && (
            <p className="flex items-start gap-2 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
              <span>
                A good replacement: <b>{result.suggestedReplacementName}</b>.
              </span>
            </p>
          )}
          {result.actions.length > 0 ? (
            <ReplaceActions space={space} result={result} onDone={setDone} />
          ) : (
            <p className="text-[13px] text-muted">Finish or cancel the items above, then archive the room again.</p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">{ARCHIVE_TEXT}</p>
          <TextareaField label="Reason" hint="Optional. Example: Room closed for good." value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} />
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}

/**
 * The two ways out when a room still holds Home Classrooms: move them to another room now (then archive), or keep the room until
 * the current school year ends and archive it then.
 */
function ReplaceActions({ space, result, onDone }: { space: SpaceDTO; result: ArchiveSpaceResultDTO; onDone: (r: ReplaceRoomResultDTO) => void }) {
  const ctx = useOptionalStudentContext();
  const data = usePickerData(space.locationId, ctx?.sessionId);
  const replace = useReplaceRoom(space.spaceId);
  const [choosing, setChoosing] = useState(false);
  const [picked, setPicked] = useState('');
  const [keepReason, setKeepReason] = useState('');
  const [tooSmall, setTooSmall] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rooms used by the sections that are moving are not "taken" for this purpose.
  const movingRoom = data.live.filter((r) => r.room.spaceId !== space.spaceId);
  const options = roomOptions(data.rooms, movingRoom, { excludeRoomId: space.spaceId });
  // Start with the suggested room when it can really be picked, else the best free room (the list puts it first).
  const free = options.filter((o) => !o.disabled);
  const roomId = picked || (free.find((o) => o.value === result.suggestedReplacementId) ?? free[0])?.value || '';

  const run = async (body: Parameters<typeof replace.mutateAsync>[0]) => {
    setError(null);
    try {
      onDone(await replace.mutateAsync(body));
    } catch (err) {
      const failures = err instanceof ApiError ? ((err.details?.failures as { code: string }[] | undefined) ?? []) : [];
      setTooSmall(failures.length > 0 && failures.every((f) => f.code === 'ROOM_TOO_SMALL'));
      setError(messageFor(err));
    }
  };

  return (
    <div className="space-y-3">
      {!choosing ? (
        <div className="flex flex-wrap gap-2">
          {result.actions.includes('CHOOSE_REPLACEMENT') && (
            <Button size="sm" onClick={() => setChoosing(true)}>
              Choose Replacement
            </Button>
          )}
          {result.actions.includes('ARCHIVE_AFTER_SESSION') && (
            <Button size="sm" variant="outline" loading={replace.isPending} loadingText="Saving…" onClick={() => void run({ mode: 'AFTER_SESSION' })}>
              Archive After Current Session
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3 rounded-xl border border-line p-3">
          <ComboboxField label="Room that takes over" value={roomId} onChange={setPicked} options={options} placeholder={data.loading ? 'Loading rooms…' : 'Choose…'} searchPlaceholder="Search rooms…" hint="The sections move today. Their old room stays in History." disabled={data.loading} />
          {tooSmall && <TextareaField label="Keep the smaller room anyway? Why" hint="Optional. Fill this in only to move into a room with fewer seats." value={keepReason} onChange={(e) => setKeepReason(e.target.value)} rows={2} maxLength={300} />}
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="outline" onClick={() => setChoosing(false)}>
              Back
            </Button>
            <Button size="sm" disabled={!roomId} loading={replace.isPending} loadingText="Moving…" onClick={() => void run({ mode: 'NOW', replacementSpaceId: roomId, ...(tooSmall && keepReason.trim() ? { capacityOverride: { reason: keepReason.trim() } } : {}) })}>
              Move And Archive
            </Button>
          </div>
        </div>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── move

/** Moves an unused room to another floor. A room with history is never moved: the dialog says to archive it and add a new one. */
export function MoveDialog({ space, onClose, onArchiveInstead }: { space: SpaceDTO; onClose: () => void; onArchiveInstead: () => void }) {
  const buildings = useBuildings(space.locationId);
  const [buildingId, setBuildingId] = useState(space.building?.buildingId ?? '');
  const floors = useFloors(buildingId || undefined);
  const [floorId, setFloorId] = useState(space.floor?.floorId ?? '');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [guarded, setGuarded] = useState(false);
  const move = useSpaceMutation((body: object) => api.post(`/physical-spaces/${space.spaceId}/move`, body), { quiet: true, success: `${space.spaceName} was moved.` });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Move this room"
      description={`${space.spaceName} now is in ${space.building?.buildingName ?? 'no building'}${space.floor ? ` › ${space.floor.floorName}` : ''}.`}
      footer={
        guarded ? (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={onArchiveInstead}>
              <Archive /> Archive This Room Instead
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              loading={move.isPending}
              loadingText="Moving…"
              onClick={async () => {
                setError(null);
                try {
                  if (!buildingId || !floorId) throw new FormProblem('Choose the building and the floor.');
                  if (!reason.trim()) throw new FormProblem('Write a short reason, for example “Class moved to the new block”.');
                  await move.mutateAsync({ buildingId, floorId, reason: reason.trim() });
                  onClose();
                } catch (err) {
                  if (err instanceof ApiError && err.code === 'GUARDED_MOVE_REQUIRED') setGuarded(true);
                  else setError(messageFor(err));
                }
              }}
            >
              Move Room
            </Button>
          </>
        )
      }
    >
      {guarded ? (
        <Alert tone="warning" title="This room has history, so it cannot be moved">
          Archive this room and create a new one, so the old records stay correct.
        </Alert>
      ) : (
        <div className="space-y-4">
          <ComboboxField
            label="Building"
            required
            value={buildingId}
            onChange={(v) => {
              setBuildingId(v);
              setFloorId('');
            }}
            options={(buildings.data ?? []).filter((b) => b.status !== 'ARCHIVED').map((b) => ({ value: b.buildingId, label: b.buildingName, hint: b.buildingCode }))}
            placeholder="Choose…"
            searchPlaceholder="Search buildings…"
          />
          <ComboboxField
            label="Floor"
            required
            value={floorId}
            onChange={setFloorId}
            options={(floors.data ?? []).filter((f) => f.status !== 'ARCHIVED').map((f) => ({ value: f.floorId, label: f.floorName, hint: f.floorCode }))}
            placeholder={buildingId ? 'Choose…' : 'Choose a building first'}
            searchPlaceholder="Search floors…"
          />
          <TextareaField label="Reason" required hint="This is saved in the room’s history." value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={300} />
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      )}
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── make unavailable

const pad = (n: number) => String(n).padStart(2, '0');
/** `2026-11-22T09:00`, the value a date-and-time input wants, in the browser's own time. */
export function toLocalInput(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const DAY = 86_400_000;
const BLOCK_TYPE_LABELS = { UNAVAILABLE: 'Cannot be used at all', RESTRICTED: 'Only some uses allowed' } as const;

/** A closure with dates (repairs, an exam). A closure of a year or more is a long-term closure: the dialog sends people to Inactive. */
export function UnavailableDialog({ space, onClose, onMakeInactive }: { space: SpaceDTO; onClose: () => void; onMakeInactive: () => Promise<void> }) {
  const [start, setStart] = useState(() => toLocalInput(new Date()));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Date.now() + DAY)));
  const [reasonCode, setReasonCode] = useState<string>('MAINTENANCE');
  const [blockType, setBlockType] = useState<string>('UNAVAILABLE');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [forcedLong, setForcedLong] = useState(false);
  const create = useSpaceMutation((body: object) => api.post<AvailabilityBlockDTO>(`/physical-spaces/${space.spaceId}/availability-blocks`, body), { quiet: true, success: `${space.spaceName} is marked unavailable for those dates.` });
  const inactive = useSpaceMutation(onMakeInactive, { quiet: true });

  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  const long = forcedLong || (Number.isFinite(endMs) && Number.isFinite(startMs) && (endMs - startMs > MAX_BLOCK_DAYS * DAY || endMs - Date.now() > MAX_BLOCK_DAYS * DAY));

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="Make this room unavailable"
      description={`${space.spaceName} stays Active. It just cannot be used for these dates.`}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={long}
            loading={create.isPending}
            loadingText="Saving…"
            onClick={async () => {
              setError(null);
              try {
                if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) throw new FormProblem('Enter the start and the end.');
                if (endMs <= startMs) throw new FormProblem('The end must be after the start.');
                await create.mutateAsync({
                  blockType,
                  startDatetime: new Date(startMs).toISOString(),
                  endDatetime: new Date(endMs).toISOString(),
                  reasonCode,
                  ...(note.trim() ? { reason: note.trim() } : {}),
                });
                onClose();
              } catch (err) {
                if (err instanceof ApiError && err.code === 'USE_INACTIVE_FOR_INDEFINITE') setForcedLong(true);
                else setError(messageFor(err));
              }
            }}
          >
            Make Unavailable
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="From" type="datetime-local" required value={start} onChange={(e) => setStart(e.target.value)} />
          <TextField label="Until" type="datetime-local" required value={end} onChange={(e) => setEnd(e.target.value)} />
        </div>
        {long && (
          <Alert tone="warning" title="For a long closure, mark the room Inactive instead">
            {LONG_CLOSURE_TEXT}
            <div className="mt-2">
              <Button
                size="sm"
                variant="outline"
                loading={inactive.isPending}
                loadingText="Saving…"
                onClick={async () => {
                  try {
                    await inactive.mutateAsync();
                    onClose();
                  } catch (err) {
                    setError(messageFor(err));
                  }
                }}
              >
                Mark Room Inactive
              </Button>
            </div>
          </Alert>
        )}
        <ComboboxField
          label="Why"
          required
          value={reasonCode}
          onChange={setReasonCode}
          options={BLOCK_REASON_CODES.map((c) => ({ value: c, label: BLOCK_REASON_LABELS[c] }))}
          searchPlaceholder="Search reasons…"
        />
        <ComboboxField label="What is allowed" value={blockType} onChange={setBlockType} options={BLOCK_TYPES.map((t) => ({ value: t, label: BLOCK_TYPE_LABELS[t] }))} searchPlaceholder="Search…" />
        <TextareaField label="Note" hint="Optional. Example: Roof repair." value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={300} />
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}
