/**
 * Money on screen. The API sends and takes whole paise (₹1 = 100 paise). Screens show rupees. These two functions are the only
 * places that turn one into the other, so there is never a decimal in a request and never a float in a total.
 */

/** `1234567` paise → `₹12,345.67`. Whole rupees drop the `.00`. Indian grouping (lakh, crore). */
export function formatMoney(paise: number): string {
  const negative = paise < 0;
  const abs = Math.abs(Math.trunc(paise));
  const rupees = Math.floor(abs / 100);
  const rest = abs % 100;
  const digits = String(rupees);
  const last3 = digits.slice(-3);
  const head = digits.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  const grouped = head ? `${head},${last3}` : last3;
  return `${negative ? '-' : ''}₹${grouped}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** `4120000000` paise → `₹4.12 crore`, `4120000` → `₹41,200`. Short form for big headline numbers. */
export function formatMoneyShort(paise: number): string {
  const negative = paise < 0;
  const rupees = Math.abs(Math.trunc(paise)) / 100;
  const sign = negative ? '-' : '';
  const trim = (n: number) => String(Math.round(n * 100) / 100);
  if (rupees >= 10_000_000) return `${sign}₹${trim(rupees / 10_000_000)} crore`;
  if (rupees >= 100_000) return `${sign}₹${trim(rupees / 100_000)} lakh`;
  return formatMoney(paise);
}

/** `"1,500.50"`, `"₹1500"` or `"12.5"` → paise. `null` when the text is not an amount with at most two decimals. */
export function toPaise(text: string): number | null {
  const clean = text.replace(/[₹,\s]/g, '');
  const m = /^(\d{1,12})(?:\.(\d{1,2}))?$/.exec(clean);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/** `150050` → `"1500.50"`, `400000` → `"4000"`. The text a person edits in a MoneyField. */
export function paiseToText(paise: number): string {
  const abs = Math.abs(Math.trunc(paise));
  const rest = abs % 100;
  return `${Math.floor(abs / 100)}${rest ? `.${String(rest).padStart(2, '0')}` : ''}`;
}

/** Basis points (`1800`) → a percentage text (`18`). `1250` → `12.5`. */
export function bpsToPercentText(bps: number): string {
  const whole = Math.floor(bps / 100);
  const rest = bps % 100;
  return rest ? `${whole}.${String(rest).padStart(2, '0').replace(/0$/, '')}` : String(whole);
}

/** A percentage text (`"12.5"`) → basis points (`1250`). `null` when it is not a number with at most two decimals. */
export function percentTextToBps(text: string): number | null {
  const m = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}
