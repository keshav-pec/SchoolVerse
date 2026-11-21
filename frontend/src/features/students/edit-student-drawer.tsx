import { useState } from 'react';
import { BLOOD_GROUPS, GENDER_LABELS, GENDERS, type StudentAdminProfileDTO } from '@shared';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextareaField, TextField } from '@/components/ui/field';
import { api, ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { useStudentMutation } from './api';

interface Values {
  legalFirstName: string;
  legalMiddleName: string;
  legalLastName: string;
  preferredName: string;
  dateOfBirth: string;
  gender: string;
  bloodGroup: string;
  primaryPhone: string;
  primaryEmail: string;
  line1: string;
  city: string;
  state: string;
  postalCode: string;
  notes: string;
}

const startFrom = (s: StudentAdminProfileDTO): Values => ({
  legalFirstName: s.legalFirstName,
  legalMiddleName: s.legalMiddleName ?? '',
  legalLastName: s.legalLastName,
  preferredName: s.preferredName ?? '',
  dateOfBirth: s.dateOfBirth ?? '',
  gender: s.gender ?? '',
  bloodGroup: s.bloodGroup ?? '',
  primaryPhone: s.primaryPhone ?? '',
  primaryEmail: s.primaryEmail ?? '',
  line1: s.address?.line1 ?? '',
  city: s.address?.city ?? '',
  state: s.address?.state ?? '',
  postalCode: s.address?.postalCode ?? '',
  notes: s.notes ?? '',
});

/** Edit the student's own details. Only what changed is sent, so a field the person can't see is never blanked by mistake. */
export function EditStudentDrawer({ student, onClose }: { student: StudentAdminProfileDTO; onClose: () => void }) {
  const initial = startFrom(student);
  const [v, setV] = useState<Values>(initial);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const personal = student.personalIncluded;
  const save = useStudentMutation((body: object) => api.patch<StudentAdminProfileDTO>(`/students/${student.studentId}`, body), { quiet: true });
  const set = (k: keyof Values) => (value: string) => setV((x) => ({ ...x, [k]: value }));
  const text = (k: keyof Values) => ({ value: v[k], error: fieldErrors[k], onChange: (e: React.ChangeEvent<HTMLInputElement>) => set(k)(e.target.value) });

  const submit = async () => {
    if (!v.legalFirstName.trim()) return setFieldErrors({ legalFirstName: 'Enter the first name.' });
    setFieldErrors({});
    setError(null);
    const body: Record<string, unknown> = { version: student.version };
    for (const k of ['legalFirstName', 'legalMiddleName', 'legalLastName', 'preferredName', 'gender', 'bloodGroup', 'notes'] as const) if (v[k] !== initial[k]) body[k] = v[k];
    if (personal) {
      for (const k of ['dateOfBirth', 'primaryPhone', 'primaryEmail'] as const) if (v[k] !== initial[k]) body[k] = v[k];
      if (['line1', 'city', 'state', 'postalCode'].some((k) => v[k as keyof Values] !== initial[k as keyof Values])) {
        body.address = { ...(student.address ?? {}), line1: v.line1 || null, city: v.city || null, state: v.state || null, postalCode: v.postalCode || null };
      }
    }
    if (Object.keys(body).length === 1) return onClose();
    try {
      await save.mutateAsync(body);
      toast.success('Student details saved.');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.fieldErrors).length > 0) setFieldErrors(err.fieldErrors);
      setError(messageFor(err));
    }
  };

  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent title="Edit student details" description="The admission number and class are not changed here.">
        <DrawerBody>
          <div className="space-y-5">
            {error && <Alert tone="danger">{error}</Alert>}
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField label="First name" required autoComplete="off" {...text('legalFirstName')} />
              <TextField label="Last name" autoComplete="off" {...text('legalLastName')} />
              <TextField label="Middle name" hint="Optional." autoComplete="off" {...text('legalMiddleName')} />
              <TextField label="Preferred name" hint="Optional. The name used in lists." autoComplete="off" {...text('preferredName')} />
            </div>
            <div className="grid gap-5 sm:grid-cols-3">
              {personal && <TextField label="Date of birth" type="date" {...text('dateOfBirth')} />}
              <ComboboxField label="Gender" value={v.gender} onChange={set('gender')} options={[{ value: '', label: 'Not given' }, ...GENDERS.map((g) => ({ value: g, label: GENDER_LABELS[g] }))]} searchPlaceholder="Search…" />
              <ComboboxField label="Blood group" value={v.bloodGroup} onChange={set('bloodGroup')} options={[{ value: '', label: 'Not given' }, ...BLOOD_GROUPS.map((g) => ({ value: g, label: g }))]} searchPlaceholder="Search…" />
            </div>
            {personal && (
              <>
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField label="Student phone" type="tel" hint="Optional." {...text('primaryPhone')} />
                  <TextField label="Student email" type="email" hint="Optional." {...text('primaryEmail')} />
                </div>
                <TextField label="Address" hint="Optional." {...text('line1')} />
                <div className="grid gap-5 sm:grid-cols-3">
                  <TextField label="City" {...text('city')} />
                  <TextField label="State" {...text('state')} />
                  <TextField label="Postal code" {...text('postalCode')} />
                </div>
              </>
            )}
            <TextareaField label="Notes" hint="Optional. Only the school office sees this." value={v.notes} onChange={(e) => set('notes')(e.target.value)} />
          </div>
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={save.isPending} loadingText="Saving…">
            Save Changes
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
