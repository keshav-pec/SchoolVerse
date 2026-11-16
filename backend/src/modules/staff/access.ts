import { LocationAssignment } from './assignment.models';
import { Employee, LIVE_EMPLOYEE_STATUSES, type EmployeeDoc } from './employee.model';
import { User } from '../../platform/users/user.model';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { recordSecurityEvent } from '../../platform/identity/security-events';
import { DIRECTORY_STATUSES } from './lifecycle';

/**
 * Location scope (PRD §22, Module 3 "Location scope"): School Admin sees the whole school. Faculty and Staff get a colleague
 * directory limited to employees who share one of their own CURRENT locations. Anything outside that is a 404, never a 403,
 * plus a `CROSS_LOCATION_DENIED` security event.
 */

/** The employee record behind the signed-in user, if their login is linked to a person with a live employment. */
export async function findCallerEmployee(ctx: ServiceContext): Promise<EmployeeDoc | null> {
  const user = await User.findOne({ _id: ctx.userId, tenantId: ctx.tenantId }).select('personId').lean<{ personId?: string | null }>();
  if (!user?.personId) return null;
  return Employee.findOne({ tenantId: ctx.tenantId, personId: user.personId, status: { $in: LIVE_EMPLOYEE_STATUSES } }).lean<EmployeeDoc>();
}

/** Locations where the employee has an assignment running today. */
export async function currentLocationIds(tenantId: string, employeeId: string, today: string): Promise<string[]> {
  return LocationAssignment.distinct('locationId', {
    tenantId,
    employeeId,
    cancelledAt: null,
    effectiveFrom: { $lte: today },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
  });
}

/** Employees with an assignment at any of the locations. `includePlanned` adds ones that start later. */
export async function employeeIdsAt(tenantId: string, locationIds: string[], today: string, includePlanned: boolean): Promise<string[]> {
  if (locationIds.length === 0) return [];
  return LocationAssignment.distinct('employeeId', {
    tenantId,
    locationId: { $in: locationIds },
    cancelledAt: null,
    ...(includePlanned ? {} : { effectiveFrom: { $lte: today } }),
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
  });
}

export interface ColleagueScope {
  self: EmployeeDoc | null;
  locationIds: string[];
  /** Employees the caller may see: colleagues who share a location, plus themselves. */
  employeeIds: string[];
}

export async function colleagueScope(ctx: ServiceContext, today: string): Promise<ColleagueScope> {
  const self = await findCallerEmployee(ctx);
  if (!self) return { self: null, locationIds: [], employeeIds: [] };
  const locationIds = await currentLocationIds(ctx.tenantId, self._id, today);
  const colleagues = await employeeIdsAt(ctx.tenantId, locationIds, today, false);
  return { self, locationIds, employeeIds: [...new Set([self._id, ...colleagues])] };
}

/** Whether a limited caller may see this employee in the colleague directory. */
export function isVisibleColleague(scope: ColleagueScope, employee: Pick<EmployeeDoc, '_id' | 'status'>): boolean {
  if (scope.self?._id === employee._id) return true;
  return scope.employeeIds.includes(employee._id) && DIRECTORY_STATUSES.includes(employee.status);
}

export function recordCrossLocationDenied(ctx: ServiceContext, targetEmployeeId: string) {
  return recordSecurityEvent({
    tenantId: ctx.tenantId,
    type: 'CROSS_LOCATION_DENIED',
    actorUserId: ctx.userId,
    targetId: targetEmployeeId,
    ip: ctx.ip ?? null,
    outcome: 'DENIED',
    metadata: { resource: 'employee' },
  });
}
