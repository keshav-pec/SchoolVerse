import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User, type UserDoc } from '../../platform/users/user.model';
import { Employee, LIVE_EMPLOYEE_STATUSES, type EmployeeDoc } from './employee.model';

/** The signed-in user and the live employment their login is linked to, for the `/me/*` routes (FSM-06). */
export interface Caller {
  user: UserDoc;
  employee: EmployeeDoc;
}

export class EmployeeNotLinked extends AppError {
  constructor() {
    super('NO_EMPLOYEE_PROFILE');
  }
}

/** Throws `NO_EMPLOYEE_PROFILE` when the login has no person, or the person has no current employment (an admin, a parent). */
export async function requireCaller(ctx: ServiceContext, db?: ClientSession): Promise<Caller> {
  const user = await User.findOne({ _id: ctx.userId, tenantId: ctx.tenantId }).session(db ?? null).lean<UserDoc>();
  if (!user?.personId) throw new EmployeeNotLinked();
  const employee = await Employee.findOne({ tenantId: ctx.tenantId, personId: user.personId, status: { $in: LIVE_EMPLOYEE_STATUSES } })
    .session(db ?? null)
    .lean<EmployeeDoc>();
  if (!employee) throw new EmployeeNotLinked();
  return { user, employee };
}
