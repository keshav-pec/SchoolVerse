import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import { signupSchema, type SignupInput } from '@shared';
import { Crown, Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PasswordField, TextField } from '@/components/ui/field';
import { PasswordStrength } from '@/components/sv/password-strength';
import { useAuth } from '@/lib/auth';
import { applyServerErrors } from '@/lib/errors';
import { firstName } from '@/lib/utils';

export function SignupPage() {
  const { signup } = useAuth();
  const navigate = useNavigate();
  const [formError, setFormError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    setError,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
    defaultValues: { workspaceName: '', fullName: '', email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const session = await signup(values);
      toast.success(`Your workspace is ready, ${firstName(session.user.fullName)}! 🎉`);
      navigate('/', { replace: true });
    } catch (err) {
      setFormError(
        applyServerErrors(err, setError, ['workspaceName', 'fullName', 'email', 'password']),
      );
    }
  });

  return (
    <div>
      <h1 className="text-[30px] leading-tight font-extrabold">Let’s set up your school ✨</h1>
      <p className="mt-2 text-[15px] text-muted">
        Create a workspace for your school. It takes about a minute.
      </p>

      <form onSubmit={onSubmit} noValidate className="mt-8 space-y-5">
        {formError && <Alert tone="danger">{formError}</Alert>}
        <TextField
          label="School or group name"
          autoFocus
          required
          placeholder="e.g. Greenfield Public School"
          hint="You can add individual campuses later."
          error={errors.workspaceName?.message}
          {...register('workspaceName')}
        />
        <TextField
          label="Your full name"
          autoComplete="name"
          required
          error={errors.fullName?.message}
          {...register('fullName')}
        />
        <TextField
          label="Work email"
          type="email"
          autoComplete="email"
          required
          placeholder="you@school.edu"
          error={errors.email?.message}
          {...register('email')}
        />
        <PasswordField
          label="Password"
          autoComplete="new-password"
          required
          error={errors.password?.message}
          {...register('password')}
        />
        <PasswordStrength value={watch('password')} />

        <div className="flex items-start gap-2.5 rounded-xl bg-brand-soft px-3.5 py-3 text-[13px] text-ink">
          <Crown className="mt-0.5 size-4 shrink-0 text-brand" aria-hidden="true" />
          <p>
            You’ll be the <strong>School Admin</strong>, with full access to school setup. You can
            invite faculty and staff later.
          </p>
        </div>

        <Button
          type="submit"
          size="lg"
          className="w-full"
          loading={isSubmitting}
          loadingText="Creating your workspace…"
        >
          <Rocket /> Create workspace
        </Button>
      </form>

      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{' '}
        <Link to="/login" className="font-semibold text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
