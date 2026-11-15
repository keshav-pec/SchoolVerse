import type { ClientSession } from 'mongoose';
import type { AuditChangeDTO, AuditEntityType } from '@shared';
import { actorFrom, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';

/**
 * Writes an audit event for something inside an academic session. `academicSessionId` goes into the
 * metadata so one session's whole history (`GET /audit?academicSessionId=`) can be read as a timeline.
 */
export function recordAcademicAudit(
  ctx: ServiceContext,
  db: ClientSession,
  event: {
    entityType: AuditEntityType;
    entityId: string;
    action: string;
    changes: AuditChangeDTO[];
    academicSessionId: string;
    metadata?: Record<string, unknown>;
  },
) {
  return recordAudit(
    {
      tenantId: ctx.tenantId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      actor: actorFrom(ctx),
      changes: event.changes,
      metadata: { academicSessionId: event.academicSessionId, ...event.metadata },
      requestId: ctx.requestId,
    },
    db,
  );
}
