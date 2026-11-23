import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { MAX_DOCUMENT_BYTES, type AgingBucket, type ExpenseCategoryDTO, type ExpenseDTO, type ItcStatus, type PayablesAgingDTO, type TaxLineDTO, type VendorBillDTO, type VendorDTO, type VendorPaymentDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { daysBetween } from '../../../core/dates';
import { duplicateKeyFields } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import { decryptField, encryptField, last4 as lastFour } from '../../../platform/identity/crypto';
import { scanFile, sniffDocumentType } from '../../../platform/identity/file-checks';
import { privateStorage } from '../../../platform/identity/private-storage';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { todayFor } from '../../staff/status';
import { mergeLines } from '../collections/alloc';
import { normRef } from '../collections/collection.service';
import { checkApproval, policyNeeds, registerApprovalExecutor } from '../core/approvals.service';
import { rolesMap } from '../core/chart.service';
import { assertInScope, auditFinance, emitFinance, financeCtx, financeScope, fyCodeFor, nextNumber, scopeFilter, type FinanceCtx } from '../core/context';
import { ApprovalPolicy, ApprovalRequest, BankAccount, CashAccount, ChartAccount, type ApprovalPolicyDoc, type BankAccountDoc, type CashAccountDoc } from '../core/models';
import { formatMoney } from '../core/money';
import { postJournal, reverseJournal, type PostLine } from '../core/posting';
import { registerMatchSource } from '../banking/sources';
import { calculateTax } from '../tax/tax';
import { Expense, ExpenseCategory, TaxLine, Vendor, VendorBill, VendorPayment, type ExpenseCategoryDoc, type ExpenseDoc, type TaxLineDoc, type VendorBillDoc, type VendorDoc, type VendorPaymentDoc } from './models';

/**
 * Expenses, vendors and their bills (FIN-13, 14; TAX-05, 06). The fast path is: amount, category, date, vendor, receipt. The system fills in the entity,
 * the period and the account from the category. Money posts only when the item is approved (if its policy needs that) AND every tax line has an
 * input-tax decision. Eligible input GST goes to the Input GST accounts; GST that cannot be claimed is added to the cost. A posted expense is
 * never edited: it is reversed and entered again.
 */

const DEFAULT_CATEGORIES: [string, string, string][] = [['RENT', 'Rent', '5200'], ['UTILITIES', 'Utilities', '5210'], ['MAINTENANCE', 'Repairs and Maintenance', '5220'], ['SUPPLIES', 'Supplies', '5230'], ['GENERAL', 'General Expenses', '5900']];

export async function ensureCategories(f: FinanceCtx, db?: ClientSession) {
  if (await ExpenseCategory.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null)) return;
  const accounts = new Map((await ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, code: { $in: DEFAULT_CATEGORIES.map((c) => c[2]) } }).session(db ?? null).select('code').lean<{ _id: string; code: string }[]>()).map((a) => [a.code, a._id]));
  for (const [code, name, acct] of DEFAULT_CATEGORIES) {
    const accountId = accounts.get(acct);
    if (accountId) await ExpenseCategory.updateOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, code }, { $setOnInsert: { schoolId: f.schoolId, name, accountId, defaultItcStatus: 'NEEDS_REVIEW', createdBy: f.userId } }, { upsert: true, session: db });
  }
}

const categoryDTO = (c: ExpenseCategoryDoc, accounts: Map<string, string>): ExpenseCategoryDTO => ({ categoryId: c._id, code: c.code, name: c.name, accountId: c.accountId, accountName: accounts.get(c.accountId) ?? null, defaultItcStatus: c.defaultItcStatus, status: c.status });

export async function listCategories(ctx: ServiceContext): Promise<ExpenseCategoryDTO[]> {
  const f = await financeCtx(ctx);
  await ensureCategories(f);
  const rows = await ExpenseCategory.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ name: 1 }).lean<ExpenseCategoryDoc[]>();
  const accounts = new Map((await ChartAccount.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.accountId) } }).select('name').lean<{ _id: string; name: string }[]>()).map((a) => [a._id, a.name]));
  return rows.map((r) => categoryDTO(r, accounts));
}

async function checkExpenseAccount(f: FinanceCtx, accountId: string) {
  const a = await ChartAccount.findOne({ _id: accountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<{ type: string; isPostable: boolean; status: string }>();
  if (!a) throw AppError.notFound('Account not found.');
  if (a.type !== 'EXPENSE' || !a.isPostable || a.status !== 'ACTIVE') throw AppError.validation({ accountId: 'Choose an active expense account.' });
}

export async function createCategory(ctx: ServiceContext, data: { code: string; name: string; accountId: string; defaultItcStatus: ItcStatus }): Promise<ExpenseCategoryDTO> {
  const f = await financeCtx(ctx);
  await ensureCategories(f);
  await checkExpenseAccount(f, data.accountId);
  try {
    const row = await withTransaction(async (db) => {
      const [c] = await ExpenseCategory.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, ...data, createdBy: ctx.userId }], { session: db });
      await auditFinance(f, db, { action: 'expense_category.created', entityType: 'expense_category', entityId: c!._id, after: { code: data.code } });
      return c!.toObject() as ExpenseCategoryDoc;
    });
    return categoryDTO(row, new Map());
  } catch (err) {
    if (duplicateKeyFields(err)) throw new AppError('FINANCE_CODE_TAKEN');
    throw err;
  }
}

export async function updateCategory(ctx: ServiceContext, id: string, data: { name?: string | undefined; accountId?: string | undefined; defaultItcStatus?: ItcStatus | undefined; status?: 'ACTIVE' | 'INACTIVE' | undefined }): Promise<ExpenseCategoryDTO> {
  const f = await financeCtx(ctx);
  if (!(await ExpenseCategory.exists({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }))) throw AppError.notFound('Category not found.');
  if (data.accountId) await checkExpenseAccount(f, data.accountId);
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await ExpenseCategory.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } });
  await auditFinance(f, undefined, { action: 'expense_category.updated', entityType: 'expense_category', entityId: id, after: patch });
  return categoryDTO((await ExpenseCategory.findOne({ _id: id, tenantId: f.tenantId }).lean<ExpenseCategoryDoc>())!, new Map());
}

// ───────────────────────────────────────────────────────────── vendors (FIN-14)

const vendorContext = (id: string) => `${id}:finance-vendor`;

