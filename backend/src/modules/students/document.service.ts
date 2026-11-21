import { createHash } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import {
  FILE_LINK_SECONDS,
  MAX_DOCUMENT_BYTES,
  PARENT_VISIBLE_DOCUMENT_TYPES,
  REQUIRED_STUDENT_DOCUMENT_TYPES,
  STUDENT_DOCUMENT_TYPE_LABELS,
  type DocumentCompletenessDTO,
  type SignedFileLinkDTO,
  type StudentDocumentDTO,
  type StudentDocumentType,
  type StudentDocumentsDTO,
  type UploadStudentDocumentFields,
} from '@shared';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { withTransaction } from '../../db/transaction';
import { signFileToken } from '../../platform/identity/crypto';
import { safeFileName, scanFile, sniffDocumentType } from '../../platform/identity/file-checks';
import { privateStorage } from '../../platform/identity/private-storage';
import { recordSecurityEvent } from '../../platform/identity/security-events';
import { actorFrom, can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { FILES_PATH } from '../staff/document.service';
import { recordStudentAudit } from './audit';
import { assertStudentWritable, loadStudent } from './guards';
import { assertParentCanAccess, assertParentRole } from './parent-access';
import { StudentDocument, type StudentDocumentDoc } from './records.models';
import { StudentAdmission } from './student.models';

/**
 * SPM-13 — student documents. The file is checked before it is stored (authorization first, then the file's own bytes, then the
 * scanner), kept in private storage under a random key, and handed out only as a link that works for a minute. Nothing here
 * stores a URL.
 */

const EXTENSIONS = { 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg' } as const;

function downloadName(doc: Pick<StudentDocumentDoc, 'displayName' | 'mime'>): string {
  const name = safeFileName(doc.displayName);
  return /\.(pdf|png|jpe?g)$/i.test(name) ? name : `${name}${EXTENSIONS[doc.mime]}`;
}

export function toStudentDocumentDTO(d: StudentDocumentDoc): StudentDocumentDTO {
  return {
    documentId: d._id,
    studentId: d.studentId,
    documentType: d.documentType,
    displayName: d.displayName,
    mime: d.mime,
    sizeBytes: d.sizeBytes,
    uploadedAt: toIso(d.createdAt)!,
    issuedBySchool: Boolean(d.generatedForCertificateId),
  };
}

export interface UploadedFile {
  buffer: Buffer;
  originalname?: string;
}

/** Keys of the documents each kind of caller may see. Medical and "other" papers stay with the school. */
const parentVisible = (type: StudentDocumentType) => (PARENT_VISIBLE_DOCUMENT_TYPES as readonly StudentDocumentType[]).includes(type);

// ───────────────────────────────────────────────────────────── upload

export async function uploadDocument(ctx: ServiceContext, studentId: string, file: UploadedFile | undefined, fields: UploadStudentDocumentFields): Promise<StudentDocumentDTO> {
  if (!file || file.buffer.length === 0) throw new AppError('FILE_REQUIRED');
  if (file.buffer.length > MAX_DOCUMENT_BYTES) throw new AppError('DOCUMENT_TOO_LARGE');

  // The client's MIME type and file extension are ignored: the bytes decide.
  const mime = sniffDocumentType(file.buffer);
  const rejected = async (reason: 'TYPE' | 'SCAN') =>
    recordSecurityEvent({ tenantId: ctx.tenantId, type: 'FILE_REJECTED', actorUserId: ctx.userId, targetId: studentId, ip: ctx.ip ?? null, metadata: { reason } });
  if (!mime) {
    await rejected('TYPE');
    throw new AppError('UNSUPPORTED_DOCUMENT_TYPE');
  }
  if (!(await scanFile(file.buffer)).clean) {
    await rejected('SCAN');
    throw new AppError('FILE_REJECTED');
  }

  const objectKey = await privateStorage.put(file.buffer, { folder: 'documents' });
  try {
    const id = await withTransaction(async (db) => {
      assertStudentWritable(await loadStudent(ctx, studentId, db));
      const displayName = fields.displayName || safeFileName(file.originalname ?? '', STUDENT_DOCUMENT_TYPE_LABELS[fields.documentType]);
      const doc = await createDocumentInTx(ctx, db, { studentId, documentType: fields.documentType, objectKey, displayName, mime, buffer: file.buffer });
      return doc._id;
    });
    return toStudentDocumentDTO((await StudentDocument.findOne({ _id: id, tenantId: ctx.tenantId }).lean<StudentDocumentDoc>())!);
  } catch (err) {
    await privateStorage.remove(objectKey);
    throw err;
  }
}

/** Writes the document row and its audit event (the file is already in private storage). */
export async function createDocumentInTx(
  ctx: ServiceContext,
  db: ClientSession,
  input: { studentId: string; documentType: StudentDocumentType; objectKey: string; displayName: string; mime: StudentDocumentDoc['mime']; buffer: Buffer; generatedForCertificateId?: string | null },
): Promise<StudentDocumentDoc> {
  const [doc] = await StudentDocument.create(
    [
      {
        tenantId: ctx.tenantId,
        studentId: input.studentId,
        documentType: input.documentType,
        objectKey: input.objectKey,
        displayName: input.displayName,
        mime: input.mime,
        sizeBytes: input.buffer.length,
        sha256: createHash('sha256').update(input.buffer).digest('hex'),
        generatedForCertificateId: input.generatedForCertificateId ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ],
    { session: db },
  );
  await recordStudentAudit(ctx, db, {
    entityType: 'student_document',
    entityId: doc!._id,
    action: 'student_document.uploaded',
    studentId: input.studentId,
    metadata: { documentType: input.documentType, sizeBytes: input.buffer.length, generated: Boolean(input.generatedForCertificateId) },
  });
  return doc!.toObject() as StudentDocumentDoc;
}

// ───────────────────────────────────────────────────────────── list and completeness

/** "5 of 6 done. Missing: Previous school TC". The certificate from the old school is only expected from a student who joined from another school. */
export function documentCompleteness(joinedFromAnotherSchool: boolean, docs: Pick<StudentDocumentDoc, 'documentType' | 'generatedForCertificateId'>[]): DocumentCompletenessDTO {
  const required: StudentDocumentType[] = [...REQUIRED_STUDENT_DOCUMENT_TYPES, ...(joinedFromAnotherSchool ? (['TRANSFER_CERTIFICATE'] as const) : [])];
  // A certificate this school issued is not the old school's.
  const have = new Set(docs.filter((d) => !d.generatedForCertificateId).map((d) => d.documentType));
  const missing = required.filter((t) => !have.has(t)).map((documentType) => ({ documentType, label: documentType === 'TRANSFER_CERTIFICATE' ? 'Previous school TC' : STUDENT_DOCUMENT_TYPE_LABELS[documentType] }));
  const done = required.length - missing.length;
  const message = missing.length === 0 ? `All ${required.length} documents are in.` : `${done} of ${required.length} done. Missing: ${missing.map((m) => m.label).join(', ')}`;
  return { total: required.length, done, missing, message };
}

async function completenessOf(ctx: ServiceContext, studentId: string, docs: StudentDocumentDoc[]): Promise<DocumentCompletenessDTO> {
  const admission = await StudentAdmission.findOne({ tenantId: ctx.tenantId, studentId, isCurrent: true }).select('previousSchool').lean<{ previousSchool: { name: string } | null }>();
  return documentCompleteness(Boolean(admission?.previousSchool), docs);
}

async function activeDocuments(ctx: ServiceContext, studentId: string): Promise<StudentDocumentDoc[]> {
  return StudentDocument.find({ tenantId: ctx.tenantId, studentId, status: 'ACTIVE' }).sort({ createdAt: -1 }).lean<StudentDocumentDoc[]>();
}

export async function listDocuments(ctx: ServiceContext, studentId: string): Promise<StudentDocumentsDTO> {
  await loadStudent(ctx, studentId);
  const docs = await activeDocuments(ctx, studentId);
  return { items: docs.map(toStudentDocumentDTO), completeness: await completenessOf(ctx, studentId, docs) };
}

/** A parent sees a small set of document types for a child they may see (404 otherwise). No completeness: that is the school's checklist. */
export async function listParentDocuments(ctx: ServiceContext, studentId: string): Promise<StudentDocumentDTO[]> {
  assertParentRole(ctx);
  await assertParentCanAccess(ctx, studentId, 'ACADEMICS');
  return (await activeDocuments(ctx, studentId)).filter((d) => parentVisible(d.documentType)).map(toStudentDocumentDTO);
}

// ───────────────────────────────────────────────────────────── download and delete

/**
 * Access is re-checked on every request: an admin with `student:documents`, or a parent allowed to see that child and that kind of
 * document. Anyone else gets a 404 (not a 403), and the refusal is audited and written to the security events.
 */
export async function requestDownload(ctx: ServiceContext, documentId: string): Promise<SignedFileLinkDTO> {
  const doc = await StudentDocument.findOne({ _id: documentId, tenantId: ctx.tenantId, status: 'ACTIVE' }).lean<StudentDocumentDoc>();
  if (!doc) throw AppError.notFound('Document not found.');

  const scope = { tenantId: ctx.tenantId, entityType: 'student_document', entityId: doc._id, actor: actorFrom(ctx), requestId: ctx.requestId } as const;
  let allowed = can(ctx, 'student:documents');
  if (!allowed && ctx.role === 'PARENT' && parentVisible(doc.documentType)) {
    try {
      await assertParentCanAccess(ctx, doc.studentId, 'ACADEMICS');
      allowed = true;
    } catch {
      allowed = false; // the parent check already wrote its own security event
    }
  } else if (!allowed) {
    await recordSecurityEvent({ tenantId: ctx.tenantId, type: 'DOCUMENT_ACCESS_DENIED', actorUserId: ctx.userId, targetId: doc._id, ip: ctx.ip ?? null });
  }
  if (!allowed) {
    await recordAudit({ ...scope, action: 'student_document.download_denied', metadata: { studentId: doc.studentId } });
    throw AppError.notFound('Document not found.');
  }

  await recordAudit({ ...scope, action: 'student_document.downloaded', metadata: { studentId: doc.studentId, documentType: doc.documentType } });
  const { token, expiresAt } = signFileToken({ k: doc.objectKey, m: doc.mime, n: downloadName(doc), t: ctx.tenantId }, FILE_LINK_SECONDS);
  return { url: `${FILES_PATH}/${token}`, expiresAt: expiresAt.toISOString() };
}

/** Marks the document deleted and removes the file. The row stays, so the audit trail still has something to point at. */
export async function deleteDocument(ctx: ServiceContext, documentId: string): Promise<void> {
  const objectKey = await withTransaction(async (db) => {
    const doc = await StudentDocument.findOne({ _id: documentId, tenantId: ctx.tenantId, status: 'ACTIVE' }).session(db).lean<StudentDocumentDoc>();
    if (!doc) throw AppError.notFound('Document not found.');
    assertStudentWritable(await loadStudent(ctx, doc.studentId, db));
    // The school's own issued certificate is a record, not an upload: it is never deleted.
    if (doc.generatedForCertificateId) throw new AppError('TC_ISSUED_LOCKED');
    await StudentDocument.updateOne({ _id: doc._id, tenantId: ctx.tenantId }, { $set: { status: 'DELETED', deletedAt: new Date(), updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'student_document', entityId: doc._id, action: 'student_document.deleted', studentId: doc.studentId, metadata: { documentType: doc.documentType } });
    return doc.objectKey;
  });
  await privateStorage.remove(objectKey);
}
