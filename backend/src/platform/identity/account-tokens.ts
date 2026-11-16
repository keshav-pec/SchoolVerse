import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import { SKIP_TENANT_SCOPE } from '../../db/plugins/tenant-scope';
import { generateOpaqueToken, hashToken } from '../auth/tokens';
import { AccountToken, type AccountTokenDoc, type AccountTokenPurpose } from './account-token.model';

export const ACTIVATION_TTL_MS = 72 * 60 * 60 * 1000;
export const RESET_TTL_MS = 30 * 60 * 1000;

const TTL: Record<AccountTokenPurpose, number> = { ACTIVATION: ACTIVATION_TTL_MS, PASSWORD_RESET: RESET_TTL_MS };

/**
 * Issues a single-use link token (48 random bytes). Only its HMAC is stored. Issuing a new one voids every older one of the
 * same purpose for that user.
 */
export async function issueAccountToken(tenantId: string, userId: string, purpose: AccountTokenPurpose, db?: ClientSession) {
  await AccountToken.deleteMany({ tenantId, userId, purpose }, { session: db });
  const raw = generateOpaqueToken();
  const expiresAt = new Date(Date.now() + TTL[purpose]);
  await AccountToken.create([{ tenantId, userId, purpose, tokenHash: hashToken(raw), expiresAt }], { session: db });
  return { token: raw, expiresAt };
}

/** Finds a usable token. Unknown, used and expired tokens all fail the same way (`TOKEN_INVALID`). */
export async function findAccountToken(raw: string, purpose: AccountTokenPurpose, db?: ClientSession): Promise<AccountTokenDoc> {
  // System lookup: the tenant is unknown until the token is found.
  const doc = await AccountToken.findOne({ tokenHash: hashToken(raw), purpose })
    .setOptions(SKIP_TENANT_SCOPE)
    .session(db ?? null)
    .lean<AccountTokenDoc>();
  if (!doc || doc.usedAt || doc.expiresAt.getTime() <= Date.now()) throw new AppError('TOKEN_INVALID');
  return doc;
}

/** Marks the token used. Two requests racing on one token: exactly one wins. */
export async function consumeAccountToken(token: AccountTokenDoc, db: ClientSession) {
  const result = await AccountToken.updateOne({ _id: token._id, tenantId: token.tenantId, usedAt: null }, { $set: { usedAt: new Date() } }, { session: db });
  if (result.modifiedCount !== 1) throw new AppError('TOKEN_INVALID');
}
