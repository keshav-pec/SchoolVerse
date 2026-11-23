import { createHash } from 'node:crypto';
import type { StatementImportDTO, StatementLineDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { parseCsv } from '../../../platform/identity/csv';
import { scanFile } from '../../../platform/identity/file-checks';
import { privateStorage } from '../../../platform/identity/private-storage';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { normRef } from '../collections/collection.service';
import { auditFinance, emitFinance, financeCtx, financeScope, type FinanceCtx } from '../core/context';
import { BankAccount, type BankAccountDoc } from '../core/models';
import { toPaise } from '../core/money';
import { BankStatementImport, BankStatementLine, BankStatementMapping, type BankStatementImportDoc, type BankStatementLineDoc, type StatementMapping } from './models';

/**
 * Bank statement import (FIN-09). The CSV is kept exactly as uploaded, privately. Columns are found by their names and remembered for
 * the bank account. Nothing is half imported: one bad row refuses the file and says which row. The same file twice is refused. Two real
 * payments of the same amount on the same day are BOTH kept; if the order is unclear (the same reference twice) they are flagged for a person to look at.
 */

const ALIASES: Record<keyof StatementMapping, string[]> = {
  date: ['date', 'txndate', 'transactiondate', 'valuedate', 'postdate', 'postingdate'],
  description: ['description', 'narration', 'particulars', 'remarks', 'details', 'transactionremarks'],
  reference: ['reference', 'referenceno', 'refno', 'utr', 'chqrefno', 'chequeno', 'transactionid', 'txnid', 'utrno', 'chqno'],
  debit: ['debit', 'withdrawal', 'withdrawalamt', 'withdrawals', 'dr', 'debitamount'],
  credit: ['credit', 'deposit', 'depositamt', 'deposits', 'cr', 'creditamount'],
  amount: ['amount', 'txnamount', 'transactionamount'],
  balance: ['balance', 'closingbalance', 'runningbalance', 'availablebalance'],
};
const squash = (s: string) => s.toLowerCase().replace(/[^a-z]/g, '');

export function autoMap(headers: string[]): StatementMapping | null {
  const find = (key: keyof StatementMapping) => headers.find((h) => ALIASES[key].includes(squash(h))) ?? null;
  const date = find('date');
  const debit = find('debit');
  const credit = find('credit');
  const amount = find('amount');
  if (!date || !((debit && credit) || amount)) return null;
  return { date, description: find('description'), reference: find('reference'), debit, credit, amount: debit && credit ? null : amount, balance: find('balance') };
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseStatementDate(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  let y: number, mo: number, d: number;
  if (m) [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  else if ((m = /^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/.exec(t))) [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])] as [number, number, number];
  else if ((m = /^(\d{1,2})[ \-/]([A-Za-z]{3})[a-z]*[ \-/](\d{4})$/.exec(t))) [d, mo, y] = [Number(m[1]), MONTHS.indexOf(m[2]!.toLowerCase()) + 1, Number(m[3])] as [number, number, number];
  else return null;
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).getUTCDate() === d ? iso : null;
}

/** An amount cell: blank is zero, `1,500.00` and `(1,500.00)` and `-1500` are read, anything else is a problem (null). */
function parseAmount(text: string | undefined): { paise: number; negative: boolean } | null {
  const raw = (text ?? '').trim();
  if (raw === '') return { paise: 0, negative: false };
  const negative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  const paise = toPaise(raw.replace(/^[-(]+|\)$/g, '').replace(/\s*(dr|cr)\.?$/i, ''));
  return paise === null ? null : { paise, negative };
}

interface ParsedLine {
  lineNo: number;
  date: string;
  description: string;
  reference: string | null;
  referenceNorm: string | null;
  debitPaise: number;
  creditPaise: number;
  balancePaise: number | null;
}

