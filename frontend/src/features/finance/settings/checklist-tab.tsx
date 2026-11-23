import { useState, type ComponentType } from 'react';
import { Link } from 'react-router';
import { ArrowLeft, ArrowRight, CircleCheck, CircleDashed, CircleMinus, Compass, Wand2 } from 'lucide-react';
import type { ReadinessStatus } from '@shared';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { cn } from '@/lib/utils';
import { useReadiness, useStandardSetup } from '../api';
import { CHECKLIST_INTRO } from '../help-copy';
import { BankTab } from './bank-tab';
import { ChartTab } from './chart-tab';
import { SchoolTaxTab } from './school-tax-tab';
import { YearsTab } from './years-tab';

const ICON: Record<ReadinessStatus, { Icon: ComponentType<{ className?: string }>; cls: string; label: string }> = {
  DONE: { Icon: CircleCheck, cls: 'text-success', label: 'Done' },
  NEEDS_ATTENTION: { Icon: CircleDashed, cls: 'text-warning', label: 'Needs attention' },
  NOT_NEEDED: { Icon: CircleMinus, cls: 'text-muted', label: 'Not needed' },
};

/** First-time walk-through. Each step is the real tab, so what is saved here is saved for good. Back and Skip are always there. */
const STEPS = [
  { title: 'School & Tax', body: <SchoolTaxTab /> },
  { title: 'Financial year', body: <YearsTab /> },
  { title: 'Chart of accounts', body: <ChartTab /> },
  { title: 'Bank account', body: <BankTab /> },
  {
    title: 'Fee types',
    body: (
      <div className="space-y-3 text-sm">
        <p>The last step is to add your fee types, like Tuition and Annual Fee, and then make a fee plan. This is done on the Fee Plans page.</p>
        <Button asChild>
          <Link to="/finance/fees?tab=plans">
            Open Fee Plans <ArrowRight />
          </Link>
        </Button>
      </div>
    ),
  },
];

function GuidedSetup({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [step, setStep] = useState(0);
  const current = STEPS[step]!;
  const last = step === STEPS.length - 1;
  return (
    <Modal
      open={open}
      onOpenChange={(o) => !o && onClose()}
      title={`Step ${step + 1} of ${STEPS.length}: ${current.title}`}
      description="You can skip a step and come back to it later from the checklist."
      className="max-w-3xl"
      footer={
        <>
          <Button variant="outline" disabled={step === 0} onClick={() => setStep(step - 1)}>
            <ArrowLeft /> Back
          </Button>
          {!last && (
            <Button variant="ghost" onClick={() => setStep(step + 1)}>
              Skip
            </Button>
          )}
          <Button onClick={() => (last ? onClose() : setStep(step + 1))}>{last ? 'Finish' : 'Next'}</Button>
        </>
      }
    >
      {current.body}
    </Modal>
  );
}

/** The Setup Checklist: what is done, what needs attention, and a Fix button for each. */
export function ChecklistTab() {
  const q = useReadiness();
  const standard = useStandardSetup();
  const [guide, setGuide] = useState(false);
  const d = q.data;
  return (
    <div className="space-y-4">
      <TabIntro title="Setup Checklist" need="required">
        {CHECKLIST_INTRO}
      </TabIntro>
      {q.isLoading && <Skeleton className="h-48" role="status" aria-label="Loading" />}
      {q.isError && <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />}
      {d && (
        <>
          <Card className="flex flex-wrap items-center justify-between gap-3" aria-label="Setup progress">
            <div>
              <p className="text-lg font-extrabold" data-testid="readiness-headline">
                {d.headline}
              </p>
              <div className="mt-2 h-2 w-64 max-w-full overflow-hidden rounded-full bg-ink/10" role="progressbar" aria-valuemin={0} aria-valuemax={d.total} aria-valuenow={d.ready} aria-label="Setup progress">
                <div className="h-full rounded-full bg-brand" style={{ width: `${d.total ? (d.ready / d.total) * 100 : 0}%` }} />
              </div>
            </div>
            <Can permission="finance:setup:manage">
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" onClick={() => standard.mutate()} loading={standard.isPending} loadingText="Setting up…">
                  <Wand2 /> Use The Standard Setup
                </Button>
                <Button onClick={() => setGuide(true)}>
                  <Compass /> Guide Me
                </Button>
              </div>
            </Can>
          </Card>
          <Card>
            <ul className="divide-y divide-line" aria-label="Setup checklist">
              {d.items.map((item) => {
                const { Icon, cls, label } = ICON[item.status];
                return (
                  <li key={item.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3" data-status={item.status}>
                    <Icon className={cn('size-5 shrink-0', cls)} aria-label={label} />
                    <div className="min-w-0 flex-1">
                      <p className="font-semibold">{item.title}</p>
                      <p className="text-sm text-muted">{item.sentence}</p>
                    </div>
                    {item.fix && (
                      <Button asChild size="sm" variant={item.status === 'NEEDS_ATTENTION' ? 'default' : 'outline'}>
                        <Link to={item.fix.path} aria-label={`Fix: ${item.title}`}>
                          Fix <span className="sr-only">{item.fix.label}</span>
                        </Link>
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          </Card>
        </>
      )}
      {guide && <GuidedSetup open onClose={() => setGuide(false)} />}
    </div>
  );
}
