import { useState } from 'react';
import { EXITED_STUDENT_STATUSES, TC_STATUS_LABELS, WITHDRAWAL_REASON_LABELS, type StudentAdminProfileDTO, type TcStatus, type TransferCertificateDTO, type WithdrawalDTO } from '@shared';
import { Check, CircleCheck, CircleDashed, Copy, DoorOpen, Download, FileBadge, Lock, MapPinned, MoveRight, Undo2, UserRoundPlus } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { TextareaField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { api } from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { FormProblem } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useStudentMutation } from '../api';
import { useStudentContext } from '../context';
import { MoveCampusDrawer, ReadmitDialog, StartWithdrawalDialog } from '../exit-dialogs';
import { EXIT_INTRO, MOVE_CAMPUS_HELP, TC_HELP, WITHDRAWAL_HELP } from '../help-copy';
import { useStudentTransfers, useTransferCertificates, useWithdrawal } from '../lifecycle-api';
import { useDocumentDownload } from './documents-tab';

type Dialog = 'move' | 'withdraw' | 'finish' | 'cancel-withdrawal' | 'readmit' | null;

// ───────────────────────────────────────────────────────────── movement history

function MovementHistory({ studentId }: { studentId: string }) {
  const ctx = useStudentContext();
  const q = useStudentTransfers(studentId);
  const campus = (id: string | null) => ctx.locations.find((l) => l.locationId === id)?.displayName ?? 'another campus';
  const items = [...(q.data?.items ?? [])].sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  if (q.isLoading) return <Skeleton className="h-16" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  if (items.length === 0) return <p className="text-sm text-muted">No moves yet. Section and campus changes show here.</p>;
  return (
    <ul className="divide-y divide-line" aria-label="Moves">
      {items.map((t) => (
        <li key={t.transferEventId} className="flex flex-wrap items-center gap-3 py-2.5 text-sm">
          {t.type === 'LOCATION' ? <MapPinned className="size-4 text-brand" aria-hidden="true" /> : <MoveRight className="size-4 text-brand" aria-hidden="true" />}
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{t.type === 'LOCATION' ? `Moved from ${campus(t.fromLocationId)} to ${campus(t.toLocationId)}` : 'Changed section'}</span>
            <span className="text-muted"> · {t.reason}</span>
          </span>
          <span className="text-muted">{formatDateOnly(t.effectiveDate)}</span>
        </li>
      ))}
    </ul>
  );
}

// ───────────────────────────────────────────────────────────── withdrawal

function WithdrawalPanel({ student, withdrawal, onDialog, readOnly }: { student: StudentAdminProfileDTO; withdrawal: WithdrawalDTO; onDialog: (d: Dialog) => void; readOnly: boolean }) {
  const inProgress = student.status === 'WITHDRAWAL_INITIATED';
  return (
    <div className="space-y-3">
      <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted">Leaving date</dt>
          <dd className="font-semibold">{formatDateOnly(withdrawal.leavingDate)}</dd>
        </div>
        <div>
          <dt className="text-muted">Reason</dt>
          <dd className="font-semibold">{WITHDRAWAL_REASON_LABELS[withdrawal.reasonCategory]}</dd>
        </div>
        <div>
          <dt className="text-muted">New school</dt>
          <dd className="font-semibold">{withdrawal.destinationSchool ?? '—'}</dd>
        </div>
      </dl>
      {inProgress && (
        <>
          <ul className="space-y-1.5" aria-label="Before the student leaves">
            {withdrawal.checklist.map((c) => (
              <li key={c.key} className="flex items-start gap-2 text-sm">
                {c.done ? <CircleCheck className="mt-0.5 size-4 text-success" aria-label="Done" /> : <CircleDashed className="mt-0.5 size-4 text-warning" aria-label="Pending" />}
                <span>
                  <span className="font-semibold">{c.label}</span>
                  {c.detail && <span className="text-muted"> · {c.detail}</span>}
                </span>
              </li>
            ))}
          </ul>
          {!readOnly && (
            <Can permission="student:lifecycle">
              <div className="flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => onDialog('finish')} disabled={!withdrawal.due} title={!withdrawal.due ? `Available from ${formatDateOnly(withdrawal.leavingDate)}` : undefined}>
                  <DoorOpen /> Finish Exit
                </Button>
                <Button size="sm" variant="outline" onClick={() => onDialog('cancel-withdrawal')}>
                  <Undo2 /> Cancel Withdrawal
                </Button>
                {!withdrawal.due && <span className="text-[13px] text-muted">The student stays in class until {formatDateOnly(withdrawal.leavingDate)}. It finishes by itself on that day.</span>}
              </div>
            </Can>
          )}
        </>
      )}
    </div>
  );
}

