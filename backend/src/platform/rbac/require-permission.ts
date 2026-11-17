import type { Request, RequestHandler } from 'express';
import type { Permission } from '@shared';
import { AppError } from '../../core/errors';

/**
 * Server-side authorization (PRD §7). Hiding a button in the UI is NOT an authorization control —
 * every protected route must declare the permissions it needs here.
 */
export function requirePermission(...required: Permission[]): RequestHandler {
  const handler: RequestHandler = (req, _res, next) => {
    assertPermissions(req, ...required);
    next();
  };
  return Object.assign(handler, { permissions: required }); // read by the API docs generator
}

/** Imperative form for permissions that depend on the request body (e.g. "create AND set primary"). */
export function assertPermissions(req: Request, ...required: Permission[]) {
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  const missing = required.filter((p) => !req.auth!.permissions.includes(p));
  if (missing.length > 0) throw new AppError('FORBIDDEN', undefined, { required: missing });
}
