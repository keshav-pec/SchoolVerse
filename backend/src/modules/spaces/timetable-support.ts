import type { SuitabilityTagCode } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { todayFor } from '../staff/status';
import { runsOn } from './assignment.rules';
import { assertLocationAccess } from './guards';
import { loadLocationRoomFacts } from './rooms';
import { PhysicalSpace, SectionSpaceAssignment, SpaceAvailabilityBlock, type SectionSpaceAssignmentDoc, type SpaceAvailabilityBlockDoc } from './space.models';

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

/** The Home Classroom room of each section on a date. A section with none is simply missing from the map. */
export async function homeClassroomRooms(ctx: ServiceContext, sectionIds: string[], date: string, sessionEnd: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (sectionIds.length === 0) return out;
  const rows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, sectionOfferingId: { $in: sectionIds }, status: { $ne: 'CANCELLED' }, effectiveFrom: { $lte: date } })
    .sort({ effectiveFrom: -1 })
    .select('sectionOfferingId physicalSpaceId effectiveFrom effectiveTo status')
    .lean<SectionSpaceAssignmentDoc[]>();
  for (const row of rows) if (!out.has(row.sectionOfferingId) && runsOn(row, date, sessionEnd)) out.set(row.sectionOfferingId, row.physicalSpaceId);
  return out;
}

/** A room as the Timetable judges it: what it can hold, what it suits, and whether it is open for lessons at all. */
export interface RoomInfo {
  spaceId: string;
  spaceName: string;
  locationId: string;
  tags: SuitabilityTagCode[];
  academicCapacity: number | null;
  /** Open and allowed to hold lessons. */
  usable: boolean;
  /** Why it is not usable, in plain words. */
  reason: string | null;
}

/** Every room at a campus that is not archived, including closed ones, so a lesson in a closed room can be named as a problem. */
export async function listRoomInfos(ctx: ServiceContext, locationId: string): Promise<RoomInfo[]> {
  await assertLocationAccess(ctx, locationId);
  const today = await todayFor(ctx);
  return (await loadLocationRoomFacts(ctx, locationId, today)).map((r) => {
    const open = r.space.operationalStatus === 'ACTIVE' && r.effective.available;
    const schedulable = r.resolved.schedulable.value;
    return {
      spaceId: r.space._id,
      spaceName: r.space.spaceName,
      locationId: r.space.locationId,
      tags: r.resolved.suitabilityTags.value as SuitabilityTagCode[],
      academicCapacity: r.resolved.academicCapacity.value,
      usable: open && schedulable,
      reason: !open ? (r.effective.reason ?? `${r.space.spaceName} is not open.`) : !schedulable ? `${r.space.spaceName} is not set up to hold lessons.` : null,
    };
  });
}

/** Which campus each room is at, for any room of the school (archived ones too). Rooms of another school are not found. */
export async function roomCampuses(ctx: ServiceContext, spaceIds: string[]): Promise<Map<string, { locationId: string; spaceName: string; archived: boolean }>> {
  if (spaceIds.length === 0) return new Map();
  const rows = await PhysicalSpace.find({ tenantId: ctx.tenantId, _id: { $in: spaceIds } }).select('locationId spaceName operationalStatus').lean<{ _id: string; locationId: string; spaceName: string; operationalStatus: string }[]>();
  return new Map(rows.map((r) => [r._id, { locationId: r.locationId, spaceName: r.spaceName, archived: r.operationalStatus === 'ARCHIVED' }]));
}

/**
 * Closures long enough to hit every week (`minDays` or more in a row) that overlap `[from, to]`. A short closure is a one-day matter for
 * Daily Operations and never blocks a weekly lesson.
 */
export async function longClosures(ctx: ServiceContext, roomIds: string[], from: string, to: string, minDays = 7): Promise<Map<string, { from: string; to: string }>> {
  const out = new Map<string, { from: string; to: string }>();
  if (roomIds.length === 0) return out;
  const blocks = await SpaceAvailabilityBlock.find({ tenantId: ctx.tenantId, physicalSpaceId: { $in: roomIds }, status: 'ACTIVE', startDatetime: { $lte: new Date(`${to}T23:59:59Z`) }, endDatetime: { $gte: new Date(`${from}T00:00:00Z`) } })
    .select('physicalSpaceId startDatetime endDatetime')
    .lean<Pick<SpaceAvailabilityBlockDoc, 'physicalSpaceId' | 'startDatetime' | 'endDatetime'>[]>();
  for (const b of blocks) {
    const days = (b.endDatetime.getTime() - b.startDatetime.getTime()) / 86_400_000;
    if (days >= minDays - 1) out.set(b.physicalSpaceId, { from: b.startDatetime.toISOString().slice(0, 10), to: b.endDatetime.toISOString().slice(0, 10) });
  }
  return out;
}
