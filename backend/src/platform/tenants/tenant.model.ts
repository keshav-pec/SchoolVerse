import { Schema, model } from 'mongoose';
import { TENANT_STATUSES, type TenantStatus } from '@shared';
import { baseSchemaOptions, uuidPrimaryKey, type BaseDoc } from '../../db/plugins/base';

export interface TenantDoc extends BaseDoc {
  name: string;
  slug: string;
  status: TenantStatus;
  createdBy: string | null;
}

/**
 * Tenant = customer account boundary. It is the root of isolation, so it is NOT tenant-scoped itself.
 * Only platform code (signup, auth) reads it directly.
 */
const tenantSchema = new Schema<TenantDoc>(
  {
    ...uuidPrimaryKey,
    name: { type: String, required: true, trim: true, maxlength: 120 },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    status: { type: String, enum: TENANT_STATUSES, default: 'ACTIVE', required: true },
    createdBy: { type: String, default: null },
  },
  baseSchemaOptions('tenants'),
);

export const Tenant = model<TenantDoc>('Tenant', tenantSchema);
