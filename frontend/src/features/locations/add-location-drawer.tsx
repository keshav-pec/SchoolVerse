import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createLocationSchema, LOCATION_TYPE_LABELS, missingActivationFields, normalizePhone, type CreateLocationInput, type LocationDetailDTO, type SchoolDTO } from '@shared';
import { ArrowLeft, ArrowRight, Check, Pencil, Rocket, Save, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { applyServerErrors } from '@/lib/errors';
import { countryName, formatAddress, formatDateOnly, formatPhone } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useCreateLocation } from './api';
import {
  ADDRESS_FIELDS,
  ALL_LOCATION_FIELDS,
  AddressFields,
  BASICS_FIELDS,
  BasicsFields,
  CONTACT_FIELDS,
  ContactFields,
  DEFAULTS_FIELDS,
  DefaultsFields,
  EMPTY_LOCATION_FORM,
  type LocationFormValues,
} from './location-form';

const STEPS = [
  { key: 'basics', label: 'Basics', fields: BASICS_FIELDS },
  { key: 'address', label: 'Address', fields: ADDRESS_FIELDS },
  { key: 'contact', label: 'Contact', fields: CONTACT_FIELDS },
  { key: 'defaults', label: 'Defaults', fields: DEFAULTS_FIELDS },
  { key: 'review', label: 'Review', fields: [] },
] as const;

const LAST = STEPS.length - 1;

function stepOfField(field: string): number {
  const i = STEPS.findIndex((s) => (s.fields as readonly string[]).includes(field) || (s.fields as readonly string[]).some((f) => field.startsWith(`${f}.`)));
  return i === -1 ? 0 : i;
}