async function vendorDTOs(f: FinanceCtx, rows: VendorDoc[]): Promise<VendorDTO[]> {
  const [owed, pending] = await Promise.all([
    VendorBill.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, vendorId: { $in: rows.map((r) => r._id) }, state: { $in: ['POSTED', 'PARTIALLY_PAID'] } }).select('vendorId balancePaise').lean<{ vendorId: string; balancePaise: number }[]>(),
    ApprovalRequest.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'VENDOR_BANK_CHANGE', decision: 'PENDING', entityId: { $in: rows.map((r) => r._id) } }).select('entityId').lean<{ _id: string; entityId: string }[]>(),
  ]);
  return rows.map((v) => ({
    vendorId: v._id, name: v.name, gstin: v.gstin, stateCode: v.stateCode, pan: v.pan ? `XXXXX${v.pan.slice(5)}` : null, contactName: v.contactName, phone: v.phone, bankAccountMasked: v.bankLast4 ? `••••${v.bankLast4}` : null, bankIfsc: v.bankIfsc, bankName: v.bankName, status: v.status,
    pendingApprovalId: pending.find((p) => p.entityId === v._id)?._id ?? null, payablePaise: owed.filter((o) => o.vendorId === v._id).reduce((s, o) => s + o.balancePaise, 0),
  }));
}

export async function listVendors(ctx: ServiceContext): Promise<VendorDTO[]> {
  const f = await financeCtx(ctx);
  return vendorDTOs(f, await Vendor.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ name: 1 }).lean<VendorDoc[]>());
}

export async function createVendor(ctx: ServiceContext, data: { name: string; gstin?: string | null | undefined; stateCode?: string | null | undefined; pan?: string | null | undefined; contactName?: string | null | undefined; phone?: string | null | undefined; bankAccountNumber?: string | undefined; bankIfsc?: string | undefined; bankName?: string | null | undefined }): Promise<VendorDTO> {
  const f = await financeCtx(ctx);
  if (data.gstin && data.stateCode && data.gstin.slice(0, 2) !== data.stateCode) throw AppError.validation({ gstin: 'The first two digits of the GSTIN must match the state code.' });
  const id = randomUUID();
  await withTransaction(async (db) => {
    await Vendor.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, name: data.name, gstin: data.gstin ?? null, stateCode: data.stateCode ?? data.gstin?.slice(0, 2) ?? null, pan: data.pan ?? null, contactName: data.contactName ?? null, phone: data.phone ?? null, bankAccountEnc: data.bankAccountNumber ? encryptField(data.bankAccountNumber, vendorContext(id)) : null, bankLast4: data.bankAccountNumber ? lastFour(data.bankAccountNumber) : null, bankIfsc: data.bankIfsc ?? null, bankName: data.bankName ?? null, createdBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'vendor.created', entityType: 'vendor', entityId: id, after: { name: data.name, gstin: data.gstin ? `…${data.gstin.slice(-4)}` : null, bankLast4: data.bankAccountNumber ? lastFour(data.bankAccountNumber) : null } });
  });
  return (await vendorDTOs(f, [(await Vendor.findOne({ _id: id, tenantId: f.tenantId }).lean<VendorDoc>())!]))[0]!;
}

/** A change to the bank account or IFSC needs a second person. The new number is sealed before it is kept on the request. */
export async function updateVendor(ctx: ServiceContext, id: string, data: { name?: string | undefined; gstin?: string | null | undefined; stateCode?: string | null | undefined; pan?: string | null | undefined; contactName?: string | null | undefined; phone?: string | null | undefined; bankAccountNumber?: string | undefined; bankIfsc?: string | undefined; bankName?: string | null | undefined; status?: 'ACTIVE' | 'INACTIVE' | undefined; approvalId?: string | undefined }): Promise<VendorDTO> {
  const f = await financeCtx(ctx);
  const before = await Vendor.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<VendorDoc>();
  if (!before) throw AppError.notFound('Vendor not found.');
  if (data.bankAccountNumber !== undefined || data.bankIfsc !== undefined) {
    await checkApproval(f, {
      action: 'VENDOR_BANK_CHANGE', entityType: 'vendor', entityId: id, amountPaise: 0, approvalId: data.approvalId, summary: `Change the bank details of ${before.name}`, impact: 'Future payments to this vendor would go to the new account.',
      payload: { ...(data.bankAccountNumber !== undefined ? { bankAccountEnc: encryptField(data.bankAccountNumber, vendorContext(id)), bankLast4: lastFour(data.bankAccountNumber) } : {}), ...(data.bankIfsc !== undefined ? { bankIfsc: data.bankIfsc } : {}) },
    });
  }
  const patch: Record<string, unknown> = { updatedBy: ctx.userId };
  for (const k of ['name', 'gstin', 'stateCode', 'pan', 'contactName', 'phone', 'bankName', 'status'] as const) if (data[k] !== undefined) patch[k] = data[k];
  await withTransaction(async (db) => {
    await Vendor.updateOne({ _id: id, tenantId: f.tenantId }, { $set: patch }, { session: db });
    await auditFinance(f, db, { action: 'vendor.updated', entityType: 'vendor', entityId: id, after: patch });
  });
  return (await vendorDTOs(f, [(await Vendor.findOne({ _id: id, tenantId: f.tenantId }).lean<VendorDoc>())!]))[0]!;
}

registerApprovalExecutor('VENDOR_BANK_CHANGE', async (f, db, request) => {
  const p = request.payload as { bankAccountEnc?: string; bankLast4?: string; bankIfsc?: string };
  const patch: Record<string, unknown> = {};
  if (p.bankAccountEnc) Object.assign(patch, { bankAccountEnc: p.bankAccountEnc, bankLast4: p.bankLast4 });
  if (p.bankIfsc) patch.bankIfsc = p.bankIfsc;
  await Vendor.updateOne({ _id: request.entityId, tenantId: f.tenantId }, { $set: patch }, { session: db });
  await auditFinance(f, db, { action: 'vendor.bank_changed', entityType: 'vendor', entityId: request.entityId ?? '', after: { bankLast4: p.bankLast4 ?? null, ifsc: p.bankIfsc ?? null }, metadata: { approvalId: request._id } });
});

export async function revealVendorBank(f: FinanceCtx, vendorId: string): Promise<string | null> {
  const v = await Vendor.findOne({ _id: vendorId, tenantId: f.tenantId }).select('+bankAccountEnc').lean<VendorDoc>();
  return v?.bankAccountEnc ? decryptField(v.bankAccountEnc, vendorContext(vendorId)) : null;
}

