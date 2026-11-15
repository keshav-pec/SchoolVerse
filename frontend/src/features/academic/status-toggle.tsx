import { CircleCheck, PauseCircle } from 'lucide-react';
import type { OfferingStatus } from '@shared';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';

/** Active / Inactive pill. A button when it can be toggled, a plain badge when it can't. */
export function StatusToggle({ status, onToggle, disabled, label }: { status: OfferingStatus; onToggle?: () => void; disabled?: boolean; label: string }) {
  const active = status === 'ACTIVE';
  const pill = (
    <Badge tone={active ? 'success' : 'warning'}>
      {active ? <CircleCheck aria-hidden /> : <PauseCircle aria-hidden />}
      {active ? 'Active' : 'Inactive'}
    </Badge>
  );
  if (!onToggle || disabled) return pill;
  return (
    <button type="button" onClick={onToggle} aria-label={`${active ? 'Deactivate' : 'Activate'} ${label}`} className={cn('rounded-pill outline-none focus-visible:ring-4 focus-visible:ring-brand/25')}>
      {pill}
    </button>
  );
}
