import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BUILDING_TYPE_LABELS,
  BUILDING_TYPES,
  floorCodeFor,
  floorFromName,
  type BuildingDTO,
  type FloorsCreatedDTO,
  type GeneratePreviewDTO,
  type GenerateResultDTO,
  type SpaceDTO,
  type SpaceTreeDTO,
} from '@shared';
import { Building2, Copy, Layers, TriangleAlert, Trees, Wand2 } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextareaField, TextField } from '@/components/ui/field';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { InfoTip } from '@/components/ui/tooltip';
import { TabIntro } from '@/components/sv/help';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { api } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { SP, useFloors, useSpaceMutation, useSpaceTypes } from './api';
import { DUPLICATE_FLOOR_HELP, GENERATOR_HELP } from './help-copy';
import type { Selection } from './space-tree';

export type BuildTab = 'building' | 'rooms' | 'duplicate' | 'outdoor';

const NEW = '__new__';
const names = (text: string) => text.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);

function Footnote({ error }: { error: string | null }) {
  return error ? <Alert tone="danger">{error}</Alert> : null;
}

/** Building and floor, picked one after the other. */
function FloorPicker({ tree, buildingId, floorId, onBuilding, onFloor, labelPrefix = '' }: { tree: SpaceTreeDTO; buildingId: string; floorId: string; onBuilding: (id: string) => void; onFloor: (id: string) => void; labelPrefix?: string }) {
  const floors = useFloors(buildingId || undefined);
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <ComboboxField
        label={`${labelPrefix}Building`}
        required
        value={buildingId}
        onChange={(v) => {
          onBuilding(v);
          onFloor('');
        }}
        options={tree.buildings.filter((b) => b.status !== 'ARCHIVED').map((b) => ({ value: b.buildingId, label: b.buildingName, hint: b.buildingCode }))}
        placeholder="Choose…"
        searchPlaceholder="Search buildings…"
      />
      <ComboboxField
        label={`${labelPrefix}Floor`}
        required
        value={floorId}
        onChange={onFloor}
        options={(floors.data ?? []).filter((f) => f.status !== 'ARCHIVED').map((f) => ({ value: f.floorId, label: f.floorName, hint: `${f.roomCount} rooms` }))}
        placeholder={buildingId ? 'Choose…' : 'Choose a building first'}
        searchPlaceholder="Search floors…"
      />
    </div>
  );
}

/** The codes a generator or a duplicate would make. A clash is red and says why. */
function PreviewList({ preview }: { preview: GeneratePreviewDTO }) {
  return (
    <section aria-label="Preview" className="space-y-2" data-testid="preview">
      <p className="text-sm font-semibold">
        {preview.willCreate} room{preview.willCreate === 1 ? '' : 's'} will be made
        {preview.alreadyThere > 0 ? ` · ${preview.alreadyThere} already there` : ''}
        {preview.clashes > 0 ? ` · ${preview.clashes} clash${preview.clashes === 1 ? '' : 'es'}` : ''}
      </p>
      <ul className="grid max-h-56 grid-cols-2 gap-1.5 overflow-y-auto rounded-lg border border-line p-2 sm:grid-cols-3">
        {preview.rows.map((r) => (
          <li
            key={r.spaceCode + r.spaceName}
            title={r.clashMessage ?? undefined}
            className={cn('rounded-md px-2 py-1 text-[13px]', r.clash === null && 'bg-canvas', r.clash === 'EXISTS' && 'bg-ink/5 text-muted', (r.clash === 'CODE_TAKEN' || r.clash === 'DUPLICATE_IN_LIST') && 'bg-danger-soft font-semibold text-danger')}
          >
            <span className="font-mono">{r.spaceCode}</span>
            {r.clash && r.clash !== 'EXISTS' && <span className="sr-only"> clash: {r.clashMessage}</span>}
            {r.clash === 'EXISTS' && <span className="ml-1 text-xs">(already there)</span>}
            {(r.clash === 'CODE_TAKEN' || r.clash === 'DUPLICATE_IN_LIST') && <TriangleAlert className="ml-1 inline size-3.5" aria-hidden="true" />}
          </li>
        ))}
      </ul>
      {preview.rows.filter((r) => r.clash === 'CODE_TAKEN' || r.clash === 'DUPLICATE_IN_LIST').map((r) => (
        <p key={r.spaceCode} className="text-[13px] text-danger">
          {r.clashMessage}
        </p>
      ))}
    </section>
  );
}

