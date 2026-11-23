import { useSearchParams } from 'react-router';
import { Combobox } from '@/components/ui/combobox';
import { todayLocal } from '../collect/shared';

/** `2026-11` → `November 2026`. */
export const monthName = (month: string) => new Date(`${month}-01T00:00:00Z`).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The last 12 months and the next one, newest first. */
export function monthOptions(): { value: string; label: string }[] {
  const now = todayLocal().slice(0, 7);
  const [y, m] = now.split('-').map(Number) as [number, number];
  return Array.from({ length: 14 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 1 + 1 - i, 1));
    const value = d.toISOString().slice(0, 7);
    return { value, label: monthName(value) };
  });
}

/** The payroll month lives in the address (`?month=2026-11`) so every payroll tab follows the same one. Default: this month. */
export function usePayrollMonth(): [string, (m: string) => void] {
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? todayLocal().slice(0, 7);
  return [
    month,
    (m) =>
      setParams((p) => {
        const n = new URLSearchParams(p);
        n.set('month', m);
        return n;
      }),
  ];
}

export function MonthPicker() {
  const [month, setMonth] = usePayrollMonth();
  return <Combobox aria-label="Payroll month" className="h-10 w-52" value={month} onChange={setMonth} options={monthOptions()} searchPlaceholder="Search months…" />;
}
