import {
  type CreateTeachingGroupData,
  type GroupHealthDTO,
  type GroupHealthStudentDTO,
  type GroupMemberDTO,
  type GroupMemberListDTO,
  type GroupMembersData,
  type GroupTeacherDTO,
  type TeachingGroupDTO,
  type UpdateTeachingGroupData,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { AcademicAssignment, type AcademicAssignmentDoc } from '../staff/assignment.models';
import { todayFor } from '../staff/status';
import { Person, type PersonDoc } from '../staff/person.model';
import { fullNameOf } from '../students/directory';
import { Student, StudentAdmission, StudentSectionAssignment, StudentSubjectEnrollment, type StudentAdmissionDoc, type StudentDoc, type StudentSectionAssignmentDoc, type StudentSubjectEnrollmentDoc } from '../students/student.models';
import { clampDate } from '../spaces/sections';
import { recordTimetableAudit } from './audit';
import { employeeNames, loadPlanFacts, requirePlanClass, requirePlanTeacher, sectionLabelOf, subjectNameOf, type PlanFacts } from './facts';
import { assertVersion, readablePlan, writablePlan } from './guards';
import { GroupMembership, TeachingGroup, type GroupMembershipDoc, type TeachingGroupDoc, type TimetablePlanDoc } from './models';

/** TT-18, TT-19 — Teaching Groups: students from many sections who learn together. Members are worked out from subject choice; only hand-added ones are stored. */

const openOn = (day: string) => ({ cancelledAt: null, effectiveFrom: { $lte: day }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: day } }] });

/** The day members are counted for: today, held inside the plan's dates. */
async function memberDay(ctx: ServiceContext, plan: Pick<TimetablePlanDoc, 'effectiveFrom' | 'effectiveTo'>): Promise<string> {
  return clampDate(await todayFor(ctx), plan.effectiveFrom, plan.effectiveTo);
}

interface Taker {
  studentId: string;
  sectionId: string;
}

/** Everyone in a class who has chosen the subject today, with the section they sit in. */
async function loadTakers(ctx: ServiceContext, classOfferingId: string, subjectOfferingId: string, day: string): Promise<Taker[]> {
  const placements = await StudentSectionAssignment.find({ tenantId: ctx.tenantId, classOfferingId, ...openOn(day) }).lean<StudentSectionAssignmentDoc[]>();
  if (placements.length === 0) return [];
  const enrolled = await StudentSubjectEnrollment.find({ tenantId: ctx.tenantId, subjectOfferingId, enrollmentId: { $in: placements.map((p) => p.enrollmentId) }, ...openOn(day) }).select('enrollmentId').lean<Pick<StudentSubjectEnrollmentDoc, 'enrollmentId'>[]>();
  const ok = new Set(enrolled.map((e) => e.enrollmentId));
  return placements.filter((p) => ok.has(p.enrollmentId)).map((p) => ({ studentId: p.studentId, sectionId: p.sectionId }));
}

interface Sets {
  computed: Set<string>;
  manual: Set<string>;
  all: Set<string>;
}

interface GroupState {
  group: TeachingGroupDoc;
  takers: Taker[];
  sets: Sets;
}

async function loadStates(ctx: ServiceContext, groups: TeachingGroupDoc[], day: string): Promise<Map<string, GroupState>> {
  const manualRows = groups.length ? await GroupMembership.find({ tenantId: ctx.tenantId, groupId: { $in: groups.map((g) => g._id) } }).lean<GroupMembershipDoc[]>() : [];
  const takerCache = new Map<string, Promise<Taker[]>>();
  const takersFor = (g: TeachingGroupDoc): Promise<Taker[]> => {
    if (!g.classOfferingId || !g.subjectOfferingId) return Promise.resolve([]);
    const key = `${g.classOfferingId}:${g.subjectOfferingId}`;
    if (!takerCache.has(key)) takerCache.set(key, loadTakers(ctx, g.classOfferingId, g.subjectOfferingId, day));
    return takerCache.get(key)!;
  };
  const out = new Map<string, GroupState>();
  for (const group of groups) {
    const takers = await takersFor(group);
    const pool = new Set(group.sectionPool);
    const computed = new Set(group.kind === 'ACTIVITY' ? [] : takers.filter((t) => pool.has(t.sectionId)).map((t) => t.studentId));
    const manual = new Set(manualRows.filter((m) => m.groupId === group._id).map((m) => m.studentId));
    out.set(group._id, { group, takers, sets: { computed, manual, all: new Set([...computed, ...manual]) } });
  }
  return out;
}

