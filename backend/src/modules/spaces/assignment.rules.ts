import type { HomeClassroomPhase } from '@shared';
import type { SectionSpaceAssignmentDoc } from './space.models';

/**
 * Date and overlap rules for Home Classroom rows. Pure functions, so every screen and report agrees on what is planned, running or over.
 * A row with no last day runs until its session ends.
 */

export type Dated = Pick<SectionSpaceAssignmentDoc, 'effectiveFrom' | 'effectiveTo'>;

export const endOf = (row: Pick<Dated, 'effectiveTo'>, sessionEnd: string) => row.effectiveTo ?? sessionEnd;

export function phaseOf(row: Dated & Pick<SectionSpaceAssignmentDoc, 'status'>, sessionEnd: string, today: string): HomeClassroomPhase {
  if (row.status === 'CANCELLED') return 'CANCELLED';
  if (today < row.effectiveFrom) return 'PLANNED';
  if (today > endOf(row, sessionEnd)) return 'ENDED';
  return 'ACTIVE';
}

/** Is the row in force on `date`? (Cancelled rows never are.) */
export const runsOn = (row: Dated & Pick<SectionSpaceAssignmentDoc, 'status'>, date: string, sessionEnd: string) => row.status !== 'CANCELLED' && row.effectiveFrom <= date && date <= endOf(row, sessionEnd);

/** Is it running now or still to come? Rows like this are what "depends on" a room. */
export const isLive = (row: Dated & Pick<SectionSpaceAssignmentDoc, 'status'>, sessionEnd: string, today: string) => row.status !== 'CANCELLED' && endOf(row, sessionEnd) >= today;

/** Two periods inside one session share a day. */
export const periodsOverlap = (a: Dated, b: Dated, sessionEnd: string) => a.effectiveFrom <= endOf(b, sessionEnd) && b.effectiveFrom <= endOf(a, sessionEnd);

/**
 * Can two sections use one room at the same time? Only when both name a shift and the shifts differ. With no shift (or the same shift)
 * the overlap is a clash: until a Shift module exists, an unnamed shift cannot be told apart from another.
 */
export const shiftsClash = (a: string | null | undefined, b: string | null | undefined) => !a || !b || a === b;

/** The start of a date as a moment (UTC), and its last millisecond. Closures are stored as moments, assignments as dates. */
export const startOfDay = (date: string) => new Date(`${date}T00:00:00.000Z`);
export const endOfDay = (date: string) => new Date(`${date}T23:59:59.999Z`);

/** "1 Apr 2026" for messages. */
export function niceDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
