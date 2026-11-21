import { useState } from 'react';
import { GENDER_LABELS, type CompletenessEntryDTO, type CompletenessItem, type StudentAdminProfileDTO } from '@shared';
import { Check, Copy, Lock, Pencil, TriangleAlert } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { InfoTip } from '@/components/ui/tooltip';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { TabIntro } from '@/components/sv/help';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { api } from '@/lib/api';
import { formatDateOnly, formatPhone } from '@/lib/format';
import { useStudentMutation } from '../api';
import { ADMISSION_NUMBER_HELP, OVERVIEW_INTRO } from '../help-copy';
import { placementText, StudentStatusPill } from '../student-bits';

export const FIX_BUTTON: Record<CompletenessItem, string> = {
  ADMISSION: 'Finish Admission',
  ENROLLMENT: 'Choose Class',
  SECTION: 'Choose Section',
  GUARDIAN: 'Add Parent',
  PRIMARY_GUARDIAN: 'Choose Primary Parent',
  SUBJECT_CHOICE: 'Choose Subjects',
};

function CopyButton({ value }: { value: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label="Copy admission number"
      className="inline-grid size-7 place-items-center rounded-md text-muted hover:bg-ink/5 hover:text-ink"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setDone(true);
          toast.success('Admission number copied.');
          setTimeout(() => setDone(false), 1500);
        });
      }}
    >
      {done ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
    </button>
  );
}

function StatusDialog({ student, to, onClose }: { student: StudentAdminProfileDTO; to: 'ACTIVE' | 'INACTIVE' | 'CONFIRM'; onClose: () => void }) {
  const change = useStudentMutation(
    (_: void) => (to === 'CONFIRM' ? api.post(`/students/${student.studentId}/activate`) : api.post(`/students/${student.studentId}/status`, { to })),
    { quiet: true, success: to === 'INACTIVE' ? 'Marked inactive.' : to === 'ACTIVE' ? 'Marked active.' : 'Admission confirmed.' },
  );
  const copy = {
    CONFIRM: { title: 'Confirm this admission?', body: 'The student becomes Active. They need an admission, a class and one parent first.', label: 'Confirm Admission' },
    INACTIVE: { title: 'Mark as inactive?', body: 'Use this for a long break, such as an extended leave. Nothing is deleted, and you can make them active again.', label: 'Mark Inactive' },
    ACTIVE: { title: 'Mark as active again?', body: 'The student is back to normal.', label: 'Mark Active' },
  }[to];
  return (
    <ConfirmDialog open onOpenChange={(open) => !open && onClose()} title={copy.title} description={copy.body} confirmLabel={copy.label} loadingLabel="Saving…" onConfirm={async () => void (await change.mutateAsync())} />
  );
}

