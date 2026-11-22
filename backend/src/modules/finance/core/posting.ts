import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { JournalEventType } from '@shared';
import { AppError } from '../../../core/errors';
import { todayFor } from '../../staff/status';
import { auditFinance, emitFinance, nextNumber, periodFor, type FinanceCtx } from './context';
import { ChartAccount, JournalEntry, JournalLine, type JournalEntryDoc, type JournalLineDoc } from './models';

/**
 * The posting engine (FIN-05). `postJournal` is the ONLY way a journal is written. It checks, in this order:
 *   1. every line has one side, and money in equals money out
 *   2. the same `sourceKey` was not posted already (an identical retry returns the first journal; a different one is refused)
 *   3. the date sits in an OPEN accounting period
 *   4. every account is active and takes entries (a detail account, not a group)
 * and then writes the entry, its lines, an audit row and an outbox event in the CALLER'S transaction. A posted journal is never
 * changed or deleted (the models refuse). A mistake is fixed with `reverseJournal`, a new mirror entry.
 */

export interface PostLine {
  accountId: string;
  debitPaise?: number;
  creditPaise?: number;
  locationId?: string | null;
  studentId?: string | null;
  employeeId?: string | null;
  vendorId?: string | null;
}

export interface PostInput {
  eventType: JournalEventType;
  /** One per real-world event, e.g. `bill:<studentId>:<feeItemId>:<period>`. The same event can never post twice. */
  sourceKey: string;
  accountingDate: string;
  lines: PostLine[];
  memo: string;
  correlationId?: string | null;
  sourceType?: string | null;
  sourceId?: string | null;
  reversesId?: string | null;
}

export interface PostResult {
  journal: JournalEntryDoc;
  /** False when this was a retry of an event that was already posted. */
  created: boolean;
}

const hashLines = (lines: (PostLine & { debitPaise: number; creditPaise: number })[]) =>
  createHash('sha256')
    .update(JSON.stringify(lines.map((l) => [l.accountId, l.debitPaise, l.creditPaise, l.locationId ?? null, l.studentId ?? null, l.employeeId ?? null, l.vendorId ?? null]).sort()))
    .digest('hex');

