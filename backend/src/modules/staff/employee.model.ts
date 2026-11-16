import { Schema, model } from 'mongoose';
import { EMPLOYEE_CATEGORIES, EMPLOYEE_STATUSES, EXIT_REASON_CATEGORIES, type EmployeeCategory, type EmployeeStatus, type ExitReasonCategory } from '@shared';
import { auditFields, baseSchemaOptions, uuidPrimaryKey, type AuditFields, type BaseDoc } from '../../db/plugins/base';
import { tenantScopePlugin } from '../../db/plugins/tenant-scope';

/**
 * FSM-01 — `employees`: one employment of one person at the school. A rehire is a NEW row for the same person,
 * so the old employment, its assignments and its history stay exactly as they were.
 */
export interface EmployeeDoc extends BaseDoc, AuditFields {
  tenantId: string;
  personId: string;
  schoolId: string;
  employeeCode: string;
  employeeCategory: EmployeeCategory;
  employmentType: string | null;
  joiningDate: string;
  confirmationDate: string | null;
  departmentId: string;
  designationId: string;
  reportingManagerId: string | null;
  officialEmail: string | null;
  officialPhone: string | null;
  status: EmployeeStatus;
  exitDate: string | null;
  exitReasonCategory: ExitReasonCategory | null;
  exitNote: string | null;
  statusChangedAt: Date | null;
  statusChangedBy: string | null;
}

/** Statuses of a live employment: everything except EXITED. */
export const LIVE_EMPLOYEE_STATUSES = EMPLOYEE_STATUSES.filter((s) => s !== 'EXITED');

const employeeSchema = new Schema<EmployeeDoc>(
  {
    ...uuidPrimaryKey,
    tenantId: { type: String, required: true, immutable: true },
    personId: { type: String, required: true, immutable: true },
    schoolId: { type: String, required: true, immutable: true },
    employeeCode: { type: String, required: true, uppercase: true, trim: true },
    employeeCategory: { type: String, enum: EMPLOYEE_CATEGORIES, required: true },
    employmentType: { type: String, default: null, trim: true, maxlength: 60 },
    joiningDate: { type: String, required: true },
    confirmationDate: { type: String, default: null },
    departmentId: { type: String, required: true },
    designationId: { type: String, required: true },
    reportingManagerId: { type: String, default: null },
    officialEmail: { type: String, default: null, lowercase: true, trim: true },
    officialPhone: { type: String, default: null },
    status: { type: String, enum: EMPLOYEE_STATUSES, default: 'ONBOARDING', required: true },
    exitDate: { type: String, default: null },
    exitReasonCategory: { type: String, enum: [...EXIT_REASON_CATEGORIES, null], default: null },
    exitNote: { type: String, default: null, maxlength: 500 },
    statusChangedAt: { type: Date, default: null },
    statusChangedBy: { type: String, default: null },
    ...auditFields,
  },
  baseSchemaOptions('employees'),
);

employeeSchema.index({ tenantId: 1, schoolId: 1, employeeCode: 1 }, { unique: true });
// One live employment per person; once EXITED the person can be hired again.
employeeSchema.index(
  { tenantId: 1, personId: 1 },
  { unique: true, partialFilterExpression: { status: { $in: LIVE_EMPLOYEE_STATUSES } }, name: 'one_live_employment_per_person' },
);
employeeSchema.index({ tenantId: 1, status: 1 });
employeeSchema.index({ tenantId: 1, departmentId: 1 });
employeeSchema.index({ tenantId: 1, designationId: 1 });
employeeSchema.index({ tenantId: 1, reportingManagerId: 1 });
employeeSchema.index({ status: 1, exitDate: 1 });
employeeSchema.plugin(tenantScopePlugin);

export const Employee = model<EmployeeDoc>('Employee', employeeSchema);
