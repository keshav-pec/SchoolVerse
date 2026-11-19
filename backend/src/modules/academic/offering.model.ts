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

/** AS-03 — a class as taught at one location in one session. */
export interface ClassOfferingDoc extends BaseDoc, AuditFields {
  tenantId: string;
  sessionId: string;
  locationId: string;
  classId: string;
  displayName: string;
  displayCode: string;
  medium: string | null;
  capacity: number | null;
  sequenceOrder: number;
  status: OfferingStatus;
}

const classOfferingSchema = new Schema<ClassOfferingDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    classId: { type: String, required: true, immutable: true },
    displayName: { type: String, required: true, trim: true },
    displayCode: { type: String, required: true, trim: true },
    medium: { type: String, default: null },
    capacity: { type: Number, default: null },
    sequenceOrder: { type: Number, default: 0 },
    status: { type: String, enum: OFFERING_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('class_offerings'),
);
classOfferingSchema.index({ tenantId: 1, sessionId: 1, locationId: 1, classId: 1 }, { unique: true });
classOfferingSchema.index({ tenantId: 1, locationId: 1 });
classOfferingSchema.plugin(tenantScopePlugin);

export const ClassOffering = model<ClassOfferingDoc>('ClassOffering', classOfferingSchema);

/** AS-04 — a section of a class offering. Codes are stored upper-cased, so "a" and "A" collide. */
export interface SectionOfferingDoc extends BaseDoc, AuditFields {
  tenantId: string;
  classOfferingId: string;
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
    classOfferingId: { type: String, required: true, immutable: true },
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
sectionOfferingSchema.index({ tenantId: 1, classOfferingId: 1, sectionCode: 1 }, { unique: true });
sectionOfferingSchema.index({ tenantId: 1, sessionId: 1 });
sectionOfferingSchema.plugin(tenantScopePlugin);

export const SectionOffering = model<SectionOfferingDoc>('SectionOffering', sectionOfferingSchema);

/** AS-07 — a subject taught in a class offering. */
export interface SubjectOfferingDoc extends BaseDoc, AuditFields {
  tenantId: string;
  classOfferingId: string;
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
    classOfferingId: { type: String, required: true, immutable: true },
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
subjectOfferingSchema.index({ tenantId: 1, classOfferingId: 1, subjectId: 1 }, { unique: true });
subjectOfferingSchema.index({ tenantId: 1, sessionId: 1 });
subjectOfferingSchema.index({ tenantId: 1, subjectId: 1 });
subjectOfferingSchema.plugin(tenantScopePlugin);

export const SubjectOffering = model<SubjectOfferingDoc>('SubjectOffering', subjectOfferingSchema);
