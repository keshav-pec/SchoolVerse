import {
  type AdmissionDTO,
  type ClassSectionDTO,
  type ExternalIdDTO,
  type FacultyStudentSummaryDTO,
  type GuardianLinkDTO,
  type SectionAssignmentDTO,
  type StudentAddressDTO,
  type StudentDirectoryDTO,
  type TransferEventDTO,
} from '@shared';
import { toIso } from '../../core/objects';
import type { ClassOfferingDoc, SectionOfferingDoc } from '../academic/offering.model';
import type { PersonAddress, PersonDoc } from '../staff/person.model';
import { assignmentStatus } from '../staff/status';
import { displayNameOf, fullNameOf, type StudentHydration } from './directory';
import { enrollmentStatus } from './rules';
import type {
  StudentAdmissionDoc,
  StudentDoc,
  StudentEnrollmentDoc,
  StudentExternalIdDoc,
  StudentGuardianLinkDoc,
  StudentSectionAssignmentDoc,
  StudentTransferEventDoc,
} from './student.models';

/**
 * Explicit DTO mappers (SEC-SPM-02). No route sends a database document. Each kind of caller gets its own mapper, so a field
 * can only leave through the mapper that is allowed to carry it:
 *   directory  → name, admission number, class-section, roll, primary guardian name, status
 *   faculty    → the same minus the guardian, plus the subjects they teach the student. No contact, address or birth date.
 *   admin      → the profile (`student-profile.ts`), personal fields only with `student:view_personal`
 */

export function classSectionOf(
  classes: Map<string, ClassOfferingDoc>,
  sections: Map<string, SectionOfferingDoc>,
  enrollment: Pick<StudentEnrollmentDoc, 'classOfferingId'> | null,
  assignment: Pick<StudentSectionAssignmentDoc, 'sectionId'> | null,
): ClassSectionDTO | null {
  if (!enrollment) return null;
  const klass = classes.get(enrollment.classOfferingId);
  if (!klass) return null;
  const section = assignment ? sections.get(assignment.sectionId) : undefined;
  return {
    classOfferingId: klass._id,
    className: klass.displayName,
    classCode: klass.displayCode,
    sectionId: section?._id ?? null,
    sectionCode: section?.sectionCode ?? null,
    label: section ? `${klass.displayCode}-${section.sectionCode}` : klass.displayCode,
  };
}

export function toDirectoryDTO(student: StudentDoc, h: StudentHydration): StudentDirectoryDTO {
  const person = h.people.get(student.personId)!;
  const placement = h.placements.get(student._id) ?? { enrollment: null, assignment: null };
  return {
    studentId: student._id,
    admissionNumber: h.admissions.get(student._id)?.admissionNumber ?? null,
    fullName: fullNameOf(person),
    displayName: displayNameOf(person),
    status: student.status,
    hasPhoto: Boolean(student.photoKey),
    academicSessionId: placement.enrollment?.academicSessionId ?? null,
    locationId: placement.enrollment?.locationId ?? null,
    enrollmentId: placement.enrollment?._id ?? null,
    enrollmentStatus: placement.enrollment ? enrollmentStatus(placement.enrollment, h.today) : null,
    classSection: classSectionOf(h.classes, h.sections, placement.enrollment, placement.assignment),
    rollNumber: placement.assignment?.rollNumber ?? null,
    primaryGuardianName: h.primaryGuardianNames.get(student._id) ?? null,
  };
}

export function toFacultySummaryDTO(student: StudentDoc, h: StudentHydration, subjects: { subjectOfferingId: string; subjectName: string }[]): FacultyStudentSummaryDTO {
  const person = h.people.get(student.personId)!;
  const placement = h.placements.get(student._id) ?? { enrollment: null, assignment: null };
  return {
    studentId: student._id,
    admissionNumber: h.admissions.get(student._id)?.admissionNumber ?? null,
    fullName: fullNameOf(person),
    displayName: displayNameOf(person),
    hasPhoto: Boolean(student.photoKey),
    classSection: classSectionOf(h.classes, h.sections, placement.enrollment, placement.assignment),
    rollNumber: placement.assignment?.rollNumber ?? null,
    subjects,
  };
}

