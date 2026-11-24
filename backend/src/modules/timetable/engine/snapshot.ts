import type { ClientSession } from 'mongoose';
import type { RequirementValuesDTO, Weekday } from '@shared';
import type { ServiceContext } from '../../../platform/rbac/tenant-context';
import { AcademicAssignment, type AcademicAssignmentDoc } from '../../staff/assignment.models';
import { todayFor } from '../../staff/status';
import { Location } from '../../locations/location.model';
import { clampDate } from '../../spaces/sections';
import { spaceService } from '../../spaces/spaceService';
import { StudentSectionAssignment, type StudentSectionAssignmentDoc } from '../../students/student.models';
import { loadBellContext } from '../bell.resolve';
import { employeeNames, loadPlanFacts, loadPlanTeachers } from '../facts';
import { loadGroupFacts } from '../group.service';
import { loadSession } from '../guards';
import {
  Availability,
  AvailabilityException,
  ConflictOverride,
  EntryFaculty,
  EntrySection,
  Requirement,
  TimetableEntry,
  TimetablePlan,
  TimetableVersion,
  WorkloadRule,
  type AvailabilityDoc,
  type AvailabilityExceptionDoc,
  type ConflictOverrideDoc,
  type EntryFacultyDoc,
  type EntrySectionDoc,
  type RequirementDoc,
  type TimetableEntryDoc,
  type TimetablePlanDoc,
  type TimetableVersionDoc,
  type WorkloadRuleDoc,
} from '../models';
import { valuesOf } from '../requirement.service';
import { Board } from './board';
import { signatureOf, toRec } from './entries';
import type { EntryRec, GroupRec, OutsideLesson, PeriodRec, RequirementIndex, RoomRec, Snapshot, WorkloadLimits } from './types';

/**
 * Everything one check needs, read once: the version's lessons, the setup of the plan, the rooms, the teachers' assignments and times, and
 * the students in each section and group. Nothing is kept between requests. A change to a teacher's assignment, a room or a student
 * shows in the very next check.
 */

const openOn = (day: string) => ({ cancelledAt: null, effectiveFrom: { $lte: day }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: day } }] });

export function buildPeriods(bell: Snapshot['bell']): Map<string, PeriodRec> {
  const out = new Map<string, PeriodRec>();
  for (const [templateId, list] of bell.periods) {
    const lessons = list.filter((p) => p.schedulable);
    for (const p of list) {
      const index = lessons.findIndex((l) => l._id === p._id);
      out.set(p._id, { id: p._id, templateId, code: p.periodCode, name: p.periodName, startMin: p.startMin, endMin: p.endMin, schedulable: p.schedulable, lessonIndex: index, lessonCount: lessons.length });
    }
  }
  return out;
}

function indexRequirements(rows: RequirementDoc[], facts: Snapshot['facts']): RequirementIndex {
  const classRows = new Map<string, RequirementValuesDTO>();
  const sectionRows = new Map<string, RequirementValuesDTO>();
  const groupRows = new Map<string, RequirementValuesDTO>();
  for (const r of rows) {
    if (r.scope === 'CLASS') classRows.set(`${r.classOfferingId}|${r.subjectOfferingId}`, valuesOf(r));
    else if (r.scope === 'SECTION' && r.sectionOfferingId) sectionRows.set(`${r.sectionOfferingId}|${r.subjectOfferingId}`, valuesOf(r));
    else if (r.scope === 'GROUP' && r.teachingGroupId) groupRows.set(r.teachingGroupId, valuesOf(r));
  }
  return {
    forSection: (sectionId, subjectOfferingId) => {
      const section = facts.sectionOf.get(sectionId);
      if (!section) return null;
      return sectionRows.get(`${sectionId}|${subjectOfferingId}`) ?? classRows.get(`${section.classOfferingId}|${subjectOfferingId}`) ?? null;
    },
    forGroup: (groupId) => groupRows.get(groupId) ?? null,
  };
}

