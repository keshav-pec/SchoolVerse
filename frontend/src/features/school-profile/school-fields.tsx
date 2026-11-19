import { useEffect, useRef, type ReactNode } from 'react';
import { useWatch, type UseFormReturn } from 'react-hook-form';
import { Check, LoaderCircle, Sparkles } from 'lucide-react';
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIMEZONE, SCHOOL_CODE_TAKEN_MESSAGE, type SchoolDTO } from '@shared';
import { ComboboxField, SelectField, TextField } from '@/components/ui/field';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { currencyOptions, LOCALE_OPTIONS, timeZoneOptions } from '@/lib/options';
import { fetchSchoolCodeAvailability, useSchoolCodeAvailability } from './api';

/** Plain strings for every input; the shared Zod schema normalises them on submit. */
export interface SchoolFormValues {
  schoolCode: string;
  legalName: string;
  displayName: string;
  shortName: string;
  primaryEmail: string;
  primaryPhone: string;
  alternatePhone: string;
  websiteUrl: string;
  defaultTimezone: string;
  defaultCurrency: string;
  defaultLocale: string;
}

export type SchoolForm = UseFormReturn<SchoolFormValues>;

const s = (v: string | null | undefined) => v ?? '';

export function schoolFormValues(school: SchoolDTO | null): SchoolFormValues {
  return {
    schoolCode: s(school?.schoolCode),
    legalName: s(school?.legalName),
    displayName: s(school?.displayName),
    shortName: s(school?.shortName),
    primaryEmail: s(school?.primaryEmail),
    primaryPhone: s(school?.primaryPhone),
    alternatePhone: s(school?.alternatePhone),
    websiteUrl: s(school?.websiteUrl),
    defaultTimezone: school?.defaultTimezone ?? DEFAULT_TIMEZONE,
    defaultCurrency: school?.defaultCurrency ?? DEFAULT_CURRENCY,
    defaultLocale: school?.defaultLocale ?? DEFAULT_LOCALE,
  };
}

export const IDENTITY_FIELDS = ['displayName', 'shortName', 'legalName', 'schoolCode'] as const;
export const CONTACT_FIELDS = ['primaryEmail', 'primaryPhone', 'alternatePhone', 'websiteUrl'] as const;
export const DEFAULTS_FIELDS = ['defaultTimezone', 'defaultCurrency', 'defaultLocale'] as const;

const errorOf = (form: SchoolForm, f: keyof SchoolFormValues) => form.formState.errors[f]?.message;

/**
 * School code: auto-filled from the school name's initials until the person types their own,
 * and checked for duplicates (platform-wide) as they type.
 */
const AUTOFILL_DELAY_MS = 2000;

