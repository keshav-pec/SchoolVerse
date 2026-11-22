import { randomUUID } from 'node:crypto';
import type {
  AccountingPeriodDTO, CreateFinancialYearData, FinanceAccessDTO, FinanceAuditEventDTO, FinancialYearDTO, FinanceBundle, LegalEntityDTO, SetFinanceAccessData, TaxProfileDTO, UpdateLegalEntityData, UpdateTaxProfileData,
} from '@shared';
import { TAX_EXAMPLE_NOTE } from '@shared';
import { AppError } from '../../../core/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { User } from '../../../platform/users/user.model';
import { auditFinance, emitFinance, financeCtx, monthRange, NUMBER_PREFIXES, stateNameFor } from './context';
import { AccessGrant, AccountingPeriod, FinanceAudit, FinanceCounter, FinancialYear, LegalEntity, type AccessGrantDoc, type AccountingPeriodDoc, type FinanceAuditDoc, type FinancialYearDoc, type LegalEntityDoc } from './models';

// ───────────────────────────────────────────────────────────── legal entity and tax profile (FIN-01, TAX-01)

export function toLegalEntityDTO(e: LegalEntityDoc): LegalEntityDTO {
  return { legalEntityId: e._id, name: e.name, legalForm: e.legalForm, pan: e.pan ? `XXXXX${e.pan.slice(5)}` : null, gstin: e.gstin, gstRegistered: e.gstRegistered, stateCode: e.stateCode, stateName: stateNameFor(e.stateCode), address: e.address, currency: 'INR', fyStartMonth: e.fyStartMonth, status: e.status };
}

export async function getLegalEntity(ctx: ServiceContext): Promise<LegalEntityDTO> {
  return toLegalEntityDTO((await financeCtx(ctx)).entity);
}

/** The first two digits of a GSTIN are the state. A mismatch is almost always a typing mistake, so it is refused. */
function assertGstinMatchesState(gstin: string | null | undefined, stateCode: string | null | undefined) {
  if (gstin && stateCode && gstin.slice(0, 2) !== stateCode) throw AppError.validation({ gstin: `This GSTIN starts with ${gstin.slice(0, 2)}, but the school's state code is ${stateCode}.` });
}

export async function updateLegalEntity(ctx: ServiceContext, data: UpdateLegalEntityData): Promise<LegalEntityDTO> {
  const f = await financeCtx(ctx);
  const next = { ...f.entity, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) } as LegalEntityDoc;
  assertGstinMatchesState(next.gstin, next.stateCode);
  if (data.fyStartMonth !== undefined && data.fyStartMonth !== f.entity.fyStartMonth && (await FinancialYear.exists({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }))) {
    throw new AppError('FINANCE_RECORD_LOCKED', 'The financial year start cannot change once a financial year exists.');
  }
  await withTransaction(async (db) => {
    await LegalEntity.updateOne({ _id: f.legalEntityId, tenantId: f.tenantId }, { $set: { ...data, updatedBy: ctx.userId } }, { session: db });
    const keys = Object.keys(data) as (keyof UpdateLegalEntityData)[];
    const identity = keys.some((k) => k === 'pan' || k === 'stateCode');
    await auditFinance(f, db, {
      action: identity ? 'legal_entity.tax_identity_changed' : 'legal_entity.updated', entityType: 'legal_entity', entityId: f.legalEntityId,
      before: Object.fromEntries(keys.map((k) => [k, f.entity[k as keyof LegalEntityDoc] ?? null])), after: data as Record<string, unknown>,
    });
  });
  return getLegalEntity(ctx);
}

export const toTaxProfileDTO = (e: LegalEntityDoc): TaxProfileDTO => ({ gstRegistered: e.gstRegistered, gstin: e.gstin, stateCode: e.stateCode, stateName: stateNameFor(e.stateCode), note: TAX_EXAMPLE_NOTE });

export async function getTaxProfile(ctx: ServiceContext): Promise<TaxProfileDTO> {
  return toTaxProfileDTO((await financeCtx(ctx)).entity);
}

