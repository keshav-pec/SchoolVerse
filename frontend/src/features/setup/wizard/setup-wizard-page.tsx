import { useEffect, useRef, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate, useNavigate } from 'react-router';
import { createSchoolSchema, SCHOOL_CODE_TAKEN_MESSAGE, SCHOOL_PROFILE_FIELDS, SETUP_STEP_COUNT, type SchoolDTO, type UpdateSchoolInput } from '@shared';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { BusRoute } from '@/components/sv/bus-route';
import { ErrorState } from '@/components/sv/error-state';
import { WizardLayout } from '@/layouts/wizard-layout';
import { useAuth, useSession } from '@/lib/auth';
import { applyServerErrors } from '@/lib/errors';
import { FullScreenLoader } from '@/routes/guards';
import { useLocations } from '../../locations/api';
import { fetchSchoolCodeAvailability, useCreateSchool, useCurrentSchool, useUpdateSchool } from '../../school-profile/api';
import { ContactFields, DefaultsFields, IDENTITY_FIELDS, IdentityFields, schoolFormValues, type SchoolFormValues } from '../../school-profile/school-fields';
import { useSaveSetupProgress } from '../api';
import { clearDraft, readDraft, writeDraft } from './draft';
import { AdditionalLocationsStep, CompleteStep, PrimaryLocationStep, ReviewStep, StepActions, StepCard, StepHeading, pickPrimaryCandidate } from './wizard-steps';

const STOPS = [
  { key: 'identity', label: 'School identity' },
  { key: 'contact', label: 'Contact' },
  { key: 'primary', label: 'Primary location' },
  { key: 'more', label: 'More locations' },
  { key: 'review', label: 'Review' },
  { key: 'finish', label: 'Finish' },
] as const;

const clampStep = (n: number) => Math.min(Math.max(Math.trunc(n) || 1, 1), SETUP_STEP_COUNT);