export async function loadSnapshot(ctx: ServiceContext, plan: TimetablePlanDoc, version: Pick<TimetableVersionDoc, '_id' | 'rev'>, db?: ClientSession): Promise<Snapshot> {
  const session = await loadSession(ctx, plan.academicSessionId, db);
  const today = await todayFor(ctx);
  const day = clampDate(today, plan.effectiveFrom, plan.effectiveTo);
  const byPlan = { tenantId: ctx.tenantId, planId: plan._id };

  const [facts, bell, entryDocs, sectionDocs, facultyDocs, overrideDocs, teachers, availDocs, exceptionDocs, workloadDocs, roomList, groupFacts, assignments, requirementDocs] = await Promise.all([
    loadPlanFacts(ctx, plan, db),
    loadBellContext(ctx, plan, db),
    TimetableEntry.find({ tenantId: ctx.tenantId, versionId: version._id }).session(db ?? null).lean<TimetableEntryDoc[]>(),
    EntrySection.find({ tenantId: ctx.tenantId, versionId: version._id }).session(db ?? null).lean<EntrySectionDoc[]>(),
    EntryFaculty.find({ tenantId: ctx.tenantId, versionId: version._id }).session(db ?? null).lean<EntryFacultyDoc[]>(),
    ConflictOverride.find({ tenantId: ctx.tenantId, versionId: version._id }).session(db ?? null).lean<ConflictOverrideDoc[]>(),
    loadPlanTeachers(ctx, plan, {}, db),
    Availability.find(byPlan).session(db ?? null).lean<AvailabilityDoc[]>(),
    AvailabilityException.find({ tenantId: ctx.tenantId, status: 'ACTIVE', dateFrom: { $lte: plan.effectiveTo }, dateTo: { $gte: plan.effectiveFrom } }).session(db ?? null).lean<AvailabilityExceptionDoc[]>(),
    WorkloadRule.find(byPlan).session(db ?? null).lean<WorkloadRuleDoc[]>(),
    spaceService.listRoomInfos(ctx, plan.locationId),
    loadGroupFacts(ctx, plan),
    AcademicAssignment.find({ tenantId: ctx.tenantId, academicSessionId: plan.academicSessionId, locationId: plan.locationId, assignmentType: 'SUBJECT_FACULTY', ...openOn(day) }).session(db ?? null).lean<AcademicAssignmentDoc[]>(),
    Requirement.find(byPlan).session(db ?? null).lean<RequirementDoc[]>(),
  ]);
  const classIds = facts.classes.map((c) => c._id);
  const placed = classIds.length ? await StudentSectionAssignment.find({ tenantId: ctx.tenantId, classOfferingId: { $in: classIds }, ...openOn(day) }).session(db ?? null).select('studentId sectionId').lean<Pick<StudentSectionAssignmentDoc, 'studentId' | 'sectionId'>[]>() : [];

  const periods = buildPeriods(bell);
  const overridesByEntry = new Map<string, ConflictOverrideDoc[]>();
  for (const o of overrideDocs) overridesByEntry.set(o.entryId, [...(overridesByEntry.get(o.entryId) ?? []), o]);
  const recs: EntryRec[] = entryDocs.map((doc) => {
    const rec = toRec(doc, sectionDocs, facultyDocs);
    rec.templateId = periods.get(rec.periodId)?.templateId ?? '';
    const live = (overridesByEntry.get(rec.id) ?? []).filter((o) => o.signature === signatureOf(rec, o.rule));
    if (live.length > 0) rec.overridden = Object.fromEntries(live.map((o) => [o.rule, { reason: o.reason, signature: o.signature }]));
    return rec;
  });

  const campusTeachers = new Set(teachers.map((t) => t.employee._id));
  const teacherNames = new Map(teachers.map((t) => [t.employee._id, t.fullName]));
  const stray = [...new Set([...recs.flatMap((e) => e.teachers.map((t) => t.employeeId)), ...[...groupFacts.values()].flatMap((g) => g.teacher.employeeIds)])].filter((id) => !teacherNames.has(id));
  for (const [id, name] of await employeeNames(ctx, stray, db)) teacherNames.set(id, name);

  const rooms = new Map<string, RoomRec>(roomList.map((r) => [r.spaceId, { spaceId: r.spaceId, spaceName: r.spaceName, tags: r.tags, capacity: r.academicCapacity, usable: r.usable, reason: r.reason }]));
  const strangerIds = [...new Set(recs.map((e) => e.spaceId).filter((id): id is string => Boolean(id) && !rooms.has(id!)))];
  const strangers = await spaceService.roomCampuses(ctx, strangerIds);
  const strangerRooms = new Map([...strangers].map(([id, s]) => [id, { spaceName: s.spaceName, archived: s.archived && s.locationId === plan.locationId }]));
  const closures = await spaceService.longClosures(ctx, [...rooms.keys()], day, plan.effectiveTo);

  const homeRoom = await spaceService.homeClassroomRooms(ctx, facts.sections.map((s) => s._id), day, session.endDate);

  const sectionSize = new Map<string, number>();
  const studentSection = new Map<string, string>();
  for (const p of placed) {
    studentSection.set(p.studentId, p.sectionId);
    sectionSize.set(p.sectionId, (sectionSize.get(p.sectionId) ?? 0) + 1);
  }

  const groups = new Map<string, GroupRec>();
  for (const [id, g] of groupFacts) {
    groups.set(id, {
      id,
      name: g.group.name,
      classOfferingId: g.group.classOfferingId,
      subjectOfferingId: g.group.subjectOfferingId,
      sectionPool: g.group.sectionPool,
      members: g.members,
      teacherIds: g.teacher.status === 'OK' ? g.teacher.employeeIds : g.teacher.candidates.map((c) => c.employeeId),
      teacherStatus: g.teacher.status,
    });
  }

  const availability = new Map<string, AvailabilityDoc[]>();
  for (const a of availDocs) availability.set(a.employeeId, [...(availability.get(a.employeeId) ?? []), a]);
  const exceptions = new Map<string, AvailabilityExceptionDoc[]>();
  for (const x of exceptionDocs) exceptions.set(x.employeeId, [...(exceptions.get(x.employeeId) ?? []), x]);
  const limits = (r: Pick<WorkloadRuleDoc, 'maxPerDay' | 'maxConsecutive' | 'maxPerWeek'>): WorkloadLimits => ({ maxPerDay: r.maxPerDay, maxConsecutive: r.maxConsecutive, maxPerWeek: r.maxPerWeek });

  const requirementsBase = indexRequirements(requirementDocs, facts);
  const classRows = new Map(requirementDocs.filter((r) => r.scope === 'CLASS').map((r) => [`${r.classOfferingId}|${r.subjectOfferingId}`, valuesOf(r)]));
  const requirements: RequirementIndex = {
    forSection: requirementsBase.forSection,
    forGroup: (groupId) => {
      const own = requirementsBase.forGroup(groupId);
      if (own) return own;
      const g = groups.get(groupId);
      return g?.classOfferingId && g.subjectOfferingId ? (classRows.get(`${g.classOfferingId}|${g.subjectOfferingId}`) ?? null) : null;
    },
  };

  return {
    tenantId: ctx.tenantId,
    plan,
    versionId: version._id,
    rev: version.rev,
    day,
    facts,
    bell,
    periods,
    board: new Board(recs),
    teacherNames,
    campusTeachers,
    availability,
    exceptions,
    workloadDefault: limits({ maxPerDay: plan.defaultMaxPerDay, maxConsecutive: plan.defaultMaxConsecutive, maxPerWeek: plan.defaultMaxPerWeek }),
    workload: new Map(workloadDocs.map((w) => [w.employeeId, limits(w)])),
    rooms,
    strangerRooms,
    closures,
    homeRoom,
    sectionSize,
    studentSection,
    groups,
    assignments,
    requirements,
    outside: await loadOutside(ctx, plan, [...campusTeachers], db),
  };
}

