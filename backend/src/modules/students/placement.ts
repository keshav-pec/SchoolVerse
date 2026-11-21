import { isOpenOn } from './rules';
import type { StudentEnrollmentDoc, StudentSectionAssignmentDoc } from './student.models';

/**
 * Where is a student "now"? Picks from effective-dated rows, never from a stored field.
 * The enrollment: the OPEN one running today, else the next one starting, else the most recent that is not cancelled.
 * The section: the one running today, else the next one starting, else the most recent.
 */
function pick<T extends { effectiveFrom: string; effectiveTo?: string | null; cancelledAt?: Date | string | null }>(rows: readonly T[], today: string, open: (row: T) => boolean = () => true): T | null {
  const live = rows.filter((r) => !r.cancelledAt);
  const running = live.filter((r) => open(r) && isOpenOn(r, today)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  if (running[0]) return running[0];
  const upcoming = live.filter((r) => open(r) && r.effectiveFrom > today).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  if (upcoming[0]) return upcoming[0];
  return [...live].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
}

export function pickEnrollment(rows: readonly StudentEnrollmentDoc[], today: string): StudentEnrollmentDoc | null {
  // A cancelled enrollment is never "where the student is". OPEN ones win over finished ones.
  const candidates = rows.filter((r) => r.state !== 'CANCELLED');
  const open = candidates.filter((r) => r.state === 'OPEN');
  return pick(open, today) ?? pick(candidates, today);
}

export function pickAssignment(rows: readonly StudentSectionAssignmentDoc[], today: string): StudentSectionAssignmentDoc | null {
  return pick(rows, today);
}

/** The enrollment of one session: the OPEN one if there is one, else the latest. */
export function pickEnrollmentIn(rows: readonly StudentEnrollmentDoc[], sessionId: string): StudentEnrollmentDoc | null {
  const inSession = rows.filter((r) => r.academicSessionId === sessionId && r.state !== 'CANCELLED').sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return inSession.find((r) => r.state === 'OPEN') ?? inSession[0] ?? null;
}
