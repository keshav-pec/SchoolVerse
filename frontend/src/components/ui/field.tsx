import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from './input';

interface FieldShellProps {
  id: string;
  label: string;
  required?: boolean;
  hint?: ReactNode;
  error?: string;
  labelAside?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Label + control + hint/error, programmatically associated (Quill QuillField pattern). */
export function FieldShell({ id, label, required, hint, error, labelAside, children, className }: FieldShellProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="text-sm font-semibold text-ink">
          {label}
          {required && (
            <span aria-hidden="true" className="ml-0.5 text-danger">
              *
            </span>
          )}
        </label>
        {labelAside}
      </div>
      {children}
      {error ? (
        <p id={`${id}-error`} role="alert" className="flex items-center gap-1.5 text-[13px] font-medium text-danger">
          <CircleAlert className="size-[15px] shrink-0" aria-hidden="true" />
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[13px] text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export type TextFieldProps = ComponentProps<'input'> & {
  label: string;
  hint?: ReactNode;
  error?: string;
  labelAside?: ReactNode;
  containerClassName?: string;
};

export function TextField({ label, hint, error, labelAside, id, required, containerClassName, ...props }: TextFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell id={fieldId} label={label} required={required} hint={hint} error={error} labelAside={labelAside} className={containerClassName}>
      <Input
        id={fieldId}
        aria-required={required || undefined}
        aria-invalid={!!error || undefined}
        aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        {...props}
      />
    </FieldShell>
  );
}

export function PasswordField(props: Omit<TextFieldProps, 'type'>) {
  const [visible, setVisible] = useState(false);
  const generated = useId();
  const fieldId = props.id ?? generated;
  const { label, hint, error, labelAside, required, containerClassName, className, ...rest } = props;
  return (
    <FieldShell id={fieldId} label={label} required={required} hint={hint} error={error} labelAside={labelAside} className={containerClassName}>
      <div className="relative">
        <Input
          {...rest}
          id={fieldId}
          type={visible ? 'text' : 'password'}
          className={cn('pr-11', className)}
          aria-required={required || undefined}
          aria-invalid={!!error || undefined}
          aria-describedby={error ? `${fieldId}-error` : hint ? `${fieldId}-hint` : undefined}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-control text-muted hover:text-ink"
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
        >
          {visible ? <EyeOff className="size-[18px]" /> : <Eye className="size-[18px]" />}
        </button>
      </div>
    </FieldShell>
  );
}
