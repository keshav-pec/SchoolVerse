import type { ClientSession } from 'mongoose';
import type { Weekday } from '@shared';

/**
 * The hook between Daily Periods (Part 1) and the lessons that sit in them (Part 3). A change to a period, or removing a school day, asks
 * every registered finder "what uses this?". Part 1 registers one finder that always answers "nothing yet"; Part 3 registers the real one
 * under the same key, so no Part 1 code changes.
 */
export interface UsageQuery {
  tenantId: string;
  planId: string;
  periodIds?: string[];
  weekday?: Weekday;
  session?: ClientSession;
}
export interface UsageAnswer {
  count: number;
  /** Plain words, e.g. "8-A Maths, Monday Period 3". At most a few. */
  examples: string[];
}
export type UsageFinder = (query: UsageQuery) => Promise<UsageAnswer>;

const finders = new Map<string, UsageFinder>();

export function registerPeriodUsage(key: string, finder: UsageFinder) {
  finders.set(key, finder);
}

export async function findPeriodUsage(query: UsageQuery): Promise<UsageAnswer> {
  const answers = await Promise.all([...finders.values()].map((f) => f(query)));
  return { count: answers.reduce((n, a) => n + a.count, 0), examples: answers.flatMap((a) => a.examples).slice(0, 5) };
}

registerPeriodUsage('timetable.period_in_use', async () => ({ count: 0, examples: [] }));