function Stepper({ current, onJump }: { current: number; onJump: (i: number) => void }) {
  return (
    <ol className="flex items-center gap-1 border-b border-line bg-canvas px-5 py-3 sm:px-6" aria-label="Progress">
      {STEPS.map((step, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <li key={step.key} className="flex flex-1 items-center gap-1 last:flex-none">
            <button
              type="button"
              disabled={i > current}
              onClick={() => onJump(i)}
              aria-current={active ? 'step' : undefined}
              className={cn('flex items-center gap-2 rounded-lg py-1 pr-1 text-sm font-semibold outline-none', active ? 'text-brand' : done ? 'text-ink' : 'text-muted')}
            >
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold',
                  active ? 'bg-brand text-white' : done ? 'bg-success text-white' : 'bg-ink/10 text-muted',
                )}
              >
                {done ? <Check className="size-3.5" aria-hidden="true" /> : i + 1}
              </span>
              <span className={cn(!active && 'hidden sm:inline')}>{step.label}</span>
            </button>
            {i < LAST && <span aria-hidden="true" className={cn('h-0.5 flex-1 rounded-full', done ? 'bg-success' : 'bg-ink/10')} />}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewCard({ title, onEdit, children }: { title: string; onEdit: () => void; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold">{title}</h3>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${title}`}>
          <Pencil /> Edit
        </Button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[130px_1fr]">{children}</dl>
    </section>
  );
}

function Row({ label, value }: { label: string; value: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 font-medium break-words">{value || '—'}</dd>
    </>
  );
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  school: SchoolDTO;
  /** True when the school has no locations yet: the drawer becomes "Add Primary Location". */
  isFirst: boolean;
  onCreated?: (location: LocationDetailDTO) => void;
}

export function AddLocationDrawer({ open, onOpenChange, school, isFirst, onCreated }: Props) {
  const { can } = useAuth();
  const create = useCreateLocation(school.schoolId);
  const [step, setStep] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const canActivate = can('location:change_status');
  const canSetPrimary = can('location:set_primary');

  const initial = useMemo<LocationFormValues>(
    () => ({ ...EMPTY_LOCATION_FORM, ...(isFirst ? { locationType: 'MAIN_CAMPUS' as const, isPrimary: canActivate && canSetPrimary } : {}) }),
    [isFirst, canActivate, canSetPrimary],
  );

  const form = useForm<LocationFormValues>({
    resolver: zodResolver(createLocationSchema) as unknown as Resolver<LocationFormValues>,
    defaultValues: initial,
    mode: 'onTouched',
  });

  // Start fresh every time the drawer opens.
  useEffect(() => {
    if (open) {
      form.reset(initial);
      setStep(0);
      setFormError(null);
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Defaults depend on the session and on whether this is the first location; follow them until the person starts typing.
  useEffect(() => {
    if (open && !form.formState.isDirty) form.reset(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial]);

  const values = form.watch();
  const missing = missingActivationFields({
    phone: values.phone?.trim() || null,
    address: { line1: values.address?.line1?.trim(), city: values.address?.city?.trim(), state: values.address?.state?.trim(), postalCode: values.address?.postalCode?.trim(), country: values.address?.country },
  });
  const missingCount = Object.keys(missing).length;

  const requestClose = () => {
    if (create.isPending) return;
    if (form.formState.isDirty) setConfirmDiscard(true);
    else onOpenChange(false);
  };

  const next = async () => {
    const ok = await form.trigger(STEPS[step]!.fields as unknown as (keyof LocationFormValues)[]);
    if (ok) setStep((s) => Math.min(s + 1, LAST));
  };

  const submit = async (intent: 'DRAFT' | 'ACTIVE') => {
    setFormError(null);
    form.setValue('intent', intent);
    await form.handleSubmit(
      async (data) => {
        try {
          const location = await create.mutateAsync(data as unknown as CreateLocationInput);
          if (location.isPrimary) toast.success(`${location.displayName} is now your Primary Location 🎉`);
          else if (location.status === 'ACTIVE') toast.success(`${location.displayName} is now active.`);
          else toast.success(`${location.displayName} saved as a draft.`);
          onOpenChange(false);
          onCreated?.(location);
        } catch (err) {
          setFormError(applyServerErrors(err, form.setError, ALL_LOCATION_FIELDS));
          // Take the person to the step that owns the first field the server complained about.
          const first = err instanceof ApiError ? Object.keys(err.fieldErrors).find((f) => (ALL_LOCATION_FIELDS as string[]).includes(f)) : undefined;
          if (first) setStep(stepOfField(first));
        }
      },
      (errors) => {
        const first = Object.keys(errors).find((k) => k !== 'root') ?? 'displayName';
        const nested = first === 'address' ? `address.${Object.keys((errors as { address?: object }).address ?? {})[0] ?? 'line1'}` : first;
        setStep(stepOfField(nested));
        setFormError(intent === 'ACTIVE' ? 'Complete the highlighted details to activate this location, or save it as a draft.' : 'Some fields need your attention.');
      },
    )();
  };

  const title = isFirst ? 'Add Primary Location' : 'Add Location';

  return (
    <>
      <Drawer open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DrawerContent
          title={title}
          description={isFirst ? 'Your Primary Location is the school’s main campus.' : 'Add a campus, branch or administrative office.'}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <Stepper current={step} onJump={setStep} />
          <form
            className="flex min-h-0 flex-1 flex-col"
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              if (step < LAST) void next();
            }}
          >
            <DrawerBody>
              {formError && (
                <Alert tone="danger" className="mb-5">
                  {formError}
                </Alert>
              )}
              {step === 0 && (
                <BasicsFields
                  form={form}
                  schoolId={school.schoolId}
                  canCheckCode={can('location:view_config')}
                  showPrimary={canSetPrimary && canActivate}
                  autoSuggest
                  primaryHint={isFirst ? 'This is your first location, so it will become Primary as soon as it’s active.' : undefined}
                />
              )}
              {step === 1 && <AddressFields form={form} />}
              {step === 2 && <ContactFields form={form} showNotes />}
              {step === 3 && <DefaultsFields form={form} school={school} />}
              {step === 4 && (
                <div className="space-y-4">
                  <ReviewCard title="Basics" onEdit={() => setStep(0)}>
                    <Row label="Name" value={values.displayName} />
                    <Row label="Code" value={<span className="font-mono">{values.locationCode.trim().toUpperCase()}</span>} />
                    <Row label="Type" value={LOCATION_TYPE_LABELS[values.locationType]} />
                    <Row label="Opening date" value={values.openingDate ? formatDateOnly(values.openingDate) : ''} />
                    <Row label="Primary" value={values.isPrimary ? 'Yes — will be your Primary Location' : 'No'} />
                  </ReviewCard>
                  <ReviewCard title="Address" onEdit={() => setStep(1)}>
                    <Row label="Address" value={values.address.line1 ? formatAddress({ ...values.address, line1: values.address.line1, line2: values.address.line2 || null, locality: values.address.locality || null, city: values.address.city || null, district: null, state: values.address.state || null, postalCode: values.address.postalCode || null }) : ''} />
                    <Row label="Country" value={countryName(values.address.country)} />
                  </ReviewCard>
                  <ReviewCard title="Contact" onEdit={() => setStep(2)}>
                    <Row label="Phone" value={values.phone.trim() ? formatPhone(normalizePhone(values.phone) ?? values.phone) : ''} />
                    <Row label="Email" value={values.email} />
                    <Row label="Website" value={values.websiteUrl} />
                  </ReviewCard>
                  <ReviewCard title="Defaults" onEdit={() => setStep(3)}>
                    <Row label="Time zone" value={values.timezoneOverride ?? `${school.defaultTimezone} (school default)`} />
                    <Row label="Currency" value={values.currencyOverride ?? `${school.defaultCurrency} (school default)`} />
                    <Row label="Locale" value={values.localeOverride ?? `${school.defaultLocale} (school default)`} />
                  </ReviewCard>
                  {missingCount > 0 && (
                    <Alert tone="warning" title="A few details are needed before this location can go live">
                      <ul className="list-disc pl-5">
                        {Object.entries(missing).map(([field, message]) => (
                          <li key={field}>{message}</li>
                        ))}
                      </ul>
                      <p className="mt-1">You can still save it as a draft and finish later.</p>
                    </Alert>
                  )}
                </div>
              )}
            </DrawerBody>

            <DrawerFooter>
              {step > 0 && (
                <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => setStep((s) => s - 1)} disabled={create.isPending}>
                  <ArrowLeft /> Back
                </Button>
              )}
              {step < LAST ? (
                <Button type="submit">
                  Next <ArrowRight />
                </Button>
              ) : (
                <>
                  <Button type="button" variant="outline" onClick={() => void submit('DRAFT')} loading={create.isPending && values.intent === 'DRAFT'} loadingText="Saving draft…" disabled={create.isPending}>
                    <Save /> Save as Draft
                  </Button>
                  {canActivate && (
                    <Button type="button" onClick={() => void submit('ACTIVE')} loading={create.isPending && values.intent === 'ACTIVE'} loadingText="Activating…" disabled={create.isPending || missingCount > 0} title={missingCount > 0 ? 'Complete the required details first' : undefined}>
                      <Rocket /> Activate Location
                    </Button>
                  )}
                </>
              )}
            </DrawerFooter>
          </form>
          {step === LAST && missingCount > 0 && canActivate && (
            <p className="sr-only">
              <TriangleAlert aria-hidden="true" /> Activate Location is disabled until the required details are filled in.
            </p>
          )}
        </DrawerContent>
      </Drawer>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this new location?"
        description="You’ve entered some details. If you close now, they’ll be lost."
        confirmLabel="Discard"
        loadingLabel="Discarding…"
        tone="danger"
        onConfirm={() => onOpenChange(false)}
      />
    </>
  );
}
