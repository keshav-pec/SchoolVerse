import type { ClientSession } from 'mongoose';
import {
  SESSION_STATUSES_FOR_LIMITED_VIEW,
  SUBJECT_EDITABLE_FIELDS,
  type BoardSubjectCodeDTO,
  type CreateSubjectData,
  type ListSubjectsQuery,
  type PaginatedDTO,
  type SetBoardSubjectCodeData,
  type SubjectDTO,
  type UpdateSubjectData,
} from '@shared';
import { AppError } from '../../core/errors';
import { escapeRegex, pickDefined, toIso } from '../../core/objects';
import { onDuplicate } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { actorFrom, can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { diffFields, changedValues } from '../audit/diff';
import { ClassOffering, SubjectOffering } from './offering.model';
import { BoardRuleVersion, EducationBoard, visibleToTenant, type BoardRuleVersionDoc, type EducationBoardDoc } from './reference.model';
import { AcademicSession } from './session.model';
import { BoardSubjectDefinition, Subject, type BoardSubjectDefinitionDoc, type SubjectDoc } from './subject.model';

/** AS-05 / AS-06 — subject master and board subject codes. Subjects are never deleted: set INACTIVE. */

// ───────────────────────────────────────────────────────────── mapping

export function toSubjectDTO(doc: SubjectDoc, boardCodes: BoardSubjectCodeDTO[] = []): SubjectDTO {
  return {
    subjectId: doc._id,
    subjectCode: doc.subjectCode,
    name: doc.name,
    shortName: doc.shortName ?? null,
    category: doc.category,
    languageCode: doc.languageCode ?? null,
    hasTheory: doc.hasTheory,
    hasPractical: doc.hasPractical,
    hasProject: doc.hasProject,
    hasInternalAssessment: doc.hasInternalAssessment,
    status: doc.status,
    boardCodes,
    createdAt: toIso(doc.createdAt)!,
    updatedAt: toIso(doc.updatedAt)!,
  };
}

async function boardCodesFor(ctx: ServiceContext, subjectIds: string[], session?: ClientSession): Promise<Map<string, BoardSubjectCodeDTO[]>> {
  const result = new Map<string, BoardSubjectCodeDTO[]>();
  if (subjectIds.length === 0) return result;
  const definitions = await BoardSubjectDefinition.find({ tenantId: ctx.tenantId, subjectId: { $in: subjectIds } })
    .session(session ?? null)
    .lean<BoardSubjectDefinitionDoc[]>();
  const versionIds = [...new Set(definitions.map((d) => d.boardRuleVersionId))];
  const versions = await BoardRuleVersion.find({ _id: { $in: versionIds }, ...visibleToTenant(ctx.tenantId) })
    .session(session ?? null)
    .lean<BoardRuleVersionDoc[]>();
  const boards = await EducationBoard.find({ _id: { $in: [...new Set(versions.map((v) => v.boardId))] }, ...visibleToTenant(ctx.tenantId) })
    .session(session ?? null)
    .lean<EducationBoardDoc[]>();
  const versionById = new Map(versions.map((v) => [v._id, v]));
  const boardById = new Map(boards.map((b) => [b._id, b]));

  for (const d of definitions) {
    const version = versionById.get(d.boardRuleVersionId);
    const board = version ? boardById.get(version.boardId) : undefined;
    const list = result.get(d.subjectId) ?? [];
    list.push({
      definitionId: d._id,
      boardRuleVersionId: d.boardRuleVersionId,
      boardId: version?.boardId ?? '',
      boardCode: board?.boardCode ?? null,
      ruleVersionName: version?.name ?? null,
      boardSubjectCode: d.boardSubjectCode,
      boardSubjectName: d.boardSubjectName ?? null,
    });
    result.set(d.subjectId, list);
  }
  for (const list of result.values()) list.sort((a, b) => (a.boardCode ?? '').localeCompare(b.boardCode ?? '') || (a.ruleVersionName ?? '').localeCompare(b.ruleVersionName ?? ''));
  return result;
}

async function toSubjectDTOs(ctx: ServiceContext, docs: SubjectDoc[], session?: ClientSession): Promise<SubjectDTO[]> {
  const codes = await boardCodesFor(ctx, docs.map((d) => d._id), session);
  return docs.map((d) => toSubjectDTO(d, codes.get(d._id) ?? []));
}

// ───────────────────────────────────────────────────────────── reads

export async function getSubjectOrThrow(ctx: ServiceContext, subjectId: string, session?: ClientSession) {
  const doc = await Subject.findOne({ _id: subjectId, tenantId: ctx.tenantId }).session(session ?? null).lean<SubjectDoc>();
  if (!doc) throw AppError.notFound('Subject not found.');
  return doc;
}

export async function getSubjectDTO(ctx: ServiceContext, subjectId: string, session?: ClientSession): Promise<SubjectDTO> {
  const [dto] = await toSubjectDTOs(ctx, [await getSubjectOrThrow(ctx, subjectId, session)], session);
  return dto!;
}

const exactCi = (value: string) => new RegExp(`^${escapeRegex(value)}$`, 'i');

export async function listSubjects(ctx: ServiceContext, query: ListSubjectsQuery): Promise<PaginatedDTO<SubjectDTO>> {
  const filter: Record<string, unknown> = { tenantId: ctx.tenantId };
  const and: Record<string, unknown>[] = [];

  if (query.category) filter.category = query.category;
  if (query.status) filter.status = query.status;
  if (query.languageCode) filter.languageCode = exactCi(query.languageCode);
  if (query.search) {
    const rx = new RegExp(escapeRegex(query.search), 'i');
    and.push({ $or: [{ name: rx }, { subjectCode: rx }, { shortName: rx }] });
  }

  if (query.boardCode) {
    // The official subject code (e.g. "041") or the board itself (e.g. "CBSE").
    const boards = await EducationBoard.find({ boardCode: query.boardCode.toUpperCase(), ...visibleToTenant(ctx.tenantId) }).select('_id').lean<{ _id: string }[]>();
    const versions = boards.length
      ? await BoardRuleVersion.find({ boardId: { $in: boards.map((b) => b._id) }, ...visibleToTenant(ctx.tenantId) }).select('_id').lean<{ _id: string }[]>()
      : [];
    const definitions = await BoardSubjectDefinition.find({
      tenantId: ctx.tenantId,
      $or: [{ boardSubjectCode: exactCi(query.boardCode) }, { boardRuleVersionId: { $in: versions.map((v) => v._id) } }],
    })
      .select('subjectId')
      .lean<{ subjectId: string }[]>();
    and.push({ _id: { $in: [...new Set(definitions.map((d) => d.subjectId))] } });
  }

  if (query.classId) {
    const offeringFilter: Record<string, unknown> = { tenantId: ctx.tenantId, classId: query.classId };
    if (query.academicSessionId) offeringFilter.sessionId = query.academicSessionId;
    if (!can(ctx, 'academic:view_config')) {
      // Limited roles must not learn what a DRAFT session contains.
      const visible = await AcademicSession.find({ tenantId: ctx.tenantId, status: { $in: SESSION_STATUSES_FOR_LIMITED_VIEW } }).select('_id').lean<{ _id: string }[]>();
      offeringFilter.sessionId = query.academicSessionId
        ? { $in: visible.map((s) => s._id).filter((id) => id === query.academicSessionId) }
        : { $in: visible.map((s) => s._id) };
    }
    const classOfferings = await ClassOffering.find(offeringFilter).select('_id').lean<{ _id: string }[]>();
    const subjectIds = await SubjectOffering.distinct('subjectId', { tenantId: ctx.tenantId, classOfferingId: { $in: classOfferings.map((g) => g._id) } });
    and.push({ _id: { $in: subjectIds } });
  }
  if (and.length) filter.$and = and;

  const [total, rows] = await Promise.all([
    Subject.countDocuments(filter),
    Subject.find(filter)
      .collation({ locale: 'en', strength: 2 })
      .sort({ name: 1, _id: 1 })
      .skip((query.page - 1) * query.pageSize)
      .limit(query.pageSize)
      .lean<SubjectDoc[]>(),
  ]);
  return { items: await toSubjectDTOs(ctx, rows), page: query.page, pageSize: query.pageSize, total };
}

// ───────────────────────────────────────────────────────────── writes

function subjectCodeTaken() {
  return new AppError('SUBJECT_CODE_TAKEN', undefined, { fields: { subjectCode: 'This subject code is already in use.' } });
}

function normalise<T extends { languageCode?: string | null }>(data: T): T {
  return data.languageCode ? { ...data, languageCode: data.languageCode.toLowerCase() } : data;
}

export async function createSubject(ctx: ServiceContext, data: CreateSubjectData): Promise<SubjectDTO> {
  return withTransaction(async (session) => {
    const [created] = await Subject.create(
      [{ ...pickDefined(normalise(data)), tenantId: ctx.tenantId, status: 'ACTIVE', createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session },
    );
    const subject = created!.toObject() as SubjectDoc;
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'subject',
        entityId: subject._id,
        action: 'subject.created',
        actor: actorFrom(ctx),
        changes: diffFields({}, subject, SUBJECT_EDITABLE_FIELDS),
        requestId: ctx.requestId,
      },
      session,
    );
    return toSubjectDTO(subject);
  }).catch(onDuplicate('subjectCode', subjectCodeTaken));
}