// ───────────────────────────────────────────────────────────── tax lines

interface TaxInput {
  taxableValuePaise: number;
  rateBps: number;
  itcStatus?: ItcStatus | undefined;
}

function taxOf(f: FinanceCtx, vendor: VendorDoc | null, input: TaxInput, fallback: ItcStatus) {
  const intra = !vendor?.stateCode || !f.entity.stateCode || vendor.stateCode === f.entity.stateCode;
  const t = calculateTax({ amountPaise: input.taxableValuePaise, priceMode: 'EXCLUSIVE', rateBps: input.rateBps, intraState: intra });
  return { ...t, itcStatus: input.rateBps > 0 ? input.itcStatus ?? fallback : ('NOT_ELIGIBLE' as ItcStatus) };
}

async function taxLineDTOs(f: FinanceCtx, rows: TaxLineDoc[]): Promise<TaxLineDTO[]> {
  const vendors = new Map((await Vendor.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.vendorId).filter((x): x is string => !!x) } }).select('name').lean<{ _id: string; name: string }[]>()).map((v) => [v._id, v.name]));
  return rows.map((r) => ({ lineId: r._id, sourceType: r.sourceType, sourceId: r.sourceId, sourceNumber: r.sourceNumber, date: r.date, vendorName: r.vendorId ? vendors.get(r.vendorId) ?? null : null, taxableValuePaise: r.taxableValuePaise, rateBps: r.rateBps, cgstPaise: r.cgstPaise, sgstPaise: r.sgstPaise, igstPaise: r.igstPaise, taxPaise: r.taxPaise, itcStatus: r.itcStatus, decisionReason: r.decisionReason }));
}

export async function listTaxLines(ctx: ServiceContext, query: { page: number; pageSize: number; itcStatus?: ItcStatus | undefined; month?: string | undefined }) {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, voided: false, ...scopeFilter(scope), ...(query.itcStatus ? { itcStatus: query.itcStatus } : {}), ...(query.month ? { month: query.month } : {}) };
  const [rows, total] = await Promise.all([TaxLine.find(filter).sort({ date: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<TaxLineDoc[]>(), TaxLine.countDocuments(filter)]);
  return { items: await taxLineDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

/** Eligible tax goes to the Input GST accounts; GST that cannot be claimed is added to the cost, so every rupee lands somewhere. */
function debitSides(lines: TaxLineDoc[], roles: Map<string, { _id: string }>) {
  const need = (role: string) => {
    const a = roles.get(role);
    if (!a) throw new AppError('FINANCE_NOT_READY', 'The chart of accounts is missing the Input GST accounts. Use the standard chart in Finance Settings.');
    return a._id;
  };
  const input: PostLine[] = [];
  let addedToCost = 0;
  for (const l of lines) {
    if (l.itcStatus === 'ELIGIBLE') {
      if (l.cgstPaise) input.push({ accountId: need('INPUT_CGST'), debitPaise: l.cgstPaise });
      if (l.sgstPaise) input.push({ accountId: need('INPUT_SGST'), debitPaise: l.sgstPaise });
      if (l.igstPaise) input.push({ accountId: need('INPUT_IGST'), debitPaise: l.igstPaise });
    } else addedToCost += l.taxPaise;
  }
  return { input, addedToCost };
}

// ───────────────────────────────────────────────────────────── expenses (FIN-13)

async function expenseDTOs(f: FinanceCtx, rows: ExpenseDoc[]): Promise<ExpenseDTO[]> {
  const [cats, vendors, users, lines] = await Promise.all([
    ExpenseCategory.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.categoryId) } }).select('name').lean<{ _id: string; name: string }[]>(),
    Vendor.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.vendorId).filter((x): x is string => !!x) } }).select('name').lean<{ _id: string; name: string }[]>(),
    User.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.createdBy) } }).select('fullName').lean<{ _id: string; fullName: string }[]>(),
    TaxLine.find({ tenantId: f.tenantId, sourceType: 'expense', sourceId: { $in: rows.map((r) => r._id) } }).lean<TaxLineDoc[]>(),
  ]);
  const dtoLines = await taxLineDTOs(f, lines);
  return rows.map((e) => {
    const mine = dtoLines.filter((l) => l.sourceId === e._id);
    return {
      expenseId: e._id, number: e.number, state: e.state, categoryId: e.categoryId, categoryName: cats.find((c) => c._id === e.categoryId)?.name ?? '', vendorId: e.vendorId, vendorName: vendors.find((v) => v._id === e.vendorId)?.name ?? null, locationId: e.locationId, date: e.date, description: e.description,
      taxableValuePaise: e.taxableValuePaise, taxPaise: e.taxPaise, totalPaise: e.totalPaise, paymentMode: e.paymentMode, needsApproval: e.needsApproval, approved: !e.needsApproval || Boolean(e.approvedBy), waitingForItc: mine.some((l) => l.itcStatus === 'NEEDS_REVIEW'),
      hasEvidence: Boolean(e.evidenceKey), journalId: e.journalId, createdByName: users.find((u) => u._id === e.createdBy)?.fullName ?? null, taxLines: mine, createdAt: e.createdAt.toISOString(),
    };
  });
}

