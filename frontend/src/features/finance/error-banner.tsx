import { Link } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';

/** Where to go to fix each finance problem. The wording itself comes from `messageFor`. */
const FIX: Record<string, { label: string; to: string }> = {
  PERIOD_CLOSED: { label: 'Open Years & Periods', to: '/finance/settings?tab=years' },
  TAX_CODE_MISSING: { label: 'Fix Fee Types', to: '/finance/fees?tab=plans' },
  PLAN_CONFLICT: { label: 'Open Fee Plans', to: '/finance/fees?tab=plans' },
  APPROVAL_REQUIRED: { label: 'Open Approvals', to: '/finance/settings?tab=approvals' },
  SELF_APPROVAL_BLOCKED: { label: 'Open Approvals', to: '/finance/settings?tab=approvals' },
};

export const fixFor = (error: unknown) => (error instanceof ApiError ? FIX[error.code] ?? null : null);

/** A finance error in plain words, with a link to the place that fixes it when there is one. */
export function ErrorBanner({ error, className }: { error: unknown; className?: string }) {
  if (error === null || error === undefined) return null;
  const fix = fixFor(error);
  return (
    <Alert tone="danger" className={className}>
      <span>{messageFor(error)}</span>
      {fix && (
        <>
          {' '}
          <Link to={fix.to} className="font-semibold text-brand underline-offset-4 hover:underline">
            {fix.label}
          </Link>
        </>
      )}
    </Alert>
  );
}
