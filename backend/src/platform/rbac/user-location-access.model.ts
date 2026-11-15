import { Schema, model } from 'mongoose';
import { baseSchemaOptions, uuidPrimaryKey, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Future location-scoped access model (PRD §7 "Future location access model").
 * Created now so the contract exists; NOT enforced in Module 1 — the School Admin
 * can access every location in the school.
 */
export const LOCATION_ACCESS_TYPES = ['FULL', 'READ_ONLY'] as const;
export type LocationAccessType = (typeof LOCATION_ACCESS_TYPES)[number];

export interface UserLocationAccessDoc extends BaseDoc {
  tenantId: string;
  userId: string;
  locationId: string;
  accessType: LocationAccessType;
  grantedAt: Date;
  grantedBy: string;
}

const userLocationAccessSchema = new Schema<UserLocationAccessDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true },
    locationId: { type: String, required: true },
    accessType: { type: String, enum: LOCATION_ACCESS_TYPES, required: true },
    grantedAt: { type: Date, default: () => new Date() },
    grantedBy: { type: String, required: true },
  },
  baseSchemaOptions('user_location_access'),
);

userLocationAccessSchema.index({ tenantId: 1, userId: 1, locationId: 1 }, { unique: true });
userLocationAccessSchema.index({ tenantId: 1, locationId: 1 });
userLocationAccessSchema.plugin(tenantScopePlugin);

export const UserLocationAccess = model<UserLocationAccessDoc>('UserLocationAccess', userLocationAccessSchema);
