import { useState, type ReactNode } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { createLocationSchema, LOCATION_TYPE_LABELS, type CreateLocationInput, type LocationDTO, type SchoolDTO } from '@shared';
import { ArrowLeft, ArrowRight, MapPin, PartyPopper, Pencil, Plus, Rocket, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import { EmptyMap } from '@/components/illustrations/empty-map';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CampusAvatar } from '@/components/sv/campus-avatar';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { PrimaryBadge } from '@/components/sv/primary-badge';
import { StatusPill } from '@/components/sv/status-pill';
import { ApiError } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { celebrate } from '@/lib/confetti';
import { applyServerErrors } from '@/lib/errors';
import { formatAddress, formatPhone } from '@/lib/format';
import { localeLabel } from '@/lib/options';
import { AddLocationDrawer } from '@/features/locations/add-location-drawer';
import { useCreateLocation, useDeleteLocation, useLocation, useLocationAction, useUpdateLocation } from '@/features/locations/api';
import { EditLocationDrawer } from '@/features/locations/edit-location-drawer';
import {
  ALL_LOCATION_FIELDS,
  buildLocationPatch,
  EMPTY_LOCATION_FORM,
  LOCATION_PATCH_FIELDS,
  LocationEditorFields,
  toFormValues,
  type LocationFormValues,
} from '@/features/locations/location-form';
import { useCompleteSetup } from '../api';

// ───────────────────────────────────────────────────────────── shared bits

export function StepHeading({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="mb-6">
      <p className="text-[11px] font-bold tracking-[0.14em] text-brand uppercase">{eyebrow}</p>
      <h1 className="mt-1 text-[26px] leading-tight font-extrabold sm:text-[30px]">{title}</h1>
      {children && <p className="mt-1.5 text-[15px] text-muted">{children}</p>}
    </div>
  );
}

export function StepCard({ children }: { children: ReactNode }) {
  return (
    <motion.section initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 220, damping: 24 }} className="rounded-card border border-line bg-white p-5 shadow-card sm:p-8">
      {children}
    </motion.section>
  );
}

export function StepActions({ children }: { children: ReactNode }) {
  return <div className="mt-8 flex flex-col-reverse gap-2 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-end">{children}</div>;
}

/** The location created first is the Primary candidate: the Primary if one exists, else the earliest. */
export function pickPrimaryCandidate(locations: LocationDTO[]): LocationDTO | null {
  return locations.find((l) => l.isPrimary) ?? [...locations].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0] ?? null;
}

// ───────────────────────────────────────────────────────────── step 3 — primary location

function PrimaryLocationForm({ school, detail, onBack, onDone }: { school: SchoolDTO; detail: ReturnType<typeof useLocation>['data']; onBack: () => void; onDone: () => void }) {
  const { can } = useAuth();
  const create = useCreateLocation(school.schoolId);
  const update = useUpdateLocation(detail?.locationId ?? '');
  const activate = useLocationAction(detail?.locationId ?? '');
  const [formError, setFormError] = useState<string | null>(null);

  const form = useForm<LocationFormValues>({
    // Validated as an ACTIVE location, because the Primary Location must be ready to go live.
    resolver: zodResolver(createLocationSchema) as unknown as Resolver<LocationFormValues>,
    defaultValues: detail ? { ...toFormValues(detail), intent: 'ACTIVE', isPrimary: false } : { ...EMPTY_LOCATION_FORM, locationType: 'MAIN_CAMPUS', intent: 'ACTIVE' },
    mode: 'onTouched',
  });

  const submit = form.handleSubmit(
    async (values) => {
      setFormError(null);
      try {
        if (!detail) {
          await create.mutateAsync({ ...values, intent: 'ACTIVE', isPrimary: true } as unknown as CreateLocationInput);
          toast.success('Location created successfully.');
        } else {
          const patch = buildLocationPatch(LOCATION_PATCH_FIELDS, form.formState.dirtyFields as Record<string, unknown>, values as unknown as Record<string, unknown>);
          if (Object.keys(patch).length > 0) await update.mutateAsync(patch);
          if (detail.status !== 'ACTIVE') await activate.mutateAsync('activate');
        }
        onDone();
      } catch (err) {
        setFormError(applyServerErrors(err, form.setError, ALL_LOCATION_FIELDS));
      }
    },
    () => setFormError('Some details need your attention. The Primary Location needs a phone number and a full address.'),
  );

  return (
    <StepCard>
      <StepHeading eyebrow="Step 3 of 5" title="Your Primary Location">
        This is your main campus. It becomes the school’s Primary Location and the default for everything that follows.
      </StepHeading>
      <form onSubmit={submit} noValidate>
        {formError && (
          <Alert tone="danger" className="mb-6">
            {formError}
          </Alert>
        )}
        <LocationEditorFields form={form} school={school} location={detail ?? undefined} canCheckCode={can('location:view_config')} autoSuggest={!detail} showNotes />
        <StepActions>
          <Button type="button" variant="ghost" className="sm:mr-auto" onClick={onBack}>
            <ArrowLeft /> Back
          </Button>
          <Button type="submit" size="lg" loading={form.formState.isSubmitting} loadingText="Saving…">
            Save &amp; Continue <ArrowRight />
          </Button>
        </StepActions>
      </form>
    </StepCard>
  );
}

