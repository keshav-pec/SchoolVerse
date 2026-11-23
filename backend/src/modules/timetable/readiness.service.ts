import {
  READINESS_AREAS,
  READINESS_AREA_LABELS,
  SPACE_SUITABILITY_TAGS,
  type ReadinessArea,
  type ReadinessFixAction,
  type RequirementValuesDTO,
  type SuitabilityTagCode,
  type TimetableReadinessAreaDTO,
  type TimetableReadinessDTO,
  type TimetableReadinessItemDTO,
} from '@shared';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AcademicAssignment, type AcademicAssignmentDoc } from '../staff/assignment.models';
import { todayFor } from '../staff/status';
import { clampDate } from '../spaces/sections';
import { spaceService } from '../spaces/spaceService';
import { loadBellContext, resolveBell, weekSlots } from './bell.resolve';
import { loadPlanFacts, loadPlanTeachers, sectionLabelOf, subjectNameOf } from './facts';
import { groupsNeedingTeacher } from './group.service';
import { loadSession, readablePlan } from './guards';
import { BellSchedule } from './models';
import { effectiveBySection } from './requirement.service';

/**
 * TT-UX-01 — "Is the timetable ready to build?" Four areas, each with a plain list of what is missing and a button that fixes it.
 * It only reads. It is cheap enough to call on every page open. Rooms and teachers are asked from the modules that own them.
 */

const FIX: Record<ReadinessFixAction, { label: string; path: string }> = {
  CREATE_PLAN: { label: 'Create Timetable Plan', path: '/timetable' },
  OPEN_GROUPS: { label: 'Open Teaching Groups', path: '/timetable/setup?tab=groups' },
  SET_SCHOOL_WEEK: { label: 'Set School Week', path: '/timetable/setup?tab=week' },
  SET_DAILY_PERIODS: { label: 'Set Daily Periods', path: '/timetable/setup?tab=periods' },
  ASSIGN_DAILY_PERIODS: { label: 'Choose Daily Periods', path: '/timetable/setup?tab=periods' },
  SET_SUBJECT_NEEDS: { label: 'Set Subject Needs', path: '/timetable/setup?tab=needs' },
  ASSIGN_CLASSES: { label: 'Go To Assign Classes', path: '/people' },
  CLASSROOM_ALLOCATION: { label: 'Go To Classroom Allocation', path: '/spaces/allocation' },
  SPACE_SETUP: { label: 'Go To Space Setup', path: '/spaces' },
  ACADEMIC_SETUP: { label: 'Go To Academic Setup', path: '/academics' },
};

const tagLabel = (code: string) => SPACE_SUITABILITY_TAGS.find((t) => t.code === code)?.label ?? code;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const examplesOf = (list: string[], max = 3) => (list.length > max ? [...list.slice(0, max), `and ${list.length - max} more`] : list);

function item(code: string, key: string, severity: TimetableReadinessItemDTO['severity'], message: string, count: number, examples: string[], action: ReadinessFixAction, query = ''): TimetableReadinessItemDTO {
  return { key: `${code}:${key}`, code, severity, message, count, examples: examplesOf(examples), fix: { action, label: FIX[action].label, path: `${FIX[action].path}${query ? `${FIX[action].path.includes('?') ? '&' : '?'}${query}` : ''}` } };
}

