import type { ComponentType } from 'react';
import { IDENTIFIER_STATUS_LABELS, LOCATION_STATUS_LABELS, type IdentifierStatus, type LocationStatus } from '@shared';
import { Archive, CalendarX2, CircleCheck, History, PauseCircle, PencilLine } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Tone = 'neutral' | 'success' | 'warning' | 'danger';
type Meta = { label: string; tone: Tone; Icon: ComponentType<{ 'aria-hidden'?: boolean }> };

const LOCATION_META: Record<LocationStatus, Meta> = {
  DRAFT: { label: LOCATION_STATUS_LABELS.DRAFT, tone: 'neutral', Icon: PencilLine },
  ACTIVE: { label: LOCATION_STATUS_LABELS.ACTIVE, tone: 'success', Icon: CircleCheck },
  INACTIVE: { label: LOCATION_STATUS_LABELS.INACTIVE, tone: 'warning', Icon: PauseCircle },
  ARCHIVED: { label: LOCATION_STATUS_LABELS.ARCHIVED, tone: 'neutral', Icon: Archive },
};

const IDENTIFIER_META: Record<IdentifierStatus, Meta> = {
  ACTIVE: { label: IDENTIFIER_STATUS_LABELS.ACTIVE, tone: 'success', Icon: CircleCheck },
  EXPIRED: { label: IDENTIFIER_STATUS_LABELS.EXPIRED, tone: 'danger', Icon: CalendarX2 },
  SUPERSEDED: { label: IDENTIFIER_STATUS_LABELS.SUPERSEDED, tone: 'neutral', Icon: History },
};

/** Status is always a word + an icon, never colour alone. */
export function StatusPill({ status, kind = 'location' }: { status: LocationStatus | IdentifierStatus; kind?: 'location' | 'identifier' }) {
  const meta = kind === 'location' ? LOCATION_META[status as LocationStatus] : IDENTIFIER_META[status as IdentifierStatus];
  const { label, tone, Icon } = meta;
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}
