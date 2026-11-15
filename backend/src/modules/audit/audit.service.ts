import type { ClientSession } from 'mongoose';
import type { AuditChangeDTO, AuditEventDTO, Role } from '@shared';
import { AuditEvent, type AuditEventDoc } from './audit.model';

export type AuditActor = { userId: string; role: Role } | 'SYSTEM';

export interface RecordAuditInput {
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actor: AuditActor;
  changes?: AuditChangeDTO[];
  metadata?: Record<string, unknown>;
  requestId?: string | null;
}

/**
 * Write an audit event. Pass the caller's `session` so the audit row commits or rolls back
 * together with the change it describes.
 */
export async function recordAudit(input: RecordAuditInput, session?: ClientSession) {
  const actor = input.actor === 'SYSTEM' ? { actorId: null, actorRole: 'SYSTEM' } : { actorId: input.actor.userId, actorRole: input.actor.role };
  const [event] = await AuditEvent.create(
    [
      {
        tenantId: input.tenantId,
        entityType: input.entityType,
        entityId: input.entityId,
        action: input.action,
        ...actor,
        changes: input.changes ?? [],
        metadata: input.metadata ?? {},
        requestId: input.requestId ?? null,
      },
    ],
    { session },
  );
  return event!;
}

export function toAuditEventDTO(doc: AuditEventDoc, actorName?: string | null): AuditEventDTO {
  return {
    auditEventId: doc._id,
    entityType: doc.entityType,
    entityId: doc.entityId,
    action: doc.action,
    actor: { userId: doc.actorId ?? null, role: doc.actorRole as AuditEventDTO['actor']['role'], name: actorName ?? null },
    changes: (doc.changes ?? []).map((c) => ({ field: c.field, from: c.from ?? null, to: c.to ?? null })),
    metadata: (doc.metadata as Record<string, unknown>) ?? {},
    occurredAt: new Date(doc.occurredAt).toISOString(),
    requestId: doc.requestId ?? null,
  };
}
