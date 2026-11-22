import type { ComponentType } from 'react';
import { SPACE_STATUS_LABELS, STRUCTURE_STATUS_LABELS, type SpaceDTO, type SpaceStatus, type StructureStatus } from '@shared';
import { Archive, CircleCheck, Lock, PauseCircle, PencilLine, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Tone = 'neutral' | 'success' | 'warning' | 'danger';
type Meta = { tone: Tone; Icon: ComponentType<{ 'aria-hidden'?: boolean }> };

const SPACE_META: Record<SpaceStatus, Meta> = {
  DRAFT: { tone: 'neutral', Icon: PencilLine },
  ACTIVE: { tone: 'success', Icon: CircleCheck },
  TEMPORARILY_UNAVAILABLE: { tone: 'warning', Icon: PauseCircle },
  RESTRICTED: { tone: 'warning', Icon: Lock },
  INACTIVE: { tone: 'warning', Icon: PauseCircle },
  ARCHIVED: { tone: 'neutral', Icon: Archive },
};

/** Status is always a word and an icon, never colour alone. A room under a closed floor says so. */
export function SpaceStatusPill({ space }: { space: Pick<SpaceDTO, 'status' | 'effectiveStatus'> }) {
  const blocked = space.status === 'ACTIVE' && !space.effectiveStatus.available;
  const meta = blocked ? { tone: 'danger' as Tone, Icon: TriangleAlert } : SPACE_META[space.status];
  return (
    <Badge tone={meta.tone} data-status={space.status} title={space.effectiveStatus.reason ?? undefined}>
      <meta.Icon aria-hidden />
      {blocked ? 'Unavailable' : SPACE_STATUS_LABELS[space.status]}
    </Badge>
  );
}

const DOT: Record<StructureStatus, string> = { DRAFT: 'bg-muted', ACTIVE: 'bg-success', INACTIVE: 'bg-warning', ARCHIVED: 'bg-muted/60' };

/** The small coloured dot in the tree. The word is there for screen readers. */
export function StatusDot({ status, unavailable }: { status: StructureStatus; unavailable?: boolean }) {
  return (
    <>
      <span aria-hidden="true" className={`size-2 shrink-0 rounded-full ${unavailable ? 'bg-danger' : DOT[status]}`} />
      <span className="sr-only">{unavailable ? 'Unavailable' : STRUCTURE_STATUS_LABELS[status]}</span>
    </>
  );
}

/** "Main Block › First Floor". Outdoor spaces have no building. */
export function whereOf(space: Pick<SpaceDTO, 'building' | 'floor'>): string {
  if (!space.building) return 'Outdoor';
  return [space.building.buildingName, space.floor?.floorName].filter(Boolean).join(' › ');
}

export function seatsText(space: Pick<SpaceDTO, 'academicCapacity'>): string {
  return space.academicCapacity.value === null ? '—' : String(space.academicCapacity.value);
}
