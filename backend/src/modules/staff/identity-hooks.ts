import { User } from '../../platform/users/user.model';
import { disableAccount } from '../../platform/identity/user-admin.service';
import { ProfileChangeRequest } from './identity.models';
import { EmployeeDocument } from './identity.models';
import { RestrictedPersonData } from '../../platform/identity/restricted-data.model';
import { onEmployeeExited, registerEmployeeHistoryCheck } from './hooks';

let registered = false;

/**
 * Wires Module 3 Part 2 into the Part 1 extension points:
 *  - an exit disables the linked login and ends its sessions, in the same transaction as the EXITED change
 *    (the role stays on record for history, but a disabled account has no access);
 *  - a login, a document, restricted data or a change request counts as history, so the employee is exited instead of deleted.
 */
export function registerStaffIdentityHooks() {
  if (registered) return;
  registered = true;

  onEmployeeExited(async (event, db) => {
    const user = await User.findOne({ tenantId: event.tenantId, personId: event.personId }).session(db).lean();
    if (!user) return;
    await disableAccount(
      event.tenantId,
      user,
      { actor: event.actor, actorId: event.actor === 'SYSTEM' ? null : event.actor.userId, requestId: event.requestId, reason: 'EMPLOYEE_EXITED' },
      db,
    );
  });

  registerEmployeeHistoryCheck('identity', async ({ tenantId, employeeId, personId, session }) => {
    const db = session ?? null;
    const [user, document, restricted, request] = await Promise.all([
      User.exists({ tenantId, personId }).session(db),
      EmployeeDocument.exists({ tenantId, employeeId }).session(db),
      RestrictedPersonData.exists({ tenantId, personId }).session(db),
      ProfileChangeRequest.exists({ tenantId, employeeId }).session(db),
    ]);
    return Boolean(user || document || restricted || request);
  });
}
