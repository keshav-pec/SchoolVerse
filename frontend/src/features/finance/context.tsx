import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Outlet } from 'react-router';
import { Landmark } from 'lucide-react';
import type { FinancialYearDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Combobox } from '@/components/ui/combobox';
import { ContextBar } from '../students/students-layout';
import { StudentContextProvider, useStudentContext } from '../students/context';
import { useFinancialYears } from './api';

const KEY = 'sv.finance.year';

interface YearValue {
  /** The financial year every Finance screen follows. `undefined` until one exists. */
  year: FinancialYearDTO | undefined;
  years: FinancialYearDTO[];
  setYearId: (id: string) => void;
}

const Ctx = createContext<YearValue | null>(null);

function pickYear(years: FinancialYearDTO[], stored: string | null): FinancialYearDTO | undefined {
  const today = new Date().toISOString().slice(0, 10);
  return years.find((y) => y.financialYearId === stored) ?? years.find((y) => y.startDate <= today && y.endDate >= today) ?? years[years.length - 1];
}

/** The financial year ("FY 2026-27"), chosen once, remembered on this device. Starts with the year that includes today. */
function FinanceYearProvider({ children }: { children: ReactNode }) {
  const q = useFinancialYears();
  const [stored, setStored] = useState<string | null>(() => localStorage.getItem(KEY));
  const years = useMemo(() => q.data ?? [], [q.data]);
  const year = pickYear(years, stored);
  useEffect(() => {
    if (stored) localStorage.setItem(KEY, stored);
  }, [stored]);
  return <Ctx.Provider value={{ year, years, setYearId: setStored }}>{children}</Ctx.Provider>;
}

export function useFinanceYear(): YearValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useFinanceYear needs <FinanceYearProvider>');
  return value;
}

function YearPicker() {
  const { year, years, setYearId } = useFinanceYear();
  return (
    <span className="flex items-center gap-2 text-sm font-semibold text-ink">
      <Landmark className="size-4 text-brand" aria-hidden="true" />
      <span className="sr-only">Financial year</span>
      <Combobox
        aria-label="Financial year"
        className="h-9 w-40"
        value={year?.financialYearId ?? ''}
        onChange={setYearId}
        options={years.map((y) => ({ value: y.financialYearId, label: `FY ${y.code}` }))}
        searchPlaceholder="Search years…"
        placeholder="No year yet"
      />
    </span>
  );
}

function NoCampus() {
  const ctx = useStudentContext();
  if (ctx.loading || ctx.location) return null;
  return (
    <Alert tone="warning" title="No campus yet" className="mb-4">
      Add a campus in School Setup first. Fees belong to a campus.
    </Alert>
  );
}

/**
 * Wraps the Finance screens with “2026-27 · Mohali Campus · FY 2026-27”. Nobody picks the campus or the year again inside a form:
 * the school year and campus are the same bar the Students and Campus screens use.
 */
export function FinanceLayout() {
  return (
    <StudentContextProvider>
      <FinanceYearProvider>
        <ContextBar extra={<YearPicker />} />
        <NoCampus />
        <Outlet />
      </FinanceYearProvider>
    </StudentContextProvider>
  );
}
