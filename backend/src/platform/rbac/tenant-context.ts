import type { Request } from 'express';
import type { AuditActor } from '../../modules/audit/audit.service';
import { AppError } from '../../core/errors';

/**
 * Helpers that make the tenant filter the default way to build a query.
 *   Model.findOne(scoped(req, { _id: id }))
 */
export function tenantIdOf(req: Request): string {
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  return req.auth.tenantId;
}

export function scoped<T extends Record<string, unknown>>(req: Request, filter?: T): T & { tenantId: string } {
  return { ...(filter ?? ({} as T)), tenantId: tenantIdOf(req) };
}

export function actorOf(req: Request): AuditActor {
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  return { userId: req.auth.userId, role: req.auth.role };
}
