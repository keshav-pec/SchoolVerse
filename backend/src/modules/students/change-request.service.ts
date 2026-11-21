import {
  STUDENT_CHANGE_FIELD_LABELS,
  type CreateStudentChangeRequestData,
  type ListStudentChangeRequestsQuery,
  type StudentChangeField,
  type StudentChangeRequestDTO,
  type StudentChangeRequestListDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { classifiedDiff } from '../staff/audit';
import { Person, type PersonDoc } from '../staff/person.model';
import { recordStudentAudit } from './audit';
import { fullNameOf } from './directory';
import { assertStudentWritable, loadPerson, loadStudent } from './guards';
import { maskEmail, maskPhone } from './mask';
import { assertParentCanAccess, assertParentRole } from './parent-access';
import { StudentChangeRequest, type StudentChangeRequestDoc } from './records.models';
import { Student, type StudentDoc } from './student.models';

/**
 * SPM-23 — a parent cannot edit their child's record. They ask, the school decides. A request names the detail and the new
 * value; the old value is read by the server. Admins see masked values, and approving applies the change in one transaction.
 */

type Value = Record<string, unknown>;

/** Shown to an admin: names in full, a birth date as the year only, contact by its last digits. */
function display(field: StudentChangeField, value: Value): string {
  if (field === 'LEGAL_NAME') return [value.legalFirstName, value.legalMiddleName, value.legalLastName].filter(Boolean).join(' ');
  if (field === 'DATE_OF_BIRTH') return value.dateOfBirth ? `Born in ${String(value.dateOfBirth).slice(0, 4)}` : 'Not set';
  return [maskPhone(value.phone as string | null), maskEmail(value.email as string | null)].filter(Boolean).join(' · ') || 'Not set';
}

async function toDTOs(ctx: ServiceContext, rows: StudentChangeRequestDoc[]): Promise<StudentChangeRequestDTO[]> {
  if (rows.length === 0) return [];
  const [students, users] = await Promise.all([
    Student.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(rows.map((r) => r.studentId))] } }).select('personId').lean<Pick<StudentDoc, '_id' | 'personId'>[]>(),
    User.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(rows.flatMap((r) => [r.requestedByUserId, r.decidedBy ?? '']).filter(Boolean))] } }).select('fullName').lean<{ _id: string; fullName: string }[]>(),
  ]);
  const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: students.map((s) => s.personId) } }).lean<PersonDoc[]>();
  const nameOfStudent = new Map(students.map((s) => [s._id, fullNameOf(people.find((p) => p._id === s.personId) ?? { legalFirstName: 'Student', legalLastName: '' })]));
  const userName = new Map(users.map((u) => [u._id, u.fullName]));
  return rows.map((r) => ({
    changeRequestId: r._id,
    studentId: r.studentId,
    studentName: nameOfStudent.get(r.studentId) ?? 'Student',
    requestedByName: userName.get(r.requestedByUserId) ?? 'Parent',
    field: r.field,
    fieldLabel: STUDENT_CHANGE_FIELD_LABELS[r.field],
    oldValue: display(r.field, r.oldValue),
    newValue: display(r.field, r.proposedValue),
    reason: r.reason ?? null,
    status: r.status,
    decidedAt: toIso(r.decidedAt),
    decidedByName: r.decidedBy ? userName.get(r.decidedBy) ?? null : null,
    decisionNote: r.decisionNote ?? null,
    createdAt: toIso(r.createdAt)!,
  }));
}

// ───────────────────────────────────────────────────────────── parent side