export async function updateSubject(ctx: ServiceContext, subjectId: string, patch: UpdateSubjectData): Promise<SubjectDTO> {
  return withTransaction(async (session) => {
    const before = await getSubjectOrThrow(ctx, subjectId, session);
    const merged = { ...before, ...pickDefined(normalise(patch)) } as SubjectDoc;
    const changes = diffFields(before, merged, SUBJECT_EDITABLE_FIELDS);
    if (changes.length > 0) {
      await Subject.updateOne({ _id: subjectId, tenantId: ctx.tenantId }, { $set: changedValues(merged, changes, ctx.userId) }, { session });
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'subject',
          entityId: subjectId,
          action: 'subject.updated',
          actor: actorFrom(ctx),
          changes,
          requestId: ctx.requestId,
        },
        session,
      );
    }
    return getSubjectDTO(ctx, subjectId, session);
  }).catch(onDuplicate('subjectCode', subjectCodeTaken));
}

// ───────────────────────────────────────────────────────────── board codes (AS-06)

/** `PUT /subjects/:id/board-codes` — creates or updates the subject's official code on one rule version. */
export async function setBoardSubjectCode(ctx: ServiceContext, subjectId: string, data: SetBoardSubjectCodeData): Promise<SubjectDTO> {
  return withTransaction(async (session) => {
    await getSubjectOrThrow(ctx, subjectId, session);
    const version = await BoardRuleVersion.findOne({ _id: data.boardRuleVersionId, ...visibleToTenant(ctx.tenantId) }).session(session).lean<BoardRuleVersionDoc>();
    if (!version) throw AppError.notFound('Rule version not found.');

    const existing = await BoardSubjectDefinition.findOne({ tenantId: ctx.tenantId, subjectId, boardRuleVersionId: version._id }).session(session).lean<BoardSubjectDefinitionDoc>();
    const next = { boardSubjectCode: data.boardSubjectCode, boardSubjectName: data.boardSubjectName ?? null };
    const changes = diffFields(existing ?? {}, next, ['boardSubjectCode', 'boardSubjectName']);

    if (!existing) {
      await BoardSubjectDefinition.create([{ ...next, tenantId: ctx.tenantId, subjectId, boardRuleVersionId: version._id, createdBy: ctx.userId, updatedBy: ctx.userId }], { session });
    } else if (changes.length > 0) {
      await BoardSubjectDefinition.updateOne({ _id: existing._id, tenantId: ctx.tenantId }, { $set: { ...next, updatedBy: ctx.userId } }, { session });
    }
    if (changes.length > 0) {
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'subject',
          entityId: subjectId,
          action: 'subject.board_code_set',
          actor: actorFrom(ctx),
          changes,
          metadata: { boardRuleVersionId: version._id, boardId: version.boardId, ruleVersionName: version.name },
          requestId: ctx.requestId,
        },
        session,
      );
    }
    return getSubjectDTO(ctx, subjectId, session);
  });
}

