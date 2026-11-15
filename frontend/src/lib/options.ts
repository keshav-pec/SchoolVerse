import { DEFAULT_TIMEZONE } from '@shared';
import type { ComboboxOption } from '@/components/ui/combobox';

function offsetOf(timeZone: string): string {
  try {
    const part = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName');
    return part?.value ?? '';
  } catch {
    return '';
  }
}

let timeZones: ComboboxOption[] | null = null;

/** Every IANA time zone with its current UTC offset as a hint, India first. */
export function timeZoneOptions(): ComboboxOption[] {
  if (timeZones) return timeZones;
  const names = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [DEFAULT_TIMEZONE, 'UTC'];
  const all = [...new Set([DEFAULT_TIMEZONE, ...names, 'UTC'])];
  timeZones = all.map((value) => ({ value, label: value.replace(/_/g, ' '), hint: offsetOf(value) }));
  return timeZones;
}

let currencies: { value: string; label: string }[] | null = null;

export function currencyOptions(): { value: string; label: string }[] {
  if (currencies) return currencies;
  const codes = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : ['INR', 'USD', 'EUR', 'GBP'];
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'currency' });
  } catch {
    names = null;
  }
  const list = codes.map((code) => ({ value: code, label: `${code} — ${names?.of(code) ?? code}` }));
  // India first, then the rest alphabetically.
  list.sort((a, b) => (a.value === 'INR' ? -1 : b.value === 'INR' ? 1 : a.value.localeCompare(b.value)));
  currencies = list;
  return list;
}

export const LOCALE_OPTIONS = [
  { value: 'en-IN', label: 'English (India)' },
  { value: 'hi-IN', label: 'Hindi (India)' },
  { value: 'pa-IN', label: 'Punjabi (India)' },
  { value: 'bn-IN', label: 'Bengali (India)' },
  { value: 'ta-IN', label: 'Tamil (India)' },
  { value: 'te-IN', label: 'Telugu (India)' },
  { value: 'mr-IN', label: 'Marathi (India)' },
  { value: 'gu-IN', label: 'Gujarati (India)' },
  { value: 'en-US', label: 'English (United States)' },
  { value: 'en-GB', label: 'English (United Kingdom)' },
  { value: 'en-AU', label: 'English (Australia)' },
  { value: 'en-CA', label: 'English (Canada)' },
  { value: 'en-SG', label: 'English (Singapore)' },
] as const;

export function localeLabel(code: string): string {
  return LOCALE_OPTIONS.find((o) => o.value === code)?.label ?? code;
}

let countries: { value: string; label: string }[] | null = null;

/** ISO country list for the address form, India first. */
export function countryOptions(): { value: string; label: string }[] {
  if (countries) return countries;
  const regions = ['IN', 'US', 'GB', 'CA', 'AU', 'SG', 'AE', 'NP', 'BD', 'LK', 'BT'];
  let names: Intl.DisplayNames | null = null;
  try {
    names = new Intl.DisplayNames(['en'], { type: 'region' });
  } catch {
    names = null;
  }
  countries = regions.map((value) => ({ value, label: names?.of(value) ?? value }));
  return countries;
}
