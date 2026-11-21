import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import {
  BLOOD_GROUPS,
  DUPLICATE_REASON_LABELS,
  GENDER_LABELS,
  GENDERS,
  RELATIONSHIP_TYPES,
  type CreateStudentResultDTO,
  type DuplicateCandidateDTO,
  type GuardianMatchDTO,
} from '@shared';
import { ArrowLeft, ArrowRight, CheckCircle2, ChevronDown, Info, UserCheck, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextareaField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { DrawerStepper, ReviewCard, ReviewRow, stepOfField, type DrawerStep } from '@/components/sv/drawer-steps';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { api, ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useChoiceGroups, useClassOfferings, useSubjectOfferings } from '../academic/api';
import { useAdmissionPreview, useAdmissionSettings, useGuardianMatch, useSectionRecommendations, useStudentMutation } from './api';
import { useStudentContext } from './context';
import { AUTO_SUBJECTS_HELP, ADMISSION_NUMBER_HELP, DRAFT_HELP, EMERGENCY_FLAG_HELP, MIGRATION_HELP, PARENT_PHONE_HELP, ROLL_NUMBER_HELP } from './help-copy';
import { placementText, todayIso } from './student-bits';

interface Form {
  firstName: string;
  middleName: string;
  lastName: string;
  preferredName: string;
  dateOfBirth: string;
  gender: string;
  bloodGroup: string;
  migration: boolean;
  admissionDate: string;
  admissionNumber: string;
  category: string;
  classOfferingId: string;
  sectionId: string;
  rollMode: '' | 'AUTO' | 'TYPED';
  rollNumber: string;
  parentPhone: string;
  parentEmail: string;
  parentFirstName: string;
  parentLastName: string;
  relationship: string;
  parentPersonId: string;
  prevName: string;
  prevBoard: string;
  prevClass: string;
  prevTc: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  studentPhone: string;
  emergencyName: string;
  emergencyPhone: string;
  emergencyRelationship: string;
  extraIdType: string;
  extraIdValue: string;
  remarks: string;
}

const EMPTY: Form = {
  firstName: '',
  middleName: '',
  lastName: '',
  preferredName: '',
  dateOfBirth: '',
  gender: '',
  bloodGroup: '',
  migration: false,
  admissionDate: todayIso(),
  admissionNumber: '',
  category: '',
  classOfferingId: '',
  sectionId: '',
  rollMode: '',
  rollNumber: '',
  parentPhone: '',
  parentEmail: '',
  parentFirstName: '',
  parentLastName: '',
  relationship: '',
  parentPersonId: '',
  prevName: '',
  prevBoard: '',
  prevClass: '',
  prevTc: '',
  addressLine1: '',
  addressLine2: '',
  city: '',
  state: '',
  postalCode: '',
  studentPhone: '',
  emergencyName: '',
  emergencyPhone: '',
  emergencyRelationship: '',
  extraIdType: '',
  extraIdValue: '',
  remarks: '',
};

type FieldName = keyof Form;

/** The 11 steps of the Full Admission Form. Each step owns some fields, so an error sends the person back to it. */
const STEPS: readonly DrawerStep[] = [
  { key: 'student', label: 'Student', fields: ['firstName', 'middleName', 'lastName', 'preferredName'] },
  { key: 'personal', label: 'Personal', fields: ['dateOfBirth', 'gender', 'bloodGroup'] },
  { key: 'admission', label: 'Admission', fields: ['migration', 'admissionDate', 'admissionNumber', 'category'] },
  { key: 'previous', label: 'Previous School', fields: ['prevName', 'prevBoard', 'prevClass', 'prevTc'] },
  { key: 'class', label: 'Class', fields: ['classOfferingId', 'sectionId', 'rollMode', 'rollNumber'] },
  { key: 'subjects', label: 'Subjects', fields: [] },
  { key: 'parent', label: 'Parent', fields: ['parentPhone', 'parentEmail', 'parentFirstName', 'parentLastName', 'relationship', 'parentPersonId'] },
  { key: 'emergency', label: 'Emergency', fields: ['emergencyName', 'emergencyPhone', 'emergencyRelationship'] },
  { key: 'contact', label: 'Address', fields: ['addressLine1', 'addressLine2', 'city', 'state', 'postalCode', 'studentPhone'] },
  { key: 'notes', label: 'Notes', fields: ['extraIdType', 'extraIdValue', 'remarks'] },
  { key: 'review', label: 'Review', fields: [] },
];
const LAST = STEPS.length - 1;

/** Server field paths → the form field that shows the message. */
const SERVER_FIELDS: Record<string, FieldName> = {
  legalFirstName: 'firstName',
  legalMiddleName: 'middleName',
  legalLastName: 'lastName',
  preferredName: 'preferredName',
  dateOfBirth: 'dateOfBirth',
  gender: 'gender',
  bloodGroup: 'bloodGroup',
  primaryPhone: 'studentPhone',
  admissionDate: 'admissionDate',
  admissionNumber: 'admissionNumber',
  category: 'category',
  classOfferingId: 'classOfferingId',
  classId: 'classOfferingId',
  sectionId: 'sectionId',
  rollNumber: 'rollNumber',
  remarks: 'remarks',
  guardian: 'parentFirstName',
  'guardian.legalFirstName': 'parentFirstName',
  'guardian.legalLastName': 'parentLastName',
  'guardian.phone': 'parentPhone',
  'guardian.email': 'parentEmail',
  'guardian.relationshipType': 'relationship',
  'guardian.guardianPersonId': 'parentPhone',
  'address.line1': 'addressLine1',
  'address.line2': 'addressLine2',
  'address.city': 'city',
  'address.state': 'state',
  'address.postalCode': 'postalCode',
  'previousSchool.name': 'prevName',
  'previousSchool.board': 'prevBoard',
  'previousSchool.className': 'prevClass',
  'previousSchool.tcNumber': 'prevTc',
};

const blank = (v: string) => v.trim() === '';
const orUndefined = (v: string) => (blank(v) ? undefined : v.trim());

function digitsIn(v: string) {
  return v.replace(/\D/g, '').length;
}

// ───────────────────────────────────────────────────────────── matched-parent and duplicate cards

function MatchCard({ match, onUse }: { match: GuardianMatchDTO; onUse: () => void }) {
  const first = match.children[0];
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-brand/25 bg-brand-soft/60 p-3.5 sm:flex-row sm:items-center" role="status">
      <UserCheck className="size-5 shrink-0 text-brand" aria-hidden="true" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="font-semibold text-ink">
          {match.fullName} is already {first ? `a parent of ${first.fullName}${first.classSection ? ` (${first.classSection.label})` : ''}${match.children.length > 1 ? ` and ${match.children.length - 1} more` : ''}` : 'in the school records'}.
        </p>
        <p className="text-muted">{[match.maskedPhone, match.maskedEmail].filter(Boolean).join(' · ') || 'Contact hidden'}</p>
      </div>
      <Button size="sm" onClick={onUse}>
        Use This Parent
      </Button>
    </div>
  );
}

