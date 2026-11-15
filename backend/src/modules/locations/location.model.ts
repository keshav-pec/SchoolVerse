import { Schema, model } from 'mongoose';
import { LOCATION_STATUSES, LOCATION_TYPES, type LocationStatus, type LocationType } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * SCH-LOC-03/04/05 — `school_locations` (PRD §9). The single source of truth for every campus,
 * branch or administrative location. Downstream modules store `locationId`, never names or codes.
 *
 * The PRD's `school_location_addresses` table is embedded as `address` (always read with the
 * location, strictly 1:1).
 */
export interface LocationAddress {
  line1: string | null;
  line2: string | null;
  locality: string | null;
  city: string | null;
  district: string | null;
  state: string | null;
  postalCode: string | null;
  /** ISO 3166-1 alpha-2 country code. */
  country: string;
}

export interface LocationDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  locationCode: string;
  displayName: string;
  officialName: string | null;
  locationType: LocationType;
  isPrimary: boolean;
  status: LocationStatus;
  openingDate: string | null;
  /** `null` = inherit from the school. */
  timezoneOverride: string | null;
  currencyOverride: string | null;
  localeOverride: string | null;
  email: string | null;
  phone: string | null;
  alternatePhone: string | null;
  websiteUrl: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string | null;
  address: LocationAddress;
  statusChangedAt: Date | null;
  statusChangedBy: string | null;
}

const addressSchema = new Schema<LocationAddress>(
  {
    line1: { type: String, default: null },
    line2: { type: String, default: null },
    locality: { type: String, default: null },
    city: { type: String, default: null },
    district: { type: String, default: null },
    state: { type: String, default: null },
    postalCode: { type: String, default: null },
    country: { type: String, default: 'IN', uppercase: true },
  },
  { _id: false },
);

const locationSchema = new Schema<LocationDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    locationCode: { type: String, required: true, uppercase: true, trim: true, maxlength: 10 },
    displayName: { type: String, required: true, trim: true },
    officialName: { type: String, default: null },
    locationType: { type: String, enum: LOCATION_TYPES, required: true },
    isPrimary: { type: Boolean, default: false, required: true },
    status: { type: String, enum: LOCATION_STATUSES, default: 'DRAFT', required: true },
    openingDate: { type: String, default: null },
    timezoneOverride: { type: String, default: null },
    currencyOverride: { type: String, default: null },
    localeOverride: { type: String, default: null },
    email: { type: String, default: null },
    phone: { type: String, default: null },
    alternatePhone: { type: String, default: null },
    websiteUrl: { type: String, default: null },
    latitude: { type: Number, default: null, min: -90, max: 90 },
    longitude: { type: Number, default: null, min: -180, max: 180 },
    notes: { type: String, default: null },
    address: { type: addressSchema, default: () => ({}) },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: String, default: null },
    ...auditFields,
  },
  baseSchemaOptions('school_locations'),
);

// PRD §15 — UNIQUE (school_id, location_code). Codes are stored upper-cased, so this is case-insensitive.
// Archived locations keep their code reserved so historical reports never become ambiguous.
locationSchema.index({ tenantId: 1, schoolId: 1, locationCode: 1 }, { unique: true });
// PRD §10 — at most one Primary per school, enforced by the database even under races.
locationSchema.index(
  { schoolId: 1 },
  { unique: true, partialFilterExpression: { isPrimary: true }, name: 'one_primary_per_school' },
);
// List screen: filter by status inside a school (also serves school FK lookups).
locationSchema.index({ tenantId: 1, schoolId: 1, status: 1 });
locationSchema.plugin(tenantScopePlugin);

export const Location = model<LocationDoc>('Location', locationSchema);
