import { createContext, useContext, type ReactNode } from 'react';
import { Outlet } from 'react-router';
import { CalendarPlus } from 'lucide-react';
import type { TimetablePlanDTO } from '@shared';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/sv/error-state';
import { api } from '@/lib/api';
import { ContextBar } from '../students/students-layout';
import { StudentContextProvider, useStudentContext } from '../students/context';
import { useTimetableMutation, usePlans } from './api';

interface PlanValue {
  plan: TimetablePlanDTO | undefined;
  loading: boolean;
}
const PlanCtx = createContext<PlanValue | null>(null);

/** The plan of the campus and school year picked in the bar. There is at most one. */
export function useTimetablePlan(): PlanValue {
  const value = useContext(PlanCtx);
  if (!value) throw new Error('useTimetablePlan needs <TimetableLayout>');
  return value;
}

function PlanProvider({ children }: { children: ReactNode }) {
  const ctx = useStudentContext();
  const plans = usePlans(ctx.locationId, ctx.sessionId);
  const plan = plans.data?.[0];
  if (plans.isError) return <ErrorState error={plans.error} onRetry={() => void plans.refetch()} />;
  return <PlanCtx.Provider value={{ plan, loading: ctx.loading || plans.isLoading }}>{children}</PlanCtx.Provider>;
}

function NothingToShow() {
  const ctx = useStudentContext();
  if (ctx.loading || (ctx.session && ctx.location)) return null;
  return (
    <Alert tone="warning" title={ctx.session ? 'No campus yet' : 'No school year yet'} className="mb-4">
      {ctx.session ? 'Add a campus in School Setup before planning the timetable.' : 'Create a school year in Academic Setup before planning the timetable.'}
    </Alert>
  );
}

/** Wraps the timetable screens with the same “2026-27 · Mohali Campus” bar the Students and Campus screens use. */
export function TimetableLayout() {
  return (
    <StudentContextProvider>
      <ContextBar />
      <NothingToShow />
      <PlanProvider>
        <Outlet />
      </PlanProvider>
    </StudentContextProvider>
  );
}

/** The first thing a campus sees: one big button. Dates and school days are filled in for you. */
export function CreatePlanCard() {
  const ctx = useStudentContext();
  const create = useTimetableMutation(() => api.post<TimetablePlanDTO>('/timetable-plans', { locationId: ctx.locationId, academicSessionId: ctx.sessionId }), { success: 'Timetable plan created.' });
  if (ctx.loading) return <Skeleton className="h-48 rounded-card" />;
  return (
    <Card className="flex flex-col items-center gap-3 p-8 text-center">
      <span className="grid size-14 place-items-center rounded-2xl bg-brand-soft text-brand">
        <CalendarPlus className="size-7" aria-hidden="true" />
      </span>
      <h2 className="text-xl font-extrabold">No timetable plan yet</h2>
      <p className="max-w-lg text-sm text-muted">
        A plan holds the school week, the daily periods and what each subject needs for {ctx.location?.displayName ?? 'this campus'} in {ctx.session?.code || ctx.session?.name || 'this year'}. We fill in the dates and Monday to Saturday for you. You can change them after.
      </p>
      <Button size="lg" disabled={!ctx.locationId || !ctx.sessionId} loading={create.isPending} loadingText="Creating…" onClick={() => create.mutate(undefined)}>
        Create Timetable Plan
      </Button>
    </Card>
  );
}
