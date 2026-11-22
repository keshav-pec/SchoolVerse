import { randomUUID } from 'node:crypto';
import type { BankAccountDTO, CashAccountDTO, CreateBankAccountData, RevealedBankNumberDTO, UpdateBankAccountData } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import { decryptField, encryptField, last4 as lastFour } from '../../../platform/identity/crypto';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { checkApproval, registerApprovalExecutor } from './approvals.service';
import { accountForRole } from './chart.service';
import { auditFinance, assertLocationAccess, financeCtx, financeScope, type FinanceCtx } from './context';
import { ApprovalRequest, BankAccount, CashAccount, ChartAccount, type BankAccountDoc, type CashAccountDoc, type ChartAccountDoc } from './models';

/**
 * Bank and cash accounts (FIN-04). The full account number is sealed with the same field encryption as Module 3 bank details, and
 * only the last four digits ever leave the server. Showing the whole number needs `finance:setup:manage` and a written reason, and is
 * audited. Changing the number or the IFSC needs approval from a second person.
 */

const bankContext = (id: string) => `${id}:finance-bank`;
const masked = (last4: string) => `••••${last4}`;

async function toBankDTOs(f: FinanceCtx, rows: BankAccountDoc[]): Promise<BankAccountDTO[]> {
  const pending = await ApprovalRequest.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'BANK_DETAIL_CHANGE', decision: 'PENDING', entityId: { $in: rows.map((r) => r._id) } }).select('entityId').lean<{ _id: string; entityId: string }[]>();
  const byBank = new Map(pending.map((p) => [p.entityId, p._id]));
  return rows.map((b) => ({
    bankAccountId: b._id, label: b.label, bankName: b.bankName, holderName: b.holderName, accountNumberMasked: masked(b.last4), ifsc: b.ifsc, purpose: b.purpose,
    glAccountId: b.glAccountId, locationIds: b.locationIds, status: b.status, pendingApprovalId: byBank.get(b._id) ?? null,
  }));
}

async function checkLocations(ctx: ServiceContext, ids: string[]) {
  for (const id of ids) await assertLocationAccess(ctx, id);
}

/** A detail asset account for this bank: the standard bank account if it is free, otherwise a new one under the same group. */
async function glAccountFor(f: FinanceCtx, requested: string | undefined, label: string, db: Parameters<Parameters<typeof withTransaction>[0]>[0]): Promise<string> {
  if (requested) {
    const account = await ChartAccount.findOne({ _id: requested, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<ChartAccountDoc>();
    if (!account) throw AppError.notFound('Account not found.');
    if (account.type !== 'ASSET' || !account.isPostable) throw AppError.validation({ glAccountId: 'Choose a detail asset account.' });
    return account._id;
  }
  const standard = await accountForRole(f, 'BANK_DEFAULT', db);
  if (!(await BankAccount.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, glAccountId: standard._id }).session(db))) return standard._id;
  const siblings = await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, parentId: standard.parentId }).session(db).select('code').lean<{ code: string }[]>();
  let n = Math.max(...siblings.map((s) => Number(s.code)).filter(Number.isFinite), Number(standard.code)) + 10;
  while (siblings.some((s) => s.code === String(n))) n += 10;
  const id = randomUUID();
  await ChartAccount.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, code: String(n), name: `Bank - ${label}`, type: 'ASSET', normalBalance: 'DEBIT', parentId: standard.parentId, createdBy: f.userId, updatedBy: f.userId }], { session: db });
  return id;
}

export async function listBankAccounts(ctx: ServiceContext): Promise<BankAccountDTO[]> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const rows = await BankAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ createdAt: 1 }).lean<BankAccountDoc[]>();
  // A scoped user sees accounts that serve one of their campuses, or every campus (an empty list).
  const visible = scope.all ? rows : rows.filter((b) => b.locationIds.length === 0 || b.locationIds.some((id) => scope.locationIds.includes(id)));
  return toBankDTOs(f, visible);
}

