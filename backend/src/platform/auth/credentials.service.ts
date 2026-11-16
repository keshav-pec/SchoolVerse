import type { ClientSession } from 'mongoose';
import { STEP_UP_SECONDS, type ActivateAccountData, type ActivationCheckDTO, type ResetPasswordData, type StepUpDTO } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import { recordAudit } from '../../modules/audit/audit.service';
import { consumeAccountToken, findAccountToken, issueAccountToken } from '../identity/account-tokens';
import { resetLink, sendSafely } from '../identity/notifier';
import { recordSecurityEvent } from '../identity/security-events';
import { User, type UserDoc } from '../users/user.model';
import type { ClientMeta } from './auth.service';
import { hashPassword, verifyPassword } from './password';
import { Session } from './session.model';
import { revokeUserSessions } from './sessions';

/** Activation, forgot/reset password and step-up. None of these ever reveals whether an email or a token exists. */

async function loadUserFor(tenantId: string, userId: string, db: ClientSession) {
  const user = await User.findOne({ _id: userId, tenantId }).session(db).lean<UserDoc>();
  if (!user) throw new AppError('TOKEN_INVALID');
  return user;
}

/** `GET /auth/activation/:token`: is the link good, and who is it for (first name only). */
export async function checkActivation(rawToken: string): Promise<ActivationCheckDTO> {
  const token = await findAccountToken(rawToken, 'ACTIVATION');
  const user = await User.findOne({ _id: token.userId, tenantId: token.tenantId }).lean<UserDoc>();
  if (!user || user.status !== 'PENDING_ACTIVATION') throw new AppError('TOKEN_INVALID');
  return { firstName: user.fullName.split(/\s+/)[0] ?? user.fullName };
}

/** The person sets their own password. The admin never sees or chooses one. */
export async function activateAccount(data: ActivateAccountData, meta: ClientMeta): Promise<void> {
  const passwordHash = await hashPassword(data.password);
  await withTransaction(async (db) => {
    const token = await findAccountToken(data.token, 'ACTIVATION', db);
    const user = await loadUserFor(token.tenantId, token.userId, db);
    if (user.status !== 'PENDING_ACTIVATION') throw new AppError('TOKEN_INVALID');
    await consumeAccountToken(token, db);
    await User.updateOne({ _id: user._id, tenantId: user.tenantId }, { $set: { passwordHash, status: 'ACTIVE', passwordChangedAt: new Date(), updatedBy: user._id } }, { session: db });
    await recordAudit(
      {
        tenantId: user.tenantId,
        entityType: 'user',
        entityId: user._id,
        action: 'user.activated',
        actor: { userId: user._id, role: user.role },
        changes: [{ field: 'status', from: 'PENDING_ACTIVATION', to: 'ACTIVE' }],
        metadata: { subjectPersonId: user.personId },
        requestId: meta.requestId,
      },
      db,
    );
  });
}

/**
 * Always the same answer. A reset link goes out only for an ACTIVE account; pending, suspended, disabled and unknown emails
 * get nothing, and the caller cannot tell which case it was.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await User.findOne({ email }).setOptions({ skipTenantScope: true }).lean<UserDoc>();
  if (!user || user.status !== 'ACTIVE') return;
  const { token } = await issueAccountToken(user.tenantId, user._id, 'PASSWORD_RESET');
  await sendSafely({ tenantId: user.tenantId, to: user.email, template: 'PASSWORD_RESET', link: resetLink(token) });
}

/** New password, and every session of the user ends (a stolen session does not survive a reset). */
export async function resetPassword(data: ResetPasswordData, meta: ClientMeta): Promise<void> {
  const passwordHash = await hashPassword(data.password);
  await withTransaction(async (db) => {
    const token = await findAccountToken(data.token, 'PASSWORD_RESET', db);
    const user = await loadUserFor(token.tenantId, token.userId, db);
    if (user.status !== 'ACTIVE') throw new AppError('TOKEN_INVALID');
    await consumeAccountToken(token, db);
    await User.updateOne({ _id: user._id, tenantId: user.tenantId }, { $set: { passwordHash, passwordChangedAt: new Date(), updatedBy: user._id } }, { session: db });
    const revoked = await revokeUserSessions(user.tenantId, user._id, 'PASSWORD_RESET', db);
    await recordAudit(
      {
        tenantId: user.tenantId,
        entityType: 'user',
        entityId: user._id,
        action: 'user.password_reset',
        actor: { userId: user._id, role: user.role },
        metadata: { sessionsRevoked: revoked, subjectPersonId: user.personId },
        requestId: meta.requestId,
      },
      db,
    );
  });
}

/** Re-checks the signed-in user's password and stamps the session; restricted routes read the stamp (5 minutes). */
export async function stepUp(auth: { userId: string; tenantId: string; sessionId: string | null }, password: string, meta: ClientMeta): Promise<StepUpDTO> {
  const user = await User.findOne({ _id: auth.userId, tenantId: auth.tenantId }).select('+passwordHash').lean<UserDoc>();
  const valid = user?.passwordHash ? await verifyPassword(password, user.passwordHash) : false;
  if (!user || !valid || !auth.sessionId) {
    await recordSecurityEvent({ tenantId: auth.tenantId, type: 'STEP_UP_FAILED', actorUserId: auth.userId, ip: meta.ip ?? null, outcome: 'FAILED' });
    throw new AppError('INVALID_CREDENTIALS');
  }
  const stepUpAt = new Date();
  await Session.updateOne({ _id: auth.sessionId, tenantId: auth.tenantId }, { $set: { stepUpAt } });
  return { stepUpAt: stepUpAt.toISOString(), validForSeconds: STEP_UP_SECONDS };
}
