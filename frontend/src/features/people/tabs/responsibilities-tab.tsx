import { useState } from 'react';
import { Link } from 'react-router';
import {
  RESPONSIBILITY_SUGGESTIONS,
  type EmployeeProfileDTO,
  type ResponsibilityDTO,
} from '@shared';
import { ArrowRight, Plus, Wrench } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader } from '@/components/ui/card';
import { ComboboxField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { AssignmentStatusChip } from '@/components/sv/employee-status';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { HelpHeading, TabIntro } from '@/components/sv/help';
import { api } from '@/lib/api';
import { FormProblem } from '@/lib/errors';
import { formatDateOnly } from '@/lib/format';
import { useResponsibilities, usePeopleMutation } from '../api';
import { CancelAssignmentDialog, EndAssignmentDialog } from '../assignment-dialogs';
import { END_CANCEL_HELP } from '../help-copy';

function AddDialog({ employee, onClose }: { employee: EmployeeProfileDTO; onClose: () => void }) {
  const [locationId, setLocationId] = useState(
    employee.primaryLocation?.locationId ?? employee.locations[0]?.locationId ?? '',
  );
  const [responsibilityType, setType] = useState('');
  const [description, setDescription] = useState('');
  const [effectiveFrom, setFrom] = useState('');
  const add = usePeopleMutation(
    (body: object) => api.post(`/employees/${employee.employeeId}/responsibilities`, body),
    { quiet: true, success: 'Responsibility added.' },
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      icon={<Wrench className="size-5" />}
      title="Add a responsibility"
      description={`A job ${employee.displayName} looks after at one campus, such as the school buses or the library.`}
      confirmLabel="Add responsibility"
      loadingLabel="Adding…"
      onConfirm={async () => {
        if (!locationId) throw new FormProblem('Choose a location.');
        if (!responsibilityType.trim()) throw new FormProblem('Say what the responsibility is.');
        await add.mutateAsync({
          locationId,
          responsibilityType: responsibilityType.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          ...(effectiveFrom ? { effectiveFrom } : {}),
        });
      }}
    >
      <div className="space-y-4">
        <TextField
          label="Responsibility"
          required
          hint="Pick from the list or type your own."
          list="responsibility-suggestions"
          placeholder="Transport In-charge"
          value={responsibilityType}
          onChange={(e) => setType(e.target.value)}
        />
        <datalist id="responsibility-suggestions">
          {RESPONSIBILITY_SUGGESTIONS.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <ComboboxField
          label="Location"
          required
          value={locationId}
          onChange={setLocationId}
          options={employee.locations.map((l) => ({ value: l.locationId, label: l.displayName }))}
          searchPlaceholder="Search locations…"
        />
        <TextField
          label="Details"
          hint="Optional. For example: Routes 3 and 4."
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={200}
        />
        <TextField
          label="Starts on"
          type="date"
          hint="Leave blank to start today."
          value={effectiveFrom}
          onChange={(e) => setFrom(e.target.value)}
        />
      </div>
    </ConfirmDialog>
  );
}

export function ResponsibilitiesTab({ employee }: { employee: EmployeeProfileDTO }) {
  const list = useResponsibilities(employee.employeeId);
  const [adding, setAdding] = useState(false);
  const [ending, setEnding] = useState<ResponsibilityDTO | null>(null);
  const [cancelling, setCancelling] = useState<ResponsibilityDTO | null>(null);
  const canAdd = !employee.readOnly && employee.locations.length > 0;

  const noLocation = !employee.readOnly && employee.locations.length === 0;
  return (
    <div className="space-y-4">
      <TabIntro title="Responsibilities" need="required">
        <p>
          What {employee.displayName} looks after, such as <b>Transport In-charge</b>,{' '}
          <b>Library</b> or <b>Reception</b>. Each one belongs to one campus. Add at least one so
          everyone knows who to ask.
        </p>
      </TabIntro>
      <Card>
        <CardHeader>
          <div>
            <HelpHeading
              title="Responsibilities"
              help={
                <>
                  <p>Each row is one job at one campus. A person can have several.</p>
                  {END_CANCEL_HELP}
                </>
              }
            />
            <CardDescription>What this person looks after, at which campus.</CardDescription>
          </div>
          <Can permission="employee:manage">
            {canAdd && (
              <Button size="sm" onClick={() => setAdding(true)}>
                <Plus /> Add Responsibility
              </Button>
            )}
          </Can>
        </CardHeader>
        {noLocation && (
          <Alert tone="warning" className="mb-4">
            <p>
              {employee.displayName} has no current campus, so a responsibility can’t be added yet.
              Add a location on the Overview tab first.
            </p>
            <Button asChild size="sm" variant="outline" className="mt-2">
              <Link to="?tab=overview">
                Go To Overview <ArrowRight />
              </Link>
            </Button>
          </Alert>
        )}
        {list.isLoading ? (
          <Skeleton className="h-24" />
        ) : list.isError ? (
          <ErrorState
            error={list.error}
            onRetry={() => void list.refetch()}
            retrying={list.isFetching}
          />
        ) : (list.data ?? []).length === 0 ? (
          <EmptyState
            illustration={<Wrench className="size-10 text-muted" aria-hidden="true" />}
            title="No responsibilities yet"
            description={canAdd ? 'Add one, for example Transport In-charge or Library.' : undefined}
          />
        ) : (
          <ul className="divide-y divide-line" aria-label="Responsibilities">
            {(list.data ?? []).map((r) => (
              <li key={r.responsibilityId} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">{r.responsibilityType}</p>
                  <p className="text-[13px] text-muted">
                    {r.locationName} · from {formatDateOnly(r.effectiveFrom)}
                    {r.effectiveTo ? ` to ${formatDateOnly(r.effectiveTo)}` : ''}
                    {r.description ? ` · ${r.description}` : ''}
                  </p>
                </div>
                <AssignmentStatusChip status={r.status} />
                <Can permission="employee:manage">
                  {!employee.readOnly && r.status === 'ACTIVE' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEnding(r)}
                      aria-label={`End ${r.responsibilityType}`}
                    >
                      End
                    </Button>
                  )}
                  {!employee.readOnly && r.status === 'PLANNED' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setCancelling(r)}
                      aria-label={`Cancel ${r.responsibilityType}`}
                    >
                      Cancel
                    </Button>
                  )}
                </Can>
              </li>
            ))}
          </ul>
        )}
        {adding && <AddDialog employee={employee} onClose={() => setAdding(false)} />}
        {ending && (
          <EndAssignmentDialog
            path={`/responsibilities/${ending.responsibilityId}/end`}
            title={`End ${ending.responsibilityType}?`}
            onClose={() => setEnding(null)}
          />
        )}
        {cancelling && (
          <CancelAssignmentDialog
            path={`/responsibilities/${cancelling.responsibilityId}/cancel`}
            title={`Cancel ${cancelling.responsibilityType}?`}
            onClose={() => setCancelling(null)}
          />
        )}
      </Card>
    </div>
  );
}
