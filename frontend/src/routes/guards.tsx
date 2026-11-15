import { Navigate, Outlet, useLocation } from 'react-router';
import { LogoMark } from '@/components/sv/logo';
import { GettingSetUpPage } from '@/features/setup/getting-set-up-page';
import { useCurrentSchool } from '@/features/school-profile/api';
import { ErrorState } from '@/components/sv/error-state';
import { useAuth } from '@/lib/auth';

export function FullScreenLoader({ label = 'Loading your workspace…' }: { label?: string }) {
  return (
    <div className="grid min-h-dvh place-items-center bg-canvas" role="status" aria-live="polite">
      <div className="flex flex-col items-center gap-4">
        <LogoMark className="size-14 animate-float" />
        <p className="text-sm font-medium text-muted">{label}</p>
      </div>
    </div>
  );
}

/** Only signed-in users. Others go to /login and come back afterwards. */
export function RequireAuth() {
  const { session, isLoading } = useAuth();
  const location = useLocation();
  if (isLoading) return <FullScreenLoader />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  return <Outlet />;
}

/** Login/signup pages — signed-in users are sent home. */
export function GuestOnly() {
  const { session, isLoading } = useAuth();
  if (isLoading) return <FullScreenLoader label="Just a moment…" />;
  if (session) return <Navigate to="/" replace />;
  return <Outlet />;
}

/**
 * School Setup is for administrators, plus a limited read-only view for Faculty and Staff.
 * Anyone without `school:view` (Parents) lands on the friendly restricted page.
 */
export function RequireSetupAccess() {
  const { can } = useAuth();
  if (!can('school:view')) return <Navigate to="/restricted" replace />;
  return <Outlet />;
}

/**
 * First-time setup gate for the app shell.
 *  - A School Admin whose school isn't finished yet goes to the wizard (`/setup`), which resumes where they left off.
 *  - Faculty and Staff see "Your school is getting set up" until then.
 *  - Parents never touch school configuration, so they pass straight through.
 */
export function RequireSetupComplete() {
  const { can } = useAuth();
  const canSeeSchool = can('school:view');
  const school = useCurrentSchool(canSeeSchool);
  if (!canSeeSchool) return <Outlet />;
  if (school.isLoading) return <FullScreenLoader label="Checking your school setup…" />;
  if (school.isError) return <ErrorState error={school.error} onRetry={() => void school.refetch()} retrying={school.isFetching} />;
  const finished = school.data?.setupCompleted === true;
  if (finished) return <Outlet />;
  if (can('setup:manage')) return <Navigate to="/setup" replace />;
  return <GettingSetUpPage />;
}
