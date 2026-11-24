import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/sv/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { CreatePlanCard, useTimetablePlan } from './context';
import { AvailabilityTab } from './tabs/availability-tab';
import { GroupsTab } from './tabs/groups-tab';
import { NeedsTab } from './tabs/needs-tab';
import { PeriodsTab } from './tabs/periods-tab';
import { WeekTab } from './tabs/week-tab';

const TABS = [
  { id: 'week', label: 'School Week' },
  { id: 'periods', label: 'Daily Periods' },
  { id: 'needs', label: 'Subject Needs' },
  { id: 'availability', label: 'Teacher Availability' },
  { id: 'groups', label: 'Teaching Groups' },
] as const;

/** `/timetable/setup`. The tab lives in the address (`?tab=needs`), so the Fix buttons on the Overview land on the right one. */
export function TimetableSetupPage() {
  const { can } = useAuth();
  const { plan, loading } = useTimetablePlan();
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = TABS.some((t) => t.id === requested) ? (requested as string) : 'week';
  const canEdit = can('timetable:setup:manage');

  return (
    <>
      <PageHeader eyebrow="Timetable" title="Timetable Setup" description="Set up the week once. The timetable is built from this." />
      {loading && <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading" />}
      {!loading && !plan && <CreatePlanCard />}
      {plan && (
        <Tabs
          value={tab}
          onValueChange={(v) =>
            setParams((p) => {
              const next = new URLSearchParams(p);
              next.set('tab', v);
              return next;
            })
          }
        >
          <TabsList aria-label="Timetable setup sections">
            {TABS.map((t) => (
              <TabsTrigger key={t.id} value={t.id}>
                {t.label}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="week">
            <WeekTab plan={plan} canEdit={canEdit} />
          </TabsContent>
          <TabsContent value="periods">
            <PeriodsTab plan={plan} canEdit={canEdit} />
          </TabsContent>
          <TabsContent value="needs">
            <NeedsTab plan={plan} canEdit={canEdit} />
          </TabsContent>
          <TabsContent value="availability">
            <AvailabilityTab plan={plan} canEdit={can('timetable:faculty_availability:manage')} />
          </TabsContent>
          <TabsContent value="groups">
            <GroupsTab plan={plan} canEdit={canEdit} />
          </TabsContent>
        </Tabs>
      )}
    </>
  );
}
