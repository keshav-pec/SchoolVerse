import { addDays } from '../../core/dates';

/**
 * Ending an effective-dated row. `lastDay` is the last day it still counts (inclusive).
 * A row that never started (its last day is before its first day) is cancelled instead, so it never shows as "ended".
 */
export function endPatch(row: { effectiveFrom: string }, lastDay: string): { effectiveTo: string } | { cancelledAt: Date } {
  return lastDay < row.effectiveFrom ? { cancelledAt: new Date() } : { effectiveTo: lastDay };
}

/** The last day of something that stops on `date`: the day before. */
export const dayBefore = (date: string) => addDays(date, -1);
