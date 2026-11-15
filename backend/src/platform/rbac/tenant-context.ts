import type { Request } from 'express';
import type { Permission, Role } from '@shared';
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

/**
 * Everything a domain service needs to know about the caller. Services never read `req`,
 * so they can be reused by future in-process callers (e.g. the setup wizard, master APIs).
 */
export interface ServiceContext {
  tenantId: string;
  userId: string;
  role: Role;
  permissions: readonly Permission[];
  requestId: string | null;
}

export function contextOf(req: Request): ServiceContext {
  if (!req.auth) throw new AppError('UNAUTHENTICATED');
  return {
    tenantId: req.auth.tenantId,
    userId: req.auth.userId,
    role: req.auth.role,
    permissions: req.auth.permissions,
    requestId: req.requestId ?? null,
  };
}

export function actorFrom(ctx: ServiceContext): AuditActor {
  return { userId: ctx.userId, role: ctx.role };
}

export function can(ctx: ServiceContext, permission: Permission): boolean {
  return ctx.permissions.includes(permission);
}
