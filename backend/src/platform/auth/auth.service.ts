import { randomBytes, randomUUID } from 'node:crypto';
import { type LoginInput, type SessionDTO, type SignupInput } from '@shared';
import { effectivePermissions } from '../rbac/permission-providers';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';
import { logger } from '../../core/logger';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { withTransaction } from '../../db/transaction';
import { recordAudit } from '../../modules/audit/audit.service';
import { recordSecurityEvent } from '../identity/security-events';
import { Tenant, type TenantDoc } from '../tenants/tenant.model';
import { toTenantDTO, toUserDTO } from '../users/user.mapper';
import { User, type UserDoc } from '../users/user.model';
import { DUMMY_HASH, hashPassword, verifyPassword } from './password';
import { Session } from './session.model';
import { generateOpaqueToken, hashToken, signAccessToken } from './tokens';

export interface ClientMeta {
  userAgent?: string | null;
  ip?: string | null;
  requestId?: string | null;
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/** A refresh token presented again within this window after rotation is treated as a benign race (multi-tab). */
const ROTATION_GRACE_MS = 30_000;

/**
 * Another request (usually another tab) already rotated this refresh token. The browser now holds that request's new
 * cookies, so the refresh route must not clear them: the caller simply retries with what it has.
 */
export class RefreshRaceLost extends AppError {
  constructor() {
    super('SESSION_EXPIRED');
  }
}

function slugify(name: string) {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `${base || 'school'}-${randomBytes(3).toString('hex')}`;
}

async function issueSession(user: Pick<UserDoc, '_id' | 'tenantId' | 'role'>, meta: ClientMeta, familyId: string = randomUUID(), stepUpAt: Date | null = null) {
  const refreshToken = generateOpaqueToken();
  const session = await Session.create({
    tenantId: user.tenantId,
    userId: user._id,
    tokenHash: hashToken(refreshToken),
    familyId,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000),
    userAgent: meta.userAgent?.slice(0, 400) ?? null,
    ip: meta.ip ?? null,
    stepUpAt,
  });
  const accessToken = signAccessToken({ sub: user._id, tid: user.tenantId, role: user.role, sid: session._id });
  return { session, tokens: { accessToken, refreshToken } satisfies IssuedTokens };
}

async function buildSession(user: UserDoc, tenant: TenantDoc): Promise<SessionDTO> {
  return { user: toUserDTO(user), tenant: toTenantDTO(tenant), permissions: await effectivePermissions(user) };
}

async function loadTenantOrThrow(tenantId: string) {
  const tenant = await Tenant.findById(tenantId).lean<TenantDoc>();
  if (!tenant) throw new AppError('UNAUTHENTICATED');
  if (tenant.status !== 'ACTIVE') throw new AppError('ACCOUNT_DISABLED');
  return tenant;
}

// ───────────────────────────────────────────────────────────── signup

