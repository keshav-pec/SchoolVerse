import { useState } from 'react';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { TabIntro } from '@/components/sv/help';
import { Money } from '@/components/finance/money';
import { ReportTable } from '@/components/finance/report-table';
import { useAuth } from '@/lib/auth';
import { REPORTS_INTRO } from '../help-copy';
import { useLiabilities, usePayrollReport } from '../ops-api';
import { MonthPicker, monthName, usePayrollMonth } from './shared';

const REPORTS = [
  { value: 'register', label: 'Payroll register', hint: 'everyone’s pay' },
  { value: 'bank-advice', label: 'Bank advice', hint: 'what the bank pays' },
  { value: 'statutory-summary', label: 'PF, ESI and PT summary' },
  { value: 'liability-aging', label: 'Unpaid salaries and dues' },
  { value: 'cost-by-location-department', label: 'Cost by campus and department' },
];

export function PayrollReportsTab() {
  const { can } = useAuth();
  const [month] = usePayrollMonth();
  const [type, setType] = useState('register');
  const report = usePayrollReport(type, month, can('payroll:report:view'));
  const liabilities = useLiabilities(can('payroll:report:view'));
  return (
    <div className="space-y-4">
      <TabIntro title="Payroll Reports">{REPORTS_INTRO}</TabIntro>
      <div className="flex flex-wrap items-end gap-3">
        <MonthPicker />
        <ComboboxField label="Report" value={type} onChange={setType} searchPlaceholder="Search reports…" options={REPORTS} containerClassName="w-72" />
      </div>
      <Card>
        <ReportTable query={report} csvPath={`/payroll/reports/${type}?month=${month}`} fileName={`payroll-${type}-${month}.csv`} />
      </Card>
      <Card aria-label="What the school still owes">
        <CardHeader>
          <CardTitle>What the school still owes</CardTitle>
        </CardHeader>
        {liabilities.isLoading ? (
          <Skeleton className="h-16" />
        ) : liabilities.data ? (
          <div className="space-y-2 text-sm">
            <p className="flex justify-between">
              <b>Salaries not paid yet</b> <Money paise={liabilities.data.unpaidSalaryPaise} strong />
            </p>
            {liabilities.data.unpaidByRun.map((r) => (
              <p key={r.runId} className="flex justify-between text-muted">
                <span>
                  {monthName(r.month)} ({r.number}) · {r.ageDays} days
                </span>
                <Money paise={r.unpaidPaise} />
              </p>
            ))}
            {liabilities.data.statutory.map((s) => (
              <p key={s.role} className="flex justify-between">
                <span>{s.label}</span>
                <Money paise={s.payablePaise} />
              </p>
            ))}
          </div>
        ) : null}
      </Card>
    </div>
  );
}
