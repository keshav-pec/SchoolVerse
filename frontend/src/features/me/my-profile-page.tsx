import { useState } from 'react';
import {
  CHANGE_FIELD_LABELS,
  EMPLOYEE_CATEGORY_LABELS,
  GOVERNMENT_ID_LABELS,
  ROLE_LABELS,
  type ChangeFieldCategory,
  type ProfileChangeRequestDTO,
  type SelfProfileDTO,
} from '@shared';
import { ACADEMIC_ASSIGNMENT_TYPE_LABELS } from '@shared';
import {
  Banknote,
  CalendarHeart,
  Fingerprint,
  IdCard,
  KeyRound,
  MailCheck,
  Pencil,
  Save,
  ShieldCheck,
  X,
} from 'lucide-react';
import { toast } from 'sonner';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { AssignmentStatusChip, EmployeeStatusPill } from '@/components/sv/employee-status';
import { ErrorState } from '@/components/sv/error-state';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { PageHeader } from '@/components/sv/page-header';
import { RoleBadge } from '@/components/sv/role-badge';
import { api, ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatDateOnly, formatDateTime, formatPhone } from '@/lib/format';
import { countryOptions } from '@/lib/options';
import { DevOutboxHint } from '../auth/dev-outbox-hint';
import { useOwnDocuments, useOwnRequests, usePeopleMutation, useSelfProfile } from '../people/api';
import { DocumentsPanel } from '../people/documents-panel';
import { RequestStatusBadge } from '../people/requests-page';
import { addressLine } from '../people/tabs/contact-tab';
import { RequestChangeDialog } from './request-change-dialog';

const CHANGE_ICONS = {
  LEGAL_NAME: IdCard,
  DATE_OF_BIRTH: CalendarHeart,
  GOVERNMENT_ID: Fingerprint,
  BANK_DETAILS: Banknote,
} as const;
const CATEGORIES: ChangeFieldCategory[] = [
  'LEGAL_NAME',
  'DATE_OF_BIRTH',
  'GOVERNMENT_ID',
  'BANK_DETAILS',
];

/** The details an employee can change directly: no approval needed, every change is recorded. */
function EditDetails({ me, onClose }: { me: SelfProfileDTO; onClose: () => void }) {
  const personal = me.profile.personal;
  const initial = {
    preferredName: me.profile.preferredName ?? '',
    personalEmail: personal?.personalEmail ?? '',
    personalPhone: personal?.personalPhone ?? '',
    line1: personal?.address?.line1 ?? '',
    line2: personal?.address?.line2 ?? '',
    city: personal?.address?.city ?? '',
    state: personal?.address?.state ?? '',
    postalCode: personal?.address?.postalCode ?? '',
    country: personal?.address?.country ?? 'IN',
    ecName: personal?.emergencyContact?.name ?? '',
    ecRelation: personal?.emergencyContact?.relation ?? '',
    ecPhone: personal?.emergencyContact?.phone ?? '',
  };
  const [v, setV] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const save = usePeopleMutation(
    (patch: object) => api.patch<SelfProfileDTO>('/me/profile', patch),
    { quiet: true, success: 'Your details are saved.' },
  );
  const set = (key: keyof typeof initial) => (e: { target: { value: string } }) =>
    setV((x) => ({ ...x, [key]: e.target.value }));

  const submit = async () => {
    setErrors({});
    setFormError(null);
    const patch: Record<string, unknown> = {};
    if (v.preferredName !== initial.preferredName) patch.preferredName = v.preferredName;
    if (v.personalEmail !== initial.personalEmail) patch.personalEmail = v.personalEmail;
    if (v.personalPhone !== initial.personalPhone) patch.personalPhone = v.personalPhone;
    const addressKeys = ['line1', 'line2', 'city', 'state', 'postalCode', 'country'] as const;
    if (addressKeys.some((k) => v[k] !== initial[k])) {
      patch.address = addressKeys.every((k) => k === 'country' || !v[k].trim())
        ? null
        : Object.fromEntries(addressKeys.map((k) => [k, v[k].trim()]));
    }
    if (
      v.ecName !== initial.ecName ||
      v.ecRelation !== initial.ecRelation ||
      v.ecPhone !== initial.ecPhone
    ) {
      const any = v.ecName.trim() || v.ecRelation.trim() || v.ecPhone.trim();
      patch.emergencyContact = any
        ? { name: v.ecName.trim(), relation: v.ecRelation.trim(), phone: v.ecPhone.trim() }
        : null;
    }
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
    <form
      className="space-y-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {formError && <Alert tone="danger">{formError}</Alert>}
      <TextField
        label="Preferred name"
        value={v.preferredName}
        onChange={set('preferredName')}
        error={errors.preferredName}
      />
      <div className="grid gap-5 sm:grid-cols-2">
        <TextField
          label="Personal email"
          type="email"
          value={v.personalEmail}
          onChange={set('personalEmail')}
          error={errors.personalEmail}
        />
        <TextField
          label="Personal phone"
          type="tel"
          value={v.personalPhone}
          onChange={set('personalPhone')}
          error={errors.personalPhone}
        />
      </div>
      <fieldset className="space-y-4">
        <legend className="mb-1 text-sm font-bold">Address</legend>
        <TextField
          label="Address line 1"
          value={v.line1}
          onChange={set('line1')}
          error={errors['address.line1']}
        />
        <TextField
          label="Address line 2"
          value={v.line2}
          onChange={set('line2')}
          error={errors['address.line2']}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="City"
            value={v.city}
            onChange={set('city')}
            error={errors['address.city']}
          />
          <TextField
            label="State"
            value={v.state}
            onChange={set('state')}
            error={errors['address.state']}
          />
          <TextField
            label="Postal code"
            value={v.postalCode}
            onChange={set('postalCode')}
            error={errors['address.postalCode']}
          />
          <ComboboxField
            label="Country"
            value={v.country}
            onChange={(country) => setV((x) => ({ ...x, country }))}
            options={countryOptions()}
            searchPlaceholder="Search countries…"
            error={errors['address.country']}
          />
        </div>
      </fieldset>
      <fieldset className="space-y-4">
        <legend className="mb-1 text-sm font-bold">Emergency contact</legend>
        <div className="grid gap-4 sm:grid-cols-3">
          <TextField
            label="Name"
            value={v.ecName}
            onChange={set('ecName')}
            error={errors['emergencyContact.name']}
          />
          <TextField
            label="Relation"
            value={v.ecRelation}
            onChange={set('ecRelation')}
            error={errors['emergencyContact.relation']}
          />
          <TextField
            label="Phone"
            type="tel"
            value={v.ecPhone}
            onChange={set('ecPhone')}
            error={errors['emergencyContact.phone']}
          />
        </div>
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" loading={save.isPending} loadingText="Saving…">
          <Save /> Save
        </Button>
        <Button type="button" variant="outline" onClick={onClose} disabled={save.isPending}>
          <X /> Cancel
        </Button>
      </div>
    </form>
  );
}

