import type { ComponentType } from 'react';
import { Archive, Ban, CircleCheck, Clock, FileCheck2, FilePen, Hourglass, Lock, LockOpen, PauseCircle, SkipForward, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

type Tone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger' | 'sun';
interface Meta {
  label: string;
  tone: Tone;
  Icon: ComponentType<{ 'aria-hidden'?: boolean }>;
}

/** One word and one colour for each state, the same on every finance screen. A state is always a word and an icon, never colour alone. */
const META: Record<string, Meta> = {
  DRAFT: { label: 'Draft', tone: 'neutral', Icon: FilePen },
  VALIDATED: { label: 'Checked', tone: 'brand', Icon: FileCheck2 },
  APPROVED: { label: 'Approved', tone: 'brand', Icon: FileCheck2 },
  PUBLISHED: { label: 'Published', tone: 'success', Icon: CircleCheck },
  SUPERSEDED: { label: 'Replaced', tone: 'neutral', Icon: Archive },
  ARCHIVED: { label: 'Archived', tone: 'neutral', Icon: Archive },
  ISSUED: { label: 'Issued', tone: 'brand', Icon: FileCheck2 },
  PARTIALLY_SETTLED: { label: 'Part Paid', tone: 'sun', Icon: Clock },
  SETTLED: { label: 'Paid', tone: 'success', Icon: CircleCheck },
  CANCELLED: { label: 'Cancelled', tone: 'neutral', Icon: Ban },
  OVERDUE: { label: 'Overdue', tone: 'danger', Icon: TriangleAlert },
  PENDING: { label: 'Waiting', tone: 'sun', Icon: Hourglass },
  REJECTED: { label: 'Rejected', tone: 'danger', Icon: Ban },
  USED: { label: 'Used', tone: 'neutral', Icon: CircleCheck },
  ENDED: { label: 'Ended', tone: 'neutral', Icon: PauseCircle },
  READY: { label: 'Ready', tone: 'success', Icon: CircleCheck },
  NEEDS_ATTENTION: { label: 'Needs a Look', tone: 'warning', Icon: TriangleAlert },
  SKIPPED: { label: 'Skipped', tone: 'neutral', Icon: SkipForward },
  ACTIVE: { label: 'Active', tone: 'success', Icon: CircleCheck },
  INACTIVE: { label: 'Inactive', tone: 'neutral', Icon: PauseCircle },
  OPEN: { label: 'Open', tone: 'success', Icon: LockOpen },
  CLOSED: { label: 'Closed', tone: 'sun', Icon: Lock },
  LOCKED: { label: 'Locked', tone: 'neutral', Icon: Lock },
};

export function FinanceStatusPill({ status }: { status: string }) {
  const meta = META[status] ?? { label: status, tone: 'neutral' as const, Icon: Clock };
  return (
    <Badge tone={meta.tone} data-status={status}>
      <meta.Icon aria-hidden />
      {meta.label}
    </Badge>
  );
}
