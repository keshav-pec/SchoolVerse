import { Outlet } from 'react-router';
import { Alert } from '@/components/ui/alert';
import { ContextBar } from '../students/students-layout';
import { StudentContextProvider, useStudentContext } from '../students/context';

function NoCampus() {
  const ctx = useStudentContext();
  if (ctx.loading || ctx.location) return null;
  return (
    <Alert tone="warning" title="No campus yet" className="mb-4">
      Add a campus in School Setup first. Rooms belong to a campus.
    </Alert>
  );
}

/**
 * Wraps the Campus screens with the same “2026-27 · Mohali Campus” bar the Students screens use. Rooms belong to the campus, so the
 * school year only matters later, on the class-room screens.
 */
export function SpacesLayout() {
  return (
    <StudentContextProvider>
      <ContextBar />
      <NoCampus />
      <Outlet />
    </StudentContextProvider>
  );
}
