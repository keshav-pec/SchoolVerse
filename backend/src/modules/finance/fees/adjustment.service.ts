import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { AdjustmentResultDTO, CreateAdjustmentData } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { checkApproval, consumeApproval } from '../core/approvals.service';
import { rolesMap } from '../core/chart.service';
import { assertInScope, auditFinance, emitFinance, financeCtx, financeScope, fyCodeFor, nextNumber, type FinanceCtx } from '../core/context';
import type { TaxCodeDoc } from '../core/models';
import { formatMoney, proportion } from '../core/money';
import { postJournal } from '../core/posting';
import { creditSideOf, issueDocument, nextSeq, priceLine, type BuiltLine } from './documents';
import { FeeDocument, FeeDocumentLine, FeeHead, FinancialAdjustment, StudentLedgerEntry, type FeeDocumentDoc, type FeeDocumentLineDoc, type FeeHeadDoc } from './models';
import { TaxCode } from '../core/models';

/**
 * Adjustments (FEE-11). An issued bill never changes. A mistake or a discount after billing is a NEW linked paper:
 *   credit note   takes money off a bill (and posts the mirror of the bill's journal, with the same tax split)
 *   debit note    adds a charge
 *   waiver        a credit note whose reason says it is a waiver
 *   late-fee reversal   a credit note on a late-fee bill
 * A credit note can never take a bill below what was already paid: the extra becomes the student's advance. There is no route that
 * sets a balance directly.
 */

interface CreditRequest {
  lineId: string;
  amountPaise: number;
}

interface CreditParts {
  line: FeeDocumentLineDoc;
  built: BuiltLine;
}

/** What is still creditable on a line, per part. Earlier credit notes took their share, so partial credits never drift by a paisa. */
async function remainingOf(f: FinanceCtx, lines: FeeDocumentLineDoc[], db: ClientSession) {
  const credits = await FeeDocumentLine.find({ tenantId: f.tenantId, originalLineId: { $in: lines.map((l) => l._id) } }).session(db).lean<FeeDocumentLineDoc[]>();
  return new Map(
    lines.map((l) => {
      const mine = credits.filter((c) => c.originalLineId === l._id);
      const sum = (k: 'taxableValuePaise' | 'cgstPaise' | 'sgstPaise' | 'igstPaise' | 'totalPaise') => mine.reduce((s, c) => s + c[k], 0);
      return [l._id, { total: l.totalPaise - sum('totalPaise'), taxable: l.taxableValuePaise - sum('taxableValuePaise'), cgst: l.cgstPaise - sum('cgstPaise'), sgst: l.sgstPaise - sum('sgstPaise'), igst: l.igstPaise - sum('igstPaise') }];
    }),
  );
}

function buildCreditLines(requests: CreditRequest[], lines: FeeDocumentLineDoc[], remaining: Awaited<ReturnType<typeof remainingOf>>, creditId: string): CreditParts[] {
  return requests.map((r, i) => {
    const line = lines.find((l) => l._id === r.lineId);
    if (!line) throw AppError.validation({ [`lines.${i}.lineId`]: 'This line is not on the bill.' });
    const left = remaining.get(line._id)!;
    if (r.amountPaise > left.total) throw new AppError('ADJUSTMENT_INVALID', `You can credit at most ${formatMoney(left.total)} more on "${line.description}".`);
    const full = r.amountPaise === left.total;
    const part = (value: number) => (full ? value : proportion(r.amountPaise, value, left.total));
    const cgst = part(left.cgst);
    const sgst = part(left.sgst);
    const igst = r.amountPaise === left.total ? left.igst : part(left.igst);
    // Whatever rounding leaves over goes to the taxable value, so the line always adds up to the amount credited.
    const taxableFixed = r.amountPaise - cgst - sgst - igst;
    const tax = cgst + sgst + igst;
    const built: BuiltLine = {
      feeHeadId: line.feeHeadId, feeItemId: line.feeItemId, description: `Credit: ${line.description}`, periodKey: line.periodKey, basePaise: taxableFixed, discountPaise: 0, taxableValuePaise: taxableFixed, taxCodeId: line.taxCodeId,
      rateBps: line.rateBps, priceMode: line.priceMode, cgstPaise: cgst, sgstPaise: sgst, igstPaise: igst, taxPaise: tax, totalPaise: r.amountPaise, incomeAccountId: line.incomeAccountId, isDeposit: line.isDeposit,
      explanation: tax > 0 ? `${formatMoney(taxableFixed)} + GST ${formatMoney(tax)} = ${formatMoney(r.amountPaise)}` : formatMoney(r.amountPaise), concessionAwardIds: [], originalLineId: line._id, sourceKey: `credit:${creditId}:${line._id}`,
    };
    return { line, built };
  });
}