// ───────────────────────────────────────────────────────────── 1. building and floors

function BuildingTab({ tree, locationId, onCreated }: { tree: SpaceTreeDTO; locationId: string; onCreated: (buildingId: string, floorId: string | null) => void }) {
  const [choice, setChoice] = useState(tree.buildings.length === 0 ? NEW : '');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [type, setType] = useState<string>('ACADEMIC');
  const [floorsText, setFloorsText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = useSpaceMutation(
    async (_: void) => {
      let buildingId = choice;
      let buildingName = tree.buildings.find((b) => b.buildingId === choice)?.buildingName ?? '';
      if (choice === NEW) {
        const b = await api.post<BuildingDTO>(`/locations/${locationId}/buildings`, { buildingName: name.trim(), ...(code.trim() ? { buildingCode: code.trim() } : {}), buildingType: type });
        buildingId = b.buildingId;
        buildingName = b.buildingName;
      }
      const list = names(floorsText);
      const floors = list.length > 0 ? await api.post<FloorsCreatedDTO>(`/buildings/${buildingId}/floors/bulk`, { floors: list.map((n) => ({ name: n })) }) : null;
      return { buildingId, buildingName, floors: floors?.floors ?? [] };
    },
    { quiet: true },
  );
  const parsed = names(floorsText).map((n, i) => ({ name: n, ...floorFromName(n, i) }));

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          if (!choice) throw new FormProblem('Choose a building, or add a new one.');
          if (choice === NEW && !name.trim()) throw new FormProblem('Enter the building name.');
          if (choice !== NEW && parsed.length === 0) throw new FormProblem('Type the floors to add, for example “Ground, First, Second”.');
          const r = await create.mutateAsync();
          toast.success(r.floors.length > 0 ? `${r.buildingName}: ${r.floors.length} floor${r.floors.length === 1 ? '' : 's'} added.` : `${r.buildingName} was added.`);
          setName('');
          setCode('');
          setFloorsText('');
          onCreated(r.buildingId, r.floors[0]?.floorId ?? null);
        } catch (err) {
          setError(messageFor(err));
        }
      }}
    >
      <ComboboxField
        label="Building"
        required
        value={choice}
        onChange={setChoice}
        options={[{ value: NEW, label: 'Add a new building' }, ...tree.buildings.filter((b) => b.status !== 'ARCHIVED').map((b) => ({ value: b.buildingId, label: b.buildingName, hint: b.buildingCode }))]}
        placeholder="Choose…"
        searchPlaceholder="Search buildings…"
      />
      {choice === NEW && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="Building name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: Main Academic Block." containerClassName="sm:col-span-2" />
          <TextField label="Code" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} hint="Optional. We make one for you." />
          <ComboboxField label="Kind of building" value={type} onChange={setType} options={BUILDING_TYPES.map((t) => ({ value: t, label: BUILDING_TYPE_LABELS[t] }))} searchPlaceholder="Search…" />
        </div>
      )}
      <TextareaField
        label="Floors"
        value={floorsText}
        onChange={(e) => setFloorsText(e.target.value)}
        rows={2}
        hint="Type them with commas. Example: Ground, First, Second. Optional if the floors are already there."
      />
      {parsed.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Floors to add">
          {parsed.map((f) => (
            <li key={f.name}>
              <Badge tone="brand">
                <Layers aria-hidden /> {f.name} · {floorCodeFor(f.floorNumber)}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Footnote error={error} />
      <Button type="submit" loading={create.isPending} loadingText="Adding…">
        <Building2 /> {choice === NEW || !choice ? 'Add Building And Floors' : 'Add Floors'}
      </Button>
    </form>
  );
}

// ───────────────────────────────────────────────────────────── 2. room generator

function GeneratorTab({ tree, presetBuilding, presetFloor, onDone }: { tree: SpaceTreeDTO; presetBuilding: string; presetFloor: string; onDone: (s: Selection) => void }) {
  const types = useSpaceTypes();
  const [buildingId, setBuildingId] = useState(presetBuilding);
  const [floorId, setFloorId] = useState(presetFloor);
  const [mode, setMode] = useState<'range' | 'names'>('range');
  const [from, setFrom] = useState('101');
  const [to, setTo] = useState('110');
  const [prefix, setPrefix] = useState('');
  const [list, setList] = useState('');
  const [typeId, setTypeId] = useState('');
  const [seats, setSeats] = useState('');
  const [error, setError] = useState<string | null>(null);

  const indoor = (types.data ?? []).filter((t) => t.status === 'ACTIVE' && !t.isOutdoor);
  const chosenType = typeId || indoor.find((t) => t.code === 'STANDARD_CLASSROOM')?.spaceTypeId || indoor[0]?.spaceTypeId || '';
  const typeRow = indoor.find((t) => t.spaceTypeId === chosenType);

  const body = useMemo(() => {
    if (!chosenType) return null;
    const common = { spaceTypeId: chosenType, ...(/^\d+$/.test(seats.trim()) && Number(seats) > 0 ? { academicCapacity: Number(seats) } : {}) };
    if (mode === 'range') {
      const a = Number(from);
      const b = Number(to);
      if (!/^\d+$/.test(from.trim()) || !/^\d+$/.test(to.trim()) || b < a || b - a >= 200) return null;
      return { from: a, to: b, ...(prefix.trim() ? { prefix: prefix.trim().toUpperCase() } : {}), ...common };
    }
    const n = names(list);
    return n.length > 0 ? { names: n, ...common } : null;
  }, [chosenType, mode, from, to, prefix, list, seats]);
  const debounced = useDebouncedValue(body ? JSON.stringify(body) : '', 300);

  const preview = useQuery({
    queryKey: [...SP, 'gen-preview', floorId, debounced],
    queryFn: () => api.post<GeneratePreviewDTO>(`/floors/${floorId}/spaces/generate/preview`, JSON.parse(debounced)),
    enabled: !!floorId && !!debounced,
    retry: false,
    placeholderData: (prev) => prev,
  });
  const generate = useSpaceMutation((payload: object) => api.post<GenerateResultDTO>(`/floors/${floorId}/spaces/generate`, payload), { quiet: true });
  const blocked = (preview.data?.clashes ?? 0) > 0;

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          if (!floorId) throw new FormProblem('Choose the building and floor first.');
          if (!body) throw new FormProblem(mode === 'range' ? 'Enter a start and end number, for example 101 to 110.' : 'Type at least one room name.');
          if (blocked) throw new FormProblem('Some codes clash with rooms that are already here. Change the numbers or the prefix first.');
          const r = await generate.mutateAsync(body);
          toast.success(`${r.created.length} room${r.created.length === 1 ? '' : 's'} created.`);
          onDone({ kind: 'floor', buildingId, floorId });
        } catch (err) {
          setError(messageFor(err));
        }
      }}
    >
      <TabIntro title="Room Generator" need="optional">
        <p>Make many rooms at once. Example: 101 to 110 on the First floor makes 10 rooms.</p>
      </TabIntro>
      <FloorPicker tree={tree} buildingId={buildingId} floorId={floorId} onBuilding={setBuildingId} onFloor={setFloorId} />
      <fieldset>
        <legend className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
          How to name the rooms <InfoTip label="About the room generator">{GENERATOR_HELP}</InfoTip>
        </legend>
        <div className="flex flex-wrap gap-4" role="radiogroup">
          {(
            [
              ['range', 'A range of numbers'],
              ['names', 'A list of names'],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex cursor-pointer items-center gap-2 text-sm">
              <input type="radio" name="gen-mode" checked={mode === v} onChange={() => setMode(v)} className="size-4 accent-[var(--color-brand)]" /> {label}
            </label>
          ))}
        </div>
      </fieldset>
      {mode === 'range' ? (
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="From" required inputMode="numeric" value={from} onChange={(e) => setFrom(e.target.value)} />
          <TextField label="To" required inputMode="numeric" value={to} onChange={(e) => setTo(e.target.value)} />
          <TextField label="Prefix" value={prefix} onChange={(e) => setPrefix(e.target.value)} hint="Optional. Example: A-" maxLength={10} />
        </div>
      ) : (
        <TextareaField label="Room names" required value={list} onChange={(e) => setList(e.target.value)} rows={3} hint="One per line or with commas. Example: Art Room, Music Room." />
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <ComboboxField label="Room type" required value={chosenType} onChange={setTypeId} options={indoor.map((t) => ({ value: t.spaceTypeId, label: t.name }))} placeholder="Choose…" searchPlaceholder="Search types…" />
        <TextField
          label="Seats for classes"
          inputMode="numeric"
          value={seats}
          onChange={(e) => setSeats(e.target.value)}
          hint={typeRow?.defaultAcademicCapacity ? `Optional. Empty means ${typeRow.defaultAcademicCapacity}, from ${typeRow.name}.` : 'Optional. Example: 40.'}
        />
      </div>
      {floorId && debounced && (preview.isLoading ? <Skeleton className="h-20" /> : preview.isError ? <Alert tone="danger">{messageFor(preview.error)}</Alert> : preview.data ? <PreviewList preview={preview.data} /> : null)}
      <Footnote error={error} />
      <Button type="submit" loading={generate.isPending} loadingText="Creating…" disabled={!floorId || !body || blocked}>
        <Wand2 /> {preview.data ? `Create ${preview.data.willCreate} Room${preview.data.willCreate === 1 ? '' : 's'}` : 'Create Rooms'}
      </Button>
      {blocked && <p className="text-[13px] text-danger">Fix the red codes first. The button works again when nothing clashes.</p>}
    </form>
  );
}

