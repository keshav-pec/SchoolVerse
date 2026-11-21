import { useState } from 'react';
import { Link } from 'react-router';
import type { GuardianLinkDTO, StudentAdminProfileDTO } from '@shared';
import { Link2, Mail, Pencil, Phone, Star, UserMinus, UserPlus, UsersRound } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { formatDateOnly, formatPhone } from '@/lib/format';
import { useStudentGuardians } from '../api';
import { EditGuardianDialog, EndGuardianDialog, MakePrimaryDialog } from '../guardian-dialogs';
import { GUARDIANS_INTRO, PRIMARY_GUARDIAN_HELP } from '../help-copy';

type Action = { kind: 'edit' | 'primary' | 'end'; link: GuardianLinkDTO };

function GuardianCard({ link, student, readOnly, onAction }: { link: GuardianLinkDTO; student: StudentAdminProfileDTO; readOnly: boolean; onAction: (a: Action) => void }) {
  const live = link.status === 'ACTIVE' || link.status === 'PLANNED';
  const access = [link.canSeeAcademics && 'Sees class details', link.canSeeFees && 'Sees fee details', link.pickupAllowed && 'Can pick up'].filter(Boolean);
  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Link to={`/families/${link.guardianPersonId}`} className="text-base font-bold text-ink hover:text-brand hover:underline">
              {link.fullName}
            </Link>
            <Badge tone="neutral">{link.relationshipType}</Badge>
            {link.isPrimary && live && (
              <Badge tone="brand">
                <Star aria-hidden /> Primary
              </Badge>
            )}
            {link.isEmergencyContact && live && <Badge tone="warning">Emergency contact</Badge>}
            {!live && <Badge tone="neutral">Ended {link.effectiveTo ? formatDateOnly(link.effectiveTo) : ''}</Badge>}
          </div>
          <p className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            {link.phone && (
              <span className="inline-flex items-center gap-1.5">
                <Phone className="size-3.5" aria-hidden="true" /> {formatPhone(link.phone)}
              </span>
            )}
            {link.email && (
              <span className="inline-flex items-center gap-1.5">
                <Mail className="size-3.5" aria-hidden="true" /> {link.email}
              </span>
            )}
            {!link.phone && !link.email && <span>No contact details shown</span>}
          </p>
          {access.length > 0 && <p className="mt-1 text-[13px] text-muted">{access.join(' · ')}</p>}
          <p className="mt-1 text-[13px] text-muted">Linked since {formatDateOnly(link.effectiveFrom)}</p>
        </div>
        {live && !readOnly && (
          <Can permission="guardian:manage">
            <div className="flex flex-wrap gap-2">
              {!link.isPrimary && (
                <Button size="sm" variant="outline" onClick={() => onAction({ kind: 'primary', link })}>
                  <Star /> Make Primary
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={() => onAction({ kind: 'edit', link })} aria-label={`Edit ${link.fullName}`}>
                <Pencil /> Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => onAction({ kind: 'end', link })} aria-label={`Unlink ${link.fullName}`} title={student.guardianCount <= 1 ? 'This is the only parent. The student will need another one.' : undefined}>
                <UserMinus /> Unlink
              </Button>
            </div>
          </Can>
        )}
      </div>
    </li>
  );
}

export function GuardiansTab({ student, readOnly, onAdd }: { student: StudentAdminProfileDTO; readOnly: boolean; onAdd: (mode: 'new' | 'link') => void }) {
  const q = useStudentGuardians(student.studentId);
  const [action, setAction] = useState<Action | null>(null);
  const [showEnded, setShowEnded] = useState(false);

  const links = q.data ?? [];
  const current = links.filter((l) => l.status === 'ACTIVE' || l.status === 'PLANNED');
  const ended = links.filter((l) => l.status !== 'ACTIVE' && l.status !== 'PLANNED' && l.status !== 'CANCELLED');

  return (
    <div className="space-y-4">
      <TabIntro title="About parents and guardians">{GUARDIANS_INTRO}</TabIntro>
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <HelpHeading title="Parents & guardians" help={PRIMARY_GUARDIAN_HELP} helpLabel="Primary parent and emergency contact" />
          {!readOnly && (
            <Can permission="guardian:manage">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => onAdd('link')}>
                  <Link2 /> Link Existing Parent
                </Button>
                <Button size="sm" onClick={() => onAdd('new')}>
                  <UserPlus /> Add New Parent
                </Button>
              </div>
            </Can>
          )}
        </div>
        {q.isLoading ? (
          <Skeleton className="h-28 rounded-xl" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
        ) : current.length === 0 ? (
          <EmptyState
            illustration={<UsersRound className="size-12 text-brand" aria-hidden="true" />}
            title="No parent linked yet"
            description="Every student needs at least one parent or guardian, so the school knows who to call."
            action={
              !readOnly && (
                <Can permission="guardian:manage">
                  <Button onClick={() => onAdd('new')}>
                    <UserPlus /> Add New Parent
                  </Button>
                </Can>
              )
            }
          />
        ) : (
          <ul className="space-y-3" aria-label="Parents and guardians">
            {current.map((l) => (
              <GuardianCard key={l.guardianLinkId} link={l} student={student} readOnly={readOnly} onAction={setAction} />
            ))}
          </ul>
        )}
        {ended.length > 0 && (
          <div className="mt-4">
            <Button variant="ghost" size="sm" onClick={() => setShowEnded((v) => !v)} aria-expanded={showEnded}>
              {showEnded ? 'Hide' : 'Show'} earlier links ({ended.length})
            </Button>
            {showEnded && (
              <ul className="mt-2 space-y-3" aria-label="Earlier links">
                {ended.map((l) => (
                  <GuardianCard key={l.guardianLinkId} link={l} student={student} readOnly onAction={setAction} />
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>
      {action?.kind === 'edit' && <EditGuardianDialog link={action.link} onClose={() => setAction(null)} />}
      {action?.kind === 'primary' && <MakePrimaryDialog link={action.link} onClose={() => setAction(null)} />}
      {action?.kind === 'end' && <EndGuardianDialog link={action.link} onClose={() => setAction(null)} />}
    </div>
  );
}
