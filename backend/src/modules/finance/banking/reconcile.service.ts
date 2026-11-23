import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { AutoMatchResultDTO, MatchCandidateDTO, MatchDTO, ReconExceptionsDTO, ReconSummaryDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { daysBetween } from '../../../core/dates';
import { withTransaction } from '../../../db/transaction';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { checkApproval, consumeApproval } from '../core/approvals.service';
import { rolesMap } from '../core/chart.service';
import { auditFinance, emitFinance, financeCtx, type FinanceCtx } from '../core/context';
import { JournalLine, type BankAccountDoc } from '../core/models';
import { formatMoney } from '../core/money';
import { postJournal } from '../core/posting';
import { clearCheque, normRef, registerStatementLineLinker, verifyCollection } from '../collections/collection.service';
import { Collection, type CollectionDoc } from '../collections/models';
import { BankStatementImport, BankStatementLine, ReconciliationMatch, type BankStatementImportDoc, type BankStatementLineDoc, type MatchTarget, type ReconciliationMatchDoc } from './models';
import { matchSource, matchSources, type BankItem } from './sources';
import { lineDTO, scopedBank } from './statement.service';

/**
 * The matching engine (FIN-10) and the exception list (FIN-11).
 *
 *   HIGH    the same reference and the same amount, on this bank account.
 *   MEDIUM  the same amount, a date within four days and the payer's name in the bank's description.
 *   LOW     the same amount within a week. A hint only.
 *
 * Only a HIGH match with exactly one candidate is confirmed by the system, and only when the other side has already been checked by a
 * person. Everything else is a suggestion for a person. A bank line and its match are linked, never merged, and a match is undone by reversing it.
 */

const SIDE = (l: Pick<BankStatementLineDoc, 'creditPaise'>) => (l.creditPaise > 0 ? 'IN' : 'OUT');
const amountOf = (l: Pick<BankStatementLineDoc, 'creditPaise' | 'debitPaise'>) => (l.creditPaise > 0 ? l.creditPaise : l.debitPaise);

type Confidence = 'HIGH' | 'MEDIUM' | 'LOW';
interface Scored {
  item: BankItem;
  confidence: Confidence;
  reasons: string[];
  mismatch: boolean;
}

function score(line: BankStatementLineDoc, item: BankItem): Scored | null {
  if (item.side !== SIDE(line)) return null;
  const desc = normRef(line.description) ?? '';
  const refHit = Boolean(item.referenceNorm && item.referenceNorm.length >= 4 && (line.referenceNorm === item.referenceNorm || (line.referenceNorm ?? '').includes(item.referenceNorm) || desc.includes(item.referenceNorm)));
  const sameAmount = item.amountPaise === amountOf(line);
  const days = Math.abs(daysBetween(item.date, line.date));
  const nameHit = Boolean(item.payer && item.payer.split(/\s+/).some((w) => w.length >= 3 && desc.includes(w.toUpperCase().replace(/[^A-Z0-9]/g, ''))));
  if (refHit && sameAmount) return { item, confidence: 'HIGH', reasons: ['Same reference', 'Same amount'], mismatch: false };
  if (refHit && !sameAmount) return { item, confidence: 'LOW', reasons: ['Same reference', `The bank shows ${formatMoney(amountOf(line))} but ${formatMoney(item.amountPaise)} was recorded`], mismatch: true };
  if (sameAmount && days <= 4 && nameHit) return { item, confidence: 'MEDIUM', reasons: ['Same amount', 'The payer\'s name is in the bank description', `${days} day${days === 1 ? '' : 's'} apart`], mismatch: false };
  if (sameAmount && days <= 7) return { item, confidence: 'LOW', reasons: ['Same amount', `${days} day${days === 1 ? '' : 's'} apart`], mismatch: false };
  return null;
}

async function confirmedTargetKeys(f: FinanceCtx, bankAccountId: string, db?: ClientSession): Promise<Set<string>> {
  const rows = await ReconciliationMatch.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId, state: 'CONFIRMED' }).session(db ?? null).select('targets').lean<{ targets: MatchTarget[] }[]>();
  return new Set(rows.flatMap((r) => r.targets.map((t) => `${t.type}:${t.id}`)));
}

