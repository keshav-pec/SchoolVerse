import type { ReportColumn, ReportDTO } from '@shared';
import { toCsv } from '../../../platform/identity/csv';
import { toRupeesText } from './money';

/**
 * Every report states its basis, so a reader knows what the numbers are: "Based on posted journals (accrual)" or "Operational view: money
 * received". Billed, verified cash and reconciled bank amounts are kept apart and labelled. The CSV escapes any cell that starts with
 * `= + - @`, so a spreadsheet never runs one as a formula.
 */
export const BASIS = {
  JOURNALS: 'Based on posted journals (accrual).',
  RECEIVED: 'Operational view: money received and confirmed by the school.',
  BILLED: 'Operational view: what was billed. This is not money received.',
  PENDING: 'Operational view: money waiting to be confirmed. This is not yet received money.',
  PAYROLL: 'Operational view: payroll runs as finalised. Paid status comes from verified payments.',
} as const;

export function makeReport(input: { type: string; title: string; basis: string; from?: string | null | undefined; to?: string | null | undefined; columns: ReportColumn[]; rows: Record<string, string | number | null>[]; totals?: Record<string, number> | null; notes?: string[] }): ReportDTO {
  return { type: input.type, title: input.title, basis: input.basis, from: input.from ?? null, to: input.to ?? null, columns: input.columns, rows: input.rows, totals: input.totals ?? null, notes: input.notes ?? [] };
}

export function sumRows(rows: Record<string, string | number | null>[], keys: string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, rows.reduce((s, r) => s + (typeof r[k] === 'number' ? (r[k] as number) : 0), 0)]));
}

export function reportCsv(report: ReportDTO): string {
  const money = new Set(report.columns.filter((c) => c.kind === 'money').map((c) => c.key));
  const head = [`${report.title}`, report.basis, ...(report.from || report.to ? [`${report.from ?? ''} to ${report.to ?? ''}`] : [])];
  const body = report.rows.map((r) => report.columns.map((c) => (money.has(c.key) && typeof r[c.key] === 'number' ? toRupeesText(r[c.key] as number) : r[c.key] ?? '')));
  const totals = report.totals ? [report.columns.map((c, i) => (i === 0 ? 'Total' : money.has(c.key) && report.totals![c.key] !== undefined ? toRupeesText(report.totals![c.key]!) : report.totals![c.key] !== undefined ? report.totals![c.key]! : ''))] : [];
  return `${head.map((h) => toCsv([h], []).trimEnd()).join('\r\n')}\r\n${toCsv(report.columns.map((c) => c.label), [...body, ...totals])}`;
}
