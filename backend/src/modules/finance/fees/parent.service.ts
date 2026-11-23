import { EXITED_STUDENT_STATUSES, type FeeDocumentKind, type ParentFeeSummaryDTO, type ParentStudentFeesDTO, type StudentClearanceDTO } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { todayFor } from '../../staff/status';
import { assertParentCanAccess, assertParentRole, parentLinksFor } from '../../students/parent-access';
import { Student } from '../../students/student.models';
import { financeCtx, type FinanceCtx } from '../core/context';
import { BankAccount, type BankAccountDoc } from '../core/models';
import { studentLabels } from '../core/people';
import { pendingClaimsOf } from '../collections/collection.service';
import { balancesOf, placementOf } from './account.service';
import { isOverdue } from './documents';
import { FeeDocument, FeeDocumentLine, type FeeDocumentDoc, type FeeDocumentLineDoc } from './models';

/**
 * What a parent may see, and what other modules may ask. Parents come only through an active guardian link that allows fees, read
 * from the database on every request (Module 4's `assertParentCanAccess`). Another child's id answers 404. Parent answers carry no
 * journal, plan, run or account ids: only what a family needs to know and to pay.
 */

const OPEN_KINDS: FeeDocumentKind[] = ['BILL', 'LATE_FEE', 'DEBIT_NOTE'];

async function nextDue(f: FinanceCtx, studentId: string) {
  const open = await FeeDocument.find({ tenantId: f.tenantId, studentId, kind: { $in: OPEN_KINDS }, status: { $in: ['ISSUED', 'PARTIALLY_SETTLED'] }, balancePaise: { $gt: 0 } }).sort({ dueDate: 1 }).lean<FeeDocumentDoc[]>();
  const first = open[0];
  return { nextDueDate: first?.dueDate ?? null, nextDuePaise: first ? open.filter((d) => d.dueDate === first.dueDate).reduce((s, d) => s + d.balancePaise, 0) : 0 };
}

export async function getFeeSummaryForParent(ctx: ServiceContext): Promise<ParentFeeSummaryDTO> {
  assertParentRole(ctx);
  const f = await financeCtx(ctx);
  const found = await parentLinksFor(ctx, 'FEES');
  const studentIds = [...new Set((found?.links ?? []).map((l) => l.studentId))];
  const live = new Set((await Student.find({ tenantId: f.tenantId, _id: { $in: studentIds }, status: { $nin: EXITED_STUDENT_STATUSES } }).select('_id').lean<{ _id: string }[]>()).map((s) => s._id));
  const labels = await studentLabels(f, studentIds);
  const today = await todayFor(ctx);
  const children: ParentFeeSummaryDTO['children'] = [];
  for (const studentId of studentIds.filter((id) => live.has(id))) {
    const [balances, due, placement] = await Promise.all([balancesOf(f, studentId, today), nextDue(f, studentId), placementOf(f, studentId)]);
    children.push({ studentId, studentName: labels.get(studentId)?.name ?? 'Student', className: placement.className, outstandingPaise: balances.outstandingPaise, overduePaise: balances.overduePaise, advancePaise: balances.advancePaise, ...due });
  }
  return { children };
}

export async function getStudentFeesForParent(ctx: ServiceContext, studentId: string): Promise<ParentStudentFeesDTO> {
  assertParentRole(ctx);
  await assertParentCanAccess(ctx, studentId, 'FEES');
  const f = await financeCtx(ctx);
  const today = await todayFor(ctx);
  const [balances, labels, docs, placement] = await Promise.all([
    balancesOf(f, studentId, today), studentLabels(f, [studentId]), FeeDocument.find({ tenantId: f.tenantId, studentId }).sort({ issueDate: -1, number: -1 }).lean<FeeDocumentDoc[]>(), placementOf(f, studentId),
  ]);
  const lines = await FeeDocumentLine.find({ tenantId: f.tenantId, documentId: { $in: docs.map((d) => d._id) } }).sort({ lineNo: 1 }).lean<FeeDocumentLineDoc[]>();
  const bank = await BankAccount.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE', purpose: 'FEES', $or: [{ locationIds: { $size: 0 } }, ...(placement.locationId ? [{ locationIds: placement.locationId }] : [])] }).sort({ createdAt: 1 }).lean<BankAccountDoc>();
  return {
    studentId, studentName: labels.get(studentId)?.name ?? 'Student', outstandingPaise: balances.outstandingPaise, overduePaise: balances.overduePaise, advancePaise: balances.advancePaise,
    bills: docs.map((d) => ({
      documentId: d._id, number: d.number, kind: d.kind, issueDate: d.issueDate, dueDate: d.dueDate, status: d.status, totalPaise: d.totalPaise, balancePaise: d.balancePaise, overdue: isOverdue(d, today),
      lines: lines.filter((l) => l.documentId === d._id).map((l) => ({ description: l.description, discountPaise: l.discountPaise, taxPaise: l.taxPaise, totalPaise: l.totalPaise })),
    })),
    howToPay: bank
      ? { bankName: bank.bankName, holderName: bank.holderName, accountLast4: bank.last4, ifsc: bank.ifsc, instructions: `Pay at the school office, or send a bank transfer to ${bank.bankName} (account ending ${bank.last4}, IFSC ${bank.ifsc}). Write your child's admission number in the payment note. Your payment counts once the school has checked it.` }
      : null,
  };
}

// ───────────────────────────────────────────────────────────── for other modules

export async function getStudentBalance(ctx: ServiceContext, studentId: string) {
  const f = await financeCtx(ctx);
  const b = await balancesOf(f, studentId, await todayFor(ctx));
  return { outstandingPaise: b.outstandingPaise, overduePaise: b.overduePaise, advancePaise: b.advancePaise };
}

/** "Can this student leave with nothing owed?" Used by the Transfer Certificate. A payment still waiting to be checked is not money yet, so it holds the answer at PENDING_CLAIMS. */
export async function getStudentClearance(ctx: ServiceContext, studentId: string): Promise<StudentClearanceDTO> {
  const f = await financeCtx(ctx);
  const b = await balancesOf(f, studentId, await todayFor(ctx));
  const deposits = await FeeDocumentLine.find({ tenantId: f.tenantId, studentId, isDeposit: true }).select('documentId totalPaise').lean<{ documentId: string; totalPaise: number }[]>();
  const settled = new Set((await FeeDocument.find({ tenantId: f.tenantId, _id: { $in: deposits.map((d) => d.documentId) }, status: 'SETTLED' }).select('_id').lean<{ _id: string }[]>()).map((d) => d._id));
  const pending = await pendingClaimsOf(f, studentId);
  const pendingClaims = pending.count;
  return {
    studentId, status: b.outstandingPaise > 0 ? 'DUES' : pendingClaims > 0 ? 'PENDING_CLAIMS' : 'CLEAR', billedPaise: b.billedPaise, paidPaise: b.paidPaise, outstandingPaise: b.outstandingPaise, pendingClaims, refundableAdvancePaise: b.advancePaise,
    refundableDepositPaise: deposits.filter((d) => settled.has(d.documentId)).reduce((s, d) => s + d.totalPaise, 0),
  };
}