// ───────────────────────────────────────────────────────────── teacher

async function teacherOf(ctx: ServiceContext, plan: TimetablePlanDoc, group: TeachingGroupDoc, day: string): Promise<GroupTeacherDTO> {
  if (group.teacherIds.length > 0) {
    const names = await employeeNames(ctx, group.teacherIds);
    return { status: 'OK', source: 'CHOSEN', employeeIds: group.teacherIds, names: group.teacherIds.map((id) => names.get(id) ?? 'Unknown'), candidates: [] };
  }
  if (!group.subjectOfferingId) return { status: 'MISSING', source: null, employeeIds: [], names: [], candidates: [] };
  const rows = await AcademicAssignment.find({
    tenantId: ctx.tenantId,
    assignmentType: 'SUBJECT_FACULTY',
    subjectOfferingId: group.subjectOfferingId,
    locationId: plan.locationId,
    ...openOn(day),
    $and: [{ $or: [{ sectionId: { $in: group.sectionPool } }, { sectionId: null, classOfferingId: group.classOfferingId }] }],
  }).lean<AcademicAssignmentDoc[]>();
  const ids = [...new Set(rows.map((r) => r.employeeId))];
  const names = await employeeNames(ctx, ids);
  const candidates = ids.map((employeeId) => ({ employeeId, fullName: names.get(employeeId) ?? 'Unknown' }));
  if (ids.length === 1) return { status: 'OK', source: 'ASSIGNMENT', employeeIds: ids, names: [names.get(ids[0]!) ?? 'Unknown'], candidates };
  return { status: ids.length === 0 ? 'MISSING' : 'PICK_ONE', source: null, employeeIds: [], names: [], candidates };
}

// ───────────────────────────────────────────────────────────── health

interface Health {
  notInAnyGroup: string[];
  leftSection: string[];
  inTwoGroups: string[];
}

async function healthOf(ctx: ServiceContext, state: GroupState, states: Map<string, GroupState>, day: string): Promise<Health> {
  const { group, takers, sets } = state;
  const same = [...states.values()].filter((s) => s.group._id !== group._id && s.group.status === 'ACTIVE' && s.group.subjectOfferingId && s.group.subjectOfferingId === group.subjectOfferingId);
  const elsewhere = new Set(same.flatMap((s) => [...s.sets.all]));
  const inAny = new Set([...sets.all, ...elsewhere]);
  const notInAnyGroup = group.subjectOfferingId ? [...new Set(takers.map((t) => t.studentId))].filter((id) => !inAny.has(id)) : [];
  const inTwoGroups = [...sets.all].filter((id) => elsewhere.has(id));
  let leftSection: string[] = [];
  if (sets.manual.size > 0 && group.sectionPool.length > 0) {
    const placements = await StudentSectionAssignment.find({ tenantId: ctx.tenantId, studentId: { $in: [...sets.manual] }, ...openOn(day) }).select('studentId sectionId').lean<Pick<StudentSectionAssignmentDoc, 'studentId' | 'sectionId'>[]>();
    const pool = new Set(group.sectionPool);
    const here = new Set(placements.filter((p) => pool.has(p.sectionId)).map((p) => p.studentId));
    leftSection = [...sets.manual].filter((id) => !here.has(id));
  }
  return { notInAnyGroup, leftSection, inTwoGroups };
}

function badgeOf(health: Health, teacher: GroupTeacherDTO): string | null {
  const n = health.notInAnyGroup.length;
  if (n > 0) return `${n} student${n === 1 ? '' : 's'} not in any group`;
  if (health.leftSection.length > 0) return `${health.leftSection.length} member${health.leftSection.length === 1 ? '' : 's'} left the section`;
  if (health.inTwoGroups.length > 0) return `${health.inTwoGroups.length} student${health.inTwoGroups.length === 1 ? ' is' : 's are'} in two groups`;
  if (teacher.status === 'MISSING') return 'No teacher yet';
  if (teacher.status === 'PICK_ONE') return 'Pick a teacher';
  return null;
}