function Wizard({ school, onFinishing }: { school: SchoolDTO | null; onFinishing: (finishing: boolean) => void }) {
  const session = useSession();
  const navigate = useNavigate();
  const tenantId = session.tenant.tenantId;
  const saveProgress = useSaveSetupProgress();
  const createSchool = useCreateSchool();
  const updateSchool = useUpdateSchool(school?.schoolId ?? '');
  const [formError, setFormError] = useState<string | null>(null);
  // Once the school exists the browser draft is obsolete; never write it again.
  const draftDone = useRef(false);

  // Before the school exists the only thing to resume from is this browser; afterwards it is the server.
  const [step, setStep] = useState(() => (school ? clampStep(school.setup?.currentStep ?? 1) : (readDraft(tenantId)?.step ?? 1)));

  const form = useForm<SchoolFormValues>({
    resolver: zodResolver(createSchoolSchema) as unknown as Resolver<SchoolFormValues>,
    defaultValues: school ? schoolFormValues(school) : { ...schoolFormValues(null), ...readDraft(tenantId)?.values },
    mode: 'onTouched',
  });

  useEffect(() => {
    if (school || draftDone.current) return;
    writeDraft(tenantId, { step: Math.min(step, 2), values: form.getValues() });
    const sub = form.watch((values) => {
      if (!draftDone.current) writeDraft(tenantId, { step: Math.min(step, 2), values: values as Partial<SchoolFormValues> });
    });
    return () => sub.unsubscribe();
  }, [school, step, tenantId, form]);

  const go = (n: number, schoolId = school?.schoolId) => {
    setStep(n);
    setFormError(null);
    window.scrollTo({ top: 0 });
    if (schoolId) saveProgress.mutate({ schoolId, step: n });
  };

  const locations = useLocations(school?.schoolId, { pageSize: 100 });
  const all = locations.data?.items ?? [];
  const candidate = pickPrimaryCandidate(all);
  const others = all.filter((l) => l.locationId !== candidate?.locationId);

  // ── steps 1–2: create or update the school
  const nextFromIdentity = async () => {
    if (!(await form.trigger([...IDENTITY_FIELDS]))) return;
    // Don't let anyone move on with a code another school already uses.
    try {
      const r = await fetchSchoolCodeAvailability({ code: form.getValues('schoolCode') });
      if (r.valid && !r.available) {
        form.setError('schoolCode', { type: 'server', message: r.message ?? SCHOOL_CODE_TAKEN_MESSAGE });
        return;
      }
    } catch {
      // The server re-checks on save; a failed pre-check must not block the wizard.
    }
    go(2);
  };

  const submitProfile = form.handleSubmit(
    async (values) => {
      setFormError(null);
      try {
        if (!school) {
          const created = await createSchool.mutateAsync(values as never);
          draftDone.current = true;
          clearDraft(tenantId);
          toast.success('School profile created. Now your first campus.');
          go(3, created.schoolId);
          return;
        }
        const dirty = form.formState.dirtyFields as Record<string, boolean | undefined>;
        const patch: Record<string, unknown> = {};
        for (const f of SCHOOL_PROFILE_FIELDS) if (dirty[f]) patch[f] = (values as unknown as Record<string, unknown>)[f];
        if (Object.keys(patch).length > 0) {
          const saved = await updateSchool.mutateAsync(patch as UpdateSchoolInput);
          form.reset(schoolFormValues(saved));
        }
        go(3);
      } catch (err) {
        setFormError(applyServerErrors(err, form.setError, SCHOOL_PROFILE_FIELDS));
        const first = Object.keys(form.formState.errors)[0];
        if (first && (IDENTITY_FIELDS as readonly string[]).includes(first)) setStep(1);
      }
    },
    (errors) => {
      const first = Object.keys(errors)[0] ?? '';
      setStep((IDENTITY_FIELDS as readonly string[]).includes(first) ? 1 : 2);
    },
  );

  // Steps 3+ need the school; if someone lands there without one, start at the top.
  const effectiveStep = !school && step > 2 ? 2 : step;
  const profile = school ?? null;

  return (
    <WizardLayout progress={<BusRoute stops={STOPS} current={effectiveStep} onJump={go} />}>
      {effectiveStep === 1 && (
        <StepCard>
          <StepHeading eyebrow="Step 1 of 6" title="Let’s set up your school">
            Start with how your school is known. You can change any of this later.
          </StepHeading>
          {formError && <Alert tone="danger" className="mb-5">{formError}</Alert>}
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void nextFromIdentity();
            }}
          >
            <IdentityFields form={form} autoSuggestCode={!school} />
            <StepActions>
              <Button type="submit" size="lg">
                Continue <ArrowRight />
              </Button>
            </StepActions>
          </form>
        </StepCard>
      )}

      {effectiveStep === 2 && (
        <StepCard>
          <StepHeading eyebrow="Step 2 of 6" title="How can people reach you?">
            Contact details and the defaults every campus will inherit.
          </StepHeading>
          {formError && <Alert tone="danger" className="mb-5">{formError}</Alert>}
          <form noValidate onSubmit={submitProfile}>
            <div className="space-y-8">
              <ContactFields form={form} />
              <div>
                <h2 className="mb-3 text-base font-bold">Operational defaults</h2>
                <DefaultsFields form={form} />
              </div>
            </div>
            <StepActions>
              <Button type="button" variant="ghost" className="sm:mr-auto" onClick={() => go(1)}>
                <ArrowLeft /> Back
              </Button>
              <Button type="submit" size="lg" loading={form.formState.isSubmitting} loadingText={school ? 'Saving…' : 'Creating your school…'}>
                Save &amp; continue <ArrowRight />
              </Button>
            </StepActions>
          </form>
        </StepCard>
      )}

      {effectiveStep === 3 && profile && <PrimaryLocationStep school={profile} candidate={candidate} onBack={() => go(2)} onDone={() => go(4)} />}
      {effectiveStep === 4 && profile && <AdditionalLocationsStep school={profile} others={others} loading={locations.isLoading} onBack={() => go(3)} onNext={() => go(5)} />}
      {effectiveStep === 5 && profile && <ReviewStep school={profile} candidate={candidate} others={others} onEdit={go} onBack={() => go(4)} onNext={() => go(6)} />}
      {effectiveStep === 6 && profile && (
        <CompleteStep school={profile} candidate={candidate} onBack={() => go(5)} onEdit={go} onFinishing={onFinishing} onFinished={() => navigate('/school-setup', { replace: true, state: { justCompleted: true } })} />
      )}
    </WizardLayout>
  );
}

/** /setup — the first-time wizard. Admins only; finished schools go to the overview instead. */
export function SetupWizardPage() {
  const { can } = useAuth();
  const q = useCurrentSchool();
  // Completing flips `setupCompleted` in the cache. Stay put while the celebration plays instead of redirecting at once.
  const [finishing, setFinishing] = useState(false);
  if (q.isLoading) return <FullScreenLoader label="Getting your setup ready…" />;
  if (q.isError) return <div className="p-8"><ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} /></div>;
  if (!can('setup:manage')) return <Navigate to="/" replace />;
  if (q.data?.setupCompleted && !finishing) return <Navigate to="/school-setup" replace />;
  // One instance for the whole flow: creating the school at step 2 must not remount (and so rewind) the wizard.
  return <Wizard school={q.data ?? null} onFinishing={setFinishing} />;
}