export async function updateTaxProfile(ctx: ServiceContext, data: UpdateTaxProfileData): Promise<TaxProfileDTO> {
  const f = await financeCtx(ctx);
  const next = { gstRegistered: data.gstRegistered ?? f.entity.gstRegistered, gstin: data.gstin !== undefined ? data.gstin : f.entity.gstin, stateCode: data.stateCode !== undefined ? data.stateCode : f.entity.stateCode };
  if (next.gstRegistered && !next.gstin) throw AppError.validation({ gstin: 'Enter the GSTIN of a GST-registered school.' });
  assertGstinMatchesState(next.gstin, next.stateCode);
  await withTransaction(async (db) => {
    await LegalEntity.updateOne({ _id: f.legalEntityId, tenantId: f.tenantId }, { $set: { gstRegistered: next.gstRegistered, gstin: next.gstin, stateCode: next.stateCode, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, {
      action: 'tax_profile.changed', entityType: 'legal_entity', entityId: f.legalEntityId,
      before: { gstRegistered: f.entity.gstRegistered, gstinLast4: f.entity.gstin?.slice(-4) ?? null, stateCode: f.entity.stateCode }, after: { gstRegistered: next.gstRegistered, gstinLast4: next.gstin?.slice(-4) ?? null, stateCode: next.stateCode },
    });
  });
  return getTaxProfile(ctx);
}

// ───────────────────────────────────────────────────────────── financial years and periods (FIN-02)

const periodDTO = (p: AccountingPeriodDoc): AccountingPeriodDTO => ({ periodId: p._id, financialYearId: p.financialYearId, code: p.code, month: p.month, startDate: p.startDate, endDate: p.endDate, state: p.state });

function yearDTO(y: FinancialYearDoc, periods: AccountingPeriodDoc[]): FinancialYearDTO {
  return { financialYearId: y._id, code: y.code, startDate: y.startDate, endDate: y.endDate, periods: periods.filter((p) => p.financialYearId === y._id).sort((a, b) => a.startDate.localeCompare(b.startDate)).map(periodDTO) };
}

export async function listFinancialYears(ctx: ServiceContext): Promise<FinancialYearDTO[]> {
  const f = await financeCtx(ctx);
  const [years, periods] = await Promise.all([
    FinancialYear.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ startDate: 1 }).lean<FinancialYearDoc[]>(),
    AccountingPeriod.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<AccountingPeriodDoc[]>(),
  ]);
  return years.map((y) => yearDTO(y, periods));
}

export async function listPeriods(ctx: ServiceContext, query: { financialYearId?: string }): Promise<AccountingPeriodDTO[]> {
  const f = await financeCtx(ctx);
  const rows = await AccountingPeriod.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.financialYearId ? { financialYearId: query.financialYearId } : {}) }).sort({ startDate: 1 }).lean<AccountingPeriodDoc[]>();
  return rows.map(periodDTO);
}

/** Makes the year and its twelve monthly periods together, and starts a number counter for each paper type. */
export async function createFinancialYear(ctx: ServiceContext, data: CreateFinancialYearData): Promise<FinancialYearDTO> {
  const f = await financeCtx(ctx);
  const startYear = Number(data.code.slice(0, 4));
  const startMonth = f.entity.fyStartMonth;
  const startDate = `${startYear}-${String(startMonth).padStart(2, '0')}-01`;
  const endMonthKey = monthKeyAfter(startYear, startMonth, 11);
  const endDate = monthRange(endMonthKey).end;
  const clash = await FinancialYear.findOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, $or: [{ code: data.code }, { startDate: { $lte: endDate }, endDate: { $gte: startDate } }] }).lean<FinancialYearDoc>();
  if (clash) throw new AppError('FINANCE_CODE_TAKEN', clash.code === data.code ? 'This financial year already exists.' : `This overlaps the financial year ${clash.code}.`);

  const yearId = randomUUID();
  await withTransaction(async (db) => {
    const base = { tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId };
    await FinancialYear.create([{ _id: yearId, ...base, code: data.code, startDate, endDate }], { session: db });
    await AccountingPeriod.create(
      Array.from({ length: 12 }, (_, i) => {
        const key = monthKeyAfter(startYear, startMonth, i);
        const range = monthRange(key);
        return { ...base, financialYearId: yearId, fyCode: data.code, code: key, month: Number(key.slice(5, 7)), startDate: range.start, endDate: range.end, state: 'OPEN' };
      }),
      { session: db, ordered: true },
    );
    for (const prefix of NUMBER_PREFIXES) {
      await FinanceCounter.updateOne({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, key: `${prefix}:${data.code}` }, { $setOnInsert: { schoolId: f.schoolId, seq: 0 } }, { upsert: true, session: db });
    }
    await auditFinance(f, db, { action: 'financial_year.created', entityType: 'financial_year', entityId: yearId, after: { code: data.code, startDate, endDate } });
    await emitFinance(f, db, 'financial_year.created', { financialYearId: yearId, code: data.code });
  });
  return (await listFinancialYears(ctx)).find((y) => y.financialYearId === yearId)!;
}

