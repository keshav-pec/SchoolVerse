import { Schema, model } from 'mongoose';
import { baseSchemaOptions, uuidPrimaryKey, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

export const ACCOUNT_TOKEN_PURPOSES = ['ACTIVATION', 'PASSWORD_RESET'] as const;
export type AccountTokenPurpose = (typeof ACCOUNT_TOKEN_PURPOSES)[number];

export interface AccountTokenDoc extends BaseDoc {
  tenantId: string;
  userId: string;
  purpose: AccountTokenPurpose;
  /** HMAC of the token. The token itself exists only in the link that was sent. */
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
}

const accountTokenSchema = new Schema<AccountTokenDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    userId: { type: String, required: true },
    purpose: { type: String, enum: ACCOUNT_TOKEN_PURPOSES, required: true },
    tokenHash: { type: String, required: true, unique: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  baseSchemaOptions('account_tokens'),
);
accountTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
accountTokenSchema.index({ tenantId: 1, userId: 1, purpose: 1 });
accountTokenSchema.plugin(tenantScopePlugin);

export const AccountToken = model<AccountTokenDoc>('AccountToken', accountTokenSchema);
