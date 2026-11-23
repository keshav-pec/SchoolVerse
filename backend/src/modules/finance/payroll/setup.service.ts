import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type {
  AdvanceDTO, CompensationDTO, PayrollInputDTO, PayrollPolicyDTO, SalaryComponentDTO, SalaryRevisionDTO, SalaryStructureDTO, StatutoryKind, StatutoryRuleDTO, StructureItemDTO, StructureVersionDTO, TaxDeclarationDTO,
} from '@shared';
import { AppError } from '../../../core/errors';
import { addDays } from '../../../core/dates';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { parseCsv } from '../../../platform/identity/csv';
import { can, type ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { LocationAssignment } from '../../staff/assignment.models';
import { Employee, type EmployeeDoc } from '../../staff/employee.model';
import { Department, Designation } from '../../staff/master.model';
import { Person } from '../../staff/person.model';
import { findCallerEmployee } from '../../staff/access';
import { todayFor } from '../../staff/status';
import { checkApproval, consumeApproval } from '../core/approvals.service';
import { rolesMap } from '../core/chart.service';
import { assertInScope, auditFinance, emitFinance, financeCtx, financeScope, fyCodeFor, monthRange, type FinanceCtx } from '../core/context';
import { ChartAccount, BankAccount, type BankAccountDoc } from '../core/models';
import { formatMoney, percentOf, roundHalfUp, toPaise } from '../core/money';
import { postJournal } from '../core/posting';
import { monthsLeftInFy } from './engine';
import {
  Advance, Compensation, PayrollInput, PayrollPolicy, SalaryComponent, SalaryRevision, SalaryStructure, SalaryStructureVersion, StatutoryRule, TaxDeclaration,
  type AdvanceDoc, type CompensationDoc, type PayrollInputDoc, type PayrollPolicyDoc, type SalaryComponentDoc, type SalaryRevisionDoc, type SalaryStructureDoc, type SalaryStructureVersionDoc, type StatutoryRuleDoc, type TaxDeclarationDoc,
} from './models';

/** Payroll setup (PAY-01 to 06): the policy, salary components and structures, who earns what, monthly inputs, statutory rules, advances. */

export const DEMO_RULE_NOTE = 'Demo values. Your accountant must replace these with the real rates before real use.';

const SYSTEM_COMPONENTS = [
  { code: 'BASIC', name: 'Basic', type: 'EARNING' as const, calc: 'FIXED' as const, pfWage: true, esiWage: true, prorate: true },
  { code: 'HRA', name: 'House Rent Allowance', type: 'EARNING' as const, calc: 'PERCENT_OF_BASIC' as const, pfWage: false, esiWage: true, prorate: true },
  { code: 'ALLOWANCE', name: 'Allowance', type: 'EARNING' as const, calc: 'FIXED' as const, pfWage: false, esiWage: true, prorate: true },
];

const DEMO_RULES: { kind: StatutoryKind; params: Record<string, unknown> }[] = [
  { kind: 'PF', params: { employeeBps: 1200, employerBps: 1200, wageCeilingPaise: 1_500_000 } },
  { kind: 'ESI', params: { employeeBps: 75, employerBps: 325, grossLimitPaise: 2_100_000 } },
  { kind: 'PT', params: { slabs: [{ fromPaise: 0, toPaise: 1_500_000, amountPaise: 0 }, { fromPaise: 1_500_001, toPaise: 2_500_000, amountPaise: 15_000 }, { fromPaise: 2_500_001, toPaise: null, amountPaise: 20_000 }] } },
];

/** The policy, the standard components and the demo rule packs. Safe to call every time. */
export async function ensurePayrollSetup(f: FinanceCtx, db?: ClientSession): Promise<PayrollPolicyDoc> {
  const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
  let policy = await PayrollPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<PayrollPolicyDoc>();
  if (policy) return policy;
  try {
    const [created] = await PayrollPolicy.create([{ ...base, createdBy: f.userId }], { session: db });
    policy = created!.toObject() as PayrollPolicyDoc;
    for (const c of SYSTEM_COMPONENTS) await SalaryComponent.updateOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, code: c.code }, { $setOnInsert: { ...base, ...c, isSystem: true, glAccountId: null, createdBy: f.userId } }, { upsert: true, session: db });
    for (const r of DEMO_RULES) await StatutoryRule.updateOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, kind: r.kind, effectiveFrom: '2000-01-01' }, { $setOnInsert: { ...base, params: r.params, state: 'DRAFT', demo: true, note: DEMO_RULE_NOTE } }, { upsert: true, session: db });
  } catch (err) {
    if (!duplicateKeyFields(err)) throw err;
    policy = await PayrollPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<PayrollPolicyDoc>();
  }
  return policy!;
}

const policyDTO = (p: PayrollPolicyDoc): PayrollPolicyDTO => ({ payDayBasis: p.payDayBasis, rounding: p.rounding, approvalRequired: p.approvalRequired, defaultBankAccountId: p.defaultBankAccountId, note: 'The pay-day basis decides how a part month is worked out: all calendar days, a fixed 30, or the working days you enter.' });

export async function getPolicy(ctx: ServiceContext): Promise<PayrollPolicyDTO> {
  const f = await financeCtx(ctx);
  return policyDTO(await ensurePayrollSetup(f));
}

export async function updatePolicy(ctx: ServiceContext, data: { payDayBasis?: PayrollPolicyDoc['payDayBasis'] | undefined; rounding?: PayrollPolicyDoc['rounding'] | undefined; approvalRequired?: boolean | undefined; defaultBankAccountId?: string | null | undefined }): Promise<PayrollPolicyDTO> {
  const f = await financeCtx(ctx);
  const before = await ensurePayrollSetup(f);
  if (data.defaultBankAccountId && !(await BankAccount.exists({ _id: data.defaultBankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }))) throw AppError.notFound('Bank account not found.');
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await withTransaction(async (db) => {
    await PayrollPolicy.updateOne({ _id: before._id, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'payroll_policy.updated', entityType: 'payroll_policy', entityId: before._id, before: { payDayBasis: before.payDayBasis, rounding: before.rounding }, after: patch });
  });
  return policyDTO((await PayrollPolicy.findOne({ _id: before._id, tenantId: f.tenantId }).lean<PayrollPolicyDoc>())!);
}

// ───────────────────────────────────────────────────────────── names

export interface EmployeeLabel {
  employeeId: string;
  name: string;
  code: string;
  departmentId: string;
  designationId: string;
  departmentName: string | null;
  designationName: string | null;
  joiningDate: string;
  exitDate: string | null;
  personId: string;
}

