import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { AccountDTO, AccountType, CreateAccountData, NormalBalance, SystemAccountRole, UpdateAccountData } from '@shared';
import { SYSTEM_ACCOUNT_ROLES } from '@shared';
import { AppError } from '../../../core/errors';
import { onDuplicate } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { checkApproval, consumeApproval } from './approvals.service';
import { auditFinance, financeCtx, type FinanceCtx } from './context';
import { ChartAccount, JournalLine, type ChartAccountDoc } from './models';

/**
 * The chart of accounts (FIN-03). Accounts are never deleted: one with entries can be made inactive. Only a detail (leaf) account
 * takes entries. A system account is the one the system posts to by role (for example `STUDENT_RECEIVABLE`), and moving a role needs approval.
 */

const NORMAL: Record<AccountType, NormalBalance> = { ASSET: 'DEBIT', EXPENSE: 'DEBIT', LIABILITY: 'CREDIT', INCOME: 'CREDIT', EQUITY: 'CREDIT' };

// code, name, type, parent code, system role, postable
type Seed = [string, string, AccountType, string | null, SystemAccountRole | null, boolean];
export const STANDARD_CHART: Seed[] = [
  ['1000', 'Assets', 'ASSET', null, null, false],
  ['1010', 'Cash in Hand', 'ASSET', '1000', 'CASH', true],
  ['1020', 'Bank Account', 'ASSET', '1000', 'BANK_DEFAULT', true],
  ['1100', 'Student Fees Receivable', 'ASSET', '1000', 'STUDENT_RECEIVABLE', true],
  ['1200', 'Employee Advances', 'ASSET', '1000', 'EMPLOYEE_ADVANCE', true],
  ['1310', 'Input CGST', 'ASSET', '1000', 'INPUT_CGST', true],
  ['1320', 'Input SGST', 'ASSET', '1000', 'INPUT_SGST', true],
  ['1330', 'Input IGST', 'ASSET', '1000', 'INPUT_IGST', true],
  ['2000', 'Liabilities', 'LIABILITY', null, null, false],
  ['2100', 'Student Advances', 'LIABILITY', '2000', 'STUDENT_ADVANCE', true],
  ['2200', 'Refundable Deposits', 'LIABILITY', '2000', 'REFUNDABLE_DEPOSIT', true],
  ['2300', 'Salary Payable', 'LIABILITY', '2000', 'SALARY_PAYABLE', true],
  ['2310', 'PF Payable', 'LIABILITY', '2000', 'PF_PAYABLE', true],
  ['2320', 'ESI Payable', 'LIABILITY', '2000', 'ESI_PAYABLE', true],
  ['2330', 'Professional Tax Payable', 'LIABILITY', '2000', 'PT_PAYABLE', true],
  ['2340', 'TDS Payable', 'LIABILITY', '2000', 'TDS_PAYABLE', true],
  ['2400', 'Refunds Payable', 'LIABILITY', '2000', 'REFUND_PAYABLE', true],
  ['2500', 'Vendors Payable', 'LIABILITY', '2000', 'VENDOR_PAYABLE', true],
  ['2610', 'Output CGST', 'LIABILITY', '2000', 'OUTPUT_CGST', true],
  ['2620', 'Output SGST', 'LIABILITY', '2000', 'OUTPUT_SGST', true],
  ['2630', 'Output IGST', 'LIABILITY', '2000', 'OUTPUT_IGST', true],
  ['3000', 'Equity', 'EQUITY', null, null, false],
  ['3100', 'Opening Balance Equity', 'EQUITY', '3000', 'OPENING_EQUITY', true],
  ['4000', 'Income', 'INCOME', null, null, false],
  ['4100', 'Tuition Fee Income', 'INCOME', '4000', null, true],
  ['4200', 'Admission Fee Income', 'INCOME', '4000', null, true],
  ['4300', 'Annual Charges Income', 'INCOME', '4000', null, true],
  ['4400', 'Transport Fee Income', 'INCOME', '4000', null, true],
  ['4500', 'Exam Fee Income', 'INCOME', '4000', null, true],
  ['4600', 'Other Fee Income', 'INCOME', '4000', null, true],
  ['4700', 'Late Fee Income', 'INCOME', '4000', 'LATE_FEE_INCOME', true],
  ['5000', 'Expenses', 'EXPENSE', null, null, false],
  ['5100', 'Salaries', 'EXPENSE', '5000', 'SALARY_EXPENSE', true],
  ['5110', 'Employer Contributions', 'EXPENSE', '5000', 'EMPLOYER_CONTRIBUTION_EXPENSE', true],
  ['5200', 'Rent', 'EXPENSE', '5000', null, true],
  ['5210', 'Utilities', 'EXPENSE', '5000', null, true],
  ['5220', 'Repairs and Maintenance', 'EXPENSE', '5000', null, true],
  ['5230', 'Supplies', 'EXPENSE', '5000', null, true],
  ['5300', 'Bank Charges', 'EXPENSE', '5000', 'BANK_CHARGES', true],
];

