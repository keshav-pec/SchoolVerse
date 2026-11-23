import { createHash } from 'node:crypto';
import type { ClearanceSummaryDTO, ImportPreviewDTO, ReminderPreviewDTO, ReminderResultDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { daysBetween } from '../../../core/dates';
import { withTransaction } from '../../../db/transaction';
import { parseCsv } from '../../../platform/identity/csv';
import { sendSafely } from '../../../platform/identity/notifier';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { Person } from '../../staff/person.model';
import { todayFor } from '../../staff/status';
import { Student, StudentAdmission, StudentGuardianLink } from '../../students/student.models';
import { rolesMap } from '../core/chart.service';
import { assertInScope, auditFinance, financeCtx, financeScope, type FinanceCtx } from '../core/context';
import { formatMoney, toPaise } from '../core/money';
import { studentLabels } from '../core/people';
import { balancesOf, placementOf } from '../fees/account.service';
import { bulkAssign } from '../fees/assignment.service';
import { isOverdue, issueDocument, type BuiltLine } from '../fees/documents';
import { FeeDocument, FeePlan, FeePlanVersion, type FeeDocumentDoc, type FeePlanDoc, type FeePlanVersionDoc } from '../fees/models';
import { getStudentClearance } from '../fees/parent.service';
import { pendingClaimsOf } from './collection.service';
import { RefundRequest } from './models';

/** Fee extras (FEE-15 to 17): clearance for a leaving student, CSV import of opening balances and plans, reminders. */

export async function clearanceSummary(ctx: ServiceContext, studentId: string): Promise<ClearanceSummaryDTO> {
  const f = await financeCtx(ctx);
  const { loadStudentFor } = await import('../fees/account.service');
  await loadStudentFor(ctx, f, studentId);
  const [c, pending, open] = await Promise.all([getStudentClearance(ctx, studentId), pendingClaimsOf(f, studentId), RefundRequest.countDocuments({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, studentId, state: { $in: ['ELIGIBLE', 'REQUESTED', 'APPROVED'] } })]);
  const parts = [
    c.outstandingPaise > 0 ? `${formatMoney(c.outstandingPaise)} is still owed` : 'Nothing is owed',
    pending.count > 0 ? `${pending.count} payment${pending.count === 1 ? ' is' : 's are'} waiting to be checked (${formatMoney(pending.amountPaise)})` : null,
    c.refundableAdvancePaise > 0 ? `${formatMoney(c.refundableAdvancePaise)} advance can go back to the family` : null,
    c.refundableDepositPaise > 0 ? `${formatMoney(c.refundableDepositPaise)} deposit can be refunded` : null,
    open > 0 ? `${open} refund${open === 1 ? ' is' : 's are'} in progress` : null,
  ].filter(Boolean);
  return { studentId, status: c.status, billedPaise: c.billedPaise, paidPaise: c.paidPaise, outstandingPaise: c.outstandingPaise, pendingClaims: c.pendingClaims, pendingClaimsPaise: pending.amountPaise, refundableAdvancePaise: c.refundableAdvancePaise, refundableDepositPaise: c.refundableDepositPaise, openRefunds: open, sentence: `${parts.join('. ')}.` };
}

// ───────────────────────────────────────────────────────────── opening balances for one student (also used by the go-live import)

/** One OPENING bill. It is a debt the family already had, not income: Dr Student Receivable, Cr Opening Balance Equity. Safe to retry. */
export async function issueOpeningBill(f: FinanceCtx, db: Parameters<Parameters<typeof withTransaction>[0]>[0], input: { studentId: string; amountPaise: number; asOf: string; note?: string | undefined }): Promise<FeeDocumentDoc | null> {
  const placement = await placementOf(f, input.studentId);
  if (!placement.locationId || !placement.sessionId) throw new AppError('IMPORT_INVALID', 'This student has no class yet.');
  const equity = (await rolesMap(f, db)).get('OPENING_EQUITY');
  if (!equity) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts has no opening balance account. Use the standard chart in Finance Settings.');
  const sourceKey = `opening:${input.studentId}`;
  if (await FeeDocument.exists({ tenantId: f.tenantId, studentId: input.studentId, kind: 'OPENING' }).session(db)) return null;
  const line: BuiltLine = {
    feeHeadId: 'OPENING', feeItemId: null, description: input.note ?? 'Opening balance brought forward', periodKey: null, basePaise: input.amountPaise, discountPaise: 0, taxableValuePaise: input.amountPaise, taxCodeId: null, rateBps: 0, priceMode: 'EXCLUSIVE',
    cgstPaise: 0, sgstPaise: 0, igstPaise: 0, taxPaise: 0, totalPaise: input.amountPaise, incomeAccountId: equity._id, isDeposit: false, explanation: formatMoney(input.amountPaise), concessionAwardIds: [], sourceKey,
  };
  return issueDocument(f, db, { kind: 'OPENING', student: { studentId: input.studentId, enrollmentId: null, locationId: placement.locationId, sessionId: placement.sessionId, classOfferingId: placement.classOfferingId }, periodKey: null, issueDate: input.asOf, dueDate: input.asOf, graceDays: 0, lines: [line], planVersionId: null, runId: null, parentDocumentId: null, journalKey: sourceKey, memo: `Opening balance brought forward`, correlationId: f.requestId }, await rolesMap(f, db));
}

// ───────────────────────────────────────────────────────────── CSV import (FEE-16)

interface ImportRow {
  row: number;
  studentId?: string;
  locationId?: string;
  amountPaise?: number;
  planVersionId?: string;
  problem?: string;
}

function readTable(text: string, need: string[]): { rows: string[][]; index: Map<string, number> } {
  const table = parseCsv(text);
  const header = (table[0] ?? []).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const index = new Map(header.map((h, i) => [h, i]));
  const missing = need.filter((n) => !index.has(n));
  if (missing.length) throw new AppError('IMPORT_INVALID', `The file needs these columns: ${need.join(', ')}.`, { missing });
  if (table.length - 1 > 2000) throw new AppError('IMPORT_INVALID', 'Import at most 2,000 rows at a time.');
  return { rows: table.slice(1), index };
}

async function parseImport(ctx: ServiceContext, f: FinanceCtx, kind: 'OPENING_BALANCES' | 'ASSIGNMENTS', text: string, options: { sessionId?: string | undefined }): Promise<ImportRow[]> {
  const scope = await financeScope(ctx);
  const { rows, index } = readTable(text, kind === 'OPENING_BALANCES' ? ['admissionnumber', 'amount'] : ['admissionnumber', 'planname']);
  const admissions = await StudentAdmission.find({ tenantId: f.tenantId, isCurrent: true, admissionNumber: { $in: rows.map((r) => r[index.get('admissionnumber')!] ?? '') } }).select('studentId admissionNumber').lean<{ studentId: string; admissionNumber: string }[]>();
  const byNumber = new Map(admissions.map((a) => [a.admissionNumber.toLowerCase(), a.studentId]));
  let plans = new Map<string, string>();
  if (kind === 'ASSIGNMENTS') {
    if (!options.sessionId) throw new AppError('IMPORT_INVALID', 'Choose the academic session for these plans.');
    const planDocs = await FeePlan.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, sessionId: options.sessionId, status: 'ACTIVE' }).lean<FeePlanDoc[]>();
    const versions = await FeePlanVersion.find({ tenantId: f.tenantId, planId: { $in: planDocs.map((p) => p._id) }, state: 'PUBLISHED' }).lean<FeePlanVersionDoc[]>();
    plans = new Map(planDocs.flatMap((p) => { const v = versions.find((x) => x.planId === p._id); return v ? [[p.name.toLowerCase(), v._id] as [string, string]] : []; }));
  }
  const seen = new Set<string>();
  const out: ImportRow[] = [];
  for (const [i, r] of rows.entries()) {
    const row = i + 2;
    const number = (r[index.get('admissionnumber')!] ?? '').trim();
    const studentId = byNumber.get(number.toLowerCase());
    if (!studentId) { out.push({ row, problem: `Admission number "${number}" was not found.` }); continue; }
    if (seen.has(studentId)) { out.push({ row, problem: `Admission number "${number}" appears twice in the file.` }); continue; }
    seen.add(studentId);
    const placement = await placementOf(f, studentId);
    if (!placement.locationId) { out.push({ row, problem: `${number} has no class yet.` }); continue; }
    try { await assertInScope(ctx, scope, placement.locationId, 'student', studentId); } catch { out.push({ row, problem: `${number} is at a campus you cannot use.` }); continue; }
    if (kind === 'OPENING_BALANCES') {
      const paise = toPaise(r[index.get('amount')!] ?? '');
      if (paise === null || paise <= 0) { out.push({ row, problem: `The amount for ${number} must be more than zero, like 4500 or 4500.50.` }); continue; }
      out.push({ row, studentId, locationId: placement.locationId, amountPaise: paise });
    } else {
      const name = (r[index.get('planname')!] ?? '').trim().toLowerCase();
      const versionId = plans.get(name);
      if (!versionId) { out.push({ row, problem: `No published fee plan is named "${r[index.get('planname')!] ?? ''}" for this session.` }); continue; }
      out.push({ row, studentId, locationId: placement.locationId, planVersionId: versionId });
    }
  }
  return out;
}

