import { useRef, useState } from 'react';
import {
  WITHDRAWAL_REASON_CATEGORIES,
  WITHDRAWAL_REASON_LABELS,
  type GuardianLinkDTO,
  type LocationTransferResultDTO,
  type LocationTransferValidationDTO,
  type ReadmissionResultDTO,
  type StudentAdminProfileDTO,
  type WithdrawalDTO,
  type WithdrawalReasonCategory,
} from '@shared';
import { ArrowRight, DoorOpen, MapPinned, UserCheck, UserMinus, UserRoundPlus } from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Drawer, DrawerBody, DrawerContent, DrawerFooter } from '@/components/ui/drawer';
import { ComboboxField, TextareaField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api } from '@/lib/api';
import { FormProblem, messageFor } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { useClassOfferings, useSections } from '../academic/api';
import { useAdmissionSettings, useStudentMutation } from './api';
import { useStudentContext } from './context';
import { MOVE_CAMPUS_HELP, READMIT_HELP, WITHDRAWAL_HELP } from './help-copy';
import { todayIso } from './student-bits';

// ───────────────────────────────────────────────────────────── move to another campus

/**
 * Move To Another Campus: choose the campus, class and section, check it first (destination class, board, seats, subjects),
 * choose subjects again when the board changes, then confirm. Same student, same admission number, same parents.
 */
