import { useState, type ReactNode } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createSchoolSchema, DEFAULT_CURRENCY, DEFAULT_LOCALE, DEFAULT_TIMEZONE, SCHOOL_PROFILE_FIELDS, updateSchoolSchema, type SchoolDTO, type UpdateSchoolInput } from '@shared';
import { Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, SelectField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { SaveBar } from '@/components/sv/save-bar';
import { useAuth } from '@/lib/auth';
import { applyServerErrors } from '@/lib/errors';
import { formatPhone } from '@/lib/format';
import { currencyOptions, LOCALE_OPTIONS, localeLabel, timeZoneOptions } from '@/lib/options';
import { useCreateSchool, useCurrentSchool, useUpdateSchool } from './api';
import { IdentifiersCard } from './identifiers-card';
import { LogoUploader } from './logo-uploader';

interface SchoolFormValues {
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

const s = (v: string | null | undefined) => v ?? '';

function valuesOf(school: SchoolDTO | null): SchoolFormValues {
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

function ProfileSkeleton() {
  return (
    <div role="status" aria-label="Loading school profile" className="space-y-6">
      <Skeleton className="h-64 rounded-card" />
      <Skeleton className="h-56 rounded-card" />
      <Skeleton className="h-56 rounded-card" />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[190px_1fr]">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm font-medium break-words">{children || <span className="text-muted">—</span>}</dd>
    </div>
  );
}

/** Faculty / Staff: the limited, read-only view (operational fields only). */
function ReadOnlyProfile({ school }: { school: SchoolDTO }) {
  return (
    <div className="space-y-6">
      <Alert tone="info" title="Limited, read-only view">
        Only School Admins can edit the school profile.
      </Alert>
      <Card>
        <CardHeader>
          <CardTitle>{school.displayName}</CardTitle>
        </CardHeader>
        <div className="mb-5">
          <LogoUploader school={school} previewName={school.displayName} canEdit={false} />
        </div>
        <dl className="space-y-3.5">
          <Row label="Legal name">{school.legalName}</Row>
          <Row label="Short name">{school.shortName}</Row>
          <Row label="Primary email">{school.primaryEmail}</Row>
          <Row label="Primary phone">{formatPhone(school.primaryPhone)}</Row>
          <Row label="Alternate phone">{school.alternatePhone ? formatPhone(school.alternatePhone) : ''}</Row>
          <Row label="Website">{school.websiteUrl}</Row>
          <Row label="Time zone">{school.defaultTimezone.replace(/_/g, ' ')}</Row>
          <Row label="Currency">{school.defaultCurrency}</Row>
          <Row label="Language & region">{localeLabel(school.defaultLocale)}</Row>
        </dl>
      </Card>
    </div>
  );
}

function ProfileForm({ school }: { school: SchoolDTO | null }) {
  const creating = !school;
  const update = useUpdateSchool(school?.schoolId ?? '');
  const create = useCreateSchool();
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<SchoolFormValues>({
    resolver: zodResolver(creating ? createSchoolSchema : updateSchoolSchema) as unknown as Resolver<SchoolFormValues>,
    defaultValues: valuesOf(school),
    mode: 'onTouched',
  });
  const { errors, isDirty, isSubmitting } = form.formState;
  const displayName = useWatch({ control: form.control, name: 'displayName' });
  const shortName = useWatch({ control: form.control, name: 'shortName' });
  const timezone = useWatch({ control: form.control, name: 'defaultTimezone' });

  const onSubmit = form.handleSubmit(async (values) => {
    setFormError(null);
    try {
      if (!school) {
        await create.mutateAsync(values as never);
        toast.success('School profile created. Now add your first campus.');
        return;
      }
      const dirty = form.formState.dirtyFields as Record<string, boolean | undefined>;
      const patch: Record<string, unknown> = {};
      for (const f of SCHOOL_PROFILE_FIELDS) if (dirty[f]) patch[f] = (values as unknown as Record<string, unknown>)[f];
      const saved = await update.mutateAsync(patch as UpdateSchoolInput);
      form.reset(valuesOf(saved));
      toast.success('School profile updated successfully.');
    } catch (err) {
      setFormError(applyServerErrors(err, form.setError, SCHOOL_PROFILE_FIELDS));
    }
  });

  const err = (f: keyof SchoolFormValues) => errors[f]?.message;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6 pb-24">
      {formError && <Alert tone="danger">{formError}</Alert>}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>School identity</CardTitle>
            <CardDescription>How your school appears across SchoolVerse.</CardDescription>
          </div>
        </CardHeader>

        {school ? (
          <div className="mb-6 rounded-xl bg-canvas p-4">
            <LogoUploader school={school} previewName={displayName} canEdit />
          </div>
        ) : (
          <p className="mb-6 rounded-xl bg-canvas p-4 text-sm text-muted">You can add a logo right after creating the profile.</p>
        )}

        <div className="grid gap-5 sm:grid-cols-2">
          <TextField label="School name" required placeholder="e.g. Greenfield Public School" hint="Shown across the app." error={err('displayName')} {...form.register('displayName')} />
          <TextField label="Short name" placeholder="e.g. Greenfield" hint="Optional. Used where space is tight." error={err('shortName')} {...form.register('shortName')} />
          <TextField label="Legal name" required hint="As registered with the board or society." containerClassName="sm:col-span-2" error={err('legalName')} {...form.register('legalName')} />
          <TextField label="School code" required placeholder="e.g. GPS-01" hint="2–20 letters, numbers or hyphens. Saved in capitals." className="font-mono uppercase" error={err('schoolCode')} {...form.register('schoolCode')} />
        </div>

        <div className="mt-6 flex items-center gap-3 rounded-xl border border-dashed border-line px-4 py-3" aria-label="Preview">
          <span className="text-[11px] font-bold tracking-widest text-muted uppercase">Preview</span>
          <span className="truncate text-sm font-semibold">{displayName.trim() || 'Your school name'}</span>
          {shortName.trim() && <span className="rounded-pill bg-brand-soft px-2 py-0.5 text-xs font-semibold text-brand">{shortName.trim()}</span>}
        </div>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Contact</CardTitle>
            <CardDescription>The main way families and officials reach the school.</CardDescription>
          </div>
        </CardHeader>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField label="Primary email" type="email" required autoComplete="email" error={err('primaryEmail')} {...form.register('primaryEmail')} />
          <TextField label="Primary phone" type="tel" required autoComplete="tel" placeholder="98765 43210" hint="Indian numbers need no country code." error={err('primaryPhone')} {...form.register('primaryPhone')} />
          <TextField label="Alternate phone" type="tel" error={err('alternatePhone')} {...form.register('alternatePhone')} />
          <TextField label="Website" placeholder="www.school.edu.in" error={err('websiteUrl')} {...form.register('websiteUrl')} />
        </div>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Operational defaults</CardTitle>
            <CardDescription>Every location inherits these unless you override them there.</CardDescription>
          </div>
        </CardHeader>
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
      </Card>

      {school ? (
        <SaveBar visible={isDirty} saving={isSubmitting} onDiscard={() => { form.reset(valuesOf(school)); setFormError(null); }} />
      ) : (
        <div className="flex justify-end">
          <Button type="submit" size="lg" loading={isSubmitting} loadingText="Creating profile…">
            <Rocket /> Create school profile
          </Button>
        </div>
      )}
    </form>
  );
}

export function SchoolProfilePage() {
  const { can } = useAuth();
  const q = useCurrentSchool();
  const canEdit = can('school:edit');
  const school = q.data ?? null;

  return (
    <>
      <PageHeader
        eyebrow="School Setup"
        title="School Profile"
        description={school ? 'Your school’s identity, contact details and operational defaults.' : 'Tell us about your school. This becomes the single source of truth for the whole ERP.'}
      />
      {q.isLoading && <ProfileSkeleton />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {q.isSuccess && !school && !canEdit && (
        <Alert tone="info" title="Your school is getting set up">
          Your School Admin hasn’t created the school profile yet. Check back soon.
        </Alert>
      )}
      {q.isSuccess && canEdit && <ProfileForm key={school?.schoolId ?? 'new'} school={school} />}
      {q.isSuccess && school && !canEdit && <ReadOnlyProfile school={school} />}
      {q.isSuccess && school && <div className="mt-6"><IdentifiersCard schoolId={school.schoolId} /></div>}
    </>
  );
}
