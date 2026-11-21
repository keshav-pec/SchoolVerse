import type { ClientSession } from 'mongoose';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { Person, type PersonDoc } from '../staff/person.model';
import { todayFor } from '../staff/status';
import { pickAssignment, pickEnrollment, pickEnrollmentIn } from './placement';
import {
  StudentAdmission,
  StudentEnrollment,
  StudentGuardianLink,
  StudentSectionAssignment,
  type StudentAdmissionDoc,
  type StudentDoc,
  type StudentEnrollmentDoc,
  type StudentGuardianLinkDoc,
  type StudentSectionAssignmentDoc,
} from './student.models';

export interface StudentPlacement {
  enrollment: StudentEnrollmentDoc | null;
  assignment: StudentSectionAssignmentDoc | null;
}

/** Everything the mappers need for a page of students, loaded in a handful of batched queries. */
export interface StudentHydration {
  today: string;
  people: Map<string, PersonDoc>;
  /** The current admission of each student. */
  admissions: Map<string, StudentAdmissionDoc>;
  placements: Map<string, StudentPlacement>;
  classes: Map<string, ClassOfferingDoc>;
  sections: Map<string, SectionOfferingDoc>;
  /** Display name of the primary guardian who is active today. */
  primaryGuardianNames: Map<string, string>;
}

const nameOf = (p: Pick<PersonDoc, 'legalFirstName' | 'legalLastName'>) => `${p.legalFirstName} ${p.legalLastName}`.trim();

/** The name shown in lists: the preferred name when there is one. */
export function displayNameOf(p: Pick<PersonDoc, 'legalFirstName' | 'legalLastName' | 'preferredName'>): string {
  return p.preferredName || nameOf(p);
}
export { nameOf as fullNameOf };

interface HydrateOptions {
  db?: ClientSession;
  today?: string;
  /** Use the enrollment of this session, rather than "where the student is today". */
  academicSessionId?: string | null;
  people?: PersonDoc[];
}

export async function hydrateStudents(ctx: ServiceContext, students: StudentDoc[], options: HydrateOptions = {}): Promise<StudentHydration> {
  const db = options.db ?? null;
  const tenantId = ctx.tenantId;
  const today = options.today ?? (await todayFor(ctx, options.db));
  const ids = students.map((s) => s._id);

  const supplied = new Map((options.people ?? []).map((p) => [p._id, p]));
  const missingPeople = students.map((s) => s.personId).filter((id) => !supplied.has(id));
  const [morePeople, admissions, enrollments, links] = await Promise.all([
    missingPeople.length ? Person.find({ tenantId, _id: { $in: missingPeople } }).session(db).lean<PersonDoc[]>() : Promise.resolve([] as PersonDoc[]),
    StudentAdmission.find({ tenantId, studentId: { $in: ids }, isCurrent: true }).session(db).lean<StudentAdmissionDoc[]>(),
    StudentEnrollment.find({ tenantId, studentId: { $in: ids } }).session(db).lean<StudentEnrollmentDoc[]>(),
    StudentGuardianLink.find({ tenantId, studentId: { $in: ids }, isPrimary: true, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] })
      .session(db)
      .lean<StudentGuardianLinkDoc[]>(),
  ]);

  const enrollmentsBy = new Map<string, StudentEnrollmentDoc[]>();
  for (const e of enrollments) enrollmentsBy.set(e.studentId, [...(enrollmentsBy.get(e.studentId) ?? []), e]);

  const chosen = new Map<string, StudentEnrollmentDoc | null>();
  for (const s of students) {
    const rows = enrollmentsBy.get(s._id) ?? [];
    chosen.set(s._id, options.academicSessionId ? pickEnrollmentIn(rows, options.academicSessionId) : pickEnrollment(rows, today));
  }
  const enrollmentIds = [...chosen.values()].filter((e): e is StudentEnrollmentDoc => Boolean(e)).map((e) => e._id);
  const assignments = enrollmentIds.length
    ? await StudentSectionAssignment.find({ tenantId, enrollmentId: { $in: enrollmentIds } }).session(db).lean<StudentSectionAssignmentDoc[]>()
    : [];
  const assignmentsBy = new Map<string, StudentSectionAssignmentDoc[]>();
  for (const a of assignments) assignmentsBy.set(a.enrollmentId, [...(assignmentsBy.get(a.enrollmentId) ?? []), a]);

  const placements = new Map<string, StudentPlacement>();
  for (const s of students) {
    const enrollment = chosen.get(s._id) ?? null;
    placements.set(s._id, { enrollment, assignment: enrollment ? pickAssignment(assignmentsBy.get(enrollment._id) ?? [], today) : null });
  }

  const classIds = [...new Set([...placements.values()].map((p) => p.enrollment?.classOfferingId).filter((id): id is string => Boolean(id)))];
  const sectionIds = [...new Set([...placements.values()].map((p) => p.assignment?.sectionId).filter((id): id is string => Boolean(id)))];
  const guardianIds = [...new Set(links.map((l) => l.guardianPersonId))];
  const [classes, sections, guardians] = await Promise.all([
    classIds.length ? ClassOffering.find({ tenantId, _id: { $in: classIds } }).session(db).lean<ClassOfferingDoc[]>() : Promise.resolve([] as ClassOfferingDoc[]),
    sectionIds.length ? SectionOffering.find({ tenantId, _id: { $in: sectionIds } }).session(db).lean<SectionOfferingDoc[]>() : Promise.resolve([] as SectionOfferingDoc[]),
    guardianIds.length ? Person.find({ tenantId, _id: { $in: guardianIds } }).session(db).lean<PersonDoc[]>() : Promise.resolve([] as PersonDoc[]),
  ]);
  const guardianById = new Map(guardians.map((g) => [g._id, g]));
  const primaryGuardianNames = new Map<string, string>();
  for (const l of links) {
    const g = guardianById.get(l.guardianPersonId);
    if (g) primaryGuardianNames.set(l.studentId, nameOf(g));
  }

  return {
    today,
    people: new Map([...supplied, ...morePeople.map((p) => [p._id, p] as const)]),
    admissions: new Map(admissions.map((a) => [a.studentId, a])),
    placements,
    classes: new Map(classes.map((c) => [c._id, c])),
    sections: new Map(sections.map((s) => [s._id, s])),
    primaryGuardianNames,
  };
}
