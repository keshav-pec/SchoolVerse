import type { ClientSession } from 'mongoose';
import type { EnrollmentOutcome } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AppError } from '../../core/errors';
import { SubjectOffering, type ClassOfferingDoc, type SubjectOfferingDoc } from '../academic/offering.model';
import { AcademicProgramme, type AcademicProgrammeDoc } from '../academic/rules.model';
import { diffFields } from '../audit/diff';
import { todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { revokePortalInTx } from './portal.service';
import { endPatch } from './rows';
import { checkSubjectSelection, UNDECIDED_CODES } from './rules';
import { StudentGuardianLink, StudentEnrollment, StudentSectionAssignment, StudentSubjectEnrollment, type StudentEnrollmentDoc, type StudentGuardianLinkDoc, type StudentSectionAssignmentDoc } from './student.models';
import { assertProgrammeForClass, endAllSubjectRows, initializeMandatoryInTx, liveSubjectRows, loadCheckProgramme, loadClassRules } from './subject.service';

/**
 * Pieces shared by transfer, promotion, repeat, exit and readmission (Module 4, Part 3). Each runs inside the caller's transaction
 * and only closes rows and creates new ones: nothing is deleted and nothing is edited in place except the state of the row being closed.
 */

/**
 * Closes an enrollment: its state, last day and outcome, the open section placement and the subject rows inside it. Promotion uses
 * `COMPLETED`, withdrawal `WITHDRAWN` / `TRANSFERRED`, a move between campuses `TRANSFERRED`.
 */
export async function closeEnrollmentInTx(
  ctx: ServiceContext,
  db: ClientSession,
  enrollment: StudentEnrollmentDoc,
  input: { lastDay: string; state: 'COMPLETED' | 'WITHDRAWN' | 'TRANSFERRED'; outcome?: EnrollmentOutcome | null; reason?: string },
) {
  const { lastDay } = input;
  await StudentEnrollment.updateOne(
    { _id: enrollment._id, tenantId: ctx.tenantId },
    { $set: { state: input.state, effectiveTo: lastDay, outcome: input.outcome ?? null, updatedBy: ctx.userId }, $inc: { version: 1 } },
    { session: db },
  );
  const open = await StudentSectionAssignment.find({ tenantId: ctx.tenantId, enrollmentId: enrollment._id, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: lastDay } }] })
    .session(db)
    .lean<StudentSectionAssignmentDoc[]>();
  for (const row of open) {
    const patch = endPatch(row, lastDay);
    await StudentSectionAssignment.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, {
      entityType: 'section_assignment',
      entityId: row._id,
      action: 'section_assignment.ended',
      changes: 'effectiveTo' in patch ? [{ field: 'effectiveTo', from: row.effectiveTo ?? null, to: patch.effectiveTo }] : [{ field: 'cancelledAt', from: null, to: new Date().toISOString() }],
      studentId: enrollment.studentId,
      metadata: { enrollmentId: enrollment._id, reason: input.reason ?? `ENROLLMENT_${input.state}` },
    });
  }
  await endAllSubjectRows(ctx, db, enrollment, lastDay);
  await recordStudentAudit(ctx, db, {
    entityType: 'enrollment',
    entityId: enrollment._id,
    action: input.state === 'COMPLETED' ? 'enrollment.completed' : 'enrollment.closed',
    changes: diffFields(enrollment, { ...enrollment, state: input.state, effectiveTo: lastDay, outcome: input.outcome ?? null }, ['state', 'effectiveTo', 'outcome']),
    studentId: enrollment.studentId,
    metadata: input.reason ? { reason: input.reason } : {},
  });
}

/**
 * Carries a student's subjects into a new enrollment. The new class's required subjects are added first. Electives are copied only
 * where the same subject is offered in the new class; if the copied choice breaks a rule it is not copied, and if it is only
 * incomplete it is kept and the student is left with "choice pending". Subjects are matched by the subject itself, never by the
 * old offering, because offerings belong to one class in one session.
 */
