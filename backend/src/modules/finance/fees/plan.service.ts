import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type {
  CreateFeeHeadData, CreateFeePlanData, FeeHeadDTO, FeePlanDTO, FeePlanItemData, FeePlanItemDTO, FeePlanVersionDTO, PlanValidationDTO, PlanVersionState, UpdateFeeHeadData,
} from '@shared';
import { AppError } from '../../../core/errors';
import { onDuplicate } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { AcademicSession, AcademicTerm } from '../../academic/session.model';
import { todayFor } from '../../staff/status';
import { ChartAccount, TaxCode, type ChartAccountDoc, type TaxCodeDoc } from '../core/models';
import { auditFinance, emitFinance, financeCtx, type FinanceCtx } from '../core/context';
import { StudentEnrollment } from '../../students/student.models';
import { ClassOffering } from '../../academic/offering.model';
import { occurrencesIn } from './schedule';
import { FeeDocumentLine, FeeHead, FeePlan, FeePlanItem, FeePlanVersion, StudentFeeAssignment, type FeeHeadDoc, type FeePlanDoc, type FeePlanItemDoc, type FeePlanVersionDoc } from './models';

// ───────────────────────────────────────────────────────────── fee heads (FEE-01)

async function toHeadDTOs(f: FinanceCtx, rows: FeeHeadDoc[]): Promise<FeeHeadDTO[]> {
  const [accounts, codes, usedInPlans, usedInBills] = await Promise.all([
    ChartAccount.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: rows.map((r) => r.incomeAccountId) } }).select('name').lean<{ _id: string; name: string }[]>(),
    TaxCode.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: rows.map((r) => r.taxCodeId).filter((x): x is string => !!x) } }).select('name').lean<{ _id: string; name: string }[]>(),
    FeePlanItem.distinct('feeHeadId', { tenantId: f.tenantId, legalEntityId: f.legalEntityId }) as Promise<string[]>,
    FeeDocumentLine.distinct('feeHeadId', { tenantId: f.tenantId, legalEntityId: f.legalEntityId }) as Promise<string[]>,
  ]);
  const account = new Map(accounts.map((a) => [a._id, a.name]));
  const code = new Map(codes.map((c) => [c._id, c.name]));
  const used = new Set([...usedInPlans, ...usedInBills]);
  return rows.map((h) => ({
    feeHeadId: h._id, code: h.code, name: h.name, category: h.category, incomeAccountId: h.incomeAccountId, incomeAccountName: account.get(h.incomeAccountId) ?? null, taxCodeId: h.taxCodeId,
    taxCodeName: h.taxCodeId ? code.get(h.taxCodeId) ?? null : null, priceMode: h.priceMode, isRecurring: h.isRecurring, isOptional: h.isOptional, isRefundableDeposit: h.isRefundableDeposit, status: h.status, inUse: used.has(h._id),
  }));
}

export async function listFeeHeads(ctx: ServiceContext): Promise<FeeHeadDTO[]> {
  const f = await financeCtx(ctx);
  return toHeadDTOs(f, await FeeHead.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ name: 1 }).lean<FeeHeadDoc[]>());
}

