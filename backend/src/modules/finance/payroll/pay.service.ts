import { createHash } from 'node:crypto';
import type { DisbursementBatchDTO, DisbursementItemDTO, LiabilityDTO, MyPayrollSummaryDTO, PayrollRunDTO, PayslipDTO, ReportDTO, TaxDeclarationDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { daysBetween } from '../../../core/dates';
import { withTransaction } from '../../../db/transaction';
import { toCsv } from '../../../platform/identity/csv';
import { findRestricted, readValue } from '../../../platform/identity/restricted-data';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { Employee, type EmployeeDoc } from '../../staff/employee.model';
import { findCallerEmployee } from '../../staff/access';
import { todayFor } from '../../staff/status';
import { rolesMap } from '../core/chart.service';
import { auditFinance, emitFinance, financeCtx, fyCodeFor, nextNumber, type FinanceCtx } from '../core/context';
import { BankAccount, JournalLine, type BankAccountDoc } from '../core/models';
import { formatMoney, roundHalfUp } from '../core/money';
import { postJournal, type PostLine } from '../core/posting';
import { BASIS, makeReport, reportCsv, sumRows } from '../core/report';
import { registerMatchSource } from '../banking/sources';
import { mergeLines } from '../collections/alloc';
import { normRef } from '../collections/collection.service';
import { Advance, DisbursementBatch, DisbursementItem, PayrollRun, PayrollRunEmployee, Payslip, type AdvanceDoc, type DisbursementBatchDoc, type DisbursementItemDoc, type PayrollRunDoc, type PayrollRunEmployeeDoc, type PayslipDoc } from './models';
import { calculateRun, monthName, payslipDTOs, payslipPdf, scopedRun } from './run.service';
import { declarationDTO, declarationFor, employeeLabels, employeesInScope, saveDeclaration, scopedEmployee } from './setup.service';

/**
 * Paying the salary (PAY-11 to 14). Four steps that are never merged: a bank FILE is built (it marks nobody paid), a person RECORDS what
 * the bank actually did (paid, failed, returned), a second person VERIFIES it (only then is the journal posted and the payout status moved), and a
 * bank debit can match the batch later. A payment can never be more than what is still payable to that employee.
 */

const paidOf = async (f: FinanceCtx, runEmployeeId: string, db?: Parameters<Parameters<typeof withTransaction>[0]>[0]) =>
  (await DisbursementItem.find({ tenantId: f.tenantId, runEmployeeId, status: 'PAID' }).session(db ?? null).select('amountPaise').lean<{ amountPaise: number }[]>()).reduce((s, i) => s + i.amountPaise, 0);

async function batchDTO(f: FinanceCtx, b: DisbursementBatchDoc): Promise<DisbursementBatchDTO> {
  const items = await DisbursementItem.find({ tenantId: f.tenantId, batchId: b._id }).sort({ createdAt: 1 }).lean<DisbursementItemDoc[]>();
  const labels = await employeeLabels(f, [...items.map((i) => i.employeeId), ...b.skipped.map((s) => s.employeeId)]);
  const dto = (i: DisbursementItemDoc): DisbursementItemDTO => ({ itemId: i._id, employeeId: i.employeeId, employeeName: labels.get(i.employeeId)?.name ?? 'Employee', amountPaise: i.amountPaise, status: i.status, mode: i.mode, reference: i.reference, paidOn: i.paidOn, reason: i.reason, verified: i.verified, retryOfId: i.retryOfId });
  return {
    batchId: b._id, runId: b.runId, month: b.month, bankAccountId: b.bankAccountId, fileHash: b.fileHash, state: b.state, totalPaise: b.totalPaise, paidPaise: items.filter((i) => i.status === 'PAID').reduce((s, i) => s + i.amountPaise, 0), verifiedPaise: items.filter((i) => i.status === 'PAID' && i.verified).reduce((s, i) => s + i.amountPaise, 0),
    items: items.map(dto), skipped: b.skipped.map((s) => ({ employeeId: s.employeeId, employeeName: labels.get(s.employeeId)?.name ?? 'Employee', reason: s.reason })), createdAt: b.createdAt.toISOString(),
  };
}

async function loadBatch(ctx: ServiceContext, f: FinanceCtx, batchId: string): Promise<{ batch: DisbursementBatchDoc; run: PayrollRunDoc }> {
  const batch = await DisbursementBatch.findOne({ _id: batchId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<DisbursementBatchDoc>();
  if (!batch) throw AppError.notFound('Payment batch not found.');
  return { batch, run: await scopedRun(ctx, f, batch.runId) };
}

export async function buildBatch(ctx: ServiceContext, runId: string, data: { bankAccountId: string }): Promise<DisbursementBatchDTO> {
  const f = await financeCtx(ctx);
  const run = await scopedRun(ctx, f, runId);
  if (run.state !== 'FINALIZED') throw new AppError('PAYROLL_STATE_INVALID', 'Salary can be paid only after the run is finalised.');
  const bank = await BankAccount.findOne({ _id: data.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).lean<BankAccountDoc>();
  if (!bank) throw AppError.notFound('Bank account not found.');
  const batch = await withTransaction(async (db) => {
    const rows = await PayrollRunEmployee.find({ tenantId: f.tenantId, runId, held: false, netPaise: { $gt: 0 } }).session(db).lean<PayrollRunEmployeeDoc[]>();
    const employees = new Map((await Employee.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.employeeId) } }).lean<EmployeeDoc[]>()).map((e) => [e._id, e]));
    const skipped: { employeeId: string; reason: string }[] = [];
    const items: Partial<DisbursementItemDoc>[] = [];
    for (const r of rows) {
      const payable = r.netPaise - (await paidOf(f, r._id, db));
      if (payable <= 0) continue;
      if (await DisbursementItem.exists({ tenantId: f.tenantId, runEmployeeId: r._id, status: 'PENDING' }).session(db)) { skipped.push({ employeeId: r.employeeId, reason: 'Already in another payment batch.' }); continue; }
      const restricted = await findRestricted(f.tenantId, employees.get(r.employeeId)!.personId, db);
      if (!restricted?.bank) { skipped.push({ employeeId: r.employeeId, reason: 'No bank account on record.' }); continue; }
      items.push({ runEmployeeId: r._id, employeeId: r.employeeId, amountPaise: payable });
    }
    const [b] = await DisbursementBatch.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, runId, month: run.month, bankAccountId: bank._id, totalPaise: items.reduce((s, i) => s + (i.amountPaise ?? 0), 0), skipped, createdBy: ctx.userId }], { session: db });
    if (items.length) await DisbursementItem.create(items.map((i) => ({ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, batchId: b!._id, runId, ...i })), { session: db, ordered: true });
    await auditFinance(f, db, { action: 'payroll_batch.built', entityType: 'payroll_batch', entityId: b!._id, after: { items: items.length, skipped: skipped.length } });
    return b!.toObject() as DisbursementBatchDoc;
  });
  return batchDTO(f, batch);
}

