import type { ClientSession } from 'mongoose';
import type { GeneralLedgerDTO, JournalDetailDTO, JournalDTO, ListJournalsQuery, TrialBalanceDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { todayIn } from '../../../core/dates';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { auditFinance, financeCtx, financeScope, type FinanceCtx } from './context';
import { ChartAccount, JournalEntry, JournalLine, type ChartAccountDoc, type JournalEntryDoc, type JournalLineDoc } from './models';
import { reverseJournal } from './posting';

/** Read routes for the books (FIN-16): journals, one account's ledger, and the trial balance. Nothing here can change a journal. */

async function toDTOs(f: FinanceCtx, entries: JournalEntryDoc[], db?: ClientSession): Promise<JournalDTO[]> {
  const ids = entries.map((e) => e._id);
  const [lines, reversals] = await Promise.all([
    JournalLine.find({ tenantId: f.tenantId, journalId: { $in: ids } }).sort({ journalId: 1, lineNo: 1 }).session(db ?? null).lean<JournalLineDoc[]>(),
    JournalEntry.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, reversesId: { $in: ids } }).select('reversesId').session(db ?? null).lean<{ _id: string; reversesId: string }[]>(),
  ]);
  const accounts = await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: [...new Set(lines.map((l) => l.accountId))] } }).select('code name').session(db ?? null).lean<{ _id: string; code: string; name: string }[]>();
  const account = new Map(accounts.map((a) => [a._id, a]));
  const reversedBy = new Map(reversals.map((r) => [r.reversesId, r._id]));
  return entries.map((e) => ({
    journalId: e._id, number: e.number, accountingDate: e.accountingDate, periodId: e.periodId, eventType: e.eventType, sourceKey: e.sourceKey, sourceType: e.sourceType, sourceId: e.sourceId, memo: e.memo,
    totalPaise: e.totalPaise, reversesId: e.reversesId, reversedById: reversedBy.get(e._id) ?? null, postedBy: e.postedBy, postedAt: new Date(e.createdAt).toISOString(),
    lines: lines.filter((l) => l.journalId === e._id).map((l) => ({
      accountId: l.accountId, accountCode: account.get(l.accountId)?.code ?? '', accountName: account.get(l.accountId)?.name ?? '', debitPaise: l.debitPaise, creditPaise: l.creditPaise,
      locationId: l.locationId, studentId: l.studentId, employeeId: l.employeeId, vendorId: l.vendorId,
    })),
  }));
}

