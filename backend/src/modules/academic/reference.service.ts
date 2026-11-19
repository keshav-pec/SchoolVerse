import type { ClientSession } from 'mongoose';
import type { BoardDTO, BoardRuleVersionDTO, CreateBoardData, CreateRuleVersionData, ClassMasterDTO, RuleVersionStatus } from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields, onDuplicate } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { actorFrom, can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import {
  BoardRuleVersion,
  EducationBoard,
  ClassMaster,
  visibleToTenant,
  type BoardRuleVersionDoc,
  type EducationBoardDoc,
  type ClassMasterDoc,
} from './reference.model';

/** AS-01 / AS-03 — boards, rule versions and the class master. System rows are read-only. */

// ───────────────────────────────────────────────────────────── mapping

export function toBoardDTO(doc: EducationBoardDoc): BoardDTO {
  return {
    boardId: doc._id,
    boardCode: doc.boardCode,
    boardName: doc.boardName,
    boardType: doc.boardType,
    stateCode: doc.stateCode ?? null,
    status: doc.status,
    isSystem: doc.tenantId === null,
  };
}

export function toRuleVersionDTO(doc: BoardRuleVersionDoc): BoardRuleVersionDTO {
  return {
    ruleVersionId: doc._id,
    boardId: doc.boardId,
    name: doc.name,
    effectiveFrom: doc.effectiveFrom ?? null,
    effectiveTo: doc.effectiveTo ?? null,
    sourceReference: doc.sourceReference ?? null,
    status: doc.status,
    isSystem: doc.tenantId === null,
  };
}

export function toClassDTO(doc: ClassMasterDoc): ClassMasterDTO {
  return {
    classId: doc._id,
    canonicalCode: doc.canonicalCode,
    canonicalName: doc.canonicalName,
    shortCode: doc.shortCode,
    sequenceNumber: doc.sequenceNumber,
    educationStage: doc.educationStage,
    isPrePrimary: doc.isPrePrimary,
    isBoardClass: doc.isBoardClass,
  };
}

// ───────────────────────────────────────────────────────────── reads

export async function listBoards(ctx: ServiceContext): Promise<BoardDTO[]> {
  const rows = await EducationBoard.find({ ...visibleToTenant(ctx.tenantId), status: 'ACTIVE' })
    .sort({ tenantId: 1, boardName: 1 })
    .lean<EducationBoardDoc[]>();
  // System boards first, then the school's own.
  return rows.sort((a, b) => Number(b.tenantId === null) - Number(a.tenantId === null) || a.boardName.localeCompare(b.boardName)).map(toBoardDTO);
}

/** A board the tenant may see (system or its own); anything else — including other tenants' boards — is a 404. */
export async function getBoardOrThrow(tenantId: string, boardId: string, session?: ClientSession) {
  const board = await EducationBoard.findOne({ _id: boardId, ...visibleToTenant(tenantId) }).session(session ?? null).lean<EducationBoardDoc>();
  if (!board) throw AppError.notFound('Board not found.');
  return board;
}

export async function listRuleVersions(ctx: ServiceContext, boardId: string): Promise<BoardRuleVersionDTO[]> {
  await getBoardOrThrow(ctx.tenantId, boardId);
  // Drafts of a school's own board are configuration; limited roles only see published / retired ones.
  const statuses: RuleVersionStatus[] = can(ctx, 'academic:view_config') ? ['DRAFT', 'PUBLISHED', 'RETIRED'] : ['PUBLISHED', 'RETIRED'];
  const rows = await BoardRuleVersion.find({ boardId, ...visibleToTenant(ctx.tenantId), status: { $in: statuses } })
    .sort({ effectiveFrom: -1, name: -1 })
    .lean<BoardRuleVersionDoc[]>();
  return rows.map(toRuleVersionDTO);
}

export async function listClasses(): Promise<ClassMasterDTO[]> {
  const rows = await ClassMaster.find().sort({ sequenceNumber: 1 }).lean<ClassMasterDoc[]>();
  return rows.map(toClassDTO);
}

export async function getClassesByIds(classIds: string[], session?: ClientSession) {
  return ClassMaster.find({ _id: { $in: classIds } }).session(session ?? null).lean<ClassMasterDoc[]>();
}

/** The version a session pins for a location: it must belong to the board and be PUBLISHED. */
export async function getUsableRuleVersion(tenantId: string, boardId: string, ruleVersionId: string, session?: ClientSession) {
  const [board, version] = await Promise.all([
    EducationBoard.findOne({ _id: boardId, ...visibleToTenant(tenantId) }).session(session ?? null).lean<EducationBoardDoc>(),
    BoardRuleVersion.findOne({ _id: ruleVersionId, boardId, ...visibleToTenant(tenantId) }).session(session ?? null).lean<BoardRuleVersionDoc>(),
  ]);
  if (!board) throw AppError.notFound('Board not found.');
  if (!version || version.status !== 'PUBLISHED') throw new AppError('RULE_VERSION_INVALID');
  return { board, version };
}

// ───────────────────────────────────────────────────────────── school-created boards ("configure from blank")

export async function createBoard(ctx: ServiceContext, data: CreateBoardData): Promise<BoardDTO> {
  return withTransaction(async (session) => {
    // A school cannot re-use a built-in code: "CBSE" must always mean the built-in board.
    const systemClash = await EducationBoard.exists({ tenantId: null, boardCode: data.boardCode }).session(session);
    if (systemClash) throw boardCodeTaken();

    const [created] = await EducationBoard.create(
      [{ ...data, stateCode: data.stateCode ?? null, tenantId: ctx.tenantId, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session },
    );
    const board = created!.toObject() as EducationBoardDoc;
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'education_board',
        entityId: board._id,
        action: 'board.created',
        actor: actorFrom(ctx),
        changes: [
          { field: 'boardCode', from: null, to: board.boardCode },
          { field: 'boardName', from: null, to: board.boardName },
          { field: 'boardType', from: null, to: board.boardType },
        ],
        requestId: ctx.requestId,
      },
      session,
    );
    return toBoardDTO(board);
  }).catch(onDuplicate('boardCode', boardCodeTaken));
}