export function MoveCampusDrawer({ student, onClose }: { student: StudentAdminProfileDTO; onClose: () => void }) {
  const ctx = useStudentContext();
  const enrollment = student.enrollment!;
  const [toLocationId, setLocation] = useState('');
  const [classOfferingId, setClass] = useState('');
  const [sectionId, setSection] = useState('');
  const [effectiveDate, setDate] = useState(todayIso());
  const [reason, setReason] = useState('');
  const [check, setCheck] = useState<LocationTransferValidationDTO | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  const classes = useClassOfferings(enrollment.academicSessionId, toLocationId || undefined);
  const sections = useSections(classOfferingId || undefined);
  const move = useStudentMutation((body: object) => api.post<LocationTransferResultDTO>(`/students/${student.studentId}/location-transfer`, body), { quiet: true });

  const campuses = ctx.locations.filter((l) => l.locationId !== enrollment.locationId);
  const base = () => ({ toLocationId, classOfferingId, effectiveDate, ...(sectionId ? { sectionId } : {}) });
  const reset = () => {
    setCheck(null);
    setError(null);
  };

  const runCheck = async () => {
    setError(null);
    if (!toLocationId) return setError('Choose the new campus.');
    if (!classOfferingId) return setError('Choose the class at the new campus.');
    setChecking(true);
    try {
      const result = await api.post<LocationTransferValidationDTO>(`/students/${student.studentId}/location-transfer/validate`, base());
      setCheck(result);
      setPicked(new Set(result.destinationSubjects.filter((s) => s.isMandatory || s.carriedOver).map((s) => s.subjectOfferingId)));
    } catch (err) {
      setError(messageFor(err));
    } finally {
      setChecking(false);
    }
  };

  const confirm = async () => {
    setError(null);
    if (!reason.trim()) return setError('Write a short reason, for example “Family moved to Chandigarh”.');
    try {
      const result = await move.mutateAsync({ ...base(), reason: reason.trim(), ...(check?.subjectMappingRequired ? { subjectOfferingIds: [...picked] } : {}) });
      toast.success(`Moved to ${check?.to.locationName ?? 'the new campus'}. The admission number stays ${student.admissionNumber ?? 'the same'}.`);
      for (const w of result.warnings) toast.warning(w);
      if (result.choicePending) toast.warning('Some subject choices are still open. Pick them on the Class & Subjects tab.');
      onClose();
    } catch (err) {
      setError(messageFor(err));
    }
  };

  const toggle = (id: string) => setPicked((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  return (
    <Drawer open onOpenChange={(open) => !open && onClose()}>
      <DrawerContent title="Move to another campus" description={`${student.fullName} keeps the same admission number and parents.`}>
        <DrawerBody className="space-y-4">
          <Alert tone="info">
            <span className="flex items-center gap-1.5">
              Now in {enrollment.className} at {enrollment.locationName}. <InfoTip label="What a campus move does">{MOVE_CAMPUS_HELP}</InfoTip>
            </span>
          </Alert>
          <ComboboxField
            label="New campus"
            required
            value={toLocationId}
            onChange={(v) => {
              setLocation(v);
              setClass('');
              setSection('');
              reset();
            }}
            options={campuses.map((l) => ({ value: l.locationId, label: l.displayName, hint: l.locationCode }))}
            placeholder="Choose…"
            searchPlaceholder="Search campuses…"
            hint={campuses.length === 0 ? 'There is no other campus. Add one in School Setup.' : undefined}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <ComboboxField
              label="Class at the new campus"
              required
              value={classOfferingId}
              onChange={(v) => {
                setClass(v);
                setSection('');
                reset();
              }}
              options={(classes.data ?? []).filter((c) => c.status === 'ACTIVE').map((c) => ({ value: c.classOfferingId, label: c.displayName, hint: c.displayCode }))}
              placeholder="Choose…"
              searchPlaceholder="Search classes…"
              hint={toLocationId && classes.data && classes.data.length === 0 ? 'No classes at this campus this year. Add them in Academic Setup.' : undefined}
            />
            <ComboboxField
              label="Section"
              value={sectionId}
              onChange={(v) => {
                setSection(v);
                reset();
              }}
              options={[{ value: '', label: 'Choose later' }, ...(sections.data ?? []).filter((s) => s.status === 'ACTIVE').map((s) => ({ value: s.sectionOfferingId, label: s.displayName, hint: s.capacity ? `${s.capacity} seats` : undefined }))]}
              searchPlaceholder="Search sections…"
              hint="Optional."
            />
          </div>
          <TextField label="Move date" type="date" required value={effectiveDate} onChange={(e) => { setDate(e.target.value); reset(); }} hint="The old campus ends the day before." />

          {check && (
            <section aria-label="Check result" className="space-y-3 rounded-xl border border-line p-4">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold">
                {check.from.className} · {check.from.locationName}
                <ArrowRight className="size-4 text-muted" aria-label="to" />
                {check.to.className}
                {check.to.sectionLabel ? `-${check.to.sectionLabel}` : ''} · {check.to.locationName}
              </p>
              {check.problems.map((p) => (
                <Alert key={p} tone="danger">
                  {p}
                </Alert>
              ))}
              {check.warnings.map((w) => (
                <Alert key={w} tone="warning">
                  {w}
                </Alert>
              ))}
              {check.boardChanged && (
                <Alert tone="warning" title="Different board">
                  {check.from.boardName ?? 'The old board'} → {check.to.boardName ?? 'the new board'}. Subjects are not copied. Tick the subjects for the new class below.
                </Alert>
              )}
              {check.subjectMappingRequired ? (
                <fieldset className="space-y-1" aria-label="Subjects at the new campus">
                  <legend className="mb-1 text-sm font-bold">Subjects at the new campus</legend>
                  {check.destinationSubjects.map((s) => (
                    <label key={s.subjectOfferingId} className="flex min-h-9 items-center gap-2 rounded-lg px-2 text-sm hover:bg-canvas">
                      <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={picked.has(s.subjectOfferingId)} disabled={s.isMandatory} onChange={() => toggle(s.subjectOfferingId)} />
                      {s.subjectName}
                      {s.isMandatory && <Badge tone="neutral">Required</Badge>}
                    </label>
                  ))}
                </fieldset>
              ) : (
                check.canTransfer && (
                  <p className="text-sm text-muted">
                    Same board: {check.destinationSubjects.filter((s) => s.carriedOver).length} subjects carry over, and the required subjects of the new class are added.
                  </p>
                )
              )}
              {check.canTransfer && <TextareaField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: Family moved to Chandigarh." className="min-h-20" />}
            </section>
          )}
          {error && <Alert tone="danger">{error}</Alert>}
        </DrawerBody>
        <DrawerFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          {check?.canTransfer ? (
            <Button onClick={() => void confirm()} loading={move.isPending} loadingText="Moving…">
              <MapPinned /> Move Student
            </Button>
          ) : (
            <Button onClick={() => void runCheck()} loading={checking} loadingText="Checking…">
              Check The Move
            </Button>
          )}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

// ───────────────────────────────────────────────────────────── withdrawal

/** Start Withdrawal: leaving date, reason, new school, whether a TC is needed. Says plainly what will happen on the leaving date. */
export function StartWithdrawalDialog({ student, onClose }: { student: StudentAdminProfileDTO; onClose: () => void }) {
  const [leavingDate, setDate] = useState(todayIso());
  const [reasonCategory, setReason] = useState<WithdrawalReasonCategory | ''>('');
  const [destinationSchool, setSchool] = useState('');
  const [note, setNote] = useState('');
  const [needsTC, setNeedsTC] = useState(true);
  const start = useStudentMutation((body: object) => api.post<WithdrawalDTO>(`/students/${student.studentId}/withdrawal`, body), { quiet: true, success: 'Withdrawal started.' });
  const future = leavingDate > todayIso();

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<DoorOpen className="size-5" />}
      title={`Start withdrawal for ${student.fullName}?`}
      description={
        <span className="flex items-start gap-1.5">
          <span>
            Leaving date {leavingDate ? formatDateOnly(leavingDate) : '—'}. {future ? 'The student stays in class until then. ' : ''}On that day the class and section close and parent access ends. History is kept.
          </span>
          <InfoTip label="About withdrawal">{WITHDRAWAL_HELP}</InfoTip>
        </span>
      }
      confirmLabel="Start Withdrawal"
      loadingLabel="Starting…"
      onConfirm={async () => {
        if (!leavingDate) throw new FormProblem('Choose the leaving date.');
        if (!reasonCategory) throw new FormProblem('Choose why the student is leaving.');
        await start.mutateAsync({ leavingDate, reasonCategory, needsTC, ...(destinationSchool.trim() ? { destinationSchool: destinationSchool.trim() } : {}), ...(note.trim() ? { note: note.trim() } : {}) });
      }}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField label="Leaving date" type="date" required value={leavingDate} onChange={(e) => setDate(e.target.value)} />
          <ComboboxField
            label="Reason"
            required
            value={reasonCategory}
            onChange={(v) => setReason(v as WithdrawalReasonCategory)}
            options={WITHDRAWAL_REASON_CATEGORIES.map((r) => ({ value: r, label: WITHDRAWAL_REASON_LABELS[r] }))}
            placeholder="Choose…"
            searchPlaceholder="Search reasons…"
          />
        </div>
        <TextField label="New school" value={destinationSchool} onChange={(e) => setSchool(e.target.value)} hint="Optional. Example: Delhi Public School, Gurugram." maxLength={120} />
        <TextField label="Note" value={note} onChange={(e) => setNote(e.target.value)} hint="Optional." maxLength={500} />
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={needsTC} onChange={(e) => setNeedsTC(e.target.checked)} />
          The parent needs a transfer certificate
        </label>
      </div>
    </ConfirmDialog>
  );
}

// ───────────────────────────────────────────────────────────── readmission

function ConfirmGuardians({ result, onClose }: { result: ReadmissionResultDTO; onClose: () => void }) {
  const [done, setDone] = useState<Record<string, 'kept' | 'ended'>>({});
  const end = useStudentMutation((link: GuardianLinkDTO) => api.post(`/guardian-links/${link.guardianLinkId}/end`, {}), { success: 'Parent unlinked. The old link stays in History.' });
  const open = result.guardiansToConfirm.filter((g) => !done[g.guardianLinkId]);
  return (
    <Drawer open onOpenChange={(o) => !o && onClose()}>
      <DrawerContent title="Confirm the parents" description={`Admission number ${result.admissionNumber}${result.admissionNumberPolicy === 'KEEP_OLD' ? ' (the old one is kept)' : ' (a new one was given)'}.`}>
        <DrawerBody className="space-y-4">
          <Alert tone="success" title={`${result.student.fullName} is back`}>
            Same student record and history. Check that these parents are still right.
          </Alert>
          {result.guardiansToConfirm.length === 0 ? (
            <p className="text-sm text-muted">No parent is linked. Add one on the Parents &amp; Guardians tab.</p>
          ) : (
            <ul className="space-y-3" aria-label="Parents to confirm">
              {result.guardiansToConfirm.map((g) => (
                <li key={g.guardianLinkId} className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{g.fullName}</p>
                    <p className="text-[13px] text-muted">{g.relationshipType}{g.isPrimary ? ' · Primary' : ''}</p>
                  </div>
                  {done[g.guardianLinkId] ? (
                    <Badge tone={done[g.guardianLinkId] === 'kept' ? 'success' : 'neutral'}>{done[g.guardianLinkId] === 'kept' ? 'Kept' : 'Unlinked'}</Badge>
                  ) : (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setDone((d) => ({ ...d, [g.guardianLinkId]: 'kept' }))} aria-label={`Keep ${g.fullName}`}>
                        <UserCheck /> Keep
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        loading={end.isPending && end.variables?.guardianLinkId === g.guardianLinkId}
                        loadingText="Unlinking…"
                        onClick={() => end.mutate(g, { onSuccess: () => setDone((d) => ({ ...d, [g.guardianLinkId]: 'ended' })) })}
                        aria-label={`Unlink ${g.fullName}`}
                      >
                        <UserMinus /> Unlink
                      </Button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </DrawerBody>
        <DrawerFooter>
          <Button onClick={onClose} disabled={open.length > 0} title={open.length > 0 ? 'Keep or unlink each parent first' : undefined}>
            Done
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

/** Re-admit a student who left: same student and history, a new class for the chosen year, then confirm the parents. */
export function ReadmitDialog({ student, onClose }: { student: StudentAdminProfileDTO; onClose: () => void }) {
  const ctx = useStudentContext();
  const settings = useAdmissionSettings();
  const [sessionId, setSession] = useState(ctx.sessionId ?? '');
  const [locationId, setLocation] = useState(ctx.locationId ?? '');
  const [classOfferingId, setClass] = useState('');
  const [sectionId, setSection] = useState('');
  const [policy, setPolicy] = useState<'' | 'KEEP_OLD' | 'ISSUE_NEW'>('');
  const [number, setNumber] = useState('');
  const [result, setResult] = useState<ReadmissionResultDTO | null>(null);
  // After a successful re-admission the dialog closes into the parents step, not back to the page.
  const readmitted = useRef(false);
  const classes = useClassOfferings(sessionId || undefined, locationId || undefined);
  const sections = useSections(classOfferingId || undefined);
  const readmit = useStudentMutation((body: object) => api.post<ReadmissionResultDTO>(`/students/${student.studentId}/readmit`, body), { quiet: true });
  const chosenPolicy = policy || settings.data?.readmissionPolicy || 'KEEP_OLD';
  const manualNew = chosenPolicy === 'ISSUE_NEW' && settings.data?.mode === 'MANUAL';

  if (result) return <ConfirmGuardians result={result} onClose={onClose} />;

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && !readmitted.current && onClose()}
      icon={<UserRoundPlus className="size-5" />}
      title={`Re-admit ${student.fullName}?`}
      description={
        <span className="flex items-start gap-1.5">
          <span>We use the same student record and history. You will confirm the parents next.</span>
          <InfoTip label="About re-admission">{READMIT_HELP}</InfoTip>
        </span>
      }
      confirmLabel="Re-admit Student"
      loadingLabel="Re-admitting…"
      onConfirm={async () => {
        if (!sessionId || !locationId) throw new FormProblem('Choose the school year and campus.');
        if (!classOfferingId) throw new FormProblem('Choose a class.');
        if (manualNew && !number.trim()) throw new FormProblem('Enter the new admission number.');
        const r = await readmit.mutateAsync({ academicSessionId: sessionId, locationId, classOfferingId, admissionNumberPolicy: chosenPolicy, ...(sectionId ? { sectionId } : {}), ...(manualNew ? { admissionNumber: number.trim() } : {}) });
        readmitted.current = true;
        setResult(r);
      }}
    >
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <ComboboxField label="School year" required value={sessionId} onChange={(v) => { setSession(v); setClass(''); setSection(''); }} options={ctx.sessions.map((s) => ({ value: s.academicSessionId, label: s.code || s.name, hint: s.isCurrent ? 'Current' : undefined }))} searchPlaceholder="Search years…" />
          <ComboboxField label="Campus" required value={locationId} onChange={(v) => { setLocation(v); setClass(''); setSection(''); }} options={ctx.locations.map((l) => ({ value: l.locationId, label: l.displayName, hint: l.locationCode }))} searchPlaceholder="Search campuses…" />
          <ComboboxField label="Class" required value={classOfferingId} onChange={(v) => { setClass(v); setSection(''); }} options={(classes.data ?? []).filter((c) => c.status === 'ACTIVE').map((c) => ({ value: c.classOfferingId, label: c.displayName, hint: c.displayCode }))} placeholder="Choose…" searchPlaceholder="Search classes…" />
          <ComboboxField label="Section" value={sectionId} onChange={setSection} options={[{ value: '', label: 'Choose later' }, ...(sections.data ?? []).filter((s) => s.status === 'ACTIVE').map((s) => ({ value: s.sectionOfferingId, label: s.displayName }))]} searchPlaceholder="Search sections…" hint="Optional." />
        </div>
        <ComboboxField
          label="Admission number"
          value={chosenPolicy}
          onChange={(v) => setPolicy(v as 'KEEP_OLD' | 'ISSUE_NEW')}
          options={[
            { value: 'KEEP_OLD', label: `Keep ${student.admissionNumber ?? 'the old number'}`, hint: settings.data?.readmissionPolicy === 'KEEP_OLD' ? 'School rule' : undefined },
            { value: 'ISSUE_NEW', label: 'Give a new number', hint: settings.data?.readmissionPolicy === 'ISSUE_NEW' ? 'School rule' : undefined },
          ]}
          searchPlaceholder="Search…"
        />
        {manualNew && <TextField label="New admission number" required value={number} onChange={(e) => setNumber(e.target.value.toUpperCase())} />}
      </div>
    </ConfirmDialog>
  );
}