function DuplicateCard({ typed, candidates, onAddNew, onOpen, busy }: { typed: { name: string; dob: string; placement: string }; candidates: DuplicateCandidateDTO[]; onAddNew: () => void; onOpen: (id: string) => void; busy: boolean }) {
  return (
    <section className="space-y-3 rounded-xl border border-warning/40 bg-warning-soft/60 p-4" aria-label="Possible duplicate">
      <h3 className="flex items-center gap-2 font-bold text-ink">
        <Info className="size-5 text-warning" aria-hidden="true" /> Is this the same student?
      </h3>
      {candidates.map((c) => (
        <div key={c.studentId} className="grid gap-3 rounded-lg bg-white p-3 text-sm sm:grid-cols-2">
          <div>
            <p className="text-xs font-bold tracking-wide text-muted uppercase">You are adding</p>
            <p className="font-semibold">{typed.name}</p>
            <p className="text-muted">{typed.dob ? formatDateOnly(typed.dob) : 'No date of birth'}</p>
            <p className="text-muted">{typed.placement}</p>
          </div>
          <div>
            <p className="text-xs font-bold tracking-wide text-muted uppercase">Already in the school</p>
            <p className="font-semibold">{c.fullName}</p>
            <p className="text-muted">
              <span className="font-mono">{c.admissionNumber ?? 'No admission no.'}</span>
              {c.classSection ? ` · ${c.classSection.label}` : ''}
            </p>
            <p className="text-warning">{c.reasons.map((r) => DUPLICATE_REASON_LABELS[r]).join(', ')}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={() => onOpen(c.studentId)}>
              Open Existing Student
            </Button>
          </div>
        </div>
      ))}
      <Button onClick={onAddNew} loading={busy} loadingText="Adding…">
        No, Add As New
      </Button>
    </section>
  );
}

// ───────────────────────────────────────────────────────────── the drawer

/** `parent` pre-fills an existing parent (adding a brother or sister from the Family page). */
export function AddStudentDrawer({ open, onOpenChange, parent }: { open: boolean; onOpenChange: (open: boolean) => void; parent?: { personId: string; fullName: string } }) {
  return (
    <Drawer open={open} onOpenChange={onOpenChange}>
      {open && <AddStudentForm onClose={() => onOpenChange(false)} presetParent={parent} />}
    </Drawer>
  );
}

