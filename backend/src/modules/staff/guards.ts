import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { Employee, type EmployeeDoc } from './employee.model';
import { ASSIGNABLE_STATUSES } from './lifecycle';

/** Loads an employee of this tenant, or 404. Other tenants' ids look exactly like missing ones. */
export async function loadEmployee(ctx: ServiceContext, employeeId: string, db?: ClientSession): Promise<EmployeeDoc> {
  const doc = await Employee.findOne({ _id: employeeId, tenantId: ctx.tenantId }).session(db ?? null).lean<EmployeeDoc>();
  if (!doc) throw AppError.notFound('Employee not found.');
  return doc;
}

/** Exited employees are history: nothing about them can change (`EMPLOYEE_READ_ONLY`). */
export function assertWritable(employee: Pick<EmployeeDoc, 'status'>) {
  if (employee.status === 'EXITED') throw new AppError('EMPLOYEE_READ_ONLY');
}

/** A new class, location or responsibility needs an employee who can actually take it (not suspended, not leaving). */
export function assertAssignable(employee: Pick<EmployeeDoc, 'status'>) {
  assertWritable(employee);
  if (!ASSIGNABLE_STATUSES.includes(employee.status)) {
    throw new AppError('EMPLOYEE_NOT_USABLE', undefined, { status: employee.status });
  }
}

/**
 * A reporting manager is another live employee of the same school, and the reporting line must not loop back
 * (A → B → C → A). `employeeId` is null while creating, when no loop is possible yet.
 */
export async function assertValidManager(ctx: ServiceContext, managerId: string, employeeId: string | null, db: ClientSession) {
  if (employeeId && managerId === employeeId) {
    throw new AppError('REPORTING_CYCLE', 'An employee cannot report to themselves.', { fields: { reportingManagerId: 'Choose someone else.' } });
  }
  const manager = await loadEmployee(ctx, managerId, db);
  if (manager.status === 'EXITED') {
    throw AppError.validation({ reportingManagerId: 'This person has left the school.' });
  }
  if (!employeeId) return;

  const seen = new Set<string>();
  let current: string | null = manager.reportingManagerId;
  while (current && !seen.has(current)) {
    if (current === employeeId) throw new AppError('REPORTING_CYCLE', undefined, { fields: { reportingManagerId: 'That person already reports to this employee.' } });
    seen.add(current);
    const next: { reportingManagerId: string | null } | null = await Employee.findOne({ _id: current, tenantId: ctx.tenantId })
      .session(db)
      .select('reportingManagerId')
      .lean<{ reportingManagerId: string | null }>();
    current = next?.reportingManagerId ?? null;
  }
}

export function assertEmploymentDates(joiningDate: string, confirmationDate: string | null | undefined) {
  if (confirmationDate && confirmationDate < joiningDate) {
    throw AppError.validation({ confirmationDate: 'The confirmation date cannot be before the joining date.' });
  }
}
