import type { ClientSession } from 'mongoose';
import type { AuditChangeDTO, AuditEntityType } from '@shared';
import { actorFrom, type ServiceContext } from '../../platform/rbac/tenant-context';
import { recordAudit } from '../audit/audit.service';
import { OutboxEvent } from '../spaces/space.models';

/** Every change writes its audit row (and any domain event) in the caller's transaction, so they commit or roll back together. */

export function recordTimetableAudit(
  ctx: ServiceContext,
  db: ClientSession,
  event: { entityType: AuditEntityType; entityId: string; action: string; changes?: AuditChangeDTO[]; planId?: string; locationId?: string; metadata?: Record<string, unknown> },
) {
  return recordAudit(
    {
      tenantId: ctx.tenantId,
      entityType: event.entityType,
      entityId: event.entityId,
      action: event.action,
      actor: actorFrom(ctx),
      changes: event.changes ?? [],
      metadata: { ...(event.planId ? { planId: event.planId } : {}), ...(event.locationId ? { locationId: event.locationId } : {}), ...event.metadata },
      requestId: ctx.requestId,
    },
    db,
  );
}

/** Domain events go to `outbox_events`. There is no message broker yet; the payload carries ids only. */
export async function emitTimetableEvent(db: ClientSession, tenantId: string, type: string, payload: Record<string, unknown>) {
  await OutboxEvent.create([{ tenantId, type, payload }], { session: db });
}
