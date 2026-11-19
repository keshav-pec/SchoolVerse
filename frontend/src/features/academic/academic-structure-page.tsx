import { useState } from 'react';
import { Info } from 'lucide-react';
import { SESSION_STATUS_LABELS, type AcademicContextDTO } from '@shared';
import { LostPlanet } from '@/components/illustrations/lost-planet';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { ComboboxField } from '@/components/ui/field';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/sv/empty-state';
import { ErrorState } from '@/components/sv/error-state';
import { PageHeader } from '@/components/sv/page-header';
import { formatDateOnly } from '@/lib/format';
import { useAcademicContext, useSessions } from './api';

function GradeDetail({ sessionId, locationId, gradeId }: { sessionId: string; locationId: string; gradeId: string }) {
  const q = useAcademicContext({ academicSessionId: sessionId, locationId, gradeId });
  if (q.isLoading) return <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading grade" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => void q.refetch()} retrying={q.isFetching} />;
  const c = q.data as AcademicContextDTO;
  return (
    <Card className="space-y-4">
      <h3 className="text-lg font-extrabold">{c.gradeOffering.displayName}</h3>
      <dl className="grid gap-4 text-sm sm:grid-cols-2">
        <div>
          <dt className="font-bold">Sections</dt>
          <dd className="text-muted">{c.sections.map((s) => s.sectionCode).join(', ') || 'None'}</dd>
        </div>
        <div>
          <dt className="font-bold">Subjects</dt>
          <dd className="text-muted">{c.subjectOfferings.map((s) => s.subjectName).join(', ') || 'None'}</dd>
        </div>
        {c.choiceGroups.length > 0 && (
          <div className="sm:col-span-2">
            <dt className="font-bold">Subject choices</dt>
            <dd><ul className="text-muted">{c.choiceGroups.map((g) => <li key={g.choiceGroupId}>{g.name}: {g.summary}</li>)}</ul></dd>
          </div>
        )}
        {c.programmes.length > 0 && (
          <div>
            <dt className="font-bold">Programmes</dt>
            <dd className="text-muted">{c.programmes.map((p) => p.name).join(', ')}</dd>
          </div>
        )}
        {c.terms.length > 0 && (
          <div>
            <dt className="font-bold">Terms</dt>
            <dd className="text-muted">{c.terms.map((t) => `${t.name} (${formatDateOnly(t.startDate)} to ${formatDateOnly(t.endDate)})`).join(' · ')}</dd>
          </div>
        )}
      </dl>
    </Card>
  );
}

/** Read-only "Academic Structure" for Faculty and Staff: published, active and closed sessions only, no controls to change anything. */
export function AcademicStructurePage() {
  const sessions = useSessions();
  const [sessionId, setSessionId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [gradeId, setGradeId] = useState('');

  const list = sessions.data ?? [];
  const current = list.find((s) => s.academicSessionId === sessionId) ?? list.find((s) => s.status === 'ACTIVE') ?? list[0];
  const location = current?.locations.find((l) => l.locationId === locationId) ?? current?.locations[0];
  const context = useAcademicContext({ academicSessionId: current?.academicSessionId, locationId: location?.locationId });
  const grades = context.data?.grades ?? [];

  const header = <PageHeader eyebrow="Academics" title="Academic Structure" description="A read-only view of your school’s sessions, grades, sections and subjects." />;
  if (sessions.isLoading) return <>{header}<Skeleton className="h-64 rounded-card" role="status" aria-label="Loading academic structure" /></>;
  if (sessions.isError) return <ErrorState error={sessions.error} onRetry={() => void sessions.refetch()} retrying={sessions.isFetching} />;
  if (!current) return <>{header}<Card><EmptyState illustration={<LostPlanet className="w-44" />} title="No published academic session yet" description="Your School Admin is still planning the year. It will show up here once it is published." /></Card></>;

  return (
    <>
      {header}
      <Alert tone="info" className="mb-6">
        <span className="inline-flex items-center gap-1.5"><Info className="size-4" aria-hidden="true" /> This is a limited, read-only view. Ask your School Admin for changes.</span>
      </Alert>
      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <ComboboxField
          label="Session"
          value={current.academicSessionId}
          onChange={(v) => { setSessionId(v); setLocationId(''); setGradeId(''); }}
          options={list.map((s) => ({ value: s.academicSessionId, label: s.name, hint: SESSION_STATUS_LABELS[s.status] }))}
          searchPlaceholder="Search sessions…"
        />
        <ComboboxField
          label="Location"
          value={location?.locationId ?? ''}
          onChange={(v) => { setLocationId(v); setGradeId(''); }}
          options={current.locations.map((l) => ({ value: l.locationId, label: l.locationName ?? '', hint: l.boardCode ?? undefined }))}
          searchPlaceholder="Search locations…"
        />
      </div>
      {context.isLoading ? (
        <Skeleton className="h-40 rounded-card" role="status" aria-label="Loading grades" />
      ) : context.isError ? (
        <ErrorState error={context.error} onRetry={() => void context.refetch()} retrying={context.isFetching} />
      ) : grades.length === 0 ? (
        <Card><EmptyState title="No grades at this location" /></Card>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <ul className="space-y-1.5" aria-label="Grades">
            {grades.map((g) => (
              <li key={g.gradeOfferingId}>
                <button
                  type="button"
                  onClick={() => setGradeId(g.gradeId)}
                  aria-pressed={gradeId === g.gradeId}
                  className={`flex w-full items-center justify-between rounded-xl border px-4 py-2.5 text-left text-sm font-semibold ${gradeId === g.gradeId ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-white hover:border-brand/40'}`}
                >
                  {g.displayName}
                  <span className="text-xs font-normal text-muted">{g.sectionCount} sec · {g.subjectCount} sub</span>
                </button>
              </li>
            ))}
          </ul>
          <div>{gradeId && location ? <GradeDetail sessionId={current.academicSessionId} locationId={location.locationId} gradeId={gradeId} /> : <Card><EmptyState title="Choose a grade" description="Pick a grade on the left to see its sections, subjects and rules." /></Card>}</div>
        </div>
      )}
    </>
  );
}
