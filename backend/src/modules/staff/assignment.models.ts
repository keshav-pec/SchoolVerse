import { Schema, model } from 'mongoose';
import {
  ACADEMIC_ASSIGNMENT_TYPES,
  ASSIGNMENT_END_REASONS,
  LOCATION_END_REASONS,
  type AcademicAssignmentType,
  type AssignmentEndReason,
  type LocationEndReason,
} from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * Effective-dated assignments (Module 3 "Effective dating"). Dates are `YYYY-MM-DD` in the school's time zone,
 * `effectiveTo` is the last day (inclusive). There is NO status column: it is computed (see `status.ts`).
 * Rows are never deleted. They end, or they are cancelled before they start.
 */
interface EffectiveDated {
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: Date | null;
  /** Set when an exit closed or cancelled the row, so cancelling the exit can put it back. */
  priorEffectiveTo: string | null;
}

const effectiveDatedFields = {
  effectiveFrom: { type: String, required: true },
  effectiveTo: { type: String, default: null },
  cancelledAt: { type: Date, default: null },
  priorEffectiveTo: { type: String, default: null },
} as const;

// ───────────────────────────────────────────────────────────── FSM-03 locations

export interface LocationAssignmentDoc extends BaseDoc, AuditFields, EffectiveDated {
  tenantId: string;
  employeeId: string;
  locationId: string;
  isPrimary: boolean;
  endReason: LocationEndReason | null;
}

const locationAssignmentSchema = new Schema<LocationAssignmentDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    isPrimary: { type: Boolean, required: true },
    ...effectiveDatedFields,
    endReason: { type: String, enum: [...LOCATION_END_REASONS, null], default: null },
    ...auditFields,
  },
  baseSchemaOptions('employee_location_assignments'),
);
locationAssignmentSchema.index({ tenantId: 1, employeeId: 1, effectiveFrom: 1 });
locationAssignmentSchema.index({ tenantId: 1, locationId: 1, effectiveTo: 1 });
locationAssignmentSchema.plugin(tenantScopePlugin);

export const LocationAssignment = model<LocationAssignmentDoc>('EmployeeLocationAssignment', locationAssignmentSchema);

// ───────────────────────────────────────────────────────────── FSM-04 faculty academic assignments

export interface AcademicAssignmentDoc extends BaseDoc, AuditFields, EffectiveDated {
  tenantId: string;
  employeeId: string;
  academicSessionId: string;
  locationId: string;
  classOfferingId: string;
  /** A `section_offerings` id (Module 2). */
  sectionId: string | null;
  subjectOfferingId: string | null;
  assignmentType: AcademicAssignmentType;
  endReason: AssignmentEndReason | null;
}

const academicAssignmentSchema = new Schema<AcademicAssignmentDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    academicSessionId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    classOfferingId: { type: String, required: true, immutable: true },
    sectionId: { type: String, default: null, immutable: true },
    subjectOfferingId: { type: String, default: null, immutable: true },
    assignmentType: { type: String, enum: ACADEMIC_ASSIGNMENT_TYPES, required: true, immutable: true },
    ...effectiveDatedFields,
    endReason: { type: String, enum: [...ASSIGNMENT_END_REASONS, null], default: null },
    ...auditFields,
  },
  baseSchemaOptions('faculty_academic_assignments'),
);
academicAssignmentSchema.index({ tenantId: 1, employeeId: 1 });
academicAssignmentSchema.index({ tenantId: 1, sectionId: 1 });
academicAssignmentSchema.index({ tenantId: 1, subjectOfferingId: 1 });
academicAssignmentSchema.index({ tenantId: 1, classOfferingId: 1 });
academicAssignmentSchema.index({ tenantId: 1, locationId: 1 });
academicAssignmentSchema.plugin(tenantScopePlugin);

export const AcademicAssignment = model<AcademicAssignmentDoc>('FacultyAcademicAssignment', academicAssignmentSchema);

// ───────────────────────────────────────────────────────────── FSM-05 staff responsibilities

export interface ResponsibilityDoc extends BaseDoc, AuditFields, EffectiveDated {
  tenantId: string;
  employeeId: string;
  locationId: string;
  responsibilityType: string;
  description: string | null;
  endReason: AssignmentEndReason | null;
}

const responsibilitySchema = new Schema<ResponsibilityDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    employeeId: { type: String, required: true, immutable: true },
    locationId: { type: String, required: true, immutable: true },
    responsibilityType: { type: String, required: true, trim: true, maxlength: 60, immutable: true },
    description: { type: String, default: null, maxlength: 200 },
    ...effectiveDatedFields,
    endReason: { type: String, enum: [...ASSIGNMENT_END_REASONS, null], default: null },
    ...auditFields,
  },
  baseSchemaOptions('staff_responsibility_assignments'),
);
responsibilitySchema.index({ tenantId: 1, employeeId: 1 });
responsibilitySchema.index({ tenantId: 1, locationId: 1 });
responsibilitySchema.plugin(tenantScopePlugin);

export const Responsibility = model<ResponsibilityDoc>('StaffResponsibilityAssignment', responsibilitySchema);