// ───────────────────────────────────────────────────────────── 3. duplicate a floor

function DuplicateTab({ tree, onDone }: { tree: SpaceTreeDTO; onDone: (s: Selection) => void }) {
  const [fromBuilding, setFromBuilding] = useState('');
  const [fromFloor, setFromFloor] = useState('');
  const [toBuilding, setToBuilding] = useState('');
  const [toFloor, setToFloor] = useState('');
  const [add, setAdd] = useState('100');
  const [error, setError] = useState<string | null>(null);
  const addNumber = /^-?\d+$/.test(add.trim()) ? Number(add) : null;
  const ready = !!fromFloor && !!toFloor && fromFloor !== toFloor && addNumber !== null;
  const body = ready ? JSON.stringify({ targetFloorId: toFloor, transform: { add: addNumber } }) : '';
  const debounced = useDebouncedValue(body, 300);
  const preview = useQuery({
    queryKey: [...SP, 'dup-preview', fromFloor, debounced],
    queryFn: () => api.post<GeneratePreviewDTO>(`/floors/${fromFloor}/duplicate-structure/preview`, JSON.parse(debounced)),
    enabled: !!debounced,
    retry: false,
    placeholderData: (prev) => prev,
  });
  const duplicate = useSpaceMutation((payload: object) => api.post<GenerateResultDTO>(`/floors/${fromFloor}/duplicate-structure`, payload), { quiet: true });
  const blocked = (preview.data?.clashes ?? 0) > 0;

  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          if (!fromFloor || !toFloor) throw new FormProblem('Choose the floor to copy and the floor to copy it to.');
          if (fromFloor === toFloor) throw new FormProblem('Choose two different floors.');
          if (addNumber === null) throw new FormProblem('Enter the number to add, for example 100.');
          if (blocked) throw new FormProblem('Some codes clash with rooms that are already there. Change the number first.');
          const r = await duplicate.mutateAsync(JSON.parse(body));
          toast.success(`${r.created.length} room${r.created.length === 1 ? '' : 's'} copied.`);
          onDone({ kind: 'floor', buildingId: toBuilding, floorId: toFloor });
        } catch (err) {
          setError(messageFor(err));
        }
      }}
    >
      <TabIntro title="Copy a floor" need="optional">
        <p className="flex items-center gap-1.5">
          Copy the rooms of one floor to another. <InfoTip label="About copying a floor">{DUPLICATE_FLOOR_HELP}</InfoTip>
        </p>
      </TabIntro>
      <FloorPicker tree={tree} buildingId={fromBuilding} floorId={fromFloor} onBuilding={setFromBuilding} onFloor={setFromFloor} labelPrefix="Copy from: " />
      <FloorPicker tree={tree} buildingId={toBuilding} floorId={toFloor} onBuilding={setToBuilding} onFloor={setToFloor} labelPrefix="Copy to: " />
      <TextField label="Add to each room number" required inputMode="numeric" value={add} onChange={(e) => setAdd(e.target.value)} hint="Example: 100 turns 101–110 into 201–210." />
      {ready && (preview.isLoading ? <Skeleton className="h-20" /> : preview.isError ? <Alert tone="danger">{messageFor(preview.error)}</Alert> : preview.data ? <PreviewList preview={preview.data} /> : null)}
      <Footnote error={error} />
      <Button type="submit" loading={duplicate.isPending} loadingText="Copying…" disabled={!ready || blocked}>
        <Copy /> Copy Floor
      </Button>
    </form>
  );
}

