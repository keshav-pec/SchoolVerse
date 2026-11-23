import { useSearchParams } from 'react-router';
import { PageHeader } from '@/components/sv/page-header';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AccountsTab } from './tabs/accounts-tab';
import { AdjustmentsTab } from './tabs/adjustments-tab';
import { BillingTab } from './tabs/billing-tab';
import { ConcessionsTab } from './tabs/concessions-tab';
import { PlansTab } from './tabs/plans-tab';

const TABS = [
  { id: 'accounts', label: 'Accounts' },
  { id: 'billing', label: 'Billing' },
  { id: 'plans', label: 'Fee Plans' },
  { id: 'concessions', label: 'Concessions' },
  { id: 'adjustments', label: 'Adjustments' },
] as const;

/** `/finance/fees`: the tab is kept in the address (`?tab=billing`), so a link or a reload lands on the same tab. */
export function FeesPage() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = TABS.some((t) => t.id === requested) ? (requested as string) : 'accounts';
  return (
    <>
      <PageHeader eyebrow="Finance" title="Student Fees" description="Fee plans, bills, discounts and each student’s account." />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          setParams((p) => {
            const next = new URLSearchParams(p);
            next.set('tab', v);
            next.delete('family');
            return next;
          })
        }
      >
        <TabsList aria-label="Student fees sections">
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="accounts">
          <AccountsTab />
        </TabsContent>
        <TabsContent value="billing">
          <BillingTab />
        </TabsContent>
        <TabsContent value="plans">
          <PlansTab />
        </TabsContent>
        <TabsContent value="concessions">
          <ConcessionsTab />
        </TabsContent>
        <TabsContent value="adjustments">
          <AdjustmentsTab />
        </TabsContent>
      </Tabs>
    </>
  );
}