export async function postJournal(f: FinanceCtx, db: ClientSession, input: PostInput): Promise<PostResult> {
  const lines = input.lines.map((l) => ({ ...l, debitPaise: l.debitPaise ?? 0, creditPaise: l.creditPaise ?? 0 })).filter((l) => l.debitPaise !== 0 || l.creditPaise !== 0);
  if (lines.length < 2) throw new AppError('JOURNAL_UNBALANCED', 'An entry needs at least two lines.');
  for (const l of lines) {
    if (!Number.isSafeInteger(l.debitPaise) || !Number.isSafeInteger(l.creditPaise) || l.debitPaise < 0 || l.creditPaise < 0) throw new AppError('JOURNAL_UNBALANCED', 'Every amount must be a whole number of paise.');
    if (l.debitPaise > 0 && l.creditPaise > 0) throw new AppError('JOURNAL_UNBALANCED', 'A line is either money in or money out, not both.');
  }
  const debit = lines.reduce((a, l) => a + l.debitPaise, 0);
  const credit = lines.reduce((a, l) => a + l.creditPaise, 0);
  if (debit !== credit) throw new AppError('JOURNAL_UNBALANCED', undefined, { debitPaise: debit, creditPaise: credit });

  const linesHash = hashLines(lines);
  const existing = await JournalEntry.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, sourceKey: input.sourceKey }).session(db).lean<JournalEntryDoc>();
  if (existing) {
    if (existing.linesHash === linesHash) return { journal: existing, created: false };
    throw new AppError('SOURCE_ALREADY_POSTED', undefined, { journalId: existing._id });
  }

  const period = await periodFor(f, input.accountingDate, db);
  if (!period) throw new AppError('PERIOD_CLOSED', `There is no accounting period for ${input.accountingDate}. Add the financial year first.`);
  if (period.state !== 'OPEN') throw new AppError('PERIOD_CLOSED', `The period ${period.code} is ${period.state === 'LOCKED' ? 'locked' : 'closed'}. Post into an open period instead.`, { periodId: period._id });

  const accountIds = [...new Set(lines.map((l) => l.accountId))];
  const accounts = await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: accountIds } }).session(db).select('status isPostable').lean<{ _id: string; status: string; isPostable: boolean }[]>();
  const byId = new Map(accounts.map((a) => [a._id, a]));
  for (const id of accountIds) {
    const a = byId.get(id);
    if (!a || a.status !== 'ACTIVE' || !a.isPostable) throw new AppError('ACCOUNT_NOT_POSTABLE', undefined, { accountId: id });
  }

  const number = await nextNumber(f, db, 'JV', period.fyCode);
  const journalId = randomUUID();
  const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
  const [created] = await JournalEntry.create(
    [
      {
        _id: journalId, ...base, number, accountingDate: input.accountingDate, periodId: period._id, eventType: input.eventType, sourceKey: input.sourceKey, linesHash,
        sourceType: input.sourceType ?? null, sourceId: input.sourceId ?? null, memo: input.memo, totalPaise: debit,
        locationIds: [...new Set(lines.map((l) => l.locationId).filter((x): x is string => !!x))], studentIds: [...new Set(lines.map((l) => l.studentId).filter((x): x is string => !!x))], accountIds,
        reversesId: input.reversesId ?? null, postedBy: f.system ? null : f.userId, correlationId: input.correlationId ?? f.requestId,
      },
    ],
    { session: db },
  );
  await JournalLine.create(
    lines.map((l, i) => ({
      ...base, journalId, lineNo: i + 1, accountId: l.accountId, accountingDate: input.accountingDate, debitPaise: l.debitPaise, creditPaise: l.creditPaise,
      locationId: l.locationId ?? null, studentId: l.studentId ?? null, employeeId: l.employeeId ?? null, vendorId: l.vendorId ?? null,
    })),
    { session: db, ordered: true },
  );
  await auditFinance(f, db, { action: input.reversesId ? 'journal.reversed' : 'journal.posted', entityType: 'journal', entityId: journalId, after: { number, eventType: input.eventType, totalPaise: debit, sourceKey: input.sourceKey }, correlationId: input.correlationId ?? null });
  await emitFinance(f, db, input.reversesId ? 'journal.reversed' : 'journal.posted', { journalId, number, eventType: input.eventType, sourceType: input.sourceType ?? null, sourceId: input.sourceId ?? null });
  return { journal: created!.toObject() as JournalEntryDoc, created: true };
}

/**
 * Undoes a journal by posting its mirror (debits and credits swapped), linked by `reversesId`. The original is never touched.
 * If the original period has since closed, the reversal goes into today's open period with a note. Reversing twice returns the first reversal.
 */
export async function reverseJournal(f: FinanceCtx, db: ClientSession, journalId: string, reason: string, options: { sourceKey?: string } = {}): Promise<PostResult> {
  const original = await JournalEntry.findOne({ _id: journalId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<JournalEntryDoc>();
  if (!original) throw AppError.notFound('Journal not found.');
  const already = await JournalEntry.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, reversesId: journalId }).session(db).lean<JournalEntryDoc>();
  if (already) return { journal: already, created: false };
  if (original.reversesId) throw new AppError('CONFLICT', 'A reversal cannot be reversed. Post a new entry instead.');

  const lines = await JournalLine.find({ tenantId: f.tenantId, journalId }).sort({ lineNo: 1 }).session(db).lean<JournalLineDoc[]>();
  const originalPeriod = await periodFor(f, original.accountingDate, db);
  const today = await todayFor(f, db);
  const movedForward = !originalPeriod || originalPeriod.state !== 'OPEN';
  return postJournal(f, db, {
    eventType: 'journal.reversed',
    sourceKey: options.sourceKey ?? `reverse:${journalId}`,
    accountingDate: movedForward ? today : original.accountingDate,
    lines: lines.map((l) => ({ accountId: l.accountId, debitPaise: l.creditPaise, creditPaise: l.debitPaise, locationId: l.locationId, studentId: l.studentId, employeeId: l.employeeId, vendorId: l.vendorId })),
    memo: `Reversal of ${original.number}: ${reason}${movedForward ? ' (the original period is closed, so this is posted in the current period)' : ''}`,
    sourceType: 'journal',
    sourceId: journalId,
    reversesId: journalId,
  });
}
