import { Schema, model, type MongooseDefaultQueryMiddleware } from 'mongoose';
import { AppError } from '../../core/errors';
import { baseSchemaOptions, uuidPrimaryKey } from '../../db/plugins/base';

export interface AuditChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface AuditEventDoc {
  _id: string;
  tenantId: string;
  entityType: string;
  entityId: string;
  action: string;
  actorId: string | null;
  actorRole: string;
  changes: AuditChange[];
  metadata: Record<string, unknown>;
  occurredAt: Date;
  requestId: string | null;
}
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * SCH-LOC-10 — append-only audit trail.
 * Captures actor, timestamp, previous and new values for configuration-sensitive fields.
 */
const changeSchema = new Schema<AuditChange>(
  {
    field: { type: String, required: true },
    from: { type: Schema.Types.Mixed, default: null },
    to: { type: Schema.Types.Mixed, default: null },
  },
  { _id: false },
);

const auditEventSchema = new Schema<AuditEventDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    entityType: { type: String, required: true },
    entityId: { type: String, required: true },
    action: { type: String, required: true },
    actorId: { type: String, default: null },
    actorRole: { type: String, required: true },
    changes: { type: [changeSchema], default: [] },
    metadata: { type: Schema.Types.Mixed, default: {} },
    occurredAt: { type: Date, default: () => new Date(), immutable: true },
    requestId: { type: String, default: null },
  },
  { ...baseSchemaOptions('audit_events'), timestamps: false, minimize: false },
);

auditEventSchema.index({ tenantId: 1, entityType: 1, entityId: 1, occurredAt: -1 });
auditEventSchema.index({ tenantId: 1, occurredAt: -1 });
auditEventSchema.plugin(tenantScopePlugin);

// Append-only: audit rows can never be edited or removed through the application.
const MUTATIONS: MongooseDefaultQueryMiddleware[] = ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'findOneAndReplace', 'deleteOne', 'deleteMany', 'findOneAndDelete'];
auditEventSchema.pre(MUTATIONS, function () {
  throw new AppError('FORBIDDEN', 'Audit events are append-only');
});

export const AuditEvent = model<AuditEventDoc>('AuditEvent', auditEventSchema);