/** "Use the standard chart": safe to press twice. Missing accounts are added; ones already there are left alone. */
export async function seedStandardChart(f: FinanceCtx, db?: ClientSession): Promise<{ added: number }> {
  const existing = await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).select('code').lean<{ _id: string; code: string }[]>();
  const idByCode = new Map(existing.map((a) => [a.code, a._id]));
  let added = 0;
  for (const [code, name, type, parent, role, postable] of STANDARD_CHART) {
    if (idByCode.has(code)) continue;
    const id = randomUUID();
    idByCode.set(code, id);
    await ChartAccount.create(
      [{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, code, name, type, normalBalance: NORMAL[type], parentId: parent ? idByCode.get(parent) ?? null : null, systemRole: role, isPostable: postable, createdBy: f.userId, updatedBy: f.userId }],
      { session: db },
    );
    added += 1;
  }
  return { added };
}

/** The account that holds a system role, or an error that says what to set up. */
export async function accountForRole(f: FinanceCtx, role: SystemAccountRole, db?: ClientSession): Promise<ChartAccountDoc> {
  const account = await ChartAccount.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, systemRole: role }).session(db ?? null).lean<ChartAccountDoc>();
  if (!account) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing an account the system needs. Use the standard chart in Finance Settings.', { role });
  return account;
}

/** All system accounts in one query. */
export async function rolesMap(f: FinanceCtx, db?: ClientSession): Promise<Map<string, ChartAccountDoc>> {
  const rows = await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, systemRole: { $type: 'string' } }).session(db ?? null).lean<ChartAccountDoc[]>();
  return new Map(rows.map((a) => [a.systemRole!, a]));
}

export async function accountsById(f: FinanceCtx, ids: string[], db?: ClientSession): Promise<Map<string, ChartAccountDoc>> {
  const rows = await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: ids } }).session(db ?? null).lean<ChartAccountDoc[]>();
  return new Map(rows.map((a) => [a._id, a]));
}

async function toDTOs(f: FinanceCtx, rows: ChartAccountDoc[]): Promise<AccountDTO[]> {
  const used = new Set((await JournalLine.distinct('accountId', { tenantId: f.tenantId, legalEntityId: f.legalEntityId })) as string[]);
  return rows.map((a) => ({
    accountId: a._id, code: a.code, name: a.name, type: a.type, parentId: a.parentId, normalBalance: a.normalBalance, systemRole: a.systemRole as SystemAccountRole | null,
    isPostable: a.isPostable, status: a.status, hasEntries: used.has(a._id),
  }));
}

