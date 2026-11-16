import type { SecurityEventType } from '@shared';
import { logger } from '../../core/logger';
import { SecurityEvent, type SecurityEventOutcome } from './security-event.model';

export interface SecurityEventInput {
  tenantId: string;
  type: SecurityEventType;
  actorUserId?: string | null;
  targetId?: string | null;
  ip?: string | null;
  outcome?: SecurityEventOutcome;
  /** IDs and categories only. */
  metadata?: Record<string, unknown>;
}

/**
 * Records something that looks like probing (PRD §28). It is written outside the caller's transaction on purpose:
 * the request is usually about to fail, and the event must survive that. A failure to write never changes the response.
 * Monitoring thresholds and alerting are deferred; events are stored and logged at `warn`.
 */
export async function recordSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    await SecurityEvent.create({
      tenantId: input.tenantId,
      type: input.type,
      actorUserId: input.actorUserId ?? null,
      targetId: input.targetId ?? null,
      ip: input.ip ?? null,
      outcome: input.outcome ?? 'DENIED',
      metadata: input.metadata ?? {},
    });
    logger.warn({ securityEvent: input.type, tenantId: input.tenantId, actorUserId: input.actorUserId ?? null, targetId: input.targetId ?? null }, 'security event');
  } catch (err) {
    logger.error({ err, securityEvent: input.type }, 'could not record security event');
  }
}