export async function employeeLabels(f: Pick<FinanceCtx, 'tenantId'>, ids: string[]): Promise<Map<string, EmployeeLabel>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const employees = await Employee.find({ tenantId: f.tenantId, _id: { $in: unique } }).lean<EmployeeDoc[]>();
  const [people, depts, desigs] = await Promise.all([
    Person.find({ tenantId: f.tenantId, _id: { $in: employees.map((e) => e.personId) } }).select('legalFirstName legalLastName preferredName').lean<{ _id: string; legalFirstName: string; legalLastName: string; preferredName: string | null }[]>(),
    Department.find({ tenantId: f.tenantId, _id: { $in: employees.map((e) => e.departmentId) } }).select('name').lean<{ _id: string; name: string }[]>(),
    Designation.find({ tenantId: f.tenantId, _id: { $in: employees.map((e) => e.designationId) } }).select('name').lean<{ _id: string; name: string }[]>(),
  ]);
  const person = new Map(people.map((p) => [p._id, p]));
  const dept = new Map(depts.map((d) => [d._id, d.name]));
  const desig = new Map(desigs.map((d) => [d._id, d.name]));
  return new Map(
    employees.map((e) => {
      const p = person.get(e.personId);
      return [e._id, { employeeId: e._id, name: p ? p.preferredName || `${p.legalFirstName} ${p.legalLastName}`.trim() : 'Employee', code: e.employeeCode, departmentId: e.departmentId, designationId: e.designationId, departmentName: dept.get(e.departmentId) ?? null, designationName: desig.get(e.designationId) ?? null, joiningDate: e.joiningDate, exitDate: e.exitDate, personId: e.personId }];
    }),
  );
}

/** An employee of this school, within the caller's campus scope. Another school's id is a 404. */
export async function scopedEmployee(ctx: ServiceContext, f: FinanceCtx, employeeId: string): Promise<EmployeeDoc> {
  const e = await Employee.findOne({ _id: employeeId, tenantId: f.tenantId }).lean<EmployeeDoc>();
  if (!e) throw AppError.notFound('Employee not found.');
  const scope = await financeScope(ctx);
  if (!scope.all) {
    const ids = await payrollEmployeeIds(f, scope.locationIds);
    if (!ids.includes(e._id)) throw AppError.notFound('Employee not found.');
  }
  return e;
}

/** Everyone who has ever worked at these campuses. A leaver is still the payroll officer's business: their last pay, arrears and settlement come after they go. */
async function payrollEmployeeIds(f: Pick<FinanceCtx, 'tenantId'>, locationIds: string[]): Promise<string[]> {
  if (locationIds.length === 0) return [];
  return (await LocationAssignment.distinct('employeeId', { tenantId: f.tenantId, locationId: { $in: locationIds }, cancelledAt: null })) as string[];
}

export async function employeesInScope(ctx: ServiceContext, f: FinanceCtx, locationId?: string | null): Promise<string[] | null> {
  const scope = await financeScope(ctx);
  if (locationId) await assertInScope(ctx, scope, locationId, 'payroll', locationId);
  if (scope.all && !locationId) return null;
  return payrollEmployeeIds(f, locationId ? [locationId] : scope.locationIds);
}

// ───────────────────────────────────────────────────────────── components and structures (PAY-02)

const componentDTO = (c: SalaryComponentDoc): SalaryComponentDTO => ({ componentId: c._id, code: c.code, name: c.name, type: c.type, calc: c.calc, pfWage: c.pfWage, esiWage: c.esiWage, prorate: c.prorate, glAccountId: c.glAccountId, isSystem: c.isSystem, status: c.status });

export async function listComponents(ctx: ServiceContext): Promise<SalaryComponentDTO[]> {
  const f = await financeCtx(ctx);
  await ensurePayrollSetup(f);
  return (await SalaryComponent.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ isSystem: -1, createdAt: 1 }).lean<SalaryComponentDoc[]>()).map(componentDTO);
}

async function checkGl(f: FinanceCtx, glAccountId: string | null | undefined) {
  if (!glAccountId) return;
  if (!(await ChartAccount.exists({ _id: glAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, isPostable: true, status: 'ACTIVE' }))) throw AppError.validation({ glAccountId: 'Choose an active detail account.' });
}

export async function createComponent(ctx: ServiceContext, data: { code: string; name: string; type: SalaryComponentDoc['type']; calc: SalaryComponentDoc['calc']; pfWage: boolean; esiWage: boolean; prorate: boolean; glAccountId?: string | null | undefined }): Promise<SalaryComponentDTO> {
  const f = await financeCtx(ctx);
  await ensurePayrollSetup(f);
  await checkGl(f, data.glAccountId);
  if (data.type !== 'EARNING' && (data.pfWage || data.esiWage)) throw AppError.validation({ pfWage: 'Only an earning can count towards PF or ESI.' });
  if (data.type === 'DEDUCTION' && !data.glAccountId) throw AppError.validation({ glAccountId: 'Choose the account this deduction is held in until it is paid out.' });
  try {
    const row = await withTransaction(async (db) => {
      const [c] = await SalaryComponent.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, ...data, glAccountId: data.glAccountId ?? null, createdBy: ctx.userId }], { session: db });
      await auditFinance(f, db, { action: 'salary_component.created', entityType: 'salary_component', entityId: c!._id, after: { code: data.code, type: data.type } });
      return c!.toObject() as SalaryComponentDoc;
    });
    return componentDTO(row);
  } catch (err) {
    if (duplicateKeyFields(err)) throw new AppError('FINANCE_CODE_TAKEN');
    throw err;
  }
}

export async function updateComponent(ctx: ServiceContext, id: string, data: { name?: string | undefined; pfWage?: boolean | undefined; esiWage?: boolean | undefined; prorate?: boolean | undefined; glAccountId?: string | null | undefined; status?: 'ACTIVE' | 'INACTIVE' | undefined }): Promise<SalaryComponentDTO> {
  const f = await financeCtx(ctx);
  const before = await SalaryComponent.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<SalaryComponentDoc>();
  if (!before) throw AppError.notFound('Salary component not found.');
  if (before.isSystem && data.status === 'INACTIVE') throw new AppError('FINANCE_RECORD_LOCKED', 'A standard component cannot be switched off.');
  await checkGl(f, data.glAccountId);
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await withTransaction(async (db) => {
    await SalaryComponent.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'salary_component.updated', entityType: 'salary_component', entityId: id, after: patch });
  });
  return componentDTO((await SalaryComponent.findOne({ _id: id, tenantId: f.tenantId }).lean<SalaryComponentDoc>())!);
}

async function itemDTOs(f: FinanceCtx, items: SalaryStructureVersionDoc['items']): Promise<StructureItemDTO[]> {
  const comps = new Map((await SalaryComponent.find({ tenantId: f.tenantId, _id: { $in: items.map((i) => i.componentId) } }).lean<SalaryComponentDoc[]>()).map((c) => [c._id, c]));
  return items.map((i) => ({ componentId: i.componentId, componentName: comps.get(i.componentId)?.name ?? 'Component', type: comps.get(i.componentId)?.type ?? 'EARNING', calc: comps.get(i.componentId)?.calc ?? 'FIXED', amountPaise: i.amountPaise, rateBps: i.rateBps }));
}

async function versionDTO(f: FinanceCtx, v: SalaryStructureVersionDoc): Promise<StructureVersionDTO> {
  const approver = v.approvedBy ? await User.findOne({ _id: v.approvedBy, tenantId: f.tenantId }).select('fullName').lean<{ fullName: string }>() : null;
  return { versionId: v._id, structureId: v.structureId, versionNo: v.versionNo, effectiveFrom: v.effectiveFrom, state: v.state, items: await itemDTOs(f, v.items), approvedByName: approver?.fullName ?? null };
}

