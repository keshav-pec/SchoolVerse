import { useState } from 'react';
import { Download, Send } from 'lucide-react';
import { toast } from 'sonner';
import type { PayslipDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Can } from '@/components/sv/can';
import { ConfirmDialog } from '@/components/sv/confirm-dialog';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { TabIntro } from '@/components/sv/help';
import { Money } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { messageFor } from '@/lib/errors';
import { openPdf, useFinanceMutation } from '../api';
import { PAYSLIPS_INTRO } from '../help-copy';
import { payApi, usePayrollRuns, usePayslips } from '../ops-api';
import { PayslipLines } from './payslip-lines';
import { MonthPicker, monthName, usePayrollMonth } from './shared';

/** Payslips: published explicitly. Bank numbers never appear here. */
export function PayslipsTab() {
  const [month] = usePayrollMonth();
  const runs = usePayrollRuns({ month });
  const slips = usePayslips({ month });
  const [open, setOpen] = useState<PayslipDTO | null>(null);
  const [publishing, setPublishing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const publish = useFinanceMutation((runId: string) => payApi.publish(runId), { quiet: true, success: (r) => `${r.published} payslips published. Staff can see them in My Salary.` });
  const unpublished = (runs.data?.items ?? []).filter((r) => r.state === 'FINALIZED' && (slips.data ?? []).some((p) => p.runId === r.runId && !p.published));
  const pdf = async (id: string) => {
    setBusy(id);
    try {
      await openPdf(`/payroll/payslips/${id}/pdf`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-4">
      <TabIntro title="Payslips">{PAYSLIPS_INTRO}</TabIntro>
      <div className="flex flex-wrap items-center gap-2">
        <MonthPicker />
        <Can permission="payroll:run:prepare">
          {unpublished.map((r) => (
            <Button key={r.runId} onClick={() => setPublishing(r.runId)}>
              <Send /> Publish Payslips ({r.number})
            </Button>
          ))}
        </Can>
      </div>
      {slips.isLoading && <Skeleton className="h-32" />}
      {slips.isError && <ErrorState error={slips.error} onRetry={() => void slips.refetch()} retrying={slips.isFetching} />}
      {slips.data && slips.data.length === 0 && <EmptyState title={`No payslips for ${monthName(month)}`} description="Payslips are made when a payroll run is finalised." />}
      {slips.data && slips.data.length > 0 && (
        <ul className="divide-y divide-line rounded-xl border border-line bg-white" aria-label="Payslips">
          {slips.data.map((p) => (
            <li key={p.payslipId} className="px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <b>{p.employeeName}</b>
                <span className="text-muted">{p.number}</span>
                <span>
                  Net <Money paise={p.netPaise} strong />
                </span>
                <FinanceStatusPill status={p.published ? 'PUBLISHED' : 'DRAFT'} label={p.published ? 'Published' : 'Not Published'} />
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="ghost" onClick={() => setOpen(open?.payslipId === p.payslipId ? null : p)} aria-expanded={open?.payslipId === p.payslipId}>
                    View
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => void pdf(p.payslipId)} loading={busy === p.payslipId} loadingText="Opening…" aria-label={`Download payslip for ${p.employeeName}`}>
                    <Download /> PDF
                  </Button>
                </span>
              </div>
              {open?.payslipId === p.payslipId && <PayslipLines payslip={p} className="mt-2" />}
            </li>
          ))}
        </ul>
      )}
      <ConfirmDialog
        open={publishing !== null}
        onOpenChange={(o) => !o && setPublishing(null)}
        title="Publish payslips?"
        description="Every person in this run can then see and download their own payslip. A payslip never changes after this."
        confirmLabel="Publish Payslips"
        loadingLabel="Publishing…"
        onConfirm={async () => {
          await publish.mutateAsync(publishing!);
        }}
      />
    </div>
  );
}
