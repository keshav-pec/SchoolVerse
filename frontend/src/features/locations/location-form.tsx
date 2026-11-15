import { useEffect, useRef, type ReactNode } from 'react';
import { get, useWatch, type FieldPath, type UseFormReturn } from 'react-hook-form';
import {
  LOCATION_TYPES,
  LOCATION_TYPE_LABELS,
  normalizeLocationCode,
  type LocationDetailDTO,
  type LocationDTO,
  type LocationType,
  type SchoolDTO,
} from '@shared';
import { Check, Lock, LoaderCircle, Sparkles, TriangleAlert } from 'lucide-react';
import { Combobox } from '@/components/ui/combobox';
import { FieldShell, SelectField, TextareaField, TextField } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { Tooltip } from '@/components/ui/tooltip';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { countryOptions, currencyOptions, LOCALE_OPTIONS, localeLabel, timeZoneOptions } from '@/lib/options';
import { cn } from '@/lib/utils';
import { useCodeAvailability } from './api';

/** Plain strings for every input; the shared Zod schema normalises them on submit. */
export interface LocationFormValues {
  displayName: string;
  locationCode: string;
  locationType: LocationType;
  officialName: string;
  openingDate: string;
  timezoneOverride: string | null;
  currencyOverride: string | null;
  localeOverride: string | null;
  email: string;
  phone: string;
  alternatePhone: string;
  websiteUrl: string;
  latitude: string;
  longitude: string;
  notes: string;
  address: {
    line1: string;
    line2: string;
    locality: string;
    city: string;
    district: string;
    state: string;
    postalCode: string;
    country: string;
  };
  intent: 'DRAFT' | 'ACTIVE';
  isPrimary: boolean;
}

export const EMPTY_LOCATION_FORM: LocationFormValues = {
  displayName: '',
  locationCode: '',
  locationType: 'BRANCH_CAMPUS',
  officialName: '',
  openingDate: '',
  timezoneOverride: null,
  currencyOverride: null,
  localeOverride: null,
  email: '',
  phone: '',
  alternatePhone: '',
  websiteUrl: '',
  latitude: '',
  longitude: '',
  notes: '',
  address: { line1: '', line2: '', locality: '', city: '', district: '', state: '', postalCode: '', country: 'IN' },
  intent: 'DRAFT',
  isPrimary: false,
};

const s = (v: string | number | null | undefined) => (v === null || v === undefined ? '' : String(v));

export function toFormValues(l: LocationDTO): LocationFormValues {
  return {
    displayName: l.displayName,
    locationCode: l.locationCode,
    locationType: l.locationType,
    officialName: s(l.officialName),
    openingDate: s(l.openingDate).slice(0, 10),
    timezoneOverride: l.timezoneOverride,
    currencyOverride: l.currencyOverride,
    localeOverride: l.localeOverride,
    email: s(l.email),
    phone: s(l.phone),
    alternatePhone: s(l.alternatePhone),
    websiteUrl: s(l.websiteUrl),
    latitude: s(l.latitude),
    longitude: s(l.longitude),
    notes: s(l.notes),
    address: {
      line1: s(l.address.line1),
      line2: s(l.address.line2),
      locality: s(l.address.locality),
      city: s(l.address.city),
      district: s(l.address.district),
      state: s(l.address.state),
      postalCode: s(l.address.postalCode),
      country: l.address.country || 'IN',
    },
    intent: 'DRAFT',
    isPrimary: l.isPrimary,
  };
}

type Path = FieldPath<LocationFormValues>;
export type LocationForm = UseFormReturn<LocationFormValues>;

