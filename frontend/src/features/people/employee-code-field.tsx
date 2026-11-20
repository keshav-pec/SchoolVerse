import { useEffect, useRef, type ReactNode } from 'react';
import type { EmployeeCategory } from '@shared';
import { Check, CircleAlert, LoaderCircle, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { useEmployeeCodeCheck } from './api';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  /** Adding: picking a category fills in the next free code (FAC-015, STF-008) until the person types their own. */
  category?: EmployeeCategory | '';
  /** Editing: this employee's own code is not a clash, and nothing is filled in automatically. */
  employeeId?: string;
  /** The code the employee has now (editing). It isn't re-checked. */
  currentCode?: string;
  error?: string;
  autoFocus?: boolean;
}

/**
 * Employee code with the same help the School code field gives: a suggested code, and a duplicate check while typing.
 * The server still refuses a duplicate on save, so this is only a convenience.
 */
export function EmployeeCodeField({ value, onChange, onBlur, category, employeeId, currentCode, error, autoFocus }: Props) {
  const adding = !employeeId;
  const code = value.trim().toUpperCase();
  const debounced = useDebouncedValue(code, 300);
  const autoFilled = useRef<string | null>(null);

  const suggestion = useEmployeeCodeCheck({ category }, adding && !!category);
  const check = useEmployeeCodeCheck({ code: debounced, employeeId }, !!debounced && debounced !== currentCode);

  // Fill in the suggestion while the box is empty or still holds the previous suggestion.
  const suggested = suggestion.data?.suggestion;
  useEffect(() => {
    if (!adding || !suggested) return;
    if (!value.trim() || value === autoFilled.current) {
      autoFilled.current = suggested;
      onChange(suggested);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [suggested, adding]);

  const result = check.data && check.data.code === code ? check.data : null;
  const checking = !!code && code !== currentCode && (debounced !== code || check.isFetching);

  let hint: ReactNode = adding ? 'Unique in your school. Choose a category and we suggest one.' : 'Unique in your school.';
  if (code && code !== currentCode) {
    if (checking) {
      hint = (
        <span className="flex items-center gap-1.5" role="status">
          <LoaderCircle className="size-[15px] animate-spin" aria-hidden="true" /> Checking…
        </span>
      );
    } else if (result?.valid && !result.available) {
      hint = (
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium text-danger" role="status">
          <CircleAlert className="size-[15px] shrink-0" aria-hidden="true" /> Someone already has this code.
          {result.suggestion && (
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2" onClick={() => onChange(result.suggestion!)}>
              Use {result.suggestion}
            </Button>
          )}
        </span>
      );
    } else if (result?.valid && result.available) {
      hint =
        adding && value === autoFilled.current ? (
          <span className="flex items-center gap-1.5 text-success" role="status">
            <Sparkles className="size-[15px]" aria-hidden="true" /> Suggested for you and free to use. You can type your own.
          </span>
        ) : (
          <span className="flex items-center gap-1.5 text-success" role="status">
            <Check className="size-[15px]" aria-hidden="true" /> Free to use.
          </span>
        );
    }
  }

  return (
    <TextField
      label="Employee code"
      required
      placeholder="FAC-014"
      autoComplete="off"
      autoFocus={autoFocus}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onBlur={onBlur}
      hint={hint}
      error={error}
      labelAside={
        <InfoTip label="About the employee code">
          <p>A short ID for this person, like a roll number for staff. It appears on lists and exports.</p>
          <p>We suggest the next free number: <b>FAC-</b> for teaching staff and <b>STF-</b> for non-teaching staff. You can type your own instead, and change it later.</p>
        </InfoTip>
      }
    />
  );
}
