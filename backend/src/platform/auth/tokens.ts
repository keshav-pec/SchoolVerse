import { createHmac, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { ROLES, type Role } from '@shared';
import { env } from '../../config/env';
import { AppError } from '../../core/errors';

const ISSUER = 'schoolverse-api';
const AUDIENCE = 'schoolverse-web';

export interface AccessTokenClaims {
  sub: string; // userId
  tid: string; // tenantId
  role: Role;
  sid: string; // sessionId
}

export function signAccessToken(claims: AccessTokenClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: `${env.ACCESS_TOKEN_TTL_MINUTES}m`,
    issuer: ISSUER,
    audience: AUDIENCE,
  });
}

export function verifyAccessToken(token: string): AccessTokenClaims {
  try {
    const payload = jwt.verify(token, env.JWT_ACCESS_SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (
      typeof payload !== 'object' ||
      typeof payload.sub !== 'string' ||
      typeof payload.tid !== 'string' ||
      typeof payload.sid !== 'string' ||
      !ROLES.includes(payload.role)
    ) {
      throw new AppError('UNAUTHENTICATED');
    }
    return { sub: payload.sub, tid: payload.tid, role: payload.role, sid: payload.sid };
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) throw new AppError('SESSION_EXPIRED');
    if (err instanceof AppError) throw err;
    throw new AppError('UNAUTHENTICATED');
  }
}

/** High-entropy opaque token (refresh tokens). */
export function generateOpaqueToken(): string {
  return randomBytes(48).toString('base64url');
}

/** Tokens are never stored in plain text — only an HMAC keyed with a server secret. */
export function hashToken(token: string): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');
}
