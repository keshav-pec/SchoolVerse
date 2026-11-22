import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import type { HomeClassroomDTO, RoomRefDTO, SpaceDTO } from '@shared';
import { ArrowRight, TriangleAlert } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import type { ComboboxOption } from '@/components/ui/combobox';
import { ComboboxField, TextareaField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { Modal } from '@/components/sv/modal';
import { messageFor } from '@/lib/errors';
import { useCampusRooms } from './api';
import { isLiveRow, tooSmallFrom, useAssignments, useAssignRoom, useReplaceAssignmentRoom, type AssignBody, type TooSmall } from './allocation-api';
import { KEEP_ROOM_HELP } from './help-copy';

// ───────────────────────────────────────────────────────────── which rooms can be picked

export interface PickContext {
  /** The section the room is for: its own current room is not "taken". */
  sectionOfferingId?: string;
  strength?: number;
  /** Only rooms with at least this many seats (Choose Larger Room). */
  minSeats?: number;
  /** A room that cannot be chosen again (the room being replaced or archived). */
  excludeRoomId?: string;
}

/** Why a room cannot be picked, in plain words. `null` = it can. */
export function whyNot(room: SpaceDTO, takenBy: string | undefined): string | null {
  if (room.type.isOutdoor || !room.homeClassroomEligible.value) return 'Not a classroom';
  if (room.status === 'TEMPORARILY_UNAVAILABLE') return 'Under maintenance';
  if (room.status === 'RESTRICTED') return 'Restricted';
  if (room.status === 'INACTIVE' || room.status === 'DRAFT') return 'Not in use';
  if (room.archiveAfterDate) return 'Being archived';
  if (!room.effectiveStatus.available) return 'Floor or building closed';
  if (takenBy) return `Taken by ${takenBy}`;
  return null;
}

const seatsOf = (room: SpaceDTO) => room.academicCapacity.value;

/**
 * The options for the room dropdown: rooms that can be picked first (the best fit at the top), then the others greyed out with the
 * reason ("Taken by 8-B", "Under maintenance", "Not a classroom"), so nobody wonders where a room went.
 */
export function roomOptions(rooms: readonly SpaceDTO[], live: readonly HomeClassroomDTO[], ctx: PickContext = {}): ComboboxOption[] {
  const takenBy = new Map<string, string>();
  for (const row of live) if (row.section.sectionOfferingId !== ctx.sectionOfferingId) takenBy.set(row.room.spaceId, takenBy.has(row.room.spaceId) ? `${takenBy.get(row.room.spaceId)}, ${row.section.label}` : row.section.label);
  const strength = ctx.strength ?? 0;
  const rows = rooms
    .filter((r) => r.status !== 'ARCHIVED' && r.spaceId !== ctx.excludeRoomId)
    .filter((r) => ctx.minSeats === undefined || (seatsOf(r) ?? 0) >= ctx.minSeats)
    .map((r) => {
      const reason = whyNot(r, takenBy.get(r.spaceId));
      const seats = seatsOf(r);
      const fits = seats !== null && seats >= strength;
      const parts = [seats === null ? 'seats not set' : `${seats} seats`];
      if (reason) parts.push(reason);
      else if (strength > 0 && seats !== null && !fits) parts.push(`too small for ${strength}`);
      return { r, reason, seats, fits, option: { value: r.spaceId, label: r.spaceName, hint: parts.join(' · '), disabled: reason !== null } satisfies ComboboxOption };
    });
  // Free rooms that fit (smallest first), then free rooms that are too small, then the ones that cannot be picked.
  const rank = (x: (typeof rows)[number]) => (x.reason ? 2 : x.fits ? 0 : 1);
  rows.sort((a, b) => rank(a) - rank(b) || (rank(a) === 0 ? (a.seats ?? 0) - (b.seats ?? 0) : (b.seats ?? 0) - (a.seats ?? 0)) || a.r.spaceName.localeCompare(b.r.spaceName, 'en', { numeric: true }));
  return rows.map((x) => x.option);
}

/** Rooms and who uses them in a school year, for the dropdown. */
export function usePickerData(locationId: string | undefined, sessionId: string | undefined) {
  const rooms = useCampusRooms(locationId);
  const rows = useAssignments({ academicSessionId: sessionId, locationId }, !!sessionId);
  return {
    rooms: rooms.data?.items ?? [],
    live: (rows.data?.items ?? []).filter(isLiveRow),
    loading: rooms.isLoading || rows.isLoading,
  };
}

// ───────────────────────────────────────────────────────────── "this room is too small"

/** One dialog for every place a room turns out too small: pick the larger room we found, or keep this one with a reason. */
export function TooSmallDialog({ info, sectionLabel, roomName, onLarger, onKeep, onClose, busy }: { info: TooSmall; sectionLabel: string; roomName: string; onLarger: (room: RoomRefDTO) => void; onKeep: (reason: string) => void; onClose: () => void; busy?: boolean }) {
  const [keeping, setKeeping] = useState(false);
  const [reason, setReason] = useState('');
  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="This room is too small"
      description={`${sectionLabel} · ${roomName}`}
      footer={
        keeping ? (
          <>
            <Button variant="outline" onClick={() => setKeeping(false)}>
              Back
            </Button>
            <Button disabled={!reason.trim()} loading={busy} loadingText="Saving…" onClick={() => onKeep(reason.trim())}>
              Keep Room
            </Button>
          </>
        ) : (
          <>
            <Button variant="outline" onClick={() => setKeeping(true)}>
              Keep Room Anyway
            </Button>
            {info.suggestedRoom && (
              <Button loading={busy} loadingText="Saving…" onClick={() => onLarger(info.suggestedRoom!)}>
                Choose Larger Room
              </Button>
            )}
          </>
        )
      }
    >
      <div className="space-y-3 text-sm">
        <Alert tone="warning">
          {sectionLabel} has <b>{info.sectionStrength} students</b>, but {roomName} holds <b>{info.roomCapacity}</b>. That is {info.shortBy} seat{info.shortBy === 1 ? '' : 's'} short.
        </Alert>
        {keeping ? (
          <TextareaField
            label="Why keep this room?"
            labelAside={<InfoTip label="About Keep Room Anyway">{KEEP_ROOM_HELP}</InfoTip>}
            hint="Required. Example: Extra desks added."
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={2}
            maxLength={300}
            autoFocus
          />
        ) : info.suggestedRoom ? (
          <p className="flex items-center gap-2" data-testid="larger-room">
            <ArrowRight className="size-4 text-brand" aria-hidden="true" /> A larger free room: <b>{info.suggestedRoom.spaceName}</b> ({info.suggestedRoom.academicCapacity} seats).
          </p>
        ) : (
          <p className="text-muted">No free room is big enough. Keep this room with a reason, or free a bigger room first.</p>
        )}
      </div>
    </Modal>
  );
}

