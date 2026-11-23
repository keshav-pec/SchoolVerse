import { useState } from 'react';
import { useNavigate } from 'react-router';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { useAuth } from '@/lib/auth';
import { useFinanceSearch } from './ops-api';

const TYPE_WORD: Record<string, string> = {
  student: 'Student',
  receipt: 'Receipt',
  bill: 'Bill',
  payment: 'Payment',
  cheque: 'Cheque',
  bank_line: 'Bank line',
  journal: 'Entry',
  payroll_run: 'Payroll',
  payslip: 'Payslip',
  expense: 'Expense',
  vendor: 'Vendor',
};

/**
 * The finance search box in the top bar: a receipt number, a UTR, a cheque number, a student, a vendor. Only for people with
 * finance access; what each person may find is decided by the API (salary results need salary access).
 */
export function FinanceSearch() {
  const { can } = useAuth();
  const navigate = useNavigate();
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const q = useDebouncedValue(text.trim(), 300);
  const results = useFinanceSearch(can('finance:view') ? q : '');
  if (!can('finance:view')) return null;
  const items = results.data ?? [];
  return (
    <div className="relative hidden w-72 lg:block" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
      <Input
        aria-label="Search finance"
        role="combobox"
        aria-expanded={open && q.length >= 2}
        aria-controls="finance-search-results"
        className="h-10 pl-9"
        placeholder="Receipt, UTR, cheque, student…"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'Enter' && items[0]) {
            navigate(items[0].path);
            setOpen(false);
          }
        }}
      />
      {open && q.length >= 2 && (
        <ul id="finance-search-results" role="listbox" aria-label="Finance search results" className="absolute top-12 right-0 left-0 z-40 max-h-96 overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-pop">
          {results.isLoading && <li className="px-3 py-2 text-sm text-muted">Searching…</li>}
          {!results.isLoading && items.length === 0 && <li className="px-3 py-2 text-sm text-muted">Nothing found for “{q}”.</li>}
          {items.map((r) => (
            <li key={`${r.type}-${r.id}`} role="option" aria-selected={false}>
              <button
                type="button"
                className="flex w-full flex-col rounded-lg px-3 py-2 text-left text-sm hover:bg-brand-soft"
                onClick={() => {
                  navigate(r.path);
                  setOpen(false);
                  setText('');
                }}
              >
                <span>
                  <span className="mr-1.5 text-[11px] font-bold tracking-wide text-muted uppercase">{TYPE_WORD[r.type] ?? r.type}</span>
                  <b>{r.label}</b>
                </span>
                {r.sub && <span className="text-[13px] text-muted">{r.sub}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
