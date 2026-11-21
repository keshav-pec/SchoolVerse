import { Schema, model } from 'mongoose';
import { GENDERS, PERSON_STATUSES, type Gender, type PersonStatus } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

export interface PersonAddress {
  line1: string | null;
  line2: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  country: string | null;
}

export interface EmergencyContact {
  name: string;
  relation: string;
  phone: string;
}

/**
 * FSM-01 — `people`: who someone is, once. Employment lives on `employees`, a login (optional) on `users`.
 * Students and guardians (Module 4) use this same collection: a person is a student or a guardian because of the rows that point
 * to them (`students`, `student_guardian_links`), so a teacher who is also a parent is still one person.
 * No uniqueness on name or date of birth: different people share them.
 */
export interface PersonDoc extends BaseDoc, AuditFields {
  tenantId: string;
  legalFirstName: string;
  legalMiddleName: string | null;
  legalLastName: string;
  preferredName: string | null;
  /** Optional. Set from the student screens; staff screens do not use it yet. */
  gender: Gender | null;
  dateOfBirth: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
  personalEmail: string | null;
  personalPhone: string | null;
  address: PersonAddress | null;
  emergencyContact: EmergencyContact | null;
  profilePhotoKey: string | null;
  status: PersonStatus;
}

const addressSchema = new Schema<PersonAddress>(
  {
    line1: { type: String, default: null },
    line2: { type: String, default: null },
    city: { type: String, default: null },
    state: { type: String, default: null },
    postalCode: { type: String, default: null },
    country: { type: String, default: null },
  },
  { _id: false },
);

const emergencyContactSchema = new Schema<EmergencyContact>(
  {
    name: { type: String, required: true },
    relation: { type: String, required: true },
    phone: { type: String, required: true },
  },
  { _id: false },
);

const personSchema = new Schema<PersonDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    legalFirstName: { type: String, required: true, trim: true, maxlength: 100 },
    legalMiddleName: { type: String, default: null, trim: true, maxlength: 100 },
    // May be empty: a student with a single-word name has no last name. Staff screens still require one.
    legalLastName: { type: String, default: '', trim: true, maxlength: 100 },
    preferredName: { type: String, default: null, trim: true, maxlength: 100 },
    gender: { type: String, enum: [...GENDERS, null], default: null },
    dateOfBirth: { type: String, default: null },
    primaryEmail: { type: String, default: null, lowercase: true, trim: true },
    primaryPhone: { type: String, default: null },
    personalEmail: { type: String, default: null, lowercase: true, trim: true },
    personalPhone: { type: String, default: null },
    address: { type: addressSchema, default: null },
    emergencyContact: { type: emergencyContactSchema, default: null },
    profilePhotoKey: { type: String, default: null },
    status: { type: String, enum: PERSON_STATUSES, default: 'ACTIVE', required: true },
    ...auditFields,
  },
  baseSchemaOptions('people'),
);
personSchema.index({ tenantId: 1, legalLastName: 1, legalFirstName: 1 });
personSchema.index({ tenantId: 1, dateOfBirth: 1 });
personSchema.index({ tenantId: 1, primaryPhone: 1 });
personSchema.index({ tenantId: 1, primaryEmail: 1 });
personSchema.plugin(tenantScopePlugin);

export const Person = model<PersonDoc>('Person', personSchema);
