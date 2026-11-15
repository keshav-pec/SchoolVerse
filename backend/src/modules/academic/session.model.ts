import { Schema, model } from 'mongoose';
import { SESSION_STATUSES, TERM_TYPES, type SessionStatus, type TermType } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

export interface SessionLocation {
  locationId: string;
  boardId: string;
  /** Pinned: publishing a newer rule version never changes an existing session. */
  boardRuleVersionId: string;
  affiliationNumber: string | null;
}

export interface SessionValidation {
  at: Date;
  errors: number;
  warnings: number;
  info: number;
}

/** AS-02 — one academic year (or any explicit date range) for the school. */
export interface AcademicSessionDoc extends BaseDoc, AuditFields {
  tenantId: string;
  schoolId: string;
  name: string;
  code: string;
  startDate: string;
  endDate: string;
  status: SessionStatus;
  locations: SessionLocation[];
  previousSessionId: string | null;
  lastValidation: SessionValidation | null;
  statusChangedAt: Date | null;
  statusChangedBy: string | null;
}

const sessionLocationSchema = new Schema<SessionLocation>(
  {
    locationId: { type: String, required: true },
    boardId: { type: String, required: true },
    boardRuleVersionId: { type: String, required: true },
    affiliationNumber: { type: String, default: null },
  },
  { _id: false },
);

const validationSchema = new Schema<SessionValidation>(
  {
    at: { type: Date, required: true },
    errors: { type: Number, default: 0 },
    warnings: { type: Number, default: 0 },
    info: { type: Number, default: 0 },
  },
  // `errors` is the contract's field name (lastValidation.errors); Mongoose only warns about it as a top-level path.
  { _id: false, suppressReservedKeysWarning: true },
);

const academicSessionSchema = new Schema<AcademicSessionDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true, immutable: true },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    status: { type: String, enum: SESSION_STATUSES, default: 'DRAFT', required: true },
    locations: { type: [sessionLocationSchema], default: [] },
    previousSessionId: { type: String, default: null },
    lastValidation: { type: validationSchema, default: null },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: String, default: null },
    ...auditFields,
  },
  baseSchemaOptions('academic_sessions'),
);
academicSessionSchema.index({ tenantId: 1, schoolId: 1, code: 1 }, { unique: true });
// One current (ACTIVE) session per school, enforced by the database even under concurrent activations.
academicSessionSchema.index(
  { schoolId: 1 },
  { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_session_per_school' },
);
academicSessionSchema.index({ tenantId: 1, schoolId: 1, status: 1 });
academicSessionSchema.plugin(tenantScopePlugin);

export const AcademicSession = model<AcademicSessionDoc>('AcademicSession', academicSessionSchema);

/** AS-12 — a term / semester / quarter inside a session, session-wide or for one location. */
export interface AcademicTermDoc extends BaseDoc, AuditFields {
  tenantId: string;
  sessionId: string;
  locationId: string | null;
  name: string;
  code: string;
  type: TermType;
  sequence: number;
  startDate: string;
  endDate: string;
}

const academicTermSchema = new Schema<AcademicTermDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    sessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, default: null },
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, uppercase: true, trim: true },
    type: { type: String, enum: TERM_TYPES, default: 'TERM', required: true },
    sequence: { type: Number, default: 1 },
    startDate: { type: String, required: true },
    endDate: { type: String, required: true },
    ...auditFields,
  },
  baseSchemaOptions('academic_terms'),
);
// `locationId: null` is the session-wide scope, and null participates in the unique key.
academicTermSchema.index({ tenantId: 1, sessionId: 1, locationId: 1, code: 1 }, { unique: true });
academicTermSchema.plugin(tenantScopePlugin);

export const AcademicTerm = model<AcademicTermDoc>('AcademicTerm', academicTermSchema);
