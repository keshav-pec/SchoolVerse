import type { SpaceDependencyDTO } from '@shared';
import { academicService } from '../academic/academic.service';
import { registerOfferingCleanup } from '../academic/cleanup';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { todayForTenant } from '../staff/status';
import { endOf, isLive } from './assignment.rules';
import { registerSpaceDependency, type SpaceDependencyQuery } from './dependencies';
import { SectionSpaceAssignment, type SectionSpaceAssignmentDoc } from './space.models';

/**
 * Part 3 on the registries. A Home Classroom is a record about a room, so:
 *  - a room that a section uses today (or will use) cannot be archived without a plan: `archive` explains and offers a replacement;
 *  - a room that ever had one cannot be moved or deleted (it has history);
 *  - converting a classroom to a lab lists the sections that would lose an eligible room;
 *  - a section or campus with a live Home Classroom on an ACTIVE session cannot be switched off until the assignment is ended.
 */

/** The live rows of a room (running or still to come) with their section's name. Rows whose section was removed are not counted. */
async function liveRowsOf(query: SpaceDependencyQuery) {
  const today = await todayForTenant(query.tenantId, query.session);
  const rows = await SectionSpaceAssignment.find({ tenantId: query.tenantId, physicalSpaceId: query.physicalSpaceId, status: { $ne: 'CANCELLED' } }).session(query.session ?? null).lean<SectionSpaceAssignmentDoc[]>();
  if (rows.length === 0) return [];
  const sessions = new Map((await AcademicSession.find({ tenantId: query.tenantId, _id: { $in: [...new Set(rows.map((r) => r.academicSessionId))] } }).session(query.session ?? null).lean<AcademicSessionDoc[]>()).map((s) => [s._id, s]));
  const sections = new Map((await SectionOffering.find({ tenantId: query.tenantId, _id: { $in: rows.map((r) => r.sectionOfferingId) } }).session(query.session ?? null).lean<SectionOfferingDoc[]>()).map((s) => [s._id, s]));
  const classes = new Map((await ClassOffering.find({ tenantId: query.tenantId, _id: { $in: [...new Set([...sections.values()].map((s) => s.classOfferingId))] } }).session(query.session ?? null).lean<ClassOfferingDoc[]>()).map((c) => [c._id, c]));
  return rows.flatMap((row) => {
    const session = sessions.get(row.academicSessionId);
    const section = sections.get(row.sectionOfferingId);
    const klass = section ? classes.get(section.classOfferingId) : undefined;
    if (!session || !section || !klass || !isLive(row, session.endDate, today)) return [];
    return [{ row, session, label: `${klass.displayCode}-${section.sectionCode}`, endsOn: endOf(row, session.endDate) }];
  });
}

let registered = false;

export function registerHomeClassroomDependency() {
  if (registered) return;
  registered = true;

  registerSpaceDependency({
    key: 'spaces.home_classrooms',
    kind: 'HOME_CLASSROOM',
    async find(query): Promise<SpaceDependencyDTO[]> {
      return (await liveRowsOf(query)).map((r) => ({ kind: 'HOME_CLASSROOM', label: `Home Classroom of ${r.label} in ${r.session.name}.`, count: 1 }));
    },
    async hasHistory({ tenantId, physicalSpaceId, session }) {
      return Boolean(await SectionSpaceAssignment.exists({ tenantId, physicalSpaceId }).session(session ?? null));
    },
    async checkConversion(query) {
      if (query.homeClassroomEligibleAfter) return [];
      return (await liveRowsOf(query)).map((r) => `${r.label} uses this room as its Home Classroom (${r.session.name}). After this change the room could no longer be one, so its Home Classroom will need a new room.`);
    },
  });

  // Module 2 asks before a section or a campus is switched off on an ACTIVE session.
  academicService.registerAcademicDependency({
    key: 'spaces.home_classrooms',
    label: 'Home Classrooms',
    entityTypes: ['section_offering', 'session_location'],
    message: (n) => `${n} Home Classroom assignment${n === 1 ? ' depends' : 's depend'} on this. End ${n === 1 ? 'it' : 'them'} first.`,
    async count({ tenantId, academicSessionId, entityType, entityId, session }) {
      const today = await todayForTenant(tenantId, session);
      const live = { status: { $ne: 'CANCELLED' as const }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] };
      if (entityType === 'section_offering') return SectionSpaceAssignment.countDocuments({ tenantId, sectionOfferingId: entityId, ...live }).session(session ?? null);
      return SectionSpaceAssignment.countDocuments({ tenantId, academicSessionId, locationId: entityId, ...live }).session(session ?? null);
    },
  });

  // Deleting a DRAFT session, class or section also removes the Home Classrooms that were carried into it.
  registerOfferingCleanup('spaces.home_classrooms', async (tenantId, scope, db) => {
    if (scope.sessionId) await SectionSpaceAssignment.deleteMany({ tenantId, academicSessionId: scope.sessionId }, { session: db });
    if (scope.sectionOfferingIds?.length) await SectionSpaceAssignment.deleteMany({ tenantId, sectionOfferingId: { $in: scope.sectionOfferingIds } }, { session: db });
  });
}
