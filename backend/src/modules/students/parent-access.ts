import type { ClientSession } from 'mongoose';
import type { ParentCapability } from '@shared';
import { AppError } from '../../core/errors';
import { recordSecurityEvent } from '../../platform/identity/security-events';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { todayFor } from '../staff/status';
import { Student, StudentGuardianLink, type StudentGuardianLinkDoc } from './student.models';

/**
 * SEC-SPM-01 — what a parent may see. Access comes only from a guardian link, and it is read from the database on every
 * request. Nothing is cached, so removing access or ending a link makes the very next request fail.
 *
 *   active parent login → the person behind it → a link to THIS student that is live today, has the portal on, allows the
 *   capability (academics or fees) → the student is in the same school.
 *
 * Any step that fails answers 404 (never 403), so a parent cannot even learn that another child's id exists, and a security
 * event with ids only is written. The student id from the browser is never trusted by itself.
 */

const capabilityFlag = { ACADEMICS: 'canSeeAcademics', FEES: 'canSeeFees' } as const satisfies Record<ParentCapability, keyof StudentGuardianLinkDoc>;

/** The live links of a parent that give a capability today. */
export async function parentLinksFor(ctx: ServiceContext, capability: ParentCapability | null, db?: ClientSession): Promise<{ personId: string; links: StudentGuardianLinkDoc[] } | null> {
  const user = await User.findOne({ _id: ctx.userId, tenantId: ctx.tenantId }).select('role status personId').session(db ?? null).lean<{ role: string; status: string; personId: string | null }>();
  if (!user || user.role !== 'PARENT' || user.status !== 'ACTIVE' || !user.personId) return null;
  const today = await todayFor(ctx, db);
  const links = await StudentGuardianLink.find({
    tenantId: ctx.tenantId,
    guardianPersonId: user.personId,
    portalEnabled: true,
    cancelledAt: null,
    effectiveFrom: { $lte: today },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
    ...(capability ? { [capabilityFlag[capability]]: true } : {}),
  })
    .session(db ?? null)
    .lean<StudentGuardianLinkDoc[]>();
  return { personId: user.personId, links };
}

/** Returns the link that lets this parent see the student, or answers 404. */
export async function assertParentCanAccess(ctx: ServiceContext, studentId: string, capability: ParentCapability, db?: ClientSession): Promise<StudentGuardianLinkDoc> {
  const found = await parentLinksFor(ctx, capability, db);
  const link = found?.links.find((l) => l.studentId === studentId) ?? null;
  const student = link ? await Student.exists({ _id: studentId, tenantId: ctx.tenantId }).session(db ?? null) : null;
  if (!link || !student) {
    await recordSecurityEvent({ tenantId: ctx.tenantId, type: 'PARENT_ACCESS_DENIED', actorUserId: ctx.userId, targetId: studentId, ip: ctx.ip ?? null, outcome: 'DENIED', metadata: { capability } });
    throw AppError.notFound('Student not found.');
  }
  return link;
}

/** Only a parent login gets past this. Anyone else is refused with 403 (they are not probing a child, they are in the wrong place). */
export function assertParentRole(ctx: ServiceContext) {
  if (ctx.role !== 'PARENT') throw new AppError('FORBIDDEN');
}
