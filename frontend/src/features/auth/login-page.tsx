import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, ROLE_LABELS, type LoginInput, type Role } from '@shared';
import { ArrowRight, FlaskConical } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PasswordField, TextField } from '@/components/ui/field';
import { useAuth } from '@/lib/auth';
import { applyServerErrors } from '@/lib/errors';
import { firstName } from '@/lib/utils';

const DEMO_ACCOUNTS: { email: string; role: Role }[] = [
  { email: 'admin@greenfield.demo', role: 'SCHOOL_ADMIN' },
  { email: 'faculty@greenfield.demo', role: 'FACULTY' },
  { email: 'staff@greenfield.demo', role: 'STAFF' },
  { email: 'parent@greenfield.demo', role: 'PARENT' },
];
const DEMO_PASSWORD = 'Welcome@123';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = (location.state as { from?: string } | null)?.from ?? '/';
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema), defaultValues: { email: '', password: '' } });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const session = await login(values);
      toast.success(`Welcome back, ${firstName(session.user.fullName)}! 👋`);
      navigate(from, { replace: true });
    } catch (err) {
      setFormError(applyServerErrors(err, setError, ['email', 'password']));
    }
  });

  return (
    <div>
      <h1 className="text-[30px] leading-tight font-extrabold">Welcome back 👋</h1>
      <p className="mt-2 text-[15px] text-muted">Sign in to your SchoolVerse workspace.</p>

      <form onSubmit={onSubmit} noValidate className="mt-8 space-y-5">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <TextField label="Email" type="email" autoComplete="email" autoFocus required placeholder="you@school.edu" error={errors.email?.message} {...register('email')} />
        <PasswordField
          label="Password"
          autoComplete="current-password"
          required
          error={errors.password?.message}
          {...register('password')}
        />
        <Button type="submit" size="lg" className="w-full" loading={isSubmitting} loadingText="Signing you in…">
          Sign in <ArrowRight />
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        New to SchoolVerse?{' '}
        <Link to="/signup" className="font-semibold text-brand hover:underline">
          Create your school workspace
        </Link>
      </p>

      {/* {import.meta.env.DEV && ( */}
      <div className="mt-8 rounded-2xl border border-dashed border-lavender/50 bg-lavender-soft/60 p-4">
        <p className="flex items-center gap-2 text-sm font-semibold text-[#5b4bd1]">
          <FlaskConical className="size-4" /> Demo accounts <span className="font-normal text-muted">(testing purpose only)</span>
        </p>
        <div className="mt-3 grid grid-cols-2 gap-2">
          {DEMO_ACCOUNTS.map((a) => (
            <button
              key={a.email}
              type="button"
              onClick={() => {
                setValue('email', a.email, { shouldValidate: true });
                setValue('password', DEMO_PASSWORD, { shouldValidate: true });
              }}
              className="rounded-lg border border-line bg-white px-3 py-2 text-left text-xs transition hover:-translate-y-px hover:border-lavender hover:shadow-card"
            >
              <span className="block font-semibold text-ink">{ROLE_LABELS[a.role]}</span>
              <span className="block truncate text-muted">{a.email}</span>
            </button>
          ))}
        </div>
      </div>
      {/* )} */}
    </div>
  );
}
