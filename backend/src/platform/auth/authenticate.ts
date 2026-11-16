import type { RequestHandler } from 'express';
import { permissionsFor } from '@shared';
import { AppError } from '../../core/errors';
import type { UserDoc } from '../users/user.model';
import { User } from '../users/user.model';
import { ACCESS_COOKIE } from './cookies';
import { Session } from './session.model';
import { verifyAccessToken } from './tokens';

function extractToken(req: Parameters<RequestHandler>[0]): string | undefined {
  const cookieToken = req.cookies?.[ACCESS_COOKIE] as string | undefined;
  if (cookieToken) return cookieToken;
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return undefined;
}

/**
 * Verifies the access token and attaches `req.auth`.
 * The tenant comes ONLY from the verified token — never from the body, query or params.
 * Role and status are re-read from the database so changes apply immediately.
 */
export const authenticate: RequestHandler = async (req, _res, next) => {
  const token = extractToken(req);
  if (!token) throw new AppError('UNAUTHENTICATED');

  const claims = verifyAccessToken(token);

  const [user, session] = await Promise.all([
    User.findOne({ _id: claims.sub, tenantId: claims.tid }).lean<UserDoc>(),
    Session.findOne({ _id: claims.sid, tenantId: claims.tid }).select('revokedAt stepUpAt').lean<{ revokedAt: Date | null; stepUpAt: Date | null }>(),
  ]);

  if (!user || !session || session.revokedAt) throw new AppError('SESSION_EXPIRED');
  if (user.status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED');
  if (user.status !== 'ACTIVE') throw new AppError('ACCOUNT_DISABLED');

  req.auth = {
    userId: user._id,
    tenantId: user.tenantId,
    role: user.role,
    permissions: permissionsFor(user.role),
    sessionId: claims.sid,
    stepUpAt: session.stepUpAt ?? null,
  };
  next();
};