export async function signup(input: SignupInput, meta: ClientMeta) {
  const existing = await User.exists({ email: input.email }).setOptions(SKIP_TENANT_SCOPE);
  if (existing) throw new AppError('EMAIL_TAKEN', undefined, { fields: { email: 'An account with this email already exists.' } });

  const passwordHash = await hashPassword(input.password);

  let created: { user: UserDoc; tenant: TenantDoc };
  try {
    created = await withTransaction(async (session) => {
      const tenantId = randomUUID();
      const userId = randomUUID();
      const [tenant] = await Tenant.create(
        [{ _id: tenantId, name: input.workspaceName, slug: slugify(input.workspaceName), createdBy: userId }],
        { session },
      );
      const [user] = await User.create(
        [
          {
            _id: userId,
            tenantId,
            email: input.email,
            passwordHash,
            fullName: input.fullName,
            role: 'SCHOOL_ADMIN',
            createdBy: userId,
            updatedBy: userId,
          },
        ],
        { session },
      );
      const actor = { userId, role: 'SCHOOL_ADMIN' as const };
      await recordAudit(
        { tenantId, entityType: 'tenant', entityId: tenantId, action: 'tenant.created', actor, metadata: { name: input.workspaceName }, requestId: meta.requestId },
        session,
      );
      await recordAudit(
        { tenantId, entityType: 'user', entityId: userId, action: 'user.created', actor, metadata: { role: 'SCHOOL_ADMIN', email: input.email }, requestId: meta.requestId },
        session,
      );
      return { user: user!.toObject() as UserDoc, tenant: tenant!.toObject() as TenantDoc };
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new AppError('EMAIL_TAKEN', undefined, { fields: { email: 'An account with this email already exists.' } });
    }
    throw err;
  }

  const { tokens } = await issueSession(created.user, meta);
  return { session: await buildSession(created.user, created.tenant), tokens };
}

// ───────────────────────────────────────────────────────────── login

export async function login(input: LoginInput, meta: ClientMeta) {
  // System lookup: the tenant is unknown until we find the user by email.
  const user = await User.findOne({ email: input.email }).select('+passwordHash').setOptions(SKIP_TENANT_SCOPE).lean<UserDoc>();

  // A pending account has no password yet; it fails like a wrong password so nothing is revealed.
  const valid = await verifyPassword(input.password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.passwordHash || !valid) {
    if (user) await recordSecurityEvent({ tenantId: user.tenantId, type: 'LOGIN_FAILED', actorUserId: user._id, ip: meta.ip ?? null, outcome: 'FAILED' });
    throw new AppError('INVALID_CREDENTIALS');
  }
  if (user.status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED');
  if (user.status !== 'ACTIVE') throw new AppError('ACCOUNT_DISABLED');

  const tenant = await loadTenantOrThrow(user.tenantId);
  const now = new Date();
  await User.updateOne({ _id: user._id, tenantId: user.tenantId }, { $set: { lastLoginAt: now } });

  const { tokens } = await issueSession(user, meta);
  logger.info({ userId: user._id, tenantId: user.tenantId }, 'User signed in');
  return { session: await buildSession({ ...user, lastLoginAt: now }, tenant), tokens };
}

// ───────────────────────────────────────────────────────────── refresh (rotation + reuse detection)

export async function refresh(rawToken: string | undefined, meta: ClientMeta) {
  if (!rawToken) throw new AppError('UNAUTHENTICATED');

  // System lookup by opaque token hash — tenant is derived from the session itself.
  const current = await Session.findOne({ tokenHash: hashToken(rawToken) }).setOptions(SKIP_TENANT_SCOPE);
  if (!current) throw new AppError('UNAUTHENTICATED');

  if (current.revokedAt) {
    const benignRace =
      current.revokedReason === 'ROTATED' && Date.now() - current.revokedAt.getTime() < ROTATION_GRACE_MS;
    if (!benignRace) {
      // A revoked token was replayed: assume theft and kill the whole session family.
      await Session.updateMany(
        { tenantId: current.tenantId, familyId: current.familyId, revokedAt: null },
        { $set: { revokedAt: new Date(), revokedReason: 'REUSE_DETECTED' } },
      );
      logger.warn({ tenantId: current.tenantId, userId: current.userId }, 'Refresh token reuse detected');
      await recordSecurityEvent({ tenantId: current.tenantId, type: 'REFRESH_TOKEN_REUSE', actorUserId: current.userId, ip: meta.ip ?? null, outcome: 'DENIED' });
      throw new AppError('SESSION_EXPIRED');
    }
    throw new RefreshRaceLost();
  }
  if (current.expiresAt.getTime() <= Date.now()) throw new AppError('SESSION_EXPIRED');

  const user = await User.findOne({ _id: current.userId, tenantId: current.tenantId }).lean<UserDoc>();
  if (!user || user.status !== 'ACTIVE') throw new AppError('UNAUTHENTICATED');
  const tenant = await loadTenantOrThrow(user.tenantId);

  const { session: next, tokens } = await issueSession(user, meta, current.familyId, current.stepUpAt ?? null);
  const rotated = await Session.updateOne(
    { _id: current._id, tenantId: current.tenantId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'ROTATED', replacedBySessionId: next._id, lastUsedAt: new Date() } },
  );
  if (rotated.modifiedCount === 0) {
    // Lost a race with a concurrent refresh — discard the session we just created.
    await Session.deleteOne({ _id: next._id, tenantId: next.tenantId });
    throw new RefreshRaceLost();
  }

  return { session: await buildSession(user, tenant), tokens };
}

// ───────────────────────────────────────────────────────────── logout

export async function logout(rawToken: string | undefined) {
  if (!rawToken) return;
  await Session.updateOne(
    { tokenHash: hashToken(rawToken), revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: 'LOGOUT' } },
  ).setOptions(SKIP_TENANT_SCOPE);
}

// ───────────────────────────────────────────────────────────── me

export async function getSession(auth: { userId: string; tenantId: string }): Promise<SessionDTO> {
  const user = await User.findOne({ _id: auth.userId, tenantId: auth.tenantId }).lean<UserDoc>();
  if (!user) throw new AppError('UNAUTHENTICATED');
  const tenant = await loadTenantOrThrow(auth.tenantId);
  return buildSession(user, tenant);
}
