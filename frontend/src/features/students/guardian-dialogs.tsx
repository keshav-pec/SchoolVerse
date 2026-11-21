import { useState } from 'react';
import { RELATIONSHIP_TYPES, type GuardianLinkDTO, type GuardianMatchDTO, type StudentAdminProfileDTO } from '@shared';
import { CalendarX2, Link2, Search, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { api } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import { useGuardianMatch, useStudentMutation } from './api';
import { EMERGENCY_FLAG_HELP, PARENT_PHONE_HELP, PORTAL_FLAG_HELP, PRIMARY_GUARDIAN_HELP } from './help-copy';

function Check({ label, checked, onChange, help, helpLabel }: { label: string; checked: boolean; onChange: (v: boolean) => void; help?: React.ReactNode; helpLabel?: string }) {
  return (
    <label className="flex min-h-9 items-center gap-2 text-sm">
      <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
      {help && <InfoTip label={helpLabel ?? `About ${label.toLowerCase()}`}>{help}</InfoTip>}
    </label>
  );
}

interface Flags {
  isPrimary: boolean;
  isEmergencyContact: boolean;
  canSeeAcademics: boolean;
  canSeeFees: boolean;
  pickupAllowed: boolean;
}

function FlagsFields({ flags, onChange }: { flags: Flags; onChange: (f: Flags) => void }) {
  const set = <K extends keyof Flags>(k: K, v: boolean) => onChange({ ...flags, [k]: v });
  return (
    <fieldset className="space-y-0.5 rounded-xl border border-line p-3">
      <legend className="flex items-center gap-1.5 px-1 text-sm font-bold">
        What this person is <InfoTip label="Primary parent and emergency contact">{PRIMARY_GUARDIAN_HELP}</InfoTip>
      </legend>
      <Check label="Primary parent" checked={flags.isPrimary} onChange={(v) => set('isPrimary', v)} help={PRIMARY_GUARDIAN_HELP} helpLabel="About the primary parent" />
      <Check label="Emergency contact" checked={flags.isEmergencyContact} onChange={(v) => set('isEmergencyContact', v)} help={EMERGENCY_FLAG_HELP} helpLabel="About the emergency contact" />
      <Check label="Can see class details" checked={flags.canSeeAcademics} onChange={(v) => set('canSeeAcademics', v)} help={PORTAL_FLAG_HELP} helpLabel="About what they can see" />
      <Check label="Can see fee details" checked={flags.canSeeFees} onChange={(v) => set('canSeeFees', v)} />
      <Check label="Allowed to pick up the student" checked={flags.pickupAllowed} onChange={(v) => set('pickupAllowed', v)} />
    </fieldset>
  );
}

// ───────────────────────────────────────────────────────────── add or link a parent

function NewParentForm({ student, hasPrimary, onDone }: { student: StudentAdminProfileDTO; hasPrimary: boolean; onDone: () => void }) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [relationship, setRelationship] = useState('');
  const [flags, setFlags] = useState<Flags>({ isPrimary: !hasPrimary, isEmergencyContact: false, canSeeAcademics: true, canSeeFees: true, pickupAllowed: false });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const phoneNow = useDebouncedValue(phone, 500);
  const emailNow = useDebouncedValue(email, 500);
  const matches = useGuardianMatch({ phone: phoneNow.replace(/\D/g, '').length >= 7 ? phoneNow : undefined, email: /.+@.+\..+/.test(emailNow) ? emailNow : undefined });
  const add = useStudentMutation((body: object) => api.post<GuardianLinkDTO>(`/students/${student.studentId}/guardians`, body), { quiet: true });
  const link = useStudentMutation((body: object) => api.post<GuardianLinkDTO>(`/students/${student.studentId}/link-existing-guardian`, body), { quiet: true });

  const save = async () => {
    const errs: Record<string, string> = {};
    if (!first.trim()) errs.legalFirstName = 'Enter the parent’s name.';
    if (!relationship) errs.relationshipType = 'Choose how they are related to the student.';
    setFieldErrors(errs);
    if (Object.keys(errs).length > 0) return;
    setError(null);
    try {
      await add.mutateAsync({ legalFirstName: first.trim(), legalLastName: last.trim(), phone: phone.trim() || undefined, email: email.trim() || undefined, relationshipType: relationship, ...flags });
      toast.success(`${first.trim()} was added.`);
      onDone();
    } catch (err) {
      setError(messageFor(err));
    }
  };

  const linkParent = async (m: GuardianMatchDTO) => {
    if (!relationship) return setFieldErrors({ relationshipType: 'Choose how they are related to the student first.' });
    try {
      await link.mutateAsync({ guardianPersonId: m.personId, relationshipType: relationship, ...flags });
      toast.success(`${m.fullName} was linked.`);
      onDone();
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <>
      <DrawerBody>
        <div className="space-y-5">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField label="Phone" type="tel" autoComplete="off" labelAside={<InfoTip label="About the phone">{PARENT_PHONE_HELP}</InfoTip>} value={phone} onChange={(e) => setPhone(e.target.value)} hint="We check if this parent is already in the school." />
            <TextField label="Email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} hint="Optional. Needed later for a parent login." />
          </div>
          {(matches.data ?? []).slice(0, 2).map((m) => (
            <div key={m.personId} className="flex flex-col gap-2 rounded-xl border border-brand/25 bg-brand-soft/60 p-3 text-sm sm:flex-row sm:items-center" role="status">
              <p className="flex-1">
                <b>{m.fullName}</b> is already in the school{m.children[0] ? ` (parent of ${m.children[0].fullName})` : ''}.
              </p>
              <Button size="sm" onClick={() => void linkParent(m)} loading={link.isPending}>
                Use This Parent
              </Button>
            </div>
          ))}
          <div className="grid gap-5 sm:grid-cols-2">
            <TextField label="Name" required autoFocus autoComplete="off" value={first} error={fieldErrors.legalFirstName} onChange={(e) => setFirst(e.target.value)} />
            <TextField label="Last name" autoComplete="off" hint="Optional." value={last} onChange={(e) => setLast(e.target.value)} />
          </div>
          <ComboboxField label="Relationship" required value={relationship} onChange={setRelationship} options={RELATIONSHIP_TYPES.map((r) => ({ value: r, label: r }))} placeholder="Choose…" searchPlaceholder="Search…" error={fieldErrors.relationshipType} />
          <FlagsFields flags={flags} onChange={setFlags} />
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onDone} disabled={add.isPending}>
          Cancel
        </Button>
        <Button onClick={() => void save()} loading={add.isPending} loadingText="Adding…">
          <UserPlus /> Add Parent
        </Button>
      </DrawerFooter>
    </>
  );
}

