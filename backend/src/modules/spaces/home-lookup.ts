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

/**
 * Rooms whose Home Classroom today belongs to a section matching the search ("8-A", "Class 8 A"), so the room search also finds a room
 * by the section that sits in it.
 */
export async function roomIdsBySection(ctx: ServiceContext, rx: RegExp, today: string, locationFilter?: unknown): Promise<string[]> {
  const rows = await SectionSpaceAssignment.find({ tenantId: ctx.tenantId, ...(locationFilter ? { locationId: locationFilter } : {}), status: { $ne: 'CANCELLED' }, effectiveFrom: { $lte: today }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] }).lean<SectionSpaceAssignmentDoc[]>();
  if (rows.length === 0) return [];
  const facts = await loadSectionFacts(ctx, rows.map((r) => r.sectionOfferingId), today);
  const out = new Set<string>();
  for (const row of rows) {
    const f = facts.get(row.sectionOfferingId);
    if (!f || !runsOn(row, today, f.session.endDate)) continue;
    const names = [f.label, `${f.klass.displayName} ${f.section.sectionCode}`, `${f.klass.displayName}-${f.section.sectionCode}`];
    if (names.some((n) => rx.test(n))) out.add(row.physicalSpaceId);
  }
  return [...out];
}
