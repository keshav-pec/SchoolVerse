import { useState } from 'react';
import { SPACE_SUITABILITY_TAGS, type SpaceTypeDTO, type SuitabilityTagCode } from '@shared';
import { Pencil, Plus, Power } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { PageHeader } from '@/components/sv/page-header';
import { api } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { useSpaceMutation, useSpaceTypes } from './api';
import { HOME_CLASSROOM_HELP, SCHEDULABLE_HELP, TAGS_HELP, TYPES_INTRO } from './help-copy';
import { CheckGroup } from './space-controls';

const tagText = (tags: readonly string[]) => (tags.length === 0 ? 'None' : tags.map((t) => SPACE_SUITABILITY_TAGS.find((x) => x.code === t)?.label ?? t).join(', '));

function Tick({ label, checked, onChange, help }: { label: string; checked: boolean; onChange: (v: boolean) => void; help?: React.ReactNode }) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-sm font-semibold">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-[var(--color-brand)]" />
      {label}
      {help && <InfoTip label={`About ${label.toLowerCase()}`}>{help}</InfoTip>}
    </label>
  );
}

/** Add a type, or change the defaults of one. A change reaches every room that follows the type, and the dialog says how many. */
function TypeDialog({ type, onClose }: { type: SpaceTypeDTO | null; onClose: () => void }) {
  const [name, setName] = useState(type?.name ?? '');
  const [schedulable, setSchedulable] = useState(type?.isSchedulable ?? true);
  const [home, setHome] = useState(type?.isHomeClassroomEligible ?? false);
  const [tags, setTags] = useState<SuitabilityTagCode[]>(type?.defaultSuitabilityTags ?? []);
  const [seats, setSeats] = useState(type?.defaultAcademicCapacity ? String(type.defaultAcademicCapacity) : '');
  const [outdoor, setOutdoor] = useState(type?.isOutdoor ?? false);
  const [error, setError] = useState<string | null>(null);
  const save = useSpaceMutation((body: object) => (type ? api.patch(`/space-types/${type.spaceTypeId}`, body) : api.post('/space-types', body)), { quiet: true, success: type ? 'Type saved.' : 'Type added.' });
  const changed = !!type && (schedulable !== type.isSchedulable || home !== type.isHomeClassroomEligible || seats !== (type.defaultAcademicCapacity ? String(type.defaultAcademicCapacity) : '') || tags.join() !== type.defaultSuitabilityTags.join());

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={type ? `Change ${type.name}` : 'Add a room type'}
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            loadingText="Saving…"
            onClick={async () => {
              setError(null);
              try {
                if (!name.trim()) throw new FormProblem('Enter a name, for example “Music Room”.');
                if (seats.trim() && (!/^\d+$/.test(seats.trim()) || Number(seats) < 1)) throw new FormProblem('Seats must be a whole number above zero. Example: 40.');
                const common = { name: name.trim(), isSchedulable: schedulable, isHomeClassroomEligible: home, defaultSuitabilityTags: tags, defaultAcademicCapacity: seats.trim() ? Number(seats) : null };
                await save.mutateAsync(type ? common : { ...common, isOutdoor: outdoor });
                onClose();
              } catch (err) {
                setError(messageFor(err));
              }
            }}
          >
            {type ? 'Save Changes' : 'Add Type'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <TextField label="Name" required value={name} onChange={(e) => setName(e.target.value)} hint="Example: Music Room." />
        <div className="flex flex-wrap gap-x-6 gap-y-2">
          <Tick label="Can be timetabled" checked={schedulable} onChange={setSchedulable} help={SCHEDULABLE_HELP} />
          <Tick label="Can be a home classroom" checked={home} onChange={setHome} help={HOME_CLASSROOM_HELP} />
          {!type && <Tick label="Outdoor space" checked={outdoor} onChange={setOutdoor} help={<p>An outdoor space, like a playground, is not inside a building and has no floor.</p>} />}
        </div>
        <TextField label="Seats for classes" inputMode="numeric" value={seats} onChange={(e) => setSeats(e.target.value)} hint="Optional. The number every room of this type starts with. Example: 40." />
        <fieldset>
          <legend className="mb-1.5 flex items-center gap-1.5 text-sm font-semibold">
            Suitable for <InfoTip label="About suitable for">{TAGS_HELP}</InfoTip>
          </legend>
          <CheckGroup legend="Suitable for" options={SPACE_SUITABILITY_TAGS} selected={tags} onChange={setTags} />
        </fieldset>
        {changed && type!.roomCount > 0 && (
          <div data-testid="rooms-use-default">
            <Alert tone="info">
              {type!.roomCount} room{type!.roomCount === 1 ? ' uses' : 's use'} this default. They follow this change, except rooms where someone set their own value.
            </Alert>
          </div>
        )}
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    </Modal>
  );
}