/** Every item the school has recorded on this bank account that no bank line has been matched to yet. */
async function openItems(f: FinanceCtx, bankAccountId: string, db?: ClientSession): Promise<BankItem[]> {
  const [taken, lists] = await Promise.all([confirmedTargetKeys(f, bankAccountId, db), Promise.all(matchSources().map((s) => s.list(f, bankAccountId, db)))]);
  return lists.flat().filter((i) => !taken.has(`${i.type}:${i.id}`));
}

const candidateDTO = (i: BankItem): MatchCandidateDTO => ({ type: i.type, id: i.id, label: i.label, amountPaise: i.amountPaise, date: i.date, reference: i.reference, verified: i.verified });

// ───────────────────────────────────────────────────────────── DTOs

async function matchDTOs(f: FinanceCtx, rows: ReconciliationMatchDoc[]): Promise<MatchDTO[]> {
  const lines = await BankStatementLine.find({ tenantId: f.tenantId, _id: { $in: rows.flatMap((r) => r.lineIds) } }).lean<BankStatementLineDoc[]>();
  const byLine = new Map(lines.map((l) => [l._id, l]));
  const banks = new Set(rows.map((r) => r.bankAccountId));
  const items = new Map<string, BankItem>();
  for (const id of banks) for (const i of (await Promise.all(matchSources().map((s) => s.list(f, id)))).flat()) items.set(`${i.type}:${i.id}`, i);
  return rows.map((r) => ({
    matchId: r._id, bankAccountId: r.bankAccountId, state: r.state, confidence: r.confidence, reasons: r.reasons, auto: r.auto, needsVerification: r.needsVerification,
    lines: r.lineIds.map((id) => byLine.get(id)).filter((l): l is BankStatementLineDoc => !!l).map(lineDTO),
    targets: r.targets.map((t) => { const i = items.get(`${t.type}:${t.id}`); return { type: t.type, id: t.id, label: i?.label ?? t.type, amountPaise: t.amountPaise, date: i?.date ?? '', reference: i?.reference ?? null, verified: i?.verified ?? true }; }),
    linesPaise: r.linesPaise, targetsPaise: r.targetsPaise,
  }));
}

// ───────────────────────────────────────────────────────────── auto-match

export async function autoMatch(ctx: ServiceContext, data: { bankAccountId: string; from?: string | null | undefined; to?: string | null | undefined }): Promise<AutoMatchResultDTO> {
  const f = await financeCtx(ctx);
  await scopedBank(ctx, f, data.bankAccountId);
  const range = data.from || data.to ? { date: { ...(data.from ? { $gte: data.from } : {}), ...(data.to ? { $lte: data.to } : {}) } } : {};
  const lines = await BankStatementLine.find({ tenantId: f.tenantId, bankAccountId: data.bankAccountId, status: { $in: ['UNMATCHED', 'SUGGESTED'] }, ...range }).sort({ date: 1, lineNo: 1 }).lean<BankStatementLineDoc[]>();
  const items = await openItems(f, data.bankAccountId);
  const taken = new Set<string>();
  const out: AutoMatchResultDTO = { confirmed: 0, suggested: 0, unmatched: 0, duplicates: await BankStatementLine.countDocuments({ tenantId: f.tenantId, bankAccountId: data.bankAccountId, status: 'DUPLICATE_SUSPECTED', ...range }) };

  // Earlier suggestions for these lines are replaced by what the engine finds now.
  await ReconciliationMatch.updateMany({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId: data.bankAccountId, state: 'SUGGESTED', lineIds: { $in: lines.map((l) => l._id) } }, { $set: { state: 'REJECTED', reversedReason: 'Replaced by a newer suggestion' } });

  for (const line of lines) {
    const scored = items.filter((i) => !taken.has(`${i.type}:${i.id}`)).map((i) => score(line, i)).filter((s): s is Scored => !!s && !s.mismatch).sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 })[a.confidence] - ({ HIGH: 0, MEDIUM: 1, LOW: 2 })[b.confidence]);
    if (scored.length === 0) {
      if (line.status === 'SUGGESTED') await BankStatementLine.updateOne({ _id: line._id, tenantId: f.tenantId }, { $set: { status: 'UNMATCHED' } });
      out.unmatched += 1;
      continue;
    }
    const best = scored[0]!;
    const high = scored.filter((s) => s.confidence === 'HIGH');
    const single = high.length === 1;
    const auto = single && best.item.verified;
    const chosen = auto ? [best] : single ? [best] : scored.filter((s) => s.confidence === best.confidence).slice(0, 3);
    try {
      await withTransaction(async (db) => {
        const [m] = await ReconciliationMatch.create(
          [{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, bankAccountId: data.bankAccountId, lineIds: [line._id], targets: chosen.map((c) => ({ type: c.item.type, id: c.item.id, amountPaise: c.item.amountPaise })), linesPaise: amountOf(line), targetsPaise: chosen.reduce((s, c) => s + c.item.amountPaise, 0), confidence: best.confidence, reasons: best.reasons, state: auto ? 'CONFIRMED' : 'SUGGESTED', auto, needsVerification: !best.item.verified, confirmedBy: auto ? ctx.userId : null, confirmedAt: auto ? new Date() : null }],
          { session: db },
        );
        await BankStatementLine.updateOne({ _id: line._id, tenantId: f.tenantId }, { $set: { status: auto ? 'AUTO_MATCHED' : 'SUGGESTED', matchId: m!._id } }, { session: db });
        if (auto) {
          await auditFinance(f, db, { action: 'reconciliation.matched', entityType: 'reconciliation_match', entityId: m!._id, after: { auto: true, confidence: best.confidence, linePaise: amountOf(line), target: `${best.item.type}:${best.item.id}` } });
          await emitFinance(f, db, 'reconciliation.match.confirmed', { matchId: m!._id, lineIds: [line._id], auto: true });
        }
      });
      for (const c of chosen) if (auto || single) taken.add(`${c.item.type}:${c.item.id}`);
      if (auto) out.confirmed += 1;
      else out.suggested += 1;
    } catch (err) {
      if (!(err instanceof AppError)) throw err;
      out.unmatched += 1;
    }
  }
  return out;
}

