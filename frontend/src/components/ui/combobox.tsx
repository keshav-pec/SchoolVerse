import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Popover as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { inputClass } from './input';

export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

export interface ComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  invalid?: boolean;
  required?: boolean;
  describedBy?: string;
  /** Accessible name when there is no visible <label> (e.g. filter bars). */
  'aria-label'?: string;
  /** Extra classes for the trigger (sizing such as `h-9 w-44`). */
  className?: string;
  onBlur?: () => void;
}

const MAX_RESULTS = 200;

/** The app's one dropdown: a themed, searchable single-select. Every pick-one field uses it. */
export function Combobox({
  id,
  value,
  onChange,
  options,
  placeholder = 'Select…',
  searchPlaceholder = 'Search…',
  emptyText = 'No matches',
  disabled,
  invalid,
  required,
  describedBy,
  'aria-label': ariaLabel,
  className,
  onBlur,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, MAX_RESULTS);
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q)).slice(0, MAX_RESULTS);
  }, [options, query]);

  // Keep the highlighted option visible while moving with the keyboard.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView?.({ block: 'nearest' });
  }, [active, open]);

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (next) {
      const i = options.slice(0, MAX_RESULTS).findIndex((o) => o.value === value);
      setActive(Math.max(i, 0));
    } else {
      setQuery('');
      onBlur?.();
    }
  };

  const pick = (o: ComboboxOption | undefined) => {
    if (!o || o.disabled) return;
    onChange(o.value);
    setOpenState(false);
  };

  const move = (from: number, step: 1 | -1) => {
    for (let i = from + step; i >= 0 && i < filtered.length; i += step) {
      if (!filtered[i]?.disabled) return i;
    }
    return from;
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') setActive((a) => move(a, 1));
    else if (e.key === 'ArrowUp') setActive((a) => move(a, -1));
    else if (e.key === 'Home') setActive(move(-1, 1));
    else if (e.key === 'End') setActive(move(filtered.length, -1));
    else if (e.key === 'Enter') pick(filtered[active]);
    else return;
    e.preventDefault();
  };

  const showPlaceholder = !selected || selected.value === '';

  return (
    <Primitive.Root open={open} onOpenChange={setOpenState}>
      <Primitive.Trigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          aria-controls={listId}
          aria-haspopup="listbox"
          aria-invalid={invalid || undefined}
          aria-required={required || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          onKeyDown={(e) => {
            if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setOpenState(true);
            }
          }}
          className={cn(inputClass, 'flex items-center justify-between gap-2 text-left', className)}
        >
          <span className={cn('truncate', showPlaceholder && 'text-muted/70')}>{selected?.label ?? (value || placeholder)}</span>
          <ChevronsUpDown className="size-4 shrink-0 text-muted" aria-hidden="true" />
        </button>
      </Primitive.Trigger>
      <Primitive.Portal>
        <Primitive.Content align="start" sideOffset={6} className="z-[70] w-(--radix-popover-trigger-width) min-w-64 rounded-xl border border-line bg-white p-1.5 shadow-pop">
          <div className="relative mb-1.5">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
            <input
              autoFocus
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setActive(0);
              }}
              onKeyDown={onSearchKey}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              aria-controls={listId}
              aria-activedescendant={filtered[active] ? `${listId}-${active}` : undefined}
              className="h-10 w-full rounded-lg border border-line pr-3 pl-9 text-sm outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" aria-label={ariaLabel} className="max-h-64 overflow-y-auto">
            {filtered.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{emptyText}</li>}
            {filtered.map((o, i) => (
              <li
                key={o.value}
                id={`${listId}-${i}`}
                data-index={i}
                role="option"
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                onClick={() => pick(o)}
                onMouseMove={() => !o.disabled && setActive(i)}
                className={cn(
                  'flex min-h-10 w-full cursor-pointer items-center gap-2 rounded-lg px-2.5 text-left text-sm',
                  i === active && 'bg-canvas',
                  o.disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <Check className={cn('size-4 shrink-0 text-brand', o.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{o.label}</span>
                {o.hint && <span className="shrink-0 text-xs text-muted">{o.hint}</span>}
              </li>
            ))}
          </ul>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