async function checkAccounts(f: FinanceCtx, incomeAccountId: string, deposit: boolean, db?: ClientSession) {
  const account = await ChartAccount.findOne({ _id: incomeAccountId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<ChartAccountDoc>();
  if (!account) throw AppError.notFound('Account not found.');
  if (!account.isPostable || account.status !== 'ACTIVE') throw new AppError('ACCOUNT_NOT_POSTABLE');
  if (deposit && account.type !== 'LIABILITY') throw AppError.validation({ incomeAccountId: 'A refundable deposit is money the school owes back, so it must use a liability account.' });
  if (!deposit && account.type !== 'INCOME') throw AppError.validation({ incomeAccountId: 'Choose an income account for this fee.' });
}

async function checkTaxCode(f: FinanceCtx, taxCodeId: string | null | undefined, db?: ClientSession) {
  if (!taxCodeId) return;
  const code = await TaxCode.findOne({ _id: taxCodeId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<TaxCodeDoc>();
  if (!code) throw AppError.notFound('Tax code not found.');
  if (code.status !== 'ACTIVE') throw AppError.validation({ taxCodeId: 'This tax code has ended. Choose another.' });
}

export async function createFeeHead(ctx: ServiceContext, data: CreateFeeHeadData): Promise<FeeHeadDTO> {
  const f = await financeCtx(ctx);
  await checkAccounts(f, data.incomeAccountId, data.isRefundableDeposit);
  await checkTaxCode(f, data.taxCodeId);
  const id = randomUUID();
  await withTransaction(async (db) => {
    await FeeHead.create(
      [{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, ...data, taxCodeId: data.taxCodeId ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    ).catch(onDuplicate('code', () => new AppError('FINANCE_CODE_TAKEN', 'This fee code is already in use.', { fields: { code: 'This fee code is already in use.' } })));
    await auditFinance(f, db, { action: 'fee_head.created', entityType: 'fee_head', entityId: id, after: { code: data.code, name: data.name, incomeAccountId: data.incomeAccountId, taxCodeId: data.taxCodeId ?? null } });
  });
  return (await toHeadDTOs(f, [(await FeeHead.findOne({ _id: id, tenantId: f.tenantId }).lean<FeeHeadDoc>())!]))[0]!;
}

export async function updateFeeHead(ctx: ServiceContext, id: string, data: UpdateFeeHeadData): Promise<FeeHeadDTO> {
  const f = await financeCtx(ctx);
  const before = await FeeHead.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<FeeHeadDoc>();
  if (!before) throw AppError.notFound('Fee head not found.');
  if (data.incomeAccountId) await checkAccounts(f, data.incomeAccountId, before.isRefundableDeposit);
  if (data.taxCodeId !== undefined) await checkTaxCode(f, data.taxCodeId);
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await withTransaction(async (db) => {
    await FeeHead.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'fee_head.updated', entityType: 'fee_head', entityId: id, before: Object.fromEntries(Object.keys(patch).map((k) => [k, (before as unknown as Record<string, unknown>)[k] ?? null])), after: patch });
  });
  return (await toHeadDTOs(f, [(await FeeHead.findOne({ _id: id, tenantId: f.tenantId }).lean<FeeHeadDoc>())!]))[0]!;
}

// ───────────────────────────────────────────────────────────── plans, versions and items (FEE-02, 03)

async function loadItems(f: FinanceCtx, versionIds: string[], db?: ClientSession): Promise<FeePlanItemDoc[]> {
  if (versionIds.length === 0) return [];
  return FeePlanItem.find({ tenantId: f.tenantId, versionId: { $in: versionIds } }).sort({ sortOrder: 1 }).session(db ?? null).lean<FeePlanItemDoc[]>();
}

/** The total of the non-optional items a student pays in one whole session. */
export async function yearlyTotal(f: FinanceCtx, items: FeePlanItemDoc[], sessionId: string, locationId: string): Promise<number> {
  const session = await AcademicSession.findOne({ _id: sessionId, tenantId: f.tenantId }).select('startDate endDate').lean<{ startDate: string; endDate: string }>();
  if (!session) return 0;
  const terms = await AcademicTerm.find({ tenantId: f.tenantId, sessionId }).select('startDate endDate locationId').lean<{ startDate: string; endDate: string; locationId: string | null }[]>();
  return items.filter((i) => !i.isOptional).reduce((sum, i) => sum + i.amountPaise * occurrencesIn(i.frequency, session, terms, locationId), 0);
}

async function toVersionDTOs(f: FinanceCtx, versions: FeePlanVersionDoc[], plans: Map<string, FeePlanDoc>): Promise<Map<string, FeePlanVersionDTO>> {
  const items = await loadItems(f, versions.map((v) => v._id));
  const heads = await FeeHead.find({ tenantId: f.tenantId, _id: { $in: [...new Set(items.map((i) => i.feeHeadId))] } }).select('name').lean<{ _id: string; name: string }[]>();
  const head = new Map(heads.map((h) => [h._id, h.name]));
  const out = new Map<string, FeePlanVersionDTO>();
  for (const v of versions) {
    const mine = items.filter((i) => i.versionId === v._id);
    const plan = plans.get(v.planId)!;
    const dtoItems: FeePlanItemDTO[] = mine.map((i) => ({ itemId: i._id, feeHeadId: i.feeHeadId, feeHeadName: head.get(i.feeHeadId) ?? '', amountPaise: i.amountPaise, frequency: i.frequency, dueDay: i.dueDay, graceDays: i.graceDays, prorationMethod: i.prorationMethod, isOptional: i.isOptional }));
    out.set(v._id, {
      versionId: v._id, planId: v.planId, versionNo: v.versionNo, effectiveFrom: v.effectiveFrom, state: v.state, items: dtoItems,
      yearlyPaise: await yearlyTotal(f, mine, plan.sessionId, plan.appliesTo.locationIds[0] ?? ''), approvedBy: v.approvedBy, publishedAt: v.publishedAt ? new Date(v.publishedAt).toISOString() : null,
    });
  }
  return out;
}

async function toPlanDTOs(f: FinanceCtx, plans: FeePlanDoc[]): Promise<FeePlanDTO[]> {
  const versions = await FeePlanVersion.find({ tenantId: f.tenantId, planId: { $in: plans.map((p) => p._id) } }).sort({ versionNo: 1 }).lean<FeePlanVersionDoc[]>();
  const dto = await toVersionDTOs(f, versions, new Map(plans.map((p) => [p._id, p])));
  return plans.map((p) => {
    const mine = versions.filter((v) => v.planId === p._id);
    const latest = mine.at(-1);
    const published = [...mine].reverse().find((v) => v.state === 'PUBLISHED');
    return {
      planId: p._id, name: p.name, sessionId: p.sessionId, appliesTo: p.appliesTo, autoAssign: p.autoAssign, status: p.status,
      latestVersion: latest ? dto.get(latest._id)! : null, publishedVersion: published ? dto.get(published._id)! : null,
      versions: mine.map((v) => ({ versionId: v._id, versionNo: v.versionNo, state: v.state, effectiveFrom: v.effectiveFrom })),
    };
  });
}

export async function listPlans(ctx: ServiceContext, query: { sessionId?: string | undefined; state?: PlanVersionState | undefined }): Promise<FeePlanDTO[]> {
  const f = await financeCtx(ctx);
  let plans = await FeePlan.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, ...(query.sessionId ? { sessionId: query.sessionId } : {}) }).sort({ createdAt: 1 }).lean<FeePlanDoc[]>();
  if (query.state) {
    const withState = new Set((await FeePlanVersion.find({ tenantId: f.tenantId, state: query.state, planId: { $in: plans.map((p) => p._id) } }).select('planId').lean<{ planId: string }[]>()).map((v) => v.planId));
    plans = plans.filter((p) => withState.has(p._id));
  }
  return toPlanDTOs(f, plans);
}

export async function getPlan(ctx: ServiceContext, planId: string): Promise<FeePlanDTO> {
  const f = await financeCtx(ctx);
  const plan = await FeePlan.findOne({ _id: planId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<FeePlanDoc>();
  if (!plan) throw AppError.notFound('Fee plan not found.');
  return (await toPlanDTOs(f, [plan]))[0]!;
}

async function writeItems(f: FinanceCtx, db: ClientSession, planId: string, versionId: string, items: FeePlanItemData[]) {
  const heads = await FeeHead.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, _id: { $in: [...new Set(items.map((i) => i.feeHeadId))] } }).session(db).select('status').lean<{ _id: string; status: string }[]>();
  const known = new Map(heads.map((h) => [h._id, h]));
  items.forEach((item, i) => {
    const head = known.get(item.feeHeadId);
    if (!head) throw AppError.validation({ [`items.${i}.feeHeadId`]: 'This fee head was not found.' });
    if (head.status !== 'ACTIVE') throw AppError.validation({ [`items.${i}.feeHeadId`]: 'This fee head is inactive.' });
  });
  await FeePlanItem.create(items.map((item, i) => ({ tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, planId, versionId, sortOrder: i, ...item })), { session: db, ordered: true });
}

export async function createPlan(ctx: ServiceContext, data: CreateFeePlanData): Promise<FeePlanDTO> {
  const f = await financeCtx(ctx);
  const session = await AcademicSession.findOne({ _id: data.sessionId, tenantId: f.tenantId }).select('startDate').lean<{ startDate: string }>();
  if (!session) throw AppError.notFound('Academic session not found.');
  const planId = randomUUID();
  const versionId = randomUUID();
  await withTransaction(async (db) => {
    await FeePlan.create([{ _id: planId, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, name: data.name, sessionId: data.sessionId, appliesTo: { ...data.appliesTo, studentId: data.appliesTo.studentId ?? null }, autoAssign: data.autoAssign, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await FeePlanVersion.create([{ _id: versionId, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, planId, versionNo: 1, effectiveFrom: data.effectiveFrom ?? session.startDate, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await writeItems(f, db, planId, versionId, data.items);
    await auditFinance(f, db, { action: 'fee_plan.created', entityType: 'fee_plan', entityId: planId, after: { name: data.name, sessionId: data.sessionId, items: data.items.length } });
  });
  return getPlan(ctx, planId);
}

export async function updatePlan(ctx: ServiceContext, planId: string, data: { name?: string | undefined; autoAssign?: boolean | undefined; status?: 'ACTIVE' | 'ARCHIVED' | undefined }): Promise<FeePlanDTO> {
  const f = await financeCtx(ctx);
  const before = await FeePlan.findOne({ _id: planId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<FeePlanDoc>();
  if (!before) throw AppError.notFound('Fee plan not found.');
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await withTransaction(async (db) => {
    await FeePlan.updateOne({ _id: planId, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'fee_plan.updated', entityType: 'fee_plan', entityId: planId, before: { name: before.name, autoAssign: before.autoAssign, status: before.status }, after: patch });
  });
  return getPlan(ctx, planId);
}

async function loadVersion(f: FinanceCtx, versionId: string, db?: ClientSession) {
  const version = await FeePlanVersion.findOne({ _id: versionId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<FeePlanVersionDoc>();
  if (!version) throw AppError.notFound('Fee plan version not found.');
  const plan = await FeePlan.findOne({ _id: version.planId, tenantId: f.tenantId }).session(db ?? null).lean<FeePlanDoc>();
  return { version, plan: plan! };
}

const FROZEN: PlanVersionState[] = ['PUBLISHED', 'SUPERSEDED', 'ARCHIVED'];

/** A new DRAFT copy of the latest version. A price change is always a new version with its own start date. */
export async function createVersion(ctx: ServiceContext, planId: string, data: { effectiveFrom?: string | undefined }): Promise<FeePlanDTO> {
  const f = await financeCtx(ctx);
  const plan = await FeePlan.findOne({ _id: planId, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<FeePlanDoc>();
  if (!plan) throw AppError.notFound('Fee plan not found.');
  const today = await todayFor(ctx);
  await withTransaction(async (db) => {
    const versions = await FeePlanVersion.find({ tenantId: f.tenantId, planId }).sort({ versionNo: -1 }).session(db).lean<FeePlanVersionDoc[]>();
    if (versions.some((v) => v.state === 'DRAFT' || v.state === 'APPROVED')) throw new AppError('CONFLICT', 'There is already a draft version of this plan. Finish or publish it first.');
    const latest = versions[0]!;
    const published = versions.find((v) => v.state === 'PUBLISHED');
    const effectiveFrom = data.effectiveFrom ?? (today > latest.effectiveFrom ? today : latest.effectiveFrom);
    if (published && effectiveFrom <= published.effectiveFrom) throw AppError.validation({ effectiveFrom: 'A new version must start after the version that is running now.' });
    const versionId = randomUUID();
    await FeePlanVersion.create([{ _id: versionId, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, planId, versionNo: latest.versionNo + 1, effectiveFrom, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    const items = await loadItems(f, [latest._id], db);
    await writeItems(f, db, planId, versionId, items.map(({ feeHeadId, amountPaise, frequency, dueDay, graceDays, prorationMethod, isOptional }) => ({ feeHeadId, amountPaise, frequency, dueDay, graceDays, prorationMethod, isOptional })));
    await auditFinance(f, db, { action: 'fee_plan_version.created', entityType: 'fee_plan', entityId: planId, after: { versionNo: latest.versionNo + 1, effectiveFrom } });
  });
  return getPlan(ctx, planId);
}

export async function updateVersion(ctx: ServiceContext, versionId: string, data: { effectiveFrom?: string | undefined; items?: FeePlanItemData[] | undefined }): Promise<FeePlanDTO> {
  const f = await financeCtx(ctx);
  const { version } = await loadVersion(f, versionId);
  if (FROZEN.includes(version.state)) throw new AppError('PLAN_VERSION_FROZEN');
  await withTransaction(async (db) => {
    if (data.effectiveFrom) await FeePlanVersion.updateOne({ _id: versionId, tenantId: f.tenantId, state: { $in: ['DRAFT', 'APPROVED'] } }, { $set: { effectiveFrom: data.effectiveFrom } }, { session: db });
    if (data.items) {
      await FeePlanItem.deleteMany({ tenantId: f.tenantId, versionId }, { session: db });
      await writeItems(f, db, version.planId, versionId, data.items);
    }
    // Any change sends an approved draft back to draft, so what is published is always what was approved.
    await FeePlanVersion.updateOne({ _id: versionId, tenantId: f.tenantId, state: 'APPROVED' }, { $set: { state: 'DRAFT', approvedBy: null, approvedAt: null } }, { session: db });
    await auditFinance(f, db, { action: 'fee_plan_version.updated', entityType: 'fee_plan', entityId: version.planId, after: { versionNo: version.versionNo, items: data.items?.length ?? null, effectiveFrom: data.effectiveFrom ?? null } });
  });
  return getPlan(ctx, version.planId);
}

/** Two plans cover the same students when they share a campus, a class and a kind of student (empty lists mean "all"). */
export function plansOverlap(a: Pick<FeePlanDoc, 'appliesTo'>, b: Pick<FeePlanDoc, 'appliesTo'>): boolean {
  if (a.appliesTo.studentId || b.appliesTo.studentId) return a.appliesTo.studentId === b.appliesTo.studentId;
  const share = (x: string[], y: string[]) => x.length === 0 || y.length === 0 || x.some((i) => y.includes(i));
  const types = a.appliesTo.studentType === 'ALL' || b.appliesTo.studentType === 'ALL' || a.appliesTo.studentType === b.appliesTo.studentType;
  return share(a.appliesTo.locationIds, b.appliesTo.locationIds) && share(a.appliesTo.classIds, b.appliesTo.classIds) && types;
}

/** Plain-words problems with a draft. A plan with problems cannot be published. */
export async function validateVersionDoc(f: FinanceCtx, version: FeePlanVersionDoc, plan: FeePlanDoc): Promise<PlanValidationDTO> {
  const problems: PlanValidationDTO['problems'] = [];
  const items = await loadItems(f, [version._id]);
  if (items.length === 0) problems.push({ code: 'NO_ITEMS', message: 'Add at least one fee line.' });
  const heads = await FeeHead.find({ tenantId: f.tenantId, _id: { $in: items.map((i) => i.feeHeadId) } }).lean<FeeHeadDoc[]>();
  const head = new Map(heads.map((h) => [h._id, h]));
  const accounts = await ChartAccount.find({ tenantId: f.tenantId, _id: { $in: heads.map((h) => h.incomeAccountId) } }).select('status isPostable').lean<{ _id: string; status: string; isPostable: boolean }[]>();
  const account = new Map(accounts.map((a) => [a._id, a]));
  for (const item of items) {
    const h = head.get(item.feeHeadId);
    if (!h) continue;
    if (h.status !== 'ACTIVE') problems.push({ code: 'HEAD_INACTIVE', itemId: item._id, message: `${h.name} is switched off. Choose another fee head.` });
    const acc = account.get(h.incomeAccountId);
    if (!acc || acc.status !== 'ACTIVE' || !acc.isPostable) problems.push({ code: 'HEAD_NO_ACCOUNT', itemId: item._id, message: `${h.name} has no income account that can take entries.` });
    if (!h.taxCodeId && !h.isRefundableDeposit) problems.push({ code: 'TAX_CODE_MISSING', itemId: item._id, message: `${h.name} has no tax setting. Add a tax code to this fee head.` });
  }
  const session = await AcademicSession.findOne({ _id: plan.sessionId, tenantId: f.tenantId }).select('startDate endDate').lean<{ startDate: string; endDate: string }>();
  if (session && (version.effectiveFrom < session.startDate || version.effectiveFrom > session.endDate)) problems.push({ code: 'DATES_OUTSIDE_SESSION', message: `The start date must be inside the academic session (${session.startDate} to ${session.endDate}).` });
  const others = await FeePlan.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId, sessionId: plan.sessionId, status: 'ACTIVE', _id: { $ne: plan._id } }).lean<FeePlanDoc[]>();
  const publishedPlanIds = new Set((await FeePlanVersion.find({ tenantId: f.tenantId, state: 'PUBLISHED', planId: { $in: others.map((p) => p._id) } }).select('planId').lean<{ planId: string }[]>()).map((v) => v.planId));
  for (const other of others.filter((p) => publishedPlanIds.has(p._id))) {
    if (plansOverlap(plan, other)) problems.push({ code: 'PLAN_CONFLICT', message: `"${other.name}" is already published for some of the same students. Narrow one of the two plans.` });
  }
  return { versionId: version._id, ok: problems.length === 0, problems };
}

export async function validateVersion(ctx: ServiceContext, versionId: string): Promise<PlanValidationDTO & { impact: { students: number; expectedPaise: number } }> {
  const f = await financeCtx(ctx);
  const { version, plan } = await loadVersion(f, versionId);
  const result = await validateVersionDoc(f, version, plan);
  return { ...result, impact: await impactOf(f, version, plan) };
}

/** "This plan will apply to 164 students. Expected this year ₹41.2 lakh." */
async function impactOf(f: FinanceCtx, version: FeePlanVersionDoc, plan: FeePlanDoc): Promise<{ students: number; expectedPaise: number }> {
  const offerings = await ClassOffering.find({ tenantId: f.tenantId, sessionId: plan.sessionId, ...(plan.appliesTo.locationIds.length ? { locationId: { $in: plan.appliesTo.locationIds } } : {}), ...(plan.appliesTo.classIds.length ? { classId: { $in: plan.appliesTo.classIds } } : {}) }).select('locationId').lean<{ _id: string; locationId: string }[]>();
  const filter: Record<string, unknown> = { tenantId: f.tenantId, academicSessionId: plan.sessionId, state: 'OPEN', classOfferingId: { $in: offerings.map((o) => o._id) } };
  if (plan.appliesTo.studentId) filter.studentId = plan.appliesTo.studentId;
  const students = await StudentEnrollment.countDocuments(filter);
  const items = await loadItems(f, [version._id]);
  const yearly = await yearlyTotal(f, items, plan.sessionId, offerings[0]?.locationId ?? '');
  return { students, expectedPaise: students * yearly };
}

export async function approveVersion(ctx: ServiceContext, versionId: string): Promise<FeePlanDTO> {
  const f = await financeCtx(ctx);
  const { version, plan } = await loadVersion(f, versionId);
  if (FROZEN.includes(version.state)) throw new AppError('PLAN_VERSION_FROZEN');
  const check = await validateVersionDoc(f, version, plan);
  if (!check.ok) throw AppError.validation({ version: check.problems[0]!.message }, 'This plan has problems. Fix them before approving.');
  await withTransaction(async (db) => {
    await FeePlanVersion.updateOne({ _id: versionId, tenantId: f.tenantId, state: { $in: ['DRAFT', 'APPROVED'] } }, { $set: { state: 'APPROVED', approvedBy: ctx.userId, approvedAt: new Date() } }, { session: db });
    await auditFinance(f, db, { action: 'fee_plan_version.approved', entityType: 'fee_plan', entityId: plan._id, after: { versionNo: version.versionNo } });
  });
  return getPlan(ctx, plan._id);
}

/** Publishing freezes the version and supersedes the one that was running. Old bills keep pointing at the version they were made from. */
export async function publishVersion(ctx: ServiceContext, versionId: string): Promise<FeePlanDTO> {
  const f = await financeCtx(ctx);
  const { version, plan } = await loadVersion(f, versionId);
  if (FROZEN.includes(version.state)) throw new AppError('PLAN_VERSION_FROZEN');
  const check = await validateVersionDoc(f, version, plan);
  if (!check.ok) {
    const conflict = check.problems.find((p) => p.code === 'PLAN_CONFLICT');
    if (conflict) throw new AppError('PLAN_CONFLICT', conflict.message);
    throw AppError.validation({ version: check.problems[0]!.message }, 'This plan has problems. Fix them before publishing.');
  }
  await withTransaction(async (db) => {
    const res = await FeePlanVersion.updateOne({ _id: versionId, tenantId: f.tenantId, state: { $in: ['DRAFT', 'APPROVED'] } }, { $set: { state: 'PUBLISHED', publishedBy: ctx.userId, publishedAt: new Date(), approvedBy: version.approvedBy ?? ctx.userId, approvedAt: version.approvedAt ?? new Date() } }, { session: db });
    if (res.modifiedCount !== 1) throw new AppError('PLAN_VERSION_FROZEN');
    await FeePlanVersion.updateMany({ tenantId: f.tenantId, planId: plan._id, state: 'PUBLISHED', _id: { $ne: versionId } }, { $set: { state: 'SUPERSEDED' } }, { session: db });
    await auditFinance(f, db, { action: 'fee_plan_version.published', entityType: 'fee_plan', entityId: plan._id, after: { versionNo: version.versionNo, effectiveFrom: version.effectiveFrom } });
    await emitFinance(f, db, 'fee_plan.published', { planId: plan._id, versionId, versionNo: version.versionNo });
  });
  return getPlan(ctx, plan._id);
}

/** Does anything still point at this version (assignments)? Used by the readiness check. */
export const versionInUse = async (f: FinanceCtx, versionId: string) => Boolean(await StudentFeeAssignment.exists({ tenantId: f.tenantId, planVersionId: versionId }));

export { loadItems, loadVersion };