export async function createBankAccount(ctx: ServiceContext, data: CreateBankAccountData): Promise<BankAccountDTO> {
  const f = await financeCtx(ctx);
  await checkLocations(ctx, data.locationIds);
  const id = randomUUID();
  await withTransaction(async (db) => {
    const glAccountId = await glAccountFor(f, data.glAccountId, data.label, db);
    await BankAccount.create(
      [{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, label: data.label, bankName: data.bankName, holderName: data.holderName ?? null, accountNumberEnc: encryptField(data.accountNumber, bankContext(id)), last4: lastFour(data.accountNumber), ifsc: data.ifsc, purpose: data.purpose, glAccountId, locationIds: data.locationIds, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    await auditFinance(f, db, { action: 'bank_account.created', entityType: 'bank_account', entityId: id, after: { label: data.label, bankName: data.bankName, last4: lastFour(data.accountNumber), ifsc: data.ifsc, purpose: data.purpose } });
  });
  return (await toBankDTOs(f, [(await BankAccount.findOne({ _id: id, tenantId: f.tenantId }).lean<BankAccountDoc>())!]))[0]!;
}

async function loadBank(f: FinanceCtx, id: string): Promise<BankAccountDoc> {
  const doc = await BankAccount.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<BankAccountDoc>();
  if (!doc) throw AppError.notFound('Bank account not found.');
  return doc;
}

export async function updateBankAccount(ctx: ServiceContext, id: string, data: UpdateBankAccountData): Promise<BankAccountDTO> {
  const f = await financeCtx(ctx);
  const before = await loadBank(f, id);
  if (data.locationIds) await checkLocations(ctx, data.locationIds);

  if (data.accountNumber !== undefined || data.ifsc !== undefined) {
    // The new value is sealed before it is kept on the request, so a pending request never holds a readable account number.
    await checkApproval(f, {
      action: 'BANK_DETAIL_CHANGE', entityType: 'bank_account', entityId: id, amountPaise: 0,
      summary: `Change the ${[data.accountNumber !== undefined ? 'account number' : null, data.ifsc !== undefined ? 'IFSC' : null].filter(Boolean).join(' and ')} of ${before.label} (${masked(before.last4)})`,
      impact: 'Money will be expected in a different bank account. Old entries are not changed.',
      payload: { ...(data.accountNumber !== undefined ? { accountNumberEnc: encryptField(data.accountNumber, bankContext(id)), last4: lastFour(data.accountNumber) } : {}), ...(data.ifsc !== undefined ? { ifsc: data.ifsc } : {}) },
    });
  }
  await withTransaction(async (db) => {
    const patch: Record<string, unknown> = { updatedBy: ctx.userId };
    for (const k of ['label', 'bankName', 'holderName', 'purpose', 'locationIds', 'status'] as const) if (data[k] !== undefined) patch[k] = data[k];
    await BankAccount.updateOne({ _id: id, tenantId: f.tenantId }, { $set: patch }, { session: db });
    await auditFinance(f, db, { action: 'bank_account.updated', entityType: 'bank_account', entityId: id, before: { label: before.label, bankName: before.bankName, purpose: before.purpose, status: before.status, locationIds: before.locationIds }, after: patch });
  });
  return (await toBankDTOs(f, [await loadBank(f, id)]))[0]!;
}

/** Runs when a second person approves a change to the number or the IFSC. */
registerApprovalExecutor('BANK_DETAIL_CHANGE', async (f, db, request) => {
  const payload = request.payload as { accountNumberEnc?: string; last4?: string; ifsc?: string };
  const patch: Record<string, unknown> = {};
  if (payload.accountNumberEnc) Object.assign(patch, { accountNumberEnc: payload.accountNumberEnc, last4: payload.last4 });
  if (payload.ifsc) patch.ifsc = payload.ifsc;
  const before = await BankAccount.findOne({ _id: request.entityId, tenantId: f.tenantId }).session(db).lean<BankAccountDoc>();
  if (!before) throw AppError.notFound('Bank account not found.');
  await BankAccount.updateOne({ _id: request.entityId, tenantId: f.tenantId }, { $set: patch }, { session: db });
  await auditFinance(f, db, {
    action: 'bank_account.details_changed', entityType: 'bank_account', entityId: before._id,
    before: { last4: before.last4, ifsc: before.ifsc }, after: { last4: payload.last4 ?? before.last4, ifsc: payload.ifsc ?? before.ifsc }, metadata: { approvalId: request._id },
  });
});

/** The only place a whole account number is returned. The reason is kept in the audit trail. */
export async function revealBankNumber(ctx: ServiceContext, id: string, reason: string): Promise<RevealedBankNumberDTO> {
  const f = await financeCtx(ctx);
  const doc = await BankAccount.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).select('+accountNumberEnc').lean<BankAccountDoc>();
  if (!doc) throw AppError.notFound('Bank account not found.');
  await auditFinance(f, undefined, { action: 'bank_account.number_revealed', entityType: 'bank_account', entityId: id, metadata: { reason, last4: doc.last4 } });
  return { bankAccountId: id, accountNumber: decryptField(doc.accountNumberEnc, bankContext(id)) };
}

// ───────────────────────────────────────────────────────────── cash

const toCashDTO = (c: CashAccountDoc): CashAccountDTO => ({ cashAccountId: c._id, label: c.label, glAccountId: c.glAccountId, locationIds: c.locationIds, status: c.status });

export async function listCashAccounts(ctx: ServiceContext): Promise<CashAccountDTO[]> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const rows = await CashAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ createdAt: 1 }).lean<CashAccountDoc[]>();
  return (scope.all ? rows : rows.filter((c) => c.locationIds.length === 0 || c.locationIds.some((id) => scope.locationIds.includes(id)))).map(toCashDTO);
}

export async function createCashAccount(ctx: ServiceContext, data: { label: string; glAccountId?: string | undefined; locationIds: string[] }): Promise<CashAccountDTO> {
  const f = await financeCtx(ctx);
  await checkLocations(ctx, data.locationIds);
  const gl = data.glAccountId ? (await ChartAccount.findOne({ _id: data.glAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<ChartAccountDoc>()) : await accountForRole(f, 'CASH');
  if (!gl) throw AppError.notFound('Account not found.');
  if (gl.type !== 'ASSET' || !gl.isPostable) throw AppError.validation({ glAccountId: 'Choose a detail asset account.' });
  const id = randomUUID();
  await withTransaction(async (db) => {
    await CashAccount.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, label: data.label, glAccountId: gl._id, locationIds: data.locationIds, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'cash_account.created', entityType: 'cash_account', entityId: id, after: { label: data.label } });
  });
  return toCashDTO((await CashAccount.findOne({ _id: id, tenantId: f.tenantId }).lean<CashAccountDoc>())!);
}

export async function updateCashAccount(ctx: ServiceContext, id: string, data: { label?: string | undefined; locationIds?: string[] | undefined; status?: 'ACTIVE' | 'INACTIVE' | undefined }): Promise<CashAccountDTO> {
  const f = await financeCtx(ctx);
  const before = await CashAccount.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<CashAccountDoc>();
  if (!before) throw AppError.notFound('Cash account not found.');
  if (data.locationIds) await checkLocations(ctx, data.locationIds);
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await withTransaction(async (db) => {
    await CashAccount.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'cash_account.updated', entityType: 'cash_account', entityId: id, before: { label: before.label, status: before.status }, after: patch });
  });
  return toCashDTO((await CashAccount.findOne({ _id: id, tenantId: f.tenantId }).lean<CashAccountDoc>())!);
}

