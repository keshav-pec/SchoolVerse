import { Link, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, FlaskConical, Mail, RefreshCw } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { messageFor } from '@/lib/errors';

interface OutboxItem {
  to: string;
  template: 'ACTIVATION' | 'PASSWORD_RESET';
  link: string;
  createdAt: string;
}

const TEMPLATE_LABELS = {
  ACTIVATION: 'Activate your account',
  PASSWORD_RESET: 'Reset your password',
} as const;

/**
 * `/dev/outbox`: the emails the API would have sent, newest first. Testing builds only (the API serves this list
 * only while `DEV_OUTBOX` is on). A link is a credential, so this must never be on for a school with real people.
 */
export function DevOutboxPage() {
  const [params] = useSearchParams();
  const to = params.get('to') ?? '';
  const q = useQuery({
    queryKey: ['dev-outbox', to],
    queryFn: () =>
      api.get<{ items: OutboxItem[] }>(`/dev/outbox${to ? `?to=${encodeURIComponent(to)}` : ''}`),
    retry: false,
  });
  const items = q.data?.items ?? [];

  return (
    <div className="mx-auto min-h-dvh max-w-2xl px-5 py-10">
      <Link
        to="/login"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand"
      >
        <ArrowLeft className="size-4" /> Back to sign in
      </Link>
      <h1 className="flex items-center gap-2.5 text-[28px] font-extrabold">
        <FlaskConical className="size-7 text-lavender" aria-hidden="true" /> Dev outbox
      </h1>
      <p className="mt-1.5 text-[15px] text-muted">
        Testing builds send no email. Open a link below as if you had received it
        {to ? (
          <>
            {' '}
            (filtered to <strong className="text-ink">{to}</strong>)
          </>
        ) : null}
        .
      </p>
      <Alert tone="warning" className="mt-5" title="For testing only">
        Anyone who can open this page can use these links. Keep this switched off for a school with
        real people.
      </Alert>

      <div className="mt-6 flex items-center justify-between">
        <h2 className="text-sm font-bold tracking-wide text-muted uppercase">Latest messages</h2>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void q.refetch()}
          loading={q.isFetching}
          loadingText="Refreshing…"
        >
          <RefreshCw /> Refresh
        </Button>
      </div>

      <div className="mt-3">
        {q.isLoading ? (
          <div role="status" aria-label="Loading messages" className="space-y-3">
            <Skeleton className="h-20 rounded-card" />
            <Skeleton className="h-20 rounded-card" />
          </div>
        ) : q.isError ? (
          <Alert tone="danger">{messageFor(q.error)}</Alert>
        ) : items.length === 0 ? (
          <EmptyState
            illustration={<Mail className="size-12 text-muted" aria-hidden="true" />}
            title="No messages yet"
            description="Create a login or ask for a password reset, then refresh."
          />
        ) : (
          <ul className="space-y-3" aria-label="Messages">
            {items.map((m) => (
              <li key={m.link} className="rounded-card border border-line bg-white p-4 shadow-card">
                <p className="text-sm font-semibold">{TEMPLATE_LABELS[m.template]}</p>
                <p className="text-[13px] text-muted">
                  To {m.to} · {formatDateTime(m.createdAt)}
                </p>
                <a
                  href={m.link}
                  className="mt-2 block text-sm font-semibold break-all text-brand hover:underline"
                >
                  {m.link}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
