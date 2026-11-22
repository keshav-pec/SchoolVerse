import { registerLocationDependency } from '../dependencies/registry';
import { registerBuiltInSpaceDependencies } from './dependencies';
import { registerHomeClassroomDependency } from './home-dependencies';
import { Building, PhysicalSpace } from './space.models';

let registered = false;

/**
 * Module 5 on the registries: a location with active buildings or rooms cannot be archived, and any building or room at all locks its
 * code. Rooms register themselves for the room dependency list (availability blocks now, Home Classrooms in Part 3).
 */
export function registerSpaceDependencies() {
  if (registered) return;
  registered = true;
  registerBuiltInSpaceDependencies();
  registerHomeClassroomDependency();
  registerLocationDependency({
    key: 'spaces.structure',
    label: 'Buildings and rooms',
    message: (n) => `${n} building${n === 1 ? ' or room is' : 's and rooms are'} still set up at this location.`,
    async countActive({ tenantId, locationId, session }) {
      const [buildings, rooms] = await Promise.all([Building.countDocuments({ tenantId, locationId, status: { $ne: 'ARCHIVED' } }).session(session ?? null), PhysicalSpace.countDocuments({ tenantId, locationId, operationalStatus: { $ne: 'ARCHIVED' } }).session(session ?? null)]);
      return buildings + rooms;
    },
    async countAny({ tenantId, locationId, session }) {
      const [buildings, rooms] = await Promise.all([Building.countDocuments({ tenantId, locationId }).session(session ?? null), PhysicalSpace.countDocuments({ tenantId, locationId }).session(session ?? null)]);
      return buildings + rooms;
    },
  });
}
