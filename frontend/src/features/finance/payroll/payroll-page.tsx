import { useSearchParams } from 'react-router';
import type { Permission } from '@shared';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { AdvancesTab } from './advances-tab';
import { InputsTab } from './inputs-tab';
import { PaymentsTab } from './payments-tab';
import { PayslipsTab } from './payslips-tab';
import { PayrollReportsTab } from './reports-tab';
import { RunsTab } from './runs-tab';
import { SetupTab } from './setup-tab';

const TABS: { id: string; label: string; any: Permission[] }[] = [
  { id: 'runs', label: 'Payroll Runs', any: ['payroll:run:prepare', 'payroll:run:approve', 'payroll:report:view'] },
  { id: 'setup', label: 'Salary Setup', any: ['payroll:setup:manage', 'payroll:structure:manage', 'payroll:run:approve'] },
  { id: 'inputs', label: 'Inputs', any: ['payroll:input:manage'] },
  { id: 'advances', label: 'Advances', any: ['payroll:input:manage', 'payroll:run:approve', 'payroll:disbursement:manage'] },
  { id: 'payments', label: 'Payments', any: ['payroll:disbursement:manage', 'payroll:disbursement:verify'] },
  { id: 'payslips', label: 'Payslips', any: ['payroll:salary:view_sensitive'] },
  { id: 'reports', label: 'Reports', any: ['payroll:report:view'] },
];

/** `/finance/payroll`: the tab and the month live in the address (`?tab=inputs&month=2026-11`). */
export function PayrollPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const tabs = TABS.filter((t) => t.any.some(can));
  const tab = tabs.find((t) => t.id === params.get('tab'))?.id ?? tabs[0]?.id ?? 'runs';
  return (
    <>
      <PageHeader eyebrow="Finance" title="Payroll" description="Salaries, payslips and salary payments." />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          setParams((p) => {
            const n = new URLSearchParams(p);
            n.set('tab', v);
            return n;
          })
        }
      >
        <TabsList aria-label="Payroll sections">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="runs">{tab === 'runs' && <RunsTab />}</TabsContent>
        <TabsContent value="setup">{tab === 'setup' && <SetupTab />}</TabsContent>
        <TabsContent value="inputs">{tab === 'inputs' && <InputsTab />}</TabsContent>
        <TabsContent value="advances">{tab === 'advances' && <AdvancesTab />}</TabsContent>
        <TabsContent value="payments">{tab === 'payments' && <PaymentsTab />}</TabsContent>
        <TabsContent value="payslips">{tab === 'payslips' && <PayslipsTab />}</TabsContent>
        <TabsContent value="reports">{tab === 'reports' && <PayrollReportsTab />}</TabsContent>
      </Tabs>
    </>
  );
}