export async function carrySubjectsInTx(
  ctx: ServiceContext,
  db: ClientSession,
  input: { toEnrollment: StudentEnrollmentDoc; previousOfferingIds: string[]; copy: boolean },
): Promise<{ mandatoryAdded: number; carried: number; choicePending: boolean }> {
  const { toEnrollment } = input;
  const { added } = await initializeMandatoryInTx(ctx, toEnrollment, db);
  const today = await todayFor(ctx, db);
  const rules = await loadClassRules(ctx, toEnrollment.classOfferingId, db);
  const programme = await loadCheckProgramme(ctx, toEnrollment.programmeId, db);
  const have = new Set((await liveSubjectRows(ctx, toEnrollment._id, today, db)).map((r) => r.subjectOfferingId));

  let toCopy: string[] = [];
  if (input.copy && input.previousOfferingIds.length > 0) {
    const old = await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: input.previousOfferingIds } }).session(db).lean<SubjectOfferingDoc[]>();
    const subjectIds = new Set(old.map((o) => o.subjectId));
    const wanted = rules.offerings.filter((o) => o.status === 'ACTIVE' && subjectIds.has(o.subjectId) && !have.has(o._id));
    const attempt = checkSubjectSelection({ ...rules.check, programme, selected: [...have, ...wanted.map((o) => o._id)], addMandatory: true });
    const wrong = attempt.problems.filter((p) => !(UNDECIDED_CODES as readonly string[]).includes(p.code));
    toCopy = wrong.length === 0 ? wanted.map((o) => o._id) : [];
  }
  for (const subjectOfferingId of toCopy) {
    const [row] = await StudentSubjectEnrollment.create(
      [{ tenantId: ctx.tenantId, studentId: toEnrollment.studentId, enrollmentId: toEnrollment._id, subjectOfferingId, source: 'ADMIN_SELECTED', isMandatory: false, effectiveFrom: toEnrollment.effectiveFrom, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    await recordStudentAudit(ctx, db, {
      entityType: 'subject_enrollment',
      entityId: row!._id,
      action: 'subject_enrollment.created',
      changes: [{ field: 'subjectOfferingId', from: null, to: subjectOfferingId }, { field: 'source', from: null, to: 'ADMIN_SELECTED' }],
      studentId: toEnrollment.studentId,
      metadata: { enrollmentId: toEnrollment._id, subjectName: rules.subjectName.get(subjectOfferingId), carriedForward: true },
    });
  }
  const after = checkSubjectSelection({ ...rules.check, programme, selected: [...have, ...toCopy], addMandatory: false });
  return { mandatoryAdded: added.length, carried: toCopy.length, choicePending: !after.valid };
}

/** The same programme (by code) in another session or campus, when it still covers the class. Otherwise null: the admin chooses again. */
export async function mapProgramme(ctx: ServiceContext, db: ClientSession, programmeId: string | null, toClass: ClassOfferingDoc): Promise<string | null> {
  if (!programmeId) return null;
  const old = await AcademicProgramme.findOne({ _id: programmeId, tenantId: ctx.tenantId }).session(db).lean<AcademicProgrammeDoc>();
  if (!old) return null;
  const next = await AcademicProgramme.findOne({ tenantId: ctx.tenantId, sessionId: toClass.sessionId, locationId: toClass.locationId, code: old.code, status: 'ACTIVE' }).session(db).lean<AcademicProgrammeDoc>();
  if (!next) return null;
  try {
    await assertProgrammeForClass(ctx, next._id, toClass, db);
    return next._id;
  } catch (err) {
    if (err instanceof AppError) return null;
    throw err;
  }
}

/** Ends the parents' portal access to this student (not their logins, and not their other children). Used when a student leaves. */
export async function endPortalAccessInTx(ctx: ServiceContext, db: ClientSession, studentId: string, reason: string): Promise<number> {
  const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, studentId, portalEnabled: true }).session(db).lean<StudentGuardianLinkDoc[]>();
  for (const link of links) await revokePortalInTx(ctx, db, link, reason);
  return links.length;
}