// ───────────────────────────────────────────────────────────── mapping

async function toGroupDTOs(ctx: ServiceContext, plan: TimetablePlanDoc, facts: PlanFacts, groups: TeachingGroupDoc[], allStates?: Map<string, GroupState>): Promise<TeachingGroupDTO[]> {
  if (groups.length === 0) return [];
  const day = await memberDay(ctx, plan);
  const states = allStates ?? (await loadStates(ctx, groups, day));
  const out: TeachingGroupDTO[] = [];
  for (const group of groups) {
    const state = states.get(group._id)!;
    const [teacher, health] = await Promise.all([teacherOf(ctx, plan, group, day), healthOf(ctx, state, states, day)]);
    out.push({
      groupId: group._id,
      planId: group.planId,
      name: group.name,
      kind: group.kind,
      classOfferingId: group.classOfferingId,
      className: group.classOfferingId ? (facts.classOf.get(group.classOfferingId)?.displayName ?? null) : null,
      subjectOfferingId: group.subjectOfferingId,
      subjectName: group.subjectOfferingId ? subjectNameOf(facts, group.subjectOfferingId) : null,
      sectionPool: group.sectionPool.map((id) => ({ sectionOfferingId: id, label: sectionLabelOf(facts, id) })),
      teacher,
      memberCount: state.sets.all.size,
      manualCount: state.sets.manual.size,
      healthBadge: group.status === 'ACTIVE' ? badgeOf(health, teacher) : null,
      status: group.status,
      version: group.version,
    });
  }
  return out;
}

async function loadGroup(ctx: ServiceContext, groupId: string, db?: import('mongoose').ClientSession): Promise<TeachingGroupDoc> {
  const doc = await TeachingGroup.findOne({ _id: groupId, tenantId: ctx.tenantId }).session(db ?? null).lean<TeachingGroupDoc>();
  if (!doc) throw AppError.notFound('Teaching Group not found.');
  return doc;
}

// ───────────────────────────────────────────────────────────── validation

const invalid = (message: string, field?: string) => new AppError('GROUP_INVALID', message, field ? { fields: { [field]: message } } : undefined);

async function checkShape(ctx: ServiceContext, plan: TimetablePlanDoc, facts: PlanFacts, input: { kind: TeachingGroupDoc['kind']; classOfferingId: string | null; subjectOfferingId: string | null; sectionPool: string[]; teacherIds: string[] }) {
  if (input.kind !== 'ACTIVITY' && (!input.classOfferingId || !input.subjectOfferingId)) throw invalid('Choose the class and the subject this group learns.', 'subjectOfferingId');
  if (input.classOfferingId) await requirePlanClass(ctx, plan, input.classOfferingId);
  if (input.subjectOfferingId) {
    const offering = facts.offeringOf.get(input.subjectOfferingId);
    if (!offering || offering.classOfferingId !== input.classOfferingId) throw invalid('This subject is not offered in that class.', 'subjectOfferingId');
  }
  for (const id of input.sectionPool) {
    const section = facts.sectionOf.get(id);
    if (!section) throw invalid('One of the sections is not part of this plan.', 'sectionPool');
    if (input.classOfferingId && section.classOfferingId !== input.classOfferingId) throw invalid('The sections must all be in the group\'s class.', 'sectionPool');
  }
  if (input.kind !== 'ACTIVITY' && input.sectionPool.length === 0) throw invalid('Choose the sections these students come from.', 'sectionPool');
  for (const id of input.teacherIds) await requirePlanTeacher(ctx, plan, id);
}

// ───────────────────────────────────────────────────────────── routes' functions

