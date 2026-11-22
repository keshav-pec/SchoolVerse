import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { runsOn } from './assignment.rules';
import { loadSectionFacts } from './sections';
import { SectionSpaceAssignment, type SectionSpaceAssignmentDoc } from './space.models';

/** Who uses a room as their Home Classroom on a date. Kept apart from the services so the room context can use it without a loop. */
export async function currentHomeClassroomOf(ctx: ServiceContext, physicalSpaceId: string, today: string): Promise<{ sectionOfferingId: string; label: string } | null> {
  const rows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, physicalSpaceId, status: { $ne: 'CANCELLED' }, effectiveFrom: { $lte: today }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] }).sort({ effectiveFrom: 1 }).lean<SectionSpaceAssignmentDoc[]>();
  if (rows.length === 0) return null;
  const facts = await loadSectionFacts(ctx, rows.map((r) => r.sectionOfferingId), today);
  for (const row of rows) {
    const f = facts.get(row.sectionOfferingId);
    if (f && runsOn(row, today, f.session.endDate)) return { sectionOfferingId: row.sectionOfferingId, label: f.label };
  }
  return null;
}
