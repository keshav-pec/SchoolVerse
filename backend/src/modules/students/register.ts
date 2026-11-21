import { academicService } from '../academic/academic.service';
import { registerLocationDependency } from '../dependencies/registry';
import { todayForTenant } from '../staff/status';
import { StudentAdmission, StudentEnrollment, StudentSectionAssignment, StudentSubjectEnrollment } from './student.models';

let registered = false;

/**
 * Module 4 on the two dependency registries (Part 1 item 25), which gives Module 2 a second real user:
 *  - a location with open enrollments cannot be archived, and any enrollment or admission at all locks its code;
 *  - a class, section or subject offering with open student rows blocks the unsafe change on an ACTIVE session.
 */
export function registerStudentDependencies() {
  if (registered) return;
  registered = true;

  registerLocationDependency({
    key: 'students.enrollments',
    label: 'Enrolled students',
    message: (n) => `${n} student${n === 1 ? ' is' : 's are'} enrolled at this location.`,
    async countActive({ tenantId, locationId, session }) {
      return StudentEnrollment.countDocuments({ tenantId, locationId, state: 'OPEN' }).session(session ?? null);
    },
    async countAny({ tenantId, locationId, session }) {
      const [enrollments, admissions] = await Promise.all([
        StudentEnrollment.countDocuments({ tenantId, locationId }).session(session ?? null),
        StudentAdmission.countDocuments({ tenantId, admissionLocationId: locationId }).session(session ?? null),
      ]);
      return enrollments + admissions;
    },
  });

  academicService.registerAcademicDependency({
    key: 'students.enrollments',
    label: 'Student enrollments',
    entityTypes: ['class_offering', 'section_offering', 'subject_offering', 'session_location'],
    message: (n) => `${n} student${n === 1 ? ' depends' : 's depend'} on this.`,
    async count({ tenantId, academicSessionId, entityType, entityId, session }) {
      const today = await todayForTenant(tenantId, session);
      const open = { cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] };
      switch (entityType) {
        case 'class_offering':
          return StudentEnrollment.countDocuments({ tenantId, classOfferingId: entityId, state: 'OPEN' }).session(session ?? null);
        case 'section_offering':
          return StudentSectionAssignment.countDocuments({ tenantId, sectionId: entityId, ...open }).session(session ?? null);
        case 'subject_offering':
          return StudentSubjectEnrollment.countDocuments({ tenantId, subjectOfferingId: entityId, ...open }).session(session ?? null);
        default:
          return StudentEnrollment.countDocuments({ tenantId, academicSessionId, locationId: entityId, state: 'OPEN' }).session(session ?? null);
      }
    },
  });
}