// ───────────────────────────────────────────────────────────── confirm, manual, reverse

interface Resolved {
  lines: BankStatementLineDoc[];
  targets: (BankItem & { amountPaise: number })[];
  linesPaise: number;
  targetsPaise: number;
}

async function resolve(f: FinanceCtx, db: ClientSession, bankAccountId: string, lineIds: string[], targets: { type: string; id: string }[]): Promise<Resolved> {
  const lines = await BankStatementLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId, _id: { $in: lineIds } }).session(db).lean<BankStatementLineDoc[]>();
  if (lines.length !== new Set(lineIds).size) throw AppError.notFound('Bank line not found.');
  for (const l of lines) if (['AUTO_MATCHED', 'VERIFIED_MATCHED', 'IGNORED'].includes(l.status)) throw new AppError('MATCH_INVALID', 'A bank line here is already matched or set aside.');
  const side = SIDE(lines[0]!);
  if (lines.some((l) => SIDE(l) !== side)) throw new AppError('MATCH_INVALID', 'Money in and money out cannot be matched together.');
  const open = new Map((await openItems(f, bankAccountId, db)).map((i) => [`${i.type}:${i.id}`, i]));
  const resolved = targets.map((t) => {
    const i = open.get(`${t.type}:${t.id}`);
    if (!i) throw new AppError('MATCH_INVALID', 'One of the items is not on this bank account, or is already matched.');
    if (i.side !== side) throw new AppError('MATCH_INVALID', 'Money in and money out cannot be matched together.');
    return i;
  });
  return { lines, targets: resolved, linesPaise: lines.reduce((s, l) => s + amountOf(l), 0), targetsPaise: resolved.reduce((s, t) => s + t.amountPaise, 0) };
}

