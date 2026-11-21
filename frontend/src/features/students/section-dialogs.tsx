import { useState } from 'react';
import { Hash, MoveRight } from 'lucide-react';
import { toast } from 'sonner';
import type { SectionAssignmentDTO, SectionAssignmentResultDTO, SectionTransferResultDTO, StudentAdminProfileDTO } from '@shared';
import { ComboboxField, TextareaField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { useSectionRecommendations, useStudentMutation } from './api';
import { ROLL_NUMBER_HELP, SECTION_CHANGE_HELP } from './help-copy';
import { todayIso } from './student-bits';

/** A student has a section today (or one that starts soon) when the enrollment's section is not ended or cancelled. */
export function currentSection(student: StudentAdminProfileDTO): SectionAssignmentDTO | null {
  const section = student.enrollment?.section ?? null;
  return section && (section.status === 'ACTIVE' || section.status === 'PLANNED') ? section : null;
}

const ROLL_OPTIONS = [
  { value: '', label: 'Give it later' },
  { value: 'AUTO', label: 'Next free number' },
  { value: 'TYPED', label: 'Type a number' },
];

function rollValue(mode: string, typed: string): string | undefined {
  if (mode === 'AUTO') return 'AUTO';
  if (mode === 'TYPED') {
    if (!typed.trim()) throw new FormProblem('Type a roll number, or choose Next free number.');
    return typed.trim();
  }
  return undefined;
}

/**
 * Choose a first section, or move to another one during the year. The list shows seats left ("VIII-B · 34 of 40"),
 * so nobody has to guess. A move keeps the old section in History.
 */
export function ChangeSectionDialog({ student, onClose }: { student: StudentAdminProfileDTO; onClose: () => void }) {
  const enrollment = student.enrollment!;
  const existing = currentSection(student);
  const recommendations = useSectionRecommendations(enrollment.classOfferingId);
  const [sectionId, setSectionId] = useState('');
  const [date, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [rollMode, setRollMode] = useState('');
  const [typedRoll, setTypedRoll] = useState('');

  const assign = useStudentMutation((body: object) => api.post<SectionAssignmentResultDTO>(`/student-enrollments/${enrollment.enrollmentId}/section-assignment`, body), { quiet: true });
  const transfer = useStudentMutation((body: object) => api.post<SectionTransferResultDTO>(`/students/${student.studentId}/section-transfer`, body), { quiet: true });

  const options = (recommendations.data ?? [])
    .filter((s) => s.sectionId !== existing?.sectionId)
    .map((s) => ({ value: s.sectionId, label: s.label, hint: s.isFull ? 'Full' : s.recommended ? 'Suggested' : undefined }));
  const suggested = recommendations.data?.find((s) => s.recommended && s.sectionId !== existing?.sectionId);
  const chosen = sectionId || suggested?.sectionId || '';

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<MoveRight className="size-5" />}
      title={existing ? 'Change section' : 'Choose a section'}
      description={
        existing ? (
          <span className="flex items-center gap-1.5">
            Now in {student.classSection?.label ?? existing.sectionName}. <InfoTip label="What happens when the section changes">{SECTION_CHANGE_HELP}</InfoTip>
          </span>
        ) : (
          `${student.fullName} is in ${enrollment.className} but has no section yet.`
        )
      }
      confirmLabel={existing ? 'Change Section' : 'Save Section'}
      loadingLabel="Saving…"
      onConfirm={async () => {
        if (!chosen) throw new FormProblem('Choose a section.');
        const rollNumber = rollValue(rollMode, typedRoll);
        if (existing) {
          if (!reason.trim()) throw new FormProblem('Write a short reason, for example “Parent request”.');
          const result = await transfer.mutateAsync({ toSectionId: chosen, effectiveDate: date, reason: reason.trim(), ...(rollNumber ? { rollNumber } : {}) });
          toast.success(`Moved to ${enrollment.classCode}-${result.to.sectionCode}. The old section stays in History.`);
          for (const w of result.warnings) toast.warning(w.message);
        } else {
          const result = await assign.mutateAsync({ sectionId: chosen, effectiveFrom: date, ...(rollNumber ? { rollNumber } : {}) });
          toast.success(`Placed in ${enrollment.classCode}-${result.assignment.sectionCode}.`);
          for (const w of result.warnings) toast.warning(w.message);
        }
      }}
    >
      <div className="space-y-4">
        <ComboboxField
          label="New section"
          required
          value={chosen}
          onChange={setSectionId}
          options={options}
          placeholder="Choose…"
          searchPlaceholder="Search sections…"
          hint={options.length === 0 && !recommendations.isLoading ? 'This class has no other section. Add one in Academic Setup.' : 'Shows how many seats are taken.'}
        />
        <TextField label={existing ? 'Change date' : 'Start date'} type="date" required value={date} onChange={(e) => setDate(e.target.value)} hint={existing ? 'The old section ends the day before.' : 'Today is filled in.'} />
        {existing && <TextareaField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Parent request, or balancing sections." className="min-h-20" />}
        <div className="grid gap-4 sm:grid-cols-2">
          <ComboboxField label="Roll number" labelAside={<InfoTip label="About the roll number">{ROLL_NUMBER_HELP}</InfoTip>} value={rollMode} onChange={setRollMode} options={ROLL_OPTIONS} searchPlaceholder="Search…" />
          {rollMode === 'TYPED' && <TextField label="Roll number to use" value={typedRoll} onChange={(e) => setTypedRoll(e.target.value)} />}
        </div>
      </div>
    </ConfirmDialog>
  );
}

/** Change the roll number inside the current section. */
export function RollNumberDialog({ assignment, onClose }: { assignment: SectionAssignmentDTO; onClose: () => void }) {
  const [mode, setMode] = useState(assignment.rollNumber ? 'TYPED' : 'AUTO');
  const [typed, setTyped] = useState(assignment.rollNumber ?? '');
  const save = useStudentMutation((rollNumber: string | null) => api.patch(`/student-section-assignments/${assignment.sectionAssignmentId}`, { rollNumber }), { quiet: true, success: 'Roll number saved.' });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<Hash className="size-5" />}
      title="Roll number"
      description={<span className="flex items-center gap-1.5">In {assignment.sectionName}. <InfoTip label="About the roll number">{ROLL_NUMBER_HELP}</InfoTip></span>}
      confirmLabel="Save Roll Number"
      loadingLabel="Saving…"
      onConfirm={async () => {
        if (mode === 'AUTO') return void (await save.mutateAsync('AUTO'));
        if (mode === 'NONE') return void (await save.mutateAsync(null));
        if (!typed.trim()) throw new FormProblem('Type a roll number, or choose Next free number.');
        await save.mutateAsync(typed.trim());
      }}
    >
      <div className="space-y-4">
        <ComboboxField
          label="Roll number"
          value={mode}
          onChange={setMode}
          options={[
            { value: 'AUTO', label: 'Next free number' },
            { value: 'TYPED', label: 'Type a number' },
            { value: 'NONE', label: 'Clear it' },
          ]}
          searchPlaceholder="Search…"
        />
        {mode === 'TYPED' && <TextField label="Roll number to use" value={typed} onChange={(e) => setTyped(e.target.value)} />}
      </div>
    </ConfirmDialog>
  );
}
