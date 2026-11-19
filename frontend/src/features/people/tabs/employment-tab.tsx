import { useState } from 'react';
import { EMPLOYMENT_TYPE_SUGGESTIONS, EXIT_REASON_LABELS, type EmployeeProfileDTO } from '@shared';
import { Pencil, Save } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Can } from '@/components/sv/can';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { api, ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { useDepartments, useDesignations, useEmployees, usePeopleMutation } from '../api';

interface FormState {
  employeeCode: string;
  employmentType: string;
  joiningDate: string;
  confirmationDate: string;
  departmentId: string;
  designationId: string;
  reportingManagerId: string;
}

function EditDrawer({ employee, onClose }: { employee: EmployeeProfileDTO; onClose: () => void }) {
  const departments = useDepartments();
  const designations = useDesignations();
  const managers = useEmployees({ pageSize: 100 });
  const initial: FormState = {
    employeeCode: employee.employeeCode,
    employmentType: employee.employmentType ?? '',
    joiningDate: employee.joiningDate,
    confirmationDate: employee.confirmationDate ?? '',
    departmentId: employee.department.departmentId,
    designationId: employee.designation.designationId,
    reportingManagerId: employee.reportingManager?.employeeId ?? '',
  };
  const [form, setForm] = useState<FormState>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = usePeopleMutation(
    (patch: object) => api.patch(`/employees/${employee.employeeId}`, patch),
    { quiet: true, success: 'Employment details saved.' },
  );
  const set = (key: keyof FormState) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    setErrors({});
    setFormError(null);
    // Only what changed is sent, so a stale form can never undo someone else's edit.
    const patch = Object.fromEntries(
      (Object.keys(form) as (keyof FormState)[])
        .filter((k) => form[k] !== initial[k])
        .map((k) => [k, form[k]]),
    );
    if (Object.keys(patch).length === 0) return onClose();
    try {
      await save.mutateAsync(patch);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length > 0)
        setErrors(err.fieldErrors);
      else setFormError(messageFor(err));
    }
  };

  return (
    <Drawer open onOpenChange={(open) => !open && !save.isPending && onClose()}>
      <DrawerContent
        title="Edit employment details"
        description={`${employee.fullName} · ${employee.employeeCode}`}
      >
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DrawerBody className="space-y-5">
            {formError && <Alert tone="danger">{formError}</Alert>}
            <TextField
              label="Employee code"
              required
              value={form.employeeCode}
              onChange={set('employeeCode')}
              error={errors.employeeCode}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                label="Joining date"
                type="date"
                required
                value={form.joiningDate}
                onChange={set('joiningDate')}
                error={errors.joiningDate}
              />
              <TextField
                label="Confirmation date"
                type="date"
                value={form.confirmationDate}
                onChange={set('confirmationDate')}
                error={errors.confirmationDate}
              />
            </div>
            <TextField
              label="Employment type"
              list="edit-employment-types"
              value={form.employmentType}
              onChange={set('employmentType')}
              error={errors.employmentType}
            />
            <datalist id="edit-employment-types">
              {EMPLOYMENT_TYPE_SUGGESTIONS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
            <div className="grid gap-5 sm:grid-cols-2">
              <ComboboxField
                label="Department"
                value={form.departmentId}
                onChange={(departmentId) => setForm((f) => ({ ...f, departmentId }))}
                options={(departments.data ?? [])
                  .filter((d) => d.status === 'ACTIVE' || d.departmentId === initial.departmentId)
                  .map((d) => ({ value: d.departmentId, label: d.name }))}
                searchPlaceholder="Search departments…"
                error={errors.departmentId}
              />
              <ComboboxField
                label="Designation"
                hint="A title only. Access comes from the login role."
                value={form.designationId}
                onChange={(designationId) => setForm((f) => ({ ...f, designationId }))}
                options={(designations.data ?? [])
                  .filter((d) => d.status === 'ACTIVE' || d.designationId === initial.designationId)
                  .map((d) => ({ value: d.designationId, label: d.name }))}
                searchPlaceholder="Search designations…"
                error={errors.designationId}
              />
            </div>
            <ComboboxField
              label="Reporting manager"
              value={form.reportingManagerId}
              onChange={(reportingManagerId) => setForm((f) => ({ ...f, reportingManagerId }))}
              options={[
                { value: '', label: 'No one' },
                ...(managers.data?.items ?? [])
                  .filter((m) => m.employeeId !== employee.employeeId)
                  .map((m) => ({ value: m.employeeId, label: m.fullName, hint: m.employeeCode })),
              ]}
              searchPlaceholder="Search people…"
              error={errors.reportingManagerId}
            />
          </DrawerBody>
          <DrawerFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
              Cancel
            </Button>
            <Button type="submit" loading={save.isPending} loadingText="Saving…">
              <Save /> Save changes
            </Button>
          </DrawerFooter>
        </form>
      </DrawerContent>
    </Drawer>
  );
}

export function EmploymentTab({ employee }: { employee: EmployeeProfileDTO }) {
  const [editing, setEditing] = useState(false);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Employment</CardTitle>
          <CardDescription>Dates, type and reporting line.</CardDescription>
        </div>
        <Can permission="employee:manage">
          {!employee.readOnly && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil /> Edit
            </Button>
          )}
        </Can>
      </CardHeader>
      <InfoGrid>
        <InfoItem label="Joining date">{formatDateOnly(employee.joiningDate)}</InfoItem>
        <InfoItem label="Confirmation date">
          {employee.confirmationDate ? formatDateOnly(employee.confirmationDate) : null}
        </InfoItem>
        <InfoItem label="Employment type">{employee.employmentType}</InfoItem>
        <InfoItem label="Department">{employee.department.name}</InfoItem>
        <InfoItem label="Designation">{employee.designation.name}</InfoItem>
        <InfoItem label="Reporting manager">
          {employee.reportingManager
            ? `${employee.reportingManager.fullName} (${employee.reportingManager.employeeCode})`
            : null}
        </InfoItem>
        {employee.exit && (
          <>
            <InfoItem label="Exit date">{formatDateOnly(employee.exit.exitDate)}</InfoItem>
            <InfoItem label="Exit reason">
              {EXIT_REASON_LABELS[employee.exit.exitReasonCategory]}
            </InfoItem>
            {employee.exit.note ? (
              <InfoItem label="Exit note">{employee.exit.note}</InfoItem>
            ) : null}
          </>
        )}
      </InfoGrid>
      {editing && <EditDrawer employee={employee} onClose={() => setEditing(false)} />}
    </Card>
  );
}
