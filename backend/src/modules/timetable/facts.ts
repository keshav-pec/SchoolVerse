import type { ClientSession } from 'mongoose';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, SubjectOffering, type ClassOfferingDoc, type SectionOfferingDoc, type SubjectOfferingDoc } from '../academic/offering.model';
import { Subject, type SubjectDoc } from '../academic/subject.model';
import { Employee, LIVE_EMPLOYEE_STATUSES, type EmployeeDoc } from '../staff/employee.model';
import { LocationAssignment } from '../staff/assignment.models';
import { displayNameOf } from '../staff/mappers';
import { Person, type PersonDoc } from '../staff/person.model';
import type { TimetablePlanDoc } from './models';

/**
 * What the plan's campus and session contain, read from Modules 2 and 3 each time. Nothing here is stored by the timetable.
 * Only ACTIVE classes, sections and subjects count: a switched-off one is no longer part of the week.
 */

export interface PlanFacts {
  classes: ClassOfferingDoc[];
  sections: SectionOfferingDoc[];
  subjectOfferings: SubjectOfferingDoc[];
  classOf: Map<string, ClassOfferingDoc>;
  sectionOf: Map<string, SectionOfferingDoc>;
  offeringOf: Map<string, SubjectOfferingDoc>;
  subjectOf: Map<string, SubjectDoc>;
}

const byOrder = <T extends { sequenceOrder: number }>(a: T, b: T) => a.sequenceOrder - b.sequenceOrder;

export async function loadPlanFacts(ctx: ServiceContext, plan: Pick<TimetablePlanDoc, 'locationId' | 'academicSessionId'>, db?: ClientSession): Promise<PlanFacts> {
  const where = { tenantId: ctx.tenantId, locationId: plan.locationId, sessionId: plan.academicSessionId, status: 'ACTIVE' as const };
  const [classes, sections, subjectOfferings] = await Promise.all([
    ClassOffering.find(where).session(db ?? null).lean<ClassOfferingDoc[]>(),
    SectionOffering.find(where).session(db ?? null).lean<SectionOfferingDoc[]>(),
    SubjectOffering.find(where).session(db ?? null).lean<SubjectOfferingDoc[]>(),
  ]);
  classes.sort(byOrder);
  const classOf = new Map(classes.map((c) => [c._id, c]));
  const liveSections = sections.filter((s) => classOf.has(s.classOfferingId)).sort((a, b) => (classOf.get(a.classOfferingId)!.sequenceOrder - classOf.get(b.classOfferingId)!.sequenceOrder) || byOrder(a, b) || a.sectionCode.localeCompare(b.sectionCode));
  const liveOfferings = subjectOfferings.filter((o) => classOf.has(o.classOfferingId));
  const subjects = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(liveOfferings.map((o) => o.subjectId))] } }).session(db ?? null).lean<SubjectDoc[]>();
  const subjectOf = new Map(subjects.map((s) => [s._id, s]));
  liveOfferings.sort((a, b) => (subjectOf.get(a.subjectId)?.name ?? '').localeCompare(subjectOf.get(b.subjectId)?.name ?? ''));
  return { classes, sections: liveSections, subjectOfferings: liveOfferings, classOf, sectionOf: new Map(liveSections.map((s) => [s._id, s])), offeringOf: new Map(liveOfferings.map((o) => [o._id, o])), subjectOf };
}

export const sectionLabelOf = (facts: PlanFacts, sectionId: string): string => {
  const section = facts.sectionOf.get(sectionId);
  const klass = section ? facts.classOf.get(section.classOfferingId) : undefined;
  return section && klass ? `${klass.displayCode}-${section.sectionCode}` : 'Unknown section';
};

export const subjectNameOf = (facts: PlanFacts, subjectOfferingId: string): string => {
  const offering = facts.offeringOf.get(subjectOfferingId);
  return (offering && facts.subjectOf.get(offering.subjectId)?.name) || 'Unknown subject';
};

export const subjectCodeOf = (facts: PlanFacts, subjectOfferingId: string): string => {
  const offering = facts.offeringOf.get(subjectOfferingId);
  return (offering && facts.subjectOf.get(offering.subjectId)?.subjectCode) || '';
};

