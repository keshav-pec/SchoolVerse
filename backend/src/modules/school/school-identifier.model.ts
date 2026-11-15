import { Schema, model } from 'mongoose';
import { IDENTIFIER_STATUSES, type IdentifierStatus } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Official identifiers (PRD §8): affiliation number, registration number, UDISE+, trust registration…
 * Modelled as flexible rows so the ERP is never hard-coded to one board or regulator.
 */
export interface SchoolIdentifierDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  identifierType: string;
  identifierValue: string;
  issuingAuthority: string | null;
  /** Calendar dates stored as `YYYY-MM-DD` so they never shift across time zones. */
  issueDate: string | null;
  expiryDate: string | null;
  documentUrl: string | null;
  status: IdentifierStatus;
}

const schoolIdentifierSchema = new Schema<SchoolIdentifierDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    identifierType: { type: String, required: true, trim: true },
    identifierValue: { type: String, required: true, trim: true },
    issuingAuthority: { type: String, default: null },
    issueDate: { type: String, default: null },
    expiryDate: { type: String, default: null },
    documentUrl: { type: String, default: null },
    status: { type: String, enum: IDENTIFIER_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('school_identifiers'),
);

schoolIdentifierSchema.index({ tenantId: 1, schoolId: 1, identifierType: 1 });
schoolIdentifierSchema.plugin(tenantScopePlugin);

export const SchoolIdentifier = model<SchoolIdentifierDoc>('SchoolIdentifier', schoolIdentifierSchema);