async function structureDTOs(f: FinanceCtx, rows: SalaryStructureDoc[]): Promise<SalaryStructureDTO[]> {
  const versions = await SalaryStructureVersion.find({ tenantId: f.tenantId, structureId: { $in: rows.map((r) => r._id) } }).sort({ versionNo: 1 }).lean<SalaryStructureVersionDoc[]>();
  return Promise.all(rows.map(async (s) => {
    const mine = versions.filter((v) => v.structureId === s._id);
    const latest = mine.at(-1) ?? null;
    return { structureId: s._id, name: s.name, status: s.status, latestVersion: latest ? await versionDTO(f, latest) : null, versions: mine.map((v) => ({ versionId: v._id, versionNo: v.versionNo, state: v.state, effectiveFrom: v.effectiveFrom })) };
  }));
}

async function checkItems(f: FinanceCtx, items: { componentId: string; amountPaise?: number | undefined; rateBps?: number | undefined }[]): Promise<SalaryStructureVersionDoc['items']> {
  const comps = new Map((await SalaryComponent.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: items.map((i) => i.componentId) } }).lean<SalaryComponentDoc[]>()).map((c) => [c._id, c]));
  if (new Set(items.map((i) => i.componentId)).size !== items.length) throw AppError.validation({ items: 'Each component can be listed once.' });
  return items.map((i, n) => {
    const c = comps.get(i.componentId);
    if (!c || c.status !== 'ACTIVE') throw AppError.validation({ [`items.${n}.componentId`]: 'This component was not found.' });
    if (c.type === 'EMPLOYER_COST') throw AppError.validation({ [`items.${n}.componentId`]: 'Employer contributions come from the PF and ESI rules, not from the structure.' });
    if (c.code === 'BASIC') return { componentId: c._id, amountPaise: null, rateBps: null };
    if (c.calc === 'FIXED' ? i.amountPaise === undefined : i.rateBps === undefined) throw AppError.validation({ [`items.${n}`]: c.calc === 'FIXED' ? `Enter an amount for ${c.name}.` : `Enter a percentage for ${c.name}.` });
    return { componentId: c._id, amountPaise: c.calc === 'FIXED' ? i.amountPaise ?? 0 : null, rateBps: c.calc === 'FIXED' ? null : i.rateBps ?? 0 };
  });
}

export async function listStructures(ctx: ServiceContext): Promise<SalaryStructureDTO[]> {
  const f = await financeCtx(ctx);
  return structureDTOs(f, await SalaryStructure.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ name: 1 }).lean<SalaryStructureDoc[]>());
}

export async function createStructure(ctx: ServiceContext, data: { name: string; effectiveFrom: string; items: { componentId: string; amountPaise?: number | undefined; rateBps?: number | undefined }[] }): Promise<SalaryStructureDTO> {
  const f = await financeCtx(ctx);
  await ensurePayrollSetup(f);
  const items = await checkItems(f, data.items);
  try {
    const row = await withTransaction(async (db) => {
      const [s] = await SalaryStructure.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, name: data.name, createdBy: ctx.userId }], { session: db });
      await SalaryStructureVersion.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, structureId: s!._id, versionNo: 1, effectiveFrom: data.effectiveFrom, items }], { session: db });
      await auditFinance(f, db, { action: 'salary_structure.created', entityType: 'salary_structure', entityId: s!._id, after: { name: data.name } });
      return s!.toObject() as SalaryStructureDoc;
    });
    return (await structureDTOs(f, [row]))[0]!;
  } catch (err) {
    if (duplicateKeyFields(err)) throw new AppError('FINANCE_CODE_TAKEN', 'A structure with this name already exists.');
    throw err;
  }
}

export async function createStructureVersion(ctx: ServiceContext, structureId: string, data: { effectiveFrom: string; items: { componentId: string; amountPaise?: number | undefined; rateBps?: number | undefined }[] }): Promise<SalaryStructureDTO> {
  const f = await financeCtx(ctx);
  const s = await SalaryStructure.findOne({ _id: structureId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<SalaryStructureDoc>();
  if (!s) throw AppError.notFound('Salary structure not found.');
  const items = await checkItems(f, data.items);
  const last = await SalaryStructureVersion.findOne({ tenantId: f.tenantId, structureId }).sort({ versionNo: -1 }).lean<SalaryStructureVersionDoc>();
  if (last && last.state === 'DRAFT') throw new AppError('CONFLICT', 'Approve or edit the draft version first.');
  await withTransaction(async (db) => {
    await SalaryStructureVersion.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, structureId, versionNo: (last?.versionNo ?? 0) + 1, effectiveFrom: data.effectiveFrom, items }], { session: db });
    await auditFinance(f, db, { action: 'salary_structure.version_created', entityType: 'salary_structure', entityId: structureId, after: { versionNo: (last?.versionNo ?? 0) + 1 } });
  });
  return (await structureDTOs(f, [s]))[0]!;
}

