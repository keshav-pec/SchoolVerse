import { useSearchParams, Link, useNavigate } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import type { ActivationCheckDTO } from '@shared';
import { KeyRound, LinkIcon, PartyPopper } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';
import { NewPasswordForm } from './new-password-form';

export function InvalidLink({
  title = 'This link is not valid any more',
  children,
}: {
  title?: string;
  children?: string;
}) {
  return (
    <div>
      <span className="grid size-12 place-items-center rounded-2xl bg-warning-soft text-warning">
        <LinkIcon className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-[28px] leading-tight font-extrabold">{title}</h1>
      <p className="mt-2 text-[15px] text-muted">
        {children ??
          'Links work once and expire after a few days. Ask your School Admin to send you a new one.'}
      </p>
      <Button asChild variant="outline" className="mt-6">
        <Link to="/login">Back To Sign In</Link>
      </Button>
    </div>
  );
}

/** `/activate?token=…`: a new person chooses their own password. The admin never sees or sets one. */
export function ActivatePage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const check = useQuery({
    queryKey: ['activation', token],
    queryFn: () => api.get<ActivationCheckDTO>(`/auth/activation/${encodeURIComponent(token)}`),
    enabled: token.length > 0,
    retry: false,
  });

  if (!token || check.isError) return <InvalidLink />;
  if (check.isLoading) {
    return (
      <div role="status" aria-label="Checking your link" className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-80" />
        <Skeleton className="h-11 w-full" />
      </div>
    );
  }

  return (
    <div>
      <span className="grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand">
        <KeyRound className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-[28px] leading-tight font-extrabold">
        Welcome, {check.data?.firstName} 👋
      </h1>
      <p className="mt-2 text-[15px] text-muted">
        Choose a password to activate your SchoolVerse account.
      </p>
      <NewPasswordForm
        submitLabel={
          <>
            <PartyPopper /> Activate my account
          </>
        }
        loadingLabel="Activating…"
        onSubmit={async (password) => {
          await api.post('/auth/activate', { token, password });
          toast.success('Your account is active. Sign in with your new password.');
          navigate('/login', { replace: true });
        }}
        footer={
          <Alert tone="info">
            Your School Admin never sees this password. If you ever forget it, use{' '}
            <strong>Forgot password</strong> on the sign-in page.
          </Alert>
        }
      />
    </div>
  );
}