export async function getBatch(ctx: ServiceContext, batchId: string): Promise<DisbursementBatchDTO> {
  const f = await financeCtx(ctx);
  return batchDTO(f, (await loadBatch(ctx, f, batchId)).batch);
}

export async function listBatches(ctx: ServiceContext, runId: string): Promise<DisbursementBatchDTO[]> {
  const f = await financeCtx(ctx);
  await scopedRun(ctx, f, runId);
  return Promise.all((await DisbursementBatch.find({ tenantId: f.tenantId, runId }).sort({ createdAt: -1 }).lean<DisbursementBatchDoc[]>()).map((b) => batchDTO(f, b)));
}

/** The generic bank file. Account numbers are read here, on the server, and written only into the file. They never reach a screen or a log. Making it pays nobody. */
export async function bankFile(ctx: ServiceContext, batchId: string): Promise<{ csv: string; fileName: string; hash: string }> {
  const f = await financeCtx(ctx);
  const { batch } = await loadBatch(ctx, f, batchId);
  const items = await DisbursementItem.find({ tenantId: f.tenantId, batchId, status: 'PENDING' }).sort({ createdAt: 1, _id: 1 }).lean<DisbursementItemDoc[]>();
  const employees = new Map((await Employee.find({ tenantId: f.tenantId, _id: { $in: items.map((i) => i.employeeId) } }).lean<EmployeeDoc[]>()).map((e) => [e._id, e]));
  const labels = await employeeLabels(f, items.map((i) => i.employeeId));
  const slips = new Map((await Payslip.find({ tenantId: f.tenantId, runEmployeeId: { $in: items.map((i) => i.runEmployeeId) } }).select('runEmployeeId number').lean<{ runEmployeeId: string; number: string }[]>()).map((s) => [s.runEmployeeId, s.number]));
  const rows: string[][] = [];
  for (const i of items.sort((a, b) => (labels.get(a.employeeId)?.code ?? '').localeCompare(labels.get(b.employeeId)?.code ?? ''))) {
    const e = employees.get(i.employeeId)!;
    const doc = await findRestricted(f.tenantId, e.personId);
    const number = readValue(e.personId, doc, null, 'BANK_ACCOUNT_NUMBER');
    if (!number || !doc?.bank) continue;
    rows.push([doc.bank.accountHolderName || labels.get(i.employeeId)?.name || '', number, doc.bank.ifsc, (i.amountPaise / 100).toFixed(2), slips.get(i.runEmployeeId) ?? '']);
  }
  const csv = toCsv(['Name', 'Account number', 'IFSC', 'Amount', 'Reference'], rows);
  const hash = createHash('sha256').update(csv).digest('hex');
  await DisbursementBatch.updateOne({ _id: batch._id, tenantId: f.tenantId }, { $set: { fileHash: hash } });
  await auditFinance(f, undefined, { action: 'payroll_bank_file.downloaded', entityType: 'payroll_batch', entityId: batchId, after: { rows: rows.length, hash } }); // never the account numbers
  return { csv, fileName: `salary-${batch.month}-${batch._id.slice(0, 8)}.csv`, hash };
}