/** The teachers' lessons in other campuses' published timetables, which overlap this plan's dates. */
async function loadOutside(ctx: ServiceContext, plan: TimetablePlanDoc, employeeIds: string[], db?: ClientSession): Promise<Map<string, OutsideLesson[]>> {
  const out = new Map<string, OutsideLesson[]>();
  if (employeeIds.length === 0) return out;
  const others = await TimetablePlan.find({ tenantId: ctx.tenantId, locationId: { $ne: plan.locationId }, status: { $ne: 'ARCHIVED' }, effectiveFrom: { $lte: plan.effectiveTo }, effectiveTo: { $gte: plan.effectiveFrom } }).session(db ?? null).lean<TimetablePlanDoc[]>();
  if (others.length === 0) return out;
  const versions = await TimetableVersion.find({ tenantId: ctx.tenantId, planId: { $in: others.map((p) => p._id) }, status: 'PUBLISHED' }).session(db ?? null).lean<TimetableVersionDoc[]>();
  if (versions.length === 0) return out;
  const rows = await EntryFaculty.find({ tenantId: ctx.tenantId, versionId: { $in: versions.map((v) => v._id) }, employeeId: { $in: employeeIds } }).session(db ?? null).lean<EntryFacultyDoc[]>();
  if (rows.length === 0) return out;
  const entries = await TimetableEntry.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.entryId) } }).select('weekday startMin endMin versionId').session(db ?? null).lean<Pick<TimetableEntryDoc, '_id' | 'weekday' | 'startMin' | 'endMin' | 'versionId'>[]>();
  const entryOf = new Map(entries.map((e) => [e._id, e]));
  const planOfVersion = new Map(versions.map((v) => [v._id, others.find((p) => p._id === v.planId)!]));
  const locations = await Location.find({ tenantId: ctx.tenantId, _id: { $in: others.map((p) => p.locationId) } }).select('displayName').lean<{ _id: string; displayName: string }[]>();
  const nameOf = new Map(locations.map((l) => [l._id, l.displayName]));
  for (const r of rows) {
    const e = entryOf.get(r.entryId);
    const p = planOfVersion.get(r.versionId);
    if (!e || !p) continue;
    const list = out.get(r.employeeId) ?? [];
    list.push({ weekday: e.weekday as Weekday, startMin: e.startMin, endMin: e.endMin, locationName: nameOf.get(p.locationId) ?? 'another campus', from: p.effectiveFrom, to: p.effectiveTo });
    out.set(r.employeeId, list);
  }
  return out;
}

/** The teachers Assign Classes allows for a subject in a section: the section's own teachers if it has any, else the class's. */
export function teachersFor(snap: Pick<Snapshot, 'assignments' | 'facts'>, sectionId: string, subjectOfferingId: string): string[] {
  const section = snap.facts.sectionOf.get(sectionId);
  if (!section) return [];
  const rows = snap.assignments.filter((a) => a.subjectOfferingId === subjectOfferingId && (a.sectionId === sectionId || (a.sectionId === null && a.classOfferingId === section.classOfferingId)));
  const own = rows.filter((a) => a.sectionId === sectionId);
  return [...new Set((own.length > 0 ? own : rows).map((a) => a.employeeId))].sort();
}