/** Posts the expense when it is allowed to: approved if that is needed, and no tax line still waiting for a decision. Returns true when it posted. */
async function tryPostExpense(f: FinanceCtx, db: ClientSession, e: ExpenseDoc): Promise<boolean> {
  if (e.state !== 'PENDING') return false;
  const lines = await TaxLine.find({ tenantId: f.tenantId, sourceType: 'expense', sourceId: e._id, voided: false }).session(db).lean<TaxLineDoc[]>();
  if ((e.needsApproval && !e.approvedBy) || lines.some((l) => l.itcStatus === 'NEEDS_REVIEW')) return false;
  const category = await ExpenseCategory.findOne({ _id: e.categoryId, tenantId: f.tenantId }).session(db).lean<ExpenseCategoryDoc>();
  const roles = await rolesMap(f, db);
  const { input, addedToCost } = debitSides(lines, roles);
  let credit: string;
  if (e.paymentMode === 'BANK') credit = (await BankAccount.findOne({ _id: e.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<BankAccountDoc>())!.glAccountId;
  else if (e.paymentMode === 'CASH') credit = e.cashAccountId ? (await CashAccount.findOne({ _id: e.cashAccountId, tenantId: f.tenantId }).session(db).lean<CashAccountDoc>())!.glAccountId : roles.get('CASH')!._id;
  else credit = roles.get('VENDOR_PAYABLE')!._id;
  const at = { locationId: e.locationId };
  const { journal } = await postJournal(f, db, {
    eventType: 'expense.posted', sourceKey: `expense:${e._id}`, accountingDate: e.date, memo: `${e.number}: ${e.description}`, sourceType: 'expense', sourceId: e._id,
    lines: mergeLines([{ accountId: category!.accountId, debitPaise: e.taxableValuePaise + addedToCost, ...at }, ...input.map((l) => ({ ...l, ...at })), { accountId: credit, creditPaise: e.totalPaise, ...at, ...(e.paymentMode === 'UNPAID' ? { vendorId: e.vendorId } : {}) }]),
  });
  await Expense.updateOne({ _id: e._id, tenantId: f.tenantId, state: 'PENDING' }, { $set: { state: 'POSTED', journalId: journal._id } }, { session: db });
  await auditFinance(f, db, { action: 'expense.posted', entityType: 'expense', entityId: e._id, after: { number: e.number, totalPaise: e.totalPaise } });
  await emitFinance(f, db, 'expense.posted', { expenseId: e._id, number: e.number });
  return true;
}

export async function createExpense(ctx: ServiceContext, data: { categoryId: string; taxableValuePaise: number; date: string; description: string; vendorId?: string | undefined; locationId: string; paymentMode: ExpenseDoc['paymentMode']; bankAccountId?: string | undefined; cashAccountId?: string | undefined; gstRateBps: number; itcStatus?: ItcStatus | undefined }): Promise<ExpenseDTO> {
  const f = await financeCtx(ctx);
  await ensureCategories(f);
  await assertInScope(ctx, await financeScope(ctx), data.locationId, 'expense', data.locationId);
  const [category, vendor, policy] = await Promise.all([
    ExpenseCategory.findOne({ _id: data.categoryId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).lean<ExpenseCategoryDoc>(),
    data.vendorId ? Vendor.findOne({ _id: data.vendorId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).lean<VendorDoc>() : null,
    ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'EXPENSE' }).lean<ApprovalPolicyDoc>(),
  ]);
  if (!category) throw AppError.notFound('Expense category not found.');
  if (data.vendorId && !vendor) throw AppError.notFound('Vendor not found.');
  if (data.paymentMode === 'BANK' && !(await BankAccount.exists({ _id: data.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }))) throw AppError.notFound('Bank account not found.');
  const tax = taxOf(f, vendor, { taxableValuePaise: data.taxableValuePaise, rateBps: data.gstRateBps, itcStatus: data.itcStatus }, category.defaultItcStatus);
  const total = data.taxableValuePaise + tax.taxPaise;
  const id = randomUUID();
  const row = await withTransaction(async (db) => {
    const number = await nextNumber(f, db, 'EXP', fyCodeFor(data.date, f.entity.fyStartMonth));
    const [e] = await Expense.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, number, categoryId: data.categoryId, vendorId: data.vendorId ?? null, locationId: data.locationId, date: data.date, description: data.description, taxableValuePaise: data.taxableValuePaise, taxPaise: tax.taxPaise, totalPaise: total, paymentMode: data.paymentMode, bankAccountId: data.bankAccountId ?? null, cashAccountId: data.cashAccountId ?? null, needsApproval: policyNeeds(policy, total), createdBy: ctx.userId }], { session: db });
    if (data.gstRateBps > 0) await TaxLine.create([{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, sourceType: 'expense', sourceId: id, sourceNumber: number, vendorId: data.vendorId ?? null, locationId: data.locationId, date: data.date, month: data.date.slice(0, 7), taxableValuePaise: data.taxableValuePaise, rateBps: data.gstRateBps, cgstPaise: tax.cgstPaise, sgstPaise: tax.sgstPaise, igstPaise: tax.igstPaise, taxPaise: tax.taxPaise, itcStatus: tax.itcStatus }], { session: db });
    await auditFinance(f, db, { action: 'expense.recorded', entityType: 'expense', entityId: id, after: { number, totalPaise: total, needsApproval: policyNeeds(policy, total) } });
    await tryPostExpense(f, db, e!.toObject() as ExpenseDoc);
    return (await Expense.findOne({ _id: id, tenantId: f.tenantId }).session(db).lean<ExpenseDoc>())!;
  });
  return (await expenseDTOs(f, [row]))[0]!;
}

async function scopedExpense(ctx: ServiceContext, f: FinanceCtx, id: string, db?: ClientSession): Promise<ExpenseDoc> {
  const e = await Expense.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<ExpenseDoc>();
  const scope = await financeScope(ctx, db);
  if (!e || (!scope.all && !scope.locationIds.includes(e.locationId))) throw AppError.notFound('Expense not found.');
  return e;
}

