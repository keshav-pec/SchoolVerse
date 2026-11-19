import { useId, useState, type ComponentProps, type ReactNode } from 'react';
import { CircleAlert, Eye, EyeOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useController, type Control, type FieldValues, type Path } from 'react-hook-form';
import { Combobox, type ComboboxProps } from './combobox';
import { Input } from './input';
import { Textarea } from './textarea';

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

type FieldBase = { label: string; hint?: ReactNode; error?: string; labelAside?: ReactNode; containerClassName?: string };

function describedBy(id: string, error?: string, hint?: ReactNode) {
  return error ? `${id}-error` : hint ? `${id}-hint` : undefined;
}

export function TextareaField({ label, hint, error, labelAside, id, required, containerClassName, ...props }: FieldBase & ComponentProps<'textarea'>) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell id={fieldId} label={label} required={required} hint={hint} error={error} labelAside={labelAside} className={containerClassName}>
      <Textarea id={fieldId} aria-required={required || undefined} aria-invalid={!!error || undefined} aria-describedby={describedBy(fieldId, error, hint)} {...props} />
    </FieldShell>
  );
}

type ComboboxFieldProps = FieldBase & Omit<ComboboxProps, 'invalid' | 'describedBy' | 'aria-label'>;

/** Labelled dropdown. The standard for every pick-one field (time zone is the reference). */
export function ComboboxField({ label, hint, error, labelAside, id, required, containerClassName, ...props }: ComboboxFieldProps) {
  const generated = useId();
  const fieldId = id ?? generated;
  return (
    <FieldShell id={fieldId} label={label} required={required} hint={hint} error={error} labelAside={labelAside} className={containerClassName}>
      <Combobox id={fieldId} required={required} invalid={!!error} describedBy={describedBy(fieldId, error, hint)} {...props} />
    </FieldShell>
  );
}

/** `ComboboxField` bound to a react-hook-form field (the dropdown twin of `{...register(name)}`). */
export function FormComboboxField<T extends FieldValues>({
  control,
  name,
  ...props
}: Omit<ComboboxFieldProps, 'value' | 'onChange' | 'onBlur'> & { control: Control<T>; name: Path<T> }) {
  const { field } = useController({ control, name });
  return <ComboboxField {...props} value={(field.value as string | null | undefined) ?? ''} onChange={field.onChange} onBlur={field.onBlur} />;
}
