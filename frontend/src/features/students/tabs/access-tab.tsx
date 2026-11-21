import { useState } from 'react';
import { PORTAL_STATE_LABELS, type ParentAccessDTO, type PortalState, type StudentAdminProfileDTO } from '@shared';
import { KeyRound, MailPlus, RefreshCw, ShieldOff, Star, UserRoundX } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { api } from '@/lib/api';
import { useStudentMutation } from '../api';
import { ACCESS_INTRO, PORTAL_STATE_HELP } from '../help-copy';
import { useParentAccess } from '../lifecycle-api';

const TONE: Record<PortalState, 'neutral' | 'success' | 'warning' | 'danger'> = { NOT_INVITED: 'neutral', INVITED: 'warning', ACTIVE: 'success', REVOKED: 'danger' };

export function PortalStateBadge({ state }: { state: PortalState }) {
  return (
    <Badge tone={TONE[state]} data-state={state}>
      {PORTAL_STATE_LABELS[state]}
    </Badge>
  );
}

function firstNameOf(name: string) {
  return name.split(' ')[0] ?? name;
}

function RemoveAccessDialog({ row, studentName, onClose }: { row: ParentAccessDTO; studentName: string; onClose: () => void }) {
  const revoke = useStudentMutation((_: void) => api.post<ParentAccessDTO>(`/guardian-links/${row.guardianLinkId}/revoke-portal`), { quiet: true, success: `${row.fullName} can no longer see ${studentName}.` });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      tone="danger"
      icon={<ShieldOff className="size-5" />}
      title={`Remove ${firstNameOf(row.fullName)}’s access to ${studentName}?`}
      description={
        <>
          <p>
            This is for <b>this child only</b>. This parent keeps their login and their other children.
          </p>
          <p className="mt-1">It works straight away: the next page they open will not show {studentName}.</p>
        </>
      }
      confirmLabel="Remove Access"
      loadingLabel="Removing…"
      onConfirm={async () => void (await revoke.mutateAsync())}
    />
  );
}

function AccessRow({ row, readOnly, onRemove }: { row: ParentAccessDTO; readOnly: boolean; onRemove: () => void }) {
  const invite = useStudentMutation((_: void) => api.post<ParentAccessDTO>(`/guardian-links/${row.guardianLinkId}/enable-portal`), {
    success: (r) => (r.reusedAccount ? `${row.fullName} already had a login. This child was added to it.` : `Invitation sent to ${row.fullName}.`),
  });
  const resend = useStudentMutation((_: void) => api.post<ParentAccessDTO>(`/guardian-links/${row.guardianLinkId}/resend-invitation`), { success: `Invitation sent again to ${row.fullName}.` });
  const canInvite = row.portalState === 'NOT_INVITED' || row.portalState === 'REVOKED';
  const first = firstNameOf(row.fullName);

  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-bold">{row.fullName}</span>
            <Badge tone="neutral">{row.relationshipType}</Badge>
            {row.isPrimary && (
              <Badge tone="brand">
                <Star aria-hidden /> Primary
              </Badge>
            )}
            <PortalStateBadge state={row.portalState} />
          </div>
          <p className="mt-1 text-[13px] text-muted">
            {[row.canSeeAcademics && 'Sees class details', row.canSeeFees && 'Sees fee details'].filter(Boolean).join(' · ') || 'Sees nothing yet (change this on the Parents tab)'}
          </p>
          {!row.linkActive && <p className="mt-1 text-[13px] text-muted">This parent is no longer linked to the student.</p>}
          {row.linkActive && canInvite && row.hasLogin && (
            <p className="mt-1 text-sm font-semibold text-success" data-testid="has-login">
              {first} already has a login. We’ll use it.
            </p>
          )}
          {row.linkActive && canInvite && !row.hasEmail && <p className="mt-1 text-sm text-warning">Add an email for {first} on the Parents &amp; Guardians tab first. Parents sign in with their email.</p>}
          {row.portalState === 'INVITED' && <p className="mt-1 text-[13px] text-muted">We emailed a link. {first} has not set a password yet.</p>}
          {row.accountStatus === 'SUSPENDED' && <p className="mt-1 text-[13px] text-danger">The login is suspended, so {first} can’t sign in at the moment.</p>}
        </div>
        {row.linkActive && !readOnly && (
          <Can permission="parent_access:manage">
            <div className="flex flex-wrap gap-2">
              {canInvite && (
                <Button size="sm" onClick={() => invite.mutate()} loading={invite.isPending} loadingText="Inviting…" disabled={!row.hasEmail} title={!row.hasEmail ? 'Add an email first' : undefined} aria-label={`Invite ${row.fullName}`}>
                  <MailPlus /> {row.portalState === 'REVOKED' ? 'Give Access Again' : 'Invite Parent'}
                </Button>
              )}
              {row.portalState === 'INVITED' && (
                <Button size="sm" variant="outline" onClick={() => resend.mutate()} loading={resend.isPending} loadingText="Sending…" aria-label={`Resend the invitation to ${row.fullName}`}>
                  <RefreshCw /> Resend
                </Button>
              )}
              {(row.portalState === 'INVITED' || row.portalState === 'ACTIVE') && (
                <Button size="sm" variant="outline" onClick={onRemove} aria-label={`Remove ${row.fullName}’s access`}>
                  <UserRoundX /> Remove Access
                </Button>
              )}
            </div>
          </Can>
        )}
      </div>
    </li>
  );
}

/** Parent Access tab (`?tab=access`): each guardian's portal state, Invite, Resend and Remove Access (for this child only). */
export function AccessTab({ student, readOnly }: { student: StudentAdminProfileDTO; readOnly: boolean }) {
  const q = useParentAccess(student.studentId);
  const [removing, setRemoving] = useState<ParentAccessDTO | null>(null);
  const rows = q.data ?? [];

  return (
    <div className="space-y-4">
      <TabIntro title="About parent access">{ACCESS_INTRO}</TabIntro>
      <Card>
        <div className="mb-3">
          <HelpHeading title="Parent logins" help={PORTAL_STATE_HELP} helpLabel="What the access states mean" />
        </div>
        {q.isLoading ? (
          <Skeleton className="h-28 rounded-xl" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : rows.length === 0 ? (
          <EmptyState illustration={<KeyRound className="size-12 text-brand" aria-hidden="true" />} title="No parent linked yet" description="Add a parent on the Parents & Guardians tab first. Then you can invite them here." />
        ) : (
          <ul className="space-y-3" aria-label="Parent access">
            {rows.map((r) => (
              <AccessRow key={r.guardianLinkId} row={r} readOnly={readOnly} onRemove={() => setRemoving(r)} />
            ))}
          </ul>
        )}
      </Card>
      {removing && <RemoveAccessDialog row={removing} studentName={student.displayName || student.fullName} onClose={() => setRemoving(null)} />}
    </div>
  );
}
