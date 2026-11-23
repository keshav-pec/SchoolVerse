import { randomUUID } from 'node:crypto';
import { WITHDRAWAL_REASON_LABELS, type RequestTransferCertificateData, type TransferCertificateDTO, type UpdateTransferCertificateData } from '@shared';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { privateStorage } from '../../platform/identity/private-storage';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering } from '../academic/offering.model';
import { AcademicSession } from '../academic/session.model';
import { todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { fullNameOf } from './directory';
import { createDocumentInTx } from './document.service';
import { loadPerson, loadStudent, requireSchool } from './guards';
import { formatTcNumber } from './rules';
import { StudentCounter, StudentTransferCertificate, type StudentTransferCertificateDoc } from './records.models';
import { StudentAdmission, StudentEnrollment, type StudentEnrollmentDoc } from './student.models';

/**
 * SPM-30 — the Transfer Certificate. Requested → (waiting for dues) → Approved → Issued. Every step is audited and needs
 * `student:lifecycle`. An issued certificate is locked: nothing can edit it (`TC_ISSUED_LOCKED`), a lost copy is a new, marked
 * duplicate with a reason. Certificate numbers come from a counter and are never reused.
 */

const EDITABLE = ['REQUESTED', 'UNDER_REVIEW', 'PENDING_CLEARANCE'] as const;
const LOCKED = ['ISSUED', 'DUPLICATE_ISSUED'] as const;
const has = (list: readonly string[], status: string) => list.includes(status);

function toDTO(c: StudentTransferCertificateDoc): TransferCertificateDTO {
  return {
    certificateId: c._id,
    studentId: c.studentId,
    certificateNumber: c.certificateNumber ?? null,
    status: c.status,
    copyType: c.copyType,
    applicationDate: c.applicationDate,
    issueDate: c.issueDate ?? null,
    leavingDate: c.leavingDate,
    reasonForLeaving: c.reasonForLeaving,
    lastClass: c.lastClass,
    result: c.result ?? null,
    duesStatus: c.duesStatus,
    documentId: c.documentId ?? null,
    originalCertificateId: c.originalCertificateId ?? null,
    duplicateReason: c.duplicateReason ?? null,
    locked: has(LOCKED, c.status),
    createdAt: toIso(c.createdAt)!,
  };
}

async function loadCertificate(ctx: ServiceContext, id: string, db?: Parameters<Parameters<typeof withTransaction>[0]>[0]): Promise<StudentTransferCertificateDoc> {
  const doc = await StudentTransferCertificate.findOne({ _id: id, tenantId: ctx.tenantId }).session(db ?? null).lean<StudentTransferCertificateDoc>();
  if (!doc) throw AppError.notFound('Transfer certificate not found.');
  return doc;
}

/** The next certificate number. Each caller gets a different value, even at the same moment. */
async function nextNumber(ctx: ServiceContext, schoolId: string, sessionCode: string, db: Parameters<Parameters<typeof withTransaction>[0]>[0]): Promise<string> {
  const counter = await StudentCounter.findOneAndUpdate({ tenantId: ctx.tenantId, schoolId, key: 'TC' }, { $inc: { seq: 1 }, $setOnInsert: { _id: randomUUID() } }, { upsert: true, returnDocument: 'after', session: db }).lean<{ seq: number }>();
  return formatTcNumber(sessionCode, counter!.seq);
}

// ───────────────────────────────────────────────────────────── read

export async function listCertificates(ctx: ServiceContext, studentId: string): Promise<TransferCertificateDTO[]> {
  await loadStudent(ctx, studentId);
  const rows = await StudentTransferCertificate.find({ tenantId: ctx.tenantId, studentId }).sort({ createdAt: -1 }).lean<StudentTransferCertificateDoc[]>();
  return rows.map(toDTO);
}

// ───────────────────────────────────────────────────────────── request, change, approve

export async function requestCertificate(ctx: ServiceContext, studentId: string, data: RequestTransferCertificateData): Promise<TransferCertificateDTO> {
  const school = await requireSchool(ctx);
  try {
    const id = await withTransaction(async (db) => {
      const student = await loadStudent(ctx, studentId, db);
      if (['DRAFT', 'ADMISSION_PENDING'].includes(student.status)) throw AppError.validation({ studentId: 'This student has not joined yet, so there is nothing to transfer.' });
      if (await StudentTransferCertificate.exists({ tenantId: ctx.tenantId, studentId, copyType: 'ORIGINAL', status: { $in: [...LOCKED] } }).session(db)) {
        throw new AppError('TC_ALREADY_OPEN', 'A transfer certificate has already been issued for this student. Issue a duplicate instead.');
      }
      const today = await todayFor(ctx, db);
      const last = await StudentEnrollment.findOne({ tenantId: ctx.tenantId, studentId, state: { $ne: 'CANCELLED' } }).session(db).sort({ effectiveFrom: -1 }).lean<StudentEnrollmentDoc>();
      const klass = last ? await ClassOffering.findOne({ _id: last.classOfferingId, tenantId: ctx.tenantId }).session(db).select('displayName').lean<{ displayName: string }>() : null;
      const w = student.withdrawal;
      const [row] = await StudentTransferCertificate.create(
        [
          {
            tenantId: ctx.tenantId,
            schoolId: school._id,
            studentId,
            enrollmentId: last?._id ?? null,
            applicationDate: data.applicationDate ?? today,
            leavingDate: data.leavingDate ?? w?.leavingDate ?? today,
            reasonForLeaving: data.reasonForLeaving ?? (w ? WITHDRAWAL_REASON_LABELS[w.reasonCategory] : 'Not stated'),
            lastClass: klass?.displayName ?? 'Not enrolled',
            result: data.result ?? null,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      await recordStudentAudit(ctx, db, { entityType: 'transfer_certificate', entityId: row!._id, action: 'transfer_certificate.requested', changes: [{ field: 'status', from: null, to: 'REQUESTED' }], studentId });
      return row!._id;
    });
    return toDTO(await loadCertificate(ctx, id));
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('studentId')) throw new AppError('TC_ALREADY_OPEN');
    throw err;
  }
}

export async function updateCertificate(ctx: ServiceContext, certificateId: string, data: UpdateTransferCertificateData): Promise<TransferCertificateDTO> {
  await withTransaction(async (db) => {
    const before = await loadCertificate(ctx, certificateId, db);
    if (has(LOCKED, before.status)) throw new AppError('TC_ISSUED_LOCKED');
    if (!has(EDITABLE, before.status)) throw new AppError('TC_NOT_READY', 'This certificate can only be changed before it is approved.');
    const { duesOverrideReason, ...rest } = data;
    const patch = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length === 0) return;
    // Finance is asked, not copied (Module 7). Marking dues cleared while money is owed or waiting needs a written reason.
    let overridden: string | null = null;
    if (patch.duesStatus === 'CLEARED' && before.duesStatus !== 'CLEARED') {
      const { financeService } = await import('../finance/financeService');
      const clearance = await financeService.getStudentClearance(ctx, before.studentId);
      if (clearance.status !== 'CLEAR') {
        if (!duesOverrideReason) throw new AppError('DUES_NOT_CLEAR', undefined, { status: clearance.status, outstandingPaise: clearance.outstandingPaise, pendingClaims: clearance.pendingClaims });
        overridden = duesOverrideReason;
      }
    }
    await StudentTransferCertificate.updateOne({ _id: certificateId, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, {
      entityType: 'transfer_certificate',
      entityId: certificateId,
      action: 'transfer_certificate.updated',
      changes: [
        ...Object.keys(patch).map((field) => ({ field, from: field === 'duesStatus' ? (before as unknown as Record<string, unknown>)[field] : '[redacted]', to: field === 'duesStatus' ? (patch as Record<string, unknown>)[field] : '[redacted]' })),
        ...(overridden ? [{ field: 'duesOverrideReason', from: null, to: overridden }] : []),
      ],
      studentId: before.studentId,
    });
  });
  return toDTO(await loadCertificate(ctx, certificateId));
}

/** Approving with dues still pending parks the certificate as "waiting for dues". Approving again once dues are cleared approves it. */
export async function approveCertificate(ctx: ServiceContext, certificateId: string): Promise<TransferCertificateDTO> {
  await withTransaction(async (db) => {
    const before = await loadCertificate(ctx, certificateId, db);
    if (has(LOCKED, before.status)) throw new AppError('TC_ISSUED_LOCKED');
    if (before.status === 'APPROVED') return;
    if (!has(EDITABLE, before.status)) throw new AppError('TC_NOT_READY');
    // A student whose fees are fully settled in Finance is cleared automatically. Money owed, or a payment still being checked, keeps it waiting.
    let duesStatus = before.duesStatus;
    if (duesStatus !== 'CLEARED') {
      const { financeService } = await import('../finance/financeService');
      const clearance = await financeService.getStudentClearance(ctx, before.studentId);
      if (clearance.status === 'CLEAR' && (clearance.billedPaise > 0 || clearance.paidPaise > 0)) duesStatus = 'CLEARED';
    }
    const to = duesStatus === 'CLEARED' ? 'APPROVED' : 'PENDING_CLEARANCE';
    if (to === before.status && duesStatus === before.duesStatus) return;
    await StudentTransferCertificate.updateOne({ _id: certificateId, tenantId: ctx.tenantId }, { $set: { status: to, duesStatus, updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'transfer_certificate', entityId: certificateId, action: to === 'APPROVED' ? 'transfer_certificate.approved' : 'transfer_certificate.pending_clearance', changes: [{ field: 'status', from: before.status, to }], studentId: before.studentId });
  });
  return toDTO(await loadCertificate(ctx, certificateId));
}

export async function cancelCertificate(ctx: ServiceContext, certificateId: string): Promise<TransferCertificateDTO> {
  await withTransaction(async (db) => {
    const before = await loadCertificate(ctx, certificateId, db);
    if (has(LOCKED, before.status)) throw new AppError('TC_ISSUED_LOCKED');
    if (before.status === 'CANCELLED') throw new AppError('TC_NOT_READY', 'This certificate is already cancelled.');
    await StudentTransferCertificate.updateOne({ _id: certificateId, tenantId: ctx.tenantId }, { $set: { status: 'CANCELLED', updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'transfer_certificate', entityId: certificateId, action: 'transfer_certificate.cancelled', changes: [{ field: 'status', from: before.status, to: 'CANCELLED' }], studentId: before.studentId });
  });
  return toDTO(await loadCertificate(ctx, certificateId));
}

// ───────────────────────────────────────────────────────────── issue and duplicate

/** A small, valid, one-page PDF: the certificate text in a standard font. Layout work (letterhead, signature) is for later. */
export function simplePdf(lines: string[]): Buffer {
  const clean = (s: string) => s.replace(/[^\x20-\x7e]/g, '?').replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = ['BT', '/F1 12 Tf', '50 790 Td', '18 TL', ...lines.map((l, i) => `${i === 0 ? '' : 'T* '}(${clean(l)}) Tj`), 'ET'].join('\n');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

async function certificateLines(ctx: ServiceContext, cert: StudentTransferCertificateDoc, number: string, copy: 'ORIGINAL' | 'DUPLICATE', issueDate: string, db: Parameters<Parameters<typeof withTransaction>[0]>[0]): Promise<string[]> {
  const [school, student] = await Promise.all([requireSchool(ctx), loadStudent(ctx, cert.studentId, db)]);
  const person = await loadPerson(ctx, student.personId, db);
  const admission = await StudentAdmission.findOne({ tenantId: ctx.tenantId, studentId: cert.studentId, isCurrent: true }).session(db).select('admissionNumber admissionDate').lean<{ admissionNumber: string; admissionDate: string }>();
  return [
    school.displayName,
    '',
    copy === 'DUPLICATE' ? 'TRANSFER CERTIFICATE (DUPLICATE COPY)' : 'TRANSFER CERTIFICATE',
    '',
    `Certificate number: ${number}`,
    `Date of issue: ${issueDate}`,
    '',
    `Name of student: ${fullNameOf(person)}`,
    `Admission number: ${admission?.admissionNumber ?? '-'}`,
    `Date of admission: ${admission?.admissionDate ?? '-'}`,
    `Date of birth: ${person.dateOfBirth ?? '-'}`,
    `Last class studied: ${cert.lastClass}`,
    `Result: ${cert.result ?? '-'}`,
    `Date of leaving: ${cert.leavingDate}`,
    `Reason for leaving: ${cert.reasonForLeaving}`,
    `Dues: ${cert.duesStatus === 'CLEARED' ? 'Cleared' : 'Pending'}`,
  ];
}

/** Stores a freshly made certificate PDF and its document row, inside the caller's transaction. */
async function storePdf(ctx: ServiceContext, db: Parameters<Parameters<typeof withTransaction>[0]>[0], cert: StudentTransferCertificateDoc, number: string, copy: 'ORIGINAL' | 'DUPLICATE', issueDate: string, keys: string[]) {
  const buffer = simplePdf(await certificateLines(ctx, cert, number, copy, issueDate, db));
  const objectKey = await privateStorage.put(buffer, { folder: 'documents' });
  keys.push(objectKey);
  return createDocumentInTx(ctx, db, { studentId: cert.studentId, documentType: 'TRANSFER_CERTIFICATE', objectKey, displayName: `Transfer Certificate ${number}`, mime: 'application/pdf', buffer, generatedForCertificateId: cert._id });
}

/** Runs a transaction that writes a private file, and removes any file left behind if it fails (the driver may run the function more than once). */
async function withStoredFile<T>(fn: (db: Parameters<Parameters<typeof withTransaction>[0]>[0], keys: string[]) => Promise<T>): Promise<T> {
  const keys: string[] = [];
  try {
    return await withTransaction(async (db) => {
      while (keys.length > 0) await privateStorage.remove(keys.pop()!);
      return fn(db, keys);
    });
  } catch (err) {
    while (keys.length > 0) await privateStorage.remove(keys.pop()!);
    throw err;
  }
}

export async function issueCertificate(ctx: ServiceContext, certificateId: string, data: { issueDate?: string | null | undefined }): Promise<TransferCertificateDTO> {
  const school = await requireSchool(ctx);
  await withStoredFile(async (db, keys) => {
    const before = await loadCertificate(ctx, certificateId, db);
    if (has(LOCKED, before.status)) throw new AppError('TC_ISSUED_LOCKED');
    if (before.status !== 'APPROVED') throw new AppError('TC_NOT_READY', 'Approve the certificate (with dues cleared) before issuing it.');
    const today = await todayFor(ctx, db);
    const issueDate = data.issueDate ?? today;
    const last = before.enrollmentId ? await StudentEnrollment.findOne({ _id: before.enrollmentId, tenantId: ctx.tenantId }).session(db).lean<StudentEnrollmentDoc>() : null;
    const session = last ? await AcademicSession.findOne({ _id: last.academicSessionId, tenantId: ctx.tenantId }).session(db).select('code').lean<{ code: string }>() : null;
    const number = await nextNumber(ctx, school._id, session?.code ?? issueDate.slice(0, 4), db);
    const doc = await storePdf(ctx, db, before, number, 'ORIGINAL', issueDate, keys);
    await StudentTransferCertificate.updateOne({ _id: certificateId, tenantId: ctx.tenantId }, { $set: { status: 'ISSUED', certificateNumber: number, issueDate, issuedBy: ctx.userId, documentId: doc._id, updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'transfer_certificate', entityId: certificateId, action: 'transfer_certificate.issued', changes: [{ field: 'status', from: before.status, to: 'ISSUED' }, { field: 'certificateNumber', from: null, to: number }], studentId: before.studentId });
  });
  return toDTO(await loadCertificate(ctx, certificateId));
}

/** A lost or damaged copy: a new row marked as a duplicate, with a new number and a reason. The original stays as it was. */
export async function issueDuplicate(ctx: ServiceContext, certificateId: string, data: { reason: string }): Promise<TransferCertificateDTO> {
  const school = await requireSchool(ctx);
  const newId = randomUUID();
  await withStoredFile(async (db, keys) => {
    const original = await loadCertificate(ctx, certificateId, db);
    if (!has(LOCKED, original.status)) throw new AppError('TC_NOT_READY', 'Only an issued certificate can have a duplicate.');
    const root = original.originalCertificateId ?? original._id;
    const today = await todayFor(ctx, db);
    const last = original.enrollmentId ? await StudentEnrollment.findOne({ _id: original.enrollmentId, tenantId: ctx.tenantId }).session(db).lean<StudentEnrollmentDoc>() : null;
    const session = last ? await AcademicSession.findOne({ _id: last.academicSessionId, tenantId: ctx.tenantId }).session(db).select('code').lean<{ code: string }>() : null;
    const number = await nextNumber(ctx, school._id, session?.code ?? today.slice(0, 4), db);
    const copy = { ...original, _id: newId } as StudentTransferCertificateDoc;
    const doc = await storePdf(ctx, db, copy, number, 'DUPLICATE', today, keys);
    await StudentTransferCertificate.create(
      [
        {
          _id: newId,
          tenantId: ctx.tenantId,
          schoolId: school._id,
          studentId: original.studentId,
          enrollmentId: original.enrollmentId,
          certificateNumber: number,
          applicationDate: today,
          issueDate: today,
          leavingDate: original.leavingDate,
          reasonForLeaving: original.reasonForLeaving,
          lastClass: original.lastClass,
          result: original.result,
          duesStatus: original.duesStatus,
          issuedBy: ctx.userId,
          copyType: 'DUPLICATE',
          documentId: doc._id,
          originalCertificateId: root,
          duplicateReason: data.reason,
          status: 'DUPLICATE_ISSUED',
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    await recordStudentAudit(ctx, db, { entityType: 'transfer_certificate', entityId: newId, action: 'transfer_certificate.duplicate_issued', changes: [{ field: 'certificateNumber', from: null, to: number }], studentId: original.studentId, metadata: { originalCertificateId: root } });
  });
  return toDTO(await loadCertificate(ctx, newId));
}

