import type { ClientSession } from 'mongoose';
import type { SessionRevokeReason } from './session.model';
import { Session } from './session.model';

/**
 * Ends every live session of a user (suspend, disable, role change, password reset, exit). The next request fails because
 * `authenticate` looks the session up each time. Pass `db` to do it in the same transaction as the change that caused it.
 */
export async function revokeUserSessions(tenantId: string, userId: string, reason: SessionRevokeReason, db?: ClientSession): Promise<number> {
  const result = await Session.updateMany({ tenantId, userId, revokedAt: null }, { $set: { revokedAt: new Date(), revokedReason: reason } }, { session: db });
  return result.modifiedCount;
}
