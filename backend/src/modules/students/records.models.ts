import { Schema, model } from 'mongoose';
import {
  CHANGE_REQUEST_STATUSES,
  DOCUMENT_STATUSES,
  DUES_STATUSES,
  IMPORT_MODES,
  IMPORT_ROW_STATUSES,
  IMPORT_STATUSES,
  STUDENT_CHANGE_FIELDS,
  STUDENT_DOCUMENT_TYPES,
  STUDENT_EXPORT_PURPOSES,
  TC_COPY_TYPES,
  TC_STATUSES,
  type ChangeRequestStatus,
  type DocumentMimeType,
  type DocumentStatus,
  type DuesStatus,
  type ImportField,
  type ImportIssueDTO,
  type ImportMode,
  type ImportRowStatus,
  type ImportStatus,
  type StudentChangeField,
  type StudentDocumentType,
  type StudentExportPurpose,
  type TcCopyType,
  type TcStatus,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Module 4, Part 3 collections: private documents, parent change requests, transfer certificates, import files and rows,
 * export records, and a counter for certificate numbers. Every collection is `tenantScope`d.
 */

// ───────────────────────────────────────────────────────────── documents

export interface StudentDocumentDoc extends BaseDoc, AuditFields {
  tenantId: string;
  studentId: string;
  documentType: StudentDocumentType;
  /** A random key in private storage. No URL is ever stored. */
  objectKey: string;
  displayName: string;
  mime: DocumentMimeType;
  sizeBytes: number;
  sha256: string;
  status: DocumentStatus;
  deletedAt: Date | null;
  /** Set on the PDF the school makes when it issues a transfer certificate. */
  generatedForCertificateId: string | null;
}

const documentSchema = new Schema<StudentDocumentDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    documentType: { type: String, enum: STUDENT_DOCUMENT_TYPES, required: true },
    objectKey: { type: String, required: true, immutable: true },
    displayName: { type: String, required: true, trim: true, maxlength: 120 },
    mime: { type: String, required: true },
    sizeBytes: { type: Number, required: true },
    sha256: { type: String, required: true },
    status: { type: String, enum: DOCUMENT_STATUSES, default: 'ACTIVE', required: true },
    deletedAt: { type: Date, default: null },
    generatedForCertificateId: { type: String, default: null },
    ...auditFields,
  },
  baseSchemaOptions('student_documents'),
);
documentSchema.index({ tenantId: 1, studentId: 1, status: 1 });
documentSchema.plugin(tenantScopePlugin);

export const StudentDocument = model<StudentDocumentDoc>('StudentDocument', documentSchema);

// ───────────────────────────────────────────────────────────── parent change requests

export interface StudentChangeRequestDoc extends BaseDoc {
  tenantId: string;
  studentId: string;
  requestedByUserId: string;
  /** The parent person who asked. A contact change is applied to this person. */
  guardianPersonId: string;
  field: StudentChangeField;
  oldValue: Record<string, unknown>;
  proposedValue: Record<string, unknown>;
  reason: string | null;
  status: ChangeRequestStatus;
  decidedBy: string | null;
  decidedAt: Date | null;
  decisionNote: string | null;
}

const changeRequestSchema = new Schema<StudentChangeRequestDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    requestedByUserId: { type: String, required: true, immutable: true },
    guardianPersonId: { type: String, required: true, immutable: true },
    field: { type: String, enum: STUDENT_CHANGE_FIELDS, required: true, immutable: true },
    oldValue: { type: Schema.Types.Mixed, required: true },
    proposedValue: { type: Schema.Types.Mixed, required: true },
    reason: { type: String, default: null, maxlength: 300 },
    status: { type: String, enum: CHANGE_REQUEST_STATUSES, default: 'PENDING', required: true },
    decidedBy: { type: String, default: null },
    decidedAt: { type: Date, default: null },
    decisionNote: { type: String, default: null, maxlength: 300 },
  },
  { ...baseSchemaOptions('student_change_requests'), minimize: false },
);
// One waiting request per detail, per child, per parent.
changeRequestSchema.index({ tenantId: 1, studentId: 1, field: 1, requestedByUserId: 1 }, { unique: true, partialFilterExpression: { status: 'PENDING' }, name: 'one_pending_request_per_field' });
changeRequestSchema.index({ tenantId: 1, status: 1, createdAt: -1 });
changeRequestSchema.index({ tenantId: 1, requestedByUserId: 1, createdAt: -1 });
changeRequestSchema.plugin(tenantScopePlugin);