export const BASICS_FIELDS: Path[] = ['displayName', 'locationCode', 'locationType', 'officialName', 'openingDate', 'isPrimary'];
export const ADDRESS_FIELDS: Path[] = ['address.line1', 'address.line2', 'address.locality', 'address.city', 'address.district', 'address.state', 'address.postalCode', 'address.country', 'latitude', 'longitude'];
export const CONTACT_FIELDS: Path[] = ['email', 'phone', 'alternatePhone', 'websiteUrl', 'notes'];
export const DEFAULTS_FIELDS: Path[] = ['timezoneOverride', 'currencyOverride', 'localeOverride'];
/** Keys a location PATCH may carry (the dotted audit paths collapse to `address`). */
export const LOCATION_PATCH_FIELDS = [
  'displayName',
  'locationCode',
  'locationType',
  'officialName',
  'openingDate',
  'timezoneOverride',
  'currencyOverride',
  'localeOverride',
  'email',
  'phone',
  'alternatePhone',
  'websiteUrl',
  'latitude',
  'longitude',
  'notes',
  'address',
] as const;
export const ALL_LOCATION_FIELDS: Path[] = [...BASICS_FIELDS, ...ADDRESS_FIELDS, ...CONTACT_FIELDS, ...DEFAULTS_FIELDS, 'intent'];

function useFieldError(form: LocationForm) {
  const { errors } = form.formState;
  return (path: Path): string | undefined => (get(errors, path) as { message?: string } | undefined)?.message;
}

// ───────────────────────────────────────────────────────────── location code (SCH-LOC-08)

interface CodeFieldProps {
  form: LocationForm;
  schoolId: string;
  /** Editing an existing location: ignore it when checking, and honour the lock. */
  location?: Pick<LocationDetailDTO, 'locationId' | 'codeLocked' | 'locationCode'>;
  /** `location:view_config` — only admins can call the availability endpoint. */
  canCheck: boolean;
  autoSuggest?: boolean;
}

