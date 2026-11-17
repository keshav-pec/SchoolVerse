import { useState } from 'react';
import {
  PROVISIONABLE_ROLES,
  ROLE_LABELS,
  type EmployeeProfileDTO,
  type ProvisionableRole,
  type UserDTO,
} from '@shared';
import {
  CirclePlay,
  Info,
  KeyRound,
  Mail,
  PauseCircle,
  ShieldAlert,
  UserCog,
  UserPlus,
} from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { UserStatusPill } from '@/components/sv/employee-status';
import { ErrorState } from '@/components/sv/error-state';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { RoleBadge } from '@/components/sv/role-badge';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { FormProblem, messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { DevOutboxHint } from '../../auth/dev-outbox-hint';
import { useEmployeeAccount, usePeopleMutation } from '../api';

const ROLE_NOTE =
  'Designation doesn’t grant access. The role you choose here decides what this person can do.';

/** There is no password field anywhere here: the person chooses their own from a single-use link. */
function CreateLoginForm({
  employee,
  defaultEmail,
}: {
  employee: EmployeeProfileDTO;
  defaultEmail: string | null;
}) {
  const [email, setEmail] = useState(defaultEmail ?? '');
  const [role, setRole] = useState<ProvisionableRole>(
    employee.employeeCategory === 'FACULTY' ? 'FACULTY' : 'STAFF',
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const create = usePeopleMutation(
    (body: object) => api.post<UserDTO>(`/employees/${employee.employeeId}/user-account`, body),
    { quiet: true, success: 'Login created. An activation link has been sent.' },
  );

  const submit = async () => {
    setErrors({});
    setFormError(null);
    if (!email.trim())
      return setErrors({ email: 'Enter the email this person will sign in with.' });
    try {
      await create.mutateAsync({ email: email.trim(), role });
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors.email)
        setErrors({ email: err.fieldErrors.email });
      else setFormError(messageFor(err));
    }
  };

  return (
    <form
      className="max-w-xl space-y-5"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <Alert tone="info" title="No login yet">
        {employee.displayName} is on the staff list but cannot sign in. Not every employee needs a
        login.
      </Alert>
      {formError && <Alert tone="danger">{formError}</Alert>}
      <TextField
        label="Sign-in email"
        type="email"
        required
        autoComplete="off"
        hint="Defaults to the official email. The activation link is sent here."
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
      />
      <SelectField
        label="Role"
        required
        hint={ROLE_NOTE}
        value={role}
        onChange={(e) => setRole(e.target.value as ProvisionableRole)}
      >
        {PROVISIONABLE_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </SelectField>
      <p className="flex items-start gap-2 text-[13px] text-muted">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> You won’t set or see a
        password. {employee.displayName} gets a single-use link that works for 72 hours and chooses
        their own.
      </p>
      <Button type="submit" loading={create.isPending} loadingText="Creating…">
        <UserPlus /> Create login
      </Button>
    </form>
  );
}

function SuspendDialog({ user, onClose }: { user: UserDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const suspend = usePeopleMutation(
    (body: object) => api.post(`/users/${user.userId}/suspend`, body),
    { quiet: true, success: 'Account suspended. They have been signed out.' },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone="danger"
      icon={<PauseCircle className="size-5" />}
      title="Suspend this account?"
      description="They are signed out everywhere at once and cannot sign in until you reactivate the account. Their employee record is not changed."
      confirmLabel="Suspend account"
      loadingLabel="Suspending…"
      onConfirm={async () => {
        if (!reason.trim()) throw new FormProblem('Give a reason. It is kept in the history.');
        await suspend.mutateAsync({ reason: reason.trim() });
      }}
    >
      <TextField
        label="Reason"
        required
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={300}
      />
    </ConfirmDialog>
  );
}

function DisableDialog({ user, onClose }: { user: UserDTO; onClose: () => void }) {
  const disable = usePeopleMutation((_: void) => api.post(`/users/${user.userId}/disable`), {
    quiet: true,
    success: 'Account disabled.',
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone="danger"
      icon={<ShieldAlert className="size-5" />}
      title="Disable this account?"
      description="Access ends for good and they are signed out now. The role stays on record for history. To give them access again later, create a new login."
      confirmLabel="Disable account"
      loadingLabel="Disabling…"
      onConfirm={async () => {
        await disable.mutateAsync();
      }}
    />
  );
}

function RoleDialog({ user, onClose }: { user: UserDTO; onClose: () => void }) {
  const [role, setRole] = useState<ProvisionableRole>(
    user.role === 'PARENT' ? 'STAFF' : (user.role as ProvisionableRole),
  );
  const change = usePeopleMutation(
    (body: object) => api.patch(`/users/${user.userId}/role`, body),
    { quiet: true, success: 'Role changed. They have been signed out so it takes effect.' },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<UserCog className="size-5" />}
      title="Change role"
      description="The new role applies at once. They are signed out and sign in again to continue."
      confirmLabel="Change role"
      loadingLabel="Changing…"
      onConfirm={async () => {
        if (role === user.role) throw new FormProblem('That is already their role.');
        await change.mutateAsync({ role });
      }}
    >
      <SelectField
        label="Role"
        value={role}
        onChange={(e) => setRole(e.target.value as ProvisionableRole)}
        hint={ROLE_NOTE}
      >
        {PROVISIONABLE_ROLES.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </SelectField>
    </ConfirmDialog>
  );
}

export function AccountTab({ employee }: { employee: EmployeeProfileDTO }) {
  const q = useEmployeeAccount(employee.employeeId);
  const me = useSession();
  const [dialog, setDialog] = useState<'suspend' | 'disable' | 'role' | null>(null);
  const resend = usePeopleMutation((id: string) => api.post(`/users/${id}/resend-activation`), {
    success: 'A new activation link has been sent. The old one no longer works.',
  });
  const reactivate = usePeopleMutation((id: string) => api.post(`/users/${id}/reactivate`), {
    success: 'Account reactivated.',
  });

  if (q.isLoading) return <Skeleton className="h-48 rounded-card" />;
  if (q.isError || !q.data)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const { account, defaultEmail } = q.data;
  const isMe = account?.userId === me.user.userId;

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="flex items-center gap-2">
            <KeyRound className="size-5 text-brand" aria-hidden="true" /> Account &amp; Access
          </CardTitle>
          <CardDescription>
            Whether this person can sign in, and what they can do when they do.
          </CardDescription>
        </div>
        {account && <UserStatusPill status={account.status} />}
      </CardHeader>

      {!account ? (
        employee.readOnly ? (
          <Alert tone="info">This employee has left the school and has no login.</Alert>
        ) : (
          <Can
            permission="user:manage"
            fallback={<Alert tone="info">This employee has no login.</Alert>}
          >
            <CreateLoginForm employee={employee} defaultEmail={defaultEmail} />
          </Can>
        )
      ) : (
        <div className="space-y-6">
          <InfoGrid>
            <InfoItem label="Sign-in email">{account.email}</InfoItem>
            <InfoItem label="Role">
              <RoleBadge role={account.role} />
            </InfoItem>
            <InfoItem label="Last signed in">
              {account.lastLoginAt ? formatDateTime(account.lastLoginAt) : 'Never'}
            </InfoItem>
          </InfoGrid>

          {account.status === 'PENDING_ACTIVATION' && (
            <Alert tone="warning" title="Waiting for activation">
              {employee.displayName} has not followed their activation link yet. Links work once and
              expire after 72 hours.
              <DevOutboxHint email={account.email} />
            </Alert>
          )}
          {account.status === 'DISABLED' && (
            <Alert tone="info">
              This account is disabled, so there is no access. The role stays on record for history.
            </Alert>
          )}
          {isMe && (
            <Alert tone="info">
              This is your own account, so you can’t suspend, disable or change it here.
            </Alert>
          )}

          <Can permission="user:manage">
            {!isMe && account.status !== 'DISABLED' && (
              <div className="flex flex-wrap gap-2">
                {account.status === 'PENDING_ACTIVATION' && (
                  <Button
                    variant="outline"
                    onClick={() => resend.mutate(account.userId)}
                    loading={resend.isPending}
                    loadingText="Sending…"
                  >
                    <Mail /> Resend activation
                  </Button>
                )}
                {account.status === 'SUSPENDED' && (
                  <Button
                    variant="outline"
                    onClick={() => reactivate.mutate(account.userId)}
                    loading={reactivate.isPending}
                    loadingText="Reactivating…"
                  >
                    <CirclePlay /> Reactivate
                  </Button>
                )}
                {account.status === 'ACTIVE' && (
                  <Button variant="outline" onClick={() => setDialog('suspend')}>
                    <PauseCircle /> Suspend
                  </Button>
                )}
                <Button variant="outline" onClick={() => setDialog('role')}>
                  <UserCog /> Change role
                </Button>
                <Button
                  variant="outline"
                  className="text-danger hover:border-danger"
                  onClick={() => setDialog('disable')}
                >
                  <ShieldAlert /> Disable
                </Button>
              </div>
            )}
          </Can>
          <p className="flex items-start gap-2 text-[13px] text-muted">
            <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> {ROLE_NOTE}
          </p>
        </div>
      )}
      {dialog === 'suspend' && account && (
        <SuspendDialog user={account} onClose={() => setDialog(null)} />
      )}
      {dialog === 'disable' && account && (
        <DisableDialog user={account} onClose={() => setDialog(null)} />
      )}
      {dialog === 'role' && account && (
        <RoleDialog user={account} onClose={() => setDialog(null)} />
      )}
    </Card>
  );
}
