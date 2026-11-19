import { Schema, model } from 'mongoose';
import {
  CHOICE_RULE_TYPES,
  CONSTRAINT_TYPES,
  OFFERING_STATUSES,
  PROGRAMME_KINDS,
  PROGRAMME_REQUIREMENTS,
  type ChoiceRuleType,
  type ConstraintType,
  type OfferingStatus,
  type ProgrammeKind,
  type ProgrammeRequirement,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/** AS-08 — a group of subject offerings with a rule ("choose 1 of Punjabi, Hindi, Urdu"). All data, no board branches. */
export interface SubjectChoiceGroupDoc extends BaseDoc, AuditFields {
  tenantId: string;
  classOfferingId: string;
  sessionId: string;
  locationId: string;
  name: string;
  ruleType: ChoiceRuleType;
  min: number;
  max: number;
  sequence: number;
  subjectOfferingIds: string[];
  status: OfferingStatus;
}

const subjectChoiceGroupSchema = new Schema<SubjectChoiceGroupDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    classOfferingId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true },
    ruleType: { type: String, enum: CHOICE_RULE_TYPES, required: true },
    min: { type: Number, default: 0 },
    max: { type: Number, default: 0 },
    sequence: { type: Number, default: 0 },
    subjectOfferingIds: { type: [String], default: [] },
    status: { type: String, enum: OFFERING_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('subject_choice_groups'),
);
subjectChoiceGroupSchema.index({ tenantId: 1, classOfferingId: 1, sequence: 1 });
subjectChoiceGroupSchema.index({ tenantId: 1, sessionId: 1 });
subjectChoiceGroupSchema.plugin(tenantScopePlugin);

export const SubjectChoiceGroup = model<SubjectChoiceGroupDoc>('SubjectChoiceGroup', subjectChoiceGroupSchema);

/** AS-09 — "A requires B" / "A excludes B" between two offerings of the same class. */
export interface SubjectChoiceConstraintDoc extends BaseDoc, AuditFields {
  tenantId: string;
  classOfferingId: string;
  sessionId: string;
  locationId: string;
  type: ConstraintType;
  subjectOfferingId: string;
  otherSubjectOfferingId: string;
}

const subjectChoiceConstraintSchema = new Schema<SubjectChoiceConstraintDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    classOfferingId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    type: { type: String, enum: CONSTRAINT_TYPES, required: true, immutable: true },
    subjectOfferingId: { type: String, required: true, immutable: true },
    otherSubjectOfferingId: { type: String, required: true, immutable: true },
    ...auditFields,
  },
  baseSchemaOptions('subject_choice_constraints'),
);
subjectChoiceConstraintSchema.index({ tenantId: 1, classOfferingId: 1, type: 1, subjectOfferingId: 1, otherSubjectOfferingId: 1 }, { unique: true });
subjectChoiceConstraintSchema.index({ tenantId: 1, sessionId: 1 });
subjectChoiceConstraintSchema.plugin(tenantScopePlugin);

export const SubjectChoiceConstraint = model<SubjectChoiceConstraintDoc>('SubjectChoiceConstraint', subjectChoiceConstraintSchema);

/** AS-10 / AS-11 — a stream (fixed subject rules) or a flexible combination (rules come from the class's groups). */
export interface ProgrammeSubjectRule {
  subjectOfferingId: string;
  requirement: ProgrammeRequirement;
}

export interface AcademicProgrammeDoc extends BaseDoc, AuditFields {
  tenantId: string;
  sessionId: string;
  locationId: string;
  name: string;
  code: string;
  kind: ProgrammeKind;
  classFromId: string;
  classToId: string;
  boardId: string | null;
  subjectRules: ProgrammeSubjectRule[];
  choiceMin: number | null;
  choiceMax: number | null;
  status: OfferingStatus;
}

const subjectRuleSchema = new Schema<ProgrammeSubjectRule>(
  {
    subjectOfferingId: { type: String, required: true },
    requirement: { type: String, enum: PROGRAMME_REQUIREMENTS, required: true },
  },
  { _id: false },
);

const academicProgrammeSchema = new Schema<AcademicProgrammeDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    kind: { type: String, enum: PROGRAMME_KINDS, required: true },
    classFromId: { type: String, required: true },
    classToId: { type: String, required: true },
    boardId: { type: String, default: null },
    subjectRules: { type: [subjectRuleSchema], default: [] },
    choiceMin: { type: Number, default: null },
    choiceMax: { type: Number, default: null },
    status: { type: String, enum: OFFERING_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('academic_programmes'),
);
academicProgrammeSchema.index({ tenantId: 1, sessionId: 1, locationId: 1, code: 1 }, { unique: true });
academicProgrammeSchema.plugin(tenantScopePlugin);

export const AcademicProgramme = model<AcademicProgrammeDoc>('AcademicProgramme', academicProgrammeSchema);
