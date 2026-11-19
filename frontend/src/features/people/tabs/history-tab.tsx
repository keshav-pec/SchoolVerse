import { ACADEMIC_ASSIGNMENT_TYPE_LABELS } from '@shared';
import { History } from 'lucide-react';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { AssignmentStatusChip } from '@/components/sv/employee-status';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { formatDateOnly } from '@/lib/format';
import { ActivityList } from '../../locations/activity-timeline';
import { useEmployeeHistory } from '../api';

function range(from: string, to: string | null) {
  return `${formatDateOnly(from)}${to ? ` – ${formatDateOnly(to)}` : ' – now'}`;
}

function HistoryList({
  title,
  empty,
  rows,
}: {
  title: string;
  empty: string;
  rows: {
    key: string;
    label: string;
    detail: string;
    status: Parameters<typeof AssignmentStatusChip>[0]['status'];
  }[];
}) {
  return (
    <Card>
      <CardHeader className="mb-2">
        <CardTitle className="text-base">{title}</CardTitle>
      </CardHeader>
      {rows.length === 0 ? (
        <p className="text-sm text-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-line" aria-label={title}>
          {rows.map((r) => (
            <li key={r.key} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{r.label}</p>
                <p className="text-[13px] text-muted">{r.detail}</p>
              </div>
              <AssignmentStatusChip status={r.status} />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

/** Every placement, class and responsibility the person ever had (with its status), then the audit timeline. */
export function HistoryTab({ employeeId }: { employeeId: string }) {
  const q = useEmployeeHistory(employeeId);
  if (q.isLoading) return <Skeleton className="h-64 rounded-card" />;
  if (q.isError || !q.data)
    return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const h = q.data;

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-2">
        <HistoryList
          title="Locations"
          empty="No placements."
          rows={h.locationAssignments.map((a) => ({
            key: a.locationAssignmentId,
            label: `${a.locationName}${a.isPrimary ? ' (primary)' : ''}`,
            detail: range(a.effectiveFrom, a.effectiveTo),
            status: a.status,
          }))}
        />
        <HistoryList
          title="Responsibilities"
          empty="No responsibilities."
          rows={h.responsibilities.map((r) => ({
            key: r.responsibilityId,
            label: r.responsibilityType,
            detail: `${r.locationName} · ${range(r.effectiveFrom, r.effectiveTo)}`,
            status: r.status,
          }))}
        />
      </div>
      {h.academicAssignments.length > 0 && (
        <HistoryList
          title="Classes"
          empty=""
          rows={h.academicAssignments.map((a) => ({
            key: a.academicAssignmentId,
            label: `${a.sectionName ? `${a.schoolClassName} · ${a.sectionName}` : a.schoolClassName}${a.subjectName ? ` · ${a.subjectName}` : ''}`,
            detail: `${ACADEMIC_ASSIGNMENT_TYPE_LABELS[a.assignmentType]} · ${a.sessionCode} · ${range(a.effectiveFrom, a.effectiveTo)}`,
            status: a.status,
          }))}
        />
      )}
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Activity</CardTitle>
            <CardDescription>
              Who changed what, and when. Personal and restricted values are never shown here.
            </CardDescription>
          </div>
        </CardHeader>
        {h.events.length === 0 ? (
          <EmptyState
            illustration={<History className="size-12 text-muted" aria-hidden="true" />}
            title="No activity yet"
          />
        ) : (
          <ActivityList events={h.events} />
        )}
      </Card>
    </div>
  );
}
