import type { RequestHandler } from 'express';
import type { Permission } from '@shared';
import { AppError } from '../../core/errors';

/**
 * Server-side authorization (PRD §7). Hiding a button in the UI is NOT an authorization control —
 * every protected route must declare the permissions it needs here.
 */
export function requirePermission(...required: Permission[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.auth) throw new AppError('UNAUTHENTICATED');
    const missing = required.filter((p) => !req.auth!.permissions.includes(p));
    if (missing.length > 0) throw new AppError('FORBIDDEN', undefined, { required: missing });
    next();
  };
}
