import type { ConcessionType, ConcessionValueType, StackMode } from '@shared';
import { formatMoney, percentOf } from '../core/money';

/**
 * Concessions on one fee line (FEE-05, 06). Awards are grouped by how they combine:
 *   HIGHEST_WINS   only the biggest of them counts (a sibling discount and a staff-child discount do not both apply)
 *   STACK          they add up
 * The two groups then add together, and the total can never go above the lowest cap (a share of the line) or above the line itself.
 */
export interface AppliedAward {
  awardId: string;
  name: string;
  type: ConcessionType;
  valueType: ConcessionValueType;
  value: number;
  stackMode: StackMode;
  capPercentBps: number | null;
}

export interface DiscountResult {
  discountPaise: number;
  awardIds: string[];
  explanation: string;
}

const amountOf = (a: AppliedAward, base: number) => (a.valueType === 'PERCENT' ? percentOf(base, a.value) : Math.min(a.value, base));
const label = (a: AppliedAward) => (a.valueType === 'PERCENT' ? `${Number((a.value / 100).toFixed(2))}%` : formatMoney(a.value));

export function computeDiscount(basePaise: number, awards: AppliedAward[]): DiscountResult {
  if (basePaise <= 0 || awards.length === 0) return { discountPaise: 0, awardIds: [], explanation: '' };
  const withAmount = awards.map((a) => ({ a, amount: amountOf(a, basePaise) }));
  const highest = withAmount.filter((x) => x.a.stackMode === 'HIGHEST_WINS').sort((x, y) => y.amount - x.amount)[0];
  const stacked = withAmount.filter((x) => x.a.stackMode === 'STACK');
  const used = [...(highest ? [highest] : []), ...stacked];
  let total = used.reduce((s, x) => s + x.amount, 0);
  const caps = awards.map((a) => a.capPercentBps).filter((c): c is number => c !== null);
  const cap = caps.length ? Math.min(...caps) : null;
  let capped = false;
  if (cap !== null) {
    const limit = percentOf(basePaise, cap);
    if (total > limit) {
      total = limit;
      capped = true;
    }
  }
  if (total > basePaise) total = basePaise;
  const parts = used.map((x) => `${x.a.name} ${label(x.a)}`).join(' + ');
  return { discountPaise: total, awardIds: used.map((x) => x.a.awardId), explanation: `${parts} = −${formatMoney(total)}${capped ? ` (limited to ${Number(((cap ?? 0) / 100).toFixed(2))}% of the fee)` : ''}` };
}