export function toAddressDTO(address: PersonAddress | null | undefined): StudentAddressDTO | null {
  if (!address) return null;
  return {
    line1: address.line1 ?? null,
    line2: address.line2 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postalCode: address.postalCode ?? null,
    country: address.country ?? null,
  };
}

export function toAdmissionDTO(admission: StudentAdmissionDoc, className: string, viewPersonal: boolean): AdmissionDTO {
  return {
    admissionId: admission._id,
    studentId: admission.studentId,
    admissionNumber: admission.admissionNumber,
    admissionDate: admission.admissionDate,
    mode: admission.mode,
    academicSessionId: admission.admissionSessionId,
    locationId: admission.admissionLocationId,
    classOfferingId: admission.admissionClassOfferingId,
    className,
    isCurrent: admission.isCurrent,
    category: viewPersonal ? admission.category ?? null : null,
    previousSchool: viewPersonal && admission.previousSchool ? { ...admission.previousSchool } : null,
    remarks: viewPersonal ? admission.remarks ?? null : null,
  };
}

export function toExternalIdDTO(doc: StudentExternalIdDoc): ExternalIdDTO {
  return { externalIdId: doc._id, studentId: doc.studentId, type: doc.type, value: doc.value, effectiveFrom: doc.effectiveFrom ?? null, effectiveTo: doc.effectiveTo ?? null };
}

export function toGuardianLinkDTO(link: StudentGuardianLinkDoc, person: PersonDoc, today: string, viewPersonal: boolean): GuardianLinkDTO {
  return {
    guardianLinkId: link._id,
    studentId: link.studentId,
    guardianPersonId: link.guardianPersonId,
    fullName: fullNameOf(person),
    relationshipType: link.relationshipType,
    isPrimary: link.isPrimary,
    isEmergencyContact: link.isEmergencyContact,
    communicationPriority: link.communicationPriority,
    canSeeAcademics: link.canSeeAcademics,
    canSeeFees: link.canSeeFees,
    pickupAllowed: link.pickupAllowed,
    portalEnabled: link.portalEnabled,
    effectiveFrom: link.effectiveFrom,
    effectiveTo: link.effectiveTo ?? null,
    status: assignmentStatus(link, today),
    phone: viewPersonal ? person.primaryPhone ?? null : null,
    email: viewPersonal ? person.primaryEmail ?? null : null,
    version: link.version,
  };
}

export function toSectionAssignmentDTO(doc: StudentSectionAssignmentDoc, section: Pick<SectionOfferingDoc, 'sectionCode' | 'displayName'> | undefined, today: string): SectionAssignmentDTO {
  return {
    sectionAssignmentId: doc._id,
    enrollmentId: doc.enrollmentId,
    studentId: doc.studentId,
    sectionId: doc.sectionId,
    sectionCode: section?.sectionCode ?? '?',
    sectionName: section?.displayName ?? 'Unknown section',
    rollNumber: doc.rollNumber ?? null,
    effectiveFrom: doc.effectiveFrom,
    effectiveTo: doc.effectiveTo ?? null,
    cancelledAt: toIso(doc.cancelledAt),
    reason: doc.reason ?? null,
    status: assignmentStatus(doc, today),
  };
}

export function toTransferEventDTO(doc: StudentTransferEventDoc): TransferEventDTO {
  return {
    transferEventId: doc._id,
    studentId: doc.studentId,
    type: doc.type,
    fromEnrollmentId: doc.fromEnrollmentId,
    toEnrollmentId: doc.toEnrollmentId ?? null,
    fromSectionId: doc.fromSectionId ?? null,
    toSectionId: doc.toSectionId ?? null,
    fromLocationId: doc.fromLocationId ?? null,
    toLocationId: doc.toLocationId ?? null,
    effectiveDate: doc.effectiveDate,
    reason: doc.reason,
    actorId: doc.actorId,
    createdAt: toIso(doc.createdAt)!,
  };
}
