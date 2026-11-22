import type { SpaceContextDTO } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { checkSpaceAvailability } from './availability.service';
import { getSectionHomeClassroom } from './assignment.service';
import { findAvailable, readiness, recommendRooms } from './integration';
import { getSpaceContext, loadVisibleSpace } from './space.service';

/**
 * Rooms, for every other module (Timetable, Exams, Attendance, Assets, Maintenance, Visitor, Events).
 *
 *   DO NOT BUILD YOUR OWN ROOM LIST. Store a room's `physicalSpaceId` and nothing else, and ask this service what the room is, whether
 *   it can be used, and which Home Classroom a section has. There is no `timetable_rooms` and no `exam_rooms`.
 *
 * Everything here goes through the same rules as the screens: your tenant, the caller's campus, and only schedulable, open rooms for
 * `findAvailable`. The Timetable books periods; this service never checks a period for a double booking.
 */
export const spaceService = {
  /** The room: where it is, its final settings with their source, whether it is open, and its Home Classroom today. */
  getSpaceContext: (ctx: ServiceContext, physicalSpaceId: string): Promise<SpaceContextDTO> => getSpaceContext(ctx, physicalSpaceId),

  /** Schedulable, open rooms at a campus with no closure in the period. */
  findAvailable,

  /** Yes or no for one room and period, with every reason. */
  async checkAvailability(ctx: ServiceContext, physicalSpaceId: string, start: Date, end: Date) {
    return checkSpaceAvailability(ctx, await loadVisibleSpace(ctx, physicalSpaceId), start, end);
  },

  /** The Home Classroom a section has on a date (default today), or none. */
  getHomeClassroom: (ctx: ServiceContext, sectionOfferingId: string, date?: string) => getSectionHomeClassroom(ctx, sectionOfferingId, date),

  recommendRooms,
  readiness,
};
