import { Schema, model } from 'mongoose';
import {
  OFFERING_STATUSES,
  SUBJECT_OFFERING_TYPES,
  type OfferingStatus,
  type SubjectOfferingType,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Offerings are the per-session, per-location instances of the masters (PRD §2.1).
 * Other modules store these UUIDs, never labels.
 */

/** AS-03 — a grade as taught at one location in one session. */
export interface GradeOfferingDoc extends BaseDoc, AuditFields {
  tenantId: string;
  sessionId: string;
  locationId: string;
  gradeId: string;
  displayName: string;
  displayCode: string;
  medium: string | null;
  capacity: number | null;
  sequenceOrder: number;
  status: OfferingStatus;
}

const gradeOfferingSchema = new Schema<GradeOfferingDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    gradeId: { type: String, required: true, immutable: true },
    displayName: { type: String, required: true, trim: true },
    displayCode: { type: String, required: true, trim: true },
    medium: { type: String, default: null },
    capacity: { type: Number, default: null },
    sequenceOrder: { type: Number, default: 0 },
    status: { type: String, enum: OFFERING_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('grade_offerings'),
);
gradeOfferingSchema.index({ tenantId: 1, sessionId: 1, locationId: 1, gradeId: 1 }, { unique: true });
gradeOfferingSchema.index({ tenantId: 1, locationId: 1 });
gradeOfferingSchema.plugin(tenantScopePlugin);

export const GradeOffering = model<GradeOfferingDoc>('GradeOffering', gradeOfferingSchema);

/** AS-04 — a section of a grade offering. Codes are stored upper-cased, so "a" and "A" collide. */
export interface SectionOfferingDoc extends BaseDoc, AuditFields {
  tenantId: string;
  gradeOfferingId: string;
  sessionId: string;
  locationId: string;
  sectionCode: string;
  displayName: string;
  capacity: number | null;
  sequenceOrder: number;
  status: OfferingStatus;
}

const sectionOfferingSchema = new Schema<SectionOfferingDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    gradeOfferingId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    sectionCode: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    displayName: { type: String, required: true, trim: true },
    capacity: { type: Number, default: null },
    sequenceOrder: { type: Number, default: 0 },
    status: { type: String, enum: OFFERING_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('section_offerings'),
);
sectionOfferingSchema.index({ tenantId: 1, gradeOfferingId: 1, sectionCode: 1 }, { unique: true });
sectionOfferingSchema.index({ tenantId: 1, sessionId: 1 });
sectionOfferingSchema.plugin(tenantScopePlugin);

export const SectionOffering = model<SectionOfferingDoc>('SectionOffering', sectionOfferingSchema);

/** AS-07 — a subject taught in a grade offering. */
export interface SubjectOfferingDoc extends BaseDoc, AuditFields {
  tenantId: string;
  gradeOfferingId: string;
  sessionId: string;
  locationId: string;
  subjectId: string;
  boardSubjectDefinitionId: string | null;
  offeringType: SubjectOfferingType;
  status: OfferingStatus;
}

const subjectOfferingSchema = new Schema<SubjectOfferingDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    gradeOfferingId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    subjectId: { type: String, required: true, immutable: true },
    boardSubjectDefinitionId: { type: String, default: null },
    offeringType: { type: String, enum: SUBJECT_OFFERING_TYPES, required: true },
    status: { type: String, enum: OFFERING_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('subject_offerings'),
);
subjectOfferingSchema.index({ tenantId: 1, gradeOfferingId: 1, subjectId: 1 }, { unique: true });
subjectOfferingSchema.index({ tenantId: 1, sessionId: 1 });
subjectOfferingSchema.index({ tenantId: 1, subjectId: 1 });
subjectOfferingSchema.plugin(tenantScopePlugin);

export const SubjectOffering = model<SubjectOfferingDoc>('SubjectOffering', subjectOfferingSchema);
