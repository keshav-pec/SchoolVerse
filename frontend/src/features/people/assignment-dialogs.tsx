import { useState } from 'react';
import { CalendarX2 } from 'lucide-react';
import { TextField } from '@/components/ui/field';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { usePeopleMutation } from './api';

const todayIso = () => new Date().toLocaleDateString('en-CA');

/** End an assignment after a chosen last day. It stays in the history. */
export function EndAssignmentDialog({
  path,
  title,
  onClose,
}: {
  path: string;
  title: string;
  onClose: () => void;
}) {
  const [effectiveTo, setTo] = useState(todayIso());
  const end = usePeopleMutation((body: object) => api.post(path, body), {
    quiet: true,
    success: 'Assignment ended.',
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<CalendarX2 className="size-5" />}
      tone="danger"
      title={title}
      description="It stops after the last day you choose and stays in their history."
      confirmLabel="End assignment"
      loadingLabel="Ending…"
      onConfirm={async () => {
        if (!effectiveTo) throw new FormProblem('Choose the last day.');
        await end.mutateAsync({ effectiveTo });
      }}
    >
      <TextField
        label="Last day"
        type="date"
        required
        value={effectiveTo}
        onChange={(e) => setTo(e.target.value)}
      />
    </ConfirmDialog>
  );
}

/** Cancel an assignment that has not started yet. */
export function CancelAssignmentDialog({
  path,
  title,
  onClose,
}: {
  path: string;
  title: string;
  onClose: () => void;
}) {
  const cancel = usePeopleMutation((_: void) => api.post(path), {
    quiet: true,
    success: 'Planned assignment cancelled.',
  });
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={title}
      description="It has not started yet, so it is simply cancelled."
      confirmLabel="Cancel the assignment"
      loadingLabel="Cancelling…"
      onConfirm={async () => {
        await cancel.mutateAsync();
      }}
    />
  );
}