export async function planReadiness(ctx: ServiceContext, planId: string): Promise<TimetableReadinessDTO> {
  const plan = await readablePlan(ctx, planId);
  const today = await todayFor(ctx);
  const day = clampDate(today, plan.effectiveFrom, plan.effectiveTo);
  const [facts, bell, teachers, session, specialGroups] = await Promise.all([
    loadPlanFacts(ctx, plan),
    loadBellContext(ctx, plan),
    loadPlanTeachers(ctx, plan, { anyCategory: true }),
    loadSession(ctx, plan.academicSessionId),
    groupsNeedingTeacher(ctx, plan),
  ]);
  const effective = await effectiveBySection(ctx, plan, facts);
  const classLabel = (classId: string) => facts.classOf.get(classId)?.displayName ?? 'Class';
  const items: Record<ReadinessArea, TimetableReadinessItemDTO[]> = { CLASSES_SUBJECTS: [], TEACHERS: [], ROOMS: [], TIME: [] };

  // ── Classes & Subjects
  if (facts.sections.length === 0) items.CLASSES_SUBJECTS.push(item('NO_SECTIONS', plan._id, 'BLOCKER', 'This campus has no active classes with sections in this session yet.', 0, [], 'ACADEMIC_SETUP'));
  for (const klass of facts.classes) {
    const sections = facts.sections.filter((s) => s.classOfferingId === klass._id);
    if (sections.length === 0) continue;
    const offerings = facts.subjectOfferings.filter((o) => o.classOfferingId === klass._id);
    if (offerings.length === 0) {
      items.CLASSES_SUBJECTS.push(item('NO_SUBJECTS', klass._id, 'BLOCKER', `${klass.displayName} has no subjects yet.`, 0, [], 'ACADEMIC_SETUP'));
      continue;
    }
    const missing = offerings.filter((o) => sections.some((s) => !effective.get(s._id)?.has(o._id)));
    if (missing.length > 0) items.CLASSES_SUBJECTS.push(item('NO_SUBJECT_NEEDS', klass._id, 'BLOCKER', `${klass.displayName}: ${plural(missing.length, 'subject')} ${missing.length === 1 ? 'has' : 'have'} no Subject Needs yet.`, missing.length, missing.map((o) => subjectNameOf(facts, o._id)), 'SET_SUBJECT_NEEDS', `classOfferingId=${klass._id}`));
  }

  // ── Teachers: exactly one valid teacher for every section subject that has periods
  const assignments = await AcademicAssignment.find({
    tenantId: ctx.tenantId,
    academicSessionId: plan.academicSessionId,
    locationId: plan.locationId,
    assignmentType: 'SUBJECT_FACULTY',
    cancelledAt: null,
    effectiveFrom: { $lte: day },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: day } }],
  }).lean<AcademicAssignmentDoc[]>();
  const campusTeachers = new Set(teachers.map((t) => t.employee._id));
  const noTeacher = new Map<string, string[]>();
  const severalTeachers = new Map<string, string[]>();
  const otherCampus = new Set<string>();
  const teacherPairs = new Set<string>();
  const seenSubjects = new Set<string>();
  for (const section of facts.sections) {
    for (const [offeringId, values] of effective.get(section._id) ?? []) {
      if (values.periodsPerWeek <= 0) continue;
      seenSubjects.add(offeringId);
      const rows = assignments.filter((a) => a.subjectOfferingId === offeringId && (a.sectionId === section._id || (a.sectionId === null && a.classOfferingId === section.classOfferingId)));
      const own = rows.filter((a) => a.sectionId === section._id);
      const chosen = [...new Set((own.length ? own : rows).map((a) => a.employeeId))];
      const label = `${sectionLabelOf(facts, section._id)} ${subjectNameOf(facts, offeringId)}`;
      if (chosen.length === 0) noTeacher.set(section.classOfferingId, [...(noTeacher.get(section.classOfferingId) ?? []), label]);
      else if (chosen.length > 1) severalTeachers.set(section.classOfferingId, [...(severalTeachers.get(section.classOfferingId) ?? []), label]);
      for (const id of chosen) {
        teacherPairs.add(id);
        if (!campusTeachers.has(id)) otherCampus.add(id);
      }
    }
  }
  for (const [classId, labels] of noTeacher) items.TEACHERS.push(item('NO_TEACHER', classId, 'WARNING', `${classLabel(classId)}: ${plural(labels.length, 'lesson subject')} ${labels.length === 1 ? 'has' : 'have'} no teacher.`, labels.length, labels, 'ASSIGN_CLASSES'));
  for (const [classId, labels] of severalTeachers) items.TEACHERS.push(item('PICK_TEACHER', classId, 'WARNING', `${classLabel(classId)}: ${plural(labels.length, 'subject')} ${labels.length === 1 ? 'has' : 'have'} two teachers. Pick one.`, labels.length, labels, 'ASSIGN_CLASSES'));
  if (otherCampus.size > 0) items.TEACHERS.push(item('TEACHER_OTHER_CAMPUS', plan._id, 'WARNING', `${plural(otherCampus.size, 'teacher')} taking classes here ${otherCampus.size === 1 ? 'is' : 'are'} not assigned to this campus.`, otherCampus.size, [], 'ASSIGN_CLASSES'));
  for (const { group, teacher } of specialGroups) items.TEACHERS.push(item('GROUP_TEACHER', group._id, 'WARNING', teacher.status === 'PICK_ONE' ? `${group.name}: pick one of ${teacher.candidates.length} teachers.` : `${group.name} has no teacher yet.`, 1, teacher.candidates.map((c) => c.fullName), 'OPEN_GROUPS', `groupId=${group._id}`));

  // ── Rooms
  const sectionIds = facts.sections.map((s) => s._id);
  const [withHome, rooms, roomReadiness] = await Promise.all([
    spaceService.sectionsWithHomeClassroom(ctx, sectionIds, day, session.endDate),
    spaceService.listSchedulableRooms(ctx, plan.locationId),
    spaceService.readiness(ctx, plan.locationId),
  ]);
  const noHome = facts.sections.filter((s) => !withHome.has(s._id));
  if (noHome.length > 0) items.ROOMS.push(item('NO_HOME_CLASSROOM', plan._id, 'WARNING', `${plural(noHome.length, 'section')} ${noHome.length === 1 ? 'has' : 'have'} no Home Classroom.`, noHome.length, noHome.map((s) => sectionLabelOf(facts, s._id)), 'CLASSROOM_ALLOCATION'));
  const neededTags = new Set<SuitabilityTagCode>();
  for (const perSection of effective.values()) for (const v of perSection.values() as Iterable<RequirementValuesDTO>) for (const tag of v.neededSuitability) if (tag !== 'GENERAL_TEACHING') neededTags.add(tag);
  for (const tag of [...neededTags].sort()) if (!rooms.some((r) => r.tags.includes(tag))) items.ROOMS.push(item('NO_ROOM_KIND', tag, 'WARNING', `Some subjects need a room for "${tagLabel(tag)}", but no open room is set up for it.`, 1, [], 'SPACE_SETUP'));
  const noCapacity = roomReadiness.items.filter((r) => r.missing.some((m) => m.code === 'ACADEMIC_CAPACITY'));
  if (noCapacity.length > 0) items.ROOMS.push(item('ROOMS_NO_CAPACITY', plan._id, 'WARNING', `${plural(noCapacity.length, 'room')} ${noCapacity.length === 1 ? 'has' : 'have'} no seat count, so we cannot check if students fit.`, noCapacity.length, noCapacity.map((r) => r.spaceName), 'SPACE_SETUP'));
  const specialRooms = rooms.filter((r) => r.tags.some((t) => t !== 'GENERAL_TEACHING')).length;

  // ── Time
  if (plan.operatingDays.length === 0) items.TIME.push(item('NO_OPERATING_DAYS', plan._id, 'BLOCKER', 'Choose the days the school runs.', 0, [], 'SET_SCHOOL_WEEK'));
  const templates = await BellSchedule.countDocuments({ tenantId: ctx.tenantId, planId, status: 'ACTIVE' });
  if (templates === 0) items.TIME.push(item('NO_DAILY_PERIODS', plan._id, 'BLOCKER', 'Daily Periods are not set up yet.', 0, [], 'SET_DAILY_PERIODS'));
  else {
    const unresolved = facts.sections.filter((s) => plan.operatingDays.some((d) => !resolveBell(bell, s.classOfferingId, s._id, d)));
    if (unresolved.length > 0) items.TIME.push(item('NO_PERIODS_FOR_SECTIONS', plan._id, 'BLOCKER', `${plural(unresolved.length, 'section')} ${unresolved.length === 1 ? 'has' : 'have'} no Daily Periods on some school days.`, unresolved.length, unresolved.map((s) => sectionLabelOf(facts, s._id)), 'ASSIGN_DAILY_PERIODS'));
    const tooMany = new Map<string, string[]>();
    for (const s of facts.sections) {
      const slots = weekSlots(bell, s.classOfferingId, s._id);
      const needed = [...(effective.get(s._id)?.values() ?? [])].reduce((n, v) => n + v.periodsPerWeek, 0);
      if (slots !== null && needed > slots) tooMany.set(s.classOfferingId, [...(tooMany.get(s.classOfferingId) ?? []), `${sectionLabelOf(facts, s._id)} needs ${needed}, the week has ${slots}`]);
    }
    for (const [classId, labels] of tooMany) items.TIME.push(item('TOO_MANY_PERIODS', classId, 'BLOCKER', `${classLabel(classId)}: the subjects need more periods than the week has.`, labels.length, labels, 'SET_SUBJECT_NEEDS', `classOfferingId=${classId}`));
  }

  const areas: TimetableReadinessAreaDTO[] = READINESS_AREAS.map((area) => ({
    area,
    label: READINESS_AREA_LABELS[area],
    status: items[area].length === 0 ? 'READY' : 'NEEDS_ACTION',
    summary: items[area].length === 0 ? 'All set' : plural(items[area].length, 'thing') + ' to fix',
    items: items[area],
  }));
  const needsActions = areas.reduce((n, a) => n + a.items.length, 0);
  const anyNeeds = [...effective.values()].some((m) => [...m.values()].some((v) => v.periodsPerWeek > 0));
  const blockedBy: string[] = [];
  if (items.TIME.length > 0) blockedBy.push('Time is not ready: fix the Daily Periods first.');
  if (!anyNeeds) blockedBy.push('No Subject Needs are set yet.');

  return {
    planId,
    ready: needsActions === 0,
    needsActions,
    message: needsActions === 0 ? 'Ready to build' : `Timetable setup needs ${plural(needsActions, 'action')}`,
    areas,
    canSmartDraft: blockedBy.length === 0,
    smartDraftBlockedBy: blockedBy,
    counts: { sections: facts.sections.length, subjects: seenSubjects.size, teachers: teacherPairs.size, homeClassrooms: withHome.size, specialRooms },
  };
}
