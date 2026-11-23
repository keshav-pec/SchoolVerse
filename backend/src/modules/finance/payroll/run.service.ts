import { createHash, randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { PayrollRunDTO, PayslipDTO, RunEmployeeDTO, RunExceptionDTO, RunExceptionsDTO, RunLineDTO, RunType } from '@shared';
import { AppError } from '../../../core/errors';
import { addDays } from '../../../core/dates';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { findRestricted } from '../../../platform/identity/restricted-data';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { LocationAssignment } from '../../staff/assignment.models';
import { Employee, type EmployeeDoc } from '../../staff/employee.model';
import { todayFor } from '../../staff/status';
import { simplePdf } from '../../students/tc.service';
import { mergeLines } from '../collections/alloc';
import { rolesMap } from '../core/chart.service';
import { auditFinance, emitFinance, financeCtx, fyCodeFor, monthRange, nextNumber, type FinanceCtx } from '../core/context';
import { ApprovalPolicy, ApprovalRequest, type ApprovalPolicyDoc } from '../core/models';
import { formatMoney, roundHalfUp } from '../core/money';
import { postJournal, type PostLine } from '../core/posting';
import { calculate, type EngineComponent, type EngineOutput } from './engine';
import {
  Advance, Compensation, DisbursementItem, PayrollInput, PayrollRun, PayrollRunEmployee, PayrollRunLine, Payslip, PayslipPublication, SalaryComponent, SalaryRevision, SalaryStructureVersion,
  type AdvanceDoc, type CompensationDoc, type PayrollInputDoc, type PayrollRunDoc, type PayrollRunEmployeeDoc, type PayrollRunLineDoc, type PayslipDoc, type SalaryComponentDoc, type SalaryRevisionDoc, type SalaryStructureVersionDoc,
} from './models';
import { compensationOn, declarationDTO, declarationFor, employeeLabels, employeesInScope, ensurePayrollSetup, monthlyGrossOf, rulesFor, scopedEmployee } from './setup.service';

/**
 * Payroll runs (PAY-07 to 10). A run is worked out for every employee of a month, with a formula in words for each line, and then shown
 * as exceptions first ("86 employees · 82 ready · 4 need action"). Calculating again gives the same answer until the run is finalised.
 * Finalising is one transaction that freezes the numbers, posts the journal and writes the payslips. After that only a linked correction
 * or supplementary run can change anything.
 */

const PREV_MONTH = (month: string) => { const [y, m] = month.split('-').map(Number) as [number, number]; return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`; };
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const monthName = (month: string) => `${MONTH_NAMES[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`;

// ───────────────────────────────────────────────────────────── DTOs

export async function runDTO(f: FinanceCtx, r: PayrollRunDoc): Promise<PayrollRunDTO> {
  const users = new Map((await User.find({ tenantId: f.tenantId, _id: { $in: [r.preparedBy, r.approvedBy].filter((x): x is string => !!x) } }).select('fullName').lean<{ _id: string; fullName: string }[]>()).map((u) => [u._id, u.fullName]));
  const label = r.type === 'MONTHLY' ? `${monthName(r.month).split(' ')[0]} payroll` : r.type === 'FULL_FINAL' ? 'Full and final settlement' : r.type === 'SUPPLEMENTARY' ? `${monthName(r.month).split(' ')[0]} supplementary payroll` : `${monthName(r.month).split(' ')[0]} correction`;
  const diff = r.previousNetPaise !== null ? r.totals.netPaise - r.previousNetPaise : null;
  return {
    runId: r._id, number: r.number, month: r.month, type: r.type, state: r.state, payoutStatus: r.payoutStatus,
    headline: r.state === 'DRAFT' ? `${label} · not calculated yet` : `${label} · ${r.counts.employees} employee${r.counts.employees === 1 ? '' : 's'} · ${r.counts.ready} ready · ${r.counts.needAction} need action${r.counts.held ? ` · ${r.counts.held} held` : ''}`,
    counts: r.counts, totals: r.totals, previousNetPaise: r.previousNetPaise,
    changeSentence: diff === null || r.previousNetPaise === 0 ? null : `${diff >= 0 ? 'Up' : 'Down'} ${formatMoney(Math.abs(diff))} from ${monthName(PREV_MONTH(r.month)).split(' ')[0]}.`,
    warnings: r.warnings, locationId: r.locationId, parentRunId: r.parentRunId, preparedByName: users.get(r.preparedBy) ?? null, approvedByName: r.approvedBy ? users.get(r.approvedBy) ?? null : null,
    finalizedAt: r.finalizedAt ? r.finalizedAt.toISOString() : null, version: r.version, createdAt: r.createdAt.toISOString(),
  };
}

async function rowDTOs(f: FinanceCtx, rows: PayrollRunEmployeeDoc[]): Promise<RunEmployeeDTO[]> {
  const [labels, slips, paid] = await Promise.all([
    employeeLabels(f, rows.map((r) => r.employeeId)),
    Payslip.find({ tenantId: f.tenantId, runEmployeeId: { $in: rows.map((r) => r._id) } }).select('runEmployeeId').lean<{ _id: string; runEmployeeId: string }[]>(),
    DisbursementItem.find({ tenantId: f.tenantId, runEmployeeId: { $in: rows.map((r) => r._id) }, status: 'PAID' }).select('runEmployeeId amountPaise').lean<{ runEmployeeId: string; amountPaise: number }[]>(),
  ]);
  const slip = new Map(slips.map((s) => [s.runEmployeeId, s._id]));
  return rows.map((r) => {
    const l = labels.get(r.employeeId);
    return {
      rowId: r._id, runId: r.runId, employeeId: r.employeeId, employeeName: l?.name ?? 'Employee', employeeCode: l?.code ?? '', departmentName: l?.departmentName ?? null, designationName: l?.designationName ?? null, locationId: r.locationId, status: r.status, held: r.held, holdReason: r.holdReason,
      grossPaise: r.grossPaise, deductionsPaise: r.deductionsPaise, employerCostPaise: r.employerCostPaise, netPaise: r.netPaise, paidDays: r.paidDen ? `${r.paidNum}/${r.paidDen}` : null, exceptions: r.exceptions, paidOutPaise: paid.filter((p) => p.runEmployeeId === r._id).reduce((s, p) => s + p.amountPaise, 0), payslipId: slip.get(r._id) ?? null,
    };
  });
}

const lineDTO = (l: PayrollRunLineDoc): RunLineDTO => ({ lineId: l._id, employeeId: l.employeeId, kind: l.kind, componentKey: l.componentKey, label: l.label, amountPaise: l.amountPaise, formula: l.formula });

export async function loadRun(f: FinanceCtx, runId: string, db?: ClientSession): Promise<PayrollRunDoc> {
  const r = await PayrollRun.findOne({ _id: runId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<PayrollRunDoc>();
  if (!r) throw AppError.notFound('Payroll run not found.');
  return r;
}

/** A run is visible only when every employee in it (or its campus) is inside the caller's scope. */
export async function scopedRun(ctx: ServiceContext, f: FinanceCtx, runId: string, db?: ClientSession): Promise<PayrollRunDoc> {
  const r = await loadRun(f, runId, db);
  const allowed = await employeesInScope(ctx, f, null);
  if (allowed && r.employeeIds.some((id) => !allowed.includes(id))) throw AppError.notFound('Payroll run not found.');
  return r;
}

// ───────────────────────────────────────────────────────────── create

export async function createRun(ctx: ServiceContext, data: { month: string; type: RunType; locationId?: string | undefined; parentRunId?: string | undefined; employeeIds?: string[] | undefined }): Promise<PayrollRunDTO> {
  const f = await financeCtx(ctx);
  await ensurePayrollSetup(f);
  const range = monthRange(data.month);
  const allowed = await employeesInScope(ctx, f, data.locationId);
  let ids: string[];
  if (data.employeeIds?.length) {
    for (const id of data.employeeIds) await scopedEmployee(ctx, f, id);
    ids = [...new Set(data.employeeIds)];
  } else {
    const live = await Employee.find({ tenantId: f.tenantId, joiningDate: { $lte: range.end }, status: { $ne: 'ONBOARDING' }, $or: [{ exitDate: null }, { exitDate: { $gte: range.start } }], ...(allowed ? { _id: { $in: allowed } } : {}) }).select('_id').lean<{ _id: string }[]>();
    ids = live.map((e) => e._id);
  }
  if (ids.length === 0) throw new AppError('PAYROLL_STATE_INVALID', 'There are no employees to pay for this month.');
  if (data.type !== 'MONTHLY') {
    if (!data.parentRunId) throw AppError.validation({ parentRunId: 'Choose the finalised run this one follows.' });
    const parent = await loadRun(f, data.parentRunId);
    if (parent.state !== 'FINALIZED') throw new AppError('PAYROLL_STATE_INVALID', 'A correction or supplementary run follows a finalised run.');
  }
  const created = await withTransaction(async (db) => {
    if (data.type === 'MONTHLY') {
      const clash = await PayrollRun.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, month: data.month, type: 'MONTHLY', state: { $ne: 'CANCELLED' }, locationId: data.locationId ?? null }).session(db).lean<PayrollRunDoc>();
      if (clash) throw new AppError('CONFLICT', clash.state === 'FINALIZED' ? 'This month was already paid. Use a supplementary or correction run to change anything.' : 'There is already a payroll run for this month. Open it instead.', { runId: clash._id });
    }
    const number = await nextNumber(f, db, 'PRN', fyCodeFor(`${data.month}-01`, f.entity.fyStartMonth));
    const [r] = await PayrollRun.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, number, month: data.month, type: data.type, locationId: data.locationId ?? null, parentRunId: data.parentRunId ?? null, employeeIds: ids, preparedBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'payroll_run.created', entityType: 'payroll_run', entityId: r!._id, after: { month: data.month, type: data.type, employees: ids.length } });
    return r!.toObject() as PayrollRunDoc;
  });
  return runDTO(f, created);
}

// ───────────────────────────────────────────────────────────── calculate

async function locationOf(f: FinanceCtx, employeeId: string, date: string): Promise<string | null> {
  const a = await LocationAssignment.findOne({ tenantId: f.tenantId, employeeId, cancelledAt: null, effectiveFrom: { $lte: date }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }] }).sort({ isPrimary: -1 }).lean<{ locationId: string }>();
  return a?.locationId ?? null;
}

async function componentsFor(f: FinanceCtx, comp: CompensationDoc | null): Promise<EngineComponent[]> {
  if (!comp) return [];
  const v = await SalaryStructureVersion.findOne({ _id: comp.structureVersionId, tenantId: f.tenantId }).lean<SalaryStructureVersionDoc>();
  const defs = new Map((await SalaryComponent.find({ tenantId: f.tenantId, _id: { $in: v?.items.map((i) => i.componentId) ?? [] } }).lean<SalaryComponentDoc[]>()).map((c) => [c._id, c]));
  const over = new Map(comp.overrides.map((o) => [o.componentId, o.amountPaise]));
  return (v?.items ?? []).flatMap((i) => {
    const c = defs.get(i.componentId);
    if (!c) return [];
    const overridden = over.get(c._id);
    return [{ componentId: c._id, code: c.code, name: c.name, type: c.type, calc: overridden !== undefined ? 'FIXED' as const : c.calc, pfWage: c.pfWage, esiWage: c.esiWage, prorate: c.prorate, glAccountId: c.glAccountId, amountPaise: overridden ?? i.amountPaise, rateBps: overridden !== undefined ? null : i.rateBps }];
  });
}

/** Arrears from a back-dated salary change: the difference for each month that was already paid at the old rate, in proportion to the days paid then. */
async function arrearsFor(f: FinanceCtx, employeeId: string, month: string, db?: ClientSession) {
  const revisions = await SalaryRevision.find({ tenantId: f.tenantId, employeeId, status: 'APPLIED', arrearPolicy: 'PAY_DIFFERENCE', arrearsRunId: null, effectiveDate: { $lt: `${month}-01` } }).session(db ?? null).lean<SalaryRevisionDoc[]>();
  const out: { revisionId: string; amountPaise: number; label: string }[] = [];
  for (const rev of revisions) {
    const newComp = await Compensation.findOne({ _id: rev.newAssignmentId, tenantId: f.tenantId }).session(db ?? null).lean<CompensationDoc>();
    if (!newComp) continue;
    const newFull = await monthlyGrossOf(f, newComp);
    const paidRows = await PayrollRunEmployee.find({ tenantId: f.tenantId, employeeId, held: false }).session(db ?? null).lean<PayrollRunEmployeeDoc[]>();
    const runs = new Map((await PayrollRun.find({ tenantId: f.tenantId, _id: { $in: paidRows.map((r) => r.runId) }, type: 'MONTHLY', state: 'FINALIZED', month: { $gte: rev.effectiveDate.slice(0, 7), $lt: month } }).session(db ?? null).lean<PayrollRunDoc[]>()).map((r) => [r._id, r]));
    let total = 0;
    for (const row of paidRows.filter((r) => runs.has(r.runId) && r.paidDen > 0)) total += roundHalfUp((newFull - row.fullMonthGrossPaise) * row.paidNum, row.paidDen);
    if (total !== 0) out.push({ revisionId: rev._id, amountPaise: total, label: `Arrears from the pay change of ${rev.effectiveDate}` });
  }
  return out;
}

export async function calculateRun(ctx: ServiceContext, runId: string): Promise<PayrollRunDTO> {
  const f = await financeCtx(ctx);
  const first = await scopedRun(ctx, f, runId);
  if (!['DRAFT', 'CALCULATED'].includes(first.state)) throw new AppError('PAYROLL_STATE_INVALID', first.state === 'CANCELLED' ? 'This run was cancelled.' : 'This run is already approved or finalised, so it cannot be calculated again.');
  const policy = await ensurePayrollSetup(f);
  const range = monthRange(first.month);
  const today = await todayFor(ctx);
  const rules = await rulesFor(f, range.end);
  const pf = rules.pf ? { employeeBps: rules.pf.params.employeeBps as number, employerBps: rules.pf.params.employerBps as number, wageCeilingPaise: rules.pf.params.wageCeilingPaise as number } : null;
  const esi = rules.esi ? { employeeBps: rules.esi.params.employeeBps as number, employerBps: rules.esi.params.employerBps as number, grossLimitPaise: rules.esi.params.grossLimitPaise as number } : null;
  const pt = rules.pt ? { slabs: rules.pt.params.slabs as { fromPaise: number; toPaise: number | null; amountPaise: number }[] } : null;
  const warnings: string[] = [];
  for (const r of [rules.pf, rules.esi, rules.pt]) if (r && (r.state !== 'APPROVED' || r.demo)) warnings.push(`${r.kind} rules are ${r.demo ? 'demo values' : 'not approved'}. Your accountant must ${r.demo ? 'replace and approve' : 'approve'} them before real use.`);
  const uniqueWarnings = [...new Set(warnings.map((w) => w))];

  const employees = await Employee.find({ tenantId: f.tenantId, _id: { $in: first.employeeIds } }).lean<EmployeeDoc[]>();
  const labels = await employeeLabels(f, first.employeeIds);
  employees.sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
  const existing = new Map((await PayrollRunEmployee.find({ tenantId: f.tenantId, runId }).lean<PayrollRunEmployeeDoc[]>()).map((r) => [r.employeeId, r]));
  const pending = new Set(((await ApprovalRequest.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'SALARY_REVISION', decision: 'PENDING' }).select('entityId').lean<{ entityId: string | null }[]>())).map((a) => a.entityId));
  const finalisedMonthly = first.type === 'FULL_FINAL' ? (await PayrollRun.find({ tenantId: f.tenantId, month: first.month, type: 'MONTHLY', state: 'FINALIZED' }).select('_id').lean<{ _id: string }[]>()).map((x) => x._id) : [];

  const rowDocs: PayrollRunEmployeeDoc[] = [];
  const lineDocs: Record<string, unknown>[] = [];
  const hashParts: string[] = [];
  const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
  for (const e of employees) {
    const prior = existing.get(e._id);
    const rowId = prior?._id ?? randomUUID();
    const label = labels.get(e._id)!;
    const refDate = e.exitDate && e.exitDate < range.end ? e.exitDate : range.end;
    const locationId = await locationOf(f, e._id, refDate < today ? refDate : today) ?? (await locationOf(f, e._id, today));
    const held = prior?.held ?? false;
    let out: EngineOutput | null = null;
    const exceptions: RunExceptionDTO[] = [];
    let comp: CompensationDoc | null = null;
    let advanceRecoveries: { advanceId: string; amountPaise: number }[] = [];
    let arrearIds: string[] = [];
    if (!held) {
      comp = await compensationOn(f, e._id, refDate);
      const input = await PayrollInput.findOne({ tenantId: f.tenantId, employeeId: e._id, month: first.month }).lean<PayrollInputDoc>();
      const decl = await declarationFor(f, e._id, first.month);
      const advances = first.type === 'MONTHLY' || first.type === 'FULL_FINAL' ? await Advance.find({ tenantId: f.tenantId, employeeId: e._id, state: 'PAID_OUT', remainingPaise: { $gt: 0 }, startMonth: { $lte: first.month } }).lean<AdvanceDoc[]>() : [];
      const arrears = first.type === 'MONTHLY' ? await arrearsFor(f, e._id, first.month) : [];
      const alreadyPaid = first.type === 'FULL_FINAL' && finalisedMonthly.length > 0 && Boolean(await PayrollRunEmployee.exists({ tenantId: f.tenantId, runId: { $in: finalisedMonthly }, employeeId: e._id, held: false }));
      const engineType: RunType = alreadyPaid ? 'SUPPLEMENTARY' : first.type;
      out = calculate({
        type: engineType, month: first.month, monthStart: range.start, monthEnd: range.end, daysInMonth: range.days, policy: { payDayBasis: policy.payDayBasis, rounding: policy.rounding }, employee: { joiningDate: e.joiningDate, exitDate: e.exitDate },
        lastPaidDay: first.type === 'FULL_FINAL' ? e.exitDate : null, compensation: comp ? { mode: comp.mode, basicPaise: comp.basicPaise } : null, components: await componentsFor(f, comp), input: input ? { workingDays: input.workingDays, paidLeaveDays: input.paidLeaveDays, lopDays: input.lopDays, unitsWorked: input.unitsWorked, extras: input.extras } : null,
        rules: { pf, esi, pt, pfRuleId: rules.pf?._id ?? null, esiRuleId: rules.esi?._id ?? null, ptRuleId: rules.pt?._id ?? null }, tdsMonthlyPaise: decl ? declarationDTO(decl, first.month).monthlyPaise : 0,
        advances: advances.map((a) => ({ advanceId: a._id, installmentPaise: a.installmentPaise, remainingPaise: a.remainingPaise })), recoverAllAdvances: first.type === 'FULL_FINAL', arrears: arrears.map((a) => ({ revisionId: a.revisionId, amountPaise: a.amountPaise, label: a.label })), oneOff: (prior?.oneOffLines ?? []).map((l) => ({ label: l.label, type: l.type, amountPaise: l.amountPaise })),
      });
      exceptions.push(...out.exceptions);
      advanceRecoveries = out.advanceRecoveries;
      arrearIds = arrears.map((a) => a.revisionId);
      if (pending.has(e._id)) exceptions.push({ code: 'PENDING_REVISION', level: 'BLOCKER', message: 'A salary change for this employee is waiting for approval.', fixHint: 'Ask an approver to decide it, then calculate again.' });
      const restricted = await findRestricted(f.tenantId, e.personId);
      if (!restricted?.bank) exceptions.push({ code: 'BANK_UNVERIFIED', level: 'REVIEW', message: 'This employee has no bank account on record, so the salary cannot go in a bank file.', fixHint: 'Add the bank details in the employee profile, or pay by cash or cheque with a reason.' });
      hashParts.push([e._id, comp?._id ?? '', comp?.basicPaise ?? '', input ? JSON.stringify([input.workingDays, input.lopDays, input.unitsWorked, input.extras]) : '', decl?.estimatedYearlyTaxPaise ?? '', advances.map((a) => a.remainingPaise).join('+'), (prior?.oneOffLines ?? []).map((l) => `${l.label}${l.amountPaise}`).join('+')].join('|'));
    }
    const blockers = exceptions.some((x) => x.level === 'BLOCKER');
    const status: PayrollRunEmployeeDoc['status'] = held ? 'HELD' : exceptions.length ? 'NEEDS_ACTION' : 'READY';
    rowDocs.push({
      _id: rowId, ...base, runId, employeeId: e._id, locationId, departmentId: label.departmentId, designationId: label.designationId, status, held, holdReason: prior?.holdReason ?? null, oneOffLines: prior?.oneOffLines ?? [], grossPaise: held ? 0 : out?.grossPaise ?? 0, deductionsPaise: held ? 0 : out?.deductionsPaise ?? 0, employerCostPaise: held ? 0 : out?.employerCostPaise ?? 0,
      netPaise: held ? 0 : out?.netPaise ?? 0, fullMonthGrossPaise: out?.fullMonthGrossPaise ?? 0, paidNum: out?.paidNum ?? 0, paidDen: out?.paidDen ?? 0, exceptions: exceptions.map((x) => ({ code: x.code, level: x.level, message: x.message, fixHint: x.fixHint })), compensationId: comp?._id ?? null, advanceRecoveries, arrearRevisionIds: arrearIds,
    } as PayrollRunEmployeeDoc);
    void blockers;
    (out?.lines ?? []).forEach((l, n) => lineDocs.push({ _id: randomUUID(), ...base, runId, runEmployeeId: rowId, employeeId: e._id, kind: l.kind, componentKey: l.componentKey, label: l.label, amountPaise: l.amountPaise, formula: l.formula, glAccountId: l.glAccountId, ruleVersionId: l.ruleVersionId, sortOrder: n }));
  }

  const totals = rowDocs.filter((r) => !r.held).reduce((t, r) => ({ grossPaise: t.grossPaise + r.grossPaise, deductionsPaise: t.deductionsPaise + r.deductionsPaise, employerCostPaise: t.employerCostPaise + r.employerCostPaise, netPaise: t.netPaise + r.netPaise }), { grossPaise: 0, deductionsPaise: 0, employerCostPaise: 0, netPaise: 0 });
  const counts = { employees: rowDocs.length, ready: rowDocs.filter((r) => r.status === 'READY').length, needAction: rowDocs.filter((r) => r.status === 'NEEDS_ACTION').length, held: rowDocs.filter((r) => r.held).length };
  const previous = first.type === 'MONTHLY' ? await PayrollRun.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, month: PREV_MONTH(first.month), type: 'MONTHLY', state: 'FINALIZED', locationId: first.locationId }).lean<PayrollRunDoc>() : null;
  const inputHash = createHash('sha256').update(hashParts.join('\n')).digest('hex');

  await withTransaction(async (db) => {
    const fresh = await PayrollRun.findOne({ _id: runId, tenantId: f.tenantId }).session(db).lean<PayrollRunDoc>();
    if (!fresh || !['DRAFT', 'CALCULATED'].includes(fresh.state)) throw new AppError('PAYROLL_STATE_INVALID', 'This run was just approved or finalised.');
    await PayrollRunLine.deleteMany({ tenantId: f.tenantId, runId }, { session: db });
    for (const r of rowDocs) await PayrollRunEmployee.replaceOne({ _id: r._id, tenantId: f.tenantId }, r, { upsert: true, session: db });
    if (lineDocs.length) await PayrollRunLine.insertMany(lineDocs, { session: db, ordered: true });
    await PayrollRun.updateOne({ _id: runId, tenantId: f.tenantId, state: { $in: ['DRAFT', 'CALCULATED'] } }, { $set: { state: 'CALCULATED', totals, counts, previousNetPaise: previous?.totals.netPaise ?? null, warnings: uniqueWarnings, ruleVersionIds: [rules.pf?._id, rules.esi?._id, rules.pt?._id].filter((x): x is string => !!x), inputHash }, $inc: { version: 1 } }, { session: db });
    await auditFinance(f, db, { action: 'payroll_run.calculated', entityType: 'payroll_run', entityId: runId, after: { employees: counts.employees, ready: counts.ready, needAction: counts.needAction } }); // totals are salary data and stay out of the audit
  });
  return runDTO(f, await loadRun(f, runId));
}

// ───────────────────────────────────────────────────────────── reads

export async function getRun(ctx: ServiceContext, runId: string): Promise<PayrollRunDTO> {
  const f = await financeCtx(ctx);
  return runDTO(f, await scopedRun(ctx, f, runId));
}

export async function listRuns(ctx: ServiceContext, query: { page: number; pageSize: number; month?: string | undefined; state?: string | undefined }) {
  const f = await financeCtx(ctx);
  const allowed = await employeesInScope(ctx, f, null);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.month ? { month: query.month } : {}), ...(query.state ? { state: { $in: query.state.split(',') } } : {}), ...(allowed ? { employeeIds: { $not: { $elemMatch: { $nin: allowed } } } } : {}) };
  const [rows, total] = await Promise.all([PayrollRun.find(filter).sort({ month: -1, createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<PayrollRunDoc[]>(), PayrollRun.countDocuments(filter)]);
  return { items: await Promise.all(rows.map((r) => runDTO(f, r))), total, page: query.page, pageSize: query.pageSize };
}

export async function listRunEmployees(ctx: ServiceContext, runId: string, query: { page: number; pageSize: number; status?: PayrollRunEmployeeDoc['status'] | undefined; q?: string | undefined }) {
  const f = await financeCtx(ctx);
  await scopedRun(ctx, f, runId);
  const all = await PayrollRunEmployee.find({ tenantId: f.tenantId, runId, ...(query.status ? { status: query.status } : {}) }).lean<PayrollRunEmployeeDoc[]>();
  const dtos = (await rowDTOs(f, all)).filter((r) => !query.q || r.employeeName.toLowerCase().includes(query.q.toLowerCase()) || r.employeeCode.toLowerCase().includes(query.q.toLowerCase())).sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
  return { items: dtos.slice((query.page - 1) * query.pageSize, query.page * query.pageSize), total: dtos.length, page: query.page, pageSize: query.pageSize };
}

export async function runLines(ctx: ServiceContext, runId: string, employeeId: string): Promise<RunLineDTO[]> {
  const f = await financeCtx(ctx);
  await scopedRun(ctx, f, runId);
  return (await PayrollRunLine.find({ tenantId: f.tenantId, runId, employeeId }).sort({ sortOrder: 1 }).lean<PayrollRunLineDoc[]>()).map(lineDTO);
}

export async function runExceptions(ctx: ServiceContext, runId: string): Promise<RunExceptionsDTO> {
  const f = await financeCtx(ctx);
  await scopedRun(ctx, f, runId);
  const rows = await PayrollRunEmployee.find({ tenantId: f.tenantId, runId, 'exceptions.0': { $exists: true } }).lean<PayrollRunEmployeeDoc[]>();
  const dtos = (await rowDTOs(f, rows)).sort((a, b) => a.employeeCode.localeCompare(b.employeeCode));
  return { runId, blockers: dtos.filter((d) => !d.held && d.exceptions.some((e) => e.level === 'BLOCKER')).length, items: dtos };
}

// ───────────────────────────────────────────────────────────── hold an employee out, add a one-off line

export async function patchRunEmployee(ctx: ServiceContext, runId: string, employeeId: string, data: { hold?: boolean | undefined; reason: string; addLine?: { label: string; type: 'EARNING' | 'DEDUCTION'; amountPaise: number } | undefined; removeLineLabel?: string | undefined }): Promise<PayrollRunDTO> {
  const f = await financeCtx(ctx);
  const run = await scopedRun(ctx, f, runId);
  if (!['DRAFT', 'CALCULATED'].includes(run.state)) throw new AppError('PAYROLL_STATE_INVALID', 'This run is already approved or finalised. Use a correction or supplementary run.');
  await withTransaction(async (db) => {
    const row = await PayrollRunEmployee.findOne({ tenantId: f.tenantId, runId, employeeId }).session(db).lean<PayrollRunEmployeeDoc>();
    if (!row) await PayrollRunEmployee.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, runId, employeeId }], { session: db }).then(() => PayrollRun.updateOne({ _id: runId, tenantId: f.tenantId }, { $addToSet: { employeeIds: employeeId } }, { session: db }));
    const set: Record<string, unknown> = {};
    if (data.hold !== undefined) Object.assign(set, { held: data.hold, holdReason: data.hold ? data.reason : null, status: data.hold ? 'HELD' : 'NEEDS_ACTION' });
    const lines = [...(row?.oneOffLines ?? [])].filter((l) => l.label !== data.removeLineLabel);
    if (data.addLine) lines.push({ ...data.addLine, reason: data.reason });
    if (data.addLine || data.removeLineLabel) set.oneOffLines = lines;
    await PayrollRunEmployee.updateOne({ tenantId: f.tenantId, runId, employeeId }, { $set: set }, { session: db });
    await auditFinance(f, db, { action: data.hold !== undefined ? (data.hold ? 'payroll_employee.held' : 'payroll_employee.released') : 'payroll_employee.line_changed', entityType: 'payroll_run', entityId: runId, after: { employeeId, reason: data.reason, line: data.addLine ? data.addLine.label : data.removeLineLabel ?? null } });
  });
  return calculateRun(ctx, runId);
}

export async function cancelRun(ctx: ServiceContext, runId: string): Promise<PayrollRunDTO> {
  const f = await financeCtx(ctx);
  await scopedRun(ctx, f, runId);
  const res = await PayrollRun.updateOne({ _id: runId, tenantId: f.tenantId, state: { $in: ['DRAFT', 'CALCULATED', 'APPROVED'] } }, { $set: { state: 'CANCELLED' }, $inc: { version: 1 } });
  if (res.modifiedCount !== 1) throw new AppError('PAYROLL_STATE_INVALID', 'Only a run that is not finalised can be cancelled.');
  await auditFinance(f, undefined, { action: 'payroll_run.cancelled', entityType: 'payroll_run', entityId: runId });
  return runDTO(f, await loadRun(f, runId));
}

// ───────────────────────────────────────────────────────────── approve and finalise

export async function approveRun(ctx: ServiceContext, runId: string): Promise<PayrollRunDTO> {
  const f = await financeCtx(ctx);
  const run = await scopedRun(ctx, f, runId);
  if (run.state !== 'CALCULATED') throw new AppError('PAYROLL_STATE_INVALID', run.state === 'DRAFT' ? 'Calculate the run first.' : 'This run cannot be approved in its current state.');
  const policy = await ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'PAYROLL_FINALIZE' }).lean<ApprovalPolicyDoc>();
  if (run.preparedBy === ctx.userId && (policy?.needsDifferentApprover ?? true)) throw new AppError('SELF_APPROVAL_BLOCKED', 'The person who prepared the payroll cannot approve it.');
  const blockers = await PayrollRunEmployee.countDocuments({ tenantId: f.tenantId, runId, held: false, 'exceptions.level': 'BLOCKER' });
  if (blockers > 0) throw new AppError('PAYROLL_BLOCKED', `${blockers} employee${blockers === 1 ? ' needs' : 's need'} attention first.`, { blockers });
  const res = await PayrollRun.updateOne({ _id: runId, tenantId: f.tenantId, state: 'CALCULATED', version: run.version }, { $set: { state: 'APPROVED', approvedBy: ctx.userId, approvedAt: new Date() }, $inc: { version: 1 } });
  if (res.modifiedCount !== 1) throw new AppError('VERSION_CONFLICT');
  await auditFinance(f, undefined, { action: 'payroll_run.approved', entityType: 'payroll_run', entityId: runId });
  return runDTO(f, await loadRun(f, runId));
}

/** One transaction: freeze the run, post the journal, write the payslips, take the instalments off the advances. Two finalisers at once: one wins. */
export async function finalizeRun(ctx: ServiceContext, runId: string, data: { version: number; acknowledgeDemoRules?: boolean | undefined }): Promise<PayrollRunDTO> {
  const f = await financeCtx(ctx);
  const run = await scopedRun(ctx, f, runId);
  const policy = await ensurePayrollSetup(f);
  const needState = policy.approvalRequired ? 'APPROVED' : run.state === 'CALCULATED' ? 'CALCULATED' : 'APPROVED';
  if (run.state === 'FINALIZED') throw new AppError('VERSION_CONFLICT', 'This run was already finalised.');
  if (run.state !== needState) throw new AppError('PAYROLL_STATE_INVALID', run.state === 'CALCULATED' ? 'A second person must approve the run first.' : 'This run is not ready to be finalised.');
  if (run.warnings.length > 0 && !data.acknowledgeDemoRules) throw new AppError('STATUTORY_RULE_UNAPPROVED', run.warnings[0], { warnings: run.warnings });
  const range = monthRange(run.month);
  const today = await todayFor(ctx);
  // A month's pay is booked on its last day; if the run is finalised before then, on today, so it never lands in a future date.
  const accountingDate = run.type === 'MONTHLY' && today > range.end ? range.end : today;
  await withTransaction(async (db) => {
    const res = await PayrollRun.updateOne({ _id: runId, tenantId: f.tenantId, state: needState, version: data.version }, { $set: { state: 'FINALIZED', finalizedBy: ctx.userId, finalizedAt: new Date(), approvedBy: run.approvedBy ?? ctx.userId, approvedAt: run.approvedAt ?? new Date() }, $inc: { version: 1 } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('VERSION_CONFLICT', 'Someone else just finalised or changed this run.');
    const rows = await PayrollRunEmployee.find({ tenantId: f.tenantId, runId, held: false }).session(db).lean<PayrollRunEmployeeDoc[]>();
    if (rows.some((r) => r.exceptions.some((e) => e.level === 'BLOCKER'))) throw new AppError('PAYROLL_BLOCKED', 'Some employees still need attention.');
    const lines = await PayrollRunLine.find({ tenantId: f.tenantId, runId }).session(db).lean<PayrollRunLineDoc[]>();
    const roles = await rolesMap(f, db);
    const need = (role: string) => {
      const a = roles.get(role);
      if (!a) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing a payroll account. Use the standard chart in Finance Settings.', { role });
      return a._id;
    };
    const journal: PostLine[] = [];
    const slips: Record<string, unknown>[] = [];
    const labels = await employeeLabels(f, rows.map((r) => r.employeeId));
    const school = f.entity.name;
    const fy = fyCodeFor(`${run.month}-01`, f.entity.fyStartMonth);
    const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
    const ROLE_OF: Record<string, string> = { PF: 'PF_PAYABLE', EMP_PF: 'PF_PAYABLE', ESI: 'ESI_PAYABLE', EMP_ESI: 'ESI_PAYABLE', PT: 'PT_PAYABLE', TDS: 'TDS_PAYABLE' };
    for (const r of rows) {
      const mine = lines.filter((l) => l.runEmployeeId === r._id).sort((a, b) => a.sortOrder - b.sortOrder);
      const at = { employeeId: r.employeeId, locationId: r.locationId };
      for (const l of mine) {
        if (l.kind === 'EARNING' || l.kind === 'ARREAR') journal.push({ accountId: l.glAccountId ?? need('SALARY_EXPENSE'), debitPaise: l.amountPaise, ...at });
        else if (l.kind === 'EMPLOYER_COST') journal.push({ accountId: need('EMPLOYER_CONTRIBUTION_EXPENSE'), debitPaise: l.amountPaise, ...at }, { accountId: need(ROLE_OF[l.componentKey]!), creditPaise: l.amountPaise, ...at });
        else if (l.kind === 'RECOVERY') journal.push({ accountId: need('EMPLOYEE_ADVANCE'), creditPaise: l.amountPaise, ...at });
        else if (l.kind === 'DEDUCTION') journal.push({ accountId: ROLE_OF[l.componentKey] ? need(ROLE_OF[l.componentKey]!) : l.glAccountId ?? need('SALARY_PAYABLE'), creditPaise: l.amountPaise, ...at });
      }
      if (r.netPaise > 0) journal.push({ accountId: need('SALARY_PAYABLE'), creditPaise: r.netPaise, ...at });
      else if (r.netPaise < 0) throw new AppError('PAYROLL_BLOCKED', 'A negative net pay cannot be finalised.');
      const number = await nextNumber(f, db, 'PSL', fy);
      const l = labels.get(r.employeeId);
      slips.push({
        _id: randomUUID(), ...base, number, runId, runEmployeeId: r._id, employeeId: r.employeeId, month: run.month,
        snapshot: { school, employeeName: l?.name ?? 'Employee', employeeCode: l?.code ?? '', department: l?.departmentName ?? null, designation: l?.designationName ?? null, grossPaise: r.grossPaise, deductionsPaise: r.deductionsPaise, employerCostPaise: r.employerCostPaise, netPaise: r.netPaise, paidDays: r.paidDen ? `${r.paidNum}/${r.paidDen}` : null, lines: mine.filter((x) => x.kind !== 'EMPLOYER_COST').map((x) => ({ kind: x.kind, label: x.label, amountPaise: x.amountPaise, formula: x.formula })) },
      });
      for (const rec of r.advanceRecoveries) {
        const adv = await Advance.updateOne({ _id: rec.advanceId, tenantId: f.tenantId, remainingPaise: { $gte: rec.amountPaise } }, { $inc: { remainingPaise: -rec.amountPaise } }, { session: db });
        if (adv.modifiedCount !== 1) throw new AppError('VERSION_CONFLICT', 'An advance changed while the run was being finalised.');
        await Advance.updateOne({ _id: rec.advanceId, tenantId: f.tenantId, remainingPaise: 0 }, { $set: { state: 'CLOSED' } }, { session: db });
      }
      for (const revisionId of r.arrearRevisionIds) await SalaryRevision.updateOne({ _id: revisionId, tenantId: f.tenantId, arrearsRunId: null }, { $set: { arrearsRunId: runId } }, { session: db });
    }
    const { journal: posted } = await postJournal(f, db, { eventType: run.type === 'MONTHLY' || run.type === 'FULL_FINAL' ? 'payroll.finalized' : 'payroll.correction', sourceKey: `payroll:${runId}`, accountingDate, lines: mergeLines(journal), memo: `Payroll ${run.number} for ${monthName(run.month)}`, sourceType: 'payroll_run', sourceId: runId });
    await Payslip.create(slips as never[], { session: db, ordered: true });
    await PayrollRun.updateOne({ _id: runId, tenantId: f.tenantId }, { $set: { journalId: posted._id } }, { session: db });
    await auditFinance(f, db, { action: 'payroll_run.finalized', entityType: 'payroll_run', entityId: runId, after: { employees: rows.length, journalNumber: posted.number } });
    await emitFinance(f, db, 'payroll.finalized', { runId, month: run.month, employees: rows.length });
  });
  return runDTO(f, await loadRun(f, runId));
}

// ───────────────────────────────────────────────────────────── payslips (PAY-10)

export async function publishPayslips(ctx: ServiceContext, runId: string): Promise<{ published: number }> {
  const f = await financeCtx(ctx);
  const run = await scopedRun(ctx, f, runId);
  if (run.state !== 'FINALIZED') throw new AppError('PAYROLL_STATE_INVALID', 'Payslips exist only after the run is finalised.');
  const count = await Payslip.countDocuments({ tenantId: f.tenantId, runId });
  if (!(await PayslipPublication.exists({ tenantId: f.tenantId, runId }))) await PayslipPublication.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, runId, publishedBy: ctx.userId }]).catch((err) => { if (!duplicateKeyFields(err)) throw err; });
  await auditFinance(f, undefined, { action: 'payslips.published', entityType: 'payroll_run', entityId: runId, after: { payslips: count } });
  return { published: count };
}

export async function payslipDTOs(f: FinanceCtx, rows: PayslipDoc[]): Promise<PayslipDTO[]> {
  const published = new Set((await PayslipPublication.find({ tenantId: f.tenantId, runId: { $in: rows.map((r) => r.runId) } }).select('runId').lean<{ runId: string }[]>()).map((p) => p.runId));
  return rows.map((p) => ({
    payslipId: p._id, number: p.number, runId: p.runId, month: p.month, employeeId: p.employeeId, employeeName: p.snapshot.employeeName, published: published.has(p.runId), grossPaise: p.snapshot.grossPaise, deductionsPaise: p.snapshot.deductionsPaise, netPaise: p.snapshot.netPaise,
    paidDays: p.snapshot.paidDays, lines: p.snapshot.lines, school: p.snapshot.school, department: p.snapshot.department, designation: p.snapshot.designation,
  }));
}

export async function listPayslips(ctx: ServiceContext, query: { employeeId?: string | undefined; month?: string | undefined }): Promise<PayslipDTO[]> {
  const f = await financeCtx(ctx);
  if (query.employeeId) await scopedEmployee(ctx, f, query.employeeId);
  const allowed = await employeesInScope(ctx, f, null);
  const rows = await Payslip.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.employeeId ? { employeeId: query.employeeId } : {}), ...(query.month ? { month: query.month } : {}), ...(allowed ? { employeeId: { $in: allowed } } : {}) }).sort({ month: -1 }).limit(300).lean<PayslipDoc[]>();
  await auditFinance(f, undefined, { action: 'payslips.read', entityType: 'payslip', entityId: query.employeeId ?? 'many', after: { count: rows.length } });
  return payslipDTOs(f, rows);
}

export function payslipPdf(p: PayslipDoc): Buffer {
  const s = p.snapshot;
  return simplePdf([
    s.school, '', `PAYSLIP ${p.number}`, `Month: ${monthName(p.month)}`, `Employee: ${s.employeeName} (${s.employeeCode})`, `${s.designation ?? ''}${s.department ? `, ${s.department}` : ''}`, ...(s.paidDays ? [`Paid days: ${s.paidDays}`] : []), '',
    ...s.lines.map((l) => `${l.label}: ${l.kind === 'DEDUCTION' || l.kind === 'RECOVERY' ? '-' : ''}${formatMoney(l.amountPaise)}   ${l.formula}`), '', `Gross: ${formatMoney(s.grossPaise)}`, `Deductions: ${formatMoney(s.deductionsPaise)}`, `Net pay: ${formatMoney(s.netPaise)}`,
  ]);
}

export async function payslipPdfFor(ctx: ServiceContext, payslipId: string): Promise<{ buffer: Buffer; fileName: string }> {
  const f = await financeCtx(ctx);
  const p = await Payslip.findOne({ _id: payslipId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<PayslipDoc>();
  if (!p) throw AppError.notFound('Payslip not found.');
  await scopedEmployee(ctx, f, p.employeeId);
  await auditFinance(f, undefined, { action: 'payslip.downloaded', entityType: 'payslip', entityId: p._id });
  return { buffer: payslipPdf(p), fileName: `payslip-${p.number.replace(/\//g, '-')}.pdf` };
}

export { addDays };
