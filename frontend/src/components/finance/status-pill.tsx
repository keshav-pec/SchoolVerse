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
  // money coming in (Part 4)
  REPORTED: { label: 'Reported', tone: 'sun', Icon: Hourglass },
  RECEIVED: { label: 'Received', tone: 'brand', Icon: FileCheck2 },
  DEPOSITED: { label: 'Deposited', tone: 'sun', Icon: Clock },
  PENDING_VERIFICATION: { label: 'Waiting for Check', tone: 'sun', Icon: Hourglass },
  VERIFIED: { label: 'Verified', tone: 'success', Icon: CircleCheck },
  POSTED: { label: 'Received', tone: 'success', Icon: CircleCheck },
  CLEARED: { label: 'Cleared', tone: 'success', Icon: CircleCheck },
  RETURNED: { label: 'Returned', tone: 'danger', Icon: Ban },
  REVERSED: { label: 'Reversed', tone: 'neutral', Icon: Ban },
  REQUESTED: { label: 'Requested', tone: 'sun', Icon: Hourglass },
  ELIGIBLE: { label: 'Can Claim', tone: 'success', Icon: CircleCheck },
  NOT_ELIGIBLE: { label: 'Not Claimed', tone: 'neutral', Icon: Ban },
  NEEDS_REVIEW: { label: 'Decide Later', tone: 'warning', Icon: TriangleAlert },
  PAID: { label: 'Paid', tone: 'success', Icon: CircleCheck },
  SIGNED_OFF: { label: 'Signed Off', tone: 'success', Icon: CircleCheck },
  // payroll
  CALCULATED: { label: 'Calculated', tone: 'brand', Icon: FileCheck2 },
  FINALIZED: { label: 'Finalised', tone: 'success', Icon: Lock },
  UNPAID: { label: 'Unpaid', tone: 'danger', Icon: Clock },
  PARTIALLY_PAID: { label: 'Part Paid', tone: 'sun', Icon: Clock },
  NEEDS_ACTION: { label: 'Needs Action', tone: 'warning', Icon: TriangleAlert },
  HELD: { label: 'On Hold', tone: 'neutral', Icon: PauseCircle },
  BUILT: { label: 'File Made', tone: 'brand', Icon: FilePen },
  RECORDED: { label: 'Recorded', tone: 'sun', Icon: Hourglass },
  FAILED: { label: 'Failed', tone: 'danger', Icon: Ban },
  PAID_OUT: { label: 'Paid Out', tone: 'brand', Icon: CircleCheck },
  APPLIED: { label: 'Applied', tone: 'success', Icon: CircleCheck },
  // bank lines
  UNMATCHED: { label: 'Not Matched', tone: 'warning', Icon: TriangleAlert },
  SUGGESTED: { label: 'Suggested', tone: 'sun', Icon: Hourglass },
  AUTO_MATCHED: { label: 'Matched', tone: 'success', Icon: CircleCheck },
  VERIFIED_MATCHED: { label: 'Matched', tone: 'success', Icon: CircleCheck },
  CONFIRMED: { label: 'Matched', tone: 'success', Icon: CircleCheck },
  PARTIAL: { label: 'Part Matched', tone: 'sun', Icon: Clock },
  DUPLICATE_SUSPECTED: { label: 'Maybe a Duplicate', tone: 'danger', Icon: TriangleAlert },
  VARIANCE: { label: 'Amount Differs', tone: 'danger', Icon: TriangleAlert },
  IGNORED: { label: 'Ignored', tone: 'neutral', Icon: SkipForward },
};

/** `label` replaces the word when one state means something else on a screen (a refund that is ELIGIBLE is "Ready to Approve"). */
export function FinanceStatusPill({ status, label }: { status: string; label?: string }) {
  const meta = META[status] ?? { label: status, tone: 'neutral' as const, Icon: Clock };
  return (
    <Badge tone={meta.tone} data-status={status}>
      <meta.Icon aria-hidden />
      {label ?? meta.label}
    </Badge>
  );
}
