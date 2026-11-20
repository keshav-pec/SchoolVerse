import { useState } from 'react';
import {
  EMPLOYEE_CATEGORY_LABELS,
  type EmployeeProfileDTO,
  type LocationAssignmentDTO,
} from '@shared';
import { ArrowRightLeft, MapPin, MapPinPlus, Star } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { AssignmentStatusChip } from '@/components/sv/employee-status';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { InfoGrid, InfoItem } from '@/components/sv/info-grid';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { formatDateOnly, formatPhone } from '@/lib/format';
import { useActiveLocations } from '../../academic/api';
import { useLocationAssignments, usePeopleMutation } from '../api';

const todayIso = () => new Date().toLocaleDateString('en-CA');

function AddLocationDialog({
  employee,
  onClose,
}: {
  employee: EmployeeProfileDTO;
  onClose: () => void;
}) {
  const locations = useActiveLocations();
  const placed = new Set(employee.locations.map((l) => l.locationId));
  const [locationId, setLocationId] = useState('');
  const [effectiveFrom, setEffectiveFrom] = useState('');
  const add = usePeopleMutation(
    (body: object) => api.post(`/employees/${employee.employeeId}/location-assignments`, body),
    { quiet: true, success: 'Location added.' },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<MapPinPlus className="size-5" />}
      title="Add a location"
      description={`${employee.displayName} also works at this location. Their primary location stays as it is.`}
      confirmLabel="Add location"
      loadingLabel="Adding…"
      onConfirm={async () => {
        if (!locationId) throw new FormProblem('Choose a location.');
        await add.mutateAsync({ locationId, ...(effectiveFrom ? { effectiveFrom } : {}) });
      }}
    >
      <div className="space-y-4">
        <ComboboxField
          label="Location"
          required
          value={locationId}
          onChange={setLocationId}
          placeholder="Choose…"
          options={(locations.data ?? [])
            .filter((l) => !placed.has(l.locationId))
            .map((l) => ({ value: l.locationId, label: l.displayName, hint: l.locationCode }))}
          searchPlaceholder="Search locations…"
        />
        <TextField
          label="Starts on"
          type="date"
          hint="Leave blank to start today."
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
        />
      </div>
    </ConfirmDialog>
  );
}

function TransferDialog({
  employee,
  onClose,
}: {
  employee: EmployeeProfileDTO;
  onClose: () => void;
}) {
  const locations = useActiveLocations();
  const [toLocationId, setTo] = useState('');
  const [effectiveFrom, setFrom] = useState(todayIso());
  const [keepOldAsSecondary, setKeep] = useState(false);
  const transfer = usePeopleMutation(
    (body: object) => api.post(`/employees/${employee.employeeId}/transfer`, body),
    { quiet: true, success: `${employee.displayName} has been transferred.` },
  );
  const current = employee.primaryLocation;
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<ArrowRightLeft className="size-5" />}
      title={`Transfer ${employee.displayName}`}
      description={
        <>
          The current primary location{current ? ` (${current.displayName})` : ''} ends the day
          before, and the new one starts on the date you choose. The old placement stays in their
          history.
        </>
      }
      confirmLabel="Transfer"
      loadingLabel="Transferring…"
      onConfirm={async () => {
        if (!toLocationId) throw new FormProblem('Choose the new location.');
        if (!effectiveFrom) throw new FormProblem('Choose the date the transfer starts.');
        await transfer.mutateAsync({ toLocationId, effectiveFrom, keepOldAsSecondary });
      }}
    >
      <div className="space-y-4">
        <ComboboxField
          label="New primary location"
          required
          value={toLocationId}
          onChange={setTo}
          placeholder="Choose…"
          options={(locations.data ?? [])
            .filter((l) => l.locationId !== current?.locationId)
            .map((l) => ({ value: l.locationId, label: l.displayName, hint: l.locationCode }))}
          searchPlaceholder="Search locations…"
        />
        <TextField
          label="Starts on"
          type="date"
          required
          hint="A date in the future shows as Planned until then."
          value={effectiveFrom}
          onChange={(e) => setFrom(e.target.value)}
        />
        <label className="flex items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={keepOldAsSecondary}
            onChange={(e) => setKeep(e.target.checked)}
            className="mt-0.5 size-4 accent-[var(--color-brand)]"
          />
          <span>Keep the old location as a secondary location</span>
        </label>
      </div>
    </ConfirmDialog>
  );
}