async function applyConfirm(f: FinanceCtx, db: ClientSession, userId: string, match: ReconciliationMatchDoc | null, r: Resolved, extra: { bankAccountId: string; confidence: ReconciliationMatchDoc['confidence']; reasons: string[]; approvalId: string | null }): Promise<string> {
  const variance = r.linesPaise - r.targetsPaise;
  const id = match?._id ?? randomUUID();
  if (match) {
    const res = await ReconciliationMatch.updateOne({ _id: id, tenantId: f.tenantId, state: 'SUGGESTED' }, { $set: { state: 'CONFIRMED', confirmedBy: userId, confirmedAt: new Date(), linesPaise: r.linesPaise, targetsPaise: r.targetsPaise, targets: r.targets.map((t) => ({ type: t.type, id: t.id, amountPaise: t.amountPaise })) } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('MATCH_INVALID', 'This suggestion was already decided.');
  } else {
    await ReconciliationMatch.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, bankAccountId: extra.bankAccountId, lineIds: r.lines.map((l) => l._id), targets: r.targets.map((t) => ({ type: t.type, id: t.id, amountPaise: t.amountPaise })), linesPaise: r.linesPaise, targetsPaise: r.targetsPaise, confidence: extra.confidence, reasons: extra.reasons, state: 'CONFIRMED', auto: false, needsVerification: false, approvalId: extra.approvalId, confirmedBy: userId, confirmedAt: new Date() }], { session: db });
  }
  const upd = await BankStatementLine.updateMany({ tenantId: f.tenantId, _id: { $in: r.lines.map((l) => l._id) }, status: { $nin: ['AUTO_MATCHED', 'VERIFIED_MATCHED', 'IGNORED'] } }, { $set: { status: variance === 0 ? 'VERIFIED_MATCHED' : 'VARIANCE', matchId: id, variancePaise: variance } }, { session: db });
  if (upd.modifiedCount !== r.lines.length) throw new AppError('MATCH_INVALID', 'A bank line was just matched by someone else.');
  // Other suggestions that use the same lines or items are now out of date.
  await ReconciliationMatch.updateMany({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, state: 'SUGGESTED', _id: { $ne: id }, $or: [{ lineIds: { $in: r.lines.map((l) => l._id) } }, { 'targets.id': { $in: r.targets.map((t) => t.id) } }] }, { $set: { state: 'REJECTED', reversedReason: 'Another match was confirmed' } }, { session: db });
  await auditFinance(f, db, { action: 'reconciliation.confirmed', entityType: 'reconciliation_match', entityId: id, after: { linesPaise: r.linesPaise, targetsPaise: r.targetsPaise, variancePaise: variance, lines: r.lines.length, targets: r.targets.length } });
  await emitFinance(f, db, 'reconciliation.match.confirmed', { matchId: id, lineIds: r.lines.map((l) => l._id), auto: false });
  return id;
}

