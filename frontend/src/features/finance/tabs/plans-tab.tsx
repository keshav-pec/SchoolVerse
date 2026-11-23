import { useState } from 'react';
import { Plus, Tags } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { Money } from '@/components/finance/money';
import { formatDateOnly } from '@/lib/format';
import { useClassOfferings } from '../../academic/api';
import { useStudentContext } from '../../students/context';
import { useFeePlans } from '../api';
import { AssignmentPanel } from '../assignment-panel';
import { FeeHeadsDrawer } from '../fee-heads-drawer';
import { PLANS_INTRO } from '../help-copy';
import { PlanBuilderDrawer } from '../plan-builder';

/** Fee Plans: the smart assignment panel, then the list of plans by class and version state. */
export function PlansTab() {
  const ctx = useStudentContext();
  const plans = useFeePlans(ctx.sessionId);
  const offerings = useClassOfferings(ctx.sessionId, ctx.locationId);
  const [target, setTarget] = useState<string | null>(null);
  const [heads, setHeads] = useState(false);
  const className = (id: string) => offerings.data?.find((o) => o.classId === id)?.displayName ?? 'A class';

  return (
    <div className="space-y-4">
      <TabIntro title="Fee Plans" need="required">
        {PLANS_INTRO}
      </TabIntro>
      <AssignmentPanel />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-bold">Plans for {ctx.session?.code ?? 'this year'}</h2>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => setHeads(true)}>
            <Tags /> Fee Types
          </Button>
          <Can permission="finance:fee_plan:manage">
            <Button onClick={() => setTarget('new')}>
              <Plus /> New Fee Plan
            </Button>
          </Can>
        </div>
      </div>
      {plans.isLoading && <Skeleton className="h-32" role="status" aria-label="Loading" />}
      {plans.isError && <ErrorState error={plans.error} onRetry={() => void plans.refetch()} retrying={plans.isFetching} />}
      {plans.data?.length === 0 && (
        <Card>
          <EmptyState
            title="No fee plans yet"
            description="A fee plan is the price list for a class. Add your fee types first, then make a plan with the amounts and due dates."
            action={
              <Can permission="finance:fee_plan:manage">
                <Button onClick={() => setTarget('new')}>
                  <Plus /> New Fee Plan
                </Button>
              </Can>
            }
          />
        </Card>
      )}
      <ul className="grid gap-3 lg:grid-cols-2" aria-label="Fee plans">
        {plans.data?.map((p) => {
          const shown = p.publishedVersion ?? p.latestVersion;
          return (
            <li key={p.planId}>
              <Card className="h-full">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <h3 className="text-base font-bold">{p.name}</h3>
                    <p className="text-[13px] text-muted">{p.appliesTo.classIds.length === 0 ? 'Every class' : p.appliesTo.classIds.map(className).join(', ')}</p>
                  </div>
                  {shown && <FinanceStatusPill status={shown.state} />}
                </div>
                <p className="mt-2 text-sm">
                  {shown ? (
                    <>
                      <b>
                        <Money paise={shown.yearlyPaise} />
                      </b>{' '}
                      <span className="text-muted">a year · version {shown.versionNo} · from {formatDateOnly(shown.effectiveFrom)}</span>
                    </>
                  ) : (
                    <span className="text-muted">No version yet.</span>
                  )}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {p.autoAssign && <Badge tone="brand">Assigns students automatically</Badge>}
                  {p.latestVersion && p.publishedVersion && p.latestVersion.versionId !== p.publishedVersion.versionId && p.latestVersion.state === 'DRAFT' && <Badge tone="sun">A new draft is waiting</Badge>}
                  <Button size="sm" variant="outline" className="ml-auto" onClick={() => setTarget(p.planId)} aria-label={`Open ${p.name}`}>
                    Open
                  </Button>
                </div>
              </Card>
            </li>
          );
        })}
      </ul>
      <PlanBuilderDrawer target={target} onClose={() => setTarget(null)} />
      <FeeHeadsDrawer open={heads} onOpenChange={setHeads} />
    </div>
  );
}
