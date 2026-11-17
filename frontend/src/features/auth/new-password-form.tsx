import { useState, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { passwordSchema } from '@shared';
import { z } from 'zod';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { PasswordField } from '@/components/ui/field';
import { PasswordStrength } from '@/components/sv/password-strength';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';

const schema = z
  .object({
    password: passwordSchema,
    confirm: z.string().min(1, { message: 'Type the password again.' }),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'The two passwords do not match.',
    path: ['confirm'],
  });
type Values = z.infer<typeof schema>;

/** Choose a password (activation and reset). The same form, with the same strength hints as sign-up. */
export function NewPasswordForm({
  submitLabel,
  loadingLabel,
  onSubmit,
  footer,
}: {
  submitLabel: ReactNode;
  loadingLabel: string;
  onSubmit: (password: string) => Promise<void>;
  footer?: ReactNode;
}) {
  const [formError, setFormError] = useState<{ message: string; invalidLink: boolean } | null>(
    null,
  );
  const {
    register,
    handleSubmit,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { password: '', confirm: '' },
  });

  const submit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      await onSubmit(values.password);
    } catch (err) {
      setFormError({
        message: messageFor(err),
        invalidLink: err instanceof ApiError && err.code === 'TOKEN_INVALID',
      });
    }
  });

  return (
    <form onSubmit={submit} noValidate className="mt-8 space-y-5">
      {formError && <Alert tone="danger">{formError.message}</Alert>}
      <PasswordField
        label="New password"
        autoComplete="new-password"
        autoFocus
        required
        error={errors.password?.message}
        {...register('password')}
      />
      <PasswordStrength value={watch('password')} />
      <PasswordField
        label="Confirm password"
        autoComplete="new-password"
        required
        error={errors.confirm?.message}
        {...register('confirm')}
      />
      <Button
        type="submit"
        size="lg"
        className="w-full"
        loading={isSubmitting}
        loadingText={loadingLabel}
      >
        {submitLabel}
      </Button>
      {footer}
    </form>
  );
}