/** What really happened at the bank: paid, failed or returned. Partial payments are allowed. A retry for a failed one is a NEW item. */
export async function recordPayments(ctx: ServiceContext, batchId: string, data: { items: { employeeId: string; status: 'PAID' | 'FAILED' | 'RETURNED'; amountPaise?: number | undefined; reference?: string | null | undefined; paidOn?: string | null | undefined; mode: 'BANK' | 'CASH' | 'CHEQUE'; reason?: string | null | undefined }[]; evidenceNote?: string | null | undefined }): Promise<DisbursementBatchDTO> {
  const f = await financeCtx(ctx);
  const { batch } = await loadBatch(ctx, f, batchId);
  const today = await todayFor(ctx);
  await withTransaction(async (db) => {
    for (const input of data.items) {
      const row = await PayrollRunEmployee.findOne({ tenantId: f.tenantId, runId: batch.runId, employeeId: input.employeeId, held: false }).session(db).lean<PayrollRunEmployeeDoc>();
      if (!row) throw AppError.notFound('This employee is not in the run.');
      const payable = row.netPaise - (await paidOf(f, row._id, db));
      const pending = await DisbursementItem.findOne({ tenantId: f.tenantId, batchId, employeeId: input.employeeId, status: 'PENDING' }).session(db).lean<DisbursementItemDoc>();
      if (input.status === 'PAID') {
        if (input.mode === 'BANK' && !input.reference) throw AppError.validation({ reference: 'Enter the bank reference for this payment.' });
        if (input.mode !== 'BANK' && !input.reason) throw AppError.validation({ reason: 'Say why this salary is paid by cash or cheque.' });
        const amount = input.amountPaise ?? pending?.amountPaise ?? payable;
        if (amount > payable) throw new AppError('PAYOUT_EXCEEDS_PAYABLE', `Only ${formatMoney(payable)} is still payable to this employee.`, { payablePaise: payable });
        const fields = { status: 'PAID' as const, amountPaise: amount, mode: input.mode, reference: input.reference ?? null, paidOn: input.paidOn ?? today, reason: input.reason ?? null, evidenceNote: data.evidenceNote ?? null, recordedBy: ctx.userId };
        if (pending) await DisbursementItem.updateOne({ _id: pending._id, tenantId: f.tenantId, status: 'PENDING' }, { $set: fields }, { session: db });
        else {
          const last = await DisbursementItem.findOne({ tenantId: f.tenantId, runEmployeeId: row._id, status: { $in: ['FAILED', 'RETURNED'] } }).sort({ createdAt: -1 }).session(db).lean<DisbursementItemDoc>();
          await DisbursementItem.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, batchId, runId: batch.runId, runEmployeeId: row._id, employeeId: input.employeeId, retryOfId: last?._id ?? null, ...fields }], { session: db });
        }
      } else if (pending) {
        await DisbursementItem.updateOne({ _id: pending._id, tenantId: f.tenantId, status: 'PENDING' }, { $set: { status: input.status, reason: input.reason ?? null, reference: input.reference ?? null, paidOn: input.paidOn ?? today, recordedBy: ctx.userId } }, { session: db });
      } else {
        const paid = await DisbursementItem.findOne({ tenantId: f.tenantId, runEmployeeId: row._id, status: 'PAID', verified: false }).session(db).lean<DisbursementItemDoc>();
        if (!paid) throw new AppError('PAYROLL_STATE_INVALID', 'There is no payment to mark as failed or returned.');
        await DisbursementItem.updateOne({ _id: paid._id, tenantId: f.tenantId, status: 'PAID', verified: false }, { $set: { status: input.status, reason: input.reason ?? null } }, { session: db });
      }
    }
    await DisbursementBatch.updateOne({ _id: batchId, tenantId: f.tenantId, state: 'BUILT' }, { $set: { state: 'RECORDED' } }, { session: db });
    await auditFinance(f, db, { action: 'payroll_payments.recorded', entityType: 'payroll_batch', entityId: batchId, after: { items: data.items.length } });
  });
  return batchDTO(f, (await DisbursementBatch.findOne({ _id: batchId, tenantId: f.tenantId }).lean<DisbursementBatchDoc>())!);
}

