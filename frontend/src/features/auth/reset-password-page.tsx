import { Link, useNavigate, useSearchParams } from 'react-router';
import { LockKeyhole } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { InvalidLink } from './activate-page';
import { NewPasswordForm } from './new-password-form';

/** `/reset-password?token=…`: a new password. Every other session of the account is signed out. */
export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  if (!token) return <InvalidLink />;

  return (
    <div>
      <span className="grid size-12 place-items-center rounded-2xl bg-brand-soft text-brand">
        <LockKeyhole className="size-6" aria-hidden="true" />
      </span>
      <h1 className="mt-4 text-[28px] leading-tight font-extrabold">Choose a new password</h1>
      <p className="mt-2 text-[15px] text-muted">
        You’ll be signed out everywhere else once it’s changed.
      </p>
      <NewPasswordForm
        submitLabel="Change password"
        loadingLabel="Changing…"
        onSubmit={async (password) => {
          await api.post('/auth/reset-password', { token, password });
          toast.success('Password changed. Sign in with the new one.');
          navigate('/login', { replace: true });
        }}
        footer={
          <p className="text-center text-sm text-muted">
            Link not working?{' '}
            <Link to="/forgot-password" className="font-semibold text-brand hover:underline">
              Ask for a new one
            </Link>
          </p>
        }
      />
    </div>
  );
}
