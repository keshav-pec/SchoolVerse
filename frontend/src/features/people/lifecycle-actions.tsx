import { useState } from 'react';
import {
  EXIT_REASON_CATEGORIES,
  EXIT_REASON_LABELS,
  type EmployeeAction,
  type EmployeeProfileDTO,
  type ExitReasonCategory,
} from '@shared';
import { CirclePlay, DoorOpen, PauseCircle, RotateCcw, Stethoscope } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ComboboxField, TextareaField, TextField } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { usePeopleMutation } from './api';

const todayIso = () => new Date().toLocaleDateString('en-CA');

interface Props {
  employee: EmployeeProfileDTO;
}

function ExitDialog({ employee, onClose }: { employee: EmployeeProfileDTO; onClose: () => void }) {
  const [exitDate, setExitDate] = useState(todayIso());
  const [reason, setReason] = useState<ExitReasonCategory | ''>('');
  const [note, setNote] = useState('');
  const exit = usePeopleMutation(
    (body: object) => api.post(`/employees/${employee.employeeId}/exit`, body),
    { quiet: true, success: `${employee.displayName}’s exit has been recorded.` },
  );
  const immediate = exitDate !== '' && exitDate <= todayIso();

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<DoorOpen className="size-5" />}
      tone="danger"
      title={`Record that ${employee.displayName} is leaving?`}
      description={
        exitDate ? (
          <>
            Their last day is <strong className="text-ink">{formatDateOnly(exitDate)}</strong>. On
            that day their classes and responsibilities close and the record is kept for history.
            {immediate
              ? ' Because the date is today or earlier, the exit takes effect now and their login is disabled.'
              : ' Until then they are on their notice period and work and sign in as normal.'}
          </>
        ) : (
          'Choose the last working day.'
        )
      }
      confirmLabel="Record exit"
      loadingLabel="Recording the exit…"
      onConfirm={async () => {
        if (!exitDate) throw new FormProblem('Choose the last working day.');
        if (!reason) throw new FormProblem('Choose a reason.');
        await exit.mutateAsync({
          exitDate,
          exitReasonCategory: reason,
          note: note.trim() || undefined,
        });
      }}
    >
      <div className="space-y-4">
        <TextField
          label="Last working day"
          type="date"
          required
          value={exitDate}
          onChange={(e) => setExitDate(e.target.value)}
        />
        <ComboboxField
          label="Reason"
          required
          value={reason}
          onChange={(v) => setReason(v as ExitReasonCategory)}
          placeholder="Choose…"
          options={EXIT_REASON_CATEGORIES.map((r) => ({ value: r, label: EXIT_REASON_LABELS[r] }))}
          searchPlaceholder="Search reasons…"
        />
        <TextareaField
          label="Note"
          hint="Optional. Only School Admins see it."
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
      </div>
    </ConfirmDialog>
  );
}

function StatusDialog({
  employee,
  action,
  onClose,
}: {
  employee: EmployeeProfileDTO;
  action: 'activate' | 'leave' | 'suspend';
  onClose: () => void;
}) {
  const [reason, setReason] = useState('');
  const to = action === 'activate' ? 'ACTIVE' : action === 'leave' ? 'ON_LEAVE' : 'SUSPENDED';
  const copy = {
    activate: {
      title:
        employee.status === 'ONBOARDING'
          ? `Activate ${employee.displayName}?`
          : `Return ${employee.displayName} to active?`,
      description: 'They become a current member of staff and can be given classes or responsibilities.',
      label: 'Activate',
      loading: 'Activating…',
      success: `${employee.displayName} is now active.`,
      Icon: CirclePlay,
    },
    leave: {
      title: `Mark ${employee.displayName} as on leave?`,
      description:
        'Their record shows On leave. Their login keeps working and their assignments stay as they are.',
      label: 'Mark on leave',
      loading: 'Saving…',
      success: `${employee.displayName} is on leave.`,
      Icon: Stethoscope,
    },
    suspend: {
      title: `Suspend ${employee.displayName}?`,
      description:
        'They can’t get new classes or responsibilities while suspended. Their login still works: to stop them signing in, suspend the login on the Login tab.',
      label: 'Suspend',
      loading: 'Suspending…',
      success: `${employee.displayName} is suspended.`,
      Icon: PauseCircle,
    },
  }[action];
  const change = usePeopleMutation(
    (body: object) => api.post(`/employees/${employee.employeeId}/status`, body),
    { quiet: true, success: copy.success },
  );

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<copy.Icon className="size-5" />}
      tone={action === 'suspend' ? 'danger' : 'default'}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.label}
      loadingLabel={copy.loading}
      onConfirm={async () => {
        await change.mutateAsync({ to, reason: reason.trim() || undefined });
      }}
    >
      {action !== 'activate' && (
        <TextField
          label="Reason"
          hint="Optional. Only School Admins see it."
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={300}
        />
      )}
    </ConfirmDialog>
  );
}

function CancelExitDialog({
  employee,
  onClose,
}: {
  employee: EmployeeProfileDTO;
  onClose: () => void;
}) {
  const cancel = usePeopleMutation(
    (_: void) => api.post(`/employees/${employee.employeeId}/cancel-exit`),
    { quiet: true, success: `${employee.displayName}’s exit has been cancelled.` },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<RotateCcw className="size-5" />}
      title={`Cancel ${employee.displayName}’s exit?`}
      description="They go back to Active, and the assignments the exit closed are reopened exactly as they were."
      confirmLabel="Cancel exit"
      loadingLabel="Cancelling…"
      onConfirm={async () => {
        await cancel.mutateAsync();
      }}
    />
  );
}

/** The lifecycle buttons the server says make sense from the current status. Each one names its effect before it acts. */
export function LifecycleActions({ employee }: Props) {
  const [open, setOpen] = useState<EmployeeAction | null>(null);
  const has = (a: EmployeeAction) => employee.lifecycleActions.includes(a);
  const close = () => setOpen(null);

  if (employee.readOnly) return null;
  return (
    <>
      <div className="flex flex-wrap gap-2">
        {has('activate') && (
          <Button onClick={() => setOpen('activate')}>
            <CirclePlay /> Activate
          </Button>
        )}
        {has('leave') && (
          <Button variant="outline" onClick={() => setOpen('leave')}>
            <Stethoscope /> Mark On Leave
          </Button>
        )}
        {has('suspend') && (
          <Button variant="outline" onClick={() => setOpen('suspend')}>
            <PauseCircle /> Suspend
          </Button>
        )}
        {has('cancel_exit') && (
          <Button variant="outline" onClick={() => setOpen('cancel_exit')}>
            <RotateCcw /> Cancel Exit
          </Button>
        )}
        {has('exit') && (
          <Button
            variant="outline"
            className="text-danger hover:border-danger"
            onClick={() => setOpen('exit')}
          >
            <DoorOpen /> Record Exit
          </Button>
        )}
      </div>
      {(open === 'activate' || open === 'leave' || open === 'suspend') && (
        <StatusDialog employee={employee} action={open} onClose={close} />
      )}
      {open === 'exit' && <ExitDialog employee={employee} onClose={close} />}
      {open === 'cancel_exit' && <CancelExitDialog employee={employee} onClose={close} />}
    </>
  );
}
