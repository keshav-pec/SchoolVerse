import { useState } from 'react';
import { BUILDING_TYPE_LABELS, BUILDING_TYPES, STRUCTURE_STATUS_LABELS, type SpaceTreeDTO, type StructureTargetStatus } from '@shared';
import { Archive, Building2, Layers, MoreHorizontal, Pencil, PlusCircle, Power } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Alert } from '@/components/ui/alert';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { Modal } from '@/components/sv/modal';
import { api } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { useBuildings, useFloors, useSpaceMutation } from './api';
import type { Selection } from './space-tree';

type Edit = null | 'rename' | 'archive';

function RenameDialog({ selection, locationId, onClose }: { selection: Extract<Selection, { kind: 'building' | 'floor' }>; locationId: string; onClose: () => void }) {
  const isFloor = selection.kind === 'floor';
  const buildings = useBuildings(locationId);
  const floors = useFloors(isFloor ? selection.buildingId : undefined);
  const building = buildings.data?.find((b) => b.buildingId === selection.buildingId);
  const floor = isFloor ? floors.data?.find((f) => f.floorId === selection.floorId) : undefined;
  const current = isFloor ? floor : building;
  const [name, setName] = useState<string | null>(null);
  const [type, setType] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useSpaceMutation((body: object) => api.patch(isFloor ? `/floors/${selection.floorId}` : `/buildings/${selection.buildingId}`, body), { quiet: true, success: 'Saved.' });
  const shownName = name ?? (isFloor ? floor?.floorName : building?.buildingName) ?? '';
  const shownType = type ?? building?.buildingType ?? 'ACADEMIC';

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={isFloor ? 'Rename floor' : 'Edit building'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!current}
            loading={save.isPending}
            loadingText="Saving…"
            onClick={async () => {
              setError(null);
              try {
                if (!shownName.trim()) throw new FormProblem('Enter a name.');
                await save.mutateAsync(isFloor ? { version: current!.version, floorName: shownName.trim() } : { version: current!.version, buildingName: shownName.trim(), buildingType: shownType });
                onClose();
              } catch (err) {
                setError(messageFor(err));
              }
            }}
          >
            Save Changes
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField label={isFloor ? 'Floor name' : 'Building name'} required value={shownName} onChange={(e) => setName(e.target.value)} hint="Room codes and history do not change when you rename." />
        {!isFloor && <ComboboxField label="Kind of building" value={shownType} onChange={setType} options={BUILDING_TYPES.map((t) => ({ value: t, label: BUILDING_TYPE_LABELS[t] }))} searchPlaceholder="Search…" />}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

/**
 * The heading of a selected building or floor: its name, status and room count, a shortcut to add rooms, and the few things an
 * admin does to it (rename, make inactive, archive). Inactive hides every room under it without rewriting them.
 */
export function StructureHeader({ selection, tree, locationId, canEdit, onAddRooms }: { selection: Extract<Selection, { kind: 'building' | 'floor' }>; tree: SpaceTreeDTO; locationId: string; canEdit: boolean; onAddRooms: () => void }) {
  const [edit, setEdit] = useState<Edit>(null);
  const building = tree.buildings.find((b) => b.buildingId === selection.buildingId);
  const floor = selection.kind === 'floor' ? building?.floors.find((f) => f.floorId === selection.floorId) : undefined;
  const status = selection.kind === 'floor' ? floor?.status : building?.status;
  const name = selection.kind === 'floor' ? floor?.floorName : building?.buildingName;
  const rooms = selection.kind === 'floor' ? floor?.roomCount : building?.roomCount;
  const setStatus = useSpaceMutation((to: StructureTargetStatus) => api.post(selection.kind === 'floor' ? `/floors/${selection.floorId}/status` : `/buildings/${selection.buildingId}/status`, { to }), {
    success: (_r, to) => `${name} is now ${STRUCTURE_STATUS_LABELS[to].toLowerCase()}.`,
  });
  const archive = useSpaceMutation((_: void) => api.post(selection.kind === 'floor' ? `/floors/${selection.floorId}/status` : `/buildings/${selection.buildingId}/status`, { to: 'ARCHIVED' }), { quiet: true, success: `${name} was archived.` });
  if (!building || !status || !name) return null;
  const Icon = selection.kind === 'floor' ? Layers : Building2;

  return (
    <div className="flex flex-wrap items-center gap-3" data-testid="structure-header">
      <Icon className="size-5 text-brand" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <h2 className="truncate text-base font-bold">
          {selection.kind === 'floor' ? `${building.buildingName} › ${name}` : name}
        </h2>
        <p className="text-[13px] text-muted">
          {rooms ?? 0} room{rooms === 1 ? '' : 's'}
          {selection.kind === 'building' ? ` · ${building.floors.length} floor${building.floors.length === 1 ? '' : 's'}` : ''}
        </p>
      </div>
      <Badge tone={status === 'ACTIVE' ? 'success' : status === 'INACTIVE' ? 'warning' : 'neutral'}>{STRUCTURE_STATUS_LABELS[status]}</Badge>
      {canEdit && (
        <>
          <Button size="sm" variant="outline" onClick={onAddRooms}>
            <PlusCircle /> Add Rooms
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="icon-sm" variant="outline" aria-label={`More actions for ${name}`}>
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setEdit('rename')}>
                <Pencil className="size-4" /> Rename
              </DropdownMenuItem>
              {status === 'ACTIVE' ? (
                <DropdownMenuItem onSelect={() => setStatus.mutate('INACTIVE')}>
                  <Power className="size-4" /> Make Inactive
                </DropdownMenuItem>
              ) : status !== 'ARCHIVED' ? (
                <DropdownMenuItem onSelect={() => setStatus.mutate('ACTIVE')}>
                  <Power className="size-4" /> Make Active
                </DropdownMenuItem>
              ) : null}
              {status !== 'ARCHIVED' && (
                <DropdownMenuItem onSelect={() => setEdit('archive')} className="text-danger">
                  <Archive className="size-4" /> Archive
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </>
      )}
      {edit === 'rename' && <RenameDialog selection={selection} locationId={locationId} onClose={() => setEdit(null)} />}
      {edit === 'archive' && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setEdit(null)}
          icon={<Archive className="size-5" />}
          tone="danger"
          title={`Archive ${name}?`}
          description={`Archived ${selection.kind === 'floor' ? 'floors' : 'buildings'} are kept for history. A ${selection.kind} with active rooms cannot be archived until its rooms are archived or moved.`}
          confirmLabel={`Archive ${selection.kind === 'floor' ? 'Floor' : 'Building'}`}
          loadingLabel="Archiving…"
          onConfirm={async () => {
            await archive.mutateAsync();
          }}
        />
      )}
    </div>
  );
}
