import { useState } from 'react';
import { Search, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useDebouncedValue } from '@/hooks/use-debounce';
import { Input } from '@/components/ui/input';
import { useStudentContext } from '../students/context';
import { useAccounts } from './api';

export interface PickedStudent {
  studentId: string;
  studentName: string;
  admissionNumber: string | null;
  className: string | null;
}

/** Search a student of this campus by name, admission number or a parent's name, then pick one. */
export function StudentPicker({ value, onChange, label = 'Student' }: { value: PickedStudent | null; onChange: (student: PickedStudent | null) => void; label?: string }) {
  const ctx = useStudentContext();
  const [text, setText] = useState('');
  const q = useDebouncedValue(text.trim(), 300);
  const list = useAccounts({ locationId: ctx.locationId, academicSessionId: ctx.sessionId, q: q || undefined });

  if (value)
    return (
      <div className="flex items-center justify-between gap-2 rounded-xl border border-line bg-canvas px-3 py-2 text-sm">
        <span>
          <b>{value.studentName}</b> <span className="text-muted">· {value.admissionNumber ?? 'No admission number'} · {value.className ?? 'No class'}</span>
        </span>
        <Button variant="ghost" size="sm" onClick={() => onChange(null)} aria-label={`Choose a different ${label.toLowerCase()}`}>
          <X /> Change
        </Button>
      </div>
    );

  return (
    <div className="space-y-2">
      <label className="block text-sm font-semibold" htmlFor="student-picker-search">
        {label}
      </label>
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" aria-hidden="true" />
        <Input id="student-picker-search" className="pl-9" placeholder="Search by name, admission number or parent…" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
      </div>
      {list.isLoading && <Skeleton className="h-20" role="status" aria-label="Searching" />}
      {list.data && list.data.items.length === 0 && <p className="text-sm text-muted">No student found. Check the spelling, or try the admission number.</p>}
      <ul className="max-h-56 divide-y divide-line overflow-y-auto rounded-xl border border-line empty:hidden" aria-label="Students found">
        {list.data?.items.slice(0, 8).map((s) => (
          <li key={s.studentId}>
            <button type="button" className="flex w-full flex-col px-3 py-2 text-left text-sm hover:bg-brand-soft/60 focus-visible:bg-brand-soft/60 focus-visible:outline-none" onClick={() => onChange(s)}>
              <span className="font-semibold">{s.studentName}</span>
              <span className="text-[13px] text-muted">
                {s.admissionNumber ?? 'No admission number'} · {s.className ?? 'No class'}
                {s.guardianName ? ` · Parent: ${s.guardianName}` : ''}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