export async function createChangeRequest(ctx: ServiceContext, studentId: string, data: CreateStudentChangeRequestData): Promise<StudentChangeRequestDTO> {
  assertParentRole(ctx);
  const link = await assertParentCanAccess(ctx, studentId, 'ACADEMICS');
  try {
    const id = await withTransaction(async (db) => {
      const student = await loadStudent(ctx, studentId, db);
      assertStudentWritable(student);
      let oldValue: Value;
      if (data.field === 'GUARDIAN_CONTACT') {
        const parent = await loadPerson(ctx, link.guardianPersonId, db);
        oldValue = { phone: parent.primaryPhone ?? null, email: parent.primaryEmail ?? null };
      } else {
        const child = await loadPerson(ctx, student.personId, db);
        oldValue = data.field === 'LEGAL_NAME' ? { legalFirstName: child.legalFirstName, legalMiddleName: child.legalMiddleName ?? null, legalLastName: child.legalLastName } : { dateOfBirth: child.dateOfBirth ?? null };
      }
      const [row] = await StudentChangeRequest.create(
        [{ tenantId: ctx.tenantId, studentId, requestedByUserId: ctx.userId, guardianPersonId: link.guardianPersonId, field: data.field, oldValue, proposedValue: data.value, reason: data.reason ?? null }],
        { session: db },
      );
      // Field names only: the values are personal and stay in the request row.
      await recordStudentAudit(ctx, db, { entityType: 'change_request', entityId: row!._id, action: 'change_request.created', changes: [{ field: data.field, from: '[redacted]', to: '[redacted]' }], studentId, metadata: { field: data.field } });
      return row!._id;
    });
    return (await toDTOs(ctx, [(await StudentChangeRequest.findOne({ _id: id, tenantId: ctx.tenantId }).lean<StudentChangeRequestDoc>())!]))[0]!;
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('field')) throw new AppError('CHANGE_REQUEST_PENDING');
    throw err;
  }
}

/** A parent's own requests, newest first, across their children. */
export async function listOwnChangeRequests(ctx: ServiceContext): Promise<StudentChangeRequestDTO[]> {
  assertParentRole(ctx);
  const rows = await StudentChangeRequest.find({ tenantId: ctx.tenantId, requestedByUserId: ctx.userId }).sort({ createdAt: -1 }).limit(100).lean<StudentChangeRequestDoc[]>();
  return toDTOs(ctx, rows);
}

export async function cancelOwnChangeRequest(ctx: ServiceContext, requestId: string): Promise<StudentChangeRequestDTO> {
  assertParentRole(ctx);
  await withTransaction(async (db) => {
    // Another parent's request looks exactly like a missing one.
    const row = await StudentChangeRequest.findOne({ _id: requestId, tenantId: ctx.tenantId, requestedByUserId: ctx.userId }).session(db).lean<StudentChangeRequestDoc>();
    if (!row) throw AppError.notFound('Request not found.');
    if (row.status !== 'PENDING') throw new AppError('CHANGE_REQUEST_CLOSED');
    await StudentChangeRequest.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { status: 'CANCELLED' } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'change_request', entityId: row._id, action: 'change_request.cancelled', studentId: row.studentId, metadata: { field: row.field } });
  });
  return (await toDTOs(ctx, [(await StudentChangeRequest.findOne({ _id: requestId, tenantId: ctx.tenantId }).lean<StudentChangeRequestDoc>())!]))[0]!;
}

// ───────────────────────────────────────────────────────────── admin side

export async function listChangeRequests(ctx: ServiceContext, query: ListStudentChangeRequestsQuery): Promise<StudentChangeRequestListDTO> {
  const filter = { tenantId: ctx.tenantId, ...(query.status ? { status: query.status } : {}), ...(query.field ? { field: query.field } : {}) };
  const [rows, total, pendingCount] = await Promise.all([
    StudentChangeRequest.find(filter).sort({ status: 1, createdAt: -1 }).skip((query.page - 1) * query.pageSize).limit(query.pageSize).lean<StudentChangeRequestDoc[]>(),
    StudentChangeRequest.countDocuments(filter),
    StudentChangeRequest.countDocuments({ tenantId: ctx.tenantId, status: 'PENDING' }),
  ]);
  return { items: await toDTOs(ctx, rows), page: query.page, pageSize: query.pageSize, total, pendingCount };
}