export async function listExpenses(ctx: ServiceContext, query: { page: number; pageSize: number; state?: string | undefined; categoryId?: string | undefined; vendorId?: string | undefined; from?: string | null | undefined; to?: string | null | undefined; locationId?: string | undefined }) {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter: Record<string, unknown> = {
    tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.locationId ? { locationId: query.locationId } : scopeFilter(scope)), ...(query.state ? { state: { $in: query.state.split(',') } } : {}), ...(query.categoryId ? { categoryId: query.categoryId } : {}), ...(query.vendorId ? { vendorId: query.vendorId } : {}),
    ...(query.from || query.to ? { date: { ...(query.from ? { $gte: query.from } : {}), ...(query.to ? { $lte: query.to } : {}) } } : {}),
  };
  if (query.locationId) await assertInScope(ctx, scope, query.locationId, 'expense', query.locationId);
  const [rows, total] = await Promise.all([Expense.find(filter).sort({ date: -1, number: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<ExpenseDoc[]>(), Expense.countDocuments(filter)]);
  return { items: await expenseDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function getExpense(ctx: ServiceContext, id: string): Promise<ExpenseDTO> {
  const f = await financeCtx(ctx);
  return (await expenseDTOs(f, [await scopedExpense(ctx, f, id)]))[0]!;
}

export async function approveExpense(ctx: ServiceContext, id: string): Promise<ExpenseDTO> {
  const f = await financeCtx(ctx);
  const first = await scopedExpense(ctx, f, id);
  const policy = await ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'EXPENSE' }).lean<ApprovalPolicyDoc>();
  if (first.createdBy === ctx.userId && (policy?.needsDifferentApprover ?? true)) throw new AppError('SELF_APPROVAL_BLOCKED');
  await withTransaction(async (db) => {
    const e = await scopedExpense(ctx, f, id, db);
    if (e.state !== 'PENDING') throw new AppError('COLLECTION_STATE_INVALID', 'This expense was already decided.');
    if (await TaxLine.exists({ tenantId: f.tenantId, sourceType: 'expense', sourceId: id, voided: false, itcStatus: 'NEEDS_REVIEW' }).session(db)) throw new AppError('ITC_REVIEW_REQUIRED');
    await Expense.updateOne({ _id: id, tenantId: f.tenantId, state: 'PENDING' }, { $set: { approvedBy: ctx.userId, approvedAt: new Date() } }, { session: db });
    await tryPostExpense(f, db, { ...e, approvedBy: ctx.userId });
    await auditFinance(f, db, { action: 'expense.approved', entityType: 'expense', entityId: id });
  });
  return getExpense(ctx, id);
}

export async function rejectExpense(ctx: ServiceContext, id: string, reason: string): Promise<ExpenseDTO> {
  const f = await financeCtx(ctx);
  await scopedExpense(ctx, f, id);
  const res = await Expense.updateOne({ _id: id, tenantId: f.tenantId, state: 'PENDING' }, { $set: { state: 'REJECTED', rejectReason: reason } });
  if (res.modifiedCount !== 1) throw new AppError('COLLECTION_STATE_INVALID', 'Only an expense that is waiting can be rejected.');
  await TaxLine.updateMany({ tenantId: f.tenantId, sourceType: 'expense', sourceId: id }, { $set: { voided: true } });
  await auditFinance(f, undefined, { action: 'expense.rejected', entityType: 'expense', entityId: id, after: { reason } });
  return getExpense(ctx, id);
}

/** A posted expense is corrected by reversing it and entering a new one. */
export async function reverseExpense(ctx: ServiceContext, id: string, reason: string): Promise<ExpenseDTO> {
  const f = await financeCtx(ctx);
  await scopedExpense(ctx, f, id);
  await withTransaction(async (db) => {
    const e = await scopedExpense(ctx, f, id, db);
    if (e.state !== 'POSTED' || !e.journalId) throw new AppError('COLLECTION_STATE_INVALID', 'Only a posted expense can be reversed.');
    await reverseJournal(f, db, e.journalId, reason, { sourceKey: `expense_rev:${id}` });
    await Expense.updateOne({ _id: id, tenantId: f.tenantId, state: 'POSTED' }, { $set: { state: 'REVERSED', reversalReason: reason } }, { session: db });
    await TaxLine.updateMany({ tenantId: f.tenantId, sourceType: 'expense', sourceId: id }, { $set: { voided: true } }, { session: db });
    await auditFinance(f, db, { action: 'expense.reversed', entityType: 'expense', entityId: id, after: { reason } });
  });
  return getExpense(ctx, id);
}

export async function attachEvidence(ctx: ServiceContext, kind: 'expense', id: string, file: { buffer: Buffer } | undefined): Promise<ExpenseDTO> {
  if (!file) throw AppError.validation({ file: 'Choose a file to upload.' });
  const f = await financeCtx(ctx);
  const e = await scopedExpense(ctx, f, id);
  if (file.buffer.length > MAX_DOCUMENT_BYTES) throw new AppError('DOCUMENT_TOO_LARGE');
  if (!sniffDocumentType(file.buffer)) throw new AppError('UNSUPPORTED_DOCUMENT_TYPE');
  if (!(await scanFile(file.buffer)).clean) throw new AppError('FILE_REJECTED');
  const key = await privateStorage.put(file.buffer, { folder: 'finance' });
  if (e.evidenceKey) await privateStorage.remove(e.evidenceKey);
  await Expense.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { evidenceKey: key } });
  await auditFinance(f, undefined, { action: 'expense.evidence_added', entityType: 'expense', entityId: id });
  void kind;
  return getExpense(ctx, id);
}

export async function expenseEvidence(ctx: ServiceContext, id: string): Promise<{ buffer: Buffer; mime: string }> {
  const f = await financeCtx(ctx);
  const e = await scopedExpense(ctx, f, id);
  const buffer = e.evidenceKey ? await privateStorage.read(e.evidenceKey) : null;
  if (!buffer) throw AppError.notFound('No receipt was uploaded.');
  await auditFinance(f, undefined, { action: 'expense.evidence_viewed', entityType: 'expense', entityId: id });
  return { buffer, mime: sniffDocumentType(buffer) ?? 'application/octet-stream' };
}

// ───────────────────────────────────────────────────────────── input tax decisions (TAX-06)

export async function reviewItc(ctx: ServiceContext, data: { lineIds: string[]; decision: 'ELIGIBLE' | 'NOT_ELIGIBLE'; reason: string }): Promise<{ decided: number; posted: number }> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  let posted = 0;
  const decided = await withTransaction(async (db) => {
    const lines = await TaxLine.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: data.lineIds }, voided: false }).session(db).lean<TaxLineDoc[]>();
    if (lines.length !== new Set(data.lineIds).size) throw AppError.notFound('Tax line not found.');
    for (const l of lines) {
      await assertInScope(ctx, scope, l.locationId, 'tax_line', l._id);
      if (l.itcStatus !== 'NEEDS_REVIEW') throw new AppError('COLLECTION_STATE_INVALID', 'This tax line was already decided. A posted entry is corrected by reversing it.');
    }
    await TaxLine.updateMany({ tenantId: f.tenantId, _id: { $in: lines.map((l) => l._id) }, itcStatus: 'NEEDS_REVIEW' }, { $set: { itcStatus: data.decision, decidedBy: ctx.userId, decisionReason: data.reason } }, { session: db });
    await auditFinance(f, db, { action: 'itc.decided', entityType: 'tax_line', entityId: lines[0]!._id, after: { decision: data.decision, lines: lines.length, reason: data.reason } });
    for (const sourceId of new Set(lines.map((l) => `${l.sourceType}:${l.sourceId}`))) {
      const [type, id] = sourceId.split(':') as ['expense' | 'vendor_bill', string];
      if (type === 'expense') { const e = await Expense.findOne({ _id: id, tenantId: f.tenantId }).session(db).lean<ExpenseDoc>(); if (e && (await tryPostExpense(f, db, e))) posted += 1; }
      else { const b = await VendorBill.findOne({ _id: id, tenantId: f.tenantId }).session(db).lean<VendorBillDoc>(); if (b && (await tryPostBill(f, db, b))) posted += 1; }
    }
    return lines.length;
  });
  return { decided, posted };
}