/** The main details, what still needs doing, and the simple status moves. */
export function OverviewTab({ student, onFix, onEdit }: { student: StudentAdminProfileDTO; onFix: (m: CompletenessEntryDTO) => void; onEdit: () => void }) {
  const [status, setStatus] = useState<'ACTIVE' | 'INACTIVE' | 'CONFIRM' | null>(null);
  const readOnly = student.availableActions.length === 0 && ['WITHDRAWN', 'TRANSFERRED_OUT', 'COMPLETED_SCHOOLING'].includes(student.status);
  const actions = student.availableActions;

  return (
    <div className="space-y-4">
      <TabIntro title="About this student">{OVERVIEW_INTRO}</TabIntro>

      {student.missing.length > 0 && (
        <Card className="border-warning/40 bg-warning-soft/40" aria-label="Still to do">
          <CardHeader className="mb-2">
            <CardTitle className="flex items-center gap-2 text-base">
              <TriangleAlert className="size-5 text-warning" aria-hidden="true" /> Still to do
            </CardTitle>
          </CardHeader>
          <ul className="divide-y divide-line">
            {student.missing.map((m) => (
              <li key={m.item} className="flex flex-wrap items-center gap-3 py-2">
                <p className="min-w-0 flex-1 text-sm font-medium">{m.message}</p>
                <Can permission={['student:manage']}>
                  <Button size="sm" variant="outline" onClick={() => onFix(m)}>
                    {FIX_BUTTON[m.item]}
                  </Button>
                </Can>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>Student details</CardTitle>
          {!readOnly && (
            <Can permission="student:manage">
              <Button variant="outline" size="sm" onClick={onEdit}>
                <Pencil /> Edit Details
              </Button>
            </Can>
          )}
        </CardHeader>
        <InfoGrid>
          <InfoItem label="Full name">{student.fullName}</InfoItem>
          <InfoItem label="Preferred name">{student.preferredName}</InfoItem>
          <InfoItem label="Admission number">
            {student.admissionNumber ? (
              <span className="inline-flex items-center gap-1.5">
                <span className="font-mono tracking-wide">{student.admissionNumber}</span>
                <Lock className="size-3.5 text-muted" aria-label="Locked" />
                <CopyButton value={student.admissionNumber} />
                <InfoTip label="About the admission number">{ADMISSION_NUMBER_HELP}</InfoTip>
              </span>
            ) : (
              <span className="font-normal text-muted">Not given yet</span>
            )}
          </InfoItem>
          <InfoItem label="Class, section and roll">{student.classSection ? placementText(student.classSection, student.rollNumber) : undefined}</InfoItem>
          <InfoItem label="Primary parent">{student.primaryGuardianName}</InfoItem>
          <InfoItem label="Status">
            <StudentStatusPill status={student.status} />
          </InfoItem>
          <InfoItem label="Gender">{student.gender ? GENDER_LABELS[student.gender] : undefined}</InfoItem>
          <InfoItem label="Blood group">{student.bloodGroup}</InfoItem>
          {student.personalIncluded && <InfoItem label="Date of birth">{student.dateOfBirth ? formatDateOnly(student.dateOfBirth) : undefined}</InfoItem>}
          {student.personalIncluded && <InfoItem label="Phone">{student.primaryPhone ? formatPhone(student.primaryPhone) : undefined}</InfoItem>}
          {student.personalIncluded && <InfoItem label="Email">{student.primaryEmail}</InfoItem>}
          {student.personalIncluded && (
            <InfoItem label="Address" className="sm:col-span-2 lg:col-span-3">
              {student.address ? [student.address.line1, student.address.line2, student.address.city, student.address.state, student.address.postalCode].filter(Boolean).join(', ') || undefined : undefined}
            </InfoItem>
          )}
          {student.notes && (
            <InfoItem label="Notes" className="sm:col-span-2 lg:col-span-3">
              {student.notes}
            </InfoItem>
          )}
        </InfoGrid>
      </Card>

      {!readOnly && (actions.includes('activate') || actions.includes('deactivate') || actions.includes('reactivate')) && (
        <Can permission="student:manage">
          <Card>
            <CardHeader className="mb-2">
              <CardTitle>Status</CardTitle>
            </CardHeader>
            <div className="flex flex-wrap items-center gap-3">
              <StudentStatusPill status={student.status} />
              {actions.includes('activate') && (
                <Button size="sm" onClick={() => setStatus('CONFIRM')} disabled={student.missing.some((m) => ['ADMISSION', 'ENROLLMENT', 'GUARDIAN'].includes(m.item))} title={student.missing.some((m) => ['ADMISSION', 'ENROLLMENT', 'GUARDIAN'].includes(m.item)) ? 'Finish the items under “Still to do” first' : undefined}>
                  Confirm Admission
                </Button>
              )}
              {actions.includes('deactivate') && (
                <Button size="sm" variant="outline" onClick={() => setStatus('INACTIVE')}>
                  Mark Inactive
                </Button>
              )}
              {actions.includes('reactivate') && (
                <Button size="sm" variant="outline" onClick={() => setStatus('ACTIVE')}>
                  Mark Active
                </Button>
              )}
              {actions.includes('activate') && student.missing.some((m) => ['ADMISSION', 'ENROLLMENT', 'GUARDIAN'].includes(m.item)) && <p className="text-[13px] text-muted">Confirm Admission is off until the items under “Still to do” are finished.</p>}
            </div>
          </Card>
        </Can>
      )}
      {status && <StatusDialog student={student} to={status} onClose={() => setStatus(null)} />}
    </div>
  );
}
