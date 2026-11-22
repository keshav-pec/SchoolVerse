import type { ComponentType } from 'react';
import {
  STUDENT_STATUS_LABELS,
  type ClassSectionDTO,
  type StudentStatus,
} from '@shared';
import { CircleCheck, CircleSlash, DoorOpen, FilePen, GraduationCap, Hourglass, PauseCircle } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'brand';
const META: Record<StudentStatus, { tone: Tone; Icon: ComponentType<{ 'aria-hidden'?: boolean }> }> = {
  DRAFT: { tone: 'neutral', Icon: FilePen },
  ADMISSION_PENDING: { tone: 'warning', Icon: Hourglass },
  ACTIVE: { tone: 'success', Icon: CircleCheck },
  INACTIVE: { tone: 'warning', Icon: PauseCircle },
  WITHDRAWAL_INITIATED: { tone: 'warning', Icon: DoorOpen },
  WITHDRAWN: { tone: 'neutral', Icon: CircleSlash },
  TRANSFERRED_OUT: { tone: 'neutral', Icon: DoorOpen },
  COMPLETED_SCHOOLING: { tone: 'brand', Icon: GraduationCap },
};

/** Status is always a word and an icon, never colour alone. */
export function StudentStatusPill({ status }: { status: StudentStatus }) {
  const { tone, Icon } = META[status];
  return (
    <Badge tone={tone} data-status={status}>
      <Icon aria-hidden />
      {STUDENT_STATUS_LABELS[status]}
    </Badge>
  );
}

/** "VIII-A · Roll 17", or what is still missing. */
export function placementText(classSection: ClassSectionDTO | null, rollNumber: string | null): string {
  if (!classSection) return 'No class yet';
  return `${classSection.label}${rollNumber ? ` · Roll ${rollNumber}` : ''}`;
}

export const todayIso = () => new Date().toLocaleDateString('en-CA');

export function fullName(first: string, last: string) {
  return `${first} ${last}`.trim();
}
