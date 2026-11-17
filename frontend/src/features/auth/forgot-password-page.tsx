import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema, type ForgotPasswordData } from '@shared';
import { ArrowLeft, MailCheck, Send } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { DevOutboxHint } from './dev-outbox-hint';

/** Always the same confirmation, whether or not the email belongs to an account. */
export function ForgotPasswordPage() {
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordData>({
    resolver: zodResolver(forgotPasswordSchema),
    defaultValues: { email: '' },
  });

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await api.post('/auth/forgot-password', values);
      setSentTo(values.email);
    } catch (err) {
      setFormError(messageFor(err));
    }
  });

  return (
    <div>
      <Link
        to="/login"
        className="mb-6 inline-flex items-center gap-1.5 text-sm font-semibold text-muted hover:text-brand"
      >
        <ArrowLeft className="size-4" /> Back to sign in
      </Link>
      {sentTo ? (
        <div role="status">
          <span className="grid size-12 place-items-center rounded-2xl bg-success-soft text-success">
            <MailCheck className="size-6" aria-hidden="true" />
          </span>
          <h1 className="mt-4 text-[28px] leading-tight font-extrabold">Check your email</h1>
          <p className="mt-2 text-[15px] text-muted">
            If <strong className="text-ink">{sentTo}</strong> belongs to an account, a reset link is
            on its way. It works once and expires in 30 minutes.
          </p>
          <DevOutboxHint email={sentTo} />
        </div>
      ) : (
        <>
          <h1 className="text-[28px] leading-tight font-extrabold">Forgot your password?</h1>
          <p className="mt-2 text-[15px] text-muted">
            Enter your email and we’ll send you a link to choose a new one.
          </p>
          <form onSubmit={submit} noValidate className="mt-8 space-y-5">
            {formError && <Alert tone="danger">{formError}</Alert>}
            <TextField
              label="Email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              placeholder="you@school.edu"
              error={errors.email?.message}
              {...register('email')}
            />
            <Button
              type="submit"
              size="lg"
              className="w-full"
              loading={isSubmitting}
              loadingText="Sending…"
            >
              <Send /> Send reset link
            </Button>
          </form>
          <DevOutboxHint />
        </>
      )}
    </div>
  );
}
