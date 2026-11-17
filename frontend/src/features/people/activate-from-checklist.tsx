import type { EmployeeProfileDTO } from '@shared';
import { CirclePlay } from 'lucide-react';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { api } from '@/lib/api';
import { usePeopleMutation } from './api';

/** The Activate step of the Next steps checklist: the same effect as the header button, one click away. */
export function ActivateFromChecklist({
  employee,
  onClose,
}: {
  employee: EmployeeProfileDTO;
  onClose: () => void;
}) {
  const activate = usePeopleMutation(
    (_: void) => api.post(`/employees/${employee.employeeId}/status`, { to: 'ACTIVE' }),
    { quiet: true, success: `${employee.displayName} is now active.` },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<CirclePlay className="size-5" />}
      title={`Activate ${employee.displayName}?`}
      description="They become Active and can be given classes or responsibilities."
      confirmLabel="Activate"
      loadingLabel="Activating…"
      onConfirm={async () => {
        await activate.mutateAsync();
      }}
    />
  );
}
