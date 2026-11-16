import type { ClientSession } from 'mongoose';
import type { ChangeUserRoleData, SuspendUserData, UserDTO, UserStatus } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import { recordAudit, type AuditActor } from '../../modules/audit/audit.service';
import { revokeUserSessions } from '../auth/sessions';
import type { SessionRevokeReason } from '../auth/session.model';
import { actorFrom, type ServiceContext } from '../rbac/tenant-context';
import { toUserDTO } from '../users/user.mapper';
import { User, type UserDoc } from '../users/user.model';
import { issueAccountToken } from './account-tokens';
import { activationLink, sendSafely } from './notifier';
import { recordSecurityEvent } from './security-events';

/**
 * Admin actions on logins (IAM-03): suspend, reactivate, disable, change role, re-send the activation link.
 * Suspend, disable and a role change end every live session in the same transaction. The role stays on a disabled
 * account for history, but a disabled account has no access.
 */

async function loadUser(tenantId: string, userId: string, db: ClientSession): Promise<UserDoc> {
  const user = await User.findOne({ _id: userId, tenantId }).session(db).lean<UserDoc>();
  if (!user) throw AppError.notFound('User not found.');
  return user;
}

function audit(ctx: { tenantId: string; requestId: string | null }, actor: AuditActor, db: ClientSession, user: UserDoc, action: string, changes: { field: string; from: unknown; to: unknown }[], metadata: Record<string, unknown> = {}) {
  return recordAudit(
    { tenantId: ctx.tenantId, entityType: 'user', entityId: user._id, action, actor, changes, metadata: { subjectPersonId: user.personId, ...metadata }, requestId: ctx.requestId },
    db,
  );
}

/** Someone has to be able to sign in as School Admin. Counts the active admins other than this user. */
async function assertNotLastAdmin(tenantId: string, user: UserDoc, db: ClientSession) {
  if (user.role !== 'SCHOOL_ADMIN' || user.status !== 'ACTIVE') return;
  const others = await User.countDocuments({ tenantId, role: 'SCHOOL_ADMIN', status: 'ACTIVE', _id: { $ne: user._id } }).session(db);
  if (others === 0) throw new AppError('LAST_ADMIN');
}

function assertNotSelf(ctx: ServiceContext, user: UserDoc) {
  if (ctx.userId === user._id) throw new AppError('CANNOT_ACT_ON_SELF');
}

async function setStatus(tenantId: string, user: UserDoc, status: UserStatus, actorId: string | null, db: ClientSession) {
  await User.updateOne({ _id: user._id, tenantId }, { $set: { status, updatedBy: actorId } }, { session: db });
}

export async function suspendUser(ctx: ServiceContext, userId: string, data: SuspendUserData): Promise<UserDTO> {
  const user = await withTransaction(async (db) => {
    const user = await loadUser(ctx.tenantId, userId, db);
    assertNotSelf(ctx, user);
    if (user.status !== 'ACTIVE') throw new AppError('INVALID_STATUS_TRANSITION', 'Only an active account can be suspended.', { from: user.status });
    await assertNotLastAdmin(ctx.tenantId, user, db);
    await setStatus(ctx.tenantId, user, 'SUSPENDED', ctx.userId, db);
    const revoked = await revokeUserSessions(ctx.tenantId, user._id, 'ACCOUNT_SUSPENDED', db);
    await audit(ctx, actorFrom(ctx), db, user, 'user.suspended', [{ field: 'status', from: user.status, to: 'SUSPENDED' }], { reason: data.reason, sessionsRevoked: revoked });
    return user;
  });
  return reload(ctx.tenantId, user._id);
}

export async function reactivateUser(ctx: ServiceContext, userId: string): Promise<UserDTO> {
  await withTransaction(async (db) => {
    const user = await loadUser(ctx.tenantId, userId, db);
    assertNotSelf(ctx, user);
    if (user.status !== 'SUSPENDED') throw new AppError('INVALID_STATUS_TRANSITION', 'Only a suspended account can be reactivated.', { from: user.status });
    await setStatus(ctx.tenantId, user, 'ACTIVE', ctx.userId, db);
    await audit(ctx, actorFrom(ctx), db, user, 'user.reactivated', [{ field: 'status', from: 'SUSPENDED', to: 'ACTIVE' }]);
  });
  return reload(ctx.tenantId, userId);
}

