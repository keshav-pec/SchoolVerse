import type { ClientSession } from 'mongoose';
import type { AuditChangeDTO, AuditEntityType, SpaceEventType } from '@shared';
import { logger } from '../../core/logger';
import { actorFrom, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { OutboxEvent } from './space.models';

/** Every change writes its audit row and its domain event in the caller's transaction, so they commit or roll back together. */

export function recordSpaceAudit(
  ctx: ServiceContext,
  db: ClientSession,
  event: { entityType: AuditEntityType; entityId: string; action: string; changes?: AuditChangeDTO[]; locationId?: string | null; metadata?: Record<string, unknown> },
) {
  return recordAudit(
    {
      tenantId: ctx.tenantId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      actor: actorFrom(ctx),
      changes: event.changes ?? [],
      metadata: { ...(event.locationId ? { locationId: event.locationId } : {}), ...event.metadata },
      requestId: ctx.requestId,
    },
    db,
  );
}

/** Writes a domain event to `outbox_events` (there is no broker yet). The payload carries ids only. */
export async function emitSpaceEvent(db: ClientSession, tenantId: string, type: SpaceEventType, payload: Record<string, unknown>) {
  await OutboxEvent.create([{ tenantId, type, payload }], { session: db });
  logger.debug({ event: type, tenantId }, 'space event');
}