function monthKeyAfter(startYear: number, startMonth: number, add: number): string {
  const index = startYear * 12 + (startMonth - 1) + add;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

// ───────────────────────────────────────────────────────────── finance access bundles (FIN-07)

async function accessDTO(user: { _id: string; fullName: string; email: string; role: FinanceAccessDTO['role'] }, grant: AccessGrantDoc | null): Promise<FinanceAccessDTO> {
  return { userId: user._id, fullName: user.fullName, email: user.email, role: user.role, bundles: (grant?.bundles ?? []) as FinanceBundle[], locationIds: grant?.locationIds ?? null };
}

export async function getAccess(ctx: ServiceContext, userId: string): Promise<FinanceAccessDTO> {
  const f = await financeCtx(ctx);
  const user = await User.findOne({ _id: userId, tenantId: f.tenantId }).select('fullName email role').lean<{ _id: string; fullName: string; email: string; role: FinanceAccessDTO['role'] }>();
  if (!user) throw AppError.notFound('User not found.');
  return accessDTO(user, await AccessGrant.findOne({ tenantId: f.tenantId, userId }).lean<AccessGrantDoc>());
}

export async function listAccess(ctx: ServiceContext): Promise<FinanceAccessDTO[]> {
  const f = await financeCtx(ctx);
  const [users, grants] = await Promise.all([
    User.find({ tenantId: f.tenantId, role: { $in: ['STAFF', 'SCHOOL_ADMIN'] }, status: { $ne: 'DISABLED' } }).sort({ fullName: 1 }).select('fullName email role').lean<{ _id: string; fullName: string; email: string; role: FinanceAccessDTO['role'] }[]>(),
    AccessGrant.find({ tenantId: f.tenantId }).lean<AccessGrantDoc[]>(),
  ]);
  const byUser = new Map(grants.map((g) => [g.userId, g]));
  return Promise.all(users.map((u) => accessDTO(u, byUser.get(u._id) ?? null)));
}

/** Only a Staff login can hold bundles (a School Admin already has everything, and Faculty and Parents never do). */
export async function setAccess(ctx: ServiceContext, userId: string, data: SetFinanceAccessData): Promise<FinanceAccessDTO> {
  const f = await financeCtx(ctx);
  const user = await User.findOne({ _id: userId, tenantId: f.tenantId }).select('fullName email role').lean<{ _id: string; fullName: string; email: string; role: FinanceAccessDTO['role'] }>();
  if (!user) throw AppError.notFound('User not found.');
  if (user.role !== 'STAFF') throw new AppError('CONFLICT', user.role === 'SCHOOL_ADMIN' ? 'A School Admin can already do everything in Finance.' : 'Only Staff logins can be given finance work.');
  const bundles = [...new Set(data.bundles)];
  const before = await AccessGrant.findOne({ tenantId: f.tenantId, userId }).lean<AccessGrantDoc>();
  await withTransaction(async (db) => {
    if (bundles.length === 0) await AccessGrant.deleteOne({ tenantId: f.tenantId, userId }, { session: db });
    else {
      await AccessGrant.updateOne(
        { tenantId: f.tenantId, userId },
        { $set: { bundles, locationIds: data.locationIds ?? null, grantedBy: ctx.userId, schoolId: f.schoolId, legalEntityId: f.legalEntityId }, $setOnInsert: { _id: randomUUID() } },
        { upsert: true, session: db },
      );
    }
    await auditFinance(f, db, { action: 'access.changed', entityType: 'finance_access', entityId: userId, before: { bundles: before?.bundles ?? [], locationIds: before?.locationIds ?? null }, after: { bundles, locationIds: data.locationIds ?? null } });
  });
  return getAccess(ctx, userId);
}

// ───────────────────────────────────────────────────────────── audit trail (FIN-08)

export async function listAudit(ctx: ServiceContext, query: { page: number; pageSize: number; entityType?: string | undefined; entityId?: string | undefined; action?: string | undefined; from?: string | null | undefined; to?: string | null | undefined }) {
  const f = await financeCtx(ctx);
  const filter: Record<string, unknown> = { tenantId: f.tenantId, legalEntityId: f.legalEntityId };
  if (query.entityType) filter.entityType = query.entityType;
  if (query.entityId) filter.entityId = query.entityId;
  if (query.action) filter.action = query.action;
  if (query.from || query.to) filter.occurredAt = { ...(query.from ? { $gte: new Date(`${query.from}T00:00:00Z`) } : {}), ...(query.to ? { $lte: new Date(`${query.to}T23:59:59Z`) } : {}) };
  const [rows, total] = await Promise.all([
    FinanceAudit.find(filter).sort({ occurredAt: -1, _id: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<FinanceAuditDoc[]>(),
    FinanceAudit.countDocuments(filter),
  ]);
  const users = await User.find({ tenantId: f.tenantId, _id: { $in: [...new Set(rows.map((r) => r.actorId).filter((x): x is string => !!x))] } }).select('fullName').lean<{ _id: string; fullName: string }[]>();
  const name = new Map(users.map((u) => [u._id, u.fullName]));
  const items: FinanceAuditEventDTO[] = rows.map((r) => ({
    auditId: r._id, actorId: r.actorId, actorName: r.actorId ? name.get(r.actorId) ?? null : 'System', action: r.action, entityType: r.entityType, entityId: r.entityId,
    before: r.before, after: r.after, correlationId: r.correlationId, occurredAt: new Date(r.occurredAt).toISOString(),
  }));
  return { items, total, page: query.page, pageSize: query.pageSize };
}
