import { Schema, model } from 'mongoose';
import { SECURITY_EVENT_TYPES, type SecurityEventType } from '@shared';
import { baseSchemaOptions, uuidPrimaryKey } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

export const SECURITY_EVENT_OUTCOMES = ['DENIED', 'FAILED', 'SUCCESS'] as const;
export type SecurityEventOutcome = (typeof SECURITY_EVENT_OUTCOMES)[number];

/** Seconds a security event is kept (180 days). */
export const SECURITY_EVENT_TTL_SECONDS = 180 * 24 * 60 * 60;

export interface SecurityEventDoc {
  _id: string;
  tenantId: string;
  type: SecurityEventType;
  actorUserId: string | null;
  targetId: string | null;
  ip: string | null;
  outcome: SecurityEventOutcome;
  /** IDs and categories only. Never a name, an email or a value. */
  metadata: Record<string, unknown>;
  createdAt: Date;
}

const securityEventSchema = new Schema<SecurityEventDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    type: { type: String, enum: SECURITY_EVENT_TYPES, required: true },
    actorUserId: { type: String, default: null },
    targetId: { type: String, default: null },
    ip: { type: String, default: null },
    outcome: { type: String, enum: SECURITY_EVENT_OUTCOMES, required: true },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { ...baseSchemaOptions('security_events'), timestamps: { createdAt: true, updatedAt: false }, minimize: false },
);
securityEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: SECURITY_EVENT_TTL_SECONDS });
securityEventSchema.index({ tenantId: 1, type: 1, createdAt: -1 });
securityEventSchema.plugin(tenantScopePlugin);

export const SecurityEvent = model<SecurityEventDoc>('SecurityEvent', securityEventSchema);