function AddStudentForm({ onClose, presetParent }: { onClose: () => void; presetParent?: { personId: string; fullName: string } }) {
  const navigate = useNavigate();
  const ctx = useStudentContext();
  const [form, setForm] = useState<Form>({ ...EMPTY, parentPersonId: presetParent?.personId ?? '' });
  const [errors, setErrors] = useState<Partial<Record<FieldName, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [step, setStep] = useState(0);
  const [moreOpen, setMoreOpen] = useState(false);
  const [duplicates, setDuplicates] = useState<DuplicateCandidateDTO[] | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [dirty, setDirty] = useState(false);

  const set = <K extends FieldName>(key: K, value: Form[K]) => {
    setDirty(true);
    setForm((f) => ({ ...f, [key]: value }));
    setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
    if (duplicates) setDuplicates(null);
  };

  // What the school needs to know about the class: its sections, required subjects and subject choices.
  const classes = useClassOfferings(ctx.sessionId, ctx.locationId);
  const recommendations = useSectionRecommendations(form.classOfferingId || undefined);
  const offerings = useSubjectOfferings(form.classOfferingId || undefined);
  const choiceGroups = useChoiceGroups(form.classOfferingId || undefined);
  const settings = useAdmissionSettings();
  const preview = useAdmissionPreview({ academicSessionId: ctx.sessionId, locationId: ctx.locationId }, settings.data?.mode === 'AUTO');

  const recommended = recommendations.data?.find((s) => s.recommended) ?? recommendations.data?.[0];
  const sectionId = form.sectionId || recommended?.sectionId || '';
  const mandatoryCount = (offerings.data ?? []).filter((o) => o.offeringType === 'MANDATORY' && o.status === 'ACTIVE').length;
  const choiceCount = (choiceGroups.data ?? []).filter((g) => g.status === 'ACTIVE' && g.ruleType !== 'REQUIRED_ALL').length;
  const manualNumber = settings.data?.mode === 'MANUAL' || form.migration;

  // Is the typed phone or email already a parent?
  const phoneNow = useDebouncedValue(form.parentPhone, 500);
  const emailNow = useDebouncedValue(form.parentEmail, 500);
  const matchArgs = {
    phone: digitsIn(phoneNow) >= 7 ? phoneNow.trim() : undefined,
    email: /.+@.+\..+/.test(emailNow.trim()) ? emailNow.trim() : undefined,
  };
  const matches = useGuardianMatch(matchArgs, !form.parentPersonId);
  const chosenParent = (matches.data ?? []).find((m) => m.personId === form.parentPersonId);
  const [pickedParent, setPickedParent] = useState<GuardianMatchDTO | null>(presetParent ? { personId: presetParent.personId, fullName: presetParent.fullName, maskedPhone: null, maskedEmail: null, isGuardian: true, children: [] } : null);
  const parent = chosenParent ?? pickedParent;

  const classOptions = (classes.data ?? []).filter((c) => c.status === 'ACTIVE').map((c) => ({ value: c.classOfferingId, label: c.displayName, hint: c.displayCode }));
  const className = classes.data?.find((c) => c.classOfferingId === form.classOfferingId)?.displayName;
  const sectionLabel = recommendations.data?.find((s) => s.sectionId === sectionId)?.label;

  const create = useStudentMutation((body: object) => api.post<CreateStudentResultDTO>('/students', body), { quiet: true });

  // ─── validation (plain words, one message per field)
  const validate = (draft: boolean): Partial<Record<FieldName, string>> => {
    const e: Partial<Record<FieldName, string>> = {};
    if (blank(form.firstName)) e.firstName = 'Enter the student’s first name.';
    if (draft) return e;
    if (!form.classOfferingId) e.classOfferingId = 'Choose a class.';
    if (!form.parentPersonId) {
      if (blank(form.parentFirstName)) e.parentFirstName = 'Enter the parent’s name.';
    }
    if (!form.relationship) e.relationship = 'Choose how they are related to the student.';
    if (form.migration) {
      if (blank(form.admissionNumber)) e.admissionNumber = 'Enter the original admission number.';
      if (!form.admissionDate) e.admissionDate = 'Enter the original admission date.';
    } else if (manualNumber && blank(form.admissionNumber)) e.admissionNumber = 'Enter the admission number.';
    if (form.rollMode === 'TYPED' && blank(form.rollNumber)) e.rollNumber = 'Type a roll number, or choose Next free number.';
    if (!ctx.locationId) e.classOfferingId = 'Choose a campus first.';
    return e;
  };

  const body = (draft: boolean, confirmNotDuplicate: boolean) => {
    const address = {
      line1: orUndefined(form.addressLine1),
      line2: orUndefined(form.addressLine2),
      city: orUndefined(form.city),
      state: orUndefined(form.state),
      postalCode: orUndefined(form.postalCode),
    };
    const hasAddress = Object.values(address).some(Boolean);
    const person = {
      legalFirstName: form.firstName.trim(),
      legalMiddleName: orUndefined(form.middleName),
      legalLastName: form.lastName.trim(),
      preferredName: orUndefined(form.preferredName),
      dateOfBirth: orUndefined(form.dateOfBirth),
      gender: orUndefined(form.gender),
      bloodGroup: orUndefined(form.bloodGroup),
      primaryPhone: orUndefined(form.studentPhone),
      ...(hasAddress ? { address } : {}),
      notes: orUndefined(form.remarks),
    };
    if (draft) return { draft: true, ...person, ...(form.classOfferingId && ctx.locationId ? { locationId: ctx.locationId, academicSessionId: ctx.sessionId, classOfferingId: form.classOfferingId } : {}) };
    const prev = orUndefined(form.prevName)
      ? { name: form.prevName.trim(), board: orUndefined(form.prevBoard), className: orUndefined(form.prevClass), tcNumber: orUndefined(form.prevTc) }
      : undefined;
    const guardian = form.parentPersonId
      ? { guardianPersonId: form.parentPersonId, relationshipType: form.relationship }
      : {
          legalFirstName: form.parentFirstName.trim(),
          legalLastName: form.parentLastName.trim(),
          phone: orUndefined(form.parentPhone),
          email: orUndefined(form.parentEmail),
          relationshipType: form.relationship,
        };
    return {
      ...person,
      remarks: undefined,
      notes: undefined,
      mode: form.migration ? 'MIGRATION' : 'NEW_ADMISSION',
      admissionDate: orUndefined(form.admissionDate),
      admissionNumber: manualNumber ? orUndefined(form.admissionNumber) : undefined,
      category: orUndefined(form.category),
      ...(prev ? { previousSchool: prev } : {}),
      academicSessionId: ctx.sessionId,
      locationId: ctx.locationId,
      classOfferingId: form.classOfferingId,
      ...(sectionId ? { sectionId } : {}),
      ...(sectionId && form.rollMode === 'AUTO' ? { rollNumber: 'AUTO' } : {}),
      ...(sectionId && form.rollMode === 'TYPED' ? { rollNumber: form.rollNumber.trim() } : {}),
      ...(orUndefined(form.extraIdValue) ? { externalIds: [{ type: orUndefined(form.extraIdType) ?? 'Legacy ERP ID', value: form.extraIdValue.trim() }] } : {}),
      guardian,
      ...(confirmNotDuplicate ? { confirmNotDuplicate: true } : {}),
    };
  };

  const finish = (result: CreateStudentResultDTO, draft: boolean) => {
    const name = result.student.fullName;
    if (draft) toast.success(`${name} was saved as a draft. Finish the admission from their page.`);
    else toast.success(`${name} was added.${result.subjectsMessage ? ` ${result.subjectsMessage}.` : ''}`);
    for (const w of result.warnings) toast.warning(w.message);
    onClose();
    navigate(`/students/${result.student.studentId}`);
  };

  const submit = async (draft: boolean, confirmNotDuplicate = false) => {
    const found = validate(draft);
    setErrors(found);
    setFormError(null);
    const firstBad = Object.keys(found)[0];
    if (firstBad) {
      setFormError('Some details need your attention.');
      if (full) setStep(stepOfField(STEPS, firstBad));
      else if (['gender'].includes(firstBad)) setMoreOpen(true);
      return;
    }
    try {
      const result = await create.mutateAsync(body(draft, confirmNotDuplicate));
      // An emergency contact is a second guardian: saved after the student exists.
      if (!draft && !blank(form.emergencyName)) {
        try {
          await api.post(`/students/${result.student.studentId}/guardians`, {
            legalFirstName: form.emergencyName.trim(),
            phone: orUndefined(form.emergencyPhone),
            relationshipType: form.emergencyRelationship || 'Other',
            isPrimary: false,
            isEmergencyContact: true,
            canSeeAcademics: false,
            canSeeFees: false,
          });
        } catch (err) {
          toast.warning(`The student was added, but the emergency contact was not saved. ${messageFor(err)}`);
        }
      }
      finish(result, draft);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'POSSIBLE_DUPLICATE_STUDENT') {
        setDuplicates(((err.details as { candidates?: DuplicateCandidateDTO[] } | undefined)?.candidates ?? []) as DuplicateCandidateDTO[]);
        return;
      }
      const placed: Partial<Record<FieldName, string>> = {};
      if (err instanceof ApiError) for (const [path, message] of Object.entries(err.fieldErrors)) if (SERVER_FIELDS[path]) placed[SERVER_FIELDS[path]] = message;
      setErrors(placed);
      const placedAll = err instanceof ApiError && Object.keys(placed).length > 0 && Object.keys(placed).length === Object.keys(err.fieldErrors).length;
      setFormError(placedAll ? 'Some details need your attention.' : messageFor(err));
      const first = Object.keys(placed)[0];
      if (first && full) setStep(stepOfField(STEPS, first));
    }
  };

  const requestClose = () => {
    if (create.isPending) return;
    if (dirty) setConfirmDiscard(true);
    else onClose();
  };

  // ─── blocks (used by both the short form and the full form)
  const nameBlock = (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField label="First name" required autoFocus autoComplete="off" value={form.firstName} error={errors.firstName} onChange={(e) => set('firstName', e.target.value)} />
        <TextField label="Last name" autoComplete="off" hint="Leave empty if there is only one name." value={form.lastName} error={errors.lastName} onChange={(e) => set('lastName', e.target.value)} />
      </div>
      {full && (
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField label="Middle name" hint="Optional." autoComplete="off" value={form.middleName} error={errors.middleName} onChange={(e) => set('middleName', e.target.value)} />
          <TextField label="Preferred name" hint="Optional. The name used in lists." autoComplete="off" value={form.preferredName} error={errors.preferredName} onChange={(e) => set('preferredName', e.target.value)} />
        </div>
      )}
    </div>
  );

  const dobBlock = (
    <TextField label="Date of birth" type="date" hint="Optional." value={form.dateOfBirth} error={errors.dateOfBirth} onChange={(e) => set('dateOfBirth', e.target.value)} />
  );

  const personalBlock = (
    <div className="space-y-5">
      {dobBlock}
      <div className="grid gap-5 sm:grid-cols-2">
        <ComboboxField
          label="Gender"
          hint="Optional."
          value={form.gender}
          onChange={(v) => set('gender', v)}
          options={[{ value: '', label: 'Not given' }, ...GENDERS.map((g) => ({ value: g, label: GENDER_LABELS[g] }))]}
          searchPlaceholder="Search…"
          error={errors.gender}
        />
        <ComboboxField
          label="Blood group"
          hint="Optional."
          value={form.bloodGroup}
          onChange={(v) => set('bloodGroup', v)}
          options={[{ value: '', label: 'Not given' }, ...BLOOD_GROUPS.map((g) => ({ value: g, label: g }))]}
          searchPlaceholder="Search…"
          error={errors.bloodGroup}
        />
      </div>
    </div>
  );

  const classBlock = (
    <div className="space-y-5">
      <ComboboxField
        label="Class"
        required
        value={form.classOfferingId}
        onChange={(v) => {
          setDirty(true);
          setErrors((e) => ({ ...e, classOfferingId: undefined }));
          setForm((f) => ({ ...f, classOfferingId: v, sectionId: '', rollMode: '', rollNumber: '' }));
        }}
        options={classOptions}
        placeholder="Choose…"
        searchPlaceholder="Search classes…"
        error={errors.classOfferingId}
        hint={classOptions.length === 0 && !classes.isLoading ? 'No classes are set up for this year and campus yet. Add them in Academic Setup.' : undefined}
      />
      {form.classOfferingId && (
        <div className="grid gap-5 sm:grid-cols-2">
          <ComboboxField
            label="Section"
            hint={recommended ? `Suggested: ${recommended.label}. Change it if you like.` : 'This class has no sections yet. Add them in Academic Setup.'}
            value={sectionId}
            onChange={(v) => set('sectionId', v)}
            options={(recommendations.data ?? []).map((s) => ({ value: s.sectionId, label: s.label, hint: s.isFull ? 'Full' : s.recommended ? 'Suggested' : undefined }))}
            placeholder="Choose…"
            searchPlaceholder="Search sections…"
            error={errors.sectionId}
          />
          {sectionId && (
            <div className="space-y-2">
              <ComboboxField
                label="Roll number"
                labelAside={<InfoTip label="About the roll number">{ROLL_NUMBER_HELP}</InfoTip>}
                value={form.rollMode}
                onChange={(v) => set('rollMode', v as Form['rollMode'])}
                options={[
                  { value: '', label: 'Give it later' },
                  { value: 'AUTO', label: 'Next free number' },
                  { value: 'TYPED', label: 'Type a number' },
                ]}
                searchPlaceholder="Search…"
              />
              {form.rollMode === 'TYPED' && (
                <TextField label="Roll number to use" value={form.rollNumber} error={errors.rollNumber} onChange={(e) => set('rollNumber', e.target.value)} />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );

  const admissionBlock = (
    <div className="space-y-5">
      <label className="flex items-start gap-3 rounded-xl border border-line p-3 text-sm">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-brand)]" checked={form.migration} onChange={(e) => set('migration', e.target.checked)} />
        <span className="flex-1">
          <span className="flex items-center gap-1.5 font-semibold">
            Existing Student (Migration) <InfoTip label="About existing students">{MIGRATION_HELP}</InfoTip>
          </span>
          <span className="text-muted">This student already studies here. You are only adding them to SchoolVerse.</span>
        </span>
      </label>
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label={form.migration ? 'Original admission date' : 'Admission date'}
          type="date"
          required={form.migration}
          hint={form.migration ? undefined : 'Today is filled in.'}
          value={form.admissionDate}
          error={errors.admissionDate}
          onChange={(e) => set('admissionDate', e.target.value)}
        />
        {manualNumber ? (
          <TextField
            label={form.migration ? 'Original admission number' : 'Admission number'}
            required
            labelAside={<InfoTip label="About the admission number">{ADMISSION_NUMBER_HELP}</InfoTip>}
            hint="Example: GPS/2026/00482. It can’t be changed later."
            autoComplete="off"
            value={form.admissionNumber}
            error={errors.admissionNumber}
            onChange={(e) => set('admissionNumber', e.target.value.toUpperCase())}
          />
        ) : (
          <div className="space-y-1.5">
            <p className="flex items-center gap-1.5 text-sm font-semibold">
              Admission number <InfoTip label="About the admission number">{ADMISSION_NUMBER_HELP}</InfoTip>
            </p>
            <p className="rounded-control border border-dashed border-line bg-canvas px-3.5 py-2.5 text-sm text-muted">Will be created automatically{preview.data?.admissionNumber ? ` (next: ${preview.data.admissionNumber})` : ''}</p>
          </div>
        )}
      </div>
      {full && <TextField label="Category" hint="Optional. Example: General, EWS." value={form.category} error={errors.category} onChange={(e) => set('category', e.target.value)} />}
    </div>
  );

  const parentBlock = (
    <div className="space-y-4">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Parent phone"
          type="tel"
          autoComplete="off"
          labelAside={<InfoTip label="About the parent phone">{PARENT_PHONE_HELP}</InfoTip>}
          hint="We check if this parent is already in the school."
          value={form.parentPhone}
          error={errors.parentPhone}
          onChange={(e) => set('parentPhone', e.target.value)}
          disabled={Boolean(form.parentPersonId)}
        />
        <TextField label="Parent email" type="email" autoComplete="off" hint="Optional. Needed later for a parent login." value={form.parentEmail} error={errors.parentEmail} onChange={(e) => set('parentEmail', e.target.value)} disabled={Boolean(form.parentPersonId)} />
      </div>

      {parent && form.parentPersonId ? (
        <div className="flex items-center gap-3 rounded-xl border border-success/30 bg-success-soft p-3 text-sm" role="status">
          <CheckCircle2 className="size-5 text-success" aria-hidden="true" />
          <p className="flex-1 font-semibold">Using {parent.fullName}. No need to type their details again.</p>
          <Button variant="outline" size="sm" onClick={() => { set('parentPersonId', ''); setPickedParent(null); }}>
            Use A Different Parent
          </Button>
        </div>
      ) : (
        <>
          {(matches.data ?? []).slice(0, 2).map((m) => (
            <MatchCard key={m.personId} match={m} onUse={() => { setPickedParent(m); setDirty(true); setForm((f) => ({ ...f, parentPersonId: m.personId })); }} />
          ))}
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField label="Parent name" required autoComplete="off" value={form.parentFirstName} error={errors.parentFirstName} onChange={(e) => set('parentFirstName', e.target.value)} />
            <TextField label="Parent last name" autoComplete="off" hint="Optional." value={form.parentLastName} error={errors.parentLastName} onChange={(e) => set('parentLastName', e.target.value)} />
          </div>
        </>
      )}
      <ComboboxField
        label="Relationship"
        required
        value={form.relationship}
        onChange={(v) => set('relationship', v)}
        options={RELATIONSHIP_TYPES.map((r) => ({ value: r, label: r }))}
        placeholder="Choose…"
        searchPlaceholder="Search…"
        error={errors.relationship}
        hint="The first parent you add becomes the primary parent."
      />
    </div>
  );

  const subjectsBlock = form.classOfferingId ? (
    <div className="space-y-3">
      <div className="flex items-start gap-2 rounded-xl border border-success/30 bg-success-soft px-4 py-3 text-sm">
        <CheckCircle2 className="mt-0.5 size-[18px] shrink-0 text-success" aria-hidden="true" />
        <p className="flex-1">
          <b>{mandatoryCount === 0 ? 'Required subjects' : `${mandatoryCount} required ${mandatoryCount === 1 ? 'subject' : 'subjects'}`}</b> will be added automatically.{' '}
          <InfoTip label="Why subjects are added automatically">{AUTO_SUBJECTS_HELP}</InfoTip>
        </p>
      </div>
      {choiceCount > 0 && (
        <p className="rounded-xl border border-line bg-canvas px-4 py-3 text-sm">
          This class also has <b>{choiceCount}</b> subject {choiceCount === 1 ? 'choice' : 'choices'} (for example a second language). Pick them on the student’s <b>Class &amp; Subjects</b> tab after saving.
        </p>
      )}
    </div>
  ) : (
    <p className="text-sm text-muted">Choose a class to see its subjects.</p>
  );

  const previousBlock = (
    <div className="space-y-5">
      <TextField label="Previous school" hint="Optional. Leave empty if this is the first school." autoComplete="off" value={form.prevName} error={errors.prevName} onChange={(e) => set('prevName', e.target.value)} />
      <div className="grid gap-5 sm:grid-cols-3">
        <TextField label="Board" hint="Example: CBSE." value={form.prevBoard} error={errors.prevBoard} onChange={(e) => set('prevBoard', e.target.value)} />
        <TextField label="Last class" value={form.prevClass} error={errors.prevClass} onChange={(e) => set('prevClass', e.target.value)} />
        <TextField label="TC number" value={form.prevTc} error={errors.prevTc} onChange={(e) => set('prevTc', e.target.value)} />
      </div>
    </div>
  );

  const emergencyBlock = (
    <div className="space-y-4">
      <p className="flex items-center gap-1.5 text-sm text-muted">
        Optional. Someone to call if the parents can’t be reached. <InfoTip label="About the emergency contact">{EMERGENCY_FLAG_HELP}</InfoTip>
      </p>
      <div className="grid gap-5 sm:grid-cols-3">
        <TextField label="Name" autoComplete="off" value={form.emergencyName} error={errors.emergencyName} onChange={(e) => set('emergencyName', e.target.value)} />
        <TextField label="Phone" type="tel" autoComplete="off" value={form.emergencyPhone} error={errors.emergencyPhone} onChange={(e) => set('emergencyPhone', e.target.value)} />
        <ComboboxField label="Relationship" value={form.emergencyRelationship} onChange={(v) => set('emergencyRelationship', v)} options={RELATIONSHIP_TYPES.map((r) => ({ value: r, label: r }))} placeholder="Choose…" searchPlaceholder="Search…" />
      </div>
      <p className="text-[13px] text-muted">More guardians can be added from the student’s <b>Parents &amp; Guardians</b> tab.</p>
    </div>
  );

  const addressBlock = (
    <div className="space-y-5">
      <TextField label="Address" hint="Optional." autoComplete="off" value={form.addressLine1} error={errors.addressLine1} onChange={(e) => set('addressLine1', e.target.value)} />
      <div className="grid gap-5 sm:grid-cols-3">
        <TextField label="City" value={form.city} error={errors.city} onChange={(e) => set('city', e.target.value)} />
        <TextField label="State" value={form.state} error={errors.state} onChange={(e) => set('state', e.target.value)} />
        <TextField label="Postal code" value={form.postalCode} error={errors.postalCode} onChange={(e) => set('postalCode', e.target.value)} />
      </div>
      {full && <TextField label="Student phone" type="tel" hint="Optional." value={form.studentPhone} error={errors.studentPhone} onChange={(e) => set('studentPhone', e.target.value)} />}
    </div>
  );

  const notesBlock = (
    <div className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField label="Outside ID type" list="id-types" hint="Optional. Example: Board Reg No." value={form.extraIdType} onChange={(e) => set('extraIdType', e.target.value)} />
        <datalist id="id-types">
          {['Legacy ERP ID', 'Board Reg No', 'State ID', 'PEN'].map((t) => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <TextField label="Outside ID" value={form.extraIdValue} onChange={(e) => set('extraIdValue', e.target.value)} />
      </div>
      <TextareaField label="Notes" hint="Optional. Only the school office sees this." value={form.remarks} error={errors.remarks} onChange={(e) => set('remarks', e.target.value)} />
    </div>
  );

  const reviewBlock = (
    <div className="space-y-4">
      <ReviewCard title="Student" onEdit={() => setStep(0)}>
        <ReviewRow label="Name" value={[form.firstName, form.middleName, form.lastName].filter(Boolean).join(' ')} />
        <ReviewRow label="Date of birth" value={form.dateOfBirth ? formatDateOnly(form.dateOfBirth) : ''} />
        <ReviewRow label="Gender" value={GENDER_LABELS[form.gender as keyof typeof GENDER_LABELS] ?? ''} />
      </ReviewCard>
      <ReviewCard title="Admission" onEdit={() => setStep(2)}>
        <ReviewRow label="Type" value={form.migration ? 'Existing student (migration)' : 'New admission'} />
        <ReviewRow label="Date" value={formatDateOnly(form.admissionDate)} />
        <ReviewRow label="Number" value={manualNumber ? form.admissionNumber : 'Created automatically'} />
      </ReviewCard>
      <ReviewCard title="Class" onEdit={() => setStep(4)}>
        <ReviewRow label="Class" value={className} />
        <ReviewRow label="Section" value={sectionLabel ?? ''} />
        <ReviewRow label="Subjects" value={mandatoryCount ? `${mandatoryCount} required subjects added automatically` : 'Added automatically'} />
      </ReviewCard>
      <ReviewCard title="Parent" onEdit={() => setStep(6)}>
        <ReviewRow label="Name" value={parent && form.parentPersonId ? `${parent.fullName} (existing parent)` : [form.parentFirstName, form.parentLastName].filter(Boolean).join(' ')} />
        <ReviewRow label="Relationship" value={form.relationship} />
        <ReviewRow label="Phone" value={form.parentPhone} />
      </ReviewCard>
      {!blank(form.emergencyName) && (
        <ReviewCard title="Emergency contact" onEdit={() => setStep(7)}>
          <ReviewRow label="Name" value={form.emergencyName} />
          <ReviewRow label="Phone" value={form.emergencyPhone} />
        </ReviewCard>
      )}
    </div>
  );

  const typedForCard = useMemo(
    () => ({ name: [form.firstName, form.lastName].filter(Boolean).join(' '), dob: form.dateOfBirth, placement: className ? placementText({ classOfferingId: form.classOfferingId, className, classCode: '', sectionId, sectionCode: null, label: className }, null) : 'No class chosen' }),
    [form.firstName, form.lastName, form.dateOfBirth, className, form.classOfferingId, sectionId],
  );

  const stepBlocks: Record<string, React.ReactNode> = {
    student: nameBlock,
    personal: personalBlock,
    admission: admissionBlock,
    previous: previousBlock,
    class: classBlock,
    subjects: subjectsBlock,
    parent: parentBlock,
    emergency: emergencyBlock,
    contact: addressBlock,
    notes: notesBlock,
    review: reviewBlock,
  };

  const duplicateCard = duplicates && duplicates.length > 0 && (
    <DuplicateCard
      typed={typedForCard}
      candidates={duplicates}
      busy={create.isPending}
      onAddNew={() => void submit(false, true)}
      onOpen={(id) => {
        onClose();
        navigate(`/students/${id}`);
      }}
    />
  );

  return (
    <>
      <DrawerContent
        title="Add student"
        description={full ? 'The full admission form, step by step.' : 'Fill in the basics. Everything else can be added later.'}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          requestClose();
        }}
      >
        {full && <DrawerStepper steps={STEPS} current={step} onJump={setStep} />}
        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            if (full && step < LAST) setStep((s) => s + 1);
            else void submit(false);
          }}
        >
          <DrawerBody>
            <div className="mb-5 flex flex-wrap items-center justify-between gap-2">
              <button type="button" onClick={() => { setFull((v) => !v); setStep(0); }} className="text-sm font-semibold text-brand hover:underline" aria-pressed={full}>
                {full ? 'Use The Quick Form' : 'Full Admission Form'}
              </button>
              <InfoTip label="About saving as a draft">{DRAFT_HELP}</InfoTip>
            </div>

            {formError && (
              <Alert tone="danger" className="mb-5">
                {formError}
              </Alert>
            )}
            {duplicateCard && <div className="mb-5">{duplicateCard}</div>}

            {full ? (
              <section aria-label={STEPS[step]!.label} className="space-y-5">
                <h3 className="text-base font-bold">{STEPS[step]!.label}</h3>
                {stepBlocks[STEPS[step]!.key]}
              </section>
            ) : (
              <div className="space-y-6">
                {nameBlock}
                {dobBlock}
                {classBlock}
                {admissionBlock}
                {parentBlock}
                {subjectsBlock}
                <div>
                  <button type="button" className="flex items-center gap-1.5 text-sm font-semibold text-brand" aria-expanded={moreOpen} onClick={() => setMoreOpen((v) => !v)}>
                    <ChevronDown className={cn('size-4 transition-transform', moreOpen && 'rotate-180')} aria-hidden="true" /> More details (optional)
                  </button>
                  {moreOpen && (
                    <div className="mt-4 space-y-6 rounded-xl border border-line p-4">
                      {personalBlock}
                      <div className="space-y-3">
                        <h4 className="text-sm font-bold">Previous school</h4>
                        {previousBlock}
                      </div>
                      <div className="space-y-3">
                        <h4 className="text-sm font-bold">Address</h4>
                        {addressBlock}
                      </div>
                      <div className="space-y-3">
                        <h4 className="text-sm font-bold">Emergency contact</h4>
                        {emergencyBlock}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </DrawerBody>
          <DrawerFooter>
            <Button variant="outline" onClick={requestClose} disabled={create.isPending}>
              Cancel
            </Button>
            <Button variant="outline" onClick={() => void submit(true)} disabled={create.isPending}>
              Save As Draft
            </Button>
            {full && step > 0 && (
              <Button variant="outline" onClick={() => setStep((s) => s - 1)} disabled={create.isPending}>
                <ArrowLeft /> Back
              </Button>
            )}
            {full && step < LAST ? (
              <Button type="submit">
                Next <ArrowRight />
              </Button>
            ) : (
              <Button type="submit" loading={create.isPending} loadingText="Adding…">
                <UserPlus /> Add Student
              </Button>
            )}
          </DrawerFooter>
        </form>
      </DrawerContent>
      <ConfirmDialog
        open={confirmDiscard}
        onOpenChange={setConfirmDiscard}
        title="Discard this student?"
        description="What you typed has not been saved."
        confirmLabel="Discard"
        loadingLabel="Closing…"
        tone="danger"
        onConfirm={() => onClose()}
      />
    </>
  );
}
