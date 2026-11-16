import { Schema, model } from 'mongoose';
import { GOVERNMENT_ID_TYPES, type GovernmentIdType } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

export interface GovernmentIdEntry {
  type: GovernmentIdType;
  /** AES-256-GCM, `kid:iv:tag:ciphertext`. */
  valueEnc: string;
  /** Kept so the value can be masked without decrypting it. */
  last4: string;
}

export interface BankEntry {
  accountHolderName: string;
  accountNumberEnc: string;
  last4: string;
  ifsc: string;
  bankName: string;
}

/**
 * Government IDs and bank details, one row per person. Every sensitive value is encrypted field by field. Nothing outside
 * `restricted-data.ts` and the services that call it reads this collection, and no list or profile API selects it.
 * Students and parents reuse it later: it knows only about a `personId`.
 */
export interface RestrictedPersonDataDoc extends BaseDoc, AuditFields {
  tenantId: string;
  personId: string;
  governmentIds: GovernmentIdEntry[];
  bank: BankEntry | null;
}

const governmentIdSchema = new Schema<GovernmentIdEntry>(
  {
    type: { type: String, enum: GOVERNMENT_ID_TYPES, required: true },
    valueEnc: { type: String, required: true },
    last4: { type: String, required: true, maxlength: 4 },
  },
  { _id: false },
);

const bankSchema = new Schema<BankEntry>(
  {
    accountHolderName: { type: String, required: true },
    accountNumberEnc: { type: String, required: true },
    last4: { type: String, required: true, maxlength: 4 },
    ifsc: { type: String, required: true },
    bankName: { type: String, required: true },
  },
  { _id: false },
);

const restrictedSchema = new Schema<RestrictedPersonDataDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    personId: { type: String, required: true, immutable: true },
    governmentIds: { type: [governmentIdSchema], default: [] },
    bank: { type: bankSchema, default: null },
    ...auditFields,
  },
  baseSchemaOptions('restricted_person_data'),
);
restrictedSchema.index({ tenantId: 1, personId: 1 }, { unique: true });
restrictedSchema.plugin(tenantScopePlugin);

export const RestrictedPersonData = model<RestrictedPersonDataDoc>('RestrictedPersonData', restrictedSchema);
