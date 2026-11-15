import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { TERM_TYPES, TERM_TYPE_LABELS, type AcademicSessionDTO, type AcademicTermDTO, type TermType } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { SelectField, TextField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { formatDateOnly } from '@/lib/format';
import { messageFor } from '@/lib/errors';
import { useAcademicMutation, useTerms } from '../api';

const day = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;

/** A bar over the session dates showing where each term sits. */
function Timeline({ session, terms }: { session: AcademicSessionDTO; terms: AcademicTermDTO[] }) {
  const start = day(session.startDate);
  const span = Math.max(1, day(session.endDate) - start);
  return (
    <div role="img" aria-label="Terms across the session" className="space-y-1.5">
      {terms.map((t) => {
        const left = Math.min(100, Math.max(0, ((day(t.startDate) - start) / span) * 100));
        const width = Math.min(100 - left, Math.max(2, ((day(t.endDate) - day(t.startDate) + 1) / span) * 100));
        return (
          <div key={t.termId} className="relative h-6 rounded-md bg-ink/6">
            <span className={`absolute inset-y-0 rounded-md px-2 text-xs leading-6 font-semibold whitespace-nowrap text-white ${t.locationId ? 'bg-mint' : 'bg-brand'}`} style={{ left: `${left}%`, width: `${width}%` }}>
              {t.code}
            </span>
          </div>
        );
      })}
    </div>
  );
}

const STATUS_TONE = { planned: 'neutral', current: 'success', closed: 'warning' } as const;

export function TermsTab({ session, readOnly }: { session: AcademicSessionDTO; readOnly: boolean }) {
  const terms = useTerms(session.academicSessionId);
  const [form, setForm] = useState({ name: '', code: '', type: 'TERM' as TermType, startDate: '', endDate: '', locationId: '' });
  const [error, setError] = useState<string | null>(null);
  const add = useAcademicMutation((_: void) => api.post(`/academic-sessions/${session.academicSessionId}/terms`, { ...form, locationId: form.locationId || null }), { quiet: true, success: 'Term added.' });
  const remove = useAcademicMutation((id: string) => api.delete<void>(`/terms/${id}`), { success: 'Term removed.' });
  const where = (t: AcademicTermDTO) => (t.locationId ? (session.locations.find((l) => l.locationId === t.locationId)?.locationName ?? 'One location') : 'All locations');

  if (terms.isLoading) return <Skeleton className="h-48 rounded-card" role="status" aria-label="Loading terms" />;
  if (terms.isError) return <ErrorState error={terms.error} onRetry={() => void terms.refetch()} retrying={terms.isFetching} />;
  const list = terms.data ?? [];

  return (
    <div className="space-y-6">
      {list.length === 0 ? (
        <Card>
          <EmptyState title="No terms yet" description="Terms are optional. Add them if you plan by term, semester or quarter." />
        </Card>
      ) : (
        <Card>
          <Timeline session={session} terms={list} />
          <ul className="mt-4 divide-y divide-line" aria-label="Terms">
            {list.map((t) => (
              <li key={t.termId} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-bold">{t.name} <span className="text-sm font-medium text-muted">{t.code}</span></p>
                  <p className="text-[13px] text-muted">{formatDateOnly(t.startDate)} to {formatDateOnly(t.endDate)} · {TERM_TYPE_LABELS[t.type]} · {where(t)}</p>
                </div>
                <Badge tone={STATUS_TONE[t.status]}>{t.status.charAt(0).toUpperCase() + t.status.slice(1)}</Badge>
                {!readOnly && (
                  <Button variant="ghost" size="icon-sm" aria-label={`Delete ${t.name}`} onClick={() => remove.mutate(t.termId)}>
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {!readOnly && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Add a term</CardTitle>
              <CardDescription>Dates must sit inside the session and can’t overlap another term in the same scope.</CardDescription>
            </div>
          </CardHeader>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <TextField label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Term 1" />
            <TextField label="Code" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value.toUpperCase() })} placeholder="T1" />
            <SelectField label="Type" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as TermType })}>
              {TERM_TYPES.map((t) => (
                <option key={t} value={t}>{TERM_TYPE_LABELS[t]}</option>
              ))}
            </SelectField>
            <TextField type="date" label="Start date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} />
            <TextField type="date" label="End date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} />
            <SelectField label="Applies to" value={form.locationId} onChange={(e) => setForm({ ...form, locationId: e.target.value })}>
              <option value="">All locations</option>
              {session.locations.map((l) => (
                <option key={l.locationId} value={l.locationId}>{l.locationName} only</option>
              ))}
            </SelectField>
          </div>
          {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
          <Button
            className="mt-4"
            disabled={!form.name || !form.code || !form.startDate || !form.endDate}
            loading={add.isPending}
            loadingText="Adding…"
            onClick={async () => {
              setError(null);
              try {
                await add.mutateAsync();
                setForm({ ...form, name: '', code: '', startDate: '', endDate: '' });
              } catch (err) {
                setError(messageFor(err));
              }
            }}
          >
            <Plus /> Add term
          </Button>
        </Card>
      )}
    </div>
  );
}
