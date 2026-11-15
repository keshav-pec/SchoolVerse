import type { ComponentType } from 'react';
import { SESSION_STATUS_LABELS, type SessionStatus } from '@shared';
import { Archive, CircleCheck, Lock, PencilLine, Send } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const META: Record<SessionStatus, { tone: 'neutral' | 'brand' | 'success' | 'warning'; Icon: ComponentType<{ 'aria-hidden'?: boolean }> }> = {
  DRAFT: { tone: 'neutral', Icon: PencilLine },
  PUBLISHED: { tone: 'brand', Icon: Send },
  ACTIVE: { tone: 'success', Icon: CircleCheck },
  CLOSED: { tone: 'warning', Icon: Lock },
  ARCHIVED: { tone: 'neutral', Icon: Archive },
};

/** Status is a word plus an icon, never colour alone. */
export function SessionPill({ status }: { status: SessionStatus }) {
  const { tone, Icon } = META[status];
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden />
      {SESSION_STATUS_LABELS[status]}
    </Badge>
  );
}
