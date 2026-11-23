import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/sv/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth';
import { AccessTab } from './settings/access-tab';
import { ApprovalsTab } from './settings/approvals-tab';
import { BankTab } from './settings/bank-tab';
import { ChartTab } from './settings/chart-tab';
import { ChecklistTab } from './settings/checklist-tab';
import { SchoolTaxTab } from './settings/school-tax-tab';
import { YearsTab } from './settings/years-tab';

/** `/finance/settings`. The tab is kept in the address (`?tab=bank`), so the Fix buttons of the checklist can land on the right one. */
export function FinanceSettingsPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = [
    { id: 'checklist', label: 'Setup Checklist', show: true },
    { id: 'school', label: 'School & Tax', show: true },
    { id: 'chart', label: 'Chart of Accounts', show: true },
    { id: 'years', label: 'Years & Periods', show: true },
    { id: 'bank', label: 'Bank & Cash', show: true },
    { id: 'approvals', label: 'Approvals', show: true },
    { id: 'access', label: 'Access', show: can('finance:access:manage') },
  ].filter((t) => t.show);
  const requested = params.get('tab');
  const tab = tabs.some((t) => t.id === requested) ? (requested as string) : 'checklist';
  return (
    <>
      <PageHeader eyebrow="Finance" title="Finance Settings" description="Set up the school’s money once. Everything else uses it." />
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
        <TabsList aria-label="Finance settings sections">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="checklist">
          <ChecklistTab />
        </TabsContent>
        <TabsContent value="school">
          <SchoolTaxTab />
        </TabsContent>
        <TabsContent value="chart">
          <ChartTab />
        </TabsContent>
        <TabsContent value="years">
          <YearsTab />
        </TabsContent>
        <TabsContent value="bank">
          <BankTab />
        </TabsContent>
        <TabsContent value="approvals">
          <ApprovalsTab />
        </TabsContent>
        {can('finance:access:manage') && (
          <TabsContent value="access">
            <AccessTab />
          </TabsContent>
        )}
      </Tabs>
    </>
  );
}
