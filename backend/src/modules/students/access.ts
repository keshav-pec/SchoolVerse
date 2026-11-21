import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { recordSecurityEvent } from '../../platform/identity/security-events';
import { findCallerEmployee } from '../staff/access';
import { AcademicAssignment } from '../staff/assignment.models';
import { todayFor } from '../staff/status';
import { StudentSectionAssignment, type StudentSectionAssignmentDoc } from './student.models';

/**
 * SEC-SPM-01 — who may see which student. The rules are enforced here, on the server, on every request.
 *
 *   School Admin   everyone (`student:view`)
 *   Faculty        only students who have a section placement today in a section the teacher is assigned to; a Coordinator or
 *                  an HOD of a class sees the whole class. Anything else is a 404 and a `CROSS_SCOPE_DENIED` security event.
 *   Staff, Parent  nothing yet (403; parents use their own routes in Part 3)
 */

/** Assignment types that cover a whole class, not one section. */
const CLASS_WIDE = ['COORDINATOR', 'HOD'] as const;

export interface FacultyScope {
  employeeId: string;
  sectionIds: Set<string>;
  classOfferingIds: Set<string>;
  /** What the teacher teaches inside each section/class: specific subject offerings, or everything (class teacher, coordinator, HOD). */
  coverage: { sectionId: string | null; classOfferingId: string; subjectOfferingId: string | null }[];
}

/** The teacher's reach today: their running academic assignments. `null` when the login is not linked to a live employee. */
export async function facultyScope(ctx: ServiceContext, today: string, db?: ClientSession): Promise<FacultyScope | null> {
  const employee = await findCallerEmployee(ctx);
  if (!employee || employee.employeeCategory !== 'FACULTY') return null;
  const rows = await AcademicAssignment.find({
    tenantId: ctx.tenantId,
    employeeId: employee._id,
    cancelledAt: null,
    effectiveFrom: { $lte: today },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
  })
    .session(db ?? null)
    .lean();
  const sectionIds = new Set<string>();
  const classOfferingIds = new Set<string>();
  for (const r of rows) {
    if ((CLASS_WIDE as readonly string[]).includes(r.assignmentType)) classOfferingIds.add(r.classOfferingId);
    else if (r.sectionId) sectionIds.add(r.sectionId);
  }
  return {
    employeeId: employee._id,
    sectionIds,
    classOfferingIds,
    coverage: rows.map((r) => ({
      sectionId: r.sectionId ?? null,
      classOfferingId: r.classOfferingId,
      subjectOfferingId: (CLASS_WIDE as readonly string[]).includes(r.assignmentType) ? null : r.subjectOfferingId ?? null,
    })),
  };
}

/** Placements running today that are inside the teacher's reach. */
export async function scopedPlacements(ctx: ServiceContext, scope: FacultyScope, today: string, extra: Record<string, unknown> = {}, db?: ClientSession): Promise<StudentSectionAssignmentDoc[]> {
  if (scope.sectionIds.size === 0 && scope.classOfferingIds.size === 0) return [];
  return StudentSectionAssignment.find({
    tenantId: ctx.tenantId,
    cancelledAt: null,
    effectiveFrom: { $lte: today },
    $and: [
      { $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] },
      { $or: [{ sectionId: { $in: [...scope.sectionIds] } }, { classOfferingId: { $in: [...scope.classOfferingIds] } }] },
    ],
    ...extra,
  })
    .session(db ?? null)
    .lean<StudentSectionAssignmentDoc[]>();
}

/**
 * Returns the placement that puts the student in the caller's reach, or answers 404 (never 403, so a teacher cannot even learn
 * that an id exists) and records a security event with ids only.
 */
export async function assertFacultyCanSeeStudent(ctx: ServiceContext, studentId: string, db?: ClientSession): Promise<{ placement: StudentSectionAssignmentDoc; scope: FacultyScope; today: string }> {
  const today = await todayFor(ctx, db);
  const scope = await facultyScope(ctx, today, db);
  const placement = scope ? (await scopedPlacements(ctx, scope, today, { studentId }, db))[0] : undefined;
  if (!scope || !placement) {
    await recordSecurityEvent({ tenantId: ctx.tenantId, type: 'CROSS_SCOPE_DENIED', actorUserId: ctx.userId, targetId: studentId, ip: ctx.ip ?? null, outcome: 'DENIED', metadata: { resource: 'student' } });
    throw AppError.notFound('Student not found.');
  }
  return { placement, scope, today };
}

/** The subjects of the student's current enrollment that this teacher teaches them. */
export function subjectsTaughtBy(scope: FacultyScope, placement: Pick<StudentSectionAssignmentDoc, 'sectionId' | 'classOfferingId'>, studentSubjectOfferingIds: string[]): { all: boolean; ids: Set<string> } {
  const covering = scope.coverage.filter((c) => c.sectionId === placement.sectionId || (c.sectionId === null && c.classOfferingId === placement.classOfferingId));
  const all = covering.some((c) => c.subjectOfferingId === null);
  return { all, ids: new Set(all ? studentSubjectOfferingIds : covering.map((c) => c.subjectOfferingId).filter((id): id is string => Boolean(id) && studentSubjectOfferingIds.includes(id!))) };
}