export function PrimaryLocationStep({ school, candidate, onBack, onDone }: { school: SchoolDTO; candidate: LocationDTO | null; onBack: () => void; onDone: () => void }) {
  const detail = useLocation(candidate?.locationId);
  if (candidate && detail.isLoading) {
    return (
      <StepCard>
        <div className="space-y-4" role="status" aria-label="Loading your Primary Location">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-11" />
          <Skeleton className="h-11" />
          <Skeleton className="h-40" />
        </div>
      </StepCard>
    );
  }
  return <PrimaryLocationForm key={candidate?.locationId ?? 'new'} school={school} detail={candidate ? detail.data : undefined} onBack={onBack} onDone={onDone} />;
}

// ───────────────────────────────────────────────────────────── step 4 — additional locations

function RemoveDraft({ location }: { location: LocationDTO }) {
  const remove = useDeleteLocation(location.locationId);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" size="icon-sm" aria-label={`Remove draft ${location.displayName}`} onClick={() => setOpen(true)}>
        <Trash2 className="text-danger" />
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="danger"
        icon={<Trash2 className="size-5" />}
        title={`Remove draft ${location.displayName}?`}
        description="The draft will be permanently deleted. This can’t be undone."
        confirmLabel="Remove draft"
        loadingLabel="Removing…"
        onConfirm={async () => {
          await remove.mutateAsync();
          toast.success(`Draft ${location.displayName} was discarded.`);
        }}
      />
    </>
  );
}