function EndDialog({
  employee,
  assignment,
  onClose,
}: {
  employee: EmployeeProfileDTO;
  assignment: LocationAssignmentDTO;
  onClose: () => void;
}) {
  const [effectiveTo, setTo] = useState(todayIso());
  const end = usePeopleMutation(
    (body: object) =>
      api.post(`/location-assignments/${assignment.locationAssignmentId}/end`, body),
    { quiet: true, success: 'Location assignment ended.' },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`End ${employee.displayName}’s time at ${assignment.locationName}?`}
      description="The placement stops after the last day you choose. It stays in their history."
      confirmLabel="End assignment"
      loadingLabel="Ending…"
      tone="danger"
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

function CancelDialog({
  assignment,
  onClose,
}: {
  assignment: LocationAssignmentDTO;
  onClose: () => void;
}) {
  const cancel = usePeopleMutation(
    (_: void) => api.post(`/location-assignments/${assignment.locationAssignmentId}/cancel`),
    { quiet: true, success: 'Planned location cancelled.' },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Cancel the planned move to ${assignment.locationName}?`}
      description="It has not started yet, so it is simply cancelled."
      confirmLabel="Cancel the plan"
      loadingLabel="Cancelling…"
      onConfirm={async () => {
        await cancel.mutateAsync();
      }}
    />
  );
}

/** Directory fields plus the employee's locations, with Add location and Transfer. */
export function OverviewTab({ employee }: { employee: EmployeeProfileDTO }) {
  const assignments = useLocationAssignments(employee.employeeId);
  const [dialog, setDialog] = useState<'add' | 'transfer' | null>(null);
  const [ending, setEnding] = useState<LocationAssignmentDTO | null>(null);
  const [cancelling, setCancelling] = useState<LocationAssignmentDTO | null>(null);
  const editable = !employee.readOnly;
  const open = (assignments.data ?? []).filter(
    (a) => a.status === 'ACTIVE' || a.status === 'PLANNED',
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>About</CardTitle>
            <CardDescription>What colleagues can see in the directory.</CardDescription>
          </div>
        </CardHeader>
        <InfoGrid>
          <InfoItem label="Name">{employee.fullName}</InfoItem>
          <InfoItem label="Preferred name">{employee.preferredName}</InfoItem>
          <InfoItem label="Employee code">
            <span className="font-mono">{employee.employeeCode}</span>
          </InfoItem>
          <InfoItem label="Category">
            {EMPLOYEE_CATEGORY_LABELS[employee.employeeCategory]}
          </InfoItem>
          <InfoItem label="Department">{employee.department.name}</InfoItem>
          <InfoItem label="Designation">{employee.designation.name}</InfoItem>
          <InfoItem label="Official email">{employee.officialEmail}</InfoItem>
          <InfoItem label="Official phone">
            {employee.officialPhone ? formatPhone(employee.officialPhone) : null}
          </InfoItem>
          <InfoItem label="Reporting manager">
            {employee.reportingManager
              ? `${employee.reportingManager.fullName} (${employee.reportingManager.employeeCode})`
              : null}
          </InfoItem>
        </InfoGrid>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Locations</CardTitle>
            <CardDescription>
              Where this person works. One primary location at a time.
            </CardDescription>
          </div>
          <Can permission="employee:manage">
            {editable && (
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={() => setDialog('add')}>
                  <MapPinPlus /> Add Location
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDialog('transfer')}>
                  <ArrowRightLeft /> Transfer
                </Button>
              </div>
            )}
          </Can>
        </CardHeader>
        {assignments.isLoading ? (
          <Skeleton className="h-16" />
        ) : assignments.isError ? (
          <ErrorState
            error={assignments.error}
            onRetry={() => void assignments.refetch()}
            retrying={assignments.isFetching}
          />
        ) : open.length === 0 ? (
          <EmptyState
            illustration={<MapPin className="size-10 text-muted" aria-hidden="true" />}
            title="No current location"
            description="Add a location, or look at the History tab for earlier placements."
          />
        ) : (
          <ul className="divide-y divide-line" aria-label="Current and planned locations">
            {open.map((a) => (
              <li key={a.locationAssignmentId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {a.locationName}{' '}
                    <span className="font-mono text-xs text-muted">{a.locationCode}</span>
                  </p>
                  <p className="text-[13px] text-muted">
                    From {formatDateOnly(a.effectiveFrom)}
                    {a.effectiveTo ? ` to ${formatDateOnly(a.effectiveTo)}` : ''}
                  </p>
                </div>
                {a.isPrimary && (
                  <Badge tone="brand">
                    <Star /> Primary
                  </Badge>
                )}
                <AssignmentStatusChip status={a.status} />
                <Can permission="employee:manage">
                  {editable && !a.isPrimary && a.status === 'ACTIVE' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEnding(a)}
                      aria-label={`End ${a.locationName}`}
                    >
                      End
                    </Button>
                  )}
                  {editable && a.status === 'PLANNED' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCancelling(a)}
                      aria-label={`Cancel ${a.locationName}`}
                    >
                      Cancel
                    </Button>
                  )}
                </Can>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {dialog === 'add' && (
        <AddLocationDialog employee={employee} onClose={() => setDialog(null)} />
      )}
      {dialog === 'transfer' && (
        <TransferDialog employee={employee} onClose={() => setDialog(null)} />
      )}
      {ending && (
        <EndDialog employee={employee} assignment={ending} onClose={() => setEnding(null)} />
      )}
      {cancelling && <CancelDialog assignment={cancelling} onClose={() => setCancelling(null)} />}
    </div>
  );
}