export async function createGroup(ctx: ServiceContext, data: CreateTeachingGroupData): Promise<TeachingGroupDTO> {
  const plan = await writablePlan(ctx, data.planId);
  const facts = await loadPlanFacts(ctx, plan);
  const input = { kind: data.kind, classOfferingId: data.classOfferingId ?? null, subjectOfferingId: data.kind === 'ACTIVITY' ? null : (data.subjectOfferingId ?? null), sectionPool: [...new Set(data.sectionPool)], teacherIds: [...new Set(data.teacherIds ?? [])] };
  await checkShape(ctx, plan, facts, input);
  const id = await withTransaction(async (db) => {
    const [doc] = await TeachingGroup.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, planId: plan._id, academicSessionId: plan.academicSessionId, locationId: plan.locationId, name: data.name, nameKey: data.name.toLowerCase(), ...input, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await recordTimetableAudit(ctx, db, { entityType: 'teaching_group', entityId: doc!._id, action: 'teaching_group.created', planId: plan._id, locationId: plan.locationId, metadata: { name: data.name, kind: data.kind, sections: input.sectionPool.length } });
    return doc!._id;
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('nameKey')) throw new AppError('GROUP_NAME_TAKEN');
    throw err;
  });
  return getGroup(ctx, id);
}

export async function listGroups(ctx: ServiceContext, planId: string, includeArchived = false): Promise<TeachingGroupDTO[]> {
  const plan = await readablePlan(ctx, planId);
  const groups = await TeachingGroup.find({ tenantId: ctx.tenantId, planId, ...(includeArchived ? {} : { status: 'ACTIVE' }) }).sort({ name: 1 }).lean<TeachingGroupDoc[]>();
  return toGroupDTOs(ctx, plan, await loadPlanFacts(ctx, plan), groups);
}

export async function getGroup(ctx: ServiceContext, groupId: string): Promise<TeachingGroupDTO> {
  const group = await loadGroup(ctx, groupId);
  const plan = await readablePlan(ctx, group.planId);
  const siblings = group.subjectOfferingId ? await TeachingGroup.find({ tenantId: ctx.tenantId, planId: plan._id, status: 'ACTIVE', subjectOfferingId: group.subjectOfferingId }).lean<TeachingGroupDoc[]>() : [];
  const all = [group, ...siblings.filter((s) => s._id !== group._id)];
  const day = await memberDay(ctx, plan);
  const states = await loadStates(ctx, all, day);
  return (await toGroupDTOs(ctx, plan, await loadPlanFacts(ctx, plan), [group], states))[0]!;
}

export async function updateGroup(ctx: ServiceContext, groupId: string, data: UpdateTeachingGroupData): Promise<TeachingGroupDTO> {
  const before = await loadGroup(ctx, groupId);
  const plan = await writablePlan(ctx, before.planId);
  assertVersion(before.version, data.version);
  const facts = await loadPlanFacts(ctx, plan);
  const { version: _version, ...rest } = data;
  const patch = pickDefined(rest);
  const next = { ...before, ...patch, sectionPool: patch.sectionPool ? [...new Set(patch.sectionPool)] : before.sectionPool, teacherIds: patch.teacherIds ? [...new Set(patch.teacherIds)] : before.teacherIds };
  if (patch.sectionPool || patch.teacherIds) await checkShape(ctx, plan, facts, next);
  await withTransaction(async (db) => {
    const changes = diffFields(before, next, ['name', 'sectionPool', 'teacherIds', 'status'] as const);
    if (changes.length === 0) return;
    const updated = await TeachingGroup.findOneAndUpdate(
      { _id: groupId, tenantId: ctx.tenantId, version: data.version },
      { $set: { ...(patch.name ? { name: patch.name, nameKey: patch.name.toLowerCase() } : {}), sectionPool: next.sectionPool, teacherIds: next.teacherIds, ...(patch.status ? { status: patch.status } : {}), updatedBy: ctx.userId }, $inc: { version: 1 } },
      { returnDocument: 'after', session: db },
    ).lean();
    if (!updated) throw new AppError('VERSION_CONFLICT');
    await recordTimetableAudit(ctx, db, { entityType: 'teaching_group', entityId: groupId, action: 'teaching_group.updated', changes, planId: plan._id, locationId: plan.locationId });
  }).catch((err: unknown) => {
    if (duplicateKeyFields(err)?.includes('nameKey')) throw new AppError('GROUP_NAME_TAKEN');
    throw err;
  });
  return getGroup(ctx, groupId);
}

