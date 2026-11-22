import type { MyClassroomsDTO } from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { SectionOffering, type SectionOfferingDoc } from '../academic/offering.model';
import { facultyScope } from '../students/access';
import { todayFor } from '../staff/status';
import { runsOn } from './assignment.rules';
import { toHomeClassroomDTOs } from './home-classroom.mappers';
import { naturalCompare } from './rooms';
import { loadSectionFacts } from './sections';
import { SectionSpaceAssignment, type SectionSpaceAssignmentDoc } from './space.models';

/**
 * "My Classroom" for a teacher: the Home Classroom in force today for each section the teacher is assigned to (a Coordinator or HOD
 * sees the whole class), and the sections that have no room yet. Read-only. Anyone who is not a teacher with assignments today gets
 * an empty answer, never somebody else's sections.
 */
export async function myHomeClassrooms(ctx: ServiceContext): Promise<MyClassroomsDTO> {
  const today = await todayFor(ctx);
  const scope = await facultyScope(ctx, today);
  if (!scope || (scope.sectionIds.size === 0 && scope.classOfferingIds.size === 0)) return { items: [], withoutRoom: [] };

  const sections = await SectionOffering.find({
    tenantId: ctx.tenantId,
    status: 'ACTIVE',
    $or: [{ _id: { $in: [...scope.sectionIds] } }, { classOfferingId: { $in: [...scope.classOfferingIds] } }],
  })
    .select('_id')
    .lean<Pick<SectionOfferingDoc, '_id'>[]>();
  const facts = await loadSectionFacts(ctx, sections.map((s) => s._id), today);
  // Only sections of a session that is running today: last year's or next year's sections are not "my classroom" yet.
  const live = [...facts.values()].filter((f) => f.session.startDate <= today && f.session.endDate >= today);
  if (live.length === 0) return { items: [], withoutRoom: [] };

  const rows = await SectionSpaceAssignment.find({
    tenantId: ctx.tenantId,
    sectionOfferingId: { $in: live.map((f) => f.section._id) },
    status: { $ne: 'CANCELLED' },
    effectiveFrom: { $lte: today },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
  })
    .sort({ effectiveFrom: -1 })
    .lean<SectionSpaceAssignmentDoc[]>();
  const current = new Map<string, SectionSpaceAssignmentDoc>();
  for (const row of rows) {
    const f = facts.get(row.sectionOfferingId)!;
    if (!current.has(row.sectionOfferingId) && runsOn(row, today, f.session.endDate)) current.set(row.sectionOfferingId, row);
  }
  const items = (await toHomeClassroomDTOs(ctx, [...current.values()], today, { sections: facts })).sort((a, b) => naturalCompare(a.section.label, b.section.label));
  const withoutRoom = live
    .filter((f) => !current.has(f.section._id))
    .map((f) => ({ sectionOfferingId: f.section._id, label: f.label }))
    .sort((a, b) => naturalCompare(a.label, b.label));
  return { items, withoutRoom };
}
