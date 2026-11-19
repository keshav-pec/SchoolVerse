import { useState } from 'react';
import type { EmployeeProfileDTO } from '@shared';
import { Lock, Pencil, Save } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { TextField } from '@/components/ui/field';
import { Can } from '@/components/sv/can';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { api, ApiError } from '@/lib/api';
import { changedFields } from '@/lib/utils';
import { messageFor } from '@/lib/errors';
import { formatPhone } from '@/lib/format';
import { usePeopleMutation } from '../api';

export function addressLine(
  address: NonNullable<NonNullable<EmployeeProfileDTO['personal']>['address']>,
): string {
  return [
    address.line1,
    address.line2,
    address.city,
    [address.state, address.postalCode].filter(Boolean).join(' '),
    address.country,
  ]
    .filter(Boolean)
    .join(', ');
}

function EditDrawer({ employee, onClose }: { employee: EmployeeProfileDTO; onClose: () => void }) {
  const personal = employee.personal;
  const initial = {
    preferredName: employee.preferredName ?? '',
    officialEmail: employee.officialEmail ?? '',
    officialPhone: employee.officialPhone ?? '',
    personalEmail: personal?.personalEmail ?? '',
    personalPhone: personal?.personalPhone ?? '',
  };
  const [form, setForm] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = usePeopleMutation(
    (patch: object) => api.patch(`/employees/${employee.employeeId}`, patch),
    { quiet: true, success: 'Contact details saved.' },
  );
  const set = (key: keyof typeof initial) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const submit = async () => {
    setErrors({});
    setFormError(null);
    const patch = changedFields(form, initial);
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
        title="Edit contact details"
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
              label="Preferred name"
              value={form.preferredName}
              onChange={set('preferredName')}
              error={errors.preferredName}
            />
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                label="Official email"
                type="email"
                value={form.officialEmail}
                onChange={set('officialEmail')}
                error={errors.officialEmail}
              />
              <TextField
                label="Official phone"
                type="tel"
                value={form.officialPhone}
                onChange={set('officialPhone')}
                error={errors.officialPhone}
              />
            </div>
            {personal && (
              <div className="grid gap-5 sm:grid-cols-2">
                <TextField
                  label="Personal email"
                  type="email"
                  value={form.personalEmail}
                  onChange={set('personalEmail')}
                  error={errors.personalEmail}
                />
                <TextField
                  label="Personal phone"
                  type="tel"
                  value={form.personalPhone}
                  onChange={set('personalPhone')}
                  error={errors.personalPhone}
                />
              </div>
            )}
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

/** Official contact is always shown. Personal contact appears only when the server sent it (`employee:view_personal`). */
export function ContactTab({ employee }: { employee: EmployeeProfileDTO }) {
  const [editing, setEditing] = useState(false);
  const personal = employee.personal;
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Official contact</CardTitle>
            <CardDescription>Shown to colleagues in the directory.</CardDescription>
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
          <InfoItem label="Official email">{employee.officialEmail}</InfoItem>
          <InfoItem label="Official phone">
            {employee.officialPhone ? formatPhone(employee.officialPhone) : null}
          </InfoItem>
          <InfoItem label="Preferred name">{employee.preferredName}</InfoItem>
        </InfoGrid>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Personal contact</CardTitle>
            <CardDescription>
              Private to this person and to administrators who may see it.
            </CardDescription>
          </div>
        </CardHeader>
        {personal ? (
          <InfoGrid>
            <InfoItem label="Personal email">{personal.personalEmail}</InfoItem>
            <InfoItem label="Personal phone">
              {personal.personalPhone ? formatPhone(personal.personalPhone) : null}
            </InfoItem>
            <InfoItem label="Primary email">{personal.primaryEmail}</InfoItem>
            <InfoItem label="Primary phone">
              {personal.primaryPhone ? formatPhone(personal.primaryPhone) : null}
            </InfoItem>
            <InfoItem label="Address" className="sm:col-span-2">
              {personal.address ? addressLine(personal.address) : null}
            </InfoItem>
            <InfoItem label="Emergency contact">
              {personal.emergencyContact
                ? `${personal.emergencyContact.name} (${personal.emergencyContact.relation}), ${formatPhone(personal.emergencyContact.phone)}`
                : null}
            </InfoItem>
          </InfoGrid>
        ) : (
          <Alert tone="info">
            <span className="inline-flex items-center gap-1.5">
              <Lock className="size-4" aria-hidden="true" /> You don’t have permission to see
              personal contact details.
            </span>
          </Alert>
        )}
      </Card>
      {editing && <EditDrawer employee={employee} onClose={() => setEditing(false)} />}
    </div>
  );
}