async function studentLabels(ctx: ServiceContext, studentIds: string[]): Promise<Map<string, { fullName: string; admissionNumber: string | null }>> {
  if (studentIds.length === 0) return new Map();
  const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: studentIds } }).select('personId').lean<Pick<StudentDoc, '_id' | 'personId'>[]>();
  const [people, admissions] = await Promise.all([
    Person.find({ tenantId: ctx.tenantId, _id: { $in: students.map((s) => s.personId) } }).lean<PersonDoc[]>(),
    StudentAdmission.find({ tenantId: ctx.tenantId, studentId: { $in: studentIds }, isCurrent: true }).select('studentId admissionNumber').lean<Pick<StudentAdmissionDoc, 'studentId' | 'admissionNumber'>[]>(),
  ]);
  const personOf = new Map(people.map((p) => [p._id, p]));
  const numberOf = new Map(admissions.map((a) => [a.studentId, a.admissionNumber]));
  return new Map(students.map((s) => [s._id, { fullName: personOf.get(s.personId) ? fullNameOf(personOf.get(s.personId)!) : 'Unknown', admissionNumber: numberOf.get(s._id) ?? null }]));
}

async function sectionOfStudents(ctx: ServiceContext, studentIds: string[], day: string): Promise<Map<string, string>> {
  if (studentIds.length === 0) return new Map();
  const rows = await StudentSectionAssignment.find({ tenantId: ctx.tenantId, studentId: { $in: studentIds }, ...openOn(day) }).select('studentId sectionId').lean<Pick<StudentSectionAssignmentDoc, 'studentId' | 'sectionId'>[]>();
  return new Map(rows.map((r) => [r.studentId, r.sectionId]));
}

export async function listMembers(ctx: ServiceContext, groupId: string, page: number, pageSize: number): Promise<GroupMemberListDTO> {
  const group = await loadGroup(ctx, groupId);
  const plan = await readablePlan(ctx, group.planId);
  const day = await memberDay(ctx, plan);
  const states = await loadStates(ctx, [group], day);
  const { sets } = states.get(groupId)!;
  const ids = [...sets.all];
  const [labels, sections, facts] = await Promise.all([studentLabels(ctx, ids), sectionOfStudents(ctx, ids, day), loadPlanFacts(ctx, plan)]);
  const all: GroupMemberDTO[] = ids
    .map((studentId) => ({ studentId, fullName: labels.get(studentId)?.fullName ?? 'Unknown', admissionNumber: labels.get(studentId)?.admissionNumber ?? null, sectionLabel: sections.get(studentId) ? sectionLabelOf(facts, sections.get(studentId)!) : null, source: (sets.computed.has(studentId) ? 'SUBJECT_CHOICE' : 'MANUAL') as GroupMemberDTO['source'] }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));
  return { items: all.slice((page - 1) * pageSize, page * pageSize), total: all.length, page, pageSize };
}