function parseRows(text: string, mappingOverride: Partial<StatementMapping> | null, remembered: StatementMapping | null): { mapping: StatementMapping; lines: ParsedLine[] } {
  const table = parseCsv(text);
  if (table.length < 2) throw new AppError('STATEMENT_INVALID', 'The file has no rows.');
  const headers = table[0]!;
  const mapping = mappingOverride ? { ...autoMap(headers), ...mappingOverride } as StatementMapping : remembered && remembered.date && headers.includes(remembered.date) ? remembered : autoMap(headers);
  if (!mapping || !mapping.date) throw new AppError('STATEMENT_INVALID', 'We could not find the date and amount columns. Say which column is which and try again.', { headers });
  const col = (name: string | null) => (name ? headers.indexOf(name) : -1);
  const idx = { date: col(mapping.date), description: col(mapping.description), reference: col(mapping.reference), debit: col(mapping.debit), credit: col(mapping.credit), amount: col(mapping.amount), balance: col(mapping.balance) };
  if (idx.date < 0 || (idx.amount < 0 && (idx.debit < 0 || idx.credit < 0))) throw new AppError('STATEMENT_INVALID', 'A column named in the mapping is not in the file.', { headers });
  const problems: { row: number; message: string }[] = [];
  const lines: ParsedLine[] = [];
  table.slice(1).forEach((cells, i) => {
    const row = i + 2;
    const date = parseStatementDate(cells[idx.date] ?? '');
    if (!date) return void problems.push({ row, message: `The date "${cells[idx.date] ?? ''}" is not a date.` });
    let debit = 0;
    let credit = 0;
    if (idx.amount >= 0) {
      const a = parseAmount(cells[idx.amount]);
      if (!a) return void problems.push({ row, message: `The amount "${cells[idx.amount] ?? ''}" is not an amount.` });
      if (a.negative) debit = a.paise;
      else credit = a.paise;
    } else {
      const d = parseAmount(cells[idx.debit]);
      const c = parseAmount(cells[idx.credit]);
      if (!d || !c) return void problems.push({ row, message: 'A debit or credit amount is not an amount.' });
      debit = d.paise;
      credit = c.paise;
    }
    if (debit > 0 && credit > 0) return void problems.push({ row, message: 'A line cannot be both a debit and a credit.' });
    if (debit === 0 && credit === 0) return; // an opening or closing balance row
    const bal = idx.balance >= 0 && (cells[idx.balance] ?? '').trim() !== '' ? parseAmount(cells[idx.balance]) : null;
    const reference = idx.reference >= 0 ? (cells[idx.reference] ?? '').trim() || null : null;
    lines.push({ lineNo: row, date, description: idx.description >= 0 ? (cells[idx.description] ?? '').trim().slice(0, 300) : '', reference, referenceNorm: normRef(reference), debitPaise: debit, creditPaise: credit, balancePaise: bal ? (bal.negative ? -bal.paise : bal.paise) : null });
  });
  if (problems.length) throw new AppError('STATEMENT_INVALID', `${problems.length} row${problems.length === 1 ? ' has' : 's have'} a problem. Nothing was imported.`, { problems: problems.slice(0, 20) });
  if (lines.length === 0) throw new AppError('STATEMENT_INVALID', 'The file has no payments in it.');
  return { mapping, lines };
}

export const lineDTO = (l: BankStatementLineDoc): StatementLineDTO => ({
  lineId: l._id, importId: l.importId, bankAccountId: l.bankAccountId, date: l.date, description: l.description, reference: l.reference, debitPaise: l.debitPaise, creditPaise: l.creditPaise, balancePaise: l.balancePaise,
  status: l.status, matchId: l.matchId, ignoredReason: l.ignoredReason,
});