// ───────────────────────────────────────────────────────────── save a room for a section, with the capacity check

export type Attempt =
  | { kind: 'assign'; body: AssignBody; sectionLabel: string; roomName: string }
  | { kind: 'replace'; assignmentId: string; physicalSpaceId: string; capacityOverride?: { reason: string }; reason?: string; sectionLabel: string; roomName: string };

export type AttemptResult = { ok: true } | { ok: false; message: string | null };

/**
 * Saves a Home Classroom. When the room is too small the shared dialog opens (Choose Larger Room / Keep Room Anyway) and the save is
 * tried again with the answer. Other refusals come back as a message for the screen to show.
 */
export function useAssignFlow(onDone?: () => void) {
  const assign = useAssignRoom();
  const replace = useReplaceAssignmentRoom();
  const [pending, setPending] = useState<{ attempt: Attempt; info: TooSmall } | null>(null);

  const run = async (attempt: Attempt): Promise<AttemptResult> => {
    try {
      if (attempt.kind === 'assign') await assign.mutateAsync(attempt.body);
      else await replace.mutateAsync({ assignmentId: attempt.assignmentId, physicalSpaceId: attempt.physicalSpaceId, capacityOverride: attempt.capacityOverride, reason: attempt.reason });
      setPending(null);
      toast.success(`${attempt.sectionLabel} now sits in ${attempt.roomName}.`);
      onDone?.();
      return { ok: true };
    } catch (err) {
      const info = tooSmallFrom(err);
      if (info) {
        setPending({ attempt, info });
        return { ok: false, message: null };
      }
      setPending(null);
      return { ok: false, message: messageFor(err) };
    }
  };

  const withRoom = (a: Attempt, room: RoomRefDTO): Attempt => (a.kind === 'assign' ? { ...a, body: { ...a.body, physicalSpaceId: room.spaceId, capacityOverride: undefined }, roomName: room.spaceName } : { ...a, physicalSpaceId: room.spaceId, capacityOverride: undefined, roomName: room.spaceName });
  const withOverride = (a: Attempt, reason: string): Attempt => (a.kind === 'assign' ? { ...a, body: { ...a.body, capacityOverride: { reason } } } : { ...a, capacityOverride: { reason } });
  const report = (r: AttemptResult) => {
    if (!r.ok && r.message) toast.error(r.message);
  };

  const dialog: ReactNode = pending ? (
    <TooSmallDialog
      info={pending.info}
      sectionLabel={pending.attempt.sectionLabel}
      roomName={pending.attempt.roomName}
      busy={assign.isPending || replace.isPending}
      onClose={() => setPending(null)}
      onLarger={(room) => void run(withRoom(pending.attempt, room)).then(report)}
      onKeep={(reason) => void run(withOverride(pending.attempt, reason)).then(report)}
    />
  ) : null;

  return { run, dialog, busy: assign.isPending || replace.isPending };
}