function SchoolCodeField({ form, autoSuggest }: { form: SchoolForm; autoSuggest: boolean }) {
  const formError = errorOf(form, 'schoolCode');
  const code = (useWatch({ control: form.control, name: 'schoolCode' }) ?? '').trim().toUpperCase();
  const name = (useWatch({ control: form.control, name: 'displayName' }) ?? '').trim();
  const debouncedCode = useDebouncedValue(code, 300);
  // Wait for a pause in typing the name before auto-filling the code.
  const debouncedName = useDebouncedValue(name, AUTOFILL_DELAY_MS);
  const touched = useRef(false);
  const autoFilled = useRef<string | null>(null);

  const check = useSchoolCodeAvailability({ code: debouncedCode }, !!debouncedCode);
  const suggestion = useSchoolCodeAvailability({ name: debouncedName }, autoSuggest && !debouncedCode && !!debouncedName);

  // Fill from the name until the person edits the field themselves.
  useEffect(() => {
    const value = suggestion.data?.suggestion;
    const current = form.getValues('schoolCode');
    if (autoSuggest && value && !touched.current && (!current || current === autoFilled.current)) {
      autoFilled.current = value;
      form.setValue('schoolCode', value, { shouldDirty: true });
    }
  }, [suggestion.data?.suggestion, autoSuggest, form]);

  // Name changed after an auto-fill (and the code was never edited): re-derive the code.
  useEffect(() => {
    if (!autoSuggest || touched.current || !autoFilled.current || form.getValues('schoolCode') !== autoFilled.current || !debouncedName) return;
    void fetchSchoolCodeAvailability({ name: debouncedName }).then((r) => {
      if (!touched.current && r.suggestion && form.getValues('schoolCode') === autoFilled.current) {
        autoFilled.current = r.suggestion;
        form.setValue('schoolCode', r.suggestion, { shouldDirty: true });
      }
    });
  }, [debouncedName, autoSuggest, form]);

  const stale = debouncedCode !== code;
  const checking = !!code && (check.isFetching || stale);
  const result = check.data && check.data.code === code ? check.data : null;
  const taken = !!result && result.valid && !result.available;

  let status: ReactNode = null;
  if (!formError && code) {
    if (checking) {
      status = (
        <p className="flex items-center gap-1.5 text-[13px] text-muted" role="status">
          <LoaderCircle className="size-[15px] animate-spin" aria-hidden="true" /> Checking availability…
        </p>
      );
    } else if (result?.valid && result.available) {
      status = (
        <p className="flex items-center gap-1.5 text-[13px] font-medium text-success" role="status">
          <Check className="size-[15px]" aria-hidden="true" /> School code {result.code} is available.
        </p>
      );
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <TextField
        label="School code"
        required
        placeholder="e.g. GPS-01"
        hint="2–20 letters, numbers or hyphens. Saved in capitals."
        className="font-mono uppercase"
        autoComplete="off"
        spellCheck={false}
        error={formError ?? (taken ? SCHOOL_CODE_TAKEN_MESSAGE : undefined)}
        {...form.register('schoolCode', {
          onChange: () => {
            touched.current = true;
          },
        })}
      />
      {taken && result?.suggestion && result.suggestion !== result.code && (
        <button
          type="button"
          className="inline-flex w-fit items-center gap-1 rounded-pill bg-sun-soft px-2.5 py-1 text-xs font-semibold text-[#7a5300] hover:bg-sun/40"
          onClick={() => {
            touched.current = true;
            form.setValue('schoolCode', result.suggestion!, { shouldDirty: true, shouldValidate: true });
          }}
        >
          <Sparkles className="size-3" aria-hidden="true" /> Try {result.suggestion}
        </button>
      )}
      {status}
    </div>
  );
}

export function IdentityFields({ form, autoSuggestCode = false }: { form: SchoolForm; autoSuggestCode?: boolean }) {
  const err = (f: keyof SchoolFormValues) => errorOf(form, f);
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <TextField label="School name" required placeholder="e.g. Greenfield Public School" hint="Shown across the app." error={err('displayName')} {...form.register('displayName')} />
      <TextField label="Short name" placeholder="e.g. Greenfield" hint="Optional. Used where space is tight." error={err('shortName')} {...form.register('shortName')} />
      <TextField label="Legal name" required hint="As registered with the board or society." containerClassName="sm:col-span-2" error={err('legalName')} {...form.register('legalName')} />
      <SchoolCodeField form={form} autoSuggest={autoSuggestCode} />
    </div>
  );
}

export function ContactFields({ form }: { form: SchoolForm }) {
  const err = (f: keyof SchoolFormValues) => errorOf(form, f);
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <TextField label="Primary email" type="email" required autoComplete="email" error={err('primaryEmail')} {...form.register('primaryEmail')} />
      <TextField label="Primary phone" type="tel" required autoComplete="tel" placeholder="98765 43210" hint="Indian numbers need no country code." error={err('primaryPhone')} {...form.register('primaryPhone')} />
      <TextField label="Alternate phone" type="tel" error={err('alternatePhone')} {...form.register('alternatePhone')} />
      <TextField label="Website" placeholder="www.school.edu.in" error={err('websiteUrl')} {...form.register('websiteUrl')} />
    </div>
  );
}

export function DefaultsFields({ form }: { form: SchoolForm }) {
  const err = (f: keyof SchoolFormValues) => errorOf(form, f);
  const timezone = useWatch({ control: form.control, name: 'defaultTimezone' });
  return (
    <div className="grid gap-5 sm:grid-cols-3">
      <ComboboxField
        label="Time zone"
        required
        value={timezone}
        onChange={(v) => form.setValue('defaultTimezone', v, { shouldDirty: true, shouldValidate: true })}
        options={timeZoneOptions()}
        searchPlaceholder="Search time zones…"
        error={err('defaultTimezone')}
      />
      <SelectField label="Currency" required error={err('defaultCurrency')} {...form.register('defaultCurrency')}>
        {currencyOptions().map((c) => (
          <option key={c.value} value={c.value}>
            {c.label}
          </option>
        ))}
      </SelectField>
      <SelectField label="Language & region" required error={err('defaultLocale')} {...form.register('defaultLocale')}>
        {LOCALE_OPTIONS.map((l) => (
          <option key={l.value} value={l.value}>
            {l.label}
          </option>
        ))}
      </SelectField>
    </div>
  );
}
