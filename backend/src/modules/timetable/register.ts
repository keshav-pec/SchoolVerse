import { timetableBundlePermissions, type TimetableBundle } from '@shared';
import { registerPermissionProvider } from '../../platform/rbac/permission-providers';
import { registerAcademicDependency } from '../academic/dependencies';
import { registerOfferingCleanup } from '../academic/cleanup';
import { registerLocationDependency } from '../dependencies/registry';
import { Availability, BellAssignment, BellPeriod, BellSchedule, GroupMembership, Requirement, TeachingGroup, TimetableGrant, TimetablePlan, WorkloadRule } from './models';
import './usage';

let registered = false;

/**
 * Module 6 on the registries Modules 1 to 5 built:
 *   - timetable bundles add permissions to a Staff or Faculty login (read from the database on every request)
 *   - a campus with a timetable plan cannot be archived until the plan is archived, and a session cannot be closed
 *   - a deleted DRAFT session, class, section or subject takes its timetable setup with it
 */
export function registerTimetableDependencies() {
  if (registered) return;
  registered = true;

  registerPermissionProvider('timetable', async (user) => {
    if (user.role !== 'STAFF' && user.role !== 'FACULTY') return [];
    const grant = await TimetableGrant.findOne({ tenantId: user.tenantId, userId: user._id }).select('bundles').lean<{ bundles: TimetableBundle[] }>();
    return grant ? timetableBundlePermissions(grant.bundles) : [];
  });

  registerLocationDependency({
    key: 'timetable.plans',
    label: 'Timetable plans',
    message: (n) => `${n} timetable plan${n === 1 ? ' is' : 's are'} still set up for this location. Archive ${n === 1 ? 'it' : 'them'} first.`,
    async countActive({ tenantId, locationId, session }) {
      return TimetablePlan.countDocuments({ tenantId, locationId, status: { $ne: 'ARCHIVED' } }).session(session ?? null);
    },
    async countAny({ tenantId, locationId, session }) {
      return TimetablePlan.countDocuments({ tenantId, locationId }).session(session ?? null);
    },
  });

  registerAcademicDependency({
    key: 'timetable.plans',
    label: 'Timetable plans',
    entityTypes: ['academic_session', 'session_location'],
    message: (n) => `${n} timetable plan${n === 1 ? ' is' : 's are'} still set up. Archive ${n === 1 ? 'it' : 'them'} first.`,
    async count({ tenantId, academicSessionId, entityType, entityId, session }) {
      return TimetablePlan.countDocuments({ tenantId, academicSessionId, status: { $ne: 'ARCHIVED' }, ...(entityType === 'session_location' ? { locationId: entityId } : {}) }).session(session ?? null);
    },
  });

  registerOfferingCleanup('timetable.setup', async (tenantId, scope, db) => {
    if (scope.sessionId) {
      const planIds = (await TimetablePlan.find({ tenantId, academicSessionId: scope.sessionId }).select('_id').session(db).lean<{ _id: string }[]>()).map((p) => p._id);
      if (planIds.length > 0) {
        const groupIds = (await TeachingGroup.find({ tenantId, planId: { $in: planIds } }).select('_id').session(db).lean<{ _id: string }[]>()).map((g) => g._id);
        const byPlan = { tenantId, planId: { $in: planIds } };
        await Promise.all([
          GroupMembership.deleteMany({ tenantId, groupId: { $in: groupIds } }, { session: db }),
          TeachingGroup.deleteMany(byPlan, { session: db }),
          Requirement.deleteMany(byPlan, { session: db }),
          Availability.deleteMany(byPlan, { session: db }),
          WorkloadRule.deleteMany(byPlan, { session: db }),
          BellAssignment.deleteMany(byPlan, { session: db }),
          BellPeriod.deleteMany(byPlan, { session: db }),
          BellSchedule.deleteMany(byPlan, { session: db }),
        ]);
        await TimetablePlan.deleteMany({ tenantId, _id: { $in: planIds } }, { session: db });
      }
      return;
    }
    if (scope.sectionOfferingIds?.length) {
      await Promise.all([
        BellAssignment.deleteMany({ tenantId, scope: 'SECTION', sectionOfferingId: { $in: scope.sectionOfferingIds } }, { session: db }),
        Requirement.deleteMany({ tenantId, scope: 'SECTION', sectionOfferingId: { $in: scope.sectionOfferingIds } }, { session: db }),
        TeachingGroup.updateMany({ tenantId, sectionPool: { $in: scope.sectionOfferingIds } }, { $pull: { sectionPool: { $in: scope.sectionOfferingIds } } }, { session: db }),
      ]);
    }
    if (scope.classOfferingIds?.length) {
      await Promise.all([BellAssignment.deleteMany({ tenantId, classOfferingId: { $in: scope.classOfferingIds } }, { session: db }), Requirement.deleteMany({ tenantId, classOfferingId: { $in: scope.classOfferingIds } }, { session: db })]);
      const groupIds = (await TeachingGroup.find({ tenantId, classOfferingId: { $in: scope.classOfferingIds } }).select('_id').session(db).lean<{ _id: string }[]>()).map((g) => g._id);
      await GroupMembership.deleteMany({ tenantId, groupId: { $in: groupIds } }, { session: db });
      await TeachingGroup.deleteMany({ tenantId, _id: { $in: groupIds } }, { session: db });
    }
    if (scope.subjectOfferingIds?.length) {
      await Requirement.deleteMany({ tenantId, subjectOfferingId: { $in: scope.subjectOfferingIds } }, { session: db });
      const groupIds = (await TeachingGroup.find({ tenantId, subjectOfferingId: { $in: scope.subjectOfferingIds } }).select('_id').session(db).lean<{ _id: string }[]>()).map((g) => g._id);
      await GroupMembership.deleteMany({ tenantId, groupId: { $in: groupIds } }, { session: db });
      await TeachingGroup.deleteMany({ tenantId, _id: { $in: groupIds } }, { session: db });
    }
  });
}
