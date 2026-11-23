import { useState } from 'react';
import { CalendarCheck, FileUp } from 'lucide-react';
import type { PayrollInputDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { CsvFileField } from '@/components/sv/csv-import';
import { TabIntro } from '@/components/sv/help';
import { Modal } from '@/components/sv/modal';
import { useAuth } from '@/lib/auth';
import { useFinanceMutation } from '../api';
import { ErrorBanner } from '../error-banner';
import { INPUTS_INTRO } from '../help-copy';
import { payApi, useCompensations, useInputs } from '../ops-api';
import { MonthPicker, monthName, usePayrollMonth } from './shared';

interface Row {
  employeeId: string;
  name: string;
  code: string;
  input: PayrollInputDTO | null;
}

function InputRow({ row, month }: { row: Row; month: string }) {
  const [working, setWorking] = useState(row.input?.workingDays?.toString() ?? '');
  const [leave, setLeave] = useState(String(row.input?.paidLeaveDays ?? 0));
  const [lop, setLop] = useState(String(row.input?.lopDays ?? 0));
  const save = useFinanceMutation(
    () => payApi.putInput({ employeeId: row.employeeId, month, workingDays: working === '' ? null : Number(working), paidLeaveDays: Number(leave) || 0, lopDays: Number(lop) || 0, unitsWorked: row.input?.unitsWorked ?? null, extras: row.input?.extras ?? [] }),
    { success: `Saved for ${row.name}.` },
  );
  const changed = working !== (row.input?.workingDays?.toString() ?? '') || leave !== String(row.input?.paidLeaveDays ?? 0) || lop !== String(row.input?.lopDays ?? 0);
  const num = (label: string, value: string, set: (v: string) => void) => <Input aria-label={`${label} for ${row.name}`} className="h-9 w-20" inputMode="decimal" value={value} onChange={(e) => set(e.target.value)} />;
  return (
    <tr className={row.input ? '' : 'bg-warning-soft/50'}>
      <td className="px-3 py-2">
        <b>{row.name}</b> <span className="text-muted">{row.code}</span>
        {!row.input && <span className="block text-[13px] text-warning">Not entered yet</span>}
      </td>
      <td className="px-3 py-2">{num('Working days', working, setWorking)}</td>
      <td className="px-3 py-2">{num('Paid leave', leave, setLeave)}</td>
      <td className="px-3 py-2">{num('Unpaid leave', lop, setLop)}</td>
      <td className="px-3 py-2 text-right">
        <Button size="sm" variant={row.input && !changed ? 'ghost' : 'outline'} disabled={row.input !== null && !changed} loading={save.isPending} loadingText="Saving…" onClick={() => save.mutate(undefined)} aria-label={`Save days for ${row.name}`}>
          Save
        </Button>
      </td>
    </tr>
  );
}

function ImportDialog({ month, onClose }: { month: string; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const run = useFinanceMutation((form: FormData) => payApi.importInputs(form), { quiet: true });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Import days for ${monthName(month)}`}
      description="A CSV with the columns: employee code, working days, paid leave, LOP."
      footer={
        <>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button
            disabled={!file}
            loading={run.isPending}
            loadingText="Importing…"
            onClick={() => {
              const form = new FormData();
              form.append('file', file!);
              form.append('month', month);
              run.mutate(form);
            }}
          >
            Import CSV
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <CsvFileField id="inputs-file" hint="Example row: FAC-001, 26, 1, 0" onFile={setFile} />
        {run.data && (
          <Alert tone={run.data.problems.length ? 'warning' : 'success'} title={`${run.data.saved} saved`}>
            {run.data.problems.length > 0 && (
              <ul className="list-disc pl-5" aria-label="Row problems">
                {run.data.problems.map((p) => (
                  <li key={p.row}>
                    Row {p.row}: {p.message}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        {run.error && <ErrorBanner error={run.error} />}
      </div>
    </Modal>
  );
}

/** Inputs: a month grid of paid days. A missing month blocks the run, so "Mark Everyone Present" fills the gaps in one click. */
export function InputsTab() {
  const { can } = useAuth();
  const [month] = usePayrollMonth();
  const inputs = useInputs(month);
  const comp = useCompensations(can('payroll:salary:view_sensitive'));
  const [importing, setImporting] = useState(false);
  const fill = useFinanceMutation(() => payApi.fillInputs({ month }), { success: (r) => `${r.filled} ${r.filled === 1 ? 'person' : 'people'} marked present for the whole month.` });
  const byId = new Map<string, Row>();
  for (const c of comp.data ?? []) if (!c.effectiveTo) byId.set(c.employeeId, { employeeId: c.employeeId, name: c.employeeName, code: c.employeeCode, input: null });
  for (const i of inputs.data ?? []) byId.set(i.employeeId, { employeeId: i.employeeId, name: i.employeeName, code: i.employeeCode, input: i });
  const rows = [...byId.values()].sort((a, b) => Number(a.input !== null) - Number(b.input !== null) || a.name.localeCompare(b.name));
  const missing = rows.filter((r) => !r.input).length;
  return (
    <div className="space-y-4">
      <TabIntro title="Inputs" need="required">
        {INPUTS_INTRO}
      </TabIntro>
      <div className="flex flex-wrap items-center gap-2">
        <MonthPicker />
        <Button variant="outline" loading={fill.isPending} loadingText="Saving…" onClick={() => fill.mutate(undefined)}>
          <CalendarCheck /> Mark Everyone Present
        </Button>
        <Button variant="outline" onClick={() => setImporting(true)}>
          <FileUp /> Import CSV
        </Button>
      </div>
      {missing > 0 && <p className="text-sm font-semibold text-warning">{missing} {missing === 1 ? 'person has' : 'people have'} no days for {monthName(month)} yet.</p>}
      <Card className="overflow-x-auto p-0 sm:p-0">
        {inputs.isLoading || comp.isLoading ? (
          <Skeleton className="m-4 h-24" />
        ) : rows.length === 0 ? (
          <p className="p-4 text-sm text-muted">Nobody has a salary yet, so there is nothing to enter. Set salaries in Salary Setup first.</p>
        ) : (
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-canvas text-left text-[13px] text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">Person</th>
                <th scope="col" className="px-3 py-2">Working days</th>
                <th scope="col" className="px-3 py-2">Paid leave</th>
                <th scope="col" className="px-3 py-2">Unpaid leave (LOP)</th>
                <th scope="col" className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <InputRow key={`${r.employeeId}-${r.input?.inputId ?? 'new'}`} row={r} month={month} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {importing && <ImportDialog month={month} onClose={() => setImporting(false)} />}
    </div>
  );
}
