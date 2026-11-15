import { Schema, model } from 'mongoose';
import {
  BOARD_STATUSES,
  BOARD_TYPES,
  EDUCATION_STAGES,
  RULE_VERSION_STATUSES,
  type BoardStatus,
  type BoardType,
  type EducationStage,
  type RuleVersionStatus,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';

/**
 * Reference data (Module 2, AS-01/AS-03).
 *
 * Boards, rule versions and the grade master are SYSTEM data: seeded rows with `tenantId: null`,
 * readable by every school and editable by none. A school can add its own board (and rule versions)
 * with its `tenantId` set. Because of that mix these collections do NOT use `tenantScopePlugin`;
 * always read them through `visibleToTenant(tenantId)` below so another school's own boards never leak.
 */
export const visibleToTenant = (tenantId: string) => ({ $or: [{ tenantId: null }, { tenantId }] });

export interface EducationBoardDoc extends BaseDoc, AuditFields {
  tenantId: string | null;
  boardCode: string;
  boardName: string;
  boardType: BoardType;
  stateCode: string | null;
  status: BoardStatus;
}

const educationBoardSchema = new Schema<EducationBoardDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, default: null, immutable: true },
    boardCode: { type: String, required: true, uppercase: true, trim: true },
    boardName: { type: String, required: true, trim: true },
    boardType: { type: String, enum: BOARD_TYPES, default: 'OTHER', required: true },
    stateCode: { type: String, default: null },
    status: { type: String, enum: BOARD_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('education_boards'),
);
// `tenantId: null` rows are the system boards, so one system row per code and one row per code per school.
educationBoardSchema.index({ tenantId: 1, boardCode: 1 }, { unique: true });

export const EducationBoard = model<EducationBoardDoc>('EducationBoard', educationBoardSchema);

export interface BoardRuleVersionDoc extends BaseDoc, AuditFields {
  tenantId: string | null;
  boardId: string;
  name: string;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  sourceReference: string | null;
  status: RuleVersionStatus;
}

const boardRuleVersionSchema = new Schema<BoardRuleVersionDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, default: null, immutable: true },
    boardId: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true },
    effectiveFrom: { type: String, default: null },
    effectiveTo: { type: String, default: null },
    sourceReference: { type: String, default: null },
    status: { type: String, enum: RULE_VERSION_STATUSES, default: 'DRAFT', required: true },
    ...auditFields,
  },
  baseSchemaOptions('board_rule_versions'),
);
boardRuleVersionSchema.index({ boardId: 1, name: 1 }, { unique: true });
boardRuleVersionSchema.index({ tenantId: 1, boardId: 1 });

export const BoardRuleVersion = model<BoardRuleVersionDoc>('BoardRuleVersion', boardRuleVersionSchema);

export interface GradeMasterDoc extends BaseDoc {
  canonicalCode: string;
  canonicalName: string;
  shortCode: string;
  sequenceNumber: number;
  educationStage: EducationStage;
  isPrePrimary: boolean;
  isBoardGrade: boolean;
}

const gradeMasterSchema = new Schema<GradeMasterDoc>(
  {
    ...uuidPrimaryKey,
    canonicalCode: { type: String, required: true },
    canonicalName: { type: String, required: true },
    shortCode: { type: String, required: true },
    sequenceNumber: { type: Number, required: true },
    educationStage: { type: String, enum: EDUCATION_STAGES, required: true },
    isPrePrimary: { type: Boolean, default: false },
    isBoardGrade: { type: Boolean, default: false },
  },
  baseSchemaOptions('grade_master'),
);
gradeMasterSchema.index({ canonicalCode: 1 }, { unique: true });

export const GradeMaster = model<GradeMasterDoc>('GradeMaster', gradeMasterSchema);
