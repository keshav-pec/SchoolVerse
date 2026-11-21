import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AcademicSessionDTO, MasterLocationDTO } from '@shared';
import { useActiveLocations, useSessions } from '../academic/api';

const KEY = 'sv.students.context';

interface Stored {
  sessionId?: string;
  locationId?: string;
}

function read(): Stored {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Stored;
  } catch {
    return {};
  }
}

export interface StudentContextValue {
  /** The school year every Students screen uses. `undefined` until the list has loaded. */
  sessionId: string | undefined;
  locationId: string | undefined;
  session: AcademicSessionDTO | undefined;
  location: MasterLocationDTO | undefined;
  sessions: AcademicSessionDTO[];
  locations: MasterLocationDTO[];
  setSessionId: (id: string) => void;
  setLocationId: (id: string) => void;
  loading: boolean;
}

const Ctx = createContext<StudentContextValue | null>(null);

/**
 * "2026-27 · Mohali Campus": the school year and campus are picked once and every Students screen follows them, so nobody
 * has to choose them again inside a form. The choice is remembered on this device. Starts with the current year and the
 * main campus.
 */
export function StudentContextProvider({ children }: { children: ReactNode }) {
  const sessionsQ = useSessions();
  const locationsQ = useActiveLocations();
  const [stored, setStored] = useState<Stored>(read);

  const sessions = useMemo(() => sessionsQ.data ?? [], [sessionsQ.data]);
  const locations = useMemo(() => (locationsQ.data ?? []).filter((l) => l.status === 'ACTIVE'), [locationsQ.data]);

  const session = sessions.find((s) => s.academicSessionId === stored.sessionId) ?? sessions.find((s) => s.isCurrent) ?? sessions[0];
  const location = locations.find((l) => l.locationId === stored.locationId) ?? locations.find((l) => l.isPrimary) ?? locations[0];

  useEffect(() => {
    localStorage.setItem(KEY, JSON.stringify(stored));
  }, [stored]);

  const value: StudentContextValue = {
    sessionId: session?.academicSessionId,
    locationId: location?.locationId,
    session,
    location,
    sessions,
    locations,
    setSessionId: (sessionId) => setStored((s) => ({ ...s, sessionId })),
    setLocationId: (locationId) => setStored((s) => ({ ...s, locationId })),
    loading: sessionsQ.isLoading || locationsQ.isLoading,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useStudentContext(): StudentContextValue {
  const value = useContext(Ctx);
  if (!value) throw new Error('useStudentContext needs <StudentContextProvider>');
  return value;
}

/** For places (like the sidebar badge) that may render outside the Students screens. */
export function useOptionalStudentContext(): StudentContextValue | null {
  return useContext(Ctx);
}