export async function scopedBank(ctx: ServiceContext, f: FinanceCtx, bankAccountId: string): Promise<BankAccountDoc> {
  const bank = await BankAccount.findOne({ _id: bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<BankAccountDoc>();
  if (!bank) throw AppError.notFound('Bank account not found.');
  const scope = await financeScope(ctx);
  if (!scope.all && bank.locationIds.length > 0 && !bank.locationIds.some((id) => scope.locationIds.includes(id))) throw AppError.notFound('Bank account not found.');
  return bank;
}

export async function importStatement(ctx: ServiceContext, bankAccountId: string, file: { buffer: Buffer; originalname?: string } | undefined, options: { openingBalance?: string | undefined; closingBalance?: string | undefined; mapping?: string | undefined }): Promise<StatementImportDTO> {
  if (!file || file.buffer.length === 0) throw AppError.validation({ file: 'Choose the bank statement file (CSV).' });
  if (file.buffer.includes(0)) throw new AppError('STATEMENT_INVALID', 'This does not look like a CSV file.');
  if (!(await scanFile(file.buffer)).clean) throw new AppError('FILE_REJECTED');
  const f = await financeCtx(ctx);
  const bank = await scopedBank(ctx, f, bankAccountId);
  const fileHash = createHash('sha256').update(file.buffer).digest('hex');
  const earlier = await BankStatementImport.findOne({ tenantId: f.tenantId, bankAccountId, fileHash }).lean<BankStatementImportDoc>();
  if (earlier) throw new AppError('STATEMENT_ALREADY_IMPORTED', `This file was already imported on ${earlier.createdAt.toISOString().slice(0, 10)}.`, { importId: earlier._id });

  let override: Partial<StatementMapping> | null = null;
  if (options.mapping) {
    try { override = JSON.parse(options.mapping) as Partial<StatementMapping>; } catch { throw AppError.validation({ mapping: 'The column names must be written as JSON.' }); }
  }
  const remembered = (await BankStatementMapping.findOne({ tenantId: f.tenantId, bankAccountId }).lean<{ mapping: StatementMapping }>())?.mapping ?? null;
  const { mapping, lines } = parseRows(file.buffer.toString('utf8'), override, remembered);

  const today = await todayFor(ctx);
  for (const l of lines) if (l.date < '2000-01-01' || l.date > today) throw new AppError('STATEMENT_INVALID', `Line ${l.lineNo} has the date ${l.date}, which is not a believable bank date.`, { problems: [{ row: l.lineNo, message: 'The date is in the future or too old.' }] });

  const credits = lines.reduce((s, l) => s + l.creditPaise, 0);
  const debits = lines.reduce((s, l) => s + l.debitPaise, 0);
  const opening = options.openingBalance ? toPaise(options.openingBalance) : null;
  const closing = options.closingBalance ? toPaise(options.closingBalance) : null;
  if ((options.openingBalance && opening === null) || (options.closingBalance && closing === null)) throw AppError.validation({ openingBalance: 'Enter the balance as an amount, like 125000.50.' });
  if (opening !== null && closing !== null && opening + credits - debits !== closing) throw new AppError('STATEMENT_INVALID', 'The statement does not add up: opening balance + money in − money out is not the closing balance. Check the file and the balances.', { openingPaise: opening, creditsPaise: credits, debitsPaise: debits, closingPaise: closing });

  // The fingerprint says "this exact line". The occurrence number tells two identical lines apart, so neither is dropped.
  const seen = new Map<string, number>();
  const prepared = lines.map((l) => {
    const fingerprint = createHash('sha256').update([l.date, l.debitPaise, l.creditPaise, l.referenceNorm ?? '', l.description.toLowerCase().replace(/\s+/g, ' '), l.balancePaise ?? ''].join('|')).digest('hex');
    const occurrence = (seen.get(fingerprint) ?? 0) + 1;
    seen.set(fingerprint, occurrence);
    return { ...l, fingerprint, occurrence };
  });

  const fileKey = await privateStorage.put(file.buffer, { folder: 'finance' });
  try {
    const result = await withTransaction(async (db) => {
      const existing = await BankStatementLine.find({ tenantId: f.tenantId, bankAccountId, fingerprint: { $in: prepared.map((p) => p.fingerprint) } }).session(db).select('fingerprint occurrence').lean<{ fingerprint: string; occurrence: number }[]>();
      const have = new Set(existing.map((e) => `${e.fingerprint}:${e.occurrence}`));
      const fresh = prepared.filter((p) => !have.has(`${p.fingerprint}:${p.occurrence}`));
      const dates = lines.map((l) => l.date).sort();
      const [doc] = await BankStatementImport.create(
        [{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, bankAccountId, fileName: (file.originalname ?? 'statement.csv').slice(0, 120), fileHash, fileKey, mapping, rowCount: lines.length, keptCount: fresh.length, skippedCount: lines.length - fresh.length, creditsPaise: credits, debitsPaise: debits, openingPaise: opening, closingPaise: closing, fromDate: dates[0]!, toDate: dates.at(-1)!, importedBy: ctx.userId }],
        { session: db },
      );
      await BankStatementLine.create(
        fresh.map((p) => ({ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, importId: doc!._id, bankAccountId, lineNo: p.lineNo, date: p.date, description: p.description, reference: p.reference, referenceNorm: p.referenceNorm, debitPaise: p.debitPaise, creditPaise: p.creditPaise, balancePaise: p.balancePaise, fingerprint: p.fingerprint, occurrence: p.occurrence, status: p.occurrence > 1 && p.referenceNorm ? ('DUPLICATE_SUSPECTED' as const) : ('UNMATCHED' as const) })),
        { session: db, ordered: true },
      );
      await BankStatementMapping.updateOne({ tenantId: f.tenantId, bankAccountId }, { $set: { mapping, schoolId: f.schoolId, legalEntityId: f.legalEntityId } }, { upsert: true, session: db });
      await auditFinance(f, db, { action: 'bank_statement.imported', entityType: 'bank_statement_import', entityId: doc!._id, after: { rows: lines.length, kept: fresh.length, creditsPaise: credits, debitsPaise: debits, bank: bank.label } });
      await emitFinance(f, db, 'bank_statement.imported', { importId: doc!._id, bankAccountId, rows: fresh.length });
      return { doc: doc!.toObject() as BankStatementImportDoc, suspect: fresh.filter((p) => p.occurrence > 1 && p.referenceNorm).length };
    });
    return importDTO(result.doc, result.suspect);
  } catch (err) {
    await privateStorage.remove(fileKey);
    if (duplicateKeyFields(err)) throw new AppError('STATEMENT_ALREADY_IMPORTED');
    throw err;
  }
}

const importDTO = (d: BankStatementImportDoc, suspect: number): StatementImportDTO => ({
  importId: d._id, bankAccountId: d.bankAccountId, fileName: d.fileName, rowCount: d.rowCount, keptCount: d.keptCount, skippedCount: d.skippedCount, creditsPaise: d.creditsPaise, debitsPaise: d.debitsPaise, openingPaise: d.openingPaise, closingPaise: d.closingPaise,
  fromDate: d.fromDate, toDate: d.toDate, suspectedDuplicates: suspect, createdAt: d.createdAt.toISOString(),
});

export async function listImports(ctx: ServiceContext, bankAccountId: string): Promise<StatementImportDTO[]> {
  const f = await financeCtx(ctx);
  await scopedBank(ctx, f, bankAccountId);
  const rows = await BankStatementImport.find({ tenantId: f.tenantId, bankAccountId }).sort({ createdAt: -1 }).limit(50).lean<BankStatementImportDoc[]>();
  const counts = await BankStatementLine.aggregate<{ _id: string; n: number }>([{ $match: { tenantId: f.tenantId, importId: { $in: rows.map((r) => r._id) }, status: 'DUPLICATE_SUSPECTED' } }, { $group: { _id: '$importId', n: { $sum: 1 } } }]);
  const by = new Map(counts.map((c) => [c._id, c.n]));
  return rows.map((r) => importDTO(r, by.get(r._id) ?? 0));
}

export async function listLines(ctx: ServiceContext, query: { bankAccountId: string; page: number; pageSize: number; status?: string | undefined; from?: string | null | undefined; to?: string | null | undefined; q?: string | undefined }) {
  const f = await financeCtx(ctx);
  await scopedBank(ctx, f, query.bankAccountId);
  const filter: Record<string, unknown> = {
    tenantId: f.tenantId, bankAccountId: query.bankAccountId, ...(query.status ? { status: { $in: query.status.split(',') } } : {}), ...(query.from || query.to ? { date: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}),
    ...(query.q ? { $or: [{ referenceNorm: { $regex: normRef(query.q) ?? '$^' } }, { description: { $regex: query.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' } }] } : {}),
  };
  const [rows, total] = await Promise.all([BankStatementLine.find(filter).sort({ date: -1, lineNo: 1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<BankStatementLineDoc[]>(), BankStatementLine.countDocuments(filter)]);
  return { items: rows.map(lineDTO), total, page: query.page, pageSize: query.pageSize };
}
