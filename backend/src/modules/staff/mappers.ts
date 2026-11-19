import type {
  EmployeeDirectoryDTO,
  EmployeeLocationRefDTO,
  EmployeePersonalDTO,
  EmployeeProfileDTO,
  FacultyAssignmentDTO,
  LocationAssignmentDTO,
  ResponsibilityDTO,
  AssignmentStatus,
  DepartmentDTO,
  DesignationDTO,
} from '@shared';
import { toIso } from '../../core/objects';
import type { AcademicAssignmentDoc, LocationAssignmentDoc, ResponsibilityDoc } from './assignment.models';
import type { EmployeeDoc } from './employee.model';
import { availableActions } from './lifecycle';
import type { StaffMasterDoc } from './master.model';
import type { PersonDoc } from './person.model';
import { assignmentStatus } from './status';

/**
 * The only way staff data leaves the service layer (PRD §16). Nothing here spreads a document:
 * every field of every DTO is named, and `data-classification.ts` says which DTO may carry which class.
 */

export function fullNameOf(person: Pick<PersonDoc, 'legalFirstName' | 'legalMiddleName' | 'legalLastName'>): string {
  return [person.legalFirstName, person.legalMiddleName, person.legalLastName].filter(Boolean).join(' ');
}

export function displayNameOf(person: Pick<PersonDoc, 'legalFirstName' | 'legalLastName' | 'preferredName'>): string {
  return person.preferredName || `${person.legalFirstName} ${person.legalLastName}`;
}

export function toDepartmentDTO(doc: StaffMasterDoc): DepartmentDTO {
  return { departmentId: doc._id, code: doc.code, name: doc.name, status: doc.status, createdAt: toIso(doc.createdAt)!, updatedAt: toIso(doc.updatedAt)! };
}

export function toDesignationDTO(doc: StaffMasterDoc): DesignationDTO {
  return { designationId: doc._id, code: doc.code, name: doc.name, status: doc.status, createdAt: toIso(doc.createdAt)!, updatedAt: toIso(doc.updatedAt)! };
}

/** Everything a mapper needs besides the employee row, loaded once per request by `hydrate()`. */
export interface Hydration {
  today: string;
  people: Map<string, PersonDoc>;
  departments: Map<string, StaffMasterDoc>;
  designations: Map<string, StaffMasterDoc>;
  placements: Map<string, { primary: EmployeeLocationRefDTO | null; locations: EmployeeLocationRefDTO[] }>;
  managers: Map<string, { employeeId: string; employeeCode: string; fullName: string }>;
}

function missing(what: string, id: string): never {
  throw new Error(`Hydration is missing ${what} ${id}`);
}

/** INTERNAL fields only. Safe for the colleague directory. */
export function toDirectoryDTO(employee: EmployeeDoc, h: Hydration): EmployeeDirectoryDTO {
  const person = h.people.get(employee.personId) ?? missing('person', employee.personId);
  const department = h.departments.get(employee.departmentId) ?? missing('department', employee.departmentId);
  const designation = h.designations.get(employee.designationId) ?? missing('designation', employee.designationId);
  const placement = h.placements.get(employee._id) ?? { primary: null, locations: [] };
  return {
    employeeId: employee._id,
    employeeCode: employee.employeeCode,
    fullName: fullNameOf(person),
    displayName: displayNameOf(person),
    preferredName: person.preferredName ?? null,
    employeeCategory: employee.employeeCategory,
    employmentType: employee.employmentType ?? null,
    department: { departmentId: department._id, code: department.code, name: department.name },
    designation: { designationId: designation._id, code: designation.code, name: designation.name },
    status: employee.status,
    primaryLocation: placement.primary,
    locations: placement.locations,
    officialEmail: employee.officialEmail ?? null,
    officialPhone: employee.officialPhone ?? null,
  };
}

function toPersonalDTO(person: PersonDoc): EmployeePersonalDTO {
  return {
    primaryEmail: person.primaryEmail ?? null,
    primaryPhone: person.primaryPhone ?? null,
    personalEmail: person.personalEmail ?? null,
    personalPhone: person.personalPhone ?? null,
    address: person.address
      ? {
          line1: person.address.line1 ?? null,
          line2: person.address.line2 ?? null,
          city: person.address.city ?? null,
          state: person.address.state ?? null,
          postalCode: person.address.postalCode ?? null,
          country: person.address.country ?? null,
        }
      : null,
    emergencyContact: person.emergencyContact
      ? { name: person.emergencyContact.name, relation: person.emergencyContact.relation, phone: person.emergencyContact.phone }
      : null,
  };
}

/**
 * INTERNAL, plus PERSONAL contact when `viewPersonal`. Never date of birth, government IDs or bank details:
 * those only exist in the masked restricted profile.
 */