const previewOf = (kind: ImportPreviewDTO['kind'], parsed: ImportRow[], hash: string, committed: boolean): ImportPreviewDTO => ({
  kind, rows: parsed.length, ready: parsed.filter((p) => !p.problem).length, problems: parsed.filter((p) => p.problem).map((p) => ({ row: p.row, message: p.problem! })), totalPaise: parsed.reduce((s, p) => s + (p.problem ? 0 : p.amountPaise ?? 0), 0), fileHash: hash, committed,
});

export async function previewFeeImport(ctx: ServiceContext, data: { kind: 'OPENING_BALANCES' | 'ASSIGNMENTS'; sessionId?: string | undefined }, file: Buffer | undefined): Promise<ImportPreviewDTO> {
  if (!file) throw AppError.validation({ file: 'Choose a CSV file.' });
  const f = await financeCtx(ctx);
  const text = file.toString('utf8');
  return previewOf(data.kind, await parseImport(ctx, f, data.kind, text, data), createHash('sha256').update(text).digest('hex'), false);
}

/** Commits every good row. A row that fails is reported, the rest still go in, and running the same file again changes nothing. */
export async function commitFeeImport(ctx: ServiceContext, data: { kind: 'OPENING_BALANCES' | 'ASSIGNMENTS'; sessionId?: string | undefined; asOf?: string | null | undefined }, file: Buffer | undefined): Promise<ImportPreviewDTO> {
  if (!file) throw AppError.validation({ file: 'Choose a CSV file.' });
  const f = await financeCtx(ctx);
  const text = file.toString('utf8');
  const hash = createHash('sha256').update(text).digest('hex');
  const parsed = await parseImport(ctx, f, data.kind, text, data);
  const today = await todayFor(ctx);
  const problems: ImportRow[] = [];
  if (data.kind === 'OPENING_BALANCES') {
    const asOf = data.asOf ?? today;
    for (const row of parsed.filter((p) => !p.problem)) {
      try {
        await withTransaction(async (db) => {
          await issueOpeningBill(f, db, { studentId: row.studentId!, amountPaise: row.amountPaise!, asOf });
        });
      } catch (err) {
        problems.push({ ...row, problem: err instanceof AppError ? err.message : 'This row could not be saved.' });
      }
    }
  } else {
    const byLocation = new Map<string, ImportRow[]>();
    for (const row of parsed.filter((p) => !p.problem)) byLocation.set(row.locationId!, [...(byLocation.get(row.locationId!) ?? []), row]);
    for (const [locationId, rows] of byLocation) {
      const res = await bulkAssign(ctx, { sessionId: data.sessionId!, locationId, items: rows.map((r) => ({ studentId: r.studentId!, planVersionId: r.planVersionId! })) }, 'IMPORT');
      for (const r of res.results.filter((x) => x.status === 'SKIPPED' && x.reason !== 'ALREADY_ASSIGNED')) problems.push({ ...(rows.find((x) => x.studentId === r.studentId) ?? { row: 0 }), problem: r.message ?? 'This student was not assigned.' });
    }
  }
  const final = parsed.map((p) => problems.find((x) => x.row === p.row) ?? p);
  await auditFinance(f, undefined, { action: 'fee_import.committed', entityType: 'fee_import', entityId: hash.slice(0, 16), after: { kind: data.kind, rows: parsed.length, problems: final.filter((p) => p.problem).length } });
  return previewOf(data.kind, final, hash, true);
}