// ───────────────────────────────────────────────────────────── transfer certificate

const STEPS: { label: string; statuses: TcStatus[] }[] = [
  { label: 'Requested', statuses: ['REQUESTED', 'UNDER_REVIEW'] },
  { label: 'Waiting for dues', statuses: ['PENDING_CLEARANCE'] },
  { label: 'Approved', statuses: ['APPROVED'] },
  { label: 'Issued', statuses: ['ISSUED', 'DUPLICATE_ISSUED'] },
];

function Steps({ status }: { status: TcStatus }) {
  const at = STEPS.findIndex((s) => s.statuses.includes(status));
  return (
    <ol className="flex flex-wrap items-center gap-1.5 text-[13px]" aria-label="Certificate steps">
      {STEPS.map((s, i) => (
        <li key={s.label} className="flex items-center gap-1.5" aria-current={i === at ? 'step' : undefined}>
          <span className={cn('inline-flex items-center gap-1 rounded-pill px-2.5 py-1 font-semibold', i < at ? 'bg-success-soft text-success' : i === at ? 'bg-brand text-white' : 'bg-canvas text-muted')}>
            {i < at && <Check className="size-3.5" aria-hidden="true" />}
            {s.label}
          </span>
          {i < STEPS.length - 1 && <span className="text-muted" aria-hidden="true">→</span>}
        </li>
      ))}
    </ol>
  );
}

function CertificateCard({ tc, canAct, onDuplicate }: { tc: TransferCertificateDTO; canAct: boolean; onDuplicate: (tc: TransferCertificateDTO) => void }) {
  const { download, downloading } = useDocumentDownload();
  const dues = useStudentMutation((duesStatus: 'PENDING' | 'CLEARED') => api.patch<TransferCertificateDTO>(`/transfer-certificates/${tc.certificateId}`, { duesStatus }), {
    success: (_r, v) => (v === 'CLEARED' ? 'Dues marked as cleared.' : 'Dues marked as pending.'),
  });
  const approve = useStudentMutation((_: void) => api.post<TransferCertificateDTO>(`/transfer-certificates/${tc.certificateId}/approve`), {
    success: (r) => (r.status === 'PENDING_CLEARANCE' ? 'Waiting for dues. Approve again once the dues are cleared.' : 'Certificate approved. You can issue it now.'),
  });
  const issue = useStudentMutation((_: void) => api.post<TransferCertificateDTO>(`/transfer-certificates/${tc.certificateId}/issue`, {}), { success: (r) => `Certificate ${r.certificateNumber} issued. It is now locked.` });
  const cancel = useStudentMutation((_: void) => api.post<TransferCertificateDTO>(`/transfer-certificates/${tc.certificateId}/cancel`), { success: 'Certificate request cancelled.' });
  const issued = tc.status === 'ISSUED' || tc.status === 'DUPLICATE_ISSUED';

  return (
    <li className="space-y-3 rounded-xl border border-line p-4" data-testid="tc-card">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-bold">{tc.copyType === 'DUPLICATE' ? 'Duplicate certificate' : 'Transfer certificate'}</span>
        {tc.certificateNumber && <span className="font-mono text-sm font-semibold">{tc.certificateNumber}</span>}
        <Badge tone={issued ? 'success' : tc.status === 'CANCELLED' ? 'neutral' : 'warning'}>{TC_STATUS_LABELS[tc.status]}</Badge>
      </div>
      {tc.status !== 'CANCELLED' && tc.copyType === 'ORIGINAL' && <Steps status={tc.status} />}
      <p className="text-[13px] text-muted">
        Asked {formatDateOnly(tc.applicationDate)} · Leaving {formatDateOnly(tc.leavingDate)} · Last class {tc.lastClass} · {tc.reasonForLeaving}
        {tc.duplicateReason ? ` · Duplicate because: ${tc.duplicateReason}` : ''}
      </p>
      {tc.locked && (
        <p className="flex items-center gap-1.5 text-sm font-semibold text-ink" data-testid="tc-locked">
          <Lock className="size-4" aria-hidden="true" /> Issued on {formatDateOnly(tc.issueDate)}. It can’t be changed. If it is lost, issue a duplicate.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {tc.documentId && (
          <Button size="sm" variant="outline" onClick={() => void download({ documentId: tc.documentId! })} loading={downloading === tc.documentId} loadingText="Opening…">
            <Download /> Download PDF
          </Button>
        )}
        {canAct && !tc.locked && tc.status !== 'CANCELLED' && (
          <>
            <label className="flex min-h-9 items-center gap-2 rounded-lg border border-line px-3 text-sm font-semibold">
              <input type="checkbox" className="size-4 accent-[var(--color-brand)]" checked={tc.duesStatus === 'CLEARED'} disabled={dues.isPending} onChange={(e) => dues.mutate(e.target.checked ? 'CLEARED' : 'PENDING')} />
              Dues cleared
            </label>
            {tc.status !== 'APPROVED' && (
              <Button size="sm" onClick={() => approve.mutate()} loading={approve.isPending} loadingText="Approving…">
                <CircleCheck /> Approve
              </Button>
            )}
            {tc.status === 'APPROVED' && (
              <Button size="sm" onClick={() => issue.mutate()} loading={issue.isPending} loadingText="Issuing…">
                <FileBadge /> Issue Certificate
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => cancel.mutate()} loading={cancel.isPending} loadingText="Cancelling…">
              Cancel Request
            </Button>
          </>
        )}
        {canAct && tc.status === 'ISSUED' && tc.copyType === 'ORIGINAL' && (
          <Button size="sm" variant="outline" onClick={() => onDuplicate(tc)}>
            <Copy /> Issue Duplicate
          </Button>
        )}
      </div>
    </li>
  );
}

function DuplicateDialog({ tc, onClose }: { tc: TransferCertificateDTO; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const duplicate = useStudentMutation((body: object) => api.post<TransferCertificateDTO>(`/transfer-certificates/${tc.certificateId}/duplicate`, body), { quiet: true, success: (r) => `Duplicate ${r.certificateNumber ?? ''} issued. It is marked as a duplicate.` });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<Copy className="size-5" />}
      title="Issue a duplicate certificate?"
      description={`A new copy of ${tc.certificateNumber} is made and marked “Duplicate”. The original stays as it is.`}
      confirmLabel="Issue Duplicate"
      loadingLabel="Issuing…"
      onConfirm={async () => {
        if (!reason.trim()) throw new FormProblem('Write why a duplicate is needed, for example “The parent lost the original”.');
        await duplicate.mutateAsync({ reason: reason.trim() });
      }}
    >
      <TextareaField label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)} hint="Example: The parent lost the original." className="min-h-20" maxLength={300} />
    </ConfirmDialog>
  );
}

