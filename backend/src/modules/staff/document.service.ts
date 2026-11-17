import { createHash } from 'node:crypto';
import {
  DOCUMENT_TYPE_LABELS,
  FILE_LINK_SECONDS,
  MAX_DOCUMENT_BYTES,
  type EmployeeDocumentDTO,
  type SignedFileLinkDTO,
  type UploadDocumentFields,
} from '@shared';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { withTransaction } from '../../db/transaction';
import { signFileToken } from '../../platform/identity/crypto';
import { safeFileName, scanFile, sniffDocumentType } from '../../platform/identity/file-checks';
import { privateStorage } from '../../platform/identity/private-storage';
import { recordSecurityEvent } from '../../platform/identity/security-events';
import { actorFrom, can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { recordAudit } from '../audit/audit.service';
import { auditScopeOf, recordStaffAudit } from './audit';
import { assertWritable, loadEmployee } from './guards';
import { EmployeeDocument, type EmployeeDocumentDoc } from './identity.models';
import { requireCaller } from './self-access';

/**
 * FSM-08 — employee documents. The file is checked before it is stored (authorization first, then magic bytes, then the
 * scanner), kept in private storage under a random key, and handed out only as a link that works for a minute.
 */

export const FILES_PATH = '/api/v1/files';

const EXTENSIONS = {
  'application/pdf': '.pdf',
  'image/png': '.png',
  'image/jpeg': '.jpg',
} as const;

/** A person names a document "Signed contract"; the saved file should still open as a PDF. */
function downloadName(doc: Pick<EmployeeDocumentDoc, 'displayName' | 'mime'>): string {
  const name = safeFileName(doc.displayName);
  return /\.(pdf|png|jpe?g)$/i.test(name) ? name : `${name}${EXTENSIONS[doc.mime]}`;
}

function toDocumentDTO(d: EmployeeDocumentDoc): EmployeeDocumentDTO {
  return {
    documentId: d._id,
    employeeId: d.employeeId,
    documentType: d.documentType,
    displayName: d.displayName,
    mime: d.mime,
    sizeBytes: d.sizeBytes,
    uploadedAt: toIso(d.createdAt)!,
  };
}

export interface UploadedFile {
  buffer: Buffer;
  originalname?: string;
}

async function store(
  ctx: ServiceContext,
  employeeId: string,
  file: UploadedFile | undefined,
  fields: UploadDocumentFields,
): Promise<EmployeeDocumentDTO> {
  if (!file || file.buffer.length === 0) throw new AppError('FILE_REQUIRED');
  if (file.buffer.length > MAX_DOCUMENT_BYTES) throw new AppError('DOCUMENT_TOO_LARGE');

  // The client's MIME type and file extension are ignored: the bytes decide.
  const mime = sniffDocumentType(file.buffer);
  if (!mime) {
    await recordSecurityEvent({
      tenantId: ctx.tenantId,
      type: 'FILE_REJECTED',
      actorUserId: ctx.userId,
      targetId: employeeId,
      ip: ctx.ip ?? null,
      metadata: { reason: 'TYPE' },
    });
    throw new AppError('UNSUPPORTED_DOCUMENT_TYPE');
  }
  const scan = await scanFile(file.buffer);
  if (!scan.clean) {
    await recordSecurityEvent({
      tenantId: ctx.tenantId,
      type: 'FILE_REJECTED',
      actorUserId: ctx.userId,
      targetId: employeeId,
      ip: ctx.ip ?? null,
      metadata: { reason: 'SCAN' },
    });
    throw new AppError('FILE_REJECTED');
  }

  const objectKey = await privateStorage.put(file.buffer, { folder: 'documents' });
  try {
    const id = await withTransaction(async (db) => {
      const employee = await loadEmployee(ctx, employeeId, db);
      assertWritable(employee);
      const displayName =
        fields.displayName ||
        safeFileName(file.originalname ?? '', DOCUMENT_TYPE_LABELS[fields.documentType]);
      const [doc] = await EmployeeDocument.create(
        [
          {
            tenantId: ctx.tenantId,
            personId: employee.personId,
            employeeId,
            documentType: fields.documentType,
            objectKey,
            displayName,
            mime,
            sizeBytes: file.buffer.length,
            sha256: createHash('sha256').update(file.buffer).digest('hex'),
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      await recordStaffAudit(auditScopeOf(ctx), db, {
        entityType: 'employee_document',
        entityId: doc!._id,
        action: 'document.uploaded',
        employeeId,
        metadata: { documentType: fields.documentType, sizeBytes: file.buffer.length },
      });
      return doc!._id;
    });
    return toDocumentDTO(
      (await EmployeeDocument.findOne({
        _id: id,
        tenantId: ctx.tenantId,
      }).lean<EmployeeDocumentDoc>())!,
    );
  } catch (err) {
    await privateStorage.remove(objectKey);
    throw err;
  }
}

/** An admin with `employee:documents` uploading for an employee (the route checks the permission first). */
export function uploadDocument(
  ctx: ServiceContext,
  employeeId: string,
  file: UploadedFile | undefined,
  fields: UploadDocumentFields,
) {
  return store(ctx, employeeId, file, fields);
}

/** An employee uploading their own document. */
export async function uploadOwnDocument(
  ctx: ServiceContext,
  file: UploadedFile | undefined,
  fields: UploadDocumentFields,
) {
  const { employee } = await requireCaller(ctx);
  return store(ctx, employee._id, file, fields);
}

async function listFor(ctx: ServiceContext, employeeId: string): Promise<EmployeeDocumentDTO[]> {
  const docs = await EmployeeDocument.find({ tenantId: ctx.tenantId, employeeId, status: 'ACTIVE' })
    .sort({ createdAt: -1 })
    .lean<EmployeeDocumentDoc[]>();
  return docs.map(toDocumentDTO);
}

export async function listDocuments(ctx: ServiceContext, employeeId: string) {
  await loadEmployee(ctx, employeeId);
  return listFor(ctx, employeeId);
}

export async function listOwnDocuments(ctx: ServiceContext) {
  const { employee } = await requireCaller(ctx);
  return listFor(ctx, employee._id);
}

/**
 * Access is re-checked on every request: an admin with `employee:documents`, or the document's own employee. Anyone else
 * gets a 404 (not a 403), and the refusal is written to the audit trail and the security events.
 */
export async function requestDownload(
  ctx: ServiceContext,
  documentId: string,
): Promise<SignedFileLinkDTO> {
  const doc = await EmployeeDocument.findOne({
    _id: documentId,
    tenantId: ctx.tenantId,
    status: 'ACTIVE',
  }).lean<EmployeeDocumentDoc>();
  if (!doc) throw AppError.notFound('Document not found.');

  let allowed = can(ctx, 'employee:documents');
  if (!allowed) {
    const user = await User.findOne({ _id: ctx.userId, tenantId: ctx.tenantId })
      .select('personId')
      .lean<{ personId?: string | null }>();
    allowed = Boolean(user?.personId) && user!.personId === doc.personId;
  }
  const scope = {
    tenantId: ctx.tenantId,
    entityType: 'employee_document',
    entityId: doc._id,
    actor: actorFrom(ctx),
    requestId: ctx.requestId,
  } as const;
  if (!allowed) {
    await recordAudit({
      ...scope,
      action: 'document.download_denied',
      metadata: { employeeId: doc.employeeId },
    });
    await recordSecurityEvent({
      tenantId: ctx.tenantId,
      type: 'DOCUMENT_ACCESS_DENIED',
      actorUserId: ctx.userId,
      targetId: doc._id,
      ip: ctx.ip ?? null,
    });
    throw AppError.notFound('Document not found.');
  }

  await recordAudit({
    ...scope,
    action: 'document.downloaded',
    metadata: { employeeId: doc.employeeId, documentType: doc.documentType },
  });
  const { token, expiresAt } = signFileToken(
    { k: doc.objectKey, m: doc.mime, n: downloadName(doc), t: ctx.tenantId },
    FILE_LINK_SECONDS,
  );
  return { url: `${FILES_PATH}/${token}`, expiresAt: expiresAt.toISOString() };
}

/** Marks the document deleted and removes the file. The row stays, so the audit trail still has something to point at. */
export async function deleteDocument(ctx: ServiceContext, documentId: string): Promise<void> {
  const objectKey = await withTransaction(async (db) => {
    const doc = await EmployeeDocument.findOne({
      _id: documentId,
      tenantId: ctx.tenantId,
      status: 'ACTIVE',
    })
      .session(db)
      .lean<EmployeeDocumentDoc>();
    if (!doc) throw AppError.notFound('Document not found.');
    assertWritable(await loadEmployee(ctx, doc.employeeId, db));
    await EmployeeDocument.updateOne(
      { _id: doc._id, tenantId: ctx.tenantId },
      { $set: { status: 'DELETED', deletedAt: new Date(), updatedBy: ctx.userId } },
      { session: db },
    );
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'employee_document',
      entityId: doc._id,
      action: 'document.deleted',
      employeeId: doc.employeeId,
      metadata: { documentType: doc.documentType },
    });
    return doc.objectKey;
  });
  await privateStorage.remove(objectKey);
}
