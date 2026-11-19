import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { Alert } from '@/components/ui/alert';
import { InfoTip } from '@/components/ui/tooltip';
import { ErrorState } from '@/components/sv/error-state';
import { useClassOfferings } from './api';

/** A class-offering select used by the Subjects and Subject Choice Rules tabs. Renders `children(classOfferingId, classOfferings)` once one is chosen. */
export function ClassPicker({
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
  children: (classOfferingId: string) => React.ReactNode;
}) {
  const classes = useClassOfferings(sessionId, locationId);
  if (classes.isLoading) return <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading classes" />;
  if (classes.isError) return <ErrorState error={classes.error} onRetry={() => void classes.refetch()} retrying={classes.isFetching} />;
  const list = classes.data ?? [];
  if (list.length === 0) return <Alert tone="info">Add classes to this location on the Classes &amp; Sections tab first.</Alert>;
  const current = list.some((g) => g.classOfferingId === value) ? value : list[0]!.classOfferingId;
  return (
    <div className="space-y-5">
      <div className="max-w-xs">
        <ComboboxField
          label="Class"
          labelAside={<InfoTip label="Why pick a class?">Each class is set up on its own. Pick the class you want to work on; the list below changes to match it.</InfoTip>}
          value={current}
          onChange={onChange}
          options={list.map((g) => ({ value: g.classOfferingId, label: g.displayName, hint: g.status === 'INACTIVE' ? 'Inactive' : undefined }))}
          searchPlaceholder="Search classes…"
        />
      </div>
      {children(current)}
    </div>
  );
}
