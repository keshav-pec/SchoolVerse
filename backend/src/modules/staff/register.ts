import { academicService } from '../academic/academic.service';
import { registerLocationDependency } from '../dependencies/registry';
import { AcademicAssignment, LocationAssignment, Responsibility } from './assignment.models';
import { Employee } from './employee.model';
import { registerStaffIdentityHooks } from './identity-hooks';
import { todayForTenant } from './status';

let registered = false;

/**
 * Module 3 on the two dependency registries (Part 1 item 14):
 *  - a location with staff placed there cannot be archived, and any assignment at all locks its code;
 *  - a section, subject or class offering with active faculty assignments blocks unsafe changes on an ACTIVE session.
 */
export function registerStaffDependencies() {
  if (registered) return;
  registered = true;
  registerStaffIdentityHooks();

  registerLocationDependency({
    key: 'staff.assignments',
    label: 'Active staff',
    message: (n) => `${n} staff member${n === 1 ? ' is' : 's are'} assigned to this location.`,
    /** Employees (not exited) with a placement here that has not ended. */
    async countActive({ tenantId, locationId, session }) {
      const today = await todayForTenant(tenantId, session);
      const ids = await LocationAssignment.distinct('employeeId', {
        tenantId,
        locationId,
        cancelledAt: null,
        $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
      }).session(session ?? null);
      if (ids.length === 0) return 0;
      return Employee.countDocuments({ tenantId, _id: { $in: ids }, status: { $ne: 'EXITED' } }).session(session ?? null);
    },
    async countAny({ tenantId, locationId, session }) {
      const scope = { tenantId, locationId };
      const counts = await Promise.all([
        LocationAssignment.countDocuments(scope).session(session ?? null),
        AcademicAssignment.countDocuments(scope).session(session ?? null),
        Responsibility.countDocuments(scope).session(session ?? null),
      ]);
      return counts.reduce((a, b) => a + b, 0);
    },
  });

  academicService.registerAcademicDependency({
    key: 'staff.faculty_assignments',
    label: 'Faculty assignments',
    entityTypes: ['class_offering', 'section_offering', 'subject_offering', 'session_location'],
    message: (n) => `${n} faculty assignment${n === 1 ? ' depends' : 's depend'} on this.`,
    async count({ tenantId, academicSessionId, entityType, entityId, session }) {
      const today = await todayForTenant(tenantId, session);
      const target: Record<string, string> =
        entityType === 'class_offering'
          ? { classOfferingId: entityId }
          : entityType === 'section_offering'
            ? { sectionId: entityId }
            : entityType === 'subject_offering'
              ? { subjectOfferingId: entityId }
              : { locationId: entityId };
      return AcademicAssignment.countDocuments({
        tenantId,
        academicSessionId,
        ...target,
        cancelledAt: null,
        $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
      }).session(session ?? null);
    },
  });
}
