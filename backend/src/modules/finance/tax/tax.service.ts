import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { TAX_EXAMPLE_NOTE, type CreateTaxCodeData, type TaxCategory, type TaxCodeDTO } from '@shared';
import { AppError } from '../../../core/errors';
import { onDuplicate } from '../../../db/errors';
import { withTransaction } from '../../../db/transaction';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { auditFinance, financeCtx, type FinanceCtx } from '../core/context';
import { TaxCode, type TaxCodeDoc } from '../core/models';
import { FeeHead } from '../fees/models';

/** Tax codes are settings the school chooses with its accountant. The seeded ones are EXAMPLES, and every one says so. */
export const SEED_TAX_CODES: { code: string; name: string; category: TaxCategory; rateBps: number }[] = [
  { code: 'EXEMPT_EDU', name: 'Exempt – educational service', category: 'EXEMPT', rateBps: 0 },
  { code: 'NIL_RATED', name: 'Nil rated', category: 'NIL_RATED', rateBps: 0 },
  { code: 'OUT_OF_SCOPE', name: 'Out of scope', category: 'OUT_OF_SCOPE', rateBps: 0 },
  { code: 'GST_5', name: 'GST 5%', category: 'TAXABLE', rateBps: 500 },
  { code: 'GST_12', name: 'GST 12%', category: 'TAXABLE', rateBps: 1200 },
  { code: 'GST_18', name: 'GST 18%', category: 'TAXABLE', rateBps: 1800 },
];

export async function seedTaxCodes(f: FinanceCtx, db?: ClientSession) {
  for (const c of SEED_TAX_CODES) {
    await TaxCode.updateOne(
      { tenantId: f.tenantId, legalEntityId: f.legalEntityId, code: c.code },
      { $setOnInsert: { _id: randomUUID(), schoolId: f.schoolId, name: c.name, category: c.category, rateBps: c.rateBps, note: TAX_EXAMPLE_NOTE, status: 'ACTIVE', createdBy: f.userId } },
      { upsert: true, session: db },
    );
  }
}

export async function taxCodesById(f: FinanceCtx, db?: ClientSession): Promise<Map<string, TaxCodeDoc>> {
  const rows = await TaxCode.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).session(db ?? null).lean<TaxCodeDoc[]>();
  return new Map(rows.map((c) => [c._id, c]));
}

async function toDTOs(f: FinanceCtx, rows: TaxCodeDoc[]): Promise<TaxCodeDTO[]> {
  const used = new Set((await FeeHead.distinct('taxCodeId', { tenantId: f.tenantId, legalEntityId: f.legalEntityId })) as string[]);
  return rows.map((c) => ({ taxCodeId: c._id, code: c.code, name: c.name, category: c.category, rateBps: c.rateBps, hsnSac: c.hsnSac, note: c.note, status: c.status, inUse: used.has(c._id) }));
}

export async function listTaxCodes(ctx: ServiceContext): Promise<TaxCodeDTO[]> {
  const f = await financeCtx(ctx);
  return toDTOs(f, await TaxCode.find({ tenantId: f.tenantId, legalEntityId: f.legalEntityId }).sort({ category: 1, rateBps: 1, code: 1 }).lean<TaxCodeDoc[]>());
}

export async function createTaxCode(ctx: ServiceContext, data: CreateTaxCodeData): Promise<TaxCodeDTO> {
  const f = await financeCtx(ctx);
  const id = randomUUID();
  await withTransaction(async (db) => {
    await TaxCode.create(
      [{ _id: id, tenantId: f.tenantId, schoolId: f.schoolId, legalEntityId: f.legalEntityId, code: data.code, name: data.name, category: data.category, rateBps: data.rateBps, hsnSac: data.hsnSac ?? null, note: data.note ?? TAX_EXAMPLE_NOTE, createdBy: ctx.userId }],
      { session: db },
    ).catch(onDuplicate('code', () => new AppError('FINANCE_CODE_TAKEN', 'This tax code is already in use.', { fields: { code: 'This tax code is already in use.' } })));
    await auditFinance(f, db, { action: 'tax_code.created', entityType: 'tax_code', entityId: id, after: { code: data.code, category: data.category, rateBps: data.rateBps } });
  });
  return (await toDTOs(f, [(await TaxCode.findOne({ _id: id, tenantId: f.tenantId }).lean<TaxCodeDoc>())!]))[0]!;
}

/** The rate and category never change (old bills point at them). A code that is no longer wanted is ended. */
export async function updateTaxCode(ctx: ServiceContext, id: string, data: { name?: string | undefined; hsnSac?: string | null | undefined; note?: string | null | undefined; status?: 'ACTIVE' | 'ENDED' | undefined }): Promise<TaxCodeDTO> {
  const f = await financeCtx(ctx);
  const before = await TaxCode.findOne({ _id: id, tenantId: f.tenantId, legalEntityId: f.legalEntityId }).lean<TaxCodeDoc>();
  if (!before) throw AppError.notFound('Tax code not found.');
  const patch = Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined));
  await withTransaction(async (db) => {
    await TaxCode.updateOne({ _id: id, tenantId: f.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await auditFinance(f, db, { action: 'tax_code.updated', entityType: 'tax_code', entityId: id, before: { name: before.name, status: before.status }, after: patch });
  });
  return (await toDTOs(f, [(await TaxCode.findOne({ _id: id, tenantId: f.tenantId }).lean<TaxCodeDoc>())!]))[0]!;
}