/** A second person confirms the money left. Only now does the books show salary paid: Dr Salary Payable, Cr Bank (or Cash). */
export async function verifyPayments(ctx: ServiceContext, batchId: string, data: { employeeIds?: string[] | undefined }): Promise<DisbursementBatchDTO> {
  const f = await financeCtx(ctx);
  const { batch, run } = await loadBatch(ctx, f, batchId);
  const today = await todayFor(ctx);
  await withTransaction(async (db) => {
    const items = await DisbursementItem.find({ tenantId: f.tenantId, batchId, status: 'PAID', verified: false, ...(data.employeeIds ? { employeeId: { $in: data.employeeIds } } : {}) }).session(db).lean<DisbursementItemDoc[]>();
    if (items.length === 0) throw new AppError('PAYROLL_STATE_INVALID', 'There are no recorded payments waiting to be verified.');
    if (items.some((i) => i.recordedBy === ctx.userId)) throw new AppError('SELF_APPROVAL_BLOCKED', 'A different person must verify payments that you recorded.');
    const bank = await BankAccount.findOne({ _id: batch.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<BankAccountDoc>();
    const roles = await rolesMap(f, db);
    const payable = roles.get('SALARY_PAYABLE');
    if (!payable || !bank) throw new AppError('FINANCE_NOT_READY', 'The salary payable or bank account is missing.');
    const rows = new Map((await PayrollRunEmployee.find({ tenantId: f.tenantId, _id: { $in: items.map((i) => i.runEmployeeId) } }).session(db).lean<PayrollRunEmployeeDoc[]>()).map((r) => [r._id, r]));
    const lines: PostLine[] = [];
    for (const i of items) {
      const at = { employeeId: i.employeeId, locationId: rows.get(i.runEmployeeId)?.locationId ?? null };
      lines.push({ accountId: payable._id, debitPaise: i.amountPaise, ...at }, { accountId: i.mode === 'CASH' ? roles.get('CASH')?._id ?? bank.glAccountId : bank.glAccountId, creditPaise: i.amountPaise, ...at });
    }
    const key = createHash('sha256').update(items.map((i) => i._id).sort().join(',')).digest('hex').slice(0, 24);
    const { journal } = await postJournal(f, db, { eventType: 'salary.paid', sourceKey: `salary_paid:${key}`, accountingDate: items.map((i) => i.paidOn ?? today).sort().at(-1)!, lines: mergeLines(lines), memo: `Salary paid for ${monthName(run.month)} (${run.number})`, sourceType: 'payroll_batch', sourceId: batchId });
    const now = new Date();
    const res = await DisbursementItem.updateMany({ tenantId: f.tenantId, _id: { $in: items.map((i) => i._id) }, verified: false, status: 'PAID' }, { $set: { verified: true, verifiedBy: ctx.userId, verifiedAt: now, journalId: journal._id } }, { session: db });
    if (res.modifiedCount !== items.length) throw new AppError('VERSION_CONFLICT');
    const all = await PayrollRunEmployee.find({ tenantId: f.tenantId, runId: batch.runId, held: false }).session(db).select('netPaise').lean<{ netPaise: number }[]>();
    const verified = (await DisbursementItem.find({ tenantId: f.tenantId, runId: batch.runId, status: 'PAID', verified: true }).session(db).select('amountPaise').lean<{ amountPaise: number }[]>()).reduce((s, i) => s + i.amountPaise, 0);
    const total = all.reduce((s, r) => s + r.netPaise, 0);
    await PayrollRun.updateOne({ _id: batch.runId, tenantId: f.tenantId }, { $set: { payoutStatus: verified >= total ? 'PAID' : verified > 0 ? 'PARTIALLY_PAID' : 'UNPAID' } }, { session: db });
    const left = await DisbursementItem.exists({ tenantId: f.tenantId, batchId, status: 'PAID', verified: false }).session(db);
    if (!left) await DisbursementBatch.updateOne({ _id: batchId, tenantId: f.tenantId }, { $set: { state: 'VERIFIED' } }, { session: db });
    await auditFinance(f, db, { action: 'payroll_payments.verified', entityType: 'payroll_batch', entityId: batchId, after: { items: items.length, journalNumber: journal.number } });
    await emitFinance(f, db, 'salary.disbursement.verified', { batchId, runId: batch.runId, items: items.length });
  });
  return batchDTO(f, (await DisbursementBatch.findOne({ _id: batchId, tenantId: f.tenantId }).lean<DisbursementBatchDoc>())!);
}

/** A bank debit can match a whole batch of salary payments. Registered with the matching engine. */
registerMatchSource({
  type: 'payroll_batch',
  async list(f, bankAccountId, db) {
    const batches = await DisbursementBatch.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId }).session(db ?? null).lean<DisbursementBatchDoc[]>();
    const items = await DisbursementItem.find({ tenantId: f.tenantId, batchId: { $in: batches.map((b) => b._id) }, status: 'PAID', mode: 'BANK' }).session(db ?? null).lean<DisbursementItemDoc[]>();
    return batches.flatMap((b) => {
      const mine = items.filter((i) => i.batchId === b._id);
      if (mine.length === 0) return [];
      const refs = [...new Set(mine.map((i) => i.reference).filter((x): x is string => !!x))];
      return [{ type: 'payroll_batch', id: b._id, side: 'OUT' as const, amountPaise: mine.reduce((s, i) => s + i.amountPaise, 0), date: mine.map((i) => i.paidOn ?? '').sort().at(-1) ?? '', reference: refs.length === 1 ? refs[0]! : null, referenceNorm: refs.length === 1 ? normRef(refs[0]) : null, payer: null, label: `Salary ${monthName(b.month)}`, verified: mine.every((i) => i.verified) }];
    });
  },
});

