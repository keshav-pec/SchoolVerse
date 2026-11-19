import { useState, type ReactNode } from 'react';
import { useForm, useWatch, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createSchoolSchema, SCHOOL_PROFILE_FIELDS, updateSchoolSchema, type SchoolDTO, type UpdateSchoolInput } from '@shared';
import { Rocket } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { SaveBar } from '@/components/sv/save-bar';
import { useAuth } from '@/lib/auth';
import { applyServerErrors } from '@/lib/errors';
import { formatPhone } from '@/lib/format';
import { localeLabel } from '@/lib/options';
import { useCreateSchool, useCurrentSchool, useUpdateSchool } from './api';
import { IdentifiersCard } from './identifiers-card';
import { LogoUploader } from './logo-uploader';
import { ContactFields, DefaultsFields, IdentityFields, schoolFormValues, type SchoolFormValues } from './school-fields';

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
    defaultValues: schoolFormValues(school),
    mode: 'onTouched',
  });
  const { isDirty, isSubmitting } = form.formState;
  const displayName = useWatch({ control: form.control, name: 'displayName' });
  const shortName = useWatch({ control: form.control, name: 'shortName' });

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
      form.reset(schoolFormValues(saved));
      toast.success('School profile updated successfully.');
    } catch (err) {
      setFormError(applyServerErrors(err, form.setError, SCHOOL_PROFILE_FIELDS));
    }
  });

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

        <IdentityFields form={form} autoSuggestCode={creating} />

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
        <ContactFields form={form} />
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Operational defaults</CardTitle>
            <CardDescription>Every location inherits these unless you override them there.</CardDescription>
          </div>
        </CardHeader>
        <DefaultsFields form={form} />
      </Card>

      {school ? (
        <SaveBar visible={isDirty} saving={isSubmitting} onDiscard={() => { form.reset(schoolFormValues(school)); setFormError(null); }} />
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