/** Ends access for good (an exited employee's login is disabled this way). Used by the admin action and the exit hook. */
export async function disableAccount(
  tenantId: string,
  user: UserDoc,
  options: { actor: AuditActor; actorId: string | null; requestId: string | null; reason: string },
  db: ClientSession,
) {
  if (user.status === 'DISABLED') return;
  await assertNotLastAdmin(tenantId, user, db);
  await setStatus(tenantId, user, 'DISABLED', options.actorId, db);
  const revoked = await revokeUserSessions(tenantId, user._id, 'ACCOUNT_DISABLED', db);
  await audit({ tenantId, requestId: options.requestId }, options.actor, db, user, 'user.disabled', [{ field: 'status', from: user.status, to: 'DISABLED' }], {
    reason: options.reason,
    sessionsRevoked: revoked,
  });
}

export async function disableUser(ctx: ServiceContext, userId: string): Promise<UserDTO> {
  await withTransaction(async (db) => {
    const user = await loadUser(ctx.tenantId, userId, db);
    assertNotSelf(ctx, user);
    if (user.status === 'DISABLED') throw new AppError('INVALID_STATUS_TRANSITION', 'This account is already disabled.', { from: user.status });
    await disableAccount(ctx.tenantId, user, { actor: actorFrom(ctx), actorId: ctx.userId, requestId: ctx.requestId, reason: 'ADMIN' }, db);
  });
  return reload(ctx.tenantId, userId);
}

export async function changeUserRole(ctx: ServiceContext, userId: string, data: ChangeUserRoleData): Promise<UserDTO> {
  await withTransaction(async (db) => {
    const user = await loadUser(ctx.tenantId, userId, db);
    assertNotSelf(ctx, user);
    if (user.status === 'DISABLED') throw new AppError('INVALID_STATUS_TRANSITION', 'A disabled account cannot be changed.', { from: user.status });
    if (user.role === data.role) return;
    await assertNotLastAdmin(ctx.tenantId, user, db);
    await User.updateOne({ _id: user._id, tenantId: ctx.tenantId }, { $set: { role: data.role, updatedBy: ctx.userId } }, { session: db });
    const reason: SessionRevokeReason = 'ROLE_CHANGED';
    const revoked = await revokeUserSessions(ctx.tenantId, user._id, reason, db);
    await audit(ctx, actorFrom(ctx), db, user, 'user.role_changed', [{ field: 'role', from: user.role, to: data.role }], { sessionsRevoked: revoked });
  });
  const dto = await reload(ctx.tenantId, userId);
  await recordSecurityEvent({ tenantId: ctx.tenantId, type: 'ROLE_CHANGED', actorUserId: ctx.userId, targetId: userId, ip: ctx.ip ?? null, outcome: 'SUCCESS', metadata: { to: dto.role } });
  return dto;
}

export async function resendActivation(ctx: ServiceContext, userId: string): Promise<UserDTO> {
  const { user, token } = await withTransaction(async (db) => {
    const user = await loadUser(ctx.tenantId, userId, db);
    if (user.status !== 'PENDING_ACTIVATION') throw new AppError('INVALID_STATUS_TRANSITION', 'Only an account that has not been activated needs a new link.', { from: user.status });
    const { token } = await issueAccountToken(ctx.tenantId, user._id, 'ACTIVATION', db);
    await audit(ctx, actorFrom(ctx), db, user, 'user.activation_resent', []);
    return { user, token };
  });
  await sendSafely({ tenantId: ctx.tenantId, to: user.email, template: 'ACTIVATION', link: activationLink(token) });
  return reload(ctx.tenantId, userId);
}

async function reload(tenantId: string, userId: string): Promise<UserDTO> {
  return toUserDTO((await User.findOne({ _id: userId, tenantId }).lean<UserDoc>())!);
}
