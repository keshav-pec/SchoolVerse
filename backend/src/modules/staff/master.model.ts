import { Schema, model } from 'mongoose';
import { MASTER_STATUSES, type MasterStatus } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/** FSM-02 — departments and designations. Never deleted: an INACTIVE one stays on existing employees. */
export interface StaffMasterDoc extends BaseDoc, AuditFields {
  tenantId: string;
  code: string;
  name: string;
  status: MasterStatus;
}

function masterSchema(collection: string) {
  const schema = new Schema<StaffMasterDoc>(
    {
      ...uuidPrimaryKey,
      tenantId: { type: String, required: true, immutable: true },
      code: { type: String, required: true, uppercase: true, trim: true, immutable: true },
      name: { type: String, required: true, trim: true, maxlength: 80 },
      status: { type: String, enum: MASTER_STATUSES, default: 'ACTIVE', required: true },
      ...auditFields,
    },
    baseSchemaOptions(collection),
  );
  schema.index({ tenantId: 1, code: 1 }, { unique: true });
  schema.plugin(tenantScopePlugin);
  return schema;
}

export const Department = model<StaffMasterDoc>('Department', masterSchema('departments'));
export const Designation = model<StaffMasterDoc>('Designation', masterSchema('designations'));