// ───────────────────────────────────────────────────────────── liabilities (PAY-12)

export async function liabilities(ctx: ServiceContext): Promise<LiabilityDTO> {
  const f = await financeCtx(ctx);
  const today = await todayFor(ctx);
  const runs = await PayrollRun.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, state: 'FINALIZED' }).sort({ month: 1 }).lean<PayrollRunDoc[]>();
  const allowed = await employeesInScope(ctx, f, null);
  const unpaidByRun: LiabilityDTO['unpaidByRun'] = [];
  for (const r of runs) {
    if (allowed && r.employeeIds.some((id) => !allowed.includes(id))) continue;
    const verified = (await DisbursementItem.find({ tenantId: f.tenantId, runId: r._id, status: 'PAID', verified: true }).select('amountPaise').lean<{ amountPaise: number }[]>()).reduce((s, i) => s + i.amountPaise, 0);
    const unpaid = r.totals.netPaise - verified;
    if (unpaid > 0) unpaidByRun.push({ runId: r._id, month: r.month, number: r.number, unpaidPaise: unpaid, ageDays: Math.max(0, daysBetween(`${r.month}-28`, today)) });
  }
  const roles = await rolesMap(f);
  const statutory: LiabilityDTO['statutory'] = [];
  for (const [role, label] of [['PF_PAYABLE', 'PF payable'], ['ESI_PAYABLE', 'ESI payable'], ['PT_PAYABLE', 'Professional Tax payable'], ['TDS_PAYABLE', 'TDS payable']] as const) {
    const a = roles.get(role);
    if (!a) continue;
    const rows = await JournalLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, accountId: a._id }).select('debitPaise creditPaise').lean<{ debitPaise: number; creditPaise: number }[]>();
    statutory.push({ role, label, payablePaise: rows.reduce((s, r) => s + r.creditPaise - r.debitPaise, 0) });
  }
  return { unpaidSalaryPaise: unpaidByRun.reduce((s, r) => s + r.unpaidPaise, 0), unpaidByRun, statutory };
}

// ───────────────────────────────────────────────────────────── full and final settlement (PAY-13)

export async function startFullFinal(ctx: ServiceContext, employeeId: string, data: { lastWorkingDay?: string | null | undefined; leaveEncashmentDays: number; leaveEncashmentRatePaise: number; noticeAdjustmentPaise: number; bonusPaise: number; gratuityPaise: number }): Promise<PayrollRunDTO> {
  const f = await financeCtx(ctx);
  const emp = await scopedEmployee(ctx, f, employeeId);
  const exit = data.lastWorkingDay ?? emp.exitDate;
  if (!exit) throw new AppError('PAYROLL_STATE_INVALID', 'Record this employee\'s exit date in the staff record first.');
  if (data.lastWorkingDay && emp.exitDate && data.lastWorkingDay !== emp.exitDate) throw AppError.validation({ lastWorkingDay: 'This is not the exit date in the staff record.' });
  // A settlement is its own run type; it is created directly so it never collides with the month's normal run.
  const created = await withTransaction(async (db) => {
    const number = await nextNumber(f, db, 'SET', fyCodeFor(`${exit.slice(0, 7)}-01`, f.entity.fyStartMonth));
    const [r] = await PayrollRun.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, number, month: exit.slice(0, 7), type: 'FULL_FINAL', employeeIds: [employeeId], preparedBy: ctx.userId }], { session: db });
    const lines = [
      ...(data.leaveEncashmentDays > 0 && data.leaveEncashmentRatePaise > 0 ? [{ label: `Leave encashment (${data.leaveEncashmentDays} days)`, type: 'EARNING' as const, amountPaise: roundHalfUp(Math.trunc(data.leaveEncashmentDays * 100) * data.leaveEncashmentRatePaise, 100), reason: 'Entered by payroll' }] : []),
      ...(data.noticeAdjustmentPaise > 0 ? [{ label: 'Notice pay', type: 'EARNING' as const, amountPaise: data.noticeAdjustmentPaise, reason: 'Entered by payroll' }] : data.noticeAdjustmentPaise < 0 ? [{ label: 'Notice period shortfall', type: 'DEDUCTION' as const, amountPaise: -data.noticeAdjustmentPaise, reason: 'Entered by payroll' }] : []),
      ...(data.bonusPaise > 0 ? [{ label: 'Bonus', type: 'EARNING' as const, amountPaise: data.bonusPaise, reason: 'Entered by payroll' }] : []),
      ...(data.gratuityPaise > 0 ? [{ label: 'Gratuity', type: 'EARNING' as const, amountPaise: data.gratuityPaise, reason: 'Entered by payroll' }] : []),
    ];
    await PayrollRunEmployee.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, runId: r!._id, employeeId, oneOffLines: lines }], { session: db });
    await auditFinance(f, db, { action: 'full_final.started', entityType: 'payroll_run', entityId: r!._id, after: { employeeId } });
    return r!._id;
  });
  return calculateRun(ctx, created);
}