// ───────────────────────────────────────────────────────────── 4. outdoor space

function OutdoorTab({ locationId, onDone }: { locationId: string; onDone: (s: Selection) => void }) {
  const types = useSpaceTypes();
  const outdoor = (types.data ?? []).filter((t) => t.status === 'ACTIVE' && t.isOutdoor);
  const [name, setName] = useState('');
  const [typeId, setTypeId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosen = typeId || outdoor[0]?.spaceTypeId || '';
  const create = useSpaceMutation((body: object) => api.post<SpaceDTO>('/physical-spaces', body), { quiet: true });
  return (
    <form
      className="space-y-4"
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        try {
          if (!name.trim()) throw new FormProblem('Enter a name, for example “Assembly Ground”.');
          if (!chosen) throw new FormProblem('Choose a type.');
          const r = await create.mutateAsync({ locationId, spaceTypeId: chosen, spaceName: name.trim() });
          toast.success(`${r.spaceName} was added.`);
          setName('');
          onDone({ kind: 'outdoor' });
        } catch (err) {
          setError(messageFor(err));
        }
      }}
    >
      <TabIntro title="Outdoor spaces" need="optional">
        <p>A playground or an assembly ground is not inside a building, so it has no floor.</p>
      </TabIntro>
      <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: Football Ground." />
      <ComboboxField label="Type" required value={chosen} onChange={setTypeId} options={outdoor.map((t) => ({ value: t.spaceTypeId, label: t.name }))} placeholder="Choose…" searchPlaceholder="Search types…" />
      <Footnote error={error} />
      <Button type="submit" loading={create.isPending} loadingText="Adding…">
        <Trees /> Add Outdoor Space
      </Button>
    </form>
  );
}

