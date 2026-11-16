import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import type { CreateUserAccountData, EmployeeAccountDTO, UserDTO } from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { withTransaction } from '../../db/transaction';
import { issueAccountToken } from '../../platform/identity/account-tokens';
import { activationLink, sendSafely } from '../../platform/identity/notifier';
import { actorFrom, type ServiceContext } from '../../platform/rbac/tenant-context';
import { toUserDTO } from '../../platform/users/user.mapper';
import { User, type UserDoc } from '../../platform/users/user.model';
import { recordAudit } from '../audit/audit.service';
import { assertWritable, loadEmployee, loadPerson } from './guards';
import { displayNameOf } from './mappers';

/**
 * IAM-01 — a login is created independently of the employee record. The admin picks the role (a designation such as
 * Principal grants nothing) and never sets or sees a password: the person gets a single-use link and chooses their own.
 */

async function userForPerson(tenantId: string, personId: string, db?: ClientSession) {
  return User.findOne({ tenantId, personId }).session(db ?? null).lean<UserDoc>();
}

export async function getEmployeeAccount(ctx: ServiceContext, employeeId: string): Promise<EmployeeAccountDTO> {
  const employee = await loadEmployee(ctx, employeeId);
  const user = await userForPerson(ctx.tenantId, employee.personId);
  return { account: user ? toUserDTO(user) : null, defaultEmail: employee.officialEmail ?? null };
}

export async function createEmployeeAccount(ctx: ServiceContext, employeeId: string, data: CreateUserAccountData): Promise<UserDTO> {
  let result: { userId: string; email: string; token: string };
  try {
    result = await withTransaction(async (db) => {
      const employee = await loadEmployee(ctx, employeeId, db);
      assertWritable(employee);
      const person = await loadPerson(ctx.tenantId, employee.personId, db);
      const email = data.email ?? employee.officialEmail;
      if (!email) throw AppError.validation({ email: 'Enter the email this person will sign in with.' });

      const taken = await User.exists({ email }).setOptions(SKIP_TENANT_SCOPE).session(db);
      const existing = await userForPerson(ctx.tenantId, employee.personId, db);
      if (taken && taken._id !== existing?._id) throw new AppError('EMAIL_TAKEN', undefined, { fields: { email: 'An account with this email already exists.' } });
      // A person who left and came back keeps their login row: it is restored, with a new role and a new link.
      if (existing && existing.status !== 'DISABLED') throw new AppError('ACCOUNT_EXISTS');

      const userId = existing?._id ?? randomUUID();
      const fullName = displayNameOf(person).slice(0, 100);
      if (existing) {
        await User.updateOne(
          { _id: existing._id, tenantId: ctx.tenantId },
          { $set: { email, fullName, role: data.role, status: 'PENDING_ACTIVATION', passwordHash: null, updatedBy: ctx.userId } },
          { session: db },
        );
      } else {
        await User.create([{ _id: userId, tenantId: ctx.tenantId, email, fullName, role: data.role, personId: employee.personId, status: 'PENDING_ACTIVATION', createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
      }
      const { token } = await issueAccountToken(ctx.tenantId, userId, 'ACTIVATION', db);
      await recordAudit(
        {
          tenantId: ctx.tenantId,
          entityType: 'user',
          entityId: userId,
          action: existing ? 'user.account_restored' : 'user.account_created',
          actor: actorFrom(ctx),
          changes: [
            { field: 'role', from: existing?.role ?? null, to: data.role },
            { field: 'status', from: existing?.status ?? null, to: 'PENDING_ACTIVATION' },
          ],
          // `employeeId` puts the event on this employee's history timeline; the email is not recorded.
          metadata: { employeeId, subjectPersonId: employee.personId },
          requestId: ctx.requestId,
        },
        db,
      );
      return { userId, email, token };
    });
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('email')) throw new AppError('EMAIL_TAKEN', undefined, { fields: { email: 'An account with this email already exists.' } });
    throw err;
  }

  // After the commit: a delivery problem must not undo the account (the admin can re-send).
  await sendSafely({ tenantId: ctx.tenantId, to: result.email, template: 'ACTIVATION', link: activationLink(result.token) });
  return toUserDTO((await User.findOne({ _id: result.userId, tenantId: ctx.tenantId }).lean<UserDoc>())!);
}
