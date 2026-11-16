import type { EmployeeHistoryDTO } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { AuditEvent, type AuditEventDoc } from '../audit/audit.model';
import { toAuditEventDTO } from '../audit/audit.service';
import { listAcademicAssignments } from './academic-assignment.service';
import { loadEmployee } from './guards';
import { listLocationAssignments } from './location-assignment.service';
import { listResponsibilities } from './responsibility.service';

/**
 * `GET /employees/:id/history` — assignment history (every row ever, with its computed status) merged with the audit
 * timeline for the employee. Every staff audit row carries `metadata.employeeId`, so one query finds them all; changes to the
 * person's login carry `metadata.subjectPersonId` instead, because a login belongs to the person and outlives one employment.
 */
export async function getEmployeeHistory(ctx: ServiceContext, employeeId: string, limit: number): Promise<EmployeeHistoryDTO> {
  const employee = await loadEmployee(ctx, employeeId);
  const [locationAssignments, academicAssignments, responsibilities, rows] = await Promise.all([
    listLocationAssignments(ctx, employeeId),
    listAcademicAssignments(ctx, employeeId),
    listResponsibilities(ctx, employeeId),
    AuditEvent.find({ tenantId: ctx.tenantId, $or: [{ 'metadata.employeeId': employeeId }, { 'metadata.subjectPersonId': employee.personId }] }).sort({ occurredAt: -1, _id: -1 }).limit(limit).lean<AuditEventDoc[]>(),
  ]);

  const actorIds = [...new Set(rows.map((r) => r.actorId).filter((id): id is string => Boolean(id)))];
  const actors = actorIds.length ? await User.find({ tenantId: ctx.tenantId, _id: { $in: actorIds } }).select('fullName').lean<{ _id: string; fullName: string }[]>() : [];
  const names = new Map(actors.map((u) => [u._id, u.fullName]));

  return {
    locationAssignments,
    academicAssignments,
    responsibilities,
    events: rows.map((r) => toAuditEventDTO(r, r.actorId ? names.get(r.actorId) ?? null : null)),
  };
}