// ───────────────────────────────────────────────────────────── the panel

/** “Build Campus Structure”: add a building and its floors, make rooms with the generator, copy a floor, or add an outdoor space. */
export function BuildPanel({ open, onClose, tree, locationId, initialTab = 'building', onDone }: { open: boolean; onClose: () => void; tree: SpaceTreeDTO; locationId: string; initialTab?: BuildTab; onDone: (s: Selection) => void }) {
  const [tab, setTab] = useState<BuildTab>(initialTab);
  const [preset, setPreset] = useState<{ buildingId: string; floorId: string }>({ buildingId: tree.buildings[0]?.buildingId ?? '', floorId: '' });
  return (
    <Drawer open={open} onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title="Build Campus Structure" description="Add buildings, floors and rooms in a few steps.">
        <DrawerBody>
          <Tabs value={tab} onValueChange={(v) => setTab(v as BuildTab)}>
            <TabsList aria-label="Steps">
              <TabsTrigger value="building">1. Building And Floors</TabsTrigger>
              <TabsTrigger value="rooms">2. Rooms</TabsTrigger>
              <TabsTrigger value="duplicate">Copy A Floor</TabsTrigger>
              <TabsTrigger value="outdoor">Outdoor</TabsTrigger>
            </TabsList>
            <TabsContent value="building">
              <BuildingTab
                tree={tree}
                locationId={locationId}
                onCreated={(buildingId, floorId) => {
                  setPreset({ buildingId, floorId: floorId ?? '' });
                  setTab('rooms');
                }}
              />
            </TabsContent>
            <TabsContent value="rooms">
              <GeneratorTab key={`${preset.buildingId}:${preset.floorId}`} tree={tree} presetBuilding={preset.buildingId} presetFloor={preset.floorId} onDone={onDone} />
            </TabsContent>
            <TabsContent value="duplicate">
              <DuplicateTab tree={tree} onDone={onDone} />
            </TabsContent>
            <TabsContent value="outdoor">
              <OutdoorTab locationId={locationId} onDone={onDone} />
            </TabsContent>
          </Tabs>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