export async function updateStructureVersion(ctx: ServiceContext, versionId: string, data: { items: { componentId: string; amountPaise?: number | undefined; rateBps?: number | undefined }[] }): Promise<StructureVersionDTO> {
  const f = await financeCtx(ctx);
  const v = await SalaryStructureVersion.findOne({ _id: versionId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<SalaryStructureVersionDoc>();
  if (!v) throw AppError.notFound('Version not found.');
  if (v.state !== 'DRAFT') throw new AppError('PLAN_VERSION_FROZEN', 'An approved salary structure cannot be changed. Make a new version instead.');
  const items = await checkItems(f, data.items);
  await SalaryStructureVersion.updateOne({ _id: versionId, tenantId: f.tenantId, state: 'DRAFT' }, { $set: { items } });
  return versionDTO(f, (await SalaryStructureVersion.findOne({ _id: versionId, tenantId: f.tenantId }).lean<SalaryStructureVersionDoc>())!);
}

export async function approveStructureVersion(ctx: ServiceContext, versionId: string): Promise<StructureVersionDTO> {
  const f = await financeCtx(ctx);
  const v = await SalaryStructureVersion.findOne({ _id: versionId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<SalaryStructureVersionDoc>();
  if (!v) throw AppError.notFound('Version not found.');
  const res = await SalaryStructureVersion.updateOne({ _id: versionId, tenantId: f.tenantId, state: 'DRAFT' }, { $set: { state: 'APPROVED', approvedBy: ctx.userId, approvedAt: new Date() } });
  if (res.modifiedCount !== 1) throw new AppError('PLAN_VERSION_FROZEN', 'This version is already approved.');
  await auditFinance(f, undefined, { action: 'salary_structure.approved', entityType: 'salary_structure_version', entityId: versionId });
  return versionDTO(f, (await SalaryStructureVersion.findOne({ _id: versionId, tenantId: f.tenantId }).lean<SalaryStructureVersionDoc>())!);
}

// ───────────────────────────────────────────────────────────── employee salary and revisions (PAY-03)

/** What the structure pays in a full month, for a preview. */
export async function monthlyGrossOf(f: FinanceCtx, comp: Pick<CompensationDoc, 'structureVersionId' | 'basicPaise' | 'overrides' | 'mode'>): Promise<number> {
  if (comp.mode !== 'MONTHLY') return comp.basicPaise;
  const v = await SalaryStructureVersion.findOne({ _id: comp.structureVersionId, tenantId: f.tenantId }).lean<SalaryStructureVersionDoc>();
  const comps = new Map((await SalaryComponent.find({ tenantId: f.tenantId, _id: { $in: v?.items.map((i) => i.componentId) ?? [] } }).lean<SalaryComponentDoc[]>()).map((c) => [c._id, c]));
  const over = new Map(comp.overrides.map((o) => [o.componentId, o.amountPaise]));
  let total = 0;
  for (const i of v?.items ?? []) {
    const c = comps.get(i.componentId);
    if (!c || c.type !== 'EARNING') continue;
    total += c.code === 'BASIC' ? comp.basicPaise : over.get(c._id) ?? (i.amountPaise ?? percentOf(comp.basicPaise, i.rateBps ?? 0));
  }
  return total;
}

async function compensationDTOs(f: FinanceCtx, rows: CompensationDoc[]): Promise<CompensationDTO[]> {
  const [labels, versions] = await Promise.all([employeeLabels(f, rows.map((r) => r.employeeId)), SalaryStructureVersion.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.structureVersionId) } }).lean<SalaryStructureVersionDoc[]>()]);
  const structures = new Map((await SalaryStructure.find({ tenantId: f.tenantId, _id: { $in: versions.map((v) => v.structureId) } }).select('name').lean<{ _id: string; name: string }[]>()).map((s) => [s._id, s.name]));
  const verMap = new Map(versions.map((v) => [v._id, v]));
  return Promise.all(rows.map(async (c) => ({
    assignmentId: c._id, employeeId: c.employeeId, employeeName: labels.get(c.employeeId)?.name ?? 'Employee', employeeCode: labels.get(c.employeeId)?.code ?? '', structureVersionId: c.structureVersionId,
    structureName: structures.get(verMap.get(c.structureVersionId)?.structureId ?? '') ?? '', mode: c.mode, basicPaise: c.basicPaise, overrides: c.overrides, effectiveFrom: c.effectiveFrom, effectiveTo: c.effectiveTo, monthlyGrossPaise: await monthlyGrossOf(f, c),
  })));
}

export async function listCompensations(ctx: ServiceContext, query: { employeeId?: string | undefined; locationId?: string | undefined }): Promise<CompensationDTO[]> {
  const f = await financeCtx(ctx);
  const ids = await employeesInScope(ctx, f, query.locationId);
  const rows = await Compensation.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, state: 'OPEN', ...(query.employeeId ? { employeeId: query.employeeId } : {}), ...(ids ? { employeeId: { $in: ids } } : {}) }).sort({ effectiveFrom: -1 }).limit(500).lean<CompensationDoc[]>();
  return compensationDTOs(f, rows);
}

/** The salary that applies to an employee on a date: the latest that started on or before it and had not ended. */
export async function compensationOn(f: FinanceCtx, employeeId: string, date: string, db?: ClientSession): Promise<CompensationDoc | null> {
  return Compensation.findOne({ tenantId: f.tenantId, employeeId, effectiveFrom: { $lte: date }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }] }).sort({ effectiveFrom: -1 }).session(db ?? null).lean<CompensationDoc>();
}

export async function assignCompensation(ctx: ServiceContext, data: { employeeId: string; structureVersionId: string; mode: CompensationDoc['mode']; basicPaise: number; overrides: { componentId: string; amountPaise: number }[]; effectiveFrom: string }): Promise<CompensationDTO> {
  const f = await financeCtx(ctx);
  const emp = await scopedEmployee(ctx, f, data.employeeId);
  const version = await SalaryStructureVersion.findOne({ _id: data.structureVersionId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<SalaryStructureVersionDoc>();
  if (!version) throw AppError.notFound('Salary structure not found.');
  if (version.state !== 'APPROVED') throw new AppError('PAYROLL_STATE_INVALID', 'Approve this salary structure version before assigning it to people.');
  if (emp.exitDate && data.effectiveFrom > emp.exitDate) throw AppError.validation({ effectiveFrom: 'This employee has already left by that date.' });
  const row = await withTransaction(async (db) => {
    const open = await Compensation.find({ tenantId: f.tenantId, employeeId: data.employeeId, state: 'OPEN' }).session(db).lean<CompensationDoc[]>();
    if (open.some((o) => o.effectiveFrom >= data.effectiveFrom)) throw new AppError('CONFLICT', 'This employee already has a salary starting on or after that date. Use a salary revision to change it.');
    for (const o of open) await Compensation.updateOne({ _id: o._id, tenantId: f.tenantId }, { $set: { effectiveTo: addDays(data.effectiveFrom, -1), state: 'ENDED' } }, { session: db });
    const [c] = await Compensation.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, ...data, createdBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'compensation.assigned', entityType: 'employee_compensation', entityId: c!._id, after: { employeeId: data.employeeId, mode: data.mode, effectiveFrom: data.effectiveFrom } }); // no amounts in the audit
    return c!.toObject() as CompensationDoc;
  });
  return (await compensationDTOs(f, [row]))[0]!;
}

/** Employees with no salary yet, each with a structure we suggest. A person still has to approve the assignment. */
export async function recommendCompensation(ctx: ServiceContext, query: { locationId?: string | undefined }) {
  const f = await financeCtx(ctx);
  const ids = await employeesInScope(ctx, f, query.locationId);
  const today = await todayFor(ctx);
  const employees = await Employee.find({ tenantId: f.tenantId, status: { $ne: 'EXITED' }, ...(ids ? { _id: { $in: ids } } : {}) }).lean<EmployeeDoc[]>();
  const withSalary = new Set((await Compensation.distinct('employeeId', { tenantId: f.tenantId, state: 'OPEN' })) as string[]);
  const missing = employees.filter((e) => !withSalary.has(e._id));
  const labels = await employeeLabels(f, missing.map((e) => e._id));
  const structures = await structureDTOs(f, await SalaryStructure.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).lean<SalaryStructureDoc[]>());
  const approved = structures.filter((s) => s.latestVersion?.state === 'APPROVED');
  return {
    asOf: today,
    items: missing.map((e) => {
      const l = labels.get(e._id)!;
      const match = approved.find((s) => l.designationName && s.name.toLowerCase().includes(l.designationName.toLowerCase())) ?? (approved.length === 1 ? approved[0] : undefined);
      return { employeeId: e._id, employeeName: l.name, employeeCode: l.code, designationName: l.designationName, suggestedStructureVersionId: match?.latestVersion?.versionId ?? null, suggestedStructureName: match?.name ?? null };
    }),
  };
}

