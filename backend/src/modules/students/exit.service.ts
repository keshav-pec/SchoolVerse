import {
  AUTO_ROLL,
  type GuardianLinkDTO,
  type ReadmissionResultDTO,
  type ReadmitStudentData,
  type StartWithdrawalData,
  type UpdateWithdrawalData,
  type WithdrawalChecklistItemDTO,
  type WithdrawalDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { latest, todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { assignSectionInTx, createEnrollmentInTx, resolveClassOffering } from './enrollment.service';
import { listGuardians } from './guardian.service';
import { loadStudent, requireSchool } from './guards';
import { assertStudentTransition } from './lifecycle';
import { carrySubjectsInTx, closeEnrollmentInTx, endPortalAccessInTx } from './rollover';
import { StudentTransferCertificate, type StudentTransferCertificateDoc } from './records.models';
import { getEffectiveSettings, mapAdmissionDuplicate, resolveAdmissionNumber } from './settings.service';
import { profileOf } from './student.service';
import { Student, StudentAdmission, StudentEnrollment, StudentGuardianLink, type StudentDoc, type StudentEnrollmentDoc } from './student.models';

/**
 * SPM-29 to SPM-32 — a student leaves, and may come back. Leaving is a workflow, never a delete: the open enrollment and section
 * close on the leaving date, subjects end, parents' access to this child ends, and every row stays for history. A leaving date in
 * the future keeps the student active until then; `processDueWithdrawals` (see `jobs.ts`) finishes it on the day.
 */

const OPEN_CERTIFICATE = ['REQUESTED', 'UNDER_REVIEW', 'PENDING_CLEARANCE', 'APPROVED'] as const;

async function checklistFor(ctx: ServiceContext, student: StudentDoc, today: string): Promise<WithdrawalChecklistItemDTO[]> {
  const w = student.withdrawal!;
  const items: WithdrawalChecklistItemDTO[] = [
    { key: 'LEAVING_DATE', label: 'Leaving date', done: w.leavingDate <= today, detail: w.leavingDate <= today ? 'The leaving date has come.' : `Leaving on ${w.leavingDate}. The student stays active until then.` },
  ];
  if (w.needsTC) {
    const certificates = await StudentTransferCertificate.find({ tenantId: ctx.tenantId, studentId: student._id, status: { $ne: 'CANCELLED' } }).lean<StudentTransferCertificateDoc[]>();
    const issued = certificates.find((c) => c.status === 'ISSUED' || c.status === 'DUPLICATE_ISSUED');
    const open = certificates.find((c) => (OPEN_CERTIFICATE as readonly string[]).includes(c.status));
    items.push({ key: 'TC', label: 'Transfer certificate', done: Boolean(issued), detail: issued ? `Issued (${issued.certificateNumber}).` : open ? 'In progress. It has not been issued yet.' : 'Not requested yet.' });
    items.push({ key: 'DUES', label: 'Dues cleared', done: Boolean(issued) || open?.duesStatus === 'CLEARED', detail: open?.duesStatus === 'PENDING' ? 'Dues are still pending.' : open ? null : 'Dues are checked when the certificate is requested.' });
  }
  const live = await StudentGuardianLink.countDocuments({ tenantId: ctx.tenantId, studentId: student._id, portalEnabled: true });
  items.push({ key: 'PORTAL', label: 'Parent access', done: live === 0, detail: live === 0 ? 'No parent has portal access.' : `${live} parent${live === 1 ? ' has' : 's have'} portal access. It ends when the student leaves.` });
  return items;
}

async function toDTO(ctx: ServiceContext, studentId: string): Promise<WithdrawalDTO> {
  const student = await loadStudent(ctx, studentId);
  if (!student.withdrawal) throw new AppError('WITHDRAWAL_NOT_STARTED');
  const today = await todayFor(ctx);
  const w = student.withdrawal;
  return {
    studentId,
    status: student.status,
    leavingDate: w.leavingDate,
    reasonCategory: w.reasonCategory,
    destinationSchool: w.destinationSchool ?? null,
    note: w.note ?? null,
    needsTC: w.needsTC,
    due: w.leavingDate <= today,
    checklist: await checklistFor(ctx, student, today),
  };
}

export async function getWithdrawal(ctx: ServiceContext, studentId: string): Promise<WithdrawalDTO> {
  return toDTO(ctx, studentId);
}

// ───────────────────────────────────────────────────────────── start, change, cancel

export async function startWithdrawal(ctx: ServiceContext, studentId: string, data: StartWithdrawalData): Promise<WithdrawalDTO> {
  await withTransaction(async (db) => {
    const student = await loadStudent(ctx, studentId, db);
    if (student.status === 'WITHDRAWAL_INITIATED') throw new AppError('WITHDRAWAL_ALREADY_STARTED');
    const to = assertStudentTransition(student.status, 'start_withdrawal');
    const enrollment = await StudentEnrollment.findOne({ tenantId: ctx.tenantId, studentId, state: 'OPEN' }).session(db).sort({ effectiveFrom: -1 }).lean<StudentEnrollmentDoc>();
    if (enrollment && data.leavingDate < enrollment.effectiveFrom) throw AppError.validation({ leavingDate: `The leaving date cannot be before the student joined this class (${enrollment.effectiveFrom}).` });
    const withdrawal = { leavingDate: data.leavingDate, reasonCategory: data.reasonCategory, destinationSchool: data.destinationSchool ?? null, note: data.note ?? null, needsTC: data.needsTC, startedAt: new Date(), startedBy: ctx.userId };
    await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId }, { $set: { status: to, withdrawal, statusChangedAt: new Date(), statusChangedBy: ctx.userId, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
    await recordStudentAudit(ctx, db, {
      entityType: 'student',
      entityId: studentId,
      action: 'student.withdrawal_started',
      changes: [{ field: 'status', from: student.status, to }],
      studentId,
      metadata: { leavingDate: data.leavingDate, reasonCategory: data.reasonCategory, needsTC: data.needsTC },
    });
  });
  return toDTO(ctx, studentId);
}

export async function updateWithdrawal(ctx: ServiceContext, studentId: string, data: UpdateWithdrawalData): Promise<WithdrawalDTO> {
  await withTransaction(async (db) => {
    const student = await loadStudent(ctx, studentId, db);
    if (student.status !== 'WITHDRAWAL_INITIATED' || !student.withdrawal) throw new AppError('WITHDRAWAL_NOT_STARTED');
    const merged = { ...student.withdrawal, ...Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) };
    await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId }, { $set: { withdrawal: merged, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'student', entityId: studentId, action: 'student.withdrawal_updated', changes: Object.keys(data).map((field) => ({ field, from: '[redacted]', to: '[redacted]' })), studentId });
  });
  return toDTO(ctx, studentId);
}

export async function cancelWithdrawal(ctx: ServiceContext, studentId: string): Promise<{ studentId: string; status: StudentDoc['status'] }> {
  await withTransaction(async (db) => {
    const student = await loadStudent(ctx, studentId, db);
    if (student.status !== 'WITHDRAWAL_INITIATED') throw new AppError('WITHDRAWAL_NOT_STARTED');
    const to = assertStudentTransition(student.status, 'cancel_withdrawal');
    await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId }, { $set: { status: to, withdrawal: null, statusChangedAt: new Date(), statusChangedBy: ctx.userId, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
    // A certificate that was never issued has no purpose any more.
    const open = await StudentTransferCertificate.find({ tenantId: ctx.tenantId, studentId, status: { $in: [...OPEN_CERTIFICATE] } }).session(db).lean<StudentTransferCertificateDoc[]>();
    for (const c of open) {
      await StudentTransferCertificate.updateOne({ _id: c._id, tenantId: ctx.tenantId }, { $set: { status: 'CANCELLED', updatedBy: ctx.userId } }, { session: db });
      await recordStudentAudit(ctx, db, { entityType: 'transfer_certificate', entityId: c._id, action: 'transfer_certificate.cancelled', studentId, metadata: { reason: 'WITHDRAWAL_CANCELLED' } });
    }
    await recordStudentAudit(ctx, db, { entityType: 'student', entityId: studentId, action: 'student.withdrawal_cancelled', changes: [{ field: 'status', from: student.status, to }], studentId });
  });
  return { studentId, status: (await loadStudent(ctx, studentId)).status };
}

// ───────────────────────────────────────────────────────────── complete

/**
 * The student has left: the open enrollment closes on the leaving date (`WITHDRAWN`, or `TRANSFERRED` when they go to another school),
 * section and subjects end with it, the student becomes `WITHDRAWN` / `TRANSFERRED_OUT`, and parents lose access to this child.
 */
export async function completeWithdrawalInTx(ctx: ServiceContext, db: Parameters<Parameters<typeof withTransaction>[0]>[0], student: StudentDoc, today: string, options: { scheduled?: boolean } = {}) {
  const w = student.withdrawal;
  if (student.status !== 'WITHDRAWAL_INITIATED' || !w) throw new AppError('WITHDRAWAL_NOT_STARTED');
  if (w.leavingDate > today) throw new AppError('WITHDRAWAL_NOT_DUE', undefined, { leavingDate: w.leavingDate });
  const transferred = Boolean(w.destinationSchool) || w.reasonCategory === 'TRANSFER_TO_OTHER_SCHOOL';
  assertStudentTransition(student.status, 'complete_withdrawal');
  const status = transferred ? 'TRANSFERRED_OUT' : 'WITHDRAWN';

  const open = await StudentEnrollment.find({ tenantId: ctx.tenantId, studentId: student._id, state: 'OPEN' }).session(db).lean<StudentEnrollmentDoc[]>();
  for (const enrollment of open) {
    // A student who left before their enrollment began (a planned one) leaves with no days in it.
    await closeEnrollmentInTx(ctx, db, enrollment, { lastDay: latest(w.leavingDate, enrollment.effectiveFrom), state: transferred ? 'TRANSFERRED' : 'WITHDRAWN', reason: 'WITHDRAWAL' });
  }
  const accessEnded = await endPortalAccessInTx(ctx, db, student._id, 'WITHDRAWAL');
  await Student.updateOne({ _id: student._id, tenantId: ctx.tenantId }, { $set: { status, statusChangedAt: new Date(), statusChangedBy: ctx.userId, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
  await recordStudentAudit(ctx, db, {
    entityType: 'student',
    entityId: student._id,
    action: 'student.withdrawal_completed',
    changes: [{ field: 'status', from: student.status, to: status }],
    studentId: student._id,
    metadata: { leavingDate: w.leavingDate, reasonCategory: w.reasonCategory, scheduled: Boolean(options.scheduled), parentAccessEnded: accessEnded },
  });
  return status;
}

export async function completeWithdrawal(ctx: ServiceContext, studentId: string): Promise<WithdrawalDTO> {
  await withTransaction(async (db) => {
    const student = await loadStudent(ctx, studentId, db);
    await completeWithdrawalInTx(ctx, db, student, await todayFor(ctx, db));
  });
  return toDTO(ctx, studentId);
}

// ───────────────────────────────────────────────────────────── readmission

/**
 * Brings a former student back as the same student and person. The admission number follows the school's readmission policy
 * (keep the old one, or issue a new one); the old admission row is kept and retired. Parents are not copied silently: the links from
 * before are returned for the admin to confirm or end, and portal access stays off until they are invited again.
 */
export async function readmitStudent(ctx: ServiceContext, studentId: string, data: ReadmitStudentData): Promise<ReadmissionResultDTO> {
  const school = await requireSchool(ctx);
  let used: { number: string; policy: 'KEEP_OLD' | 'ISSUE_NEW' };
  try {
    used = await withTransaction(async (db) => {
      const student = await loadStudent(ctx, studentId, db);
      const today = await todayFor(ctx, db);
      if (!['WITHDRAWN', 'TRANSFERRED_OUT', 'COMPLETED_SCHOOLING'].includes(student.status)) throw new AppError('STUDENT_NOT_EXITED');
      const status = assertStudentTransition(student.status, 'readmit');
      const session = await AcademicSession.findOne({ _id: data.academicSessionId, tenantId: ctx.tenantId }).session(db).lean<AcademicSessionDoc>();
      if (!session) throw AppError.notFound('Academic session not found.');
      const offering = await resolveClassOffering(ctx, { academicSessionId: session._id, locationId: data.locationId, classOfferingId: data.classOfferingId }, db);
      const settings = await getEffectiveSettings(ctx, school, db);
      const policy = data.admissionNumberPolicy ?? settings.readmissionPolicy;

      const previous = await StudentAdmission.findOne({ tenantId: ctx.tenantId, studentId, isCurrent: true }).session(db).lean<{ _id: string; admissionNumber: string }>();
      if (!previous) throw AppError.notFound('This student has no admission record.');
      const admissionDate = data.admissionDate ?? today;
      const admissionNumber = policy === 'KEEP_OLD' ? previous.admissionNumber : await resolveAdmissionNumber(ctx, school, { mode: 'READMISSION', admissionNumber: data.admissionNumber, academicSessionId: session._id, locationId: data.locationId, today }, db);

      // One admission is current at a time: the old one is retired first, then the new one starts.
      await StudentAdmission.updateOne({ _id: previous._id, tenantId: ctx.tenantId }, { $set: { isCurrent: false, updatedBy: ctx.userId } }, { session: db });
      const [admission] = await StudentAdmission.create(
        [{ tenantId: ctx.tenantId, schoolId: school._id, studentId, admissionNumber, admissionDate, mode: 'READMISSION', admissionSessionId: session._id, admissionLocationId: data.locationId, admissionClassOfferingId: offering._id, isCurrent: true, createdBy: ctx.userId, updatedBy: ctx.userId }],
        { session: db },
      );
      await recordStudentAudit(ctx, db, { entityType: 'admission', entityId: admission!._id, action: 'admission.created', changes: [{ field: 'admissionNumber', from: previous.admissionNumber, to: admissionNumber }, { field: 'mode', from: null, to: 'READMISSION' }], studentId, metadata: { mode: 'READMISSION', policy } });

      const lastEnrollment = await StudentEnrollment.findOne({ tenantId: ctx.tenantId, studentId, state: { $ne: 'CANCELLED' } }).session(db).sort({ effectiveFrom: -1 }).lean<StudentEnrollmentDoc>();
      const effectiveFrom = latest(admissionDate, session.startDate);
      const enrollment = await createEnrollmentInTx(ctx, db, { studentId, schoolId: school._id, session, offering, enrollmentType: 'READMISSION', effectiveFrom, previousEnrollmentId: lastEnrollment?._id ?? null });
      if (data.sectionId) await assignSectionInTx(ctx, db, enrollment, { sectionId: data.sectionId, rollNumber: AUTO_ROLL, effectiveFrom }, settings);
      await carrySubjectsInTx(ctx, db, { toEnrollment: enrollment, previousOfferingIds: [], copy: false });

      await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId }, { $set: { status, withdrawal: null, statusChangedAt: new Date(), statusChangedBy: ctx.userId, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
      await recordStudentAudit(ctx, db, { entityType: 'student', entityId: studentId, action: 'student.readmitted', changes: [{ field: 'status', from: student.status, to: status }], studentId, metadata: { policy, enrollmentId: enrollment._id } });
      return { number: admissionNumber, policy };
    });
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('academicSessionId')) throw new AppError('ENROLLMENT_ALREADY_OPEN');
    mapAdmissionDuplicate(err);
  }

  const links: GuardianLinkDTO[] = (await listGuardians(ctx, studentId)).filter((l) => l.status === 'ACTIVE');
  return { student: await profileOf(ctx, await loadStudent(ctx, studentId)), admissionNumber: used.number, admissionNumberPolicy: used.policy, guardiansToConfirm: links };
}

