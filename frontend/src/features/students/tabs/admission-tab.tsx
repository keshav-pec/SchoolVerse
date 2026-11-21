import { useState } from 'react';
import { ADMISSION_MODE_LABELS, EXTERNAL_ID_TYPE_SUGGESTIONS, type ExternalIdDTO, type StudentAdminProfileDTO } from '@shared';
import { CalendarX2, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { TextField } from '@/components/ui/field';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { useStudentMutation } from '../api';
import { ADMISSION_INTRO, ADMISSION_NUMBER_HELP, EXTERNAL_ID_HELP } from '../help-copy';

function AddExternalIdDialog({ studentId, onClose }: { studentId: string; onClose: () => void }) {
  const [type, setType] = useState('');
  const [value, setValue] = useState('');
  const add = useStudentMutation((body: object) => api.post(`/students/${studentId}/external-ids`, body), { quiet: true, success: 'Outside ID added.' });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title="Add an outside ID"
      description="A number from another place, such as a board registration number."
      confirmLabel="Add ID"
      loadingLabel="Adding…"
      onConfirm={async () => {
        if (!type.trim()) throw new FormProblem('Enter what kind of ID this is. Example: Board Reg No.');
        if (!value.trim()) throw new FormProblem('Enter the ID.');
        await add.mutateAsync({ type: type.trim(), value: value.trim() });
      }}
    >
      <div className="space-y-4">
        <TextField label="Kind of ID" list="external-id-types" required value={type} onChange={(e) => setType(e.target.value)} hint="Pick from the list or type your own." />
        <datalist id="external-id-types">
          {EXTERNAL_ID_TYPE_SUGGESTIONS.map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <TextField label="ID" required value={value} onChange={(e) => setValue(e.target.value)} />
      </div>
    </ConfirmDialog>
  );
}

function EndExternalIdDialog({ id, onClose }: { id: ExternalIdDTO; onClose: () => void }) {
  const end = useStudentMutation((_: void) => api.post(`/external-ids/${id.externalIdId}/end`, {}), { quiet: true, success: 'Outside ID ended.' });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<CalendarX2 className="size-5" />}
      tone="danger"
      title={`End ${id.type}?`}
      description="It is no longer used to find this student. It stays in History."
      confirmLabel="End ID"
      loadingLabel="Ending…"
      onConfirm={async () => void (await end.mutateAsync())}
    />
  );
}

/** How and when the student joined. The admission number is permanent. */
export function AdmissionTab({ student, readOnly }: { student: StudentAdminProfileDTO; readOnly: boolean }) {
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<ExternalIdDTO | null>(null);
  const a = student.admission;
  const live = student.externalIds.filter((e) => !e.effectiveTo);

  return (
    <div className="space-y-4">
      <TabIntro title="About the admission">{ADMISSION_INTRO}</TabIntro>
      <Card>
        <CardHeader>
          <HelpHeading title="Admission" help={ADMISSION_NUMBER_HELP} helpLabel="About the admission number" />
        </CardHeader>
        {a ? (
          <InfoGrid>
            <InfoItem label="Admission number">
              <span className="font-mono tracking-wide">{a.admissionNumber}</span>
            </InfoItem>
            <InfoItem label="Admission date">{formatDateOnly(a.admissionDate)}</InfoItem>
            <InfoItem label="How they joined">{ADMISSION_MODE_LABELS[a.mode]}</InfoItem>
            <InfoItem label="Joined in class">{a.className}</InfoItem>
            {student.personalIncluded && <InfoItem label="Category">{a.category}</InfoItem>}
            {student.personalIncluded && (
              <InfoItem label="Previous school" className="sm:col-span-2">
                {a.previousSchool ? [a.previousSchool.name, a.previousSchool.board, a.previousSchool.className, a.previousSchool.tcNumber ? `TC ${a.previousSchool.tcNumber}` : null].filter(Boolean).join(' · ') : undefined}
              </InfoItem>
            )}
            {a.remarks && <InfoItem label="Remarks" className="sm:col-span-2 lg:col-span-3">{a.remarks}</InfoItem>}
          </InfoGrid>
        ) : (
          <p className="text-sm text-muted">No admission is recorded yet. Use “Finish Admission” on the Overview tab.</p>
        )}
      </Card>

      <Card>
        <CardHeader>
          <HelpHeading title="Outside IDs" help={EXTERNAL_ID_HELP} helpLabel="About outside IDs" className="text-lg font-bold" />
          {!readOnly && (
            <Can permission="student:manage">
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}>
                <Plus /> Add ID
              </Button>
            </Can>
          )}
        </CardHeader>
        {!student.personalIncluded ? (
          <p className="text-sm text-muted">Outside IDs are only shown to staff who may see personal details.</p>
        ) : live.length === 0 ? (
          <p className="text-sm text-muted">No outside IDs yet.</p>
        ) : (
          <ul className="divide-y divide-line" aria-label="Outside IDs">
            {live.map((e) => (
              <li key={e.externalIdId} className="flex flex-wrap items-center gap-3 py-2 text-sm">
                <span className="text-muted">{e.type}</span>
                <span className="flex-1 font-mono font-semibold">{e.value}</span>
                {!readOnly && (
                  <Can permission="student:manage">
                    <Button size="sm" variant="ghost" onClick={() => setEnding(e)} aria-label={`End ${e.type}`}>
                      End
                    </Button>
                  </Can>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {adding && <AddExternalIdDialog studentId={student.studentId} onClose={() => setAdding(false)} />}
      {ending && <EndExternalIdDialog id={ending} onClose={() => setEnding(null)} />}
    </div>
  );
}