// ───────────────────────────────────────────────────────────── vendor bills (FIN-14)

async function billDTOs(f: FinanceCtx, rows: VendorBillDoc[]): Promise<VendorBillDTO[]> {
  const [vendors, lines] = await Promise.all([Vendor.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.vendorId) } }).select('name').lean<{ _id: string; name: string }[]>(), TaxLine.find({ tenantId: f.tenantId, sourceType: 'vendor_bill', sourceId: { $in: rows.map((r) => r._id) } }).lean<TaxLineDoc[]>()]);
  const tl = await taxLineDTOs(f, lines);
  return rows.map((b) => ({
    billId: b._id, number: b.number, vendorId: b.vendorId, vendorName: vendors.find((v) => v._id === b.vendorId)?.name ?? '', vendorBillNumber: b.vendorBillNumber, state: b.state, date: b.date, dueDate: b.dueDate, lines: b.lines, taxableValuePaise: b.taxableValuePaise, taxPaise: b.taxPaise,
    totalPaise: b.totalPaise, paidPaise: b.paidPaise, balancePaise: b.balancePaise, needsApproval: b.needsApproval, approved: !b.needsApproval || Boolean(b.approvedBy), waitingForItc: tl.some((l) => l.sourceId === b._id && l.itcStatus === 'NEEDS_REVIEW'), locationId: b.locationId, journalId: b.journalId, taxLines: tl.filter((l) => l.sourceId === b._id),
  }));
}

async function tryPostBill(f: FinanceCtx, db: ClientSession, b: VendorBillDoc): Promise<boolean> {
  if (b.state !== 'PENDING') return false;
  const lines = await TaxLine.find({ tenantId: f.tenantId, sourceType: 'vendor_bill', sourceId: b._id, voided: false }).session(db).lean<TaxLineDoc[]>();
  if ((b.needsApproval && !b.approvedBy) || lines.some((l) => l.itcStatus === 'NEEDS_REVIEW')) return false;
  const roles = await rolesMap(f, db);
  const cats = new Map((await ExpenseCategory.find({ tenantId: f.tenantId, _id: { $in: b.lines.map((l) => l.categoryId) } }).session(db).lean<ExpenseCategoryDoc[]>()).map((c) => [c._id, c]));
  const debits: PostLine[] = [];
  b.lines.forEach((l, i) => {
    const tl = lines.find((x) => x.sourceNumber === `${b.number}#${i + 1}`);
    debits.push({ accountId: cats.get(l.categoryId)!.accountId, debitPaise: l.taxableValuePaise + (tl && tl.itcStatus !== 'ELIGIBLE' ? tl.taxPaise : 0), locationId: b.locationId });
  });
  const { input } = debitSides(lines, roles);
  const { journal } = await postJournal(f, db, { eventType: 'vendor_bill.posted', sourceKey: `vendor_bill:${b._id}`, accountingDate: b.date, memo: `${b.number}: vendor bill ${b.vendorBillNumber}`, sourceType: 'vendor_bill', sourceId: b._id, lines: mergeLines([...debits, ...input.map((l) => ({ ...l, locationId: b.locationId })), { accountId: roles.get('VENDOR_PAYABLE')!._id, creditPaise: b.totalPaise, vendorId: b.vendorId, locationId: b.locationId }]) });
  await VendorBill.updateOne({ _id: b._id, tenantId: f.tenantId, state: 'PENDING' }, { $set: { state: 'POSTED', journalId: journal._id } }, { session: db });
  await auditFinance(f, db, { action: 'vendor_bill.posted', entityType: 'vendor_bill', entityId: b._id, after: { number: b.number, totalPaise: b.totalPaise } });
  return true;
}

export async function createVendorBill(ctx: ServiceContext, data: { vendorId: string; vendorBillNumber: string; date: string; dueDate: string; locationId: string; lines: { description: string; categoryId: string; taxableValuePaise: number; gstRateBps: number; itcStatus?: ItcStatus | undefined }[] }): Promise<VendorBillDTO> {
  const f = await financeCtx(ctx);
  await ensureCategories(f);
  await assertInScope(ctx, await financeScope(ctx), data.locationId, 'vendor_bill', data.locationId);
  const vendor = await Vendor.findOne({ _id: data.vendorId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).lean<VendorDoc>();
  if (!vendor) throw AppError.notFound('Vendor not found.');
  const cats = new Map((await ExpenseCategory.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: data.lines.map((l) => l.categoryId) } }).lean<ExpenseCategoryDoc[]>()).map((c) => [c._id, c]));
  const policy = await ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'VENDOR_BILL' }).lean<ApprovalPolicyDoc>();
  const computed = data.lines.map((l) => {
    const c = cats.get(l.categoryId);
    if (!c) throw AppError.validation({ lines: 'An expense category was not found.' });
    return { l, tax: taxOf(f, vendor, { taxableValuePaise: l.taxableValuePaise, rateBps: l.gstRateBps, itcStatus: l.itcStatus }, c.defaultItcStatus) };
  });
  const taxable = computed.reduce((s, c) => s + c.l.taxableValuePaise, 0);
  const tax = computed.reduce((s, c) => s + c.tax.taxPaise, 0);
  const id = randomUUID();
  try {
    const row = await withTransaction(async (db) => {
      const number = await nextNumber(f, db, 'VBL', fyCodeFor(data.date, f.entity.fyStartMonth));
      const [b] = await VendorBill.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, number, vendorId: data.vendorId, vendorBillNumber: data.vendorBillNumber, date: data.date, dueDate: data.dueDate, locationId: data.locationId, lines: computed.map((c) => ({ description: c.l.description, categoryId: c.l.categoryId, taxableValuePaise: c.l.taxableValuePaise, rateBps: c.l.gstRateBps, taxPaise: c.tax.taxPaise })), taxableValuePaise: taxable, taxPaise: tax, totalPaise: taxable + tax, balancePaise: taxable + tax, needsApproval: policyNeeds(policy, taxable + tax), createdBy: ctx.userId }], { session: db });
      const taxLines = computed.flatMap((c, i) => (c.l.gstRateBps > 0 ? [{ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, sourceType: 'vendor_bill' as const, sourceId: id, sourceNumber: `${number}#${i + 1}`, vendorId: data.vendorId, locationId: data.locationId, date: data.date, month: data.date.slice(0, 7), taxableValuePaise: c.l.taxableValuePaise, rateBps: c.l.gstRateBps, cgstPaise: c.tax.cgstPaise, sgstPaise: c.tax.sgstPaise, igstPaise: c.tax.igstPaise, taxPaise: c.tax.taxPaise, itcStatus: c.tax.itcStatus }] : []));
      if (taxLines.length) await TaxLine.create(taxLines, { session: db, ordered: true });
      await auditFinance(f, db, { action: 'vendor_bill.recorded', entityType: 'vendor_bill', entityId: id, after: { number, totalPaise: taxable + tax } });
      await tryPostBill(f, db, b!.toObject() as VendorBillDoc);
      return (await VendorBill.findOne({ _id: id, tenantId: f.tenantId }).session(db).lean<VendorBillDoc>())!;
    });
    return (await billDTOs(f, [row]))[0]!;
  } catch (err) {
    if (duplicateKeyFields(err)) throw new AppError('CONFLICT', 'This vendor bill number was already entered for this vendor.');
    throw err;
  }
}

