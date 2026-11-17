import type { Model } from 'mongoose';
import {
  codeFromName,
  MASTER_EDITABLE_FIELDS,
  SUGGESTED_DEPARTMENTS,
  SUGGESTED_DESIGNATIONS,
  type CreateMasterData,
  type DepartmentDTO,
  type DesignationDTO,
  type ListMastersQuery,
  type SuggestedMastersDTO,
  type UpdateMasterData,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields, changedValues } from '../audit/diff';
import { auditScopeOf, recordStaffAudit } from './audit';
import { toDepartmentDTO, toDesignationDTO } from './mappers';
import { Department, Designation, type StaffMasterDoc } from './master.model';

/** FSM-02 — departments and designations. Both behave the same, so one implementation serves two entities. */
interface MasterKind<T> {
  model: Model<StaffMasterDoc>;
  entityType: 'department' | 'designation';
  label: string;
  suggested: readonly string[];
  duplicateCode: 'DEPARTMENT_CODE_TAKEN' | 'DESIGNATION_CODE_TAKEN';
  toDTO: (doc: StaffMasterDoc) => T;
}

const departments: MasterKind<DepartmentDTO> = {
  model: Department,
  entityType: 'department',
  label: 'Department',
  suggested: SUGGESTED_DEPARTMENTS,
  duplicateCode: 'DEPARTMENT_CODE_TAKEN',
  toDTO: toDepartmentDTO,
};

const designations: MasterKind<DesignationDTO> = {
  model: Designation,
  entityType: 'designation',
  label: 'Designation',
  suggested: SUGGESTED_DESIGNATIONS,
  duplicateCode: 'DESIGNATION_CODE_TAKEN',
  toDTO: toDesignationDTO,
};

function makeService<T>(kind: MasterKind<T>) {
  const codeTaken = () => new AppError(kind.duplicateCode, undefined, { fields: { code: 'This code is already in use.' } });

  async function list(ctx: ServiceContext, query: ListMastersQuery): Promise<T[]> {
    const docs = await kind.model
      .find({ tenantId: ctx.tenantId, ...(query.status ? { status: query.status } : {}) })
      .collation({ locale: 'en', strength: 2 })
      .sort({ name: 1, _id: 1 })
      .lean<StaffMasterDoc[]>();
    return docs.map(kind.toDTO);
  }

  async function create(ctx: ServiceContext, data: CreateMasterData): Promise<T> {
    try {
      return await withTransaction(async (db) => {
        const [created] = await kind.model.create([{ tenantId: ctx.tenantId, code: data.code, name: data.name, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
        const doc = created!.toObject() as StaffMasterDoc;
        await recordStaffAudit(auditScopeOf(ctx), db, {
          entityType: kind.entityType,
          entityId: doc._id,
          action: `${kind.entityType}.created`,
          changes: diffFields({}, doc, ['code', 'name', 'status']),
          employeeId: null,
        });
        return kind.toDTO(doc);
      });
    } catch (err) {
      if (duplicateKeyFields(err)?.includes('code')) throw codeTaken();
      throw err;
    }
  }

  async function update(ctx: ServiceContext, id: string, patch: UpdateMasterData): Promise<T> {
    return withTransaction(async (db) => {
      const before = await kind.model.findOne({ _id: id, tenantId: ctx.tenantId }).session(db).lean<StaffMasterDoc>();
      if (!before) throw AppError.notFound(`${kind.label} not found.`);
      const merged = { ...before, ...pickDefined(patch) } as StaffMasterDoc;
      const changes = diffFields(before, merged, MASTER_EDITABLE_FIELDS);
      if (changes.length > 0) {
        await kind.model.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: changedValues(merged, changes, ctx.userId) }, { session: db });
        await recordStaffAudit(auditScopeOf(ctx), db, { entityType: kind.entityType, entityId: id, action: `${kind.entityType}.updated`, changes, employeeId: null });
      }
      return kind.toDTO(merged);
    });
  }

  /** Adds the PRD §7 starter list, skipping codes that already exist. */
  async function addSuggested(ctx: ServiceContext): Promise<SuggestedMastersDTO<T>> {
    return withTransaction(async (db) => {
      const wanted = kind.suggested.map((name) => ({ code: codeFromName(name), name }));
      const existing = await kind.model
        .find({ tenantId: ctx.tenantId, code: { $in: wanted.map((w) => w.code) } })
        .session(db)
        .select('code')
        .lean<{ code: string }[]>();
      const taken = new Set(existing.map((e) => e.code));
      const fresh = wanted.filter((w) => !taken.has(w.code));
      if (fresh.length === 0) return { created: [], skipped: wanted.length };

      const docs = await kind.model.create(
        fresh.map((w) => ({ tenantId: ctx.tenantId, code: w.code, name: w.name, createdBy: ctx.userId, updatedBy: ctx.userId })),
        { session: db, ordered: true },
      );
      for (const created of docs) {
        const doc = created.toObject() as StaffMasterDoc;
        await recordStaffAudit(auditScopeOf(ctx), db, {
          entityType: kind.entityType,
          entityId: doc._id,
          action: `${kind.entityType}.created`,
          changes: diffFields({}, doc, ['code', 'name', 'status']),
          employeeId: null,
          metadata: { suggested: true },
        });
      }
      return { created: docs.map((d) => kind.toDTO(d.toObject() as StaffMasterDoc)), skipped: wanted.length - fresh.length };
    });
  }

  return { list, create, update, addSuggested };
}

export const departmentService = makeService(departments);
export const designationService = makeService(designations);

/** Loads an ACTIVE department or designation for a new or changed employee (`MASTER_INACTIVE` otherwise). */
export async function requireActiveMaster(
  ctx: ServiceContext,
  kind: 'department' | 'designation',
  id: string,
  field: string,
  db: import('mongoose').ClientSession,
): Promise<StaffMasterDoc> {
  const model = kind === 'department' ? Department : Designation;
  const doc = await model.findOne({ _id: id, tenantId: ctx.tenantId }).session(db).lean<StaffMasterDoc>();
  if (!doc) throw AppError.notFound(`${kind === 'department' ? 'Department' : 'Designation'} not found.`);
  if (doc.status !== 'ACTIVE') {
    throw new AppError('MASTER_INACTIVE', undefined, { fields: { [field]: `${doc.name} is inactive.` } });
  }
  return doc;
}
