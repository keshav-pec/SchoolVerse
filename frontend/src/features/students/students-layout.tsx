import { Outlet } from 'react-router';
import { CalendarDays, MapPin } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Combobox } from '@/components/ui/combobox';
import { Skeleton } from '@/components/ui/skeleton';
import { InfoTip } from '@/components/ui/tooltip';
import { StudentContextProvider, useStudentContext } from './context';

/** "2026-27 · Mohali Campus": pick the year and campus once. Every Students screen follows it. */
export function ContextBar() {
  const ctx = useStudentContext();
  if (ctx.loading) return <Skeleton className="mb-4 h-11 rounded-xl" />;
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-line bg-white px-3 py-2" role="group" aria-label="School year and campus">
      <span className="flex items-center gap-2 text-sm font-semibold text-ink">
        <CalendarDays className="size-4 text-brand" aria-hidden="true" />
        <span className="sr-only">School year</span>
        <Combobox
          aria-label="School year"
          className="h-9 w-40"
          value={ctx.sessionId ?? ''}
          onChange={ctx.setSessionId}
          options={ctx.sessions.map((s) => ({ value: s.academicSessionId, label: s.code || s.name, hint: s.isCurrent ? 'Current' : undefined }))}
          searchPlaceholder="Search years…"
          placeholder="Choose year"
        />
      </span>
      <span className="flex items-center gap-2 text-sm font-semibold text-ink">
        <MapPin className="size-4 text-brand" aria-hidden="true" />
        <span className="sr-only">Campus</span>
        <Combobox
          aria-label="Campus"
          className="h-9 w-52"
          value={ctx.locationId ?? ''}
          onChange={ctx.setLocationId}
          options={ctx.locations.map((l) => ({ value: l.locationId, label: l.displayName, hint: l.locationCode }))}
          searchPlaceholder="Search campuses…"
          placeholder="Choose campus"
        />
      </span>
      <InfoTip label="About the year and campus">
        <p>Pick the school year and campus once. Lists and forms on these pages use them, so you don’t choose them again.</p>
      </InfoTip>
      <p className="ml-auto hidden text-sm text-muted sm:block" aria-live="polite">
        {ctx.session ? `${ctx.session.code || ctx.session.name}` : 'No year'} · {ctx.location?.displayName ?? 'No campus'}
      </p>
    </div>
  );
}

function NothingToShow() {
  const ctx = useStudentContext();
  if (ctx.loading || (ctx.session && ctx.location)) return null;
  return (
    <Alert tone="warning" title={ctx.session ? 'No campus yet' : 'No school year yet'} className="mb-4">
      {ctx.session ? 'Add a campus in School Setup before adding students.' : 'Create a school year in Academic Setup before adding students.'}
    </Alert>
  );
}

/** Wraps the admin Students screens with the shared year and campus. */
export function StudentsLayout() {
  return (
    <StudentContextProvider>
      <ContextBar />
      <NothingToShow />
      <Outlet />
    </StudentContextProvider>
  );
}
