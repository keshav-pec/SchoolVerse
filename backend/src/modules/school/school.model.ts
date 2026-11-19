import { Schema, model } from 'mongoose';
import { SCHOOL_STATUSES, SETUP_STATUSES, type SchoolStatus, type SetupStatus } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * SCH-LOC-01 — the School Master (PRD §8): one canonical institution record per tenant in the MVP.
 * Locations inherit its operational defaults (timezone, currency, locale).
 */
export interface SchoolDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolCode: string;
  legalName: string;
  displayName: string;
  shortName: string | null;
  logoUrl: string | null;
  primaryEmail: string;
  primaryPhone: string;
  alternatePhone: string | null;
  websiteUrl: string | null;
  defaultTimezone: string;
  defaultCurrency: string;
  defaultLocale: string;
  status: SchoolStatus;
  setup: { status: SetupStatus; currentStep: number; completedAt: Date | null };
  /**
   * Bumped inside every transaction that can change which location is Primary.
   * Two such transactions on the same school then write-conflict, and the driver retries one
   * of them — so primary-location changes for a school are serialised.
   */
  locationsVersion: number;
}

const schoolSchema = new Schema<SchoolDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolCode: { type: String, required: true, uppercase: true, trim: true },
    legalName: { type: String, required: true, trim: true },
    displayName: { type: String, required: true, trim: true },
    shortName: { type: String, default: null },
    logoUrl: { type: String, default: null },
    primaryEmail: { type: String, required: true, lowercase: true, trim: true },
    primaryPhone: { type: String, required: true },
    alternatePhone: { type: String, default: null },
    websiteUrl: { type: String, default: null },
    defaultTimezone: { type: String, required: true },
    defaultCurrency: { type: String, required: true },
    defaultLocale: { type: String, required: true },
    status: { type: String, enum: SCHOOL_STATUSES, default: 'ACTIVE', required: true },
    setup: {
      status: { type: String, enum: SETUP_STATUSES, default: 'IN_PROGRESS' },
      currentStep: { type: Number, default: 1, min: 1 },
      completedAt: { type: Date, default: null },
    },
    locationsVersion: { type: Number, default: 0 },
    ...auditFields,
  },
  baseSchemaOptions('schools'),
);

// MVP: exactly one School Master per tenant. Drop this index to allow several schools later.
schoolSchema.index({ tenantId: 1 }, { unique: true });
// School codes are unique across the whole platform, not just per tenant.
schoolSchema.index({ schoolCode: 1 }, { unique: true });
schoolSchema.plugin(tenantScopePlugin);

export const School = model<SchoolDoc>('School', schoolSchema);
