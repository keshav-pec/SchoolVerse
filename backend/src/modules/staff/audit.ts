import type { ClientSession } from 'mongoose';
import { isAuditRedacted, REDACTED, type AuditChangeDTO, type AuditEntityType, type ClassifiedEntity } from '@shared';
import { actorFrom, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit, type AuditActor } from '../audit/audit.service';
import { diffFields } from '../audit/diff';

/** Who is acting, for the audit row. The hourly job acts as `SYSTEM`. */
export interface StaffAuditScope {
  tenantId: string;
  actor: AuditActor;
  requestId: string | null;
}

export function auditScopeOf(ctx: ServiceContext): StaffAuditScope {
  return { tenantId: ctx.tenantId, actor: actorFrom(ctx), requestId: ctx.requestId };
}

export function systemScope(tenantId: string): StaffAuditScope {
  return { tenantId, actor: 'SYSTEM', requestId: null };
}

/**
 * Writes an audit event for something about one employee. `employeeId` goes into the metadata, so one employee's whole
 * history (`GET /employees/:id/history`) can be read as a timeline whatever entity changed.
 */
export function recordStaffAudit(
  scope: StaffAuditScope,
  db: ClientSession,
  event: {
    entityType: AuditEntityType;
    entityId: string;
    action: string;
    changes?: AuditChangeDTO[];
    employeeId: string | null;
    metadata?: Record<string, unknown>;
  },
) {
  return recordAudit(
    {
      tenantId: scope.tenantId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      actor: scope.actor,
      changes: event.changes ?? [],
      metadata: { ...(event.employeeId ? { employeeId: event.employeeId } : {}), ...event.metadata },
      requestId: scope.requestId,
    },
    db,
  );
}

/**
 * Field diff for a classified entity. The audit trail records THAT a personal or restricted field changed, never its value:
 * those values are written as `[redacted]` (SEC-04).
 */
export function classifiedDiff(entity: ClassifiedEntity, before: unknown, after: unknown, fields: readonly string[]): AuditChangeDTO[] {
  return diffFields(before, after, fields).map((change) =>
    isAuditRedacted(entity, change.field) ? { field: change.field, from: REDACTED, to: REDACTED } : change,
  );
}