export function LocationCodeField({ form, schoolId, location, canCheck, autoSuggest = false }: CodeFieldProps) {
  const error = useFieldError(form)('locationCode');
  const code = useWatch({ control: form.control, name: 'locationCode' }) ?? '';
  const name = useWatch({ control: form.control, name: 'displayName' }) ?? '';
  const debouncedCode = useDebouncedValue(normalizeLocationCode(code), 300);
  const debouncedName = useDebouncedValue(name.trim(), 300);
  const touched = useRef(false);

  const unchanged = !!location && debouncedCode === location.locationCode;
  const locked = !!location?.codeLocked;

  const codeCheck = useCodeAvailability(schoolId, { code: debouncedCode, name: debouncedName, excludeLocationId: location?.locationId }, canCheck && !locked && !!debouncedCode && !unchanged);
  const nameSuggestion = useCodeAvailability(schoolId, { name: debouncedName, excludeLocationId: location?.locationId }, canCheck && !locked && autoSuggest && !debouncedCode && !!debouncedName);

  // Fill the code from the name until the person types their own.
  const autoFilled = useRef<string | null>(null);
  useEffect(() => {
    const suggestion = nameSuggestion.data?.suggestion;
    if (autoSuggest && suggestion && !touched.current && (!form.getValues('locationCode') || form.getValues('locationCode') === autoFilled.current)) {
      autoFilled.current = suggestion;
      form.setValue('locationCode', suggestion, { shouldDirty: true });
    }
  }, [nameSuggestion.data?.suggestion, autoSuggest, form]);

  const register = form.register('locationCode', {
    onChange: () => {
      touched.current = true;
    },
  });

  const result = codeCheck.data;
  const stale = debouncedCode !== normalizeLocationCode(code);
  const checking = canCheck && !!debouncedCode && !unchanged && !locked && (codeCheck.isFetching || stale);

  let status: ReactNode = null;
  if (!error && canCheck && !locked && code.trim()) {
    if (checking) {
      status = (
        <p className="flex items-center gap-1.5 text-[13px] text-muted" role="status">
          <LoaderCircle className="size-[15px] animate-spin" aria-hidden="true" /> Checking availability…
        </p>
      );
    } else if (result && result.code === debouncedCode) {
      if (result.valid && result.available) {
        status = (
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-success" role="status">
            <Check className="size-[15px]" aria-hidden="true" /> Location code {result.code} is available.
          </p>
        );
      } else {
        status = (
          <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-medium text-danger">
            <span className="flex items-center gap-1.5">
              <TriangleAlert className="size-[15px]" aria-hidden="true" />
              {result.message ?? `Location code ${result.code} is already in use.`}
            </span>
            {result.suggestion && result.suggestion !== result.code && (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-pill bg-sun-soft px-2.5 py-1 text-xs font-semibold text-[#7a5300] hover:bg-sun/40"
                onClick={() => {
                  touched.current = true;
                  form.setValue('locationCode', result.suggestion!, { shouldDirty: true, shouldValidate: true });
                }}
              >
                <Sparkles className="size-3" aria-hidden="true" /> Try {result.suggestion}
              </button>
            )}
          </div>
        );
      }
    }
  }

  const aside = locked ? (
    <Tooltip content="This code is locked because other records already reference this location. The location ID never changes.">
      <button type="button" className="inline-flex items-center gap-1 rounded-md text-xs font-semibold text-muted" aria-label="Why is the code locked?">
        <Lock className="size-3.5" aria-hidden="true" /> Locked
      </button>
    </Tooltip>
  ) : null;

  return (
    <div className="flex flex-col gap-1.5">
      <TextField
        label="Location code"
        required
        placeholder="e.g. MOH"
        maxLength={10}
        autoComplete="off"
        spellCheck={false}
        disabled={locked}
        labelAside={aside}
        hint={locked ? 'Locked: other records reference this location, so the code can’t change.' : 'Short and unique, e.g. MOH or DEL01. It’s saved in capitals.'}
        error={error}
        className={cn('font-mono tracking-wider uppercase')}
        {...register}
        onBlur={(e) => {
          e.target.value = normalizeLocationCode(e.target.value);
          form.setValue('locationCode', e.target.value, { shouldDirty: true });
          void register.onBlur(e);
        }}
      />
      {status}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── sections

interface SectionProps {
  form: LocationForm;
}

export function BasicsFields({
  form,
  schoolId,
  location,
  canCheckCode,
  showPrimary,
  primaryHint,
  autoSuggest,
}: SectionProps & {
  schoolId: string;
  location?: Pick<LocationDetailDTO, 'locationId' | 'codeLocked' | 'locationCode'>;
  canCheckCode: boolean;
  showPrimary?: boolean;
  primaryHint?: ReactNode;
  autoSuggest?: boolean;
}) {
  const err = useFieldError(form);
  const intent = useWatch({ control: form.control, name: 'intent' });
  return (
    <div className="space-y-5">
      <TextField label="Location name" required placeholder="e.g. Mohali Campus" error={err('displayName')} {...form.register('displayName')} />
      <div className="grid gap-5 sm:grid-cols-2">
        <LocationCodeField form={form} schoolId={schoolId} location={location} canCheck={canCheckCode} autoSuggest={autoSuggest} />
        <SelectField label="Location type" required error={err('locationType')} {...form.register('locationType')}>
          {LOCATION_TYPES.map((t) => (
            <option key={t} value={t}>
              {LOCATION_TYPE_LABELS[t]}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField label="Official name" placeholder="As it appears on affiliation documents" hint="Optional. Use it if it differs from the display name." error={err('officialName')} {...form.register('officialName')} />
      <TextField label="Opening date" type="date" error={err('openingDate')} {...form.register('openingDate')} />
      {showPrimary && (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-canvas px-4 py-3.5">
          <input type="checkbox" className="mt-1 size-4 accent-[#244fd4]" {...form.register('isPrimary')} />
          <span className="text-sm">
            <span className="block font-semibold text-ink">Make this the Primary Location</span>
            <span className="text-muted">{primaryHint ?? 'The Primary Location is your school’s main campus. Only an active location can be Primary.'}</span>
            {err('isPrimary') && intent !== 'ACTIVE' && <span className="mt-1 block text-[13px] font-medium text-danger">{err('isPrimary')}</span>}
          </span>
        </label>
      )}
    </div>
  );
}

export function AddressFields({ form }: SectionProps) {
  const err = useFieldError(form);
  const country = useWatch({ control: form.control, name: 'address.country' });
  const postalHint = country === 'IN' ? '6-digit PIN code' : country === 'US' ? 'ZIP code, e.g. 94105' : undefined;
  return (
    <div className="space-y-5">
      <TextField label="Address line 1" required autoComplete="address-line1" error={err('address.line1')} {...form.register('address.line1')} />
      <TextField label="Address line 2" autoComplete="address-line2" error={err('address.line2')} {...form.register('address.line2')} />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField label="Locality / area" error={err('address.locality')} {...form.register('address.locality')} />
        <TextField label="City" required autoComplete="address-level2" error={err('address.city')} {...form.register('address.city')} />
        <TextField label="District" error={err('address.district')} {...form.register('address.district')} />
        <TextField label="State" required autoComplete="address-level1" error={err('address.state')} {...form.register('address.state')} />
        <TextField label="Postal code" required inputMode="text" autoComplete="postal-code" hint={postalHint} error={err('address.postalCode')} {...form.register('address.postalCode')} />
        <SelectField label="Country" required error={err('address.country')} {...form.register('address.country')}>
          {countryOptions().map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </SelectField>
      </div>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold text-ink">Map coordinates (optional)</legend>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField label="Latitude" inputMode="decimal" placeholder="30.7046" error={err('latitude')} {...form.register('latitude')} />
          <TextField label="Longitude" inputMode="decimal" placeholder="76.7179" error={err('longitude')} {...form.register('longitude')} />
        </div>
      </fieldset>
    </div>
  );
}

export function ContactFields({ form, showNotes }: SectionProps & { showNotes: boolean }) {
  const err = useFieldError(form);
  return (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField label="Phone" type="tel" required autoComplete="tel" placeholder="98765 43210" hint="Indian numbers need no country code." error={err('phone')} {...form.register('phone')} />
        <TextField label="Alternate phone" type="tel" error={err('alternatePhone')} {...form.register('alternatePhone')} />
      </div>
      <TextField label="Email" type="email" autoComplete="email" placeholder="campus@school.edu" error={err('email')} {...form.register('email')} />
      <TextField label="Website" placeholder="campus.school.edu" error={err('websiteUrl')} {...form.register('websiteUrl')} />
      {showNotes && <TextareaField label="Internal notes" hint="Only School Admins can see these." rows={3} error={err('notes')} {...form.register('notes')} />}
    </div>
  );
}

type DefaultKey = 'timezoneOverride' | 'currencyOverride' | 'localeOverride';

function OverrideRow({
  form,
  name,
  label,
  schoolValue,
  display,
  renderEditor,
}: SectionProps & {
  name: DefaultKey;
  label: string;
  schoolValue: string;
  display: (v: string) => string;
  renderEditor: (value: string, onChange: (v: string) => void, id: string) => ReactNode;
}) {
  const value = useWatch({ control: form.control, name });
  const error = useFieldError(form)(name);
  const overriding = value !== null && value !== undefined;
  const id = `override-${name}`;
  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-sm font-semibold text-ink">{label}</p>
          <p className="text-[13px] text-muted">{overriding ? `School default: ${display(schoolValue)}` : `Inherited from the school: ${display(schoolValue)}`}</p>
        </div>
        <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            className="size-4 accent-[#244fd4]"
            checked={overriding}
            onChange={(e) => form.setValue(name, e.target.checked ? schoolValue : null, { shouldDirty: true, shouldValidate: true })}
          />
          Override for this location
        </label>
      </div>
      {overriding && (
        <FieldShell id={id} label={label} error={error} className="mt-3">
          {renderEditor(value ?? '', (v) => form.setValue(name, v, { shouldDirty: true, shouldValidate: true }), id)}
        </FieldShell>
      )}
    </div>
  );
}

export function DefaultsFields({ form, school }: SectionProps & { school: Pick<SchoolDTO, 'defaultTimezone' | 'defaultCurrency' | 'defaultLocale'> }) {
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Locations inherit the school’s operational defaults. Override one only if this location really differs.</p>
      <OverrideRow
        form={form}
        name="timezoneOverride"
        label="Time zone"
        schoolValue={school.defaultTimezone}
        display={(v) => v.replace(/_/g, ' ')}
        renderEditor={(value, onChange, id) => (
          <TimeZoneSelect id={id} value={value} onChange={onChange} />
        )}
      />
      <OverrideRow
        form={form}
        name="currencyOverride"
        label="Currency"
        schoolValue={school.defaultCurrency}
        display={(v) => v}
        renderEditor={(value, onChange, id) => (
          <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
            {currencyOptions().map((c) => (
              <option key={c.value} value={c.value}>
                {c.label}
              </option>
            ))}
          </Select>
        )}
      />
      <OverrideRow
        form={form}
        name="localeOverride"
        label="Language & region"
        schoolValue={school.defaultLocale}
        display={localeLabel}
        renderEditor={(value, onChange, id) => (
          <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
            {LOCALE_OPTIONS.map((l) => (
              <option key={l.value} value={l.value}>
                {l.label}
              </option>
            ))}
          </Select>
        )}
      />
    </div>
  );
}

function TimeZoneSelect({ id, value, onChange }: { id: string; value: string; onChange: (v: string) => void }) {
  return <Combobox id={id} value={value} onChange={onChange} options={timeZoneOptions()} searchPlaceholder="Search time zones…" />;
}

/**
 * Build a PATCH body from only the fields that changed. `address` is sent as a whole object
 * (that is how the API replaces it) as soon as any address field changed.
 */
export function buildLocationPatch(fields: readonly string[], dirty: Record<string, unknown>, values: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of fields) {
    if (dirty[key]) patch[key] = values[key];
  }
  return patch;
}

/** Every location section stacked, for places that edit a whole location in one go (wizard, edit drawer). */
export function LocationEditorFields({
  form,
  school,
  location,
  canCheckCode,
  showPrimary,
  autoSuggest,
  showNotes,
}: {
  form: LocationForm;
  school: Pick<SchoolDTO, 'schoolId' | 'defaultTimezone' | 'defaultCurrency' | 'defaultLocale'>;
  location?: Pick<LocationDetailDTO, 'locationId' | 'codeLocked' | 'locationCode'>;
  canCheckCode: boolean;
  showPrimary?: boolean;
  autoSuggest?: boolean;
  showNotes?: boolean;
}) {
  const heading = 'mb-4 text-base font-bold text-ink';
  return (
    <div className="space-y-8">
      <section aria-labelledby="sec-basics">
        <h3 id="sec-basics" className={heading}>
          Basics
        </h3>
        <BasicsFields form={form} schoolId={school.schoolId} location={location} canCheckCode={canCheckCode} showPrimary={showPrimary} autoSuggest={autoSuggest} />
      </section>
      <section aria-labelledby="sec-address">
        <h3 id="sec-address" className={heading}>
          Address
        </h3>
        <AddressFields form={form} />
      </section>
      <section aria-labelledby="sec-contact">
        <h3 id="sec-contact" className={heading}>
          Contact
        </h3>
        <ContactFields form={form} showNotes={showNotes ?? false} />
      </section>
      <section aria-labelledby="sec-defaults">
        <h3 id="sec-defaults" className={heading}>
          Operational defaults
        </h3>
        <DefaultsFields form={form} school={school} />
      </section>
    </div>
  );
}
