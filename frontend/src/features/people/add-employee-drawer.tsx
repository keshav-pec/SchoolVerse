import { useEffect, useState } from 'react';
import { Controller, useForm, type Resolver } from 'react-hook-form';
import { Link, useNavigate } from 'react-router';
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
import { ArrowLeft, ArrowRight, Sparkles, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { FormComboboxField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { DrawerStepper, ReviewCard, ReviewRow, stepOfField } from '@/components/sv/drawer-steps';
import { api, ApiError } from '@/lib/api';
import { applyServerErrors } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { useActiveLocations } from '../academic/api';
import { useAddSuggestedMasters, useDepartments, useDesignations, useEmployees, usePeopleMutation } from './api';
import { EmployeeCodeField } from './employee-code-field';
import { CATEGORY_HELP, DESIGNATION_HELP } from './help-copy';

const todayIso = () => new Date().toLocaleDateString('en-CA');

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
  { key: 'placement', label: 'Where They Work', fields: PLACEMENT_FIELDS },
  { key: 'review', label: 'Review', fields: [] },
] as const;
const LAST = STEPS.length - 1;

/** Add employee in three steps: basics, where they work, review. After saving, the profile opens with its next steps. */
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
  const suggestDepartments = useAddSuggestedMasters('departments');
  const suggestDesignations = useAddSuggestedMasters('designations');

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
      // Most people are added on the day they join, so today is filled in.
      form.reset({ ...EMPTY_EMPLOYEE_FORM, joiningDate: todayIso() });
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
        if (first) setStep(stepOfField(STEPS, first));
      }
    },
    (errs) => {
      const first = Object.keys(errs).find((k) => k !== 'root');
      if (first) setStep(stepOfField(STEPS, first));
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
          <DrawerStepper steps={STEPS} current={step} onJump={setStep} />
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
                    hint="Optional."
                    autoComplete="off"
                    error={errors.legalMiddleName?.message}
                    {...register('legalMiddleName')}
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FormComboboxField
                      label="Category"
                      required
                      labelAside={<InfoTip label="About the category">{CATEGORY_HELP}</InfoTip>}
                      control={form.control}
                      name="employeeCategory"
                      placeholder="Choose…"
                      options={EMPLOYEE_CATEGORIES.map((c) => ({ value: c, label: EMPLOYEE_CATEGORY_LABELS[c] }))}
                      searchPlaceholder="Search categories…"
                      error={errors.employeeCategory?.message}
                    />
                    <Controller
                      control={form.control}
                      name="employeeCode"
                      render={({ field }) => (
                        <EmployeeCodeField
                          value={field.value}
                          onChange={(v) => field.onChange(v)}
                          onBlur={field.onBlur}
                          category={values.employeeCategory}
                          error={errors.employeeCode?.message}
                        />
                      )}
                    />
                  </div>
                  <div className="grid gap-5 sm:grid-cols-2">
                    <TextField
                      label="Joining date"
                      type="date"
                      required
                      hint="Today is filled in. Change it if they joined on another day."
                      error={errors.joiningDate?.message}
                      {...register('joiningDate')}
                    />
                    <TextField
                      label="Employment type"
                      list="employment-types"
                      placeholder="Permanent"
                      hint="Optional. Pick from the list or type your own."
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
                  <FormComboboxField
                    label="Primary location"
                    required
                    hint="The campus where they mainly work. You can add more campuses later."
                    control={form.control}
                    name="primaryLocationId"
                    placeholder="Choose…"
                    options={(locations.data ?? []).map((l) => ({ value: l.locationId, label: l.displayName, hint: l.locationCode }))}
                    searchPlaceholder="Search locations…"
                    error={errors.primaryLocationId?.message}
                  />
                  <div className="grid gap-5 sm:grid-cols-2">
                    <FormComboboxField
                      label="Department"
                      required
                      hint="The team they belong to, e.g. Academics."
                      control={form.control}
                      name="departmentId"
                      placeholder="Choose…"
                      options={activeDepartments.map((d) => ({ value: d.departmentId, label: d.name }))}
                      searchPlaceholder="Search departments…"
                      error={errors.departmentId?.message}
                    />
                    <FormComboboxField
                      label="Designation"
                      required
                      hint="Their job title, e.g. PGT or Accountant."
                      labelAside={<InfoTip label="About the designation">{DESIGNATION_HELP}</InfoTip>}
                      control={form.control}
                      name="designationId"
                      placeholder="Choose…"
                      options={activeDesignations.map((d) => ({ value: d.designationId, label: d.name }))}
                      searchPlaceholder="Search designations…"
                      error={errors.designationId?.message}
                    />
                  </div>
                  {(['departments', 'designations'] as const).map((kind) => {
                    const empty =
                      kind === 'departments'
                        ? !departments.isLoading && activeDepartments.length === 0
                        : !designations.isLoading && activeDesignations.length === 0;
                    if (!empty) return null;
                    const suggest = kind === 'departments' ? suggestDepartments : suggestDesignations;
                    return (
                      <Alert key={kind} tone="warning">
                        <p>
                          Your school has no {kind} yet, so there is nothing to choose. Add the
                          common ones in one click, or{' '}
                          <Link to="/people/settings" className="font-semibold text-brand underline">
                            set up your own list
                          </Link>
                          .
                        </p>
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          className="mt-2"
                          onClick={suggest.run}
                          loading={suggest.pending}
                          loadingText="Adding…"
                        >
                          <Sparkles /> Add Suggested {kind === 'departments' ? 'Departments' : 'Designations'}
                        </Button>
                      </Alert>
                    );
                  })}
                  <FormComboboxField
                    label="Reports to"
                    hint="Optional. The person they answer to, such as the Principal."
                    control={form.control}
                    name="reportingManagerId"
                    options={[{ value: '', label: 'No one' }, ...(managers.data?.items ?? []).map((m) => ({ value: m.employeeId, label: m.fullName, hint: m.employeeCode }))]}
                    searchPlaceholder="Search people…"
                    error={errors.reportingManagerId?.message}
                  />
                </div>
              )}
              {step === 2 && (
                <div className="space-y-4">
                  <ReviewCard title="Basics" onEdit={() => setStep(0)}>
                    <ReviewRow
                      label="Name"
                      value={[values.legalFirstName, values.legalMiddleName, values.legalLastName]
                        .filter((p) => p.trim())
                        .join(' ')}
                    />
                    <ReviewRow
                      label="Category"
                      value={
                        values.employeeCategory
                          ? EMPLOYEE_CATEGORY_LABELS[values.employeeCategory]
                          : ''
                      }
                    />
                    <ReviewRow
                      label="Employee code"
                      value={
                        <span className="font-mono">
                          {values.employeeCode.trim().toUpperCase()}
                        </span>
                      }
                    />
                    <ReviewRow
                      label="Joining date"
                      value={values.joiningDate ? formatDateOnly(values.joiningDate) : ''}
                    />
                    <ReviewRow label="Employment type" value={values.employmentType} />
                  </ReviewCard>
                  <ReviewCard title="Where They Work" onEdit={() => setStep(1)}>
                    <ReviewRow label="Primary location" value={locationName} />
                    <ReviewRow label="Department" value={departmentName} />
                    <ReviewRow label="Designation" value={designationName} />
                    <ReviewRow label="Reports to" value={managerName} />
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
                  <UserPlus /> Save Employee
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
