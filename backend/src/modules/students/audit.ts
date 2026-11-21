import type { ClientSession } from 'mongoose';
import type { AuditChangeDTO, AuditEntityType } from '@shared';
import { actorFrom, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit, type AuditActor } from '../audit/audit.service';

export interface StudentAuditScope {
  tenantId: string;
  actor: AuditActor;
  requestId: string | null;
}

export function studentScope(ctx: ServiceContext): StudentAuditScope {
  return { tenantId: ctx.tenantId, actor: actorFrom(ctx), requestId: ctx.requestId };
}

export function systemScope(tenantId: string): StudentAuditScope {
  return { tenantId, actor: 'SYSTEM', requestId: null };
}

/**
 * Writes an audit event inside the caller's transaction. `studentId` goes into the metadata, so one student's whole history
 * (`GET /students/:id/history`) can be read whatever entity changed. Guardian contact values are written as `[redacted]`
 * by the callers (use `classifiedDiff` for any diff that can hold personal fields).
 */
export function recordStudentAudit(
  scope: StudentAuditScope | ServiceContext,
  db: ClientSession,
  event: {
    entityType: AuditEntityType;
    entityId: string;
    action: string;
    changes?: AuditChangeDTO[];
    studentId: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  const s: StudentAuditScope = 'actor' in scope ? scope : studentScope(scope);
  return recordAudit(
    {
      tenantId: s.tenantId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      actor: s.actor,
      changes: event.changes ?? [],
      metadata: { ...(event.studentId ? { studentId: event.studentId } : {}), ...event.metadata },
      requestId: s.requestId,
    },
    db,
  );
}