// ───────────────────────────────────────────────────────────── reminders (FEE-17)

/** Who is overdue by at least N days, one line per student. A reminder carries amounts and bill numbers only. */
export async function previewReminders(ctx: ServiceContext, data: { minDaysOverdue: number; locationId?: string | undefined; classOfferingId?: string | undefined }): Promise<ReminderPreviewDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const today = await todayFor(ctx);
  if (data.locationId) await assertInScope(ctx, scope, data.locationId, 'reminder', data.locationId);
  const docs = (await FeeDocument.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: { $in: ['BILL', 'LATE_FEE', 'DEBIT_NOTE', 'OPENING'] }, balancePaise: { $gt: 0 }, ...(data.locationId ? { locationId: data.locationId } : scope.all ? {} : { locationId: { $in: scope.locationIds } }), ...(data.classOfferingId ? { classOfferingId: data.classOfferingId } : {}) }).lean<FeeDocumentDoc[]>())
    .filter((d) => isOverdue(d, today) && daysBetween(d.overdueAfter, today) >= data.minDaysOverdue);
  const byStudent = new Map<string, FeeDocumentDoc[]>();
  for (const d of docs) byStudent.set(d.studentId, [...(byStudent.get(d.studentId) ?? []), d]);
  const ids = [...byStudent.keys()];
  const [labels, links] = await Promise.all([studentLabels(f, ids), StudentGuardianLink.find({ tenantId: f.tenantId, studentId: { $in: ids }, cancelledAt: null }).sort({ isPrimary: -1 }).lean<{ studentId: string; guardianPersonId: string }[]>()]);
  const people = new Map((await Person.find({ tenantId: f.tenantId, _id: { $in: links.map((l) => l.guardianPersonId) } }).select('legalFirstName legalLastName preferredName primaryEmail personalEmail').lean<{ _id: string; legalFirstName: string; legalLastName: string; preferredName: string | null; primaryEmail: string | null; personalEmail: string | null }[]>()).map((p) => [p._id, p]));
  const items = ids.map((studentId) => {
    const mine = byStudent.get(studentId)!;
    const link = links.find((l) => l.studentId === studentId);
    const p = link ? people.get(link.guardianPersonId) : undefined;
    return {
      studentId, studentName: labels.get(studentId)?.name ?? 'Student', guardianName: p ? p.preferredName || `${p.legalFirstName} ${p.legalLastName}`.trim() : null, guardianEmail: p?.primaryEmail ?? p?.personalEmail ?? null,
      billNumbers: mine.map((d) => d.number), overduePaise: mine.reduce((s, d) => s + d.balancePaise, 0), oldestDaysLate: Math.max(...mine.map((d) => daysBetween(d.overdueAfter, today))),
    };
  }).sort((a, b) => b.overduePaise - a.overduePaise);
  return { minDaysOverdue: data.minDaysOverdue, count: items.length, totalPaise: items.reduce((s, i) => s + i.overduePaise, 0), items };
}

/** Writes each reminder to the notifier (the dev outbox until a real provider is connected). A family with no email is skipped, not guessed. */
export async function sendReminders(ctx: ServiceContext, data: { minDaysOverdue: number; locationId?: string | undefined; classOfferingId?: string | undefined }): Promise<ReminderResultDTO> {
  const f = await financeCtx(ctx);
  const preview = await previewReminders(ctx, data);
  let sent = 0;
  for (const item of preview.items) {
    if (!item.guardianEmail) continue;
    await sendSafely({ tenantId: f.tenantId, to: item.guardianEmail, template: 'FEE_REMINDER', link: '', body: `Fee reminder for ${item.studentName}: ${formatMoney(item.overduePaise)} is overdue. Bills: ${item.billNumbers.join(', ')}.` });
    sent += 1;
  }
  await auditFinance(f, undefined, { action: 'fee_reminders.sent', entityType: 'fee_reminder', entityId: f.legalEntityId, after: { sent, skipped: preview.count - sent, minDaysOverdue: data.minDaysOverdue } });
  return { sent, skipped: preview.count - sent };
}

export { balancesOf, Student };
