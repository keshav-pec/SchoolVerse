import { useEffect, useState, type ReactNode } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { useNavigate } from 'react-router';
import { zodResolver } from '@hookform/resolvers/zod';
import {
  createEmployeeSchema,
  EMPLOYEE_CATEGORIES,
  EMPLOYEE_CATEGORY_LABELS,
  EMPLOYMENT_TYPE_SUGGESTIONS,
  type CreateEmployeeData,
  type EmployeeCategory,
  type EmployeeProfileDTO,
} from '@shared';
import { ArrowLeft, ArrowRight, Check, Pencil, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { SelectField, TextField } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api, ApiError } from '@/lib/api';
import { applyServerErrors } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useActiveLocations } from '../academic/api';
import { useDepartments, useDesignations, useEmployees, usePeopleMutation } from './api';

/** The form works with text: the shared schema turns blanks into nulls and codes into upper case. */
export interface EmployeeFormValues {
  legalFirstName: string;
  legalMiddleName: string;
  legalLastName: string;
  employeeCategory: EmployeeCategory | '';
  employeeCode: string;
  joiningDate: string;
  employmentType: string;
  primaryLocationId: string;
  departmentId: string;
  designationId: string;
  reportingManagerId: string;
}

export const EMPTY_EMPLOYEE_FORM: EmployeeFormValues = {
  legalFirstName: '',
  legalMiddleName: '',
  legalLastName: '',
  employeeCategory: '',
  employeeCode: '',
  joiningDate: '',
  employmentType: '',
  primaryLocationId: '',
  departmentId: '',
  designationId: '',
  reportingManagerId: '',
};

/** Blank selects and names would otherwise fail with the schema's generic wording ("Must be a valid ID."); say what to do instead. */
const BLANK_MESSAGES: Partial<Record<keyof EmployeeFormValues, string>> = {
  primaryLocationId: 'Choose a primary location.',
  departmentId: 'Choose a department.',
  designationId: 'Choose a designation.',
  joiningDate: 'Enter the joining date.',
};

const resolver: Resolver<EmployeeFormValues> = async (values, context, options) => {
  const result = await (
    zodResolver(createEmployeeSchema) as unknown as Resolver<EmployeeFormValues>
  )(values, context, options);
  const errors = result.errors as Record<string, { type: string; message?: string }>;
  // The schema only checks for a missing name once everything else is valid, so say it up front.
  const required = {
    legalFirstName: 'First name is required.',
    legalLastName: 'Last name is required.',
  } as const;
  for (const [field, message] of Object.entries(required) as [keyof typeof required, string][]) {
    if (!values[field].trim()) errors[field] = { type: 'required', message };
  }
  for (const [field, message] of Object.entries(BLANK_MESSAGES) as [
    keyof EmployeeFormValues,
    string,
  ][]) {
    if (errors[field] && !String(values[field]).trim())
      errors[field] = { ...errors[field], message };
  }
  if (Object.keys(errors).length > 0) return { values: {}, errors: errors as never };
  return result;
};

const BASICS_FIELDS = [
  'legalFirstName',
  'legalMiddleName',
  'legalLastName',
  'employeeCategory',
  'employeeCode',
  'joiningDate',
  'employmentType',
] as const;
const PLACEMENT_FIELDS = [
  'primaryLocationId',
  'departmentId',
  'designationId',
  'reportingManagerId',
] as const;
const ALL_FIELDS = [...BASICS_FIELDS, ...PLACEMENT_FIELDS] as const;

const STEPS = [
  { key: 'basics', label: 'Basics', fields: BASICS_FIELDS },
  { key: 'placement', label: 'Placement', fields: PLACEMENT_FIELDS },
  { key: 'review', label: 'Review', fields: [] },
] as const;
const LAST = STEPS.length - 1;

function stepOfField(field: string): number {
  const i = STEPS.findIndex((s) => (s.fields as readonly string[]).includes(field));
  return i === -1 ? 0 : i;
}