const revisionDTOs = async (f: FinanceCtx, rows: SalaryRevisionDoc[]): Promise<SalaryRevisionDTO[]> => {
  const labels = await employeeLabels(f, rows.map((r) => r.employeeId));
  return rows.map((r) => ({ revisionId: r._id, employeeId: r.employeeId, employeeName: labels.get(r.employeeId)?.name ?? 'Employee', fromBasicPaise: r.fromBasicPaise, toBasicPaise: r.toBasicPaise, effectiveDate: r.effectiveDate, arrearPolicy: r.arrearPolicy, status: r.status, reason: r.reason, approvalId: r.approvalId }));
};

/** A pay rise or cut. Needs a second person. A back-dated one makes arrears in the next run; a finalised payslip is never rewritten. */
export async function createRevision(ctx: ServiceContext, data: { employeeId: string; newBasicPaise: number; effectiveDate: string; arrearPolicy: 'PAY_DIFFERENCE' | 'NONE'; reason: string; approvalId?: string | undefined }): Promise<SalaryRevisionDTO> {
  const f = await financeCtx(ctx);
  const emp = await scopedEmployee(ctx, f, data.employeeId);
  const current = await compensationOn(f, data.employeeId, data.effectiveDate) ?? (await Compensation.findOne({ tenantId: f.tenantId, employeeId: data.employeeId, state: 'OPEN' }).sort({ effectiveFrom: -1 }).lean<CompensationDoc>());
  if (!current) throw new AppError('PAYROLL_STATE_INVALID', 'This employee has no salary yet. Assign a salary structure first.');
  if (data.effectiveDate < current.effectiveFrom) throw AppError.validation({ effectiveDate: `The change cannot start before the current salary (${current.effectiveFrom}).` });
  const approval = await checkApproval(f, { action: 'SALARY_REVISION', entityType: 'employee', entityId: emp._id, amountPaise: Math.abs(data.newBasicPaise - current.basicPaise), reason: data.reason, approvalId: data.approvalId, payload: { newBasicPaise: data.newBasicPaise, effectiveDate: data.effectiveDate }, summary: `Change basic pay from ${formatMoney(current.basicPaise)} to ${formatMoney(data.newBasicPaise)} from ${data.effectiveDate}`, impact: 'A new salary line starts on that date. A past start date adds arrears to the next payroll run.' });
  const row = await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    const open = await Compensation.find({ tenantId: f.tenantId, employeeId: data.employeeId, state: 'OPEN' }).session(db).lean<CompensationDoc[]>();
    if (open.some((o) => o.effectiveFrom >= data.effectiveDate)) throw new AppError('CONFLICT', 'There is already a salary starting on or after that date.');
    for (const o of open) await Compensation.updateOne({ _id: o._id, tenantId: f.tenantId }, { $set: { effectiveTo: addDays(data.effectiveDate, -1), state: 'ENDED' } }, { session: db });
    const [next] = await Compensation.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, employeeId: data.employeeId, structureVersionId: current.structureVersionId, mode: current.mode, basicPaise: data.newBasicPaise, overrides: current.overrides, effectiveFrom: data.effectiveDate, createdBy: ctx.userId }], { session: db });
    const [rev] = await SalaryRevision.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, employeeId: data.employeeId, fromAssignmentId: current._id, fromBasicPaise: current.basicPaise, toBasicPaise: data.newBasicPaise, effectiveDate: data.effectiveDate, arrearPolicy: data.arrearPolicy, status: 'APPLIED', reason: data.reason, approvalId: approval?._id ?? null, newAssignmentId: next!._id, createdBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'salary_revision.applied', entityType: 'salary_revision', entityId: rev!._id, after: { employeeId: data.employeeId, effectiveDate: data.effectiveDate, arrearPolicy: data.arrearPolicy } });
    return rev!.toObject() as SalaryRevisionDoc;
  });
  return (await revisionDTOs(f, [row]))[0]!;
}

export async function listRevisions(ctx: ServiceContext, employeeId?: string): Promise<SalaryRevisionDTO[]> {
  const f = await financeCtx(ctx);
  const ids = await employeesInScope(ctx, f);
  return revisionDTOs(f, await SalaryRevision.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(employeeId ? { employeeId } : {}), ...(ids ? { employeeId: { $in: ids } } : {}) }).sort({ createdAt: -1 }).limit(200).lean<SalaryRevisionDoc[]>());
}

// ───────────────────────────────────────────────────────────── monthly inputs (PAY-04)

const inputDTOs = async (f: FinanceCtx, rows: PayrollInputDoc[]): Promise<PayrollInputDTO[]> => {
  const labels = await employeeLabels(f, rows.map((r) => r.employeeId));
  return rows.map((r) => ({ inputId: r._id, employeeId: r.employeeId, employeeName: labels.get(r.employeeId)?.name ?? 'Employee', employeeCode: labels.get(r.employeeId)?.code ?? '', month: r.month, workingDays: r.workingDays, paidLeaveDays: r.paidLeaveDays, lopDays: r.lopDays, unitsWorked: r.unitsWorked, extras: r.extras, source: r.source }));
};

export async function listInputs(ctx: ServiceContext, month: string): Promise<PayrollInputDTO[]> {
  const f = await financeCtx(ctx);
  const ids = await employeesInScope(ctx, f);
  return inputDTOs(f, await PayrollInput.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, month, ...(ids ? { employeeId: { $in: ids } } : {}) }).lean<PayrollInputDoc[]>());
}

async function saveInput(f: FinanceCtx, db: ClientSession, userId: string, source: 'MANUAL' | 'CSV', d: { employeeId: string; month: string; workingDays?: number | null | undefined; paidLeaveDays: number; lopDays: number; unitsWorked?: number | null | undefined; extras: PayrollInputDoc['extras'] }) {
  await ensureNotFinalised(f, db, d.employeeId, d.month);
  await PayrollInput.updateOne(
    { tenantId: f.tenantId, employeeId: d.employeeId, month: d.month },
    { $set: { workingDays: d.workingDays ?? null, paidLeaveDays: d.paidLeaveDays, lopDays: d.lopDays, unitsWorked: d.unitsWorked ?? null, extras: d.extras, source, approvedBy: userId }, $setOnInsert: { schoolId: f.schoolId, legalEntityId: f.legalEntityId } },
    { upsert: true, session: db },
  );
}

/** Inputs for a month that is already paid cannot be changed: a correction run is the way. */
async function ensureNotFinalised(f: FinanceCtx, db: ClientSession, employeeId: string, month: string) {
  const { PayrollRun, PayrollRunEmployee } = await import('./models');
  const runs = await PayrollRun.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, month, type: 'MONTHLY', state: 'FINALIZED' }).session(db).select('_id').lean<{ _id: string }[]>();
  if (runs.length && (await PayrollRunEmployee.exists({ tenantId: f.tenantId, runId: { $in: runs.map((r) => r._id) }, employeeId }).session(db))) throw new AppError('PAYROLL_STATE_INVALID', 'This month was already paid. Use a correction run to change anything.');
}

