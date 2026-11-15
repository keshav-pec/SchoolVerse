import { Schema, model } from 'mongoose';
import { ROLES, USER_STATUSES, type Role, type UserStatus } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

export interface UserDoc extends BaseDoc, AuditFields {
  tenantId: string;
  email: string;
  passwordHash: string;
  fullName: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: Date | null;
  passwordChangedAt: Date | null;
}

const userSchema = new Schema<UserDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    // Globally unique so people can sign in with just email + password.
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    fullName: { type: String, required: true, trim: true, maxlength: 100 },
    role: { type: String, enum: ROLES, required: true },
    status: { type: String, enum: USER_STATUSES, default: 'ACTIVE', required: true },
    lastLoginAt: { type: Date, default: null },
    passwordChangedAt: { type: Date, default: null },
    ...auditFields,
  },
  baseSchemaOptions('users'),
);

userSchema.index({ tenantId: 1, role: 1 });
userSchema.plugin(tenantScopePlugin);

export const User = model<UserDoc>('User', userSchema);