/** A person agrees with a suggestion. "Verify and Match" also confirms the money itself (a payment seen, a cheque cleared) in the same click. */
export async function confirmMatch(ctx: ServiceContext, matchId: string, data: { verify?: boolean | undefined; seenOn?: string | null | undefined }): Promise<MatchDTO> {
  const f = await financeCtx(ctx);
  const match = await ReconciliationMatch.findOne({ _id: matchId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ReconciliationMatchDoc>();
  if (!match) throw AppError.notFound('Match not found.');
  await scopedBank(ctx, f, match.bankAccountId);
  if (match.state !== 'SUGGESTED') throw new AppError('MATCH_INVALID', match.state === 'CONFIRMED' ? 'This match is already confirmed.' : 'This suggestion is out of date.');
  const open = await openItems(f, match.bankAccountId);
  const line = (await BankStatementLine.findOne({ _id: match.lineIds[0], tenantId: f.tenantId }).lean<BankStatementLineDoc>())!;
  const pending = match.targets.map((t) => open.find((i) => i.type === t.type && i.id === t.id)).filter((i): i is BankItem => !!i && !i.verified);
  if (pending.length > 0) {
    if (!data.verify) throw new AppError('MATCH_INVALID', 'The money behind this match has not been checked yet. Choose Verify and Match.', { needsVerification: true });
    if (!can(ctx, 'finance:collection:verify')) throw new AppError('FORBIDDEN', undefined, { required: ['finance:collection:verify'] });
    for (const item of pending) {
      const c = await Collection.findOne({ _id: item.id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<CollectionDoc>();
      if (!c) throw AppError.notFound('Payment not found.');
      const seenOn = data.seenOn ?? line.date;
      if (c.method === 'CHEQUE') await clearCheque(ctx, c._id, { clearedOn: seenOn });
      else await verifyCollection(ctx, c._id, { amountSeenPaise: amountOf(line), evidence: { seenOn, note: 'Seen on the bank statement' } });
    }
  }
  await withTransaction(async (db) => {
    const fresh = await ReconciliationMatch.findOne({ _id: matchId, tenantId: f.tenantId }).session(db).lean<ReconciliationMatchDoc>();
    if (!fresh || fresh.state !== 'SUGGESTED') throw new AppError('MATCH_INVALID', 'This suggestion was just decided.');
    const r = await resolve(f, db, fresh.bankAccountId, fresh.lineIds, fresh.targets);
    if (r.linesPaise !== r.targetsPaise) throw new AppError('MATCH_INVALID', `The bank shows ${formatMoney(r.linesPaise)} but the records add up to ${formatMoney(r.targetsPaise)}. Match it by hand with a reason.`);
    await applyConfirm(f, db, ctx.userId, fresh, r, { bankAccountId: fresh.bankAccountId, confidence: fresh.confidence, reasons: fresh.reasons, approvalId: null });
  });
  return (await matchDTOs(f, [(await ReconciliationMatch.findOne({ _id: matchId, tenantId: f.tenantId }).lean<ReconciliationMatchDoc>())!]))[0]!;
}

/** The human's own choice: any number of bank lines against any number of recorded items. The totals must agree, or a second person must approve the difference. */
export async function manualMatch(ctx: ServiceContext, data: { bankAccountId: string; lineIds: string[]; targets: { type: string; id: string }[]; reason?: string | null | undefined; approvalId?: string | undefined }): Promise<MatchDTO> {
  const f = await financeCtx(ctx);
  await scopedBank(ctx, f, data.bankAccountId);
  const pre = await withTransaction((db) => resolve(f, db, data.bankAccountId, data.lineIds, data.targets));
  const variance = pre.linesPaise - pre.targetsPaise;
  const approval = variance !== 0
    ? await checkApproval(f, { action: 'RECON_OVERRIDE', entityType: 'reconciliation', entityId: data.lineIds[0]!, amountPaise: Math.abs(variance), reason: data.reason ?? null, approvalId: data.approvalId, summary: `Match bank lines with a difference of ${formatMoney(Math.abs(variance))}`, impact: 'The lines will be marked with a variance and left in the exception list.' })
    : null;
  const id = await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    const r = await resolve(f, db, data.bankAccountId, data.lineIds, data.targets);
    return applyConfirm(f, db, ctx.userId, null, r, { bankAccountId: data.bankAccountId, confidence: 'MANUAL', reasons: [data.reason ?? 'Matched by hand'], approvalId: approval?._id ?? null });
  });
  return (await matchDTOs(f, [(await ReconciliationMatch.findOne({ _id: id, tenantId: f.tenantId }).lean<ReconciliationMatchDoc>())!]))[0]!;
}

export async function reverseMatch(ctx: ServiceContext, matchId: string, reason: string): Promise<MatchDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const m = await ReconciliationMatch.findOne({ _id: matchId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<ReconciliationMatchDoc>();
    if (!m) throw AppError.notFound('Match not found.');
    await scopedBank(ctx, f, m.bankAccountId);
    const res = await ReconciliationMatch.updateOne({ _id: matchId, tenantId: f.tenantId, state: 'CONFIRMED' }, { $set: { state: 'REVERSED', reversedBy: ctx.userId, reversedReason: reason } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('MATCH_INVALID', 'Only a confirmed match can be reversed.');
    await BankStatementLine.updateMany({ tenantId: f.tenantId, _id: { $in: m.lineIds }, postedJournalId: null }, { $set: { status: 'UNMATCHED', matchId: null, variancePaise: 0 } }, { session: db });
    await auditFinance(f, db, { action: 'reconciliation.reversed', entityType: 'reconciliation_match', entityId: matchId, after: { reason } });
  });
  return (await matchDTOs(f, [(await ReconciliationMatch.findOne({ _id: matchId, tenantId: f.tenantId }).lean<ReconciliationMatchDoc>())!]))[0]!;
}

/** Set a bank line aside (it is not ours, or it is explained elsewhere). Always needs a second person, and is audited. */
export async function ignoreLine(ctx: ServiceContext, lineId: string, data: { reason: string; approvalId?: string | undefined }) {
  const f = await financeCtx(ctx);
  const line = await BankStatementLine.findOne({ _id: lineId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<BankStatementLineDoc>();
  if (!line) throw AppError.notFound('Bank line not found.');
  await scopedBank(ctx, f, line.bankAccountId);
  if (['AUTO_MATCHED', 'VERIFIED_MATCHED', 'IGNORED'].includes(line.status)) throw new AppError('MATCH_INVALID', 'This line is already matched or set aside.');
  const approval = await checkApproval(f, { action: 'RECON_OVERRIDE', entityType: 'bank_statement_line', entityId: lineId, amountPaise: amountOf(line), reason: data.reason, approvalId: data.approvalId, summary: `Set aside a bank line of ${formatMoney(amountOf(line))} (${line.description || line.reference || 'no description'})`, impact: 'The line will leave the exception list without being matched to a record.' });
  await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    const res = await BankStatementLine.updateOne({ _id: lineId, tenantId: f.tenantId, status: { $nin: ['AUTO_MATCHED', 'VERIFIED_MATCHED', 'IGNORED'] } }, { $set: { status: 'IGNORED', ignoredReason: data.reason } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('MATCH_INVALID', 'This line was just matched by someone else.');
    await auditFinance(f, db, { action: 'reconciliation.ignored', entityType: 'bank_statement_line', entityId: lineId, after: { reason: data.reason, amountPaise: amountOf(line) } });
  });
  return lineDTO((await BankStatementLine.findOne({ _id: lineId, tenantId: f.tenantId }).lean<BankStatementLineDoc>())!);
}

// ───────────────────────────────────────────────────────────── bank charge and interest straight from the line

async function postFromLine(ctx: ServiceContext, lineId: string, kind: 'charge' | 'interest', memo?: string | null) {
  const f = await financeCtx(ctx);
  const line = await BankStatementLine.findOne({ _id: lineId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<BankStatementLineDoc>();
  if (!line) throw AppError.notFound('Bank line not found.');
  const bank = await scopedBank(ctx, f, line.bankAccountId);
  if (kind === 'charge' && line.debitPaise === 0) throw new AppError('MATCH_INVALID', 'A bank charge is money going out of the bank.');
  if (kind === 'interest' && line.creditPaise === 0) throw new AppError('MATCH_INVALID', 'Interest is money coming into the bank.');
  if (['AUTO_MATCHED', 'VERIFIED_MATCHED', 'IGNORED'].includes(line.status)) throw new AppError('MATCH_INVALID', 'This line is already matched or set aside.');
  await withTransaction(async (db) => {
    const roles = await rolesMap(f, db);
    const other = roles.get(kind === 'charge' ? 'BANK_CHARGES' : 'BANK_INTEREST_INCOME');
    if (!other) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing this account. Use the standard chart in Finance Settings.');
    const amount = amountOf(line);
    const { journal } = await postJournal(f, db, {
      eventType: kind === 'charge' ? 'bank.charge' : 'bank.interest', sourceKey: `bank_line:${kind}:${line._id}`, accountingDate: line.date, memo: memo ?? `${kind === 'charge' ? 'Bank charge' : 'Bank interest'}: ${line.description || line.reference || ''}`.trim(), sourceType: 'bank_statement_line', sourceId: line._id,
      lines: kind === 'charge' ? [{ accountId: other._id, debitPaise: amount }, { accountId: (bank as BankAccountDoc).glAccountId, creditPaise: amount }] : [{ accountId: (bank as BankAccountDoc).glAccountId, debitPaise: amount }, { accountId: other._id, creditPaise: amount }],
    });
    const res = await BankStatementLine.updateOne({ _id: line._id, tenantId: f.tenantId, status: { $nin: ['AUTO_MATCHED', 'VERIFIED_MATCHED', 'IGNORED'] } }, { $set: { status: 'VERIFIED_MATCHED', postedJournalId: journal._id } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('MATCH_INVALID', 'This line was just matched by someone else.');
    await auditFinance(f, db, { action: kind === 'charge' ? 'bank.charge_recorded' : 'bank.interest_recorded', entityType: 'bank_statement_line', entityId: line._id, after: { amountPaise: amount, journalId: journal._id } });
  });
  return lineDTO((await BankStatementLine.findOne({ _id: lineId, tenantId: f.tenantId }).lean<BankStatementLineDoc>())!);
}
export const recordBankCharge = (ctx: ServiceContext, lineId: string, memo?: string | null) => postFromLine(ctx, lineId, 'charge', memo);
export const recordBankInterest = (ctx: ServiceContext, lineId: string, memo?: string | null) => postFromLine(ctx, lineId, 'interest', memo);

// ───────────────────────────────────────────────────────────── the exception list (FIN-11)

export async function exceptions(ctx: ServiceContext, bankAccountId: string): Promise<ReconExceptionsDTO> {
  const f = await financeCtx(ctx);
  await scopedBank(ctx, f, bankAccountId);
  const [lines, open, suggested] = await Promise.all([
    BankStatementLine.find({ tenantId: f.tenantId, bankAccountId }).sort({ date: 1, lineNo: 1 }).lean<BankStatementLineDoc[]>(),
    openItems(f, bankAccountId),
    ReconciliationMatch.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId, state: 'SUGGESTED' }).lean<ReconciliationMatchDoc[]>(),
  ]);
  const counts = { imported: lines.length, matched: lines.filter((l) => ['AUTO_MATCHED', 'VERIFIED_MATCHED'].includes(l.status)).length, waitingForVerification: 0, amountMismatches: 0, possibleDuplicates: lines.filter((l) => l.status === 'DUPLICATE_SUSPECTED').length, unmatched: 0, ignored: lines.filter((l) => l.status === 'IGNORED').length };
  const groups: ReconExceptionsDTO['groups'] = [
    { key: 'WAITING_FOR_VERIFICATION', title: 'Money is here, but not yet checked', items: [] },
    { key: 'AMOUNT_MISMATCH', title: 'The amount is different', items: [] },
    { key: 'POSSIBLE_DUPLICATE', title: 'Possible duplicates', items: [] },
    { key: 'UNMATCHED', title: 'Nothing found for these', items: [] },
  ];
  const matchDocs = await matchDTOs(f, suggested);
  for (const line of lines.filter((l) => ['UNMATCHED', 'SUGGESTED', 'VARIANCE', 'DUPLICATE_SUSPECTED', 'PARTIAL'].includes(l.status))) {
    const mine = matchDocs.filter((m) => m.lines.some((l) => l.lineId === line._id));
    const scored = open.map((i) => score(line, i)).filter((s): s is Scored => !!s).sort((a, b) => ({ HIGH: 0, MEDIUM: 1, LOW: 2 })[a.confidence] - ({ HIGH: 0, MEDIUM: 1, LOW: 2 })[b.confidence]);
    const entry = { line: lineDTO(line), matches: mine, candidates: scored.slice(0, 5).map((s) => candidateDTO(s.item)), hint: '' };
    if (line.status === 'DUPLICATE_SUSPECTED') {
      entry.hint = 'This looks like the same line twice. Check the bank app before matching it.';
      groups[2]!.items.push(entry);
    } else if (line.status === 'VARIANCE' || scored.some((s) => s.mismatch)) {
      entry.hint = scored.find((s) => s.mismatch)?.reasons[1] ?? `Matched with a difference of ${formatMoney(Math.abs(line.variancePaise))}.`;
      groups[1]!.items.push(entry);
    } else if (mine.some((m) => m.needsVerification)) {
      entry.hint = 'The payment was reported but nobody has checked it yet. Verify and Match does both in one click.';
      groups[0]!.items.push(entry);
    } else {
      entry.hint = mine.length ? 'A match is suggested. Check it and confirm.' : 'No recorded payment matches this line yet.';
      groups[3]!.items.push(entry);
    }
  }
  counts.waitingForVerification = groups[0]!.items.length;
  counts.amountMismatches = groups[1]!.items.length;
  counts.unmatched = groups[3]!.items.length;
  const headline = `${counts.imported} imported · ${counts.matched} matched · ${counts.waitingForVerification} waiting for verification · ${counts.amountMismatches} amount mismatch${counts.amountMismatches === 1 ? '' : 'es'} · ${counts.possibleDuplicates} possible duplicate${counts.possibleDuplicates === 1 ? '' : 's'}`;
  return { bankAccountId, headline, counts, groups, timingDifferences: open.map(candidateDTO) };
}

export async function listMatches(ctx: ServiceContext, bankAccountId: string, state?: ReconciliationMatchDoc['state']): Promise<MatchDTO[]> {
  const f = await financeCtx(ctx);
  await scopedBank(ctx, f, bankAccountId);
  return matchDTOs(f, await ReconciliationMatch.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId, ...(state ? { state } : {}) }).sort({ createdAt: -1 }).limit(100).lean<ReconciliationMatchDoc[]>());
}

// ───────────────────────────────────────────────────────────── the reconciliation statement (FIN-11)

export async function summary(ctx: ServiceContext, query: { bankAccountId: string; asOf?: string | null | undefined }): Promise<ReconSummaryDTO> {
  const f = await financeCtx(ctx);
  const bank = await scopedBank(ctx, f, query.bankAccountId);
  const asOf = query.asOf ?? (await todayFor(ctx));
  const [glRows, lines, open, lastImport] = await Promise.all([
    JournalLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, accountId: bank.glAccountId, accountingDate: { $lte: asOf } }).select('debitPaise creditPaise').lean<{ debitPaise: number; creditPaise: number }[]>(),
    BankStatementLine.find({ tenantId: f.tenantId, bankAccountId: query.bankAccountId, date: { $lte: asOf } }).sort({ date: 1, lineNo: 1 }).lean<BankStatementLineDoc[]>(),
    openItems(f, query.bankAccountId),
    BankStatementImport.findOne({ tenantId: f.tenantId, bankAccountId: query.bankAccountId, toDate: { $lte: asOf }, closingPaise: { $ne: null } }).sort({ toDate: -1 }).lean<BankStatementImportDoc>(),
  ]);
  const books = glRows.reduce((s, r) => s + r.debitPaise - r.creditPaise, 0);
  const lastWithBalance = [...lines].reverse().find((l) => l.balancePaise !== null);
  const bankBalance = lastImport?.closingPaise ?? lastWithBalance?.balancePaise ?? null;
  const inBooks = open.filter((i) => i.date <= asOf && i.verified);
  const loose = lines.filter((l) => ['UNMATCHED', 'SUGGESTED', 'DUPLICATE_SUSPECTED', 'PARTIAL', 'VARIANCE'].includes(l.status));
  const inBooksNotInBank = inBooks.map((i) => ({ label: `${i.label} (${i.side === 'IN' ? 'received, not yet in the bank' : 'paid, not yet cleared'})`, amountPaise: i.side === 'IN' ? i.amountPaise : -i.amountPaise }));
  const inBankNotInBooks = loose.map((l) => ({ label: `${l.date} ${l.description || l.reference || 'bank line'}`, amountPaise: l.creditPaise > 0 ? l.creditPaise : -l.debitPaise })).concat(lines.filter((l) => l.status === 'VARIANCE').map((l) => ({ label: `Difference on ${l.date} ${l.reference ?? ''}`.trim(), amountPaise: 0 })));
  const adjustedBank = bankBalance === null ? null : bankBalance + inBooksNotInBank.reduce((s, x) => s + x.amountPaise, 0);
  const adjustedBooks = books + inBankNotInBooks.reduce((s, x) => s + x.amountPaise, 0);
  const difference = adjustedBank === null ? 0 : adjustedBank - adjustedBooks;
  return {
    bankAccountId: query.bankAccountId, asOf, balancePerBooksPaise: books, balancePerBankPaise: bankBalance, inBooksNotInBank, inBankNotInBooks: inBankNotInBooks.filter((x) => x.amountPaise !== 0), differencePaise: difference, explained: difference === 0 && bankBalance !== null,
    sentence: bankBalance === null ? 'Import a bank statement with a balance to see the reconciliation.' : difference === 0 ? 'Every difference between the books and the bank is explained.' : `${formatMoney(Math.abs(difference))} is not explained yet. Look at the exception list.`,
  };
}

// ───────────────────────────────────────────────────────────── "this payment was seen on this bank line"

registerStatementLineLinker(async (f, db, { lineId, collection, amountPaise }) => {
  const line = await BankStatementLine.findOne({ _id: lineId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<BankStatementLineDoc>();
  if (!line) throw AppError.notFound('Bank line not found.');
  if (line.creditPaise === 0) throw new AppError('MATCH_INVALID', 'Only a bank credit can show a payment received.');
  if (['AUTO_MATCHED', 'VERIFIED_MATCHED', 'IGNORED'].includes(line.status)) throw new AppError('MATCH_INVALID', 'This bank line is already matched to something else.');
  if (line.creditPaise !== amountPaise) throw new AppError('AMOUNT_MISMATCH', `The bank line is ${formatMoney(line.creditPaise)} but you entered ${formatMoney(amountPaise)}.`);
  const id = randomUUID();
  await ReconciliationMatch.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, bankAccountId: line.bankAccountId, lineIds: [line._id], targets: [{ type: 'collection', id: collection._id, amountPaise }], linesPaise: line.creditPaise, targetsPaise: amountPaise, confidence: 'MANUAL', reasons: ['Payment verified against this bank line'], state: 'CONFIRMED', confirmedBy: f.userId, confirmedAt: new Date() }], { session: db });
  await BankStatementLine.updateOne({ _id: line._id, tenantId: f.tenantId }, { $set: { status: 'VERIFIED_MATCHED', matchId: id } }, { session: db });
  await ReconciliationMatch.updateMany({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, state: 'SUGGESTED', $or: [{ lineIds: line._id }, { 'targets.id': collection._id }] }, { $set: { state: 'REJECTED', reversedReason: 'The payment was verified against a bank line' } }, { session: db });
});

export { matchSource, normRef };