export async function settlementStatement(ctx: ServiceContext, runId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const f = await financeCtx(ctx);
  const run = await scopedRun(ctx, f, runId);
  if (run.type !== 'FULL_FINAL' || run.state !== 'FINALIZED') throw new AppError('PAYROLL_STATE_INVALID', 'The settlement statement is issued after the settlement is finalised.');
  const slip = await Payslip.findOne({ tenantId: f.tenantId, runId }).lean<PayslipDoc>();
  if (!slip) throw AppError.notFound('Settlement not found.');
  return { buffer: payslipPdf({ ...slip, number: `${slip.number} (FULL AND FINAL)` }), fileName: `settlement-${run.number.replace(/\//g, '-')}.pdf` };
}

// ───────────────────────────────────────────────────────────── self-service (PAY-14): identity comes from the session only

async function me(ctx: ServiceContext) {
  const employee = await findCallerEmployee(ctx);
  if (!employee) throw new AppError('NO_EMPLOYEE_PROFILE');
  return employee;
}

export async function mySummary(ctx: ServiceContext): Promise<MyPayrollSummaryDTO> {
  const f = await financeCtx(ctx);
  const e = await me(ctx);
  const mine = await myPayslipRows(f, e._id);
  const today = await todayFor(ctx);
  const [advances, decl] = await Promise.all([Advance.find({ tenantId: f.tenantId, employeeId: e._id, state: 'PAID_OUT' }).lean<AdvanceDoc[]>(), declarationFor(f, e._id, today.slice(0, 7))]);
  return { employeeId: e._id, latestPayslip: mine[0] ? { payslipId: mine[0]._id, month: mine[0].month, netPaise: mine[0].snapshot.netPaise } : null, openAdvancePaise: advances.reduce((s, a) => s + a.remainingPaise, 0), taxDeclaration: decl ? declarationDTO(decl, today.slice(0, 7)) : null };
}

/** Published payslips of the signed-in employee only. */
async function myPayslipRows(f: FinanceCtx, employeeId: string): Promise<PayslipDoc[]> {
  const { PayslipPublication } = await import('./models');
  const published = (await PayslipPublication.find({ tenantId: f.tenantId }).select('runId').lean<{ runId: string }[]>()).map((p) => p.runId);
  return Payslip.find({ tenantId: f.tenantId, employeeId, runId: { $in: published } }).sort({ month: -1 }).lean<PayslipDoc[]>();
}

export async function myPayslips(ctx: ServiceContext): Promise<PayslipDTO[]> {
  const f = await financeCtx(ctx);
  const e = await me(ctx);
  return payslipDTOs(f, await myPayslipRows(f, e._id));
}

export async function myPayslipPdf(ctx: ServiceContext, payslipId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const f = await financeCtx(ctx);
  const e = await me(ctx);
  const p = (await myPayslipRows(f, e._id)).find((x) => x._id === payslipId);
  if (!p) throw AppError.notFound('Payslip not found.'); // another person's, or one not published yet: the same answer
  await auditFinance(f, undefined, { action: 'payslip.downloaded', entityType: 'payslip', entityId: p._id, metadata: { self: true } });
  return { buffer: payslipPdf(p), fileName: `payslip-${p.number.replace(/\//g, '-')}.pdf` };
}

export async function myAdvances(ctx: ServiceContext) {
  const f = await financeCtx(ctx);
  const e = await me(ctx);
  const rows = await Advance.find({ tenantId: f.tenantId, employeeId: e._id }).sort({ createdAt: -1 }).lean<AdvanceDoc[]>();
  return rows.map((a) => ({ advanceId: a._id, principalPaise: a.principalPaise, installmentPaise: a.installmentPaise, remainingPaise: a.remainingPaise, startMonth: a.startMonth, state: a.state, paidOn: a.paidOn }));
}