function CertificatePanel({ student }: { student: StudentAdminProfileDTO }) {
  const q = useTransferCertificates(student.studentId);
  const canAct = useAuth().can('student:lifecycle');
  const [duplicating, setDuplicating] = useState<TransferCertificateDTO | null>(null);
  const request = useStudentMutation((_: void) => api.post<TransferCertificateDTO>(`/students/${student.studentId}/transfer-certificates`, {}), { success: 'Certificate requested. Mark the dues, then approve it.' });
  const items = [...(q.data ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const hasLive = items.some((c) => c.copyType === 'ORIGINAL' && c.status !== 'CANCELLED');
  const canRequest = !hasLive && !['DRAFT', 'ADMISSION_PENDING'].includes(student.status);

  return (
    <>
      {q.isLoading ? (
        <Skeleton className="h-20" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />
      ) : (
        <div className="space-y-3">
          {items.length === 0 && <p className="text-sm text-muted">No transfer certificate yet.</p>}
          {canRequest && (
            <Can permission="student:lifecycle">
              <Button size="sm" variant="outline" onClick={() => request.mutate()} loading={request.isPending} loadingText="Requesting…">
                <FileBadge /> Request Transfer Certificate
              </Button>
            </Can>
          )}
          {items.length > 0 && (
            <ul className="space-y-3" aria-label="Transfer certificates">
              {items.map((tc) => (
                <CertificateCard key={tc.certificateId} tc={tc} canAct={canAct} onDuplicate={setDuplicating} />
              ))}
            </ul>
          )}
        </div>
      )}
      {duplicating && <DuplicateDialog tc={duplicating} onClose={() => setDuplicating(null)} />}
    </>
  );
}

// ───────────────────────────────────────────────────────────── the tab

/** Transfers & Exit tab (`?tab=exit`): moves, withdrawal with its checklist, the Transfer Certificate, and re-admission. */
export function ExitTab({ student, readOnly }: { student: StudentAdminProfileDTO; readOnly: boolean }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const exited = EXITED_STUDENT_STATUSES.includes(student.status);
  const leaving = student.status === 'WITHDRAWAL_INITIATED';
  const withdrawal = useWithdrawal(student.studentId, leaving || exited);
  const enrollment = student.enrollment;
  const canMove = !readOnly && !leaving && (student.status === 'ACTIVE' || student.status === 'INACTIVE') && enrollment?.state === 'OPEN';
  const canWithdraw = !readOnly && (student.status === 'ACTIVE' || student.status === 'INACTIVE');

  const finish = useStudentMutation((_: void) => api.post<WithdrawalDTO>(`/students/${student.studentId}/withdrawal/complete`), { quiet: true, success: `${student.fullName} has left the school. The record is kept for history.` });
  const cancel = useStudentMutation((_: void) => api.post(`/students/${student.studentId}/withdrawal/cancel`), { quiet: true, success: 'Withdrawal cancelled. The student stays in class.' });

  return (
    <div className="space-y-4">
      <TabIntro title="About transfers and exit">{EXIT_INTRO}</TabIntro>

      <Card>
        <CardHeader>
          <HelpHeading title="Moves" help={MOVE_CAMPUS_HELP} helpLabel="About moving campus" />
          {canMove && (
            <Can permission="student:lifecycle">
              <Button size="sm" variant="outline" onClick={() => setDialog('move')}>
                <MapPinned /> Move To Another Campus
              </Button>
            </Can>
          )}
        </CardHeader>
        <MovementHistory studentId={student.studentId} />
      </Card>

      <Card>
        <CardHeader>
          <HelpHeading title="Leaving the school" help={WITHDRAWAL_HELP} helpLabel="About withdrawal" />
          {canWithdraw && (
            <Can permission="student:lifecycle">
              <Button size="sm" variant="outline" onClick={() => setDialog('withdraw')}>
                <DoorOpen /> Start Withdrawal
              </Button>
            </Can>
          )}
          {exited && (
            <Can permission="student:lifecycle">
              <Button size="sm" onClick={() => setDialog('readmit')}>
                <UserRoundPlus /> Re-admit
              </Button>
            </Can>
          )}
        </CardHeader>
        {leaving || exited ? (
          withdrawal.isLoading ? (
            <Skeleton className="h-20" />
          ) : withdrawal.data ? (
            <WithdrawalPanel student={student} withdrawal={withdrawal.data} onDialog={setDialog} readOnly={readOnly} />
          ) : (
            <p className="text-sm text-muted">{exited ? 'This student has left the school.' : 'No withdrawal details.'}</p>
          )
        ) : (
          <p className="text-sm text-muted">The student is in school. Start a withdrawal when a parent says the child is leaving.</p>
        )}
      </Card>

      <Card>
        <CardHeader>
          <HelpHeading title="Transfer certificate" help={TC_HELP} helpLabel="About the transfer certificate" />
        </CardHeader>
        <CertificatePanel student={student} />
      </Card>

      {dialog === 'move' && enrollment && <MoveCampusDrawer student={student} onClose={() => setDialog(null)} />}
      {dialog === 'withdraw' && <StartWithdrawalDialog student={student} onClose={() => setDialog(null)} />}
      {dialog === 'readmit' && <ReadmitDialog student={student} onClose={() => setDialog(null)} />}
      {dialog === 'finish' && withdrawal.data && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          tone="danger"
          icon={<DoorOpen className="size-5" />}
          title={`Finish ${student.fullName}’s exit?`}
          description={`Leaving date ${formatDateOnly(withdrawal.data.leavingDate)}. Class and section will close and parent access ends. History is kept.`}
          confirmLabel="Finish Exit"
          loadingLabel="Finishing…"
          onConfirm={async () => void (await finish.mutateAsync())}
        />
      )}
      {dialog === 'cancel-withdrawal' && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDialog(null)}
          icon={<Undo2 className="size-5" />}
          title="Cancel the withdrawal?"
          description="The student stays in their class as before."
          confirmLabel="Cancel Withdrawal"
          loadingLabel="Cancelling…"
          onConfirm={async () => void (await cancel.mutateAsync())}
        />
      )}
    </div>
  );
}
