import type { ComponentType } from 'react';
import {
  ASSIGNMENT_STATUS_LABELS,
  EMPLOYEE_STATUS_LABELS,
  type AssignmentStatus,
  type EmployeeStatus,
  type UserStatus,
} from '@shared';
import {
  CalendarClock,
  CircleCheck,
  CircleSlash,
  DoorOpen,
  Hourglass,
  PauseCircle,
  Sparkles,
  UserCheck,
  UserX,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand';
type Meta = { label: string; tone: Tone; Icon: ComponentType<{ 'aria-hidden'?: boolean }> };

const EMPLOYEE_META: Record<EmployeeStatus, Meta> = {
  ONBOARDING: { label: EMPLOYEE_STATUS_LABELS.ONBOARDING, tone: 'brand', Icon: Sparkles },
  ACTIVE: { label: EMPLOYEE_STATUS_LABELS.ACTIVE, tone: 'success', Icon: CircleCheck },
  ON_LEAVE: { label: EMPLOYEE_STATUS_LABELS.ON_LEAVE, tone: 'warning', Icon: PauseCircle },
  SUSPENDED: { label: EMPLOYEE_STATUS_LABELS.SUSPENDED, tone: 'danger', Icon: CircleSlash },
  NOTICE_PERIOD: { label: EMPLOYEE_STATUS_LABELS.NOTICE_PERIOD, tone: 'warning', Icon: Hourglass },
  EXITED: { label: EMPLOYEE_STATUS_LABELS.EXITED, tone: 'neutral', Icon: DoorOpen },
};

const ASSIGNMENT_META: Record<AssignmentStatus, Meta> = {
  PLANNED: { label: ASSIGNMENT_STATUS_LABELS.PLANNED, tone: 'brand', Icon: CalendarClock },
  ACTIVE: { label: ASSIGNMENT_STATUS_LABELS.ACTIVE, tone: 'success', Icon: CircleCheck },
  COMPLETED: { label: ASSIGNMENT_STATUS_LABELS.COMPLETED, tone: 'neutral', Icon: UserCheck },
  CANCELLED: { label: ASSIGNMENT_STATUS_LABELS.CANCELLED, tone: 'neutral', Icon: UserX },
};

const USER_META: Record<UserStatus, Meta> = {
  PENDING_ACTIVATION: { label: 'Waiting to activate', tone: 'warning', Icon: Hourglass },
  ACTIVE: { label: 'Active', tone: 'success', Icon: CircleCheck },
  SUSPENDED: { label: 'Suspended', tone: 'danger', Icon: PauseCircle },
  DISABLED: { label: 'Disabled', tone: 'neutral', Icon: CircleSlash },
};

/** Status is always a word and an icon, never colour alone. */
export function EmployeeStatusPill({ status }: { status: EmployeeStatus }) {
  const { label, tone, Icon } = EMPLOYEE_META[status];
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

export function AssignmentStatusChip({ status }: { status: AssignmentStatus }) {
  const { label, tone, Icon } = ASSIGNMENT_META[status];
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}

export function UserStatusPill({ status }: { status: UserStatus }) {
  const { label, tone, Icon } = USER_META[status];
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden />
      {label}
    </Badge>
  );
}