async function scopedBill(ctx: ServiceContext, f: FinanceCtx, id: string, db?: ClientSession): Promise<VendorBillDoc> {
  const b = await VendorBill.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<VendorBillDoc>();
  const scope = await financeScope(ctx, db);
  if (!b || (!scope.all && !scope.locationIds.includes(b.locationId))) throw AppError.notFound('Vendor bill not found.');
  return b;
}

export async function listVendorBills(ctx: ServiceContext, query: { page: number; pageSize: number; state?: string | undefined; vendorId?: string | undefined; open?: boolean | undefined }) {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope), ...(query.state ? { state: { $in: query.state.split(',') } } : {}), ...(query.vendorId ? { vendorId: query.vendorId } : {}), ...(query.open ? { state: { $in: ['POSTED', 'PARTIALLY_PAID'] } } : {}) };
  const [rows, total] = await Promise.all([VendorBill.find(filter).sort({ date: -1, number: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<VendorBillDoc[]>(), VendorBill.countDocuments(filter)]);
  return { items: await billDTOs(f, rows), total, page: query.page, pageSize: query.pageSize };
}

export async function approveVendorBill(ctx: ServiceContext, id: string): Promise<VendorBillDTO> {
  const f = await financeCtx(ctx);
  const first = await scopedBill(ctx, f, id);
  const policy = await ApprovalPolicy.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, action: 'VENDOR_BILL' }).lean<ApprovalPolicyDoc>();
  if (first.createdBy === ctx.userId && (policy?.needsDifferentApprover ?? true)) throw new AppError('SELF_APPROVAL_BLOCKED');
  await withTransaction(async (db) => {
    const b = await scopedBill(ctx, f, id, db);
    if (b.state !== 'PENDING') throw new AppError('COLLECTION_STATE_INVALID', 'This bill was already decided.');
    if (await TaxLine.exists({ tenantId: f.tenantId, sourceType: 'vendor_bill', sourceId: id, voided: false, itcStatus: 'NEEDS_REVIEW' }).session(db)) throw new AppError('ITC_REVIEW_REQUIRED');
    await VendorBill.updateOne({ _id: id, tenantId: f.tenantId, state: 'PENDING' }, { $set: { approvedBy: ctx.userId, approvedAt: new Date() } }, { session: db });
    await tryPostBill(f, db, { ...b, approvedBy: ctx.userId });
    await auditFinance(f, db, { action: 'vendor_bill.approved', entityType: 'vendor_bill', entityId: id });
  });
  return (await billDTOs(f, [(await VendorBill.findOne({ _id: id, tenantId: f.tenantId }).lean<VendorBillDoc>())!]))[0]!;
}

export async function reverseVendorBill(ctx: ServiceContext, id: string, reason: string): Promise<VendorBillDTO> {
  const f = await financeCtx(ctx);
  await withTransaction(async (db) => {
    const b = await scopedBill(ctx, f, id, db);
    if (b.state !== 'POSTED' || b.paidPaise > 0 || !b.journalId) throw new AppError('COLLECTION_STATE_INVALID', 'Only a posted bill with no payment against it can be reversed.');
    await reverseJournal(f, db, b.journalId, reason, { sourceKey: `vendor_bill_rev:${id}` });
    await VendorBill.updateOne({ _id: id, tenantId: f.tenantId, state: 'POSTED', paidPaise: 0 }, { $set: { state: 'REVERSED', balancePaise: 0 } }, { session: db });
    await TaxLine.updateMany({ tenantId: f.tenantId, sourceType: 'vendor_bill', sourceId: id }, { $set: { voided: true } }, { session: db });
    await auditFinance(f, db, { action: 'vendor_bill.reversed', entityType: 'vendor_bill', entityId: id, after: { reason } });
  });
  return (await billDTOs(f, [(await VendorBill.findOne({ _id: id, tenantId: f.tenantId }).lean<VendorBillDoc>())!]))[0]!;
}

// ───────────────────────────────────────────────────────────── paying a vendor (recorded after the school has paid through its bank)

