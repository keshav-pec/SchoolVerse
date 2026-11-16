import { Schema, model } from 'mongoose';
import {
  CHANGE_FIELD_CATEGORIES,
  CHANGE_REQUEST_STATUSES,
  DOCUMENT_MIME_TYPES,
  DOCUMENT_STATUSES,
  DOCUMENT_TYPES,
  EXPORT_PURPOSES,
  type ChangeFieldCategory,
  type ChangeRequestStatus,
  type DocumentMimeType,
  type DocumentStatus,
  type DocumentType,
  type ExportPurpose,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

// ───────────────────────────────────────────────────────────── documents (FSM-08)

/** Metadata only. The bytes sit in private storage under `objectKey`, a random key. No URL is ever stored. */
export interface EmployeeDocumentDoc extends BaseDoc, AuditFields {
  tenantId: string;
  personId: string;
  employeeId: string;
  documentType: DocumentType;
  objectKey: string;
  displayName: string;
  mime: DocumentMimeType;
  sizeBytes: number;
  sha256: string;
  status: DocumentStatus;
  deletedAt: Date | null;
}

const documentSchema = new Schema<EmployeeDocumentDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    personId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    documentType: { type: String, enum: DOCUMENT_TYPES, required: true },
    objectKey: { type: String, required: true },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    mime: { type: String, enum: DOCUMENT_MIME_TYPES, required: true },
    sizeBytes: { type: Number, required: true, min: 0 },
    sha256: { type: String, required: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'ACTIVE', required: true },
    deletedAt: { type: Date, default: null },
    ...auditFields,
  },
  baseSchemaOptions('employee_documents'),
);
documentSchema.index({ tenantId: 1, employeeId: 1, status: 1 });
documentSchema.index({ tenantId: 1, personId: 1 });
documentSchema.plugin(tenantScopePlugin);

export const EmployeeDocument = model<EmployeeDocumentDoc>('EmployeeDocument', documentSchema);

// ───────────────────────────────────────────────────────────── change requests (FSM-07)

export interface ProfileChangeRequestDoc extends BaseDoc, AuditFields {
  tenantId: string;
  employeeId: string;
  personId: string;
  fieldCategory: ChangeFieldCategory;
  /** The proposed value as JSON, encrypted. Approvers see a masked summary, never this. */
  proposedValueEnc: string;
  reason: string | null;
  status: ChangeRequestStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
}

const changeRequestSchema = new Schema<ProfileChangeRequestDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    personId: { type: String, required: true, immutable: true },
    fieldCategory: { type: String, enum: CHANGE_FIELD_CATEGORIES, required: true, immutable: true },
    proposedValueEnc: { type: String, required: true },
    reason: { type: String, default: null, maxlength: 300 },
    status: { type: String, enum: CHANGE_REQUEST_STATUSES, default: 'PENDING', required: true },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: null, maxlength: 300 },
    ...auditFields,
  },
  baseSchemaOptions('profile_change_requests'),
);
// One pending request per employee and detail.
changeRequestSchema.index(
  { tenantId: 1, employeeId: 1, fieldCategory: 1 },
  { unique: true, partialFilterExpression: { status: 'PENDING' }, name: 'one_pending_request_per_field' },
);
changeRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
changeRequestSchema.plugin(tenantScopePlugin);

export const ProfileChangeRequest = model<ProfileChangeRequestDoc>('ProfileChangeRequest', changeRequestSchema);

// ───────────────────────────────────────────────────────────── exports (SEC-05)

export interface ExportDoc extends BaseDoc {
  tenantId: string;
  requestedBy: string;
  purpose: ExportPurpose;
  fileName: string;
  objectKey: string;
  rowCount: number;
  /** The link stops working at this time. The file itself is removed by the hourly cleanup. */
  expiresAt: Date;
}

/** Seconds a finished export record is kept after its link expires (the cleanup job removes the file first). */
export const EXPORT_RECORD_GRACE_SECONDS = 24 * 60 * 60;

const exportSchema = new Schema<ExportDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    requestedBy: { type: String, required: true },
    purpose: { type: String, enum: EXPORT_PURPOSES, required: true },
    fileName: { type: String, required: true },
    objectKey: { type: String, required: true },
    rowCount: { type: Number, required: true, min: 0 },
    expiresAt: { type: Date, required: true },
  },
  baseSchemaOptions('exports'),
);
exportSchema.index({ expiresAt: 1 }, { expireAfterSeconds: EXPORT_RECORD_GRACE_SECONDS });
exportSchema.plugin(tenantScopePlugin);

export const StaffExport = model<ExportDoc>('StaffExport', exportSchema);