/** A class that belongs to the plan's campus and session. Another campus is `WRONG_CAMPUS`; anything else is a 404. */
export async function requirePlanClass(ctx: ServiceContext, plan: TimetablePlanDoc, classOfferingId: string, db?: ClientSession): Promise<ClassOfferingDoc> {
  const klass = await ClassOffering.findOne({ _id: classOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<ClassOfferingDoc>();
  if (!klass || klass.sessionId !== plan.academicSessionId) throw AppError.notFound('Class not found.');
  if (klass.locationId !== plan.locationId) throw new AppError('WRONG_CAMPUS', 'This class is at another campus than the timetable plan.');
  return klass;
}

export async function requirePlanSection(ctx: ServiceContext, plan: TimetablePlanDoc, sectionOfferingId: string, db?: ClientSession): Promise<SectionOfferingDoc> {
  const section = await SectionOffering.findOne({ _id: sectionOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<SectionOfferingDoc>();
  if (!section || section.sessionId !== plan.academicSessionId) throw AppError.notFound('Section not found.');
  if (section.locationId !== plan.locationId) throw new AppError('WRONG_CAMPUS', 'This section is at another campus than the timetable plan.');
  return section;
}

// ───────────────────────────────────────────────────────────── teachers

export interface TeacherFacts {
  employee: EmployeeDoc;
  fullName: string;
}

/** Live employees with a location assignment at the plan's campus that overlaps the plan's dates. Faculty only unless `anyCategory`. */
export async function loadPlanTeachers(ctx: ServiceContext, plan: Pick<TimetablePlanDoc, 'locationId' | 'effectiveFrom' | 'effectiveTo'>, options: { employeeIds?: string[]; anyCategory?: boolean } = {}, db?: ClientSession): Promise<TeacherFacts[]> {
  const assigned = (await LocationAssignment.distinct('employeeId', {
    tenantId: ctx.tenantId,
    locationId: plan.locationId,
    cancelledAt: null,
    effectiveFrom: { $lte: plan.effectiveTo },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: plan.effectiveFrom } }],
  }).session(db ?? null)) as string[];
  const ids = options.employeeIds ? assigned.filter((id) => options.employeeIds!.includes(id)) : assigned;
  if (ids.length === 0) return [];
  const employees = await Employee.find({ tenantId: ctx.tenantId, _id: { $in: ids }, status: { $in: LIVE_EMPLOYEE_STATUSES }, ...(options.anyCategory ? {} : { employeeCategory: 'FACULTY' }) }).session(db ?? null).lean<EmployeeDoc[]>();
  const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: employees.map((e) => e.personId) } }).session(db ?? null).lean<PersonDoc[]>();
  const personOf = new Map(people.map((p) => [p._id, p]));
  return employees
    .map((employee) => ({ employee, fullName: personOf.get(employee.personId) ? displayNameOf(personOf.get(employee.personId)!) : 'Unknown' }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));
}

/** Names for any employee ids (any category), so an old assignment still shows a name. */
export async function employeeNames(ctx: ServiceContext, employeeIds: string[], db?: ClientSession): Promise<Map<string, string>> {
  const ids = [...new Set(employeeIds)];
  if (ids.length === 0) return new Map();
  const employees = await Employee.find({ tenantId: ctx.tenantId, _id: { $in: ids } }).select('personId').session(db ?? null).lean<{ _id: string; personId: string }[]>();
  const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: employees.map((e) => e.personId) } }).session(db ?? null).lean<PersonDoc[]>();
  const personOf = new Map(people.map((p) => [p._id, p]));
  return new Map(employees.map((e) => [e._id, personOf.get(e.personId) ? displayNameOf(personOf.get(e.personId)!) : 'Unknown']));
}

/** One employee who may be scheduled at this plan's campus. 404 for another school's id, `WRONG_CAMPUS` for one who works elsewhere. */
export async function requirePlanTeacher(ctx: ServiceContext, plan: TimetablePlanDoc, employeeId: string, db?: ClientSession): Promise<TeacherFacts> {
  const exists = await Employee.exists({ _id: employeeId, tenantId: ctx.tenantId }).session(db ?? null);
  if (!exists) throw AppError.notFound('Teacher not found.');
  const [found] = await loadPlanTeachers(ctx, plan, { employeeIds: [employeeId] }, db);
  if (!found) throw new AppError('WRONG_CAMPUS', 'This teacher does not work at the timetable plan\'s campus.');
  return found;
}