function Stepper({ current, onJump }: { current: number; onJump: (i: number) => void }) {
  return (
    <ol
      className="flex items-center gap-1 border-b border-line bg-canvas px-5 py-3 sm:px-6"
      aria-label="Progress"
    >
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
              className={cn(
                'flex items-center gap-2 rounded-lg py-1 pr-1 text-sm font-semibold outline-none',
                active ? 'text-brand' : done ? 'text-ink' : 'text-muted',
              )}
            >
              <span
                className={cn(
                  'grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold',
                  active
                    ? 'bg-brand text-white'
                    : done
                      ? 'bg-success text-white'
                      : 'bg-ink/10 text-muted',
                )}
              >
                {done ? <Check className="size-3.5" aria-hidden="true" /> : i + 1}
              </span>
              <span>{step.label}</span>
            </button>
            {i < LAST && (
              <span
                aria-hidden="true"
                className={cn('h-0.5 flex-1 rounded-full', done ? 'bg-success' : 'bg-ink/10')}
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

function ReviewCard({
  title,
  onEdit,
  children,
}: {
  title: string;
  onEdit: () => void;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-line p-4">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-sm font-bold">{title}</h3>
        <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${title}`}>
          <Pencil /> Edit
        </Button>
      </div>
      <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[150px_1fr]">{children}</dl>
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

/** Add employee in three steps: basics, placement, review. After saving, the profile opens with its next steps. */
export function AddEmployeeDrawer({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const locations = useActiveLocations();
  const departments = useDepartments(open);
  const designations = useDesignations(open);
  const managers = useEmployees({ pageSize: 100 }, open);

  const create = usePeopleMutation(
    (data: CreateEmployeeData) => api.post<EmployeeProfileDTO>('/employees', data),
    { quiet: true },
  );
  const form = useForm<EmployeeFormValues>({
    resolver,
    defaultValues: EMPTY_EMPLOYEE_FORM,
    mode: 'onTouched',
  });
  const {
    register,
    formState: { errors },
  } = form;
  const values = form.watch();

  useEffect(() => {
    if (open) {
      form.reset(EMPTY_EMPLOYEE_FORM);
      setStep(0);
      setFormError(null);
      create.reset();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const activeDepartments = (departments.data ?? []).filter((d) => d.status === 'ACTIVE');
  const activeDesignations = (designations.data ?? []).filter((d) => d.status === 'ACTIVE');
  const locationName = locations.data?.find(
    (l) => l.locationId === values.primaryLocationId,
  )?.displayName;
  const departmentName = activeDepartments.find(
    (d) => d.departmentId === values.departmentId,
  )?.name;
  const designationName = activeDesignations.find(
    (d) => d.designationId === values.designationId,
  )?.name;
  const managerName = managers.data?.items.find(
    (m) => m.employeeId === values.reportingManagerId,
  )?.fullName;

  const requestClose = () => {
    if (create.isPending) return;
    if (form.formState.isDirty) setConfirmDiscard(true);
    else onOpenChange(false);
  };

  const next = async () => {
    const ok = await form.trigger(STEPS[step]!.fields as unknown as (keyof EmployeeFormValues)[]);
    if (ok) setStep((s) => Math.min(s + 1, LAST));
  };

  const save = form.handleSubmit(
    async (data) => {
      setFormError(null);
      try {
        const employee = await create.mutateAsync(data as unknown as CreateEmployeeData);
        toast.success(`${employee.fullName} has been added. Finish their setup below.`);
        onOpenChange(false);
        navigate(`/people/${employee.employeeId}`);
      } catch (err) {
        setFormError(applyServerErrors(err, form.setError, ALL_FIELDS));
        const first =
          err instanceof ApiError
            ? Object.keys(err.fieldErrors).find((f) =>
                (ALL_FIELDS as readonly string[]).includes(f),
              )
            : undefined;
        if (first) setStep(stepOfField(first));
      }
    },
    (errs) => {
      const first = Object.keys(errs).find((k) => k !== 'root');
      if (first) setStep(stepOfField(first));
      setFormError('Some fields need your attention.');
    },
  );

  return (
    <>
      <Drawer open={open} onOpenChange={(next) => (next ? onOpenChange(true) : requestClose())}>
        <DrawerContent
          title="Add employee"
          description="A new team member starts as Onboarding. You can finish their setup on the next screen."
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
                <div className="space-y-5">
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      label="First name"
                      required
                      autoComplete="off"
                      autoFocus
                      error={errors.legalFirstName?.message}
                      {...register('legalFirstName')}
                    />
                    <TextField
                      label="Last name"
                      required
                      autoComplete="off"
                      error={errors.legalLastName?.message}
                      {...register('legalLastName')}
                    />
                  </div>
                  <TextField
                    label="Middle name"
                    autoComplete="off"
                    error={errors.legalMiddleName?.message}
                    {...register('legalMiddleName')}
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <SelectField
                      label="Category"
                      required
                      error={errors.employeeCategory?.message}
                      {...register('employeeCategory')}
                    >
                      <option value="">Choose…</option>
                      {EMPLOYEE_CATEGORIES.map((c) => (
                        <option key={c} value={c}>
                          {EMPLOYEE_CATEGORY_LABELS[c]}
                        </option>
                      ))}
                    </SelectField>
                    <TextField
                      label="Employee code"
                      required
                      placeholder="FAC-014"
                      autoComplete="off"
                      hint="Unique in your school. You can change it later."
                      error={errors.employeeCode?.message}
                      {...register('employeeCode')}
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      label="Joining date"
                      type="date"
                      required
                      error={errors.joiningDate?.message}
                      {...register('joiningDate')}
                    />
                    <TextField
                      label="Employment type"
                      list="employment-types"
                      placeholder="Permanent"
                      autoComplete="off"
                      error={errors.employmentType?.message}
                      {...register('employmentType')}
                    />
                    <datalist id="employment-types">
                      {EMPLOYMENT_TYPE_SUGGESTIONS.map((t) => (
                        <option key={t} value={t} />
                      ))}
                    </datalist>
                  </div>
                </div>
              )}
              {step === 1 && (
                <div className="space-y-5">
                  <SelectField
                    label="Primary location"
                    required
                    hint="Where this person mainly works. Add more locations later."
                    error={errors.primaryLocationId?.message}
                    {...register('primaryLocationId')}
                  >
                    <option value="">Choose…</option>
                    {(locations.data ?? []).map((l) => (
                      <option key={l.locationId} value={l.locationId}>
                        {l.displayName} ({l.locationCode})
                      </option>
                    ))}
                  </SelectField>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <SelectField
                      label="Department"
                      required
                      error={errors.departmentId?.message}
                      {...register('departmentId')}
                    >
                      <option value="">Choose…</option>
                      {activeDepartments.map((d) => (
                        <option key={d.departmentId} value={d.departmentId}>
                          {d.name}
                        </option>
                      ))}
                    </SelectField>
                    <SelectField
                      label="Designation"
                      required
                      hint="A title only. Access comes from the login role."
                      error={errors.designationId?.message}
                      {...register('designationId')}
                    >
                      <option value="">Choose…</option>
                      {activeDesignations.map((d) => (
                        <option key={d.designationId} value={d.designationId}>
                          {d.name}
                        </option>
                      ))}
                    </SelectField>
                  </div>
                  {!departments.isLoading && activeDepartments.length === 0 && (
                    <Alert tone="warning">
                      There are no departments yet. Add some under Departments &amp; Designations
                      first.
                    </Alert>
                  )}
                  <SelectField
                    label="Reporting manager"
                    hint="Optional."
                    error={errors.reportingManagerId?.message}
                    {...register('reportingManagerId')}
                  >
                    <option value="">No one</option>
                    {(managers.data?.items ?? []).map((m) => (
                      <option key={m.employeeId} value={m.employeeId}>
                        {m.fullName} ({m.employeeCode})
                      </option>
                    ))}
                  </SelectField>
                </div>
              )}
              {step === 2 && (
                <div className="space-y-4">
                  <ReviewCard title="Basics" onEdit={() => setStep(0)}>
                    <Row
                      label="Name"
                      value={[values.legalFirstName, values.legalMiddleName, values.legalLastName]
                        .filter((p) => p.trim())
                        .join(' ')}
                    />
                    <Row
                      label="Category"
                      value={
                        values.employeeCategory
                          ? EMPLOYEE_CATEGORY_LABELS[values.employeeCategory]
                          : ''
                      }
                    />
                    <Row
                      label="Employee code"
                      value={
                        <span className="font-mono">
                          {values.employeeCode.trim().toUpperCase()}
                        </span>
                      }
                    />
                    <Row
                      label="Joining date"
                      value={values.joiningDate ? formatDateOnly(values.joiningDate) : ''}
                    />
                    <Row label="Employment type" value={values.employmentType} />
                  </ReviewCard>
                  <ReviewCard title="Placement" onEdit={() => setStep(1)}>
                    <Row label="Primary location" value={locationName} />
                    <Row label="Department" value={departmentName} />
                    <Row label="Designation" value={designationName} />
                    <Row label="Reporting manager" value={managerName} />
                  </ReviewCard>
                  <Alert tone="info">
                    After saving you’ll see what’s left to do: classes or responsibilities,
                    documents, a login, and activation.
                  </Alert>
                </div>
              )}
            </DrawerBody>

            <DrawerFooter>
              {step > 0 && (
                <Button
                  type="button"
                  variant="ghost"
                  className="sm:mr-auto"
                  onClick={() => setStep((s) => s - 1)}
                  disabled={create.isPending}
                >
                  <ArrowLeft /> Back
                </Button>
              )}
              {step < LAST ? (
                <Button type="submit">
                  Next <ArrowRight />
                </Button>
              ) : (
                <Button
                  type="button"
                  onClick={() => void save()}
                  loading={create.isPending}
                  loadingText="Saving…"
                >
                  <UserPlus /> Save employee
                </Button>
              )}
            </DrawerFooter>
          </form>
        </DrawerContent>
      </Drawer>

      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this new employee?"
        description="You’ve entered some details. If you close now, they’ll be lost."
        confirmLabel="Discard"
        loadingLabel="Discarding…"
        tone="danger"
        onConfirm={() => onOpenChange(false)}
      />
    </>
  );
}