function boardCodeTaken() {
  return new AppError('BOARD_CODE_TAKEN', undefined, { fields: { boardCode: 'This board code is already in use.' } });
}

function assertOwnBoard(board: EducationBoardDoc) {
  if (board.tenantId === null) throw new AppError('BOARD_READ_ONLY');
}

export async function createRuleVersion(ctx: ServiceContext, boardId: string, data: CreateRuleVersionData): Promise<BoardRuleVersionDTO> {
  try {
    return await withTransaction(async (session) => {
      const board = await getBoardOrThrow(ctx.tenantId, boardId, session);
      assertOwnBoard(board);
      const [created] = await BoardRuleVersion.create(
        [
          {
            tenantId: ctx.tenantId,
            boardId,
            name: data.name,
            effectiveFrom: data.effectiveFrom ?? null,
            effectiveTo: data.effectiveTo ?? null,
            sourceReference: data.sourceReference ?? null,
            status: 'DRAFT',
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session },
      );
      const version = created!.toObject() as BoardRuleVersionDoc;
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'board_rule_version',
          entityId: version._id,
          action: 'rule_version.created',
          actor: actorFrom(ctx),
          changes: [
            { field: 'name', from: null, to: version.name },
            { field: 'status', from: null, to: version.status },
          ],
          metadata: { boardId, boardCode: board.boardCode },
          requestId: ctx.requestId,
        },
        session,
      );
      return toRuleVersionDTO(version);
    });
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('name')) {
      throw new AppError('CONFLICT', 'This board already has a rule version with that name.', { fields: { name: 'This name is already in use for this board.' } });
    }
    throw err;
  }
}

/** DRAFT → PUBLISHED. A published version is what sessions can pin; it is never edited afterwards. */
export async function publishRuleVersion(ctx: ServiceContext, boardId: string, ruleVersionId: string): Promise<BoardRuleVersionDTO> {
  return withTransaction(async (session) => {
    const board = await getBoardOrThrow(ctx.tenantId, boardId, session);
    assertOwnBoard(board);
    const version = await BoardRuleVersion.findOne({ _id: ruleVersionId, boardId, tenantId: ctx.tenantId }).session(session).lean<BoardRuleVersionDoc>();
    if (!version) throw AppError.notFound('Rule version not found.');
    if (version.status !== 'DRAFT') {
      throw new AppError('INVALID_STATUS_TRANSITION', 'Only a draft rule version can be published.', { from: version.status, action: 'publish' });
    }
    await BoardRuleVersion.updateOne({ _id: ruleVersionId, tenantId: ctx.tenantId }, { $set: { status: 'PUBLISHED', updatedBy: ctx.userId } }, { session });
    await recordAudit(
      {
        tenantId: ctx.tenantId,
        entityType: 'board_rule_version',
        entityId: ruleVersionId,
        action: 'rule_version.published',
        actor: actorFrom(ctx),
        changes: [{ field: 'status', from: 'DRAFT', to: 'PUBLISHED' }],
        metadata: { boardId, boardCode: board.boardCode },
        requestId: ctx.requestId,
      },
      session,
    );
    return toRuleVersionDTO({ ...version, status: 'PUBLISHED' });
  });
}
