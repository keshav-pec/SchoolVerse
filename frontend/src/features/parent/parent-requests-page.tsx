import { useState } from 'react';
import { STUDENT_CHANGE_FIELDS, STUDENT_CHANGE_FIELD_LABELS, type StudentChangeField, type StudentChangeRequestDTO } from '@shared';
import { ArrowRight, Inbox, Send } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { RequestStatusBadge } from '@/components/sv/change-requests';
import { useOwnRequests, useParentMutation } from './api';
import { useChildSelection } from './parent-layout';

const FIELD_HINTS: Record<StudentChangeField, string> = {
  LEGAL_NAME: 'A spelling mistake in your child’s name.',
  DATE_OF_BIRTH: 'A wrong date of birth.',
  GUARDIAN_CONTACT: 'Your new phone number or email.',
};

function AskForAChange() {
  const { children, selectedId } = useChildSelection();
  const [studentId, setStudentId] = useState('');
  const [field, setField] = useState<StudentChangeField>('LEGAL_NAME');
  const [first, setFirst] = useState('');
  const [middle, setMiddle] = useState('');
  const [last, setLast] = useState('');
  const [dob, setDob] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const child = studentId || selectedId || '';
  const send = useParentMutation((body: object) => api.post<StudentChangeRequestDTO>(`/parent/children/${child}/change-requests`, body), { quiet: true, success: 'Request sent. The school will look at it.' });

  const valueFor = (): object | string => {
    if (field === 'LEGAL_NAME') return first.trim() ? { legalFirstName: first.trim(), legalMiddleName: middle.trim() || undefined, legalLastName: last.trim() } : 'Enter the first name as it should be.';
    if (field === 'DATE_OF_BIRTH') return dob ? { dateOfBirth: dob } : 'Choose the correct date of birth.';
    return phone.trim() || email.trim() ? { ...(phone.trim() ? { phone: phone.trim() } : {}), ...(email.trim() ? { email: email.trim() } : {}) } : 'Enter a new phone number or email.';
  };

  const submit = async () => {
    setError(null);
    if (!child) return setError('Choose your child.');
    const value = valueFor();
    if (typeof value === 'string') return setError(value);
    try {
      await send.mutateAsync({ field, value, ...(reason.trim() ? { reason: reason.trim() } : {}) });
      setFirst('');
      setMiddle('');
      setLast('');
      setDob('');
      setPhone('');
      setEmail('');
      setReason('');
    } catch (err) {
      setError(messageFor(err));
    }
  };

  return (
    <form
      className="space-y-4 rounded-card border border-line bg-white p-4 shadow-card"
      aria-label="Ask for a change"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div>
        <h2 className="text-lg font-bold">Ask for a change</h2>
        <p className="text-sm text-muted">The school checks every request before anything changes.</p>
      </div>
      {children.length > 1 && (
        <ComboboxField label="Child" value={child} onChange={setStudentId} options={children.map((c) => ({ value: c.studentId, label: c.displayName || c.fullName, hint: c.classSection?.label }))} searchPlaceholder="Search…" />
      )}
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">What is wrong?</legend>
        <div className="grid gap-2" role="radiogroup">
          {STUDENT_CHANGE_FIELDS.map((f) => (
            <label key={f} className={cn('flex min-h-12 cursor-pointer items-center gap-3 rounded-xl border px-3 py-2', field === f ? 'border-brand bg-brand-soft' : 'border-line')}>
              <input type="radio" name="change-field" value={f} checked={field === f} onChange={() => setField(f)} className="size-5 accent-[var(--color-brand)]" />
              <span>
                <span className="block text-sm font-bold">{STUDENT_CHANGE_FIELD_LABELS[f]}</span>
                <span className="block text-xs text-muted">{FIELD_HINTS[f]}</span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {field === 'LEGAL_NAME' && (
        <div className="grid gap-3 sm:grid-cols-3">
          <TextField label="First name" required value={first} onChange={(e) => setFirst(e.target.value)} />
          <TextField label="Middle name" hint="Optional." value={middle} onChange={(e) => setMiddle(e.target.value)} />
          <TextField label="Last name" value={last} onChange={(e) => setLast(e.target.value)} />
        </div>
      )}
      {field === 'DATE_OF_BIRTH' && <TextField label="Correct date of birth" type="date" required value={dob} onChange={(e) => setDob(e.target.value)} />}
      {field === 'GUARDIAN_CONTACT' && (
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="New phone number" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} hint="Example: +91 98765 43210" />
          <TextField label="New email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} hint="Optional." />
        </div>
      )}
      <TextField label="Why?" hint="Optional. Example: The name is spelled wrong on the ID card." value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
      {error && <Alert tone="danger">{error}</Alert>}
      <Button type="submit" className="min-h-12 w-full sm:w-auto" loading={send.isPending} loadingText="Sending…">
        <Send /> Send Request
      </Button>
    </form>
  );
}

/** `/parent/requests`: ask the school to correct a name, a date of birth or your contact, and see what happened to earlier requests. */
export function ParentRequestsPage() {
  const q = useOwnRequests();
  const cancel = useParentMutation((id: string) => api.post(`/parent/change-requests/${id}/cancel`), { success: 'Request cancelled.' });
  const items = q.data ?? [];
  return (
    <div className="max-w-3xl space-y-4">
      <h1 className="text-[22px] font-extrabold">Requests</h1>
      <AskForAChange />
      <section aria-label="Earlier requests" className="rounded-card border border-line bg-white shadow-card">
        <h2 className="border-b border-line px-4 py-3 text-base font-bold">Earlier requests</h2>
        {q.isLoading ? (
          <Skeleton className="m-4 h-16" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : items.length === 0 ? (
          <EmptyState illustration={<Inbox className="size-10 text-muted" aria-hidden="true" />} title="No requests yet" />
        ) : (
          <ul className="divide-y divide-line">
            {items.map((r) => (
              <li key={r.changeRequestId} className="space-y-1.5 px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1 text-sm font-semibold">
                    {r.fieldLabel} · {r.studentName}
                  </span>
                  <RequestStatusBadge status={r.status} />
                </div>
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted">{r.oldValue || 'Not on file'}</span>
                  <ArrowRight className="size-4 text-muted" aria-label="change to" />
                  <span className="font-semibold">{r.newValue}</span>
                </p>
                <p className="text-xs text-muted">Sent {formatDateTime(r.createdAt)}</p>
                {r.status === 'REJECTED' && r.decisionNote && <p className="text-sm">School’s note: {r.decisionNote}</p>}
                {r.status === 'APPROVED' && <p className="text-sm text-success">The school made this change.</p>}
                {r.status === 'PENDING' && (
                  <Button size="sm" variant="ghost" className="min-h-11" onClick={() => cancel.mutate(r.changeRequestId)}>
                    Cancel Request
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