export async function saveMyDeclaration(ctx: ServiceContext, data: { regime: 'NEW' | 'OLD'; estimatedYearlyTaxPaise: number; alreadyDeductedPaise: number; note?: string | null | undefined }): Promise<TaxDeclarationDTO> {
  const e = await me(ctx);
  return saveDeclaration(ctx, e._id, data, 'SELF');
}

// ───────────────────────────────────────────────────────────── reports (PAY-15)

type Q = { month?: string | undefined };
export async function payrollReport(ctx: ServiceContext, type: string, query: Q): Promise<ReportDTO> {
  const f = await financeCtx(ctx);
  const sensitive = can(ctx, 'payroll:salary:view_sensitive');
  const month = query.month ?? (await todayFor(ctx)).slice(0, 7);
  const allowed = await employeesInScope(ctx, f, null);
  const runs = await PayrollRun.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, month, state: 'FINALIZED' }).lean<PayrollRunDoc[]>();
  const rows = await PayrollRunEmployee.find({ tenantId: f.tenantId, runId: { $in: runs.map((r) => r._id) }, held: false, ...(allowed ? { employeeId: { $in: allowed } } : {}) }).lean<PayrollRunEmployeeDoc[]>();
  const labels = await employeeLabels(f, rows.map((r) => r.employeeId));
  const text = (key: string, label: string) => ({ key, label, kind: 'text' as const });
  const money = (key: string, label: string) => ({ key, label, kind: 'money' as const });
  const money$ = (cols: ReturnType<typeof money>[]) => (sensitive ? cols : []);
  const base = { from: month, to: month };
  switch (type) {
    case 'register': {
      const out = rows.map((r) => ({ code: labels.get(r.employeeId)?.code ?? '', name: labels.get(r.employeeId)?.name ?? '', department: labels.get(r.employeeId)?.departmentName ?? null, paidDays: r.paidDen ? `${r.paidNum}/${r.paidDen}` : null, grossPaise: r.grossPaise, deductionsPaise: r.deductionsPaise, employerCostPaise: r.employerCostPaise, netPaise: r.netPaise })).sort((a, b) => a.code.localeCompare(b.code));
      return makeReport({ type, title: `Payroll register, ${monthName(month)}`, basis: BASIS.PAYROLL, ...base, columns: [text('code', 'Code'), text('name', 'Name'), text('department', 'Department'), text('paidDays', 'Paid days'), ...money$([money('grossPaise', 'Gross'), money('deductionsPaise', 'Deductions'), money('employerCostPaise', 'Employer cost'), money('netPaise', 'Net pay')])], rows: out.map((r) => ({ code: r.code, name: r.name, department: r.department, paidDays: r.paidDays, ...(sensitive ? { grossPaise: r.grossPaise, deductionsPaise: r.deductionsPaise, employerCostPaise: r.employerCostPaise, netPaise: r.netPaise } : {}) })), totals: sensitive ? sumRows(out, ['grossPaise', 'deductionsPaise', 'employerCostPaise', 'netPaise']) : null, notes: sensitive ? [] : ['Salary amounts are hidden. They need the salary permission.'] });
    }
    case 'bank-advice': {
      const emps = new Map((await Employee.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.employeeId) } }).lean<EmployeeDoc[]>()).map((e) => [e._id, e]));
      const out = [] as { code: string; name: string; account: string; ifsc: string; netPaise: number }[];
      for (const r of rows) {
        const doc = await findRestricted(f.tenantId, emps.get(r.employeeId)!.personId);
        out.push({ code: labels.get(r.employeeId)?.code ?? '', name: labels.get(r.employeeId)?.name ?? '', account: doc?.bank ? `••••${doc.bank.last4}` : 'No bank account', ifsc: doc?.bank?.ifsc ?? '', netPaise: r.netPaise });
      }
      out.sort((a, b) => a.code.localeCompare(b.code));
      return makeReport({ type, title: `Bank advice, ${monthName(month)}`, basis: BASIS.PAYROLL, ...base, columns: [text('code', 'Code'), text('name', 'Name'), text('account', 'Account'), text('ifsc', 'IFSC'), ...money$([money('netPaise', 'Net pay')])], rows: out.map((r) => ({ code: r.code, name: r.name, account: r.account, ifsc: r.ifsc, ...(sensitive ? { netPaise: r.netPaise } : {}) })), totals: sensitive ? sumRows(out, ['netPaise']) : null, notes: ['Account numbers are never shown here. The bank file is downloaded from the payment batch.'] });
    }
    case 'statutory-summary': {
      const { PayrollRunLine } = await import('./models');
      const lines = await PayrollRunLine.find({ tenantId: f.tenantId, runId: { $in: runs.map((r) => r._id) }, componentKey: { $in: ['PF', 'EMP_PF', 'ESI', 'EMP_ESI', 'PT', 'TDS'] } }).lean<{ componentKey: string; amountPaise: number }[]>();
      const roles = await rolesMap(f);
      const groups: [string, string[], string][] = [['PF', ['PF', 'EMP_PF'], 'PF_PAYABLE'], ['ESI', ['ESI', 'EMP_ESI'], 'ESI_PAYABLE'], ['Professional Tax', ['PT'], 'PT_PAYABLE'], ['TDS', ['TDS'], 'TDS_PAYABLE']];
      const out = [];
      for (const [name, keys, role] of groups) {
        const acc = roles.get(role);
        const jl = acc ? await JournalLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, accountId: acc._id }).select('debitPaise creditPaise').lean<{ debitPaise: number; creditPaise: number }[]>() : [];
        out.push({ name, deductedPaise: lines.filter((l) => keys.includes(l.componentKey)).reduce((s, l) => s + l.amountPaise, 0), paidToAuthorityPaise: jl.reduce((s, l) => s + l.debitPaise, 0), stillPayablePaise: jl.reduce((s, l) => s + l.creditPaise - l.debitPaise, 0) });
      }
      return makeReport({ type, title: `Statutory summary, ${monthName(month)}`, basis: BASIS.JOURNALS, ...base, columns: [text('name', 'Item'), ...money$([money('deductedPaise', 'Taken this month'), money('paidToAuthorityPaise', 'Paid to the authority (all time)'), money('stillPayablePaise', 'Still payable (all time)')])], rows: out.map((r) => ({ name: r.name, ...(sensitive ? { deductedPaise: r.deductedPaise, paidToAuthorityPaise: r.paidToAuthorityPaise, stillPayablePaise: r.stillPayablePaise } : {}) })), totals: sensitive ? sumRows(out, ['deductedPaise', 'paidToAuthorityPaise', 'stillPayablePaise']) : null });
    }
    case 'liability-aging': {
      const l = await liabilities(ctx);
      return makeReport({ type, title: 'Salary liability aging', basis: BASIS.PAYROLL, columns: [text('number', 'Run'), text('month', 'Month'), { key: 'ageDays', label: 'Age (days)', kind: 'number' }, ...money$([money('unpaidPaise', 'Unpaid')])], rows: l.unpaidByRun.map((r) => ({ number: r.number, month: r.month, ageDays: r.ageDays, ...(sensitive ? { unpaidPaise: r.unpaidPaise } : {}) })), totals: sensitive ? { unpaidPaise: l.unpaidSalaryPaise } : null, notes: ['Paid means verified by a second person, not just recorded.'] });
    }
    case 'cost-by-location-department': {
      const { Location } = await import('../../locations/location.model');
      const names = new Map((await Location.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.locationId).filter((x): x is string => !!x) } }).select('name').lean<{ _id: string; name: string }[]>()).map((l) => [l._id, l.name]));
      const out = new Map<string, { location: string; department: string; employees: number; costPaise: number }>();
      for (const r of rows) {
        const key = `${r.locationId}|${r.departmentId}`;
        const have = out.get(key) ?? { location: names.get(r.locationId ?? '') ?? 'No campus', department: labels.get(r.employeeId)?.departmentName ?? 'No department', employees: 0, costPaise: 0 };
        have.employees += 1;
        have.costPaise += r.grossPaise + r.employerCostPaise;
        out.set(key, have);
      }
      const list = [...out.values()].sort((a, b) => a.location.localeCompare(b.location) || a.department.localeCompare(b.department));
      return makeReport({ type, title: `Payroll cost by campus and department, ${monthName(month)}`, basis: BASIS.PAYROLL, ...base, columns: [text('location', 'Campus'), text('department', 'Department'), { key: 'employees', label: 'Employees', kind: 'number' }, ...money$([money('costPaise', 'Gross pay + employer cost')])], rows: list.map((r) => ({ location: r.location, department: r.department, employees: r.employees, ...(sensitive ? { costPaise: r.costPaise } : {}) })), totals: sensitive ? sumRows(list, ['employees', 'costPaise']) : null });
    }
    default:
      throw AppError.notFound('Report not found.');
  }
}

export async function payrollReportCsv(ctx: ServiceContext, type: string, query: Q): Promise<string> {
  const report = await payrollReport(ctx, type, query);
  const f = await financeCtx(ctx);
  await auditFinance(f, undefined, { action: 'report.exported', entityType: 'payroll_report', entityId: type, after: { rows: report.rows.length, month: query.month ?? null } });
  return reportCsv(report);
}

