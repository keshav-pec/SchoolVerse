import { Schema, model } from 'mongoose';
import { baseSchemaOptions, uuidPrimaryKey, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

export const SESSION_REVOKE_REASONS = ['ROTATED', 'LOGOUT', 'REUSE_DETECTED'] as const;
export type SessionRevokeReason = (typeof SESSION_REVOKE_REASONS)[number];

export interface SessionDoc extends BaseDoc {
  tenantId: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedReason: SessionRevokeReason | null;
  replacedBySessionId: string | null;
  userAgent: string | null;
  ip: string | null;
  lastUsedAt: Date;
}

/** One refresh-token session. Tokens are stored only as HMAC hashes. */
const sessionSchema = new Schema<SessionDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    familyId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    revokedReason: { type: String, enum: [...SESSION_REVOKE_REASONS, null], default: null },
    replacedBySessionId: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 400 },
    ip: { type: String, default: null },
    lastUsedAt: { type: Date, default: () => new Date() },
  },
  baseSchemaOptions('auth_sessions'),
);

// Expired sessions are purged automatically by MongoDB.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
sessionSchema.plugin(tenantScopePlugin);

export const Session = model<SessionDoc>('Session', sessionSchema);