/** `/spaces/types`: the room types and their defaults. Rooms follow their type, so one change here reaches many rooms. */
export function SpaceTypesPage() {
  const q = useSpaceTypes();
  const [editing, setEditing] = useState<SpaceTypeDTO | 'new' | null>(null);
  const [toggling, setToggling] = useState<SpaceTypeDTO | null>(null);
  const toggle = useSpaceMutation((t: SpaceTypeDTO) => api.post(`/space-types/${t.spaceTypeId}/${t.status === 'ACTIVE' ? 'inactivate' : 'activate'}`), { quiet: true, success: 'Done.' });

  return (
    <>
      <PageHeader
        eyebrow="Campus"
        title="Room Types"
        description="Ready-made settings for each kind of room."
        actions={
          <Button onClick={() => setEditing('new')}>
            <Plus /> Add Type
          </Button>
        }
      />
      <TabIntro title="About room types" className="mb-4">
        {TYPES_INTRO}
      </TabIntro>
      {q.isLoading ? (
        <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />
      ) : q.isError || !q.data ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <Card className="p-0">
          <ul className="divide-y divide-line" aria-label="Room types">
            {q.data.map((t) => (
              <li key={t.spaceTypeId} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <div className="min-w-0 flex-1 basis-56">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-bold">
                    {t.name}
                    {t.isSystem && <Badge tone="neutral">Built in</Badge>}
                    {t.isOutdoor && <Badge tone="mint">Outdoor</Badge>}
                    {t.status === 'INACTIVE' && <Badge tone="warning">Inactive</Badge>}
                  </p>
                  <p className="text-[13px] text-muted">
                    {t.isSchedulable ? 'Can be timetabled' : 'Not timetabled'} · {t.isHomeClassroomEligible ? 'Can be a home classroom' : 'Not a home classroom'}
                    {t.defaultAcademicCapacity ? ` · ${t.defaultAcademicCapacity} seats` : ''}
                  </p>
                  <p className="text-[13px] text-muted">Suitable for: {tagText(t.defaultSuitabilityTags)}</p>
                </div>
                <p className="text-sm tabular-nums text-muted">
                  {t.roomCount} room{t.roomCount === 1 ? '' : 's'}
                </p>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setEditing(t)} aria-label={`Change ${t.name}`}>
                    <Pencil /> Change
                  </Button>
                  {!t.isSystem && (
                    <Button size="sm" variant="ghost" onClick={() => setToggling(t)} aria-label={`${t.status === 'ACTIVE' ? 'Make inactive' : 'Make active'} ${t.name}`}>
                      <Power /> {t.status === 'ACTIVE' ? 'Make Inactive' : 'Make Active'}
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && <TypeDialog key={editing === 'new' ? 'new' : editing.spaceTypeId} type={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {toggling && (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setToggling(null)}
          icon={<Power className="size-5" />}
          title={toggling.status === 'ACTIVE' ? `Make ${toggling.name} inactive?` : `Make ${toggling.name} active?`}
          description={toggling.status === 'ACTIVE' ? 'New rooms cannot use this type any more. If active rooms still use it, change their type first.' : 'Rooms can use this type again.'}
          confirmLabel={toggling.status === 'ACTIVE' ? 'Make Inactive' : 'Make Active'}
          loadingLabel="Saving…"
          onConfirm={async () => {
            await toggle.mutateAsync(toggling);
          }}
        />
      )}
    </>
  );
}
