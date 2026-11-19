import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert } from '@/components/ui/alert';
import { ErrorState } from '@/components/sv/error-state';
import { useGradeOfferings } from './api';

/** A grade-offering select used by the Subjects and Choice Rules tabs. Renders `children(gradeOfferingId, gradeOfferings)` once one is chosen. */
export function GradePicker({
  sessionId,
  locationId,
  value,
  onChange,
  children,
}: {
  sessionId: string;
  locationId: string;
  value: string;
  onChange: (id: string) => void;
  children: (gradeOfferingId: string) => React.ReactNode;
}) {
  const grades = useGradeOfferings(sessionId, locationId);
  if (grades.isLoading) return <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading grades" />;
  if (grades.isError) return <ErrorState error={grades.error} onRetry={() => void grades.refetch()} retrying={grades.isFetching} />;
  const list = grades.data ?? [];
  if (list.length === 0) return <Alert tone="info">Add grades to this location on the Grades &amp; Sections tab first.</Alert>;
  const current = list.some((g) => g.gradeOfferingId === value) ? value : list[0]!.gradeOfferingId;
  return (
    <div className="space-y-5">
      <div className="max-w-xs">
        <ComboboxField
          label="Grade"
          value={current}
          onChange={onChange}
          options={list.map((g) => ({ value: g.gradeOfferingId, label: g.displayName, hint: g.status === 'INACTIVE' ? 'Inactive' : undefined }))}
          searchPlaceholder="Search grades…"
        />
      </div>
      {children(current)}
    </div>
  );
}