/** Applies the new value to the right person, inside the caller's transaction. */
async function applyChange(ctx: ServiceContext, db: Parameters<Parameters<typeof withTransaction>[0]>[0], row: StudentChangeRequestDoc) {
  const personId = row.field === 'GUARDIAN_CONTACT' ? row.guardianPersonId : (await loadStudent(ctx, row.studentId, db)).personId;
  const before = await loadPerson(ctx, personId, db);
  const value = row.proposedValue;
  const patch: Partial<PersonDoc> =
    row.field === 'LEGAL_NAME'
      ? { legalFirstName: value.legalFirstName as string, legalMiddleName: (value.legalMiddleName as string | null) ?? null, legalLastName: (value.legalLastName as string) ?? '' }
      : row.field === 'DATE_OF_BIRTH'
        ? { dateOfBirth: value.dateOfBirth as string }
        : { ...(value.phone ? { primaryPhone: value.phone as string } : {}), ...(value.email ? { primaryEmail: value.email as string } : {}) };
  const merged = { ...before, ...patch } as PersonDoc;
  const fields = Object.keys(patch);
  const diff = classifiedDiff('person', before, merged, fields as never);
  if (diff.length > 0) await Person.updateOne({ _id: personId, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
  // A child's details changed: bump the version so an edit that began from the old copy is refused.
  if (row.field !== 'GUARDIAN_CONTACT') await Student.updateOne({ _id: row.studentId, tenantId: ctx.tenantId }, { $inc: { version: 1 }, $set: { updatedBy: ctx.userId } }, { session: db });
  return diff;
}

async function decide(ctx: ServiceContext, requestId: string, decision: 'APPROVED' | 'REJECTED', note: string | null | undefined): Promise<StudentChangeRequestDTO> {
  await withTransaction(async (db) => {
    const row = await StudentChangeRequest.findOne({ _id: requestId, tenantId: ctx.tenantId }).session(db).lean<StudentChangeRequestDoc>();
    if (!row) throw AppError.notFound('Request not found.');
    if (row.status !== 'PENDING') throw new AppError('CHANGE_REQUEST_CLOSED');
    let diff: { field: string; from: unknown; to: unknown }[] = [];
    if (decision === 'APPROVED') {
      assertStudentWritable(await loadStudent(ctx, row.studentId, db));
      diff = await applyChange(ctx, db, row);
    }
    await StudentChangeRequest.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { status: decision, decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: note ?? null } }, { session: db });
    await recordStudentAudit(ctx, db, {
      entityType: 'change_request',
      entityId: row._id,
      action: decision === 'APPROVED' ? 'change_request.approved' : 'change_request.rejected',
      studentId: row.studentId,
      metadata: { field: row.field, applied: diff.map((d) => d.field) },
    });
    // The change itself goes on the audit trail of the person it changed, with personal values redacted.
    if (diff.length > 0) {
      await recordStudentAudit(ctx, db, { entityType: row.field === 'GUARDIAN_CONTACT' ? 'person' : 'student', entityId: row.field === 'GUARDIAN_CONTACT' ? row.guardianPersonId : row.studentId, action: row.field === 'GUARDIAN_CONTACT' ? 'guardian.updated' : 'student.updated', changes: diff as never, studentId: row.field === 'GUARDIAN_CONTACT' ? null : row.studentId, metadata: { viaChangeRequest: row._id, ...(row.field === 'GUARDIAN_CONTACT' ? { studentIds: [row.studentId], role: 'GUARDIAN' } : {}) } });
    }
  });
  return (await toDTOs(ctx, [(await StudentChangeRequest.findOne({ _id: requestId, tenantId: ctx.tenantId }).lean<StudentChangeRequestDoc>())!]))[0]!;
}

export const approveChangeRequest = (ctx: ServiceContext, requestId: string, note?: string | null) => decide(ctx, requestId, 'APPROVED', note);
export const rejectChangeRequest = (ctx: ServiceContext, requestId: string, note: string) => decide(ctx, requestId, 'REJECTED', note);