function RequestRow({
  r,
  onCancel,
  cancelling,
}: {
  r: ProfileChangeRequestDTO;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-semibold">
          {CHANGE_FIELD_LABELS[r.fieldCategory]}{' '}
          <span className="font-normal text-muted">→ {r.proposedDisplay}</span>
        </p>
        <p className="text-[13px] text-muted">
          Asked {formatDateTime(r.requestedAt)}
          {r.decidedAt && r.status !== 'PENDING'
            ? ` · ${r.status.toLowerCase()} ${formatDateTime(r.decidedAt)}`
            : ''}
          {r.decisionNote ? ` · “${r.decisionNote}”` : ''}
        </p>
      </div>
      <RequestStatusBadge status={r.status} />
      {r.status === 'PENDING' && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onCancel}
          loading={cancelling}
          loadingText="Cancelling…"
          aria-label={`Cancel request for ${CHANGE_FIELD_LABELS[r.fieldCategory]}`}
        >
          Cancel
        </Button>
      )}
    </li>
  );
}

/** `/me`: your own record. Low-risk details you can edit; the rest you ask to change. */
export function MyProfilePage() {
  const q = useSelfProfile();
  const requests = useOwnRequests(q.isSuccess);
  const documents = useOwnDocuments(q.isSuccess);
  const [editing, setEditing] = useState(false);
  const [requesting, setRequesting] = useState<ChangeFieldCategory | null>(null);
  const cancel = usePeopleMutation(
    (id: string) => api.post(`/me/profile-change-requests/${id}/cancel`),
    { success: 'Request cancelled.' },
  );
  const reset = usePeopleMutation((email: string) => api.post('/auth/forgot-password', { email }), {
    quiet: true,
  });

  if (q.isLoading) {
    return (
      <div role="status" aria-label="Loading your profile" className="space-y-4">
        <Skeleton className="h-24 rounded-card" />
        <Skeleton className="h-64 rounded-card" />
      </div>
    );
  }
  if (q.isError || !q.data) {
    if (q.error instanceof ApiError && q.error.code === 'NO_EMPLOYEE_PROFILE') {
      return (
        <ErrorState
          error={
            new ApiError(
              404,
              'NO_EMPLOYEE_PROFILE',
              'Your login is not linked to an employee profile. Ask your School Admin if you expected to see one here.',
            )
          }
        />
      );
    }
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  }

  const me = q.data;
  const p = me.profile;
  const personal = p.personal;
  const all = requests.data ?? [];
  const pendingBy = new Map(
    all.filter((r) => r.status === 'PENDING').map((r) => [r.fieldCategory, r]),
  );

  const sendReset = async () => {
    try {
      await reset.mutateAsync(me.account.email);
      toast.success('If that works, a reset link is on its way to your email.');
    } catch (err) {
      toast.error(messageFor(err));
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Me"
        title="My profile"
        description="Your own record. You can keep your contact details up to date; other changes are checked by a School Admin first."
      />

      <header className="mb-4 flex flex-col gap-3 rounded-card border border-line bg-white p-4 shadow-card sm:flex-row sm:items-center sm:gap-4 sm:px-5">
        <Avatar name={p.fullName} className="size-12 text-lg" />
        <div className="min-w-0 flex-1">
          <h2 className="text-[22px] leading-tight font-extrabold break-words">{p.fullName}</h2>
          <p className="mt-1 text-sm text-muted">
            <span className="font-mono font-semibold text-ink">{p.employeeCode}</span> ·{' '}
            {p.designation.name} · {p.department.name} ·{' '}
            {EMPLOYEE_CATEGORY_LABELS[p.employeeCategory]}
          </p>
          <div className="mt-2.5">
            <EmployeeStatusPill status={p.status} />
          </div>
        </div>
      </header>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Your details</CardTitle>
              <CardDescription>
                Only you and the administrators who may see personal details can see these.
              </CardDescription>
            </div>
            {!editing && (
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
                <Pencil /> Edit
              </Button>
            )}
          </CardHeader>
          {editing ? (
            <EditDetails me={me} onClose={() => setEditing(false)} />
          ) : (
            <InfoGrid>
              <InfoItem label="Legal name">{p.fullName}</InfoItem>
              <InfoItem label="Preferred name">{p.preferredName}</InfoItem>
              <InfoItem label="Date of birth">
                {me.dateOfBirth ? formatDateOnly(me.dateOfBirth) : null}
              </InfoItem>
              <InfoItem label="Official email">{p.officialEmail}</InfoItem>
              <InfoItem label="Official phone">
                {p.officialPhone ? formatPhone(p.officialPhone) : null}
              </InfoItem>
              <InfoItem label="Joined">{formatDateOnly(p.joiningDate)}</InfoItem>
              <InfoItem label="Personal email">{personal?.personalEmail}</InfoItem>
              <InfoItem label="Personal phone">
                {personal?.personalPhone ? formatPhone(personal.personalPhone) : null}
              </InfoItem>
              <InfoItem label="Emergency contact">
                {personal?.emergencyContact
                  ? `${personal.emergencyContact.name} (${personal.emergencyContact.relation}), ${formatPhone(personal.emergencyContact.phone)}`
                  : null}
              </InfoItem>
              <InfoItem label="Address" className="sm:col-span-2 lg:col-span-3">
                {personal?.address ? addressLine(personal.address) : null}
              </InfoItem>
            </InfoGrid>
          )}
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <ShieldCheck className="size-5 text-brand" aria-hidden="true" /> Protected details
              </CardTitle>
              <CardDescription>
                Shown masked. To change one, send a request; a School Admin approves it.
              </CardDescription>
            </div>
          </CardHeader>
          <dl className="mb-5 grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
            {me.restricted.governmentIds.map((g) => (
              <div key={g.type}>
                <dt className="text-[13px] text-muted">{GOVERNMENT_ID_LABELS[g.type]}</dt>
                <dd className="font-mono font-semibold">{g.masked}</dd>
              </div>
            ))}
            {me.restricted.bank && (
              <div>
                <dt className="text-[13px] text-muted">Bank account</dt>
                <dd className="font-semibold">
                  {me.restricted.bank.bankName}{' '}
                  <span className="font-mono">{me.restricted.bank.accountNumberMasked}</span>
                </dd>
              </div>
            )}
            {me.restricted.governmentIds.length === 0 && !me.restricted.bank && (
              <p className="text-muted sm:col-span-2">Nothing on file yet.</p>
            )}
          </dl>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Request a change">
            {CATEGORIES.map((c) => {
              const Icon = CHANGE_ICONS[c];
              const pending = pendingBy.has(c);
              return (
                <Button
                  key={c}
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => setRequesting(c)}
                  aria-label={`Request change: ${CHANGE_FIELD_LABELS[c]}`}
                >
                  <Icon /> {CHANGE_FIELD_LABELS[c]}
                  {pending && <span className="text-xs font-normal text-muted">· pending</span>}
                </Button>
              );
            })}
          </div>

          {all.length > 0 && (
            <div className="mt-6">
              <h3 className="mb-1 text-sm font-bold">Your requests</h3>
              <ul className="divide-y divide-line" aria-label="Your change requests">
                {all.map((r) => (
                  <RequestRow
                    key={r.changeRequestId}
                    r={r}
                    onCancel={() => cancel.mutate(r.changeRequestId)}
                    cancelling={cancel.isPending && cancel.variables === r.changeRequestId}
                  />
                ))}
              </ul>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>My documents</CardTitle>
              <CardDescription>
                Upload what the school asks for. Only you and School Admins can open them.
              </CardDescription>
            </div>
          </CardHeader>
          <DocumentsPanel documents={documents} uploadPath="/me/documents" canDelete={false} />
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>My assignments</CardTitle>
              <CardDescription>Where you work and what you look after.</CardDescription>
            </div>
          </CardHeader>
          <div className="grid gap-6 lg:grid-cols-3">
            <div>
              <h3 className="mb-2 text-sm font-bold">Locations</h3>
              <ul className="space-y-2" aria-label="My locations">
                {me.locationAssignments
                  .filter((a) => a.status === 'ACTIVE' || a.status === 'PLANNED')
                  .map((a) => (
                    <li
                      key={a.locationAssignmentId}
                      className="flex flex-wrap items-center gap-2 text-sm"
                    >
                      <span className="font-semibold">{a.locationName}</span>
                      {a.isPrimary && <span className="text-xs text-muted">(primary)</span>}
                      <AssignmentStatusChip status={a.status} />
                    </li>
                  ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-2 text-sm font-bold">Classes</h3>
              {me.academicAssignments.filter((a) => a.status === 'ACTIVE' || a.status === 'PLANNED')
                .length === 0 ? (
                <p className="text-sm text-muted">None right now.</p>
              ) : (
                <ul className="space-y-2" aria-label="My classes">
                  {me.academicAssignments
                    .filter((a) => a.status === 'ACTIVE' || a.status === 'PLANNED')
                    .map((a) => (
                      <li key={a.academicAssignmentId} className="text-sm">
                        <span className="font-semibold">
                          {a.sectionName ? `${a.schoolClassName} · ${a.sectionName}` : a.schoolClassName}
                          {a.subjectName ? ` · ${a.subjectName}` : ''}
                        </span>
                        <span className="block text-[13px] text-muted">
                          {ACADEMIC_ASSIGNMENT_TYPE_LABELS[a.assignmentType]}
                        </span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="mb-2 text-sm font-bold">Responsibilities</h3>
              {me.responsibilities.filter((r) => r.status === 'ACTIVE' || r.status === 'PLANNED')
                .length === 0 ? (
                <p className="text-sm text-muted">None right now.</p>
              ) : (
                <ul className="space-y-2" aria-label="My responsibilities">
                  {me.responsibilities
                    .filter((r) => r.status === 'ACTIVE' || r.status === 'PLANNED')
                    .map((r) => (
                      <li key={r.responsibilityId} className="text-sm">
                        <span className="font-semibold">{r.responsibilityType}</span>
                        <span className="block text-[13px] text-muted">{r.locationName}</span>
                      </li>
                    ))}
                </ul>
              )}
            </div>
          </div>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <KeyRound className="size-5 text-brand" aria-hidden="true" /> Security
              </CardTitle>
              <CardDescription>How you sign in to SchoolVerse.</CardDescription>
            </div>
          </CardHeader>
          <InfoGrid>
            <InfoItem label="Sign-in email">{me.account.email}</InfoItem>
            <InfoItem label="Role">
              <RoleBadge role={me.account.role} />
            </InfoItem>
            <InfoItem label="Last signed in">
              {me.account.lastLoginAt ? formatDateTime(me.account.lastLoginAt) : null}
            </InfoItem>
          </InfoGrid>
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => void sendReset()}
              loading={reset.isPending}
              loadingText="Sending…"
            >
              <MailCheck /> Email Me A Password Reset Link
            </Button>
            <span className="text-[13px] text-muted">
              Your role is {ROLE_LABELS[me.account.role]}. Only a School Admin can change it.
            </span>
          </div>
          <DevOutboxHint email={me.account.email} />
        </Card>
      </div>

      {requesting && (
        <RequestChangeDialog
          category={requesting}
          profile={me}
          onClose={() => setRequesting(null)}
        />
      )}
    </>
  );
}
