import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { FeeDocumentKind, PriceMode } from '@shared';
import { AppError } from '../../../core/errors';
import { addDays } from '../../../core/dates';
import { auditFinance, emitFinance, fyCodeFor, nextNumber, type FinanceCtx } from '../core/context';
import { postJournal, type PostLine } from '../core/posting';
import type { ChartAccountDoc, TaxCodeDoc } from '../core/models';
import { calculateTax } from '../tax/tax';
import { FeeDocument, FeeDocumentLine, StudentLedgerEntry, type FeeDocumentDoc, type FeeHeadDoc } from './models';

/**
 * Pricing a fee line and issuing a document. Used by billing runs, late fees and debit notes, so every paper is made the same way:
 * the lines (a snapshot of price, discount and tax), the ledger row and the journal are written together, in one transaction.
 */

export interface BuiltLine {
  feeHeadId: string;
  feeItemId: string | null;
  description: string;
  periodKey: string | null;
  basePaise: number;
  discountPaise: number;
  taxableValuePaise: number;
  taxCodeId: string | null;
  rateBps: number;
  priceMode: PriceMode;
  cgstPaise: number;
  sgstPaise: number;
  igstPaise: number;
  taxPaise: number;
  totalPaise: number;
  incomeAccountId: string;
  isDeposit: boolean;
  explanation: string;
  concessionAwardIds: string[];
  originalLineId?: string | null;
  sourceKey: string;
}

/** Price one line: discount first, then tax on what is left. A refundable deposit carries no tax and no concession. */
export function priceLine(input: { head: FeeHeadDoc; taxCode: TaxCodeDoc | null; basePaise: number; discountPaise: number; intraState: boolean; description: string; periodKey: string | null; feeItemId: string | null; sourceKey: string; explain: string[]; awardIds: string[] }): BuiltLine {
  const { head, taxCode, basePaise, discountPaise, intraState } = input;
  const net = basePaise - discountPaise;
  const isDeposit = head.isRefundableDeposit;
  const rateBps = isDeposit || !taxCode ? 0 : taxCode.rateBps;
  const tax = calculateTax({ amountPaise: net, priceMode: head.priceMode, rateBps, intraState });
  // A fee with no GST needs no tax sentence; the sums that matter (a part period, a discount) are what the parent reads.
  const explanation = [...input.explain, tax.taxPaise > 0 ? tax.explanation : ''].filter(Boolean).join(' · ');
  return {
    feeHeadId: head._id, feeItemId: input.feeItemId, description: input.description, periodKey: input.periodKey, basePaise, discountPaise, taxableValuePaise: tax.taxableValuePaise, taxCodeId: head.taxCodeId, rateBps,
    priceMode: head.priceMode, cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, igstPaise: tax.igstPaise, taxPaise: tax.taxPaise, totalPaise: tax.totalPaise, incomeAccountId: head.incomeAccountId, isDeposit,
    explanation, concessionAwardIds: input.awardIds, sourceKey: input.sourceKey,
  };
}

export const sumLines = (lines: BuiltLine[]) => ({
  basePaise: lines.reduce((s, l) => s + l.basePaise, 0),
  discountPaise: lines.reduce((s, l) => s + l.discountPaise, 0),
  taxableValuePaise: lines.reduce((s, l) => s + l.taxableValuePaise, 0),
  cgstPaise: lines.reduce((s, l) => s + l.cgstPaise, 0),
  sgstPaise: lines.reduce((s, l) => s + l.sgstPaise, 0),
  igstPaise: lines.reduce((s, l) => s + l.igstPaise, 0),
  taxPaise: lines.reduce((s, l) => s + l.taxPaise, 0),
  totalPaise: lines.reduce((s, l) => s + l.totalPaise, 0),
});

/** The credit side of a bill's journal: income per account (or the deposit liability), and output GST. */
export function creditSideOf(lines: BuiltLine[], roles: Map<string, ChartAccountDoc>, sign: 1 | -1 = 1): PostLine[] {
  const byAccount = new Map<string, number>();
  const add = (accountId: string, paise: number) => paise !== 0 && byAccount.set(accountId, (byAccount.get(accountId) ?? 0) + paise);
  for (const l of lines) add(l.incomeAccountId, l.taxableValuePaise);
  const gst = (role: string, paise: number) => {
    if (paise === 0) return;
    const account = roles.get(role);
    if (!account) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing the GST accounts. Use the standard chart in Finance Settings.', { role });
    add(account._id, paise);
  };
  gst('OUTPUT_CGST', lines.reduce((s, l) => s + l.cgstPaise, 0));
  gst('OUTPUT_SGST', lines.reduce((s, l) => s + l.sgstPaise, 0));
  gst('OUTPUT_IGST', lines.reduce((s, l) => s + l.igstPaise, 0));
  return [...byAccount.entries()].map(([accountId, paise]) => (sign === 1 ? { accountId, creditPaise: paise } : { accountId, debitPaise: paise }));
}

