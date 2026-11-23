import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { BellRing } from 'lucide-react';
import type { Permission } from '@shared';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Can } from '@/components/sv/can';
import { PageHeader } from '@/components/sv/page-header';
import { useAuth } from '@/lib/auth';
import { useVerificationQueue } from '../ops-api';
import { ChequesTab } from './cheques-tab';
import { RemindersDrawer } from './drawers';
import { ReceiptsTab } from './receipts-tab';
import { RefundsTab } from './refunds-tab';
import { ShiftTab } from './shift-tab';
import { TakePayment } from './take-payment';
import { VerifyTab } from './verify-tab';

const TABS: { id: string; label: string; any: Permission[] }[] = [
  { id: 'take', label: 'Take Payment', any: ['finance:collection:record'] },
  { id: 'verify', label: 'Waiting for Verification', any: ['finance:collection:verify'] },
  { id: 'cheques', label: 'Cheques', any: ['finance:view'] },
  { id: 'receipts', label: 'Receipts', any: ['finance:view'] },
  { id: 'refunds', label: 'Refunds', any: ['finance:view'] },
  { id: 'shift', label: 'My Shift', any: ['finance:cashier:shift', 'finance:cashier:supervise'] },
];

/** `/finance/collect`: everything about money coming in. The tab lives in the address (`?tab=verify`). */
export function CollectPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [reminders, setReminders] = useState(false);
  const tabs = TABS.filter((t) => t.any.some(can));
  const requested = params.get('tab');
  const tab = tabs.find((t) => t.id === requested)?.id ?? tabs[0]?.id ?? 'receipts';
  const queue = useVerificationQueue(can('finance:collection:verify'));
  return (
    <>
      <PageHeader
        eyebrow="Finance"
        title="Collect Payments"
        description="Take fees, check payments in the bank, and give receipts."
        actions={
          <Can permission="finance:billing:create">
            <Button variant="outline" onClick={() => setReminders(true)}>
              <BellRing /> Send Reminders
            </Button>
          </Can>
        }
      />
      <Tabs
        value={tab}
        onValueChange={(v) =>
          setParams((p) => {
            const n = new URLSearchParams(p);
            n.set('tab', v);
            if (v !== 'take') {
              n.delete('student');
              n.delete('guardian');
            }
            return n;
          })
        }
      >
        <TabsList aria-label="Collect payments sections">
          {tabs.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
              {t.id === 'verify' && (queue.data?.total ?? 0) > 0 && (
                <span className="ml-1.5 grid min-w-5 place-items-center rounded-full bg-sun px-1.5 text-[11px] leading-5 font-bold text-navy" aria-label={`${queue.data!.total} waiting`}>
                  {queue.data!.total}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="take">{tab === 'take' && <TakePayment />}</TabsContent>
        <TabsContent value="verify">{tab === 'verify' && <VerifyTab />}</TabsContent>
        <TabsContent value="cheques">{tab === 'cheques' && <ChequesTab />}</TabsContent>
        <TabsContent value="receipts">{tab === 'receipts' && <ReceiptsTab />}</TabsContent>
        <TabsContent value="refunds">{tab === 'refunds' && <RefundsTab />}</TabsContent>
        <TabsContent value="shift">{tab === 'shift' && <ShiftTab />}</TabsContent>
      </Tabs>
      <RemindersDrawer open={reminders} onClose={() => setReminders(false)} />
    </>
  );
}