export const StudentChangeRequest = model<StudentChangeRequestDoc>('StudentChangeRequest', changeRequestSchema);

// ───────────────────────────────────────────────────────────── transfer certificates

export interface StudentTransferCertificateDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  studentId: string;
  enrollmentId: string | null;
  /** Null until the certificate is issued. Numbers are never reused. */
  certificateNumber: string | null;
  applicationDate: string;
  issueDate: string | null;
  leavingDate: string;
  reasonForLeaving: string;
  lastClass: string;
  result: string | null;
  duesStatus: DuesStatus;
  issuedBy: string | null;
  copyType: TcCopyType;
  /** The PDF the school made (a `student_documents` row). */
  documentId: string | null;
  originalCertificateId: string | null;
  duplicateReason: string | null;
  status: TcStatus;
}

const certificateSchema = new Schema<StudentTransferCertificateDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    studentId: { type: String, required: true, immutable: true },
    enrollmentId: { type: String, default: null },
    certificateNumber: { type: String, default: null },
    applicationDate: { type: String, required: true },
    issueDate: { type: String, default: null },
    leavingDate: { type: String, required: true },
    reasonForLeaving: { type: String, required: true, maxlength: 300 },
    lastClass: { type: String, required: true },
    result: { type: String, default: null },
    duesStatus: { type: String, enum: DUES_STATUSES, default: 'PENDING', required: true },
    issuedBy: { type: String, default: null },
    copyType: { type: String, enum: TC_COPY_TYPES, default: 'ORIGINAL', required: true },
    documentId: { type: String, default: null },
    originalCertificateId: { type: String, default: null },
    duplicateReason: { type: String, default: null, maxlength: 300 },
    status: { type: String, enum: TC_STATUSES, default: 'REQUESTED', required: true },
    ...auditFields,
  },
  baseSchemaOptions('student_transfer_certificates'),
);
certificateSchema.index({ tenantId: 1, schoolId: 1, certificateNumber: 1 }, { unique: true, partialFilterExpression: { certificateNumber: { $type: 'string' } }, name: 'unique_certificate_number' });
// A student has one certificate in progress at a time (issued and cancelled ones are history).
certificateSchema.index({ tenantId: 1, studentId: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['REQUESTED', 'UNDER_REVIEW', 'PENDING_CLEARANCE', 'APPROVED'] } }, name: 'one_open_certificate_per_student' });
certificateSchema.index({ tenantId: 1, status: 1 });
certificateSchema.plugin(tenantScopePlugin);

export const StudentTransferCertificate = model<StudentTransferCertificateDoc>('StudentTransferCertificate', certificateSchema);

// ───────────────────────────────────────────────────────────── import

export interface StudentImportDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  fileName: string;
  /** SHA-256 of the file. With the row number and admission number it makes a row's idempotency key. */
  fileHash: string;
  mode: ImportMode;
  status: ImportStatus;
  academicSessionId: string;
  locationId: string;
  headers: string[];
  mapping: Partial<Record<ImportField, string | null>>;
  rowCount: number;
  committedAt: Date | null;
}