export async function putInput(ctx: ServiceContext, data: { employeeId: string; month: string; workingDays?: number | null | undefined; paidLeaveDays: number; lopDays: number; unitsWorked?: number | null | undefined; extras: PayrollInputDoc['extras'] }): Promise<PayrollInputDTO> {
  const f = await financeCtx(ctx);
  await scopedEmployee(ctx, f, data.employeeId);
  if (data.lopDays + data.paidLeaveDays > 31) throw AppError.validation({ lopDays: 'That is more days than a month has.' });
  await withTransaction(async (db) => {
    await saveInput(f, db, ctx.userId, 'MANUAL', data);
    await auditFinance(f, db, { action: 'payroll_input.saved', entityType: 'payroll_input', entityId: `${data.employeeId}:${data.month}`, after: { lopDays: data.lopDays, extras: data.extras.length } });
  });
  return (await inputDTOs(f, [(await PayrollInput.findOne({ tenantId: f.tenantId, employeeId: data.employeeId, month: data.month }).lean<PayrollInputDoc>())!]))[0]!;
}

/** "Mark everyone present": an explicit, audited choice that fills a full month for everyone who has no entry yet. Never done on its own. */
export async function fillInputs(ctx: ServiceContext, data: { month: string; workingDays?: number | undefined; locationId?: string | undefined }): Promise<{ filled: number }> {
  const f = await financeCtx(ctx);
  const ids = await employeesInScope(ctx, f, data.locationId);
  const range = monthRange(data.month);
  const employees = await Employee.find({ tenantId: f.tenantId, joiningDate: { $lte: range.end }, $or: [{ exitDate: null }, { exitDate: { $gte: range.start } }], status: { $ne: 'EXITED' }, ...(ids ? { _id: { $in: ids } } : {}) }).select('_id').lean<{ _id: string }[]>();
  const have = new Set((await PayrollInput.distinct('employeeId', { tenantId: f.tenantId, month: data.month })) as string[]);
  let filled = 0;
  await withTransaction(async (db) => {
    for (const e of employees.filter((x) => !have.has(x._id))) {
      await saveInput(f, db, ctx.userId, 'MANUAL', { employeeId: e._id, month: data.month, workingDays: data.workingDays ?? null, paidLeaveDays: 0, lopDays: 0, unitsWorked: null, extras: [] });
      filled += 1;
    }
    await auditFinance(f, db, { action: 'payroll_input.filled', entityType: 'payroll_input', entityId: data.month, after: { filled } });
  });
  return { filled };
}

/** CSV: employee code, working days, paid leave, LOP days, hours or days worked. A row that is wrong is reported; the good rows still go in. */
export async function importInputs(ctx: ServiceContext, month: string, file: Buffer | undefined): Promise<{ saved: number; problems: { row: number; message: string }[] }> {
  if (!file) throw AppError.validation({ file: 'Choose a CSV file.' });
  const f = await financeCtx(ctx);
  const table = parseCsv(file.toString('utf8'));
  const header = (table[0] ?? []).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
  const col = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const idx = { code: col('employeecode', 'code', 'empcode'), working: col('workingdays'), leave: col('paidleave', 'paidleavedays', 'leave'), lop: col('lop', 'lopdays', 'absent'), units: col('hours', 'unitsworked', 'daysworked', 'units') };
  if (idx.code < 0) throw new AppError('IMPORT_INVALID', 'The file needs an employee code column.');
  const employees = await Employee.find({ tenantId: f.tenantId, employeeCode: { $in: table.slice(1).map((r) => (r[idx.code] ?? '').toUpperCase()) } }).select('_id employeeCode').lean<{ _id: string; employeeCode: string }[]>();
  const byCode = new Map(employees.map((e) => [e.employeeCode, e._id]));
  const num = (v: string | undefined) => (v === undefined || v.trim() === '' ? null : Number(v));
  const problems: { row: number; message: string }[] = [];
  let saved = 0;
  for (const [i, r] of table.slice(1).entries()) {
    const code = (r[idx.code] ?? '').toUpperCase();
    const employeeId = byCode.get(code);
    const [w, l, p, u] = [num(r[idx.working]), num(r[idx.leave]), num(r[idx.lop]), num(r[idx.units])];
    if (!employeeId) { problems.push({ row: i + 2, message: `Employee code "${code}" was not found.` }); continue; }
    if ([w, l, p, u].some((x) => x !== null && (!Number.isFinite(x) || x < 0))) { problems.push({ row: i + 2, message: 'A day or hour value is not a number.' }); continue; }
    try {
      await scopedEmployee(ctx, f, employeeId);
      await withTransaction((db) => saveInput(f, db, ctx.userId, 'CSV', { employeeId, month, workingDays: w, paidLeaveDays: l ?? 0, lopDays: p ?? 0, unitsWorked: u, extras: [] }));
      saved += 1;
    } catch (err) {
      problems.push({ row: i + 2, message: err instanceof AppError ? err.message : 'This row could not be saved.' });
    }
  }
  await auditFinance(f, undefined, { action: 'payroll_input.imported', entityType: 'payroll_input', entityId: month, after: { saved, problems: problems.length } });
  return { saved, problems };
}

// ───────────────────────────────────────────────────────────── statutory rules (PAY-05)

const ruleDTO = async (f: FinanceCtx, r: StatutoryRuleDoc): Promise<StatutoryRuleDTO> => {
  const approver = r.approvedBy ? await User.findOne({ _id: r.approvedBy, tenantId: f.tenantId }).select('fullName').lean<{ fullName: string }>() : null;
  return { ruleId: r._id, kind: r.kind, effectiveFrom: r.effectiveFrom, params: r.params, state: r.state, demo: r.demo, warning: r.demo || r.state !== 'APPROVED' ? (r.demo ? DEMO_RULE_NOTE : 'These rules are not approved yet.') : null, approvedByName: approver?.fullName ?? null };
};

export async function listRules(ctx: ServiceContext): Promise<StatutoryRuleDTO[]> {
  const f = await financeCtx(ctx);
  await ensurePayrollSetup(f);
  const rows = await StatutoryRule.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ kind: 1, effectiveFrom: 1 }).lean<StatutoryRuleDoc[]>();
  return Promise.all(rows.map((r) => ruleDTO(f, r)));
}

function checkParams(kind: StatutoryKind, p: Record<string, unknown>) {
  const num = (k: string) => typeof p[k] === 'number' && Number.isInteger(p[k]) && (p[k] as number) >= 0;
  if (kind === 'PF' && !(num('employeeBps') && num('employerBps') && num('wageCeilingPaise'))) throw AppError.validation({ params: 'PF needs employeeBps, employerBps and wageCeilingPaise (whole numbers).' });
  if (kind === 'ESI' && !(num('employeeBps') && num('employerBps') && num('grossLimitPaise'))) throw AppError.validation({ params: 'ESI needs employeeBps, employerBps and grossLimitPaise (whole numbers).' });
  if (kind === 'PT') {
    const slabs = p.slabs;
    if (!Array.isArray(slabs) || slabs.length === 0 || !slabs.every((s) => s && typeof s.fromPaise === 'number' && typeof s.amountPaise === 'number' && (s.toPaise === null || typeof s.toPaise === 'number'))) throw AppError.validation({ params: 'Professional Tax needs slabs: [{ fromPaise, toPaise, amountPaise }].' });
  }
}

