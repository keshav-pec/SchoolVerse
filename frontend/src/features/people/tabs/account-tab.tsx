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
import { ComboboxField, TextField } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/tooltip';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { UserStatusPill } from '@/components/sv/employee-status';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { RoleBadge } from '@/components/sv/role-badge';
import { api, ApiError } from '@/lib/api';
import { useSession } from '@/lib/auth';
import { FormProblem, messageFor } from '@/lib/errors';
import { formatDateTime } from '@/lib/format';
import { DevOutboxHint } from '../../auth/dev-outbox-hint';
import { useEmployeeAccount, usePeopleMutation } from '../api';
import { ROLE_HELP } from '../help-copy';

const ROLE_OPTIONS = PROVISIONABLE_ROLES.map((r) => ({ value: r, label: ROLE_LABELS[r] }));

const ROLE_NOTE = 'This decides what they can do. Their job title doesn’t give any access.';

const roleAside = <InfoTip label="About roles">{ROLE_HELP}</InfoTip>;

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
        {employee.displayName} is on the staff list but can’t sign in to SchoolVerse. Create a login
        only if they will use it. Drivers or cleaners, for example, often don’t need one.
      </Alert>
      {formError && <Alert tone="danger">{formError}</Alert>}
      <TextField
        label="Sign-in email"
        type="email"
        required
        autoComplete="off"
        hint="We filled in their official email. We send a one-time link here so they can set their own password."
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        error={errors.email}
      />
      <ComboboxField
        label="Role"
        required
        hint={ROLE_NOTE}
        labelAside={roleAside}
        value={role}
        onChange={(v) => setRole(v as ProvisionableRole)}
        options={ROLE_OPTIONS}
        searchPlaceholder="Search roles…"
      />
      <p className="flex items-start gap-2 text-[13px] text-muted">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" /> You never set or see their
        password. {employee.displayName} gets an email link that works once, within 3 days, and
        chooses their own.
      </p>
      <Button type="submit" loading={create.isPending} loadingText="Creating…">
        <UserPlus /> Create Login
      </Button>
    </form>
  );
}

function SuspendDialog({ user, onClose }: { user: UserDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const suspend = usePeopleMutation(
    (body: object) => api.post(`/users/${user.userId}/suspend`, body),
    { quiet: true, success: 'Login suspended. They have been signed out.' },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone="danger"
      icon={<PauseCircle className="size-5" />}
      title="Suspend this login?"
      description="A pause you can undo. They are signed out everywhere at once and can’t sign in until you press Reactivate. Their staff record doesn’t change."
      confirmLabel="Suspend login"
      loadingLabel="Suspending…"
      onConfirm={async () => {
        if (!reason.trim()) throw new FormProblem('Give a reason. It is kept in the history.');
        await suspend.mutateAsync({ reason: reason.trim() });
      }}
    >
      <TextField
        label="Reason"
        required
        hint="Kept in their history, e.g. “On long leave”."
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
    success: 'Login disabled.',
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone="danger"
      icon={<ShieldAlert className="size-5" />}
      title="Disable this login for good?"
      description="This can’t be undone. They are signed out now and this login never works again. To give them access later, you create a new login. If you only need a pause, use Suspend instead."
      confirmLabel="Disable login"
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
      description="The new role works straight away. They are signed out and sign in again to continue."
      confirmLabel="Change role"
      loadingLabel="Changing…"
      onConfirm={async () => {
        if (role === user.role) throw new FormProblem('That is already their role.');
        await change.mutateAsync({ role });
      }}
    >
      <ComboboxField
        label="Role"
        value={role}
        onChange={(v) => setRole(v as ProvisionableRole)}
        hint={ROLE_NOTE}
        labelAside={roleAside}
        options={ROLE_OPTIONS}
        searchPlaceholder="Search roles…"
      />
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
    <div className="space-y-4">
      <TabIntro title="Login" need="optional">
        <p>
          A login lets {employee.displayName} sign in to SchoolVerse with their own email and
          password. Skip this if they won’t use SchoolVerse.
        </p>
        <p>
          The <b>role</b> you pick decides what they can see. Their job title doesn’t give any
          access.
        </p>
      </TabIntro>
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="flex items-center gap-2">
              <KeyRound className="size-5 text-brand" aria-hidden="true" /> Login
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
                {employee.displayName} hasn’t opened their email link yet. A link works once and stops
                working after 3 days. If it has run out, press Resend Activation.
                <DevOutboxHint email={account.email} />
              </Alert>
            )}
            {account.status === 'DISABLED' && (
              <Alert tone="info">
                This login is disabled for good, so they can’t sign in. It stays here for history.
              </Alert>
            )}
            {isMe && (
              <Alert tone="info">
                This is your own login, so you can’t suspend, disable or change it here.
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
                      <Mail /> Resend Activation
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
                      <PauseCircle /> Suspend Login
                    </Button>
                  )}
                  <Button variant="outline" onClick={() => setDialog('role')}>
                    <UserCog /> Change Role
                  </Button>
                  <Button
                    variant="outline"
                    className="text-danger hover:border-danger"
                    onClick={() => setDialog('disable')}
                  >
                    <ShieldAlert /> Disable Login
                  </Button>
                  <InfoTip label="What these buttons do" className="self-center">
                    <ul>
                      <li><b>Resend Activation</b>: emails a fresh link. The old link stops working.</li>
                      <li><b>Suspend Login</b>: a pause. They can’t sign in until you press Reactivate.</li>
                      <li><b>Change Role</b>: changes what they can see. They sign in again.</li>
                      <li><b>Disable Login</b>: ends this login for good. It can’t be undone.</li>
                    </ul>
                    <p>None of these change their staff record.</p>
                  </InfoTip>
                </div>
              )}
            </Can>
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
    </div>
  );
}
