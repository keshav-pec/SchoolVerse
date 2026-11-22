import type { FeeFrequency, ProrationMethod } from '@shared';
import { addDays, daysBetween } from '../../../core/dates';
import { addMonths, monthKeyOf, monthRange } from '../core/context';
import { formatMoney, proportion } from '../core/money';

/**
 * When a fee item is billed, and how much of it a student owes for a part period. Everything is worked out from dates, in the same
 * way for the preview, the bill and "expected later", so the three never disagree.
 */
export interface SessionDates {
  startDate: string;
  endDate: string;
}
export interface TermDates {
  startDate: string;
  endDate: string;
  locationId: string | null;
}

/** Month keys of a session, in order: `2026-04` … `2027-03`. */
export function sessionMonths(session: SessionDates): string[] {
  const out: string[] = [];
  let key = monthKeyOf(session.startDate);
  const last = monthKeyOf(session.endDate);
  while (key <= last && out.length < 36) {
    out.push(key);
    key = addMonths(key, 1);
  }
  return out;
}

/** The months in which an item is billed. A term fee is billed in the month each term starts (or twice a year when no terms are set). */
export function billingPeriods(frequency: FeeFrequency, session: SessionDates, terms: TermDates[], locationId: string): string[] {
  const months = sessionMonths(session);
  const every = (n: number) => months.filter((_, i) => i % n === 0);
  switch (frequency) {
    case 'MONTHLY':
      return months;
    case 'QUARTERLY':
      return every(3);
    case 'HALF_YEARLY':
      return every(6);
    case 'YEARLY':
    case 'ONE_TIME':
      return months.slice(0, 1);
    case 'TERM': {
      const own = terms.filter((t) => t.locationId === locationId);
      const usable = own.length ? own : terms.filter((t) => t.locationId === null);
      const keys = [...new Set(usable.map((t) => monthKeyOf(t.startDate)).filter((k) => months.includes(k)))].sort();
      return keys.length ? keys : every(6);
    }
  }
}

/** The days an item's period covers: from the first of its month to the day before its next period (or the end of the session). */
export function periodSpan(periods: string[], periodKey: string, session: SessionDates): { start: string; end: string; days: number } {
  const i = periods.indexOf(periodKey);
  const start = monthRange(periodKey).start;
  const nextKey = i >= 0 ? periods[i + 1] : undefined;
  const end = nextKey ? addDays(monthRange(nextKey).start, -1) : session.endDate;
  return { start, end, days: daysBetween(start, end) + 1 };
}

export interface ProrationResult {
  /** `null` means the student owes nothing for this period. */
  amountPaise: number | null;
  explanation: string;
  prorated: boolean;
}

/**
 * Joining or leaving in the middle of a period.
 *   FULL_PERIOD    charge the whole period whatever the date
 *   CALENDAR_DAYS  charge only the days the student is here: "18 of 30 days × ₹4,000 = ₹2,400"
 *   NONE           no charge for a part period; the fee starts with the next whole period
 */
export function prorate(amountPaise: number, method: ProrationMethod, span: { start: string; end: string; days: number }, stay: { from: string; to: string | null }): ProrationResult {
  if (stay.from > span.end || (stay.to !== null && stay.to < span.start)) return { amountPaise: null, explanation: 'Not at the school during this period.', prorated: false };
  const from = stay.from > span.start ? stay.from : span.start;
  const to = stay.to !== null && stay.to < span.end ? stay.to : span.end;
  const partial = from !== span.start || to !== span.end;
  if (!partial || method === 'FULL_PERIOD') return { amountPaise, explanation: '', prorated: false };
  if (method === 'NONE') return { amountPaise: null, explanation: 'Joined part-way through the period, so there is no charge until the next one.', prorated: false };
  const days = daysBetween(from, to) + 1;
  const share = proportion(amountPaise, days, span.days);
  return { amountPaise: share, explanation: `${days} of ${span.days} days × ${formatMoney(amountPaise)} = ${formatMoney(share)}`, prorated: true };
}

/** The due date of a period: the item's due day in the month of the period (never later than the 28th). */
export const dueDateFor = (periodKey: string, dueDay: number): string => `${periodKey}-${String(Math.min(Math.max(dueDay, 1), 28)).padStart(2, '0')}`;

/** How many times an item is billed in a session. Used for "Expected this year". */
export const occurrencesIn = (frequency: FeeFrequency, session: SessionDates, terms: TermDates[], locationId: string): number => billingPeriods(frequency, session, terms, locationId).length;
