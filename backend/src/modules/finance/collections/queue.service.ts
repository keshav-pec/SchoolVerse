import type { BankLineSuggestionDTO, VerificationItemDTO, VerificationQueueDTO } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { financeCtx, financeScope, scopeFilter } from '../core/context';
import { formatMoney } from '../core/money';
import { BankStatementLine, type BankStatementLineDoc } from '../banking/models';
import { claimDTOs, collectionDTOs } from './collection.service';
import { Collection, PaymentClaim, type CollectionDoc, type PaymentClaimDoc } from './models';

/**
 * Module 7, Part 4 — the Waiting for Verification queue. Claims from parents and staff, and UPI or bank payments entered at the
 * counter, in one list, oldest first. When a bank statement is imported, each row carries the statement line that looks like it
 * ("Matches ₹4,000 on 12 Nov, ref …4821"). A suggestion is only a hint: a person still verifies.
 */

const LIMIT = 200;
const DAY = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const short = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const tail = (ref: string | null) => (ref ? `, ref …${ref.slice(-4)}` : '');

function suggest(lines: BankStatementLineDoc[], used: Set<string>, item: { amountPaise: number; date: string; referenceNorm: string | null }): BankLineSuggestionDTO | null {
  const open = lines.filter((l) => !used.has(l._id));
  const ref = item.referenceNorm;
  const byRef = ref ? open.filter((l) => l.referenceNorm !== null && (l.referenceNorm === ref || l.referenceNorm.endsWith(ref) || ref.endsWith(l.referenceNorm))) : [];
  const exact = byRef.find((l) => l.creditPaise === item.amountPaise);
  const near = (l: BankStatementLineDoc) => l.date >= shift(item.date, -3) && l.date <= shift(item.date, 7);
  const line = exact ?? byRef[0] ?? open.find((l) => l.creditPaise === item.amountPaise && near(l)) ?? null;
  if (!line) return null;
  used.add(line._id);
  const sameAmount = line.creditPaise === item.amountPaise;
  const sentence = sameAmount
    ? `Matches ${formatMoney(line.creditPaise)} on ${short(line.date)}${tail(line.reference)}`
    : `Same reference, but the bank shows ${formatMoney(line.creditPaise)} on ${short(line.date)}${tail(line.reference)}`;
  return { lineId: line._id, bankAccountId: line.bankAccountId, date: line.date, amountPaise: line.creditPaise, reference: line.reference, exact: Boolean(exact), sentence };
}

export async function verificationQueue(ctx: ServiceContext): Promise<VerificationQueueDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const base: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope), status: 'PENDING_VERIFICATION' };
  const [claims, collections, total] = await Promise.all([
    PaymentClaim.find(base).sort({ createdAt: 1 }).limit(LIMIT).lean<PaymentClaimDoc[]>(),
    Collection.find({ ...base, claimId: null }).sort({ createdAt: 1 }).limit(LIMIT).lean<CollectionDoc[]>(),
    Promise.all([PaymentClaim.countDocuments(base), Collection.countDocuments({ ...base, claimId: null })]).then(([a, b]) => a + b),
  ]);
  const [claimRows, collectionRows] = await Promise.all([claimDTOs(f, claims), collectionDTOs(f, collections)]);
  const dates = [...claims.map((c) => c.paidOn), ...collections.map((c) => c.receivedOn)].sort();
  const lines = dates.length
    ? await BankStatementLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: { $in: ['UNMATCHED', 'SUGGESTED'] }, creditPaise: { $gt: 0 }, date: { $gte: shift(dates[0]!, -3), $lte: shift(dates[dates.length - 1]!, 7) } })
        .sort({ date: 1, lineNo: 1 })
        .limit(3000)
        .lean<BankStatementLineDoc[]>()
    : [];
  const used = new Set<string>();
  const items: (VerificationItemDTO & { referenceNorm: string | null })[] = [
    ...claimRows.map((c, i) => ({
      kind: 'CLAIM' as const, id: c.claimId, method: c.method, amountPaise: c.amountPaise, date: c.paidOn, reference: c.reference, students: c.students.map((s) => ({ studentId: s.studentId, studentName: s.studentName })),
      reportedByName: c.reportedByName, reportedByParent: c.reportedByParent, hasProof: c.hasProof, flags: c.flags, createdAt: c.createdAt, suggestion: null, referenceNorm: claims[i]!.referenceNorm,
    })),
    ...collectionRows.map((c, i) => ({
      kind: 'COLLECTION' as const, id: c.collectionId, method: c.method, amountPaise: c.amountPaise, date: c.receivedOn, reference: c.reference, students: c.students, reportedByName: c.cashierName, reportedByParent: false, hasProof: false,
      flags: c.flags, createdAt: c.createdAt, suggestion: null, referenceNorm: collections[i]!.referenceNorm,
    })),
  ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // Exact matches claim their lines first, so a near match never takes the line an exact one needs.
  for (const pass of ['exact', 'any'] as const)
    for (const item of items) {
      if (item.suggestion) continue;
      const s = suggest(lines, used, { amountPaise: item.amountPaise, date: item.date, referenceNorm: item.referenceNorm });
      if (s && pass === 'exact' && !s.exact) used.delete(s.lineId);
      else item.suggestion = s;
    }
  return { items: items.map(({ referenceNorm: _drop, ...rest }) => rest), total };
}
