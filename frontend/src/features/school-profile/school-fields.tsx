import { useWatch, type UseFormReturn } from 'react-hook-form';
import { DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIMEZONE, type SchoolDTO } from '@shared';
import { ComboboxField, SelectField, TextField } from '@/components/ui/field';
import { currencyOptions, LOCALE_OPTIONS, timeZoneOptions } from '@/lib/options';

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

export function IdentityFields({ form }: { form: SchoolForm }) {
  const err = (f: keyof SchoolFormValues) => errorOf(form, f);
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <TextField label="School name" required placeholder="e.g. Greenfield Public School" hint="Shown across the app." error={err('displayName')} {...form.register('displayName')} />
      <TextField label="Short name" placeholder="e.g. Greenfield" hint="Optional. Used where space is tight." error={err('shortName')} {...form.register('shortName')} />
      <TextField label="Legal name" required hint="As registered with the board or society." containerClassName="sm:col-span-2" error={err('legalName')} {...form.register('legalName')} />
      <TextField label="School code" required placeholder="e.g. GPS-01" hint="2–20 letters, numbers or hyphens. Saved in capitals." className="font-mono uppercase" error={err('schoolCode')} {...form.register('schoolCode')} />
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