function LinkExistingForm({ student, hasPrimary, onDone }: { student: StudentAdminProfileDTO; hasPrimary: boolean; onDone: () => void }) {
  const [text, setText] = useState('');
  const [relationship, setRelationship] = useState('');
  const [flags, setFlags] = useState<Flags>({ isPrimary: !hasPrimary, isEmergencyContact: false, canSeeAcademics: true, canSeeFees: true, pickupAllowed: false });
  const [error, setError] = useState<string | null>(null);
  const [relError, setRelError] = useState<string | undefined>();
  const typed = useDebouncedValue(text.trim(), 400);

  // A phone has mostly digits, an email has an @, anything else is a name.
  const args = !typed
    ? {}
    : typed.includes('@')
      ? { email: typed }
      : typed.replace(/\D/g, '').length >= 5 && /^[\d\s+()-]+$/.test(typed)
        ? { phone: typed }
        : { name: typed };
  const matches = useGuardianMatch(args);
  const link = useStudentMutation((body: object) => api.post<GuardianLinkDTO>(`/students/${student.studentId}/link-existing-guardian`, body), { quiet: true });

  const use = async (m: GuardianMatchDTO) => {
    if (!relationship) return setRelError('Choose how they are related to the student first.');
    setRelError(undefined);
    try {
      await link.mutateAsync({ guardianPersonId: m.personId, relationshipType: relationship, ...flags });
      toast.success(`${m.fullName} was linked to ${student.fullName}.`);
      onDone();
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <>
      <DrawerBody>
        <div className="space-y-5">
          {error && <Alert tone="danger">{error}</Alert>}
          <div className="space-y-1.5">
            <label htmlFor="find-parent" className="text-sm font-semibold">
              Find the parent
            </label>
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
              <Input id="find-parent" value={text} onChange={(e) => setText(e.target.value)} placeholder="Phone, email or name" className="pl-10" autoFocus autoComplete="off" />
            </div>
            <p className="text-[13px] text-muted">Use this when a brother or sister already studies here. You will not need to type the parent again.</p>
          </div>
          <ComboboxField label="Relationship" required value={relationship} onChange={(v) => { setRelationship(v); setRelError(undefined); }} options={RELATIONSHIP_TYPES.map((r) => ({ value: r, label: r }))} placeholder="Choose…" searchPlaceholder="Search…" error={relError} />
          <FlagsFields flags={flags} onChange={setFlags} />
          <div className="space-y-2" aria-live="polite">
            {typed && matches.isSuccess && matches.data.length === 0 && <p className="text-sm text-muted">No parent found. Use the “New Parent” tab to add them.</p>}
            {(matches.data ?? []).map((m) => (
              <div key={m.personId} className="flex flex-col gap-2 rounded-xl border border-line p-3 text-sm sm:flex-row sm:items-center">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{m.fullName}</p>
                  <p className="text-muted">{[m.maskedPhone, m.maskedEmail].filter(Boolean).join(' · ') || 'Contact hidden'}</p>
                  <p className="text-muted">{m.children.length > 0 ? `Parent of ${m.children.map((c) => c.fullName).join(', ')}` : 'Not linked to any student yet'}</p>
                </div>
                <Button size="sm" onClick={() => void use(m)} loading={link.isPending}>
                  <Link2 /> Use This Parent
                </Button>
              </div>
            ))}
          </div>
        </div>
      </DrawerBody>
      <DrawerFooter>
        <Button variant="outline" onClick={onDone}>
          Close
        </Button>
      </DrawerFooter>
    </>
  );
}

export function AddGuardianDrawer({ student, hasPrimary, initial = 'new', onClose }: { student: StudentAdminProfileDTO; hasPrimary: boolean; initial?: 'new' | 'link'; onClose: () => void }) {
  const [tab, setTab] = useState<'new' | 'link'>(initial);
  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent title="Add parent or guardian" description={`For ${student.fullName}. The first parent becomes the primary parent.`}>
        <div className="flex gap-1 border-b border-line px-5 sm:px-6" role="tablist" aria-label="How to add">
          {(['new', 'link'] as const).map((t) => (
            <button
              key={t}
              type="button"
              role="tab"
              aria-selected={tab === t}
              onClick={() => setTab(t)}
              className={cn('-mb-px min-h-11 border-b-2 px-3 text-sm font-semibold', tab === t ? 'border-brand text-brand' : 'border-transparent text-muted hover:text-ink')}
            >
              {t === 'new' ? 'New Parent' : 'Link Existing Parent'}
            </button>
          ))}
        </div>
        {tab === 'new' ? <NewParentForm student={student} hasPrimary={hasPrimary} onDone={onClose} /> : <LinkExistingForm student={student} hasPrimary={hasPrimary} onDone={onClose} />}
      </DrawerContent>
    </Drawer>
  );
}

