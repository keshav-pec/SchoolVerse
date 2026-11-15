import { Schema, model } from 'mongoose';
import { SUBJECT_CATEGORIES, SUBJECT_STATUSES, type SubjectCategory, type SubjectStatus } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/** AS-05 — the school's subject master. Offerings reference `_id`, so codes and names can change safely. */
export interface SubjectDoc extends BaseDoc, AuditFields {
  tenantId: string;
  subjectCode: string;
  name: string;
  shortName: string | null;
  category: SubjectCategory;
  languageCode: string | null;
  hasTheory: boolean;
  hasPractical: boolean;
  hasProject: boolean;
  hasInternalAssessment: boolean;
  status: SubjectStatus;
}

const subjectSchema = new Schema<SubjectDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    subjectCode: { type: String, required: true, uppercase: true, trim: true },
    name: { type: String, required: true, trim: true },
    shortName: { type: String, default: null },
    category: { type: String, enum: SUBJECT_CATEGORIES, required: true },
    languageCode: { type: String, default: null },
    hasTheory: { type: Boolean, default: true },
    hasPractical: { type: Boolean, default: false },
    hasProject: { type: Boolean, default: false },
    hasInternalAssessment: { type: Boolean, default: false },
    status: { type: String, enum: SUBJECT_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('subjects'),
);
subjectSchema.index({ tenantId: 1, subjectCode: 1 }, { unique: true });
subjectSchema.index({ tenantId: 1, status: 1, name: 1 });
subjectSchema.plugin(tenantScopePlugin);

export const Subject = model<SubjectDoc>('Subject', subjectSchema);

/** AS-06 — a subject's official code on a board rule version. The internal subject stays stable. */
export interface BoardSubjectDefinitionDoc extends BaseDoc, AuditFields {
  tenantId: string;
  subjectId: string;
  boardRuleVersionId: string;
  boardSubjectCode: string;
  boardSubjectName: string | null;
}

const boardSubjectDefinitionSchema = new Schema<BoardSubjectDefinitionDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    subjectId: { type: String, required: true, immutable: true },
    boardRuleVersionId: { type: String, required: true, immutable: true },
    boardSubjectCode: { type: String, required: true, trim: true },
    boardSubjectName: { type: String, default: null },
    ...auditFields,
  },
  baseSchemaOptions('board_subject_definitions'),
);
boardSubjectDefinitionSchema.index({ tenantId: 1, subjectId: 1, boardRuleVersionId: 1 }, { unique: true });
boardSubjectDefinitionSchema.index({ tenantId: 1, boardSubjectCode: 1 });
boardSubjectDefinitionSchema.plugin(tenantScopePlugin);

export const BoardSubjectDefinition = model<BoardSubjectDefinitionDoc>('BoardSubjectDefinition', boardSubjectDefinitionSchema);
