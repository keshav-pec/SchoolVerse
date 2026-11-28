import { Navigate, Outlet, useLocation } from 'react-router';
import { LogoMark } from '@/components/sv/logo';
import { NotFoundPage } from '@/features/errors/not-found-page';
import { GettingSetUpPage } from '@/features/setup/getting-set-up-page';
import { useCurrentSchool } from '@/features/school-profile/api';
import { ErrorState } from '@/components/sv/error-state';
import type { Permission } from '@shared';
import { useAuth, useSession } from '@/lib/auth';

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
  if (!session)
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
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
  if (school.isError)
    return (
      <ErrorState
        error={school.error}
        onRetry={() => void school.refetch()}
        retrying={school.isFetching}
      />
    );
  const finished = school.data?.setupCompleted === true;
  if (finished) return <Outlet />;
  if (can('setup:manage')) return <Navigate to="/setup" replace />;
  return <GettingSetUpPage />;
}

/** Academics: anyone with `academic:view` (admins, plus a read-only view for Faculty and Staff). Parents see the restricted page. */
export function RequireAcademicAccess() {
  const { can } = useAuth();
  if (!can('academic:view')) return <Navigate to="/restricted" replace />;
  return <Outlet />;
}

/** Configuration pages (session setup, subject master) are for admins; limited roles go back to the read-only page. */
export function RequireAcademicConfig() {
  const { can } = useAuth();
  if (!can('academic:view_config')) return <Navigate to="/academics" replace />;
  return <Outlet />;
}

/**
 * People: anyone who may use the directory can enter. Parents (no `employee:directory`) get the restricted page. Faculty and
 * Staff, who hold the directory but not the full record, are shown Not Found for an administrators-only URL: the page
 * does not admit that it exists (the API answers 404 for records they may not see, too).
 */
export function RequirePeopleAdmin({ permission = 'employee:view' }: { permission?: Permission }) {
  const { can } = useAuth();
  if (!can('employee:directory')) return <Navigate to="/restricted" replace />;
  if (!can(permission)) return <NotFoundPage />;
  return <Outlet />;
}

/** The colleague directory and `/me` need the directory permission; everything about them is also decided by the API. */
export function RequireDirectoryAccess() {
  const { can } = useAuth();
  if (!can('employee:directory')) return <Navigate to="/restricted" replace />;
  return <Outlet />;
}

/**
 * Students: School Admins (`student:view`) and Faculty (through their own sections) may enter. Staff and Parents get the
 * restricted page. Which students a teacher can open is decided by the API.
 */
export function RequireStudentAccess() {
  const { can } = useAuth();
  const session = useSession();
  if (!can('student:view') && session.user.role !== 'FACULTY') return <Navigate to="/restricted" replace />;
  return <Outlet />;
}

/** Student lists, families and Needs Attention are for admins. Faculty see Not Found: the page does not admit it exists. */
export function RequireStudentAdmin() {
  const { can } = useAuth();
  if (!can('student:view')) return <NotFoundPage />;
  return <Outlet />;
}

/** `/my-students` is the teacher's own list. */
export function RequireFaculty() {
  const session = useSession();
  if (session.user.role !== 'FACULTY') return <NotFoundPage />;
  return <Outlet />;
}

/** The parent portal is for parents only. Anyone else is shown Not Found. */
export function RequireParent() {
  const session = useSession();
  if (session.user.role !== 'PARENT') return <NotFoundPage />;
  return <Outlet />;
}

/** Student lifecycle pages need their own permission (promotion, imports, change requests). Others see Not Found. */
export function RequireStudentPermission({ permission }: { permission: Permission }) {
  const { can } = useAuth();
  if (!can(permission)) return <NotFoundPage />;
  return <Outlet />;
}

/** Campus: anyone with `space:view` (admins, and Faculty who see the rooms they can use). Staff and Parents get the restricted page. */
export function RequireSpaceAccess() {
  const { can } = useAuth();
  if (!can('space:view')) return <Navigate to="/restricted" replace />;
  return <Outlet />;
}

/** Room setup pages (types, attention, imports) need a stronger permission. Others see Not Found: the page does not admit it exists. */
export function RequireSpacePermission({ permission }: { permission: Permission }) {
  const { can } = useAuth();
  if (!can(permission)) return <NotFoundPage />;
  return <Outlet />;
}

/** Finance: anyone holding `finance:view` (School Admin, or Staff with a finance job). Teachers and Parents get the restricted page. */
export function RequireFinanceAccess() {
  const { can } = useAuth();
  if (!can('finance:view')) return <Navigate to="/restricted" replace />;
  return <Outlet />;
}

/** A finance page that needs more than `finance:view` (Banking, Payroll, Expenses…). Someone without it sees Not Found. */
export function RequireFinancePermission({ any }: { any: Permission[] }) {
  const { can } = useAuth();
  if (!any.some(can)) return <NotFoundPage />;
  return <Outlet />;
}

/** `/me/salary`: anyone whose login is an employee (teaching or non-teaching staff, or an admin linked to an employee record). */
export function RequireEmployeeLogin() {
  const session = useSession();
  const u = session.user;
  if (u.role === 'PARENT') return <Navigate to="/restricted" replace />;
  if (u.role !== 'FACULTY' && u.role !== 'STAFF' && !u.personId) return <NotFoundPage />;
  return <Outlet />;
}

/** Timetable setup: the School Admin, or Staff holding a Scheduling Coordinator job. Faculty only look at the timetable later, so they get the restricted page. */
export function RequireTimetableSetup() {
  const { can } = useAuth();
  if (!can('timetable:setup:manage')) return <Navigate to="/restricted" replace />;
  return <Outlet />;
}

/** The schedule workspace and Needs Attention: whoever can edit lessons (School Admin, or Staff with the Scheduling Coordinator job). Faculty get the restricted page. */
export function RequireTimetableSchedule() {
  const { can } = useAuth();
  if (!can('timetable:entry:edit')) return <Navigate to="/restricted" replace />;
  return <Outlet />;
}

/** Timetable screens that more than one kind of person uses. The server decides the rest; this only sends people away from a page they can never use. */
export function RequireTimetableAny({ any }: { any: Permission[] }) {
  const { can } = useAuth();
  if (!any.some((p) => can(p))) return <Navigate to="/restricted" replace />;
  return <Outlet />;
}