export async function createRule(ctx: ServiceContext, data: { kind: StatutoryKind; effectiveFrom: string; params: Record<string, unknown>; note?: string | null | undefined }): Promise<StatutoryRuleDTO> {
  const f = await financeCtx(ctx);
  await ensurePayrollSetup(f);
  checkParams(data.kind, data.params);
  try {
    const row = await withTransaction(async (db) => {
      const [r] = await StatutoryRule.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, kind: data.kind, effectiveFrom: data.effectiveFrom, params: data.params, note: data.note ?? null, state: 'DRAFT', demo: false, createdBy: ctx.userId }], { session: db });
      await auditFinance(f, db, { action: 'statutory_rule.created', entityType: 'statutory_rule', entityId: r!._id, after: { kind: data.kind, effectiveFrom: data.effectiveFrom } });
      return r!.toObject() as StatutoryRuleDoc;
    });
    return ruleDTO(f, row);
  } catch (err) {
    if (duplicateKeyFields(err)) throw new AppError('FINANCE_CODE_TAKEN', 'There is already a rule of this kind starting on that date.');
    throw err;
  }
}

export async function approveRule(ctx: ServiceContext, ruleId: string): Promise<StatutoryRuleDTO> {
  const f = await financeCtx(ctx);
  const r = await StatutoryRule.findOne({ _id: ruleId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<StatutoryRuleDoc>();
  if (!r) throw AppError.notFound('Rule not found.');
  if (r.createdBy === ctx.userId) throw new AppError('SELF_APPROVAL_BLOCKED');
  const res = await StatutoryRule.updateOne({ _id: ruleId, tenantId: f.tenantId, state: 'DRAFT' }, { $set: { state: 'APPROVED', approvedBy: ctx.userId, approvedAt: new Date(), demo: false } });
  if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This rule is already approved.');
  await auditFinance(f, undefined, { action: 'statutory_rule.approved', entityType: 'statutory_rule', entityId: ruleId, after: { kind: r.kind } });
  return ruleDTO(f, (await StatutoryRule.findOne({ _id: ruleId, tenantId: f.tenantId }).lean<StatutoryRuleDoc>())!);
}

/** The rule of each kind in force on a date (the latest that had started). */
export async function rulesFor(f: FinanceCtx, date: string, db?: ClientSession) {
  const rows = await StatutoryRule.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, effectiveFrom: { $lte: date } }).sort({ effectiveFrom: 1 }).session(db ?? null).lean<StatutoryRuleDoc[]>();
  const pick = (k: StatutoryKind) => rows.filter((r) => r.kind === k).at(-1) ?? null;
  return { pf: pick('PF'), esi: pick('ESI'), pt: pick('PT') };
}

// ───────────────────────────────────────────────────────────── tax declaration (TDS)

export function declarationDTO(d: TaxDeclarationDoc, month: string): TaxDeclarationDTO {
  const left = Math.max(1, monthsLeftInFy(month));
  return { declarationId: d._id, employeeId: d.employeeId, fyCode: d.fyCode, regime: d.regime, estimatedYearlyTaxPaise: d.estimatedYearlyTaxPaise, alreadyDeductedPaise: d.alreadyDeductedPaise, monthlyPaise: Math.max(0, roundHalfUp(d.estimatedYearlyTaxPaise - d.alreadyDeductedPaise, left)), note: d.note };
}

export async function saveDeclaration(ctx: ServiceContext, employeeId: string, data: { regime: 'NEW' | 'OLD'; estimatedYearlyTaxPaise: number; alreadyDeductedPaise: number; note?: string | null | undefined }, mode: 'STAFF' | 'SELF'): Promise<TaxDeclarationDTO> {
  const f = await financeCtx(ctx);
  if (mode === 'STAFF') await scopedEmployee(ctx, f, employeeId);
  const today = await todayFor(ctx);
  const fyCode = fyCodeFor(today, f.entity.fyStartMonth);
  await withTransaction(async (db) => {
    await TaxDeclaration.updateOne({ tenantId: f.tenantId, employeeId, fyCode }, { $set: { regime: data.regime, estimatedYearlyTaxPaise: data.estimatedYearlyTaxPaise, alreadyDeductedPaise: data.alreadyDeductedPaise, note: data.note ?? null, submittedBy: ctx.userId }, $setOnInsert: { schoolId: f.schoolId, legalEntityId: f.legalEntityId } }, { upsert: true, session: db });
    await auditFinance(f, db, { action: 'tax_declaration.saved', entityType: 'tax_declaration', entityId: `${employeeId}:${fyCode}`, after: { regime: data.regime, by: mode } });
  });
  return declarationDTO((await TaxDeclaration.findOne({ tenantId: f.tenantId, employeeId, fyCode }).lean<TaxDeclarationDoc>())!, today.slice(0, 7));
}

export async function declarationFor(f: FinanceCtx, employeeId: string, month: string, db?: ClientSession): Promise<TaxDeclarationDoc | null> {
  return TaxDeclaration.findOne({ tenantId: f.tenantId, employeeId, fyCode: fyCodeFor(`${month}-01`, f.entity.fyStartMonth) }).session(db ?? null).lean<TaxDeclarationDoc>();
}

// ───────────────────────────────────────────────────────────── advances and loans (PAY-06)

const advanceDTOs = async (f: FinanceCtx, rows: AdvanceDoc[]): Promise<AdvanceDTO[]> => {
  const labels = await employeeLabels(f, rows.map((r) => r.employeeId));
  return rows.map((a) => ({ advanceId: a._id, employeeId: a.employeeId, employeeName: labels.get(a.employeeId)?.name ?? 'Employee', principalPaise: a.principalPaise, installments: a.installments, installmentPaise: a.installmentPaise, remainingPaise: a.remainingPaise, startMonth: a.startMonth, state: a.state, reason: a.reason, paidOn: a.paidOn }));
};

export async function createAdvance(ctx: ServiceContext, data: { employeeId: string; principalPaise: number; installments: number; startMonth: string; reason: string }): Promise<AdvanceDTO> {
  const f = await financeCtx(ctx);
  await scopedEmployee(ctx, f, data.employeeId);
  const [row] = await withTransaction(async (db) => {
    const [a] = await Advance.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, ...data, installmentPaise: Math.ceil(data.principalPaise / data.installments), remainingPaise: data.principalPaise, requestedBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'advance.requested', entityType: 'employee_advance', entityId: a!._id, after: { employeeId: data.employeeId, installments: data.installments } });
    return [a!.toObject() as AdvanceDoc];
  });
  return (await advanceDTOs(f, [row!]))[0]!;
}

export async function listAdvances(ctx: ServiceContext, employeeId?: string): Promise<AdvanceDTO[]> {
  const f = await financeCtx(ctx);
  const ids = await employeesInScope(ctx, f);
  return advanceDTOs(f, await Advance.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(employeeId ? { employeeId } : {}), ...(ids ? { employeeId: { $in: ids } } : {}) }).sort({ createdAt: -1 }).limit(200).lean<AdvanceDoc[]>());
}