export interface CreditNoteInput {
  doc: FeeDocumentDoc;
  type: 'CREDIT_NOTE' | 'WAIVER' | 'LATE_FEE_REVERSAL';
  lines: CreditRequest[];
  reason: string;
  issueDate: string;
  approvalId?: string | null;
}

/** Does the whole credit-note write in the caller's transaction. Approval is checked by the caller before it starts. */
export async function applyCreditNote(f: FinanceCtx, db: ClientSession, input: CreditNoteInput): Promise<AdjustmentResultDTO> {
  const { doc, reason, issueDate } = input;
  const current = await FeeDocument.findOne({ _id: doc._id, tenantId: f.tenantId }).session(db).lean<FeeDocumentDoc>();
  if (!current) throw AppError.notFound('Bill not found.');
  if (current.kind === 'CREDIT_NOTE') throw new AppError('ADJUSTMENT_INVALID', 'A credit note cannot be credited again.');
  if (current.status === 'CANCELLED') throw new AppError('ADJUSTMENT_INVALID', 'This bill is already cancelled.');
  if (input.type === 'LATE_FEE_REVERSAL' && current.kind !== 'LATE_FEE') throw new AppError('ADJUSTMENT_INVALID', 'A late-fee reversal is for a late-fee bill.');
  const lines = await FeeDocumentLine.find({ tenantId: f.tenantId, documentId: current._id }).session(db).lean<FeeDocumentLineDoc[]>();
  const creditId = randomUUID();
  const parts = buildCreditLines(input.lines, lines, await remainingOf(f, lines, db), creditId);
  const built = parts.map((p) => p.built);
  const total = built.reduce((s, l) => s + l.totalPaise, 0);
  const applied = Math.min(total, current.balancePaise);
  const extra = total - applied;

  const roles = await rolesMap(f, db);
  const receivable = roles.get('STUDENT_RECEIVABLE');
  const advance = roles.get('STUDENT_ADVANCE');
  if (!receivable || (extra > 0 && !advance)) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing the receivable or advance account. Use the standard chart in Finance Settings.');

  // The bill's balance moves only if it is still what we read: a payment landing at the same moment makes this fail, not go wrong.
  const moved = await FeeDocument.updateOne({ _id: current._id, tenantId: f.tenantId, balancePaise: current.balancePaise }, { $inc: { balancePaise: -applied, creditedPaise: applied } }, { session: db });
  if (moved.modifiedCount !== 1) throw new AppError('VERSION_CONFLICT');
  const balanceAfter = current.balancePaise - applied;
  const creditedAfter = current.creditedPaise + applied;
  const status = balanceAfter === 0 ? (current.paidPaise === 0 && creditedAfter >= current.totalPaise ? 'CANCELLED' : 'SETTLED') : balanceAfter < current.totalPaise ? 'PARTIALLY_SETTLED' : 'ISSUED';
  if (status !== current.status) await FeeDocument.updateOne({ _id: current._id, tenantId: f.tenantId }, { $set: { status } }, { session: db });

  const { journal } = await postJournal(f, db, {
    eventType: 'credit_note.issued', sourceKey: `credit_note:${creditId}`, accountingDate: issueDate, memo: `${input.type === 'WAIVER' ? 'Waiver' : 'Credit note'} on ${current.number}: ${reason}`, sourceType: 'fee_document', sourceId: creditId,
    lines: [
      ...creditSideOf(built, roles, -1).map((l) => ({ ...l, locationId: current.locationId, studentId: current.studentId })),
      { accountId: receivable._id, creditPaise: applied, locationId: current.locationId, studentId: current.studentId },
      ...(extra > 0 ? [{ accountId: advance!._id, creditPaise: extra, locationId: current.locationId, studentId: current.studentId }] : []),
    ],
  });

  const number = await nextNumber(f, db, 'CN', fyCodeFor(issueDate, f.entity.fyStartMonth));
  const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
  await FeeDocument.create(
    [{ _id: creditId, ...base, number, studentId: current.studentId, enrollmentId: current.enrollmentId, locationId: current.locationId, sessionId: current.sessionId, classOfferingId: current.classOfferingId, kind: 'CREDIT_NOTE', periodKey: current.periodKey, issueDate, dueDate: issueDate, graceDays: 0, overdueAfter: issueDate, basePaise: built.reduce((s, l) => s + l.basePaise, 0), discountPaise: 0, taxableValuePaise: built.reduce((s, l) => s + l.taxableValuePaise, 0), cgstPaise: built.reduce((s, l) => s + l.cgstPaise, 0), sgstPaise: built.reduce((s, l) => s + l.sgstPaise, 0), igstPaise: built.reduce((s, l) => s + l.igstPaise, 0), totalPaise: total, paidPaise: 0, creditedPaise: 0, balancePaise: 0, status: 'SETTLED', planVersionId: current.planVersionId, runId: null, parentDocumentId: current._id, journalId: journal._id, createdBy: f.system ? null : f.userId }],
    { session: db },
  );
  await FeeDocumentLine.create(built.map((l, i) => ({ ...base, documentId: creditId, studentId: current.studentId, lineNo: i + 1, qty: 1, ...l })), { session: db, ordered: true });
  await StudentLedgerEntry.create(
    [
      { ...base, studentId: current.studentId, date: issueDate, kind: 'CREDIT_NOTE' as const, amountPaise: -applied, documentId: current._id, journalId: journal._id, description: `${input.type === 'WAIVER' ? 'Waiver' : 'Credit note'} ${number} on ${current.number}: ${reason}`, seq: nextSeq() },
      ...(extra > 0 ? [{ ...base, studentId: current.studentId, date: issueDate, kind: 'ADVANCE_IN' as const, amountPaise: -extra, documentId: current._id, journalId: journal._id, description: `Credit above the bill, kept as an advance (${number})`, seq: nextSeq() }] : []),
    ].filter((e) => e.amountPaise !== 0),
    { session: db, ordered: true },
  );
  const adjustmentId = randomUUID();
  await FinancialAdjustment.create([{ _id: adjustmentId, ...base, documentId: current._id, newDocumentId: creditId, studentId: current.studentId, type: input.type, amountPaise: total, reason, status: 'APPLIED', approvalId: input.approvalId ?? null, createdBy: f.userId }], { session: db });
  await auditFinance(f, db, { action: 'fee_document.credited', entityType: 'fee_document', entityId: current._id, after: { creditNote: number, type: input.type, amountPaise: total, appliedToBillPaise: applied, advancePaise: extra, reason } });
  await emitFinance(f, db, 'fee_demand.adjusted', { documentId: current._id, creditNoteId: creditId, studentId: current.studentId, amountPaise: total, type: input.type });
  return { adjustmentId, type: input.type, documentId: current._id, newDocumentId: creditId, newDocumentNumber: number, amountPaise: total, appliedToBillPaise: applied, advancePaise: extra, billBalancePaise: balanceAfter, journalId: journal._id };
}