const importSchema = new Schema<StudentImportDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    fileName: { type: String, required: true, maxlength: 120 },
    fileHash: { type: String, required: true },
    mode: { type: String, enum: IMPORT_MODES, required: true },
    status: { type: String, enum: IMPORT_STATUSES, default: 'UPLOADED', required: true },
    academicSessionId: { type: String, required: true },
    locationId: { type: String, required: true },
    headers: { type: [String], default: [] },
    mapping: { type: Schema.Types.Mixed, default: {} },
    rowCount: { type: Number, default: 0 },
    committedAt: { type: Date, default: null },
    ...auditFields,
  },
  { ...baseSchemaOptions('student_imports'), minimize: false },
);
importSchema.index({ tenantId: 1, createdAt: -1 });
importSchema.plugin(tenantScopePlugin);

export const StudentImport = model<StudentImportDoc>('StudentImport', importSchema);

export interface StudentImportRowDoc extends BaseDoc {
  tenantId: string;
  importId: string;
  rowNumber: number;
  /** The file's own cells, by header. */
  raw: Record<string, string>;
  /** Corrections made in the app, by field. They win over the file. */
  fixes: Partial<Record<ImportField, string>>;
  status: ImportRowStatus;
  issues: ImportIssueDTO[];
  studentId: string | null;
  /** File hash + row number + admission number. Set once the row has been imported, so a retry skips it. */
  idempotencyKey: string | null;
}

const importRowSchema = new Schema<StudentImportRowDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    importId: { type: String, required: true, immutable: true },
    rowNumber: { type: Number, required: true, immutable: true },
    raw: { type: Schema.Types.Mixed, default: {} },
    fixes: { type: Schema.Types.Mixed, default: {} },
    status: { type: String, enum: IMPORT_ROW_STATUSES, default: 'NEEDS_ATTENTION', required: true },
    issues: { type: Schema.Types.Mixed, default: [] },
    studentId: { type: String, default: null },
    idempotencyKey: { type: String, default: null },
  },
  { ...baseSchemaOptions('student_import_rows'), minimize: false },
);
importRowSchema.index({ tenantId: 1, importId: 1, rowNumber: 1 }, { unique: true });
importRowSchema.index({ tenantId: 1, importId: 1, status: 1 });
// A row imported once is never imported again, even by another import of the same file.
importRowSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } }, name: 'one_import_per_row_key' });
importRowSchema.plugin(tenantScopePlugin);

export const StudentImportRow = model<StudentImportRowDoc>('StudentImportRow', importRowSchema);

// ───────────────────────────────────────────────────────────── export

export interface StudentExportDoc extends BaseDoc {
  tenantId: string;
  requestedBy: string;
  purpose: StudentExportPurpose;
  fileName: string;
  objectKey: string;
  rowCount: number;
  /** After this the file is deleted and the row removed. */
  expiresAt: Date;
}

const exportSchema = new Schema<StudentExportDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    requestedBy: { type: String, required: true },
    purpose: { type: String, enum: STUDENT_EXPORT_PURPOSES, required: true },
    fileName: { type: String, required: true },
    objectKey: { type: String, required: true },
    rowCount: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
  },
  baseSchemaOptions('student_exports'),
);
exportSchema.index({ expiresAt: 1 });
exportSchema.plugin(tenantScopePlugin);

export const StudentExport = model<StudentExportDoc>('StudentExport', exportSchema);

// ───────────────────────────────────────────────────────────── counters

/** A number that only goes up (transfer certificate numbers). `findOneAndUpdate` hands each caller a different value. */
export interface StudentCounterDoc extends BaseDoc {
  tenantId: string;
  schoolId: string;
  key: string;
  seq: number;
}

const counterSchema = new Schema<StudentCounterDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    key: { type: String, required: true, immutable: true },
    seq: { type: Number, default: 0 },
  },
  baseSchemaOptions('student_counters'),
);
counterSchema.index({ tenantId: 1, schoolId: 1, key: 1 }, { unique: true });
counterSchema.plugin(tenantScopePlugin);

export const StudentCounter = model<StudentCounterDoc>('StudentCounter', counterSchema);
