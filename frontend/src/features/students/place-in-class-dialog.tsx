import { useState } from 'react';
import { GraduationCap } from 'lucide-react';
import type { StudentAdminProfileDTO } from '@shared';
import { ComboboxField, TextField } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { useClassOfferings } from '../academic/api';
import { useAdmissionSettings, useStudentMutation } from './api';
import { useStudentContext } from './context';
import { todayIso } from './student-bits';

/**
 * Finishes a draft: records the admission (which gives the admission number) and puts the student in a class. For a student
 * who already has an admission but no class this year, only the class is added.
 */
export function PlaceInClassDialog({ student, onClose }: { student: StudentAdminProfileDTO; onClose: () => void }) {
  const ctx = useStudentContext();
  const classes = useClassOfferings(ctx.sessionId, ctx.locationId);
  const settings = useAdmissionSettings();
  const [classOfferingId, setClassId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [number, setNumber] = useState('');
  const needsAdmission = !student.admission;
  const manual = needsAdmission && settings.data?.mode === 'MANUAL';

  const admit = useStudentMutation((body: object) => api.post(`/students/${student.studentId}/admission`, body), { quiet: true, success: 'Admission recorded.' });
  const enroll = useStudentMutation((body: object) => api.post(`/students/${student.studentId}/enrollments`, body), { quiet: true, success: 'Placed in the class.' });

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<GraduationCap className="size-5" />}
      title={needsAdmission ? 'Finish the admission' : 'Choose a class'}
      description={`${student.fullName} will be placed in the class for ${ctx.session?.code ?? 'this year'} at ${ctx.location?.displayName ?? 'this campus'}. Required subjects are added automatically.`}
      confirmLabel={needsAdmission ? 'Finish Admission' : 'Save Class'}
      loadingLabel="Saving…"
      onConfirm={async () => {
        if (!ctx.sessionId || !ctx.locationId) throw new FormProblem('Choose a school year and campus at the top of the page first.');
        if (!classOfferingId) throw new FormProblem('Choose a class.');
        if (manual && !number.trim()) throw new FormProblem('Enter the admission number.');
        if (needsAdmission) {
          await admit.mutateAsync({ academicSessionId: ctx.sessionId, locationId: ctx.locationId, classOfferingId, admissionDate: date, ...(manual ? { admissionNumber: number.trim() } : {}) });
        } else {
          await enroll.mutateAsync({ academicSessionId: ctx.sessionId, locationId: ctx.locationId, classOfferingId, effectiveFrom: date });
        }
      }}
    >
      <div className="space-y-4">
        <ComboboxField
          label="Class"
          required
          value={classOfferingId}
          onChange={setClassId}
          options={(classes.data ?? []).filter((c) => c.status === 'ACTIVE').map((c) => ({ value: c.classOfferingId, label: c.displayName, hint: c.displayCode }))}
          placeholder="Choose…"
          searchPlaceholder="Search classes…"
        />
        <TextField label={needsAdmission ? 'Admission date' : 'Start date'} type="date" value={date} onChange={(e) => setDate(e.target.value)} hint="Today is filled in." />
        {manual && <TextField label="Admission number" required value={number} onChange={(e) => setNumber(e.target.value.toUpperCase())} hint="Example: GPS/2026/00482. It can’t be changed later." />}
      </div>
    </ConfirmDialog>
  );
}