export async function approveAdvance(ctx: ServiceContext, advanceId: string): Promise<AdvanceDTO> {
  const f = await financeCtx(ctx);
  const a = await Advance.findOne({ _id: advanceId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<AdvanceDoc>();
  if (!a) throw AppError.notFound('Advance not found.');
  if (a.requestedBy === ctx.userId) throw new AppError('SELF_APPROVAL_BLOCKED');
  const res = await Advance.updateOne({ _id: advanceId, tenantId: f.tenantId, state: 'REQUESTED' }, { $set: { state: 'APPROVED', approvedBy: ctx.userId } });
  if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This advance was already decided.');
  await auditFinance(f, undefined, { action: 'advance.approved', entityType: 'employee_advance', entityId: advanceId });
  return (await advanceDTOs(f, [(await Advance.findOne({ _id: advanceId, tenantId: f.tenantId }).lean<AdvanceDoc>())!]))[0]!;
}

/** The money really left the bank. An advance is the school's asset, kept apart from salary payable: Dr Employee Advances, Cr Bank. */
export async function recordAdvancePayment(ctx: ServiceContext, advanceId: string, data: { bankAccountId: string; reference: string; paidOn?: string | null | undefined }): Promise<AdvanceDTO> {
  const f = await financeCtx(ctx);
  const date = data.paidOn ?? (await todayFor(ctx));
  await withTransaction(async (db) => {
    const a = await Advance.findOne({ _id: advanceId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<AdvanceDoc>();
    if (!a) throw AppError.notFound('Advance not found.');
    if (a.state !== 'APPROVED') throw new AppError('PAYROLL_STATE_INVALID', a.state === 'REQUESTED' ? 'A second person must approve this advance first.' : 'This advance was already paid or closed.');
    const bank = await BankAccount.findOne({ _id: data.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).session(db).lean<BankAccountDoc>();
    if (!bank) throw AppError.notFound('Bank account not found.');
    const asset = (await rolesMap(f, db)).get('EMPLOYEE_ADVANCE');
    if (!asset) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts has no employee advance account. Use the standard chart in Finance Settings.');
    const { journal } = await postJournal(f, db, { eventType: 'salary.advance_paid', sourceKey: `advance_paid:${a._id}`, accountingDate: date, memo: `Salary advance paid (${data.reference})`, sourceType: 'employee_advance', sourceId: a._id, lines: [{ accountId: asset._id, debitPaise: a.principalPaise, employeeId: a.employeeId }, { accountId: bank.glAccountId, creditPaise: a.principalPaise }] });
    const res = await Advance.updateOne({ _id: a._id, tenantId: f.tenantId, state: 'APPROVED' }, { $set: { state: 'PAID_OUT', paidOn: date, paidJournalId: journal._id } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This advance was just paid.');
    await auditFinance(f, db, { action: 'advance.paid', entityType: 'employee_advance', entityId: a._id, after: { paidOn: date } });
  });
  return (await advanceDTOs(f, [(await Advance.findOne({ _id: advanceId, tenantId: f.tenantId }).lean<AdvanceDoc>())!]))[0]!;
}

/** The instalment plan changes: a second person must approve. */
export async function changeAdvancePlan(ctx: ServiceContext, advanceId: string, data: { installments: number; approvalId?: string | undefined }): Promise<AdvanceDTO> {
  const f = await financeCtx(ctx);
  const a = await Advance.findOne({ _id: advanceId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<AdvanceDoc>();
  if (!a) throw AppError.notFound('Advance not found.');
  if (!['APPROVED', 'PAID_OUT'].includes(a.state)) throw new AppError('PAYROLL_STATE_INVALID', 'This advance is not running.');
  const approval = await checkApproval(f, { action: 'LOAN_CHANGE', entityType: 'employee_advance', entityId: a._id, amountPaise: a.remainingPaise, approvalId: data.approvalId, payload: { installments: data.installments }, summary: `Change the advance to ${data.installments} instalments`, impact: `The remaining ${formatMoney(a.remainingPaise)} will be recovered in ${data.installments} instalments.` });
  await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    await Advance.updateOne({ _id: a._id, tenantId: f.tenantId }, { $set: { installments: data.installments, installmentPaise: Math.ceil(a.remainingPaise / data.installments) } }, { session: db });
    await auditFinance(f, db, { action: 'advance.plan_changed', entityType: 'employee_advance', entityId: a._id, after: { installments: data.installments } });
  });
  return (await advanceDTOs(f, [(await Advance.findOne({ _id: advanceId, tenantId: f.tenantId }).lean<AdvanceDoc>())!]))[0]!;
}

/** Money paid back early, outside the salary: Dr Bank, Cr Employee Advances. */
export async function repayAdvanceEarly(ctx: ServiceContext, advanceId: string, data: { amountPaise: number; bankAccountId: string; reference?: string | null | undefined; paidOn?: string | null | undefined }): Promise<AdvanceDTO> {
  const f = await financeCtx(ctx);
  const date = data.paidOn ?? (await todayFor(ctx));
  await withTransaction(async (db) => {
    const a = await Advance.findOne({ _id: advanceId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<AdvanceDoc>();
    if (!a) throw AppError.notFound('Advance not found.');
    if (a.state !== 'PAID_OUT') throw new AppError('PAYROLL_STATE_INVALID', 'Only an advance that was paid out can be repaid.');
    if (data.amountPaise > a.remainingPaise) throw new AppError('PAYOUT_EXCEEDS_PAYABLE', `Only ${formatMoney(a.remainingPaise)} is still owed on this advance.`);
    const bank = await BankAccount.findOne({ _id: data.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).session(db).lean<BankAccountDoc>();
    if (!bank) throw AppError.notFound('Bank account not found.');
    const asset = (await rolesMap(f, db)).get('EMPLOYEE_ADVANCE')!;
    await postJournal(f, db, { eventType: 'salary.advance_recovered', sourceKey: `advance_repay:${a._id}:${randomUUID()}`, accountingDate: date, memo: 'Salary advance repaid early', sourceType: 'employee_advance', sourceId: a._id, lines: [{ accountId: bank.glAccountId, debitPaise: data.amountPaise }, { accountId: asset._id, creditPaise: data.amountPaise, employeeId: a.employeeId }] });
    const remaining = a.remainingPaise - data.amountPaise;
    const res = await Advance.updateOne({ _id: a._id, tenantId: f.tenantId, remainingPaise: a.remainingPaise }, { $set: { remainingPaise: remaining, state: remaining === 0 ? 'CLOSED' : 'PAID_OUT', installmentPaise: remaining === 0 ? 0 : Math.min(a.installmentPaise, remaining) } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('CONFLICT', 'This advance changed just now. Try again.');
    await auditFinance(f, db, { action: 'advance.repaid_early', entityType: 'employee_advance', entityId: a._id, after: { amountPaise: data.amountPaise } });
  });
  return (await advanceDTOs(f, [(await Advance.findOne({ _id: advanceId, tenantId: f.tenantId }).lean<AdvanceDoc>())!]))[0]!;
}

export { can, emitFinance, findCallerEmployee, LocationAssignment, toPaise };