export function toProfileDTO(employee: EmployeeDoc, h: Hydration, options: { viewPersonal: boolean; deletable: boolean }): EmployeeProfileDTO {
  const person = h.people.get(employee.personId) ?? missing('person', employee.personId);
  return {
    ...toDirectoryDTO(employee, h),
    personId: employee.personId,
    schoolId: employee.schoolId,
    legalFirstName: person.legalFirstName,
    legalMiddleName: person.legalMiddleName ?? null,
    legalLastName: person.legalLastName,
    joiningDate: employee.joiningDate,
    confirmationDate: employee.confirmationDate ?? null,
    reportingManager: employee.reportingManagerId ? h.managers.get(employee.reportingManagerId) ?? null : null,
    exit:
      employee.exitDate && employee.exitReasonCategory
        ? {
            exitDate: employee.exitDate,
            exitReasonCategory: employee.exitReasonCategory,
            ...(options.viewPersonal ? { note: employee.exitNote ?? null } : {}),
          }
        : null,
    ...(options.viewPersonal ? { personal: toPersonalDTO(person) } : {}),
    lifecycleActions: availableActions(employee.status),
    deletable: options.deletable,
    readOnly: employee.status === 'EXITED',
    createdAt: toIso(employee.createdAt)!,
    updatedAt: toIso(employee.updatedAt)!,
  };
}

// ───────────────────────────────────────────────────────────── assignments

export interface LocationLabel {
  locationCode: string;
  displayName: string;
}

export function toLocationAssignmentDTO(doc: LocationAssignmentDoc, location: LocationLabel, today: string): LocationAssignmentDTO {
  return {
    locationAssignmentId: doc._id,
    employeeId: doc.employeeId,
    locationId: doc.locationId,
    locationCode: location.locationCode,
    locationName: location.displayName,
    isPrimary: doc.isPrimary,
    effectiveFrom: doc.effectiveFrom,
    effectiveTo: doc.effectiveTo ?? null,
    cancelledAt: toIso(doc.cancelledAt),
    endReason: doc.endReason ?? null,
    status: assignmentStatus(doc, today),
  };
}

export interface AcademicLabels {
  session: { code: string; name: string };
  location: LocationLabel;
  schoolClassName: string;
  section: { sectionCode: string; displayName: string } | null;
  subject: { subjectId: string; name: string } | null;
}

export function toFacultyAssignmentDTO(doc: AcademicAssignmentDoc, labels: AcademicLabels, today: string): FacultyAssignmentDTO {
  return {
    academicAssignmentId: doc._id,
    employeeId: doc.employeeId,
    academicSessionId: doc.academicSessionId,
    sessionCode: labels.session.code,
    sessionName: labels.session.name,
    locationId: doc.locationId,
    locationCode: labels.location.locationCode,
    locationName: labels.location.displayName,
    classOfferingId: doc.classOfferingId,
    schoolClassName: labels.schoolClassName,
    sectionId: doc.sectionId ?? null,
    sectionCode: labels.section?.sectionCode ?? null,
    sectionName: labels.section?.displayName ?? null,
    subjectOfferingId: doc.subjectOfferingId ?? null,
    subjectId: labels.subject?.subjectId ?? null,
    subjectName: labels.subject?.name ?? null,
    assignmentType: doc.assignmentType,
    effectiveFrom: doc.effectiveFrom,
    effectiveTo: doc.effectiveTo ?? null,
    cancelledAt: toIso(doc.cancelledAt),
    endReason: doc.endReason ?? null,
    status: assignmentStatus(doc, today),
  };
}

export function toResponsibilityDTO(doc: ResponsibilityDoc, location: LocationLabel, today: string): ResponsibilityDTO {
  return {
    responsibilityId: doc._id,
    employeeId: doc.employeeId,
    locationId: doc.locationId,
    locationCode: location.locationCode,
    locationName: location.displayName,
    responsibilityType: doc.responsibilityType,
    description: doc.description ?? null,
    effectiveFrom: doc.effectiveFrom,
    effectiveTo: doc.effectiveTo ?? null,
    cancelledAt: toIso(doc.cancelledAt),
    endReason: doc.endReason ?? null,
    status: assignmentStatus(doc, today),
  };
}

/** Placement rules shown in the directory: current primary first, then the next planned one, then the most recent. */
export function placementOf(
  rows: { doc: LocationAssignmentDoc; ref: LocationLabel }[],
  today: string,
): { primary: EmployeeLocationRefDTO | null; locations: EmployeeLocationRefDTO[] } {
  const live = rows.filter((r) => !r.doc.cancelledAt);
  const refOf = (r: { doc: LocationAssignmentDoc; ref: LocationLabel }, status: AssignmentStatus): EmployeeLocationRefDTO => ({
    locationId: r.doc.locationId,
    locationCode: r.ref.locationCode,
    displayName: r.ref.displayName,
    isPrimary: r.doc.isPrimary,
    status,
  });
  const withStatus = live.map((r) => ({ r, status: assignmentStatus(r.doc, today) }));
  const open = withStatus.filter((x) => x.status === 'ACTIVE' || x.status === 'PLANNED');
  open.sort((a, b) => Number(b.r.doc.isPrimary) - Number(a.r.doc.isPrimary) || a.r.doc.effectiveFrom.localeCompare(b.r.doc.effectiveFrom));

  const primaries = withStatus.filter((x) => x.r.doc.isPrimary).sort((a, b) => a.r.doc.effectiveFrom.localeCompare(b.r.doc.effectiveFrom));
  const primary =
    primaries.find((x) => x.status === 'ACTIVE') ?? primaries.find((x) => x.status === 'PLANNED') ?? primaries[primaries.length - 1] ?? null;

  return { primary: primary ? refOf(primary.r, primary.status) : null, locations: open.map((x) => refOf(x.r, x.status)) };
}
