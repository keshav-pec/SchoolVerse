import { useId, useMemo, useState } from 'react';
import { Check, ChevronsUpDown, Search } from 'lucide-react';
import { Popover as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { inputClass } from './input';

export interface ComboboxOption {
  value: string;
  label: string;
  hint?: string;
}

interface ComboboxProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly ComboboxOption[];
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
}

/** Searchable single-select (used for time zones). */
export function Combobox({ id, value, onChange, options, placeholder = 'Select…', searchPlaceholder = 'Search…', emptyText = 'No matches', disabled, invalid, describedBy }: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const listId = useId();
  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options.slice(0, 200);
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.toLowerCase().includes(q) || o.hint?.toLowerCase().includes(q)).slice(0, 200);
  }, [options, query]);

  return (
    <Primitive.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <Primitive.Trigger asChild>
        <button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          disabled={disabled}
          className={cn(inputClass, 'flex items-center justify-between gap-2 text-left')}
        >
          <span className={cn('truncate', !selected && 'text-muted/70')}>{selected?.label ?? (value || placeholder)}</span>
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
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-10 w-full rounded-lg border border-line pr-3 pl-9 text-sm outline-none focus:border-brand focus:ring-4 focus:ring-brand/15"
            />
          </div>
          <ul id={listId} role="listbox" className="max-h-64 overflow-y-auto">
            {filtered.length === 0 && <li className="px-3 py-4 text-center text-sm text-muted">{emptyText}</li>}
            {filtered.map((o) => (
              <li key={o.value} role="option" aria-selected={o.value === value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className="flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 text-left text-sm hover:bg-canvas focus-visible:bg-canvas"
                >
                  <Check className={cn('size-4 shrink-0 text-brand', o.value === value ? 'opacity-100' : 'opacity-0')} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  {o.hint && <span className="shrink-0 text-xs text-muted">{o.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
