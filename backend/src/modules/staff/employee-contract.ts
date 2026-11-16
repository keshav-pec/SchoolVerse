import type { EmployeePurpose, EmployeeSummaryDTO } from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { listFacultyForSection } from './academic-assignment.service';
import { hydrate } from './directory';
import { loadEmployee } from './guards';
import { ASSIGNABLE_STATUSES } from './lifecycle';
import { displayNameOf, fullNameOf } from './mappers';

/**
 * The in-process contract of Faculty & Staff for later modules (Timetable, Attendance, Fees…). They store `employeeId`
 * (never the editable employee code) and ask these functions whether the employee can be used.
 *
 *   purpose NEW_ASSIGNMENT   a new record is being created: the employee must be onboarding, active or on leave.
 *   purpose HISTORICAL_READ  an old record is being read: any employee, including exited ones.
 */
export async function getEmployeeSummary(ctx: ServiceContext, employeeId: string): Promise<EmployeeSummaryDTO> {
  const employee = await loadEmployee(ctx, employeeId);
  const h = await hydrate(ctx, [employee]);
  const person = h.people.get(employee.personId)!;
  return {
    employeeId: employee._id,
    personId: employee.personId,
    employeeCode: employee.employeeCode,
    fullName: fullNameOf(person),
    displayName: displayNameOf(person),
    employeeCategory: employee.employeeCategory,
    status: employee.status,
    departmentName: h.departments.get(employee.departmentId)?.name ?? '',
    designationName: h.designations.get(employee.designationId)?.name ?? '',
    primaryLocationId: h.placements.get(employee._id)?.primary?.locationId ?? null,
  };
}

export async function assertEmployeeUsable(ctx: ServiceContext, employeeId: string, options: { purpose: EmployeePurpose }): Promise<EmployeeSummaryDTO> {
  const summary = await getEmployeeSummary(ctx, employeeId);
  if (options.purpose === 'NEW_ASSIGNMENT') {
    if (summary.status === 'EXITED') throw new AppError('EMPLOYEE_READ_ONLY');
    if (!ASSIGNABLE_STATUSES.includes(summary.status)) throw new AppError('EMPLOYEE_NOT_USABLE', undefined, { status: summary.status });
  }
  return summary;
}

export const employeeService = { getEmployeeSummary, assertEmployeeUsable, listFacultyForSection };
