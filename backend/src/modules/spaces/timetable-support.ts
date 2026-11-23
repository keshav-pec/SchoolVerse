import type { SuitabilityTagCode } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { todayFor } from '../staff/status';
import { runsOn } from './assignment.rules';
import { assertLocationAccess } from './guards';
import { loadLocationRoomFacts } from './rooms';
import { SectionSpaceAssignment, type SectionSpaceAssignmentDoc } from './space.models';

/**
 * What the Timetable needs from rooms, answered here so it never keeps its own room list. Read-only.
 *
 *   sectionsWithHomeClassroom  which of these sections have a Home Classroom on a date
 *   listSchedulableRooms       open rooms that can hold a lesson, with the suitability tags they have
 */

export async function sectionsWithHomeClassroom(ctx: ServiceContext, sectionIds: string[], date: string, sessionEnd: string): Promise<Set<string>> {
  if (sectionIds.length === 0) return new Set();
  const rows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, sectionOfferingId: { $in: sectionIds }, status: { $ne: 'CANCELLED' }, effectiveFrom: { $lte: date } }).select('sectionOfferingId effectiveFrom effectiveTo status').lean<SectionSpaceAssignmentDoc[]>();
  return new Set(rows.filter((r) => runsOn(r, date, sessionEnd)).map((r) => r.sectionOfferingId));
}

export interface SchedulableRoom {
  spaceId: string;
  spaceName: string;
  tags: SuitabilityTagCode[];
  academicCapacity: number | null;
}

export async function listSchedulableRooms(ctx: ServiceContext, locationId: string): Promise<SchedulableRoom[]> {
  await assertLocationAccess(ctx, locationId);
  const today = await todayFor(ctx);
  return (await loadLocationRoomFacts(ctx, locationId, today))
    .filter((r) => r.space.operationalStatus === 'ACTIVE' && r.effective.available && r.resolved.schedulable.value)
    .map((r) => ({ spaceId: r.space._id, spaceName: r.space.spaceName, tags: r.resolved.suitabilityTags.value as SuitabilityTagCode[], academicCapacity: r.resolved.academicCapacity.value }));
}