export interface IssueSpec {
  kind: Extract<FeeDocumentKind, 'BILL' | 'LATE_FEE' | 'DEBIT_NOTE' | 'OPENING'>;
  student: { studentId: string; enrollmentId: string | null; locationId: string; sessionId: string; classOfferingId: string | null };
  periodKey: string | null;
  issueDate: string;
  dueDate: string;
  graceDays: number;
  lines: BuiltLine[];
  planVersionId: string | null;
  runId: string | null;
  parentDocumentId: string | null;
  /** The journal's one-per-event key. */
  journalKey: string;
  memo: string;
  correlationId: string | null;
}

let seq = 0;
/** A number that only goes up inside this server, used to keep ledger rows of one transaction in order. */
export const nextSeq = () => Date.now() * 1000 + (seq = (seq + 1) % 1000);

/**
 * Makes one bill, late-fee bill or debit note in the caller's transaction: document, immutable lines, ledger row, journal
 * (Dr Student Receivable; Cr Income, output GST or the deposit liability), audit and event. Nothing here is skipped, so nothing can
 * be half written.
 */
export async function issueDocument(f: FinanceCtx, db: ClientSession, spec: IssueSpec, roles: Map<string, ChartAccountDoc>): Promise<FeeDocumentDoc> {
  const receivable = roles.get('STUDENT_RECEIVABLE');
  if (!receivable) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing the student receivable account. Use the standard chart in Finance Settings.');
  const totals = sumLines(spec.lines);
  if (totals.totalPaise <= 0) throw new AppError('ADJUSTMENT_INVALID', 'A bill must be for more than zero.');
  const documentId = randomUUID();
  const prefix = spec.kind === 'DEBIT_NOTE' ? 'DN' : spec.kind === 'OPENING' ? 'OPN' : 'BILL';
  const number = await nextNumber(f, db, prefix, fyCodeFor(spec.issueDate, f.entity.fyStartMonth));
  const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };

  const { journal } = await postJournal(f, db, {
    eventType: spec.kind === 'BILL' ? 'bill.issued' : spec.kind === 'LATE_FEE' ? 'latefee.issued' : spec.kind === 'OPENING' ? 'opening.balance' : 'debit_note.issued',
    sourceKey: spec.journalKey, accountingDate: spec.issueDate, memo: spec.memo, sourceType: 'fee_document', sourceId: documentId, correlationId: spec.correlationId,
    lines: [{ accountId: receivable._id, debitPaise: totals.totalPaise, locationId: spec.student.locationId, studentId: spec.student.studentId }, ...creditSideOf(spec.lines, roles).map((l) => ({ ...l, locationId: spec.student.locationId, studentId: spec.student.studentId }))],
  });

  const [created] = await FeeDocument.create(
    [
      {
        _id: documentId, ...base, number, studentId: spec.student.studentId, enrollmentId: spec.student.enrollmentId, locationId: spec.student.locationId, sessionId: spec.student.sessionId, classOfferingId: spec.student.classOfferingId,
        kind: spec.kind, periodKey: spec.periodKey, issueDate: spec.issueDate, dueDate: spec.dueDate, graceDays: spec.graceDays, overdueAfter: addDays(spec.dueDate, spec.graceDays), basePaise: totals.basePaise, discountPaise: totals.discountPaise,
        taxableValuePaise: totals.taxableValuePaise, cgstPaise: totals.cgstPaise, sgstPaise: totals.sgstPaise, igstPaise: totals.igstPaise, totalPaise: totals.totalPaise, paidPaise: 0, creditedPaise: 0, balancePaise: totals.totalPaise,
        status: 'ISSUED', planVersionId: spec.planVersionId, runId: spec.runId, parentDocumentId: spec.parentDocumentId, journalId: journal._id, createdBy: f.system ? null : f.userId,
      },
    ],
    { session: db },
  );
  await FeeDocumentLine.create(spec.lines.map((l, i) => ({ ...base, documentId, studentId: spec.student.studentId, lineNo: i + 1, qty: 1, ...l })), { session: db, ordered: true });
  await StudentLedgerEntry.create(
    [{ ...base, studentId: spec.student.studentId, date: spec.issueDate, kind: spec.kind === 'DEBIT_NOTE' ? 'DEBIT_NOTE' : 'BILL', amountPaise: totals.totalPaise, documentId, journalId: journal._id, description: `${spec.kind === 'LATE_FEE' ? 'Late fee' : spec.kind === 'DEBIT_NOTE' ? 'Debit note' : spec.kind === 'OPENING' ? 'Opening balance' : 'Bill'} ${number}`, seq: nextSeq() }],
    { session: db },
  );
  await auditFinance(f, db, { action: 'fee_document.issued', entityType: 'fee_document', entityId: documentId, after: { number, kind: spec.kind, studentId: spec.student.studentId, totalPaise: totals.totalPaise, periodKey: spec.periodKey }, correlationId: spec.correlationId });
  await emitFinance(f, db, 'fee_demand.issued', { documentId, number, studentId: spec.student.studentId, totalPaise: totals.totalPaise, periodKey: spec.periodKey, kind: spec.kind });
  return created!.toObject() as FeeDocumentDoc;
}

/** Overdue is worked out from dates, never stored: due date plus grace days is before today, and something is still owed. */
export const isOverdue = (doc: Pick<FeeDocumentDoc, 'overdueAfter' | 'balancePaise' | 'status'>, today: string): boolean => doc.balancePaise > 0 && doc.status !== 'CANCELLED' && doc.overdueAfter < today;