export async function listJournals(ctx: ServiceContext, query: ListJournalsQuery) {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  if (query.from || query.to) filter.accountingDate = { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) };
  if (query.accountId) filter.accountIds = query.accountId;
  if (query.studentId) filter.studentIds = query.studentId;
  if (query.sourceType) filter.sourceType = query.sourceType;
  if (query.sourceId) filter.sourceId = query.sourceId;
  if (query.eventType) filter.eventType = query.eventType;
  if (!scope.all) filter.$or = [{ locationIds: { $size: 0 } }, { locationIds: { $in: scope.locationIds } }];
  const [rows, total] = await Promise.all([
    JournalEntry.find(filter).sort({ accountingDate: -1, number: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<JournalEntryDoc[]>(),
    JournalEntry.countDocuments(filter),
  ]);
  return { items: await toDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getJournal(ctx: ServiceContext, journalId: string): Promise<JournalDetailDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const entry = await JournalEntry.findOne({ _id: journalId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<JournalEntryDoc>();
  if (!entry || (!scope.all && entry.locationIds.length > 0 && !entry.locationIds.some((id) => scope.locationIds.includes(id)))) throw AppError.notFound('Journal not found.');
  const [dto] = await toDTOs(f, [entry]);
  return { ...dto!, source: entry.sourceType && entry.sourceId ? { type: entry.sourceType, id: entry.sourceId, label: `${entry.sourceType.replace(/_/g, ' ')} ${entry.sourceId.slice(0, 8)}` } : null };
}

/** Only a hand-made entry can be reversed here. Anything that came from a bill or a payment is undone from that bill or payment. */
export async function reverseManualJournal(ctx: ServiceContext, journalId: string, reason: string): Promise<JournalDTO> {
  const f = await financeCtx(ctx);
  const entry = await JournalEntry.findOne({ _id: journalId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<JournalEntryDoc>();
  if (!entry) throw AppError.notFound('Journal not found.');
  if (entry.eventType !== 'manual') throw new AppError('CONFLICT', 'This entry came from a bill or a payment. Undo it from there, for example with a credit note.');
  const result = await withTransaction(async (db) => {
    const r = await reverseJournal(f, db, journalId, reason);
    await auditFinance(f, db, { action: 'journal.reverse_requested', entityType: 'journal', entityId: journalId, metadata: { reason } });
    return r;
  });
  return (await toDTOs(f, [result.journal]))[0]!;
}

const signed = (normal: 'DEBIT' | 'CREDIT', debit: number, credit: number) => (normal === 'DEBIT' ? debit - credit : credit - debit);

export async function generalLedger(ctx: ServiceContext, query: { accountId: string; from?: string | null | undefined; to?: string | null | undefined }): Promise<GeneralLedgerDTO> {
  const f = await financeCtx(ctx);
  const account = await ChartAccount.findOne({ _id: query.accountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ChartAccountDoc>();
  if (!account) throw AppError.notFound('Account not found.');
  const scope = await financeScope(ctx);
  const base: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, accountId: account._id };
  if (!scope.all) base.$or = [{ locationId: null }, { locationId: { $in: scope.locationIds } }];
  const [opening] = query.from
    ? await JournalLine.aggregate<{ debit: number; credit: number }>([{ $match: { ...base, accountingDate: { $lt: query.from } } }, { $group: { _id: null, debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } }])
    : [];
  const openingPaise = opening ? signed(account.normalBalance, opening.debit, opening.credit) : 0;
  const lines = await JournalLine.find({ ...base, ...(query.from || query.to ? { accountingDate: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}) }).sort({ accountingDate: 1, createdAt: 1, lineNo: 1 }).lean<JournalLineDoc[]>();
  const entries = await JournalEntry.find({ tenantId: f.tenantId, _id: { $in: [...new Set(lines.map((l) => l.journalId))] } }).select('number memo').lean<{ _id: string; number: string; memo: string }[]>();
  const entry = new Map(entries.map((e) => [e._id, e]));
  let running = openingPaise;
  const rows = lines.map((l) => {
    running += signed(account.normalBalance, l.debitPaise, l.creditPaise);
    return { date: l.accountingDate, journalId: l.journalId, number: entry.get(l.journalId)?.number ?? '', memo: entry.get(l.journalId)?.memo ?? '', debitPaise: l.debitPaise, creditPaise: l.creditPaise, balancePaise: running };
  });
  return { account: { accountId: account._id, code: account.code, name: account.name, normalBalance: account.normalBalance }, openingPaise, rows, closingPaise: running };
}

/** Totals per account up to a date. The two totals must be equal; if they are not, `balanced` says so. */
export async function trialBalance(ctx: ServiceContext, query: { asOf?: string | null | undefined }): Promise<TrialBalanceDTO> {
  const f = await financeCtx(ctx);
  const school = await todayFor(ctx);
  const asOf = query.asOf ?? school ?? todayIn('Asia/Kolkata');
  const scope = await financeScope(ctx);
  const match: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, accountingDate: { $lte: asOf } };
  if (!scope.all) match.$or = [{ locationId: null }, { locationId: { $in: scope.locationIds } }];
  const totals = await JournalLine.aggregate<{ _id: string; debit: number; credit: number }>([{ $match: match }, { $group: { _id: '$accountId', debit: { $sum: '$debitPaise' }, credit: { $sum: '$creditPaise' } } }]);
  const accounts = await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: totals.map((t) => t._id) } }).sort({ code: 1 }).lean<ChartAccountDoc[]>();
  const byId = new Map(totals.map((t) => [t._id, t]));
  const rows = accounts.map((a) => {
    const t = byId.get(a._id)!;
    const net = t.debit - t.credit;
    return { accountId: a._id, code: a.code, name: a.name, type: a.type, debitPaise: net > 0 ? net : 0, creditPaise: net < 0 ? -net : 0 };
  });
  const rawDebit = totals.reduce((s, t) => s + t.debit, 0);
  const rawCredit = totals.reduce((s, t) => s + t.credit, 0);
  return { asOf, rows, totalDebitPaise: rows.reduce((s, r) => s + r.debitPaise, 0), totalCreditPaise: rows.reduce((s, r) => s + r.creditPaise, 0), balanced: rawDebit === rawCredit };
}
