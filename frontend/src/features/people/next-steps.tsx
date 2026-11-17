import type { ReactNode } from 'react';
import type { EmployeeProfileDTO } from '@shared';
import { Check, Circle, ListChecks } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/lib/auth';
import {
  useEmployeeAccount,
  useEmployeeDocuments,
  useFacultyAssignments,
  useResponsibilities,
} from './api';

interface Step {
  key: string;
  label: string;
  detail: string;
  done: boolean;
  action: ReactNode;
}

/**
 * Right after onboarding: what is left before this person is fully set up (PRD §10.1 / §10.2). Faculty need classes,
 * staff need a responsibility; everyone needs documents, a login, and to be activated.
 */
export function NextSteps({
  employee,
  onGoTo,
  onActivate,
}: {
  employee: EmployeeProfileDTO;
  onGoTo: (tab: string) => void;
  onActivate: () => void;
}) {
  const { can } = useAuth();
  const isFaculty = employee.employeeCategory === 'FACULTY';
  const classes = useFacultyAssignments(employee.employeeId, undefined, isFaculty);
  const responsibilities = useResponsibilities(employee.employeeId, !isFaculty);
  const documents = useEmployeeDocuments(employee.employeeId, can('employee:documents'));
  const account = useEmployeeAccount(employee.employeeId, can('user:view'));

  const hasWork = isFaculty
    ? (classes.data ?? []).some((a) => a.status !== 'CANCELLED')
    : (responsibilities.data ?? []).some((r) => r.status !== 'CANCELLED');
  const steps: Step[] = [
    {
      key: 'work',
      label: isFaculty ? 'Assign classes' : 'Assign a responsibility',
      detail: isFaculty
        ? 'Subjects and sections they teach this session.'
        : 'For example Transport In-charge or Library.',
      done: hasWork,
      action: (
        <Button
          size="sm"
          variant="outline"
          onClick={() => onGoTo(isFaculty ? 'academic' : 'responsibilities')}
        >
          {isFaculty ? 'Assign classes' : 'Add responsibility'}
        </Button>
      ),
    },
    {
      key: 'documents',
      label: 'Upload documents',
      detail: 'ID proof, qualifications, contract.',
      done: (documents.data ?? []).length > 0,
      action: (
        <Button size="sm" variant="outline" onClick={() => onGoTo('documents')}>
          Upload documents
        </Button>
      ),
    },
    {
      key: 'login',
      label: 'Create a login',
      detail: 'Optional. Not every employee needs one.',
      done: !!account.data?.account,
      action: (
        <Button size="sm" variant="outline" onClick={() => onGoTo('account')}>
          Create login
        </Button>
      ),
    },
    {
      key: 'activate',
      label: 'Activate',
      detail: 'Makes them a current member of staff.',
      done: employee.status !== 'ONBOARDING',
      action: (
        <Button size="sm" onClick={onActivate}>
          Activate
        </Button>
      ),
    },
  ].filter((s) =>
    s.key === 'documents' ? can('employee:documents') : s.key === 'login' ? can('user:view') : true,
  );

  const doneCount = steps.filter((s) => s.done).length;
  return (
    <Card className="mb-6 border-brand/25 bg-brand-soft/40">
      <CardHeader className="mb-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <ListChecks className="size-5 text-brand" aria-hidden="true" /> Next steps
          </CardTitle>
          <CardDescription>
            {doneCount} of {steps.length} done. Do them in any order.
          </CardDescription>
        </div>
      </CardHeader>
      <ol className="space-y-2" aria-label="Next steps">
        {steps.map((s) => (
          <li
            key={s.key}
            className="flex flex-wrap items-center gap-3 rounded-xl bg-white px-4 py-3"
          >
            <span className={s.done ? 'text-success' : 'text-muted'} aria-hidden="true">
              {s.done ? <Check className="size-5" /> : <Circle className="size-5" />}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">
                {s.label}
                {s.done && <span className="sr-only"> (done)</span>}
              </p>
              <p className="text-[13px] text-muted">{s.detail}</p>
            </div>
            {!s.done && s.action}
          </li>
        ))}
      </ol>
    </Card>
  );
}