export async function changeMembers(ctx: ServiceContext, groupId: string, data: GroupMembersData): Promise<{ added: number; removed: number }> {
  const group = await loadGroup(ctx, groupId);
  const plan = await writablePlan(ctx, group.planId);
  const add = [...new Set(data.add)].filter((id) => !data.remove.includes(id));
  if (add.length > 0) {
    const found = await Student.find({ tenantId: ctx.tenantId, _id: { $in: add } }).select('_id').lean<{ _id: string }[]>();
    if (found.length !== add.length) throw AppError.notFound('One of these students was not found.');
    const facts = await loadPlanFacts(ctx, plan);
    const day = await memberDay(ctx, plan);
    const placed = await sectionOfStudents(ctx, add, day);
    const elsewhere = add.filter((id) => !placed.has(id) || !facts.sectionOf.has(placed.get(id)!));
    if (elsewhere.length > 0) throw new AppError('WRONG_CAMPUS', `${elsewhere.length} student${elsewhere.length === 1 ? ' is' : 's are'} not in a class at this campus.`, { studentIds: elsewhere });
  }
  const result = await withTransaction(async (db) => {
    let added = 0;
    for (const studentId of add) {
      const exists = await GroupMembership.exists({ tenantId: ctx.tenantId, groupId, studentId }).session(db);
      if (exists) continue;
      await GroupMembership.create([{ tenantId: ctx.tenantId, schoolId: plan.schoolId, groupId, studentId, source: 'MANUAL', addedBy: ctx.userId, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
      added += 1;
    }
    const removedRows = data.remove.length ? await GroupMembership.deleteMany({ tenantId: ctx.tenantId, groupId, studentId: { $in: data.remove } }, { session: db }) : { deletedCount: 0 };
    if (added > 0 || removedRows.deletedCount > 0) await recordTimetableAudit(ctx, db, { entityType: 'teaching_group', entityId: groupId, action: 'teaching_group.members_changed', planId: plan._id, locationId: plan.locationId, metadata: { added, removed: removedRows.deletedCount } });
    return { added, removed: removedRows.deletedCount };
  });
  return result;
}

export async function groupHealth(ctx: ServiceContext, groupId: string): Promise<GroupHealthDTO> {
  const group = await loadGroup(ctx, groupId);
  const plan = await readablePlan(ctx, group.planId);
  const day = await memberDay(ctx, plan);
  const siblings = group.subjectOfferingId ? await TeachingGroup.find({ tenantId: ctx.tenantId, planId: plan._id, status: 'ACTIVE', subjectOfferingId: group.subjectOfferingId }).lean<TeachingGroupDoc[]>() : [];
  const states = await loadStates(ctx, [group, ...siblings.filter((s) => s._id !== group._id)], day);
  const health = await healthOf(ctx, states.get(groupId)!, states, day);
  const ids = [...new Set([...health.notInAnyGroup, ...health.leftSection, ...health.inTwoGroups])];
  const [labels, sections, facts] = await Promise.all([studentLabels(ctx, ids), sectionOfStudents(ctx, ids, day), loadPlanFacts(ctx, plan)]);
  const row = (studentId: string): GroupHealthStudentDTO => ({ studentId, fullName: labels.get(studentId)?.fullName ?? 'Unknown', admissionNumber: labels.get(studentId)?.admissionNumber ?? null, sectionLabel: sections.get(studentId) ? sectionLabelOf(facts, sections.get(studentId)!) : null });
  const byName = (a: GroupHealthStudentDTO, b: GroupHealthStudentDTO) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' });
  return {
    groupId,
    notInAnyGroup: health.notInAnyGroup.map(row).sort(byName),
    leftSection: health.leftSection.map(row).sort(byName),
    inTwoGroups: health.inTwoGroups.map(row).sort(byName),
    healthy: health.notInAnyGroup.length + health.leftSection.length + health.inTwoGroups.length === 0,
  };
}

/** For the readiness check: groups with their teacher problems, without the student counts. */
export async function groupsNeedingTeacher(ctx: ServiceContext, plan: TimetablePlanDoc): Promise<{ group: TeachingGroupDoc; teacher: GroupTeacherDTO }[]> {
  const groups = await TeachingGroup.find({ tenantId: ctx.tenantId, planId: plan._id, status: 'ACTIVE' }).lean<TeachingGroupDoc[]>();
  const day = await memberDay(ctx, plan);
  const out: { group: TeachingGroupDoc; teacher: GroupTeacherDTO }[] = [];
  for (const group of groups) {
    const teacher = await teacherOf(ctx, plan, group, day);
    if (teacher.status !== 'OK') out.push({ group, teacher });
  }
  return out;
}

/** For the clash checker: every active group of the plan with the students in it today and the teachers it may use. */
export interface GroupFacts {
  group: TeachingGroupDoc;
  members: Set<string>;
  teacher: GroupTeacherDTO;
}

export async function loadGroupFacts(ctx: ServiceContext, plan: TimetablePlanDoc): Promise<Map<string, GroupFacts>> {
  const groups = await TeachingGroup.find({ tenantId: ctx.tenantId, planId: plan._id, status: 'ACTIVE' }).lean<TeachingGroupDoc[]>();
  if (groups.length === 0) return new Map();
  const day = await memberDay(ctx, plan);
  const states = await loadStates(ctx, groups, day);
  const out = new Map<string, GroupFacts>();
  for (const group of groups) out.set(group._id, { group, members: states.get(group._id)!.sets.all, teacher: await teacherOf(ctx, plan, group, day) });
  return out;
}