// ───────────────────────────────────────────────────────────── pick a room for one section

export interface PickTarget {
  sectionOfferingId: string;
  label: string;
  strength: number;
  /** The section's current row, when the room is being replaced. */
  assignmentId?: string | null;
  currentRoom?: { spaceId: string; spaceName: string } | null;
  /** Pre-selected room (the suggestion). */
  suggestedRoomId?: string | null;
  /** Show only rooms that hold the whole section. */
  largerOnly?: boolean;
}

/**
 * "Pick Another Room", "Choose Larger Room" and "Replace Room" all open this dialog: the room dropdown lists only rooms that can be
 * picked, with seats; the others are greyed out with the reason.
 */
export function PickRoomDialog({ target, locationId, sessionId, onClose, title }: { target: PickTarget; locationId: string; sessionId: string; onClose: () => void; title?: string }) {
  const data = usePickerData(locationId, sessionId);
  const [roomId, setRoomId] = useState(target.suggestedRoomId ?? '');
  const [error, setError] = useState<string | null>(null);
  const flow = useAssignFlow(onClose);
  const options = roomOptions(data.rooms, data.live, { sectionOfferingId: target.sectionOfferingId, strength: target.strength, minSeats: target.largerOnly ? target.strength : undefined, excludeRoomId: target.currentRoom?.spaceId });
  const free = options.filter((o) => !o.disabled);
  const room = data.rooms.find((r) => r.spaceId === roomId);

  const save = async () => {
    if (!room) return;
    setError(null);
    const attempt: Attempt = target.assignmentId
      ? { kind: 'replace', assignmentId: target.assignmentId, physicalSpaceId: room.spaceId, sectionLabel: target.label, roomName: room.spaceName }
      : { kind: 'assign', body: { sectionOfferingId: target.sectionOfferingId, physicalSpaceId: room.spaceId }, sectionLabel: target.label, roomName: room.spaceName };
    const r = await flow.run(attempt);
    if (!r.ok && r.message) setError(r.message);
  };

  return (
    <>
      <Modal
        open={!flow.dialog}
        onOpenChange={(open) => !open && onClose()}
        title={title ?? (target.currentRoom ? 'Replace room' : 'Pick a room')}
        description={`${target.label} · ${target.strength} student${target.strength === 1 ? '' : 's'}`}
        footer={
          <>
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button disabled={!room} loading={flow.busy} loadingText="Saving…" onClick={() => void save()}>
              Save Room
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          {target.currentRoom && (
            <p className="text-sm">
              Now in <b>{target.currentRoom.spaceName}</b>. The old room is kept in History.
            </p>
          )}
          <ComboboxField
            label="Room"
            value={roomId}
            onChange={setRoomId}
            options={options}
            placeholder={data.loading ? 'Loading rooms…' : 'Choose…'}
            searchPlaceholder="Search rooms…"
            hint={target.largerOnly ? `Only rooms with at least ${target.strength} seats.` : 'Greyed-out rooms show why they cannot be picked.'}
            disabled={data.loading}
          />
          {!data.loading && free.length === 0 && (
            <Alert tone="warning">
              {target.largerOnly ? `No free room has ${target.strength} seats.` : 'No free classroom is left.'} Free a room in Current Rooms, or add rooms in Space Setup.
            </Alert>
          )}
          {room && room.academicCapacity.value !== null && room.academicCapacity.value < target.strength && (
            <p className="flex items-center gap-1.5 text-[13px] text-warning">
              <TriangleAlert className="size-4" aria-hidden="true" /> {room.spaceName} holds {room.academicCapacity.value}. We will ask before keeping it.
            </p>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </div>
      </Modal>
      {flow.dialog}
    </>
  );
}