export async function listAccounts(ctx: ServiceContext, query: { type?: string; q?: string } = {}): Promise<AccountDTO[]> {
  const f = await financeCtx(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  if (query.type) filter.type = query.type;
  const rows = await ChartAccount.find(filter).sort({ code: 1 }).lean<ChartAccountDoc[]>();
  const q = query.q?.trim().toLowerCase();
  return toDTOs(f, q ? rows.filter((a) => a.code.includes(q) || a.name.toLowerCase().includes(q)) : rows);
}

function suggestCode(siblings: string[], parentCode: string | null, type: AccountType): string {
  const base: Record<AccountType, number> = { ASSET: 1000, LIABILITY: 2000, EQUITY: 3000, INCOME: 4000, EXPENSE: 5000 };
  const numeric = siblings.map(Number).filter((n) => Number.isFinite(n));
  let next = (numeric.length ? Math.max(...numeric) : parentCode && Number.isFinite(Number(parentCode)) ? Number(parentCode) : base[type]) + 10;
  while (siblings.includes(String(next))) next += 10;
  return String(next);
}

export async function createAccount(ctx: ServiceContext, data: CreateAccountData): Promise<AccountDTO> {
  const f = await financeCtx(ctx);
  const parent = data.parentId ? await ChartAccount.findOne({ _id: data.parentId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ChartAccountDoc>() : null;
  if (data.parentId && !parent) throw AppError.notFound('Parent account not found.');
  if (parent && parent.type !== data.type) throw AppError.validation({ type: `This must be the same type as its parent (${parent.type.toLowerCase()}).` });
  const id = randomUUID();
  await withTransaction(async (db) => {
    const all = await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).select('code').lean<{ code: string }[]>();
    const code = data.code ?? suggestCode(all.map((a) => a.code), parent?.code ?? null, data.type);
    if (parent) {
      if (await JournalLine.exists({ tenantId: f.tenantId, accountId: parent._id }).session(db)) throw new AppError('FINANCE_RECORD_LOCKED', 'This account already has entries, so it cannot become a group. Add the new account somewhere else.');
      if (parent.isPostable) await ChartAccount.updateOne({ _id: parent._id, tenantId: f.tenantId }, { $set: { isPostable: false } }, { session: db });
    }
    await ChartAccount.create(
      [{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, code, name: data.name, type: data.type, normalBalance: NORMAL[data.type], parentId: parent?._id ?? null, isPostable: data.isPostable ?? true, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    ).catch(onDuplicate('code', () => new AppError('FINANCE_CODE_TAKEN', 'This account code is already in use.', { fields: { code: 'This account code is already in use.' } })));
    await auditFinance(f, db, { action: 'account.created', entityType: 'account', entityId: id, after: { code, name: data.name, type: data.type } });
  });
  return (await toDTOs(f, [(await ChartAccount.findOne({ _id: id, tenantId: f.tenantId }).lean<ChartAccountDoc>())!]))[0]!;
}

export async function updateAccount(ctx: ServiceContext, accountId: string, data: UpdateAccountData): Promise<AccountDTO> {
  const f = await financeCtx(ctx);
  const before = await ChartAccount.findOne({ _id: accountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ChartAccountDoc>();
  if (!before) throw AppError.notFound('Account not found.');
  const roleChange = data.systemRole !== undefined && data.systemRole !== before.systemRole;
  if (roleChange && data.systemRole && !(SYSTEM_ACCOUNT_ROLES as readonly string[]).includes(data.systemRole)) throw AppError.validation({ systemRole: 'This is not a system role.' });
  if (roleChange && data.systemRole && !before.isPostable) throw AppError.validation({ systemRole: 'Only a detail account can hold a system role.' });
  if (data.status === 'INACTIVE' && before.systemRole) throw new AppError('FINANCE_RECORD_LOCKED', 'A system account cannot be made inactive. Move its role to another account first.');
  const approval = roleChange
    ? await checkApproval(f, { action: 'SYSTEM_ROLE_CHANGE', entityType: 'account', entityId: accountId, amountPaise: 0, summary: `Move the system role ${data.systemRole ?? before.systemRole ?? ''} to ${before.code} ${before.name}`, impact: 'Future entries for this role will post to a different account. Old entries are not changed.', approvalId: data.approvalId })
    : null;
  await withTransaction(async (db) => {
    if (approval) await consumeApproval(f, db, approval);
    if (roleChange && data.systemRole) await ChartAccount.updateOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, systemRole: data.systemRole }, { $set: { systemRole: null } }, { session: db });
    const patch: Record<string, unknown> = { updatedBy: ctx.userId };
    if (data.name !== undefined) patch.name = data.name;
    if (data.status !== undefined) patch.status = data.status;
    if (roleChange) patch.systemRole = data.systemRole;
    await ChartAccount.updateOne({ _id: accountId, tenantId: f.tenantId }, { $set: patch }, { session: db });
    await auditFinance(f, db, { action: roleChange ? 'account.system_role_moved' : 'account.updated', entityType: 'account', entityId: accountId, before: { name: before.name, status: before.status, systemRole: before.systemRole }, after: patch });
  });
  return (await toDTOs(f, [(await ChartAccount.findOne({ _id: accountId, tenantId: f.tenantId }).lean<ChartAccountDoc>())!]))[0]!;
}