// ───────────────────────────────────────────────────────────── edit and end a link

export function EditGuardianDialog({ link, onClose }: { link: GuardianLinkDTO; onClose: () => void }) {
  const [relationship, setRelationship] = useState<string>(link.relationshipType);
  const [flags, setFlags] = useState<Flags>({ isPrimary: link.isPrimary, isEmergencyContact: link.isEmergencyContact, canSeeAcademics: link.canSeeAcademics, canSeeFees: link.canSeeFees, pickupAllowed: link.pickupAllowed });
  const save = useStudentMutation((body: object) => api.patch<GuardianLinkDTO>(`/guardian-links/${link.guardianLinkId}`, body), { quiet: true, success: `${link.fullName} was updated.` });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Edit ${link.fullName}`}
      description="Change how this person is linked to the student."
      confirmLabel="Save Changes"
      loadingLabel="Saving…"
      onConfirm={async () => {
        if (!relationship) throw new FormProblem('Choose how they are related to the student.');
        await save.mutateAsync({ version: link.version, relationshipType: relationship, ...flags });
      }}
    >
      <div className="space-y-4">
        <ComboboxField label="Relationship" value={relationship} onChange={setRelationship} options={RELATIONSHIP_TYPES.map((r) => ({ value: r, label: r }))} searchPlaceholder="Search…" />
        <FlagsFields flags={flags} onChange={setFlags} />
      </div>
    </ConfirmDialog>
  );
}

export function MakePrimaryDialog({ link, onClose }: { link: GuardianLinkDTO; onClose: () => void }) {
  const save = useStudentMutation(() => api.patch<GuardianLinkDTO>(`/guardian-links/${link.guardianLinkId}`, { version: link.version, isPrimary: true }), { quiet: true, success: `${link.fullName} is now the primary parent.` });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Make ${link.fullName} the primary parent?`}
      description="The school calls the primary parent first. The current primary parent stays linked as a guardian."
      confirmLabel="Make Primary"
      loadingLabel="Saving…"
      onConfirm={async () => void (await save.mutateAsync(undefined))}
    />
  );
}

export function EndGuardianDialog({ link, onClose }: { link: GuardianLinkDTO; onClose: () => void }) {
  const [effectiveTo, setTo] = useState('');
  const end = useStudentMutation((body: object) => api.post<GuardianLinkDTO>(`/guardian-links/${link.guardianLinkId}/end`, body), { quiet: true, success: `${link.fullName} was unlinked. The record stays in History.` });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<CalendarX2 className="size-5" />}
      tone="danger"
      title={`Unlink ${link.fullName}?`}
      description="They stop being a parent or guardian of this student. Nothing is deleted: the link stays in History, and they stay linked to their other children."
      confirmLabel="Unlink"
      loadingLabel="Unlinking…"
      onConfirm={async () => {
        await end.mutateAsync(effectiveTo ? { effectiveTo } : {});
      }}
    >
      <TextField label="Last day" type="date" value={effectiveTo} onChange={(e) => setTo(e.target.value)} hint="Optional. Leave empty to unlink from now." />
    </ConfirmDialog>
  );
}