/** `DELETE /subjects/:id/board-codes/:ruleVersionId` — blocked while a subject offering still uses the mapping. */
export async function removeBoardSubjectCode(ctx: ServiceContext, subjectId: string, boardRuleVersionId: string): Promise<SubjectDTO> {
  return withTransaction(async (session) => {
    await getSubjectOrThrow(ctx, subjectId, session);
    const existing = await BoardSubjectDefinition.findOne({ tenantId: ctx.tenantId, subjectId, boardRuleVersionId }).session(session).lean<BoardSubjectDefinitionDoc>();
    if (!existing) throw AppError.notFound('Board code mapping not found.');

    const inUse = await SubjectOffering.countDocuments({ tenantId: ctx.tenantId, boardSubjectDefinitionId: existing._id }).session(session);
    if (inUse > 0) {
      throw new AppError('ACADEMIC_HAS_DEPENDENCIES', 'This board code is used by subject offerings. Unlink it from those offerings first.', {
        dependencies: [{ key: 'academic.subject_offerings', label: 'Subject offerings', count: inUse, message: `${inUse} subject offering${inUse === 1 ? ' uses' : 's use'} this board code.` }],
      });
    }
    await BoardSubjectDefinition.deleteOne({ _id: existing._id, tenantId: ctx.tenantId }, { session });
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'subject',
        entityId: subjectId,
        action: 'subject.board_code_removed',
        actor: actorFrom(ctx),
        changes: [{ field: 'boardSubjectCode', from: existing.boardSubjectCode, to: null }],
        metadata: { boardRuleVersionId },
        requestId: ctx.requestId,
      },
      session,
    );
    return getSubjectDTO(ctx, subjectId, session);
  });
}
