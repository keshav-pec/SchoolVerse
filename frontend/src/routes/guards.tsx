import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import type { Permission } from '@shared';
import { LogoMark } from '@/components/sv/logo';
import { ForbiddenPage } from '@/features/errors/forbidden-page';
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

/** Renders a friendly 403 page instead of the content when a permission is missing. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { can } = useAuth();
  return can(permission) ? <>{children}</> : <ForbiddenPage />;
}