export async function createVendorPayment(ctx: ServiceContext, data: { vendorId: string; bankAccountId: string; paidOn?: string | null | undefined; reference: string; allocations: { billId: string; amountPaise: number }[] }): Promise<VendorPaymentDTO> {
  const f = await financeCtx(ctx);
  const date = data.paidOn ?? (await todayFor(ctx));
  const total = data.allocations.reduce((s, a) => s + a.amountPaise, 0);
  const payment = await withTransaction(async (db) => {
    const vendor = await Vendor.findOne({ _id: data.vendorId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db).lean<VendorDoc>();
    if (!vendor) throw AppError.notFound('Vendor not found.');
    const bank = await BankAccount.findOne({ _id: data.bankAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId, status: 'ACTIVE' }).session(db).lean<BankAccountDoc>();
    if (!bank) throw AppError.notFound('Bank account not found.');
    if (new Set(data.allocations.map((a) => a.billId)).size !== data.allocations.length) throw AppError.validation({ allocations: 'Each bill can be listed once.' });
    for (const a of data.allocations) {
      const b = await scopedBill(ctx, f, a.billId, db);
      if (b.vendorId !== data.vendorId) throw new AppError('ALLOCATION_INVALID', 'That bill belongs to a different vendor.');
      if (!['POSTED', 'PARTIALLY_PAID'].includes(b.state)) throw new AppError('ALLOCATION_INVALID', `Bill ${b.number} is not open for payment.`);
      if (a.amountPaise > b.balancePaise) throw new AppError('ALLOCATION_INVALID', `Bill ${b.number} has only ${formatMoney(b.balancePaise)} left to pay.`);
      const moved = await VendorBill.updateOne({ _id: b._id, tenantId: f.tenantId, balancePaise: { $gte: a.amountPaise } }, { $inc: { balancePaise: -a.amountPaise, paidPaise: a.amountPaise } }, { session: db });
      if (moved.modifiedCount !== 1) throw new AppError('ALLOCATION_CONFLICT');
      await VendorBill.updateOne({ _id: b._id, tenantId: f.tenantId }, { $set: { state: b.balancePaise - a.amountPaise === 0 ? 'PAID' : 'PARTIALLY_PAID' } }, { session: db });
    }
    const number = await nextNumber(f, db, 'VPY', fyCodeFor(date, f.entity.fyStartMonth));
    const roles = await rolesMap(f, db);
    const id = randomUUID();
    const { journal } = await postJournal(f, db, { eventType: 'vendor_payment.posted', sourceKey: `vendor_payment:${id}`, accountingDate: date, memo: `${number}: payment to ${vendor.name} (${data.reference})`, sourceType: 'vendor_payment', sourceId: id, lines: [{ accountId: roles.get('VENDOR_PAYABLE')!._id, debitPaise: total, vendorId: vendor._id }, { accountId: bank.glAccountId, creditPaise: total }] });
    const [p] = await VendorPayment.create([{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, number, vendorId: data.vendorId, bankAccountId: data.bankAccountId, amountPaise: total, paidOn: date, reference: data.reference, referenceNorm: normRef(data.reference), allocations: data.allocations, journalId: journal._id, createdBy: ctx.userId }], { session: db });
    await auditFinance(f, db, { action: 'vendor_payment.recorded', entityType: 'vendor_payment', entityId: id, after: { number, totalPaise: total, bills: data.allocations.length } });
    return p!.toObject() as VendorPaymentDoc;
  });
  return (await paymentDTOs(f, [payment]))[0]!;
}

async function paymentDTOs(f: FinanceCtx, rows: VendorPaymentDoc[]): Promise<VendorPaymentDTO[]> {
  const [vendors, bills] = await Promise.all([Vendor.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.vendorId) } }).select('name').lean<{ _id: string; name: string }[]>(), VendorBill.find({ tenantId: f.tenantId, _id: { $in: rows.flatMap((r) => r.allocations.map((a) => a.billId)) } }).select('number').lean<{ _id: string; number: string }[]>()]);
  return rows.map((p) => ({ paymentId: p._id, number: p.number, vendorId: p.vendorId, vendorName: vendors.find((v) => v._id === p.vendorId)?.name ?? '', bankAccountId: p.bankAccountId, amountPaise: p.amountPaise, paidOn: p.paidOn, reference: p.reference, allocations: p.allocations.map((a) => ({ billId: a.billId, billNumber: bills.find((b) => b._id === a.billId)?.number ?? '', amountPaise: a.amountPaise })), journalId: p.journalId }));
}

export async function listVendorPayments(ctx: ServiceContext, vendorId?: string): Promise<VendorPaymentDTO[]> {
  const f = await financeCtx(ctx);
  return paymentDTOs(f, await VendorPayment.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(vendorId ? { vendorId } : {}) }).sort({ paidOn: -1, createdAt: -1 }).limit(100).lean<VendorPaymentDoc[]>());
}

const bucketOf = (daysLate: number): AgingBucket => (daysLate <= 0 ? 'CURRENT' : daysLate <= 30 ? 'D1_30' : daysLate <= 60 ? 'D31_60' : daysLate <= 90 ? 'D61_90' : 'D90_PLUS');

export async function payablesAging(ctx: ServiceContext, query: { asOf?: string | null | undefined }): Promise<PayablesAgingDTO> {
  const f = await financeCtx(ctx);
  const scope = await financeScope(ctx);
  const asOf = query.asOf ?? (await todayFor(ctx));
  const rows = await VendorBill.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...scopeFilter(scope), state: { $in: ['POSTED', 'PARTIALLY_PAID'] }, balancePaise: { $gt: 0 } }).sort({ dueDate: 1 }).lean<VendorBillDoc[]>();
  const vendors = new Map((await Vendor.find({ tenantId: f.tenantId, _id: { $in: rows.map((r) => r.vendorId) } }).select('name').lean<{ _id: string; name: string }[]>()).map((v) => [v._id, v.name]));
  const list = rows.map((b) => ({ billId: b._id, number: b.number, vendorName: vendors.get(b.vendorId) ?? '', dueDate: b.dueDate, balancePaise: b.balancePaise, bucket: bucketOf(daysBetween(b.dueDate, asOf)) }));
  const buckets = (['CURRENT', 'D1_30', 'D31_60', 'D61_90', 'D90_PLUS'] as AgingBucket[]).map((bucket) => ({ bucket, count: list.filter((r) => r.bucket === bucket).length, totalPaise: list.filter((r) => r.bucket === bucket).reduce((s, r) => s + r.balancePaise, 0) }));
  return { asOf, buckets, totalPaise: list.reduce((s, r) => s + r.balancePaise, 0), rows: list };
}

// ───────────────────────────────────────────────────────────── bank-side items for reconciliation

registerMatchSource({
  type: 'vendor_payment',
  async list(f, bankAccountId, db) {
    const rows = await VendorPayment.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId }).session(db ?? null).lean<VendorPaymentDoc[]>();
    return rows.map((p) => ({ type: 'vendor_payment', id: p._id, side: 'OUT' as const, amountPaise: p.amountPaise, date: p.paidOn, reference: p.reference, referenceNorm: p.referenceNorm, payer: null, label: `Vendor payment ${p.number}`, verified: true }));
  },
});
registerMatchSource({
  type: 'expense',
  async list(f, bankAccountId, db) {
    const rows = await Expense.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, bankAccountId, paymentMode: 'BANK', state: 'POSTED' }).session(db ?? null).lean<ExpenseDoc[]>();
    return rows.map((e) => ({ type: 'expense', id: e._id, side: 'OUT' as const, amountPaise: e.totalPaise, date: e.date, reference: e.number, referenceNorm: null, payer: null, label: `Expense ${e.number}`, verified: true }));
  },
});

export { ApprovalRequest };
