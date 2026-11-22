/**
 * Money helpers. Money is a whole number of paise (₹1 = 100 paise) everywhere in the finance module. These are the only places
 * that turn text into money, divide money, or work out a percentage, so rounding is the same on every screen and every report.
 * Rounding is "half up" and happens once per line.
 */

const MAX_SAFE = Number.MAX_SAFE_INTEGER;

export function assertPaise(value: number, label = 'amount'): number {
  if (!Number.isSafeInteger(value)) throw new Error(`The ${label} must be a whole number of paise.`);
  return value;
}

/** `"1,500.50"`, `"₹1500"` or `"12.5"` to paise. Returns `null` when the text is not an amount with at most two decimals. */
export function toPaise(rupees: string): number | null {
  const clean = rupees.replace(/[₹,\s]/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  const whole = Number.parseInt(m[1]!, 10);
  const fraction = Number.parseInt((m[2] ?? '').padEnd(2, '0') || '0', 10);
  const total = whole * 100 + fraction;
  return total > MAX_SAFE ? null : total;
}

/** Indian grouping: 1234567 paise → "₹12,345.67". Whole rupees drop the ".00". */
export function formatMoney(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(assertPaise(paise));
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = head ? `${head},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** `numerator / denominator` rounded half up to a whole number, with no floating point. Negative numerators round away from zero. */
export function roundHalfUp(numerator: number, denominator: number): number {
  if (denominator === 0) throw new Error('Cannot divide money by zero.');
  const n = BigInt(assertPaise(numerator));
  const d = BigInt(assertPaise(denominator));
  const sign = (n < 0n) !== (d < 0n) ? -1n : 1n;
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  return Number(sign * ((2n * an + ad) / (2n * ad)));
}

/** `bps` basis points of an amount: `percentOf(150000, 1800)` is 18% = 27000. */
export function percentOf(paise: number, bps: number): number {
  return proportion(assertPaise(paise), assertPaise(bps), 10_000);
}

/** Splits an amount into `parts` pieces that add up to the amount. Any odd paise go to the first pieces. */
export function splitEvenly(total: number, parts: number): number[] {
  if (!Number.isInteger(parts) || parts < 1) throw new Error('Split into at least one part.');
  const base = Math.floor(total / parts);
  const extra = total - base * parts;
  return Array.from({ length: parts }, (_, i) => base + (i < extra ? 1 : 0));
}

/** `amount × part / whole` rounded half up. The share of a line a credit note takes back. */
export function proportion(amount: number, part: number, whole: number): number {
  if (whole === 0) return 0;
  return Number((BigInt(amount) * BigInt(part) * 2n + BigInt(whole)) / (2n * BigInt(whole)));
}

export const sumPaise = (values: readonly number[]): number => values.reduce((a, b) => a + b, 0);
