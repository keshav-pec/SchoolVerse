import { useState, type ReactNode } from 'react';
import type { LocationAction, LocationDependencyDTO, LocationDTO } from '@shared';
import { Archive, Crown, EllipsisVertical, Eye, PauseCircle, Play, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { useAuth } from '@/lib/auth';
import { ApiError } from '@/lib/api';
import { useDeleteLocation, useLocationAction, useLocations, useSetPrimary } from './api';

type Dialog = 'activate' | 'deactivate' | 'archive' | 'primary' | 'discard' | 'choose-primary' | null;

/** What the current user may do to this location, given its status. Mirrors the server's state machine. */
export function availableActions(location: Pick<LocationDTO, 'status' | 'isPrimary'>, can: (p: 'location:change_status' | 'location:set_primary' | 'location:archive') => boolean, deletable?: boolean) {
  const { status, isPrimary } = location;
  return {
    activate: (status === 'DRAFT' || status === 'INACTIVE') && can('location:change_status'),
    deactivate: status === 'ACTIVE' && !isPrimary && can('location:change_status'),
    /** Deactivating the Primary Location is blocked by the server (PRIMARY_LOCATION_REQUIRED). */
    deactivateBlocked: status === 'ACTIVE' && isPrimary && can('location:change_status'),
    setPrimary: status === 'ACTIVE' && !isPrimary && can('location:set_primary'),
    choosePrimary: status === 'ACTIVE' && isPrimary && can('location:set_primary'),
    archive: (status === 'DRAFT' || status === 'INACTIVE') && can('location:archive'),
    discard: status === 'DRAFT' && can('location:archive') && deletable !== false,
  };
}

function dependenciesOf(err: unknown): LocationDependencyDTO[] {
  if (err instanceof ApiError && err.code === 'LOCATION_HAS_DEPENDENCIES') {
    const list = err.details?.dependencies;
    if (Array.isArray(list)) return list as LocationDependencyDTO[];
  }
  return [];
}

interface Props {
  location: LocationDTO;
  schoolId: string;
  /** From the detail endpoint. Unknown in the list, where the server decides. */
  deletable?: boolean;
  currentPrimaryName?: string;
  onDiscarded?: () => void;
  /** Render as a "⋯" menu (table rows) or as a row of buttons (detail header). */
  variant?: 'menu' | 'buttons';
}

export function LocationActions({ location, schoolId, deletable, currentPrimaryName, onDiscarded, variant = 'menu' }: Props) {
  const { can } = useAuth();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [dependencies, setDependencies] = useState<LocationDependencyDTO[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const act = useLocationAction(location.locationId);
  const primary = useSetPrimary(location.locationId);
  const remove = useDeleteLocation(location.locationId);
  const allowed = availableActions(location, can, deletable);
  const name = location.displayName;

  const close = () => setDialog(null);

  const run = (action: LocationAction, success: string) => async () => {
    try {
      await act.mutateAsync(action);
      toast.success(success);
    } catch (err) {
      setDependencies(dependenciesOf(err));
      throw err;
    }
  };

  const hasAny = Object.entries(allowed).some(([k, v]) => k !== 'deactivateBlocked' && v) || allowed.deactivateBlocked;
  if (!hasAny) return null;

  const items: { key: string; label: string; icon: ReactNode; onSelect: () => void; danger?: boolean }[] = [];
  if (allowed.activate) items.push({ key: 'activate', label: location.status === 'INACTIVE' ? 'Reactivate' : 'Activate', icon: <Play />, onSelect: () => setDialog('activate') });
  if (allowed.setPrimary) items.push({ key: 'primary', label: 'Set as Primary', icon: <Crown />, onSelect: () => setDialog('primary') });
  if (allowed.deactivate) items.push({ key: 'deactivate', label: 'Deactivate', icon: <PauseCircle />, onSelect: () => setDialog('deactivate') });
  if (allowed.archive) items.push({ key: 'archive', label: 'Archive', icon: <Archive />, onSelect: () => { setDependencies([]); setDialog('archive'); }, danger: true });
  if (allowed.discard) items.push({ key: 'discard', label: 'Discard draft', icon: <Trash2 />, onSelect: () => setDialog('discard'), danger: true });

  const primaryBlockedNote = allowed.deactivateBlocked ? (
    <div className="px-2.5 py-2 text-[13px] leading-snug text-muted" data-testid="primary-deactivate-note">
      <span className="block font-semibold text-ink">Deactivate isn’t available</span>
      Set another active location as Primary before deactivating this one.
    </div>
  ) : null;

  const trigger =
    variant === 'menu' ? (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${name}`}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-60">
          <DropdownMenuItem asChild>
            <Link to={`/school-setup/locations/${location.locationId}`}>
              <Eye /> View details
            </Link>
          </DropdownMenuItem>
          {(items.length > 0 || allowed.deactivateBlocked || allowed.choosePrimary) && <DropdownMenuSeparator />}
          {items.map((item) => (
            <DropdownMenuItem key={item.key} onSelect={item.onSelect} className={item.danger ? 'text-danger data-[highlighted]:bg-danger-soft [&_svg]:text-danger' : undefined}>
              {item.icon} {item.label}
            </DropdownMenuItem>
          ))}
          {allowed.deactivateBlocked && (
            <>
              <DropdownMenuItem disabled aria-disabled="true">
                <PauseCircle /> Deactivate
              </DropdownMenuItem>
              {primaryBlockedNote}
              {allowed.choosePrimary && (
                <DropdownMenuItem onSelect={() => setDialog('choose-primary')}>
                  <Crown /> Choose new primary
                </DropdownMenuItem>
              )}
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : (
      <div className="flex flex-wrap items-center gap-2">
        {items.map((item) => (
          <Button key={item.key} variant={item.danger ? 'outline' : item.key === 'primary' || item.key === 'activate' ? 'default' : 'outline'} size="sm" onClick={item.onSelect} className={item.danger ? 'border-danger/40 text-danger hover:bg-danger-soft' : undefined}>
            {item.icon} {item.label}
          </Button>
        ))}
        {allowed.deactivateBlocked && (
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center">
            <Button variant="outline" size="sm" disabled aria-disabled="true" aria-describedby={`primary-note-${location.locationId}`}>
              <PauseCircle /> Deactivate
            </Button>
            <span id={`primary-note-${location.locationId}`} className="text-[13px] text-muted">
              This is the Primary Location. Set another active location as Primary first.
            </span>
            {allowed.choosePrimary && (
              <Button variant="secondary" size="sm" onClick={() => setDialog('choose-primary')}>
                <Crown /> Choose new primary
              </Button>
            )}
          </div>
        )}
      </div>
    );

  return (
    <>
      {trigger}

      <ConfirmDialog
        open={dialog === 'activate'}
        onOpenChange={(o) => !o && close()}
        icon={<Play className="size-5" />}
        title={`${location.status === 'INACTIVE' ? 'Reactivate' : 'Activate'} ${name}?`}
        description={`${name} will become an active location. It can be selected when assigning staff, students and classes across SchoolVerse.`}
        confirmLabel={location.status === 'INACTIVE' ? 'Reactivate location' : 'Activate location'}
        loadingLabel="Activating…"
        onConfirm={run('activate', `${name} is now active.`)}
      />

      <ConfirmDialog
        open={dialog === 'deactivate'}
        onOpenChange={(o) => !o && close()}
        icon={<PauseCircle className="size-5" />}
        title={`Deactivate ${name}?`}
        description={`${name} will no longer be offered for new assignments. Existing records stay exactly as they are, and you can reactivate it any time.`}
        confirmLabel="Deactivate location"
        loadingLabel="Deactivating…"
        onConfirm={run('deactivate', `${name} has been deactivated.`)}
      />

      <ConfirmDialog
        open={dialog === 'archive'}
        onOpenChange={(o) => !o && close()}
        tone="danger"
        icon={<Archive className="size-5" />}
        title={`Archive ${name}?`}
        description={`Archived locations are kept for history only. ${name} can’t be edited, reactivated or used for new assignments, and its code stays reserved.`}
        confirmLabel="Archive location"
        loadingLabel="Archiving…"
        onConfirm={run('archive', 'Location archived successfully.')}
      >
        {dependencies.length > 0 && (
          <Alert tone="warning" title="This location can’t be archived yet">
            <p>Active records are still associated with it. Move or close these first:</p>
            <ul className="mt-2 space-y-1" aria-label="Blocking dependencies">
              {dependencies.map((d) => (
                <li key={d.key} className="flex items-start gap-2">
                  <span className="mt-0.5 grid min-w-6 place-items-center rounded-md bg-warning/15 px-1.5 text-xs font-bold text-warning">{d.count}</span>
                  <span>
                    <span className="font-semibold text-ink">{d.label}</span>
                    <span className="block text-muted">{d.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          </Alert>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={dialog === 'primary'}
        onOpenChange={(o) => !o && close()}
        icon={<Crown className="size-5" />}
        title={`Make ${name} the Primary Location?`}
        description={`${currentPrimaryName ?? 'The current Primary Location'} will stop being Primary. A school has exactly one Primary Location, and the switch happens in one step.`}
        confirmLabel="Set as Primary"
        loadingLabel="Switching…"
        onConfirm={async () => {
          await primary.mutateAsync(location.locationId);
          toast.success(`${name} is now the Primary Location.`);
        }}
      />

      <ConfirmDialog
        open={dialog === 'discard'}
        onOpenChange={(o) => !o && close()}
        tone="danger"
        icon={<Trash2 className="size-5" />}
        title={`Discard draft ${name}?`}
        description="The draft will be permanently deleted. This can’t be undone."
        confirmLabel="Discard draft"
        loadingLabel="Discarding…"
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success(`Draft ${name} was discarded.`);
          onDiscarded?.();
        }}
      />

      <ChoosePrimaryDialog
        open={dialog === 'choose-primary'}
        onOpenChange={(o) => !o && close()}
        schoolId={schoolId}
        excludeId={location.locationId}
        chosen={chosen}
        setChosen={setChosen}
        onConfirm={async (target, targetName) => {
          await primary.mutateAsync(target);
          toast.success(`${targetName} is now the Primary Location.`);
        }}
      />
    </>
  );
}

function ChoosePrimaryDialog({
  open,
  onOpenChange,
  schoolId,
  excludeId,
  chosen,
  setChosen,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  schoolId: string;
  excludeId: string;
  chosen: string | null;
  setChosen: (id: string | null) => void;
  onConfirm: (id: string, name: string) => Promise<void>;
}) {
  const list = useLocations(open ? schoolId : undefined, { status: 'ACTIVE', pageSize: 100 });
  const candidates = (list.data?.items ?? []).filter((l) => l.locationId !== excludeId);
  const target = candidates.find((l) => l.locationId === chosen);

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      icon={<Crown className="size-5" />}
      title="Choose a new Primary Location"
      description="Pick an active location to become Primary. Then you can deactivate this one if you need to."
      confirmLabel="Set as Primary"
      loadingLabel="Switching…"
      onConfirm={async () => {
        if (!target) throw new Error('Choose a location first.');
        await onConfirm(target.locationId, target.displayName);
      }}
    >
      {list.isLoading ? (
        <p className="text-sm text-muted">Loading active locations…</p>
      ) : candidates.length === 0 ? (
        <Alert tone="warning" title="No other active location">
          Activate another location first, then make it Primary.
        </Alert>
      ) : (
        <fieldset>
          <legend className="sr-only">Active locations</legend>
          <div className="space-y-2">
            {candidates.map((l) => (
              <label key={l.locationId} className="flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border border-line px-3.5 py-2.5 has-[:checked]:border-brand has-[:checked]:bg-brand-soft">
                <input type="radio" name="new-primary" className="size-4 accent-[#244fd4]" checked={chosen === l.locationId} onChange={() => setChosen(l.locationId)} />
                <span className="text-sm font-semibold">{l.displayName}</span>
                <span className="ml-auto font-mono text-xs text-muted">{l.locationCode}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </ConfirmDialog>
  );
}