export async function createAdjustment(ctx: ServiceContext, documentId: string, data: CreateAdjustmentData): Promise<AdjustmentResultDTO> {
  const f = await financeCtx(ctx);
  const doc = await FeeDocument.findOne({ _id: documentId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<FeeDocumentDoc>();
  if (!doc) throw AppError.notFound('Bill not found.');
  await assertInScope(ctx, await financeScope(ctx), doc.locationId, 'fee_document', doc._id);
  const issueDate = await todayFor(ctx);

  if (data.type === 'DEBIT_NOTE') {
    if (doc.kind === 'CREDIT_NOTE') throw new AppError('ADJUSTMENT_INVALID', 'A debit note cannot be added to a credit note.');
    const heads = new Map((await FeeHead.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: data.lines.map((l) => l.feeHeadId) } }).lean<FeeHeadDoc[]>()).map((h) => [h._id, h]));
    const codes = new Map((await TaxCode.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<TaxCodeDoc[]>()).map((c) => [c._id, c]));
    const debitId = randomUUID();
    const lines = data.lines.map((l, i) => {
      const head = heads.get(l.feeHeadId);
      if (!head) throw AppError.validation({ [`lines.${i}.feeHeadId`]: 'This fee head was not found.' });
      if (!head.isRefundableDeposit && !head.taxCodeId) throw new AppError('TAX_CODE_MISSING');
      return priceLine({ head, taxCode: head.taxCodeId ? codes.get(head.taxCodeId) ?? null : null, basePaise: l.amountPaise, discountPaise: 0, intraState: true, description: l.description, periodKey: doc.periodKey, feeItemId: null, sourceKey: `debit:${debitId}:${i}`, explain: [], awardIds: [] });
    });
    return withTransaction(async (db) => {
      const roles = await rolesMap(f, db);
      const issued = await issueDocument(f, db, { kind: 'DEBIT_NOTE', student: { studentId: doc.studentId, enrollmentId: doc.enrollmentId, locationId: doc.locationId, sessionId: doc.sessionId, classOfferingId: doc.classOfferingId }, periodKey: doc.periodKey, issueDate, dueDate: issueDate, graceDays: 0, lines, planVersionId: doc.planVersionId, runId: null, parentDocumentId: doc._id, journalKey: `debit_note:${debitId}`, memo: `Debit note on ${doc.number}: ${data.reason}`, correlationId: ctx.requestId }, roles);
      const adjustmentId = randomUUID();
      await FinancialAdjustment.create([{ _id: adjustmentId, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, documentId: doc._id, newDocumentId: issued._id, studentId: doc.studentId, type: 'DEBIT_NOTE', amountPaise: issued.totalPaise, reason: data.reason, status: 'APPLIED', createdBy: ctx.userId }], { session: db });
      await emitFinance(f, db, 'fee_demand.adjusted', { documentId: doc._id, debitNoteId: issued._id, studentId: doc.studentId, amountPaise: issued.totalPaise, type: 'DEBIT_NOTE' });
      return { adjustmentId, type: 'DEBIT_NOTE' as const, documentId: doc._id, newDocumentId: issued._id, newDocumentNumber: issued.number, amountPaise: issued.totalPaise, appliedToBillPaise: 0, advancePaise: 0, billBalancePaise: doc.balancePaise, journalId: issued.journalId! };
    });
  }

  const total = data.lines.reduce((s, l) => s + l.amountPaise, 0);
  const approval = await checkApproval(f, {
    action: data.type === 'CREDIT_NOTE' ? 'CREDIT_NOTE' : 'WAIVER', entityType: 'fee_document', entityId: doc._id, amountPaise: total, reason: data.reason, approvalId: data.approvalId,
    summary: `${data.type === 'WAIVER' ? 'Waive' : 'Credit'} ${formatMoney(total)} on bill ${doc.number}`, impact: `The student will owe ${formatMoney(Math.max(0, doc.balancePaise - total))} on this bill instead of ${formatMoney(doc.balancePaise)}.`,
  });
  return withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    return applyCreditNote(f, db, { doc, type: data.type, lines: data.lines, reason: data.reason, issueDate, approvalId: approval?._id ?? null });
  });
}