export function AdditionalLocationsStep({ school, others, loading, onBack, onNext }: { school: SchoolDTO; others: LocationDTO[]; loading: boolean; onBack: () => void; onNext: () => void }) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  return (
    <StepCard>
      <StepHeading eyebrow="Step 4 of 5" title="Any other campuses?">
        Add branches or administrative offices now, as drafts or active. You can always add more later.
      </StepHeading>

      {loading ? (
        <Skeleton className="h-16" />
      ) : others.length === 0 ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-8 text-center">
          <EmptyMap className="mx-auto w-40" />
          <p className="mt-2 font-semibold">Just one campus? That’s perfectly fine.</p>
          <p className="text-sm text-muted">Skip ahead, or add another location.</p>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line" aria-label="Additional locations">
          {others.map((l) => (
            <li key={l.locationId} className="flex items-center gap-3 p-3.5">
              <CampusAvatar code={l.locationCode} size="sm" />
              <div className="min-w-0 flex-1">
                <p className="truncate font-semibold">{l.displayName}</p>
                <p className="truncate text-xs text-muted">
                  <span className="font-mono font-semibold">{l.locationCode}</span> · {LOCATION_TYPE_LABELS[l.locationType]}
                  {l.address.city ? ` · ${l.address.city}` : ''}
                </p>
              </div>
              <StatusPill status={l.status} />
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${l.displayName}`} onClick={() => setEditing(l.locationId)}>
                <Pencil />
              </Button>
              {l.status === 'DRAFT' && <RemoveDraft location={l} />}
            </li>
          ))}
        </ul>
      )}

      <div className="mt-4">
        <Button variant="secondary" onClick={() => setAdding(true)}>
          <Plus /> Add Another Location
        </Button>
      </div>

      <StepActions>
        <Button type="button" variant="ghost" className="sm:mr-auto" onClick={onBack}>
          <ArrowLeft /> Back
        </Button>
        <Button size="lg" onClick={onNext}>
          {others.length === 0 ? 'Skip For Now' : 'Continue'} <ArrowRight />
        </Button>
      </StepActions>

      <AddLocationDrawer open={adding} onOpenChange={setAdding} school={school} isFirst={false} />
      <EditLocationDrawer locationId={editing} school={school} open={editing !== null} onOpenChange={(o) => !o && setEditing(null)} />
    </StepCard>
  );
}

// ───────────────────────────────────────────────────────────── step 5 — review

function ReviewCard({ title, step, onEdit, children }: { title: string; step: number; onEdit: (step: number) => void; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-line p-4 sm:p-5" aria-label={title}>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-base font-bold">{title}</h2>
        <Button variant="ghost" size="sm" onClick={() => onEdit(step)} aria-label={`Edit ${title}`}>
          <Pencil /> Edit
        </Button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[160px_1fr]">{children}</dl>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 font-medium break-words">{children || <span className="text-muted">—</span>}</dd>
    </>
  );
}

/** Which wizard step owns each field the server may report as missing. */
function stepForMissing(field: string): number {
  if (field.startsWith('primaryLocation')) return 3;
  if (['displayName', 'legalName', 'schoolCode'].includes(field)) return 1;
  return 2;
}

export function ReviewStep({
  school,
  candidate,
  others,
  onEdit,
  onBack,
  onFinishing,
  onFinished,
}: {
  school: SchoolDTO;
  candidate: LocationDTO | null;
  others: LocationDTO[];
  onEdit: (step: number) => void;
  onBack: () => void;
  /** Tells the page not to redirect away while the celebration plays. */
  onFinishing: (finishing: boolean) => void;
  onFinished: () => void;
}) {
  const complete = useCompleteSetup();
  const [done, setDone] = useState(false);
  const error = complete.error;
  const missing = error instanceof ApiError && error.code === 'SETUP_INCOMPLETE' ? Object.entries(error.fieldErrors) : [];

  const finish = async () => {
    onFinishing(true);
    try {
      await complete.mutateAsync({ schoolId: school.schoolId, primaryLocationId: candidate?.locationId });
      setDone(true);
      void celebrate();
      setTimeout(onFinished, 3200);
    } catch {
      onFinishing(false); // the error is shown below
    }
  };

  if (done) {
    return (
      <StepCard>
        <div className="py-6 text-center" role="status">
          <motion.div initial={{ scale: 0.5, rotate: -10 }} animate={{ scale: 1, rotate: 0 }} transition={{ type: 'spring', stiffness: 260, damping: 14 }} className="mx-auto grid size-20 place-items-center rounded-3xl bg-sun-soft text-[#7a5300]">
            <PartyPopper className="size-10" aria-hidden="true" />
          </motion.div>
          <h1 className="mt-5 text-[28px] font-extrabold">You’re all set! 🎉</h1>
          <p className="mx-auto mt-2 max-w-md text-[15px] text-muted">
            {candidate?.displayName ?? 'Your campus'} is now your Primary Location. Taking you to your School Setup overview…
          </p>
          <Button size="lg" className="mt-6" onClick={onFinished}>
            Go To The Overview <ArrowRight />
          </Button>
        </div>
      </StepCard>
    );
  }

  return (
    <StepCard>
      <StepHeading eyebrow="Step 5 of 5" title="Review and finish">
        Check the details below. Use Edit to change anything, then complete your setup.
      </StepHeading>

      {missing.length > 0 && (
        <Alert tone="warning" title="A few things still need attention" className="mb-5">
          <ul className="mt-1 space-y-1.5">
            {missing.map(([field, message]) => (
              <li key={field} className="flex flex-wrap items-center gap-2">
                <span>{message}</span>
                <Button variant="link" className="h-auto" onClick={() => onEdit(stepForMissing(field))}>
                  Fix This
                </Button>
              </li>
            ))}
          </ul>
        </Alert>
      )}
      {error && missing.length === 0 && (
        <Alert tone="danger" className="mb-5">
          {error instanceof Error ? error.message : 'Something went wrong.'}
        </Alert>
      )}

      <div className="space-y-4">
        <ReviewCard title="School identity" step={1} onEdit={onEdit}>
          <Row label="School name">{school.displayName}</Row>
          <Row label="Short name">{school.shortName}</Row>
          <Row label="Legal name">{school.legalName}</Row>
          <Row label="School code">
            <span className="font-mono">{school.schoolCode}</span>
          </Row>
        </ReviewCard>
        <ReviewCard title="Contact & defaults" step={2} onEdit={onEdit}>
          <Row label="Email">{school.primaryEmail}</Row>
          <Row label="Phone">{formatPhone(school.primaryPhone)}</Row>
          <Row label="Alternate phone">{school.alternatePhone ? formatPhone(school.alternatePhone) : ''}</Row>
          <Row label="Website">{school.websiteUrl}</Row>
          <Row label="Time zone">{school.defaultTimezone.replace(/_/g, ' ')}</Row>
          <Row label="Currency · Language">{`${school.defaultCurrency} · ${localeLabel(school.defaultLocale)}`}</Row>
        </ReviewCard>
        <ReviewCard title="Primary Location" step={3} onEdit={onEdit}>
          {candidate ? (
            <>
              <Row label="Name">
                <span className="inline-flex flex-wrap items-center gap-2">
                  {candidate.displayName}
                  <PrimaryBadge />
                </span>
              </Row>
              <Row label="Code">
                <span className="font-mono">{candidate.locationCode}</span>
              </Row>
              <Row label="Address">{formatAddress(candidate.address)}</Row>
              <Row label="Phone">{candidate.phone ? formatPhone(candidate.phone) : ''}</Row>
            </>
          ) : (
            <Row label="Location">Not added yet</Row>
          )}
        </ReviewCard>
        <ReviewCard title={`Additional locations (${others.length})`} step={4} onEdit={onEdit}>
          {others.length === 0 ? (
            <Row label="Locations">None. You can add more later.</Row>
          ) : (
            others.map((l) => (
              <Row key={l.locationId} label={l.locationCode}>
                <span className="inline-flex flex-wrap items-center gap-2">
                  {l.displayName}
                  <StatusPill status={l.status} />
                </span>
              </Row>
            ))
          )}
        </ReviewCard>
      </div>
      <div className="mt-5 rounded-xl bg-brand-soft p-4 text-sm">
        <p className="flex items-center gap-2 font-semibold text-ink">
          <MapPin className="size-4 text-brand" aria-hidden="true" />{' '}
          {candidate ? `Completing setup activates ${candidate.displayName} as your Primary Location and opens your School Setup overview.` : 'Add a Primary Location first.'}
        </p>
        <p className="mt-1 text-muted">After this, add the rest of your campuses and continue with Academic Structure whenever you’re ready.</p>
      </div>

      <StepActions>
        <Button type="button" variant="ghost" className="sm:mr-auto" onClick={onBack} disabled={complete.isPending}>
          <ArrowLeft /> Back
        </Button>
        <Button size="lg" variant="sun" onClick={() => void finish()} loading={complete.isPending} loadingText="Finishing Setup…" disabled={!candidate}>
          <Rocket /> Complete School Setup
        </Button>
      </StepActions>
    </StepCard>
  );
}
