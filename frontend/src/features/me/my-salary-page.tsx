import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, Wallet } from 'lucide-react';
import { toast } from 'sonner';
import type { PayslipDTO, TaxDeclarationDTO } from '@shared';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { Money, MoneyField } from '@/components/finance/money';
import { FinanceStatusPill } from '@/components/finance/status-pill';
import { openPdf } from '@/features/finance/api';
import { myApi, useMyAdvances, useMyPayrollSummary, useMyPayslips } from '@/features/finance/ops-api';
import { PayslipLines } from '@/features/finance/payroll/payslip-lines';
import { monthName } from '@/features/finance/payroll/shared';
import { ApiError } from '@/lib/api';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/money';

const PAY_STATUS: Record<string, { status: string; label: string }> = {
  PAID: { status: 'PAID', label: 'Paid' },
  CHECKING: { status: 'RECORDED', label: 'Paid · Being Checked' },
  NOT_PAID: { status: 'UNPAID', label: 'Not Paid Yet' },
};

function Big({ label, paise }: { label: string; paise: number }) {
  return (
    <div role="group" aria-label={label} className="rounded-xl bg-canvas px-3 py-2">
      <p className="text-[13px] text-muted">{label}</p>
      <p className="text-lg font-extrabold tabular-nums">{formatMoney(paise)}</p>
    </div>
  );
}

function SlipCard({ p, first }: { p: PayslipDTO; first: boolean }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const pay = PAY_STATUS[p.paymentStatus ?? 'NOT_PAID']!;
  const download = async () => {
    setBusy(true);
    try {
      await openPdf(`/me/payslips/${p.payslipId}/pdf`);
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section aria-label={`Payslip for ${monthName(p.month)}`} className="rounded-card border border-line bg-white p-4 shadow-card">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-base font-extrabold">{monthName(p.month)}</h2>
        <FinanceStatusPill status={pay.status} label={pay.label} />
      </div>
      {first ? (
        <div className="mt-3 grid grid-cols-3 gap-2">
          <Big label="Gross" paise={p.grossPaise} />
          <Big label="Deductions" paise={p.deductionsPaise} />
          <Big label="Net Pay" paise={p.netPaise} />
        </div>
      ) : (
        <p className="mt-1 text-sm">
          Net <Money paise={p.netPaise} strong /> <span className="text-muted">· gross {formatMoney(p.grossPaise)}</span>
        </p>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" variant="outline" className="min-h-11" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          View Breakdown
        </Button>
        <Button size="sm" variant="outline" className="min-h-11" onClick={() => void download()} loading={busy} loadingText="Opening…">
          <Download /> Download Payslip
        </Button>
      </div>
      {open && <PayslipLines payslip={p} className="mt-3" />}
    </section>
  );
}

function TaxForm({ current }: { current: TaxDeclarationDTO | null }) {
  const qc = useQueryClient();
  const [regime, setRegime] = useState<string>(current?.regime ?? 'NEW');
  const [yearly, setYearly] = useState<number | null>(current?.estimatedYearlyTaxPaise ?? null);
  const [deducted, setDeducted] = useState<number | null>(current?.alreadyDeductedPaise ?? 0);
  const save = useMutation({
    mutationFn: () => myApi.saveDeclaration({ regime, estimatedYearlyTaxPaise: yearly ?? 0, alreadyDeductedPaise: deducted ?? 0 }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['me', 'payroll'] });
      toast.success('Saved. Your monthly tax deduction is worked out from this.');
    },
    onError: (e) => toast.error(messageFor(e)),
  });
  return (
    <Card aria-label="Income tax">
      <CardHeader>
        <CardTitle>Income tax (TDS)</CardTitle>
      </CardHeader>
      <p className="mb-3 text-sm text-muted">Tell the school your expected tax for the year. It is taken in equal parts from the months left. {current && <>Now: {formatMoney(current.monthlyPaise)} a month.</>}</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <ComboboxField
          label="Tax regime"
          value={regime}
          onChange={setRegime}
          searchPlaceholder="Search…"
          options={[
            { value: 'NEW', label: 'New regime' },
            { value: 'OLD', label: 'Old regime' },
          ]}
        />
        <MoneyField label="Expected tax this year" value={yearly} onChange={setYearly} />
        <MoneyField label="Already deducted elsewhere" value={deducted} onChange={setDeducted} hint="Optional. Example: by a previous employer." />
      </div>
      <Button className="mt-3 min-h-11" disabled={yearly === null} loading={save.isPending} loadingText="Saving…" onClick={() => save.mutate()}>
        Save Tax Details
      </Button>
    </Card>
  );
}

/** `/me/salary`: the signed-in employee's own pay, and nobody else's. The API reads the person from the session, never from the address. */
export function MySalaryPage() {
  const summary = useMyPayrollSummary();
  const linked = summary.isSuccess;
  const slips = useMyPayslips(linked);
  const advances = useMyAdvances(linked);

  if (summary.isLoading) return <Skeleton className="h-64 rounded-card" role="status" aria-label="Loading" />;
  if (summary.isError) {
    if (summary.error instanceof ApiError && summary.error.status === 404)
      return <EmptyState illustration={<Wallet className="size-14 text-muted" aria-hidden="true" />} title="No salary record" description="Your login is not linked to an employee record, so there is no salary to show. Please ask the school office." />;
    return <ErrorState error={summary.error} onRetry={() => void summary.refetch()} retrying={summary.isFetching} />;
  }
  const list = slips.data ?? [];
  const open = (advances.data ?? []).filter((a) => a.state === 'PAID_OUT' && a.remainingPaise > 0);
  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        <h1 className="flex items-center gap-2 text-[22px] font-extrabold">
          <Wallet className="size-6 text-brand" aria-hidden="true" /> My Salary
        </h1>
        <p className="text-sm text-muted">Only you can see this page.</p>
      </div>
      {slips.isLoading && <Skeleton className="h-40 rounded-card" />}
      {slips.data && list.length === 0 && <EmptyState title="No payslips yet" description="Your payslip appears here after the school publishes the month’s payslips." />}
      {list.map((p, i) => (
        <SlipCard key={p.payslipId} p={p} first={i === 0} />
      ))}
      {open.length > 0 && (
        <Card aria-label="Advance recovery">
          <CardHeader>
            <CardTitle>Advance recovery</CardTitle>
          </CardHeader>
          <ul className="space-y-1 text-sm">
            {open.map((a) => (
              <li key={a.advanceId} className="flex flex-wrap justify-between gap-2">
                <span>
                  {formatMoney(a.principalPaise)} advance · {formatMoney(a.installmentPaise)} a month
                </span>
                <span>
                  Left <Money paise={a.remainingPaise} strong />
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <TaxForm current={summary.data?.taxDeclaration ?? null} />
    </div>
  );
}
