import { Link } from 'react-router';
import { FlaskConical } from 'lucide-react';
import { SHOW_DEV_OUTBOX } from '@/lib/dev';

/** Test builds have no email provider. This points to the page that shows the emails the app would have sent. */
export function DevOutboxHint({ email }: { email?: string }) {
  if (!SHOW_DEV_OUTBOX) return null;
  return (
    <p className="mt-8 flex items-start gap-2 rounded-xl border border-dashed border-lavender/50 bg-lavender-soft/60 px-3.5 py-3 text-[13px] text-muted">
      <FlaskConical className="mt-0.5 size-4 shrink-0 text-[#5b4bd1]" aria-hidden="true" />
      <span>
        Testing build: no email is sent.{' '}
        <Link
          to={email ? `/dev/outbox?to=${encodeURIComponent(email)}` : '/dev/outbox'}
          className="font-semibold text-brand hover:underline"
        >
          Open the dev outbox
        </Link>{' '}
        to see the link.
      </span>
    </p>
  );
}
