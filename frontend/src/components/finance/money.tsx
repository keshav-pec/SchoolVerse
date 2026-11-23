import { useId, useState, type ReactNode } from 'react';
import { FieldShell } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { formatMoney, paiseToText, toPaise } from '@/lib/money';
import { cn } from '@/lib/utils';

/** An amount in ₹ with lakh/crore commas. A negative amount is red and written with a minus sign. */
export function Money({ paise, className, strong }: { paise: number; className?: string; strong?: boolean }) {
  return <span className={cn('tabular-nums', strong && 'font-bold', paise < 0 && 'text-danger', className)}>{formatMoney(paise)}</span>;
}

/**
 * An amount box. The person types rupees (`1,500.50`); `onChange` gets whole paise, or `null` while the text is empty or is not an
 * amount. A decimal never reaches the API.
 */
export function MoneyField({
  label,
  value,
  onChange,
  hint,
  error,
  labelAside,
  required,
  disabled,
  id,
  containerClassName,
}: {
  label: string;
  /** Whole paise. */
  value: number | null;
  onChange: (paise: number | null) => void;
  hint?: ReactNode;
  error?: string;
  labelAside?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  id?: string;
  containerClassName?: string;
}) {
  const generated = useId();
  const fieldId = id ?? generated;
  const [text, setText] = useState(value === null ? '' : paiseToText(value));
  const [seen, setSeen] = useState(value);
  // The value changed from outside (a reset, a different record): show it, unless the text already means the same amount.
  if (value !== seen) {
    setSeen(value);
    if (toPaise(text) !== value) setText(value === null ? '' : paiseToText(value));
  }
  const bad = text.trim() !== '' && toPaise(text) === null;
  return (
    <FieldShell id={fieldId} label={label} required={required} hint={hint} error={error ?? (bad ? 'Enter an amount like 1500 or 1500.50.' : undefined)} labelAside={labelAside} className={containerClassName}>
      <div className="relative">
        <span className="pointer-events-none absolute inset-y-0 left-3.5 grid place-items-center text-muted" aria-hidden="true">
          ₹
        </span>
        <Input
          id={fieldId}
          inputMode="decimal"
          autoComplete="off"
          className="pl-8"
          value={text}
          disabled={disabled}
          aria-required={required || undefined}
          aria-invalid={!!error || bad || undefined}
          onChange={(e) => {
            setText(e.target.value);
            const next = e.target.value.trim() === '' ? null : toPaise(e.target.value);
            setSeen(next);
            onChange(next);
          }}
        />
      </div>
    </FieldShell>
  );
}
