import type { ClientSession } from 'mongoose';
import type { GuardianLinkDTO, StudentContextDTO, StudentContextRequest, StudentStatus } from '@shared';
import { EXITED_STUDENT_STATUSES } from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { can } from '../../platform/rbac/tenant-context';
import { ClassOffering, type ClassOfferingDoc } from '../academic/offering.model';
import { labelsFor } from '../staff/location-assignment.service';
import { todayFor } from '../staff/status';
import { Person, type PersonDoc } from '../staff/person.model';
import { assertFacultyCanSeeStudent } from './access';
import { fullNameOf } from './directory';
import { listGuardians } from './guardian.service';
import { loadStudent } from './guards';
import { assertParentCanAccess } from './parent-access';
import { pickEnrollmentIn } from './placement';
import { isOpenOn, naturalCompare } from './rules';
import { Student, StudentAdmission, StudentEnrollment, StudentSectionAssignment, StudentSubjectEnrollment, type StudentAdmissionDoc, type StudentDoc, type StudentEnrollmentDoc, type StudentSectionAssignmentDoc, type StudentSubjectEnrollmentDoc } from './student.models';
import { toSectionAssignmentDTOs } from './enrollment.dto';
import { toSubjectDTOs } from './subject.service';

/**
 * SPM-34, SPM-35 — the in-process contract for later modules (Attendance, Fees, Exams, Timetable…). They call this to learn where a
 * student is on a date, and must not build their own student lists. What a student is in on a day comes from the effective-dated
 * rows, never from a stored field.
 */

export async function getStudentContext(ctx: ServiceContext, input: StudentContextRequest): Promise<StudentContextDTO> {
  const student = await loadStudent(ctx, input.studentId);
  const today = await todayFor(ctx);
  const date = input.date ?? today;
  const [admission, enrollments] = await Promise.all([
    StudentAdmission.findOne({ tenantId: ctx.tenantId, studentId: student._id, isCurrent: true }).select('admissionNumber').lean<Pick<StudentAdmissionDoc, 'admissionNumber'>>(),
    StudentEnrollment.find({ tenantId: ctx.tenantId, studentId: student._id, state: { $ne: 'CANCELLED' } }).sort({ effectiveFrom: -1 }).lean<StudentEnrollmentDoc[]>(),
  ]);
  // A session asks "where was the student in that session"; a date asks "where were they that day".
  const enrollment: StudentEnrollmentDoc | null = input.academicSessionId
    ? pickEnrollmentIn(enrollments, input.academicSessionId)
    : (enrollments.find((e) => e.state === 'OPEN' && isOpenOn(e, date)) ?? enrollments.find((e) => isOpenOn(e, date)) ?? null);

  const empty: StudentContextDTO = { studentId: student._id, date, status: student.status, admissionNumber: admission?.admissionNumber ?? null, academicSessionId: input.academicSessionId ?? null, enrollmentId: null, locationId: null, locationName: null, classSection: null, sectionId: null, rollNumber: null, programmeId: null, subjects: [] };
  if (!enrollment) return empty;

  const [assignments, subjectRows, klass, labels] = await Promise.all([
    StudentSectionAssignment.find({ tenantId: ctx.tenantId, enrollmentId: enrollment._id }).lean<StudentSectionAssignmentDoc[]>(),
    StudentSubjectEnrollment.find({ tenantId: ctx.tenantId, enrollmentId: enrollment._id }).sort({ isMandatory: -1, _id: 1 }).lean<StudentSubjectEnrollmentDoc[]>(),
    ClassOffering.findOne({ _id: enrollment.classOfferingId, tenantId: ctx.tenantId }).lean<ClassOfferingDoc>(),
    labelsFor(ctx.tenantId, [enrollment.locationId]),
  ]);
  const placement = assignments.find((a) => isOpenOn(a, date)) ?? null;
  const [section = null] = placement ? await toSectionAssignmentDTOs(ctx, [placement], today) : [];
  return {
    ...empty,
    academicSessionId: enrollment.academicSessionId,
    enrollmentId: enrollment._id,
    locationId: enrollment.locationId,
    locationName: labels.get(enrollment.locationId)?.displayName ?? null,
    classSection: klass ? { classOfferingId: klass._id, className: klass.displayName, classCode: klass.displayCode, sectionId: section?.sectionId ?? null, sectionCode: section?.sectionCode ?? null, label: section ? `${klass.displayCode}-${section.sectionCode}` : klass.displayCode } : null,
    sectionId: section?.sectionId ?? null,
    rollNumber: section?.rollNumber ?? null,
    programmeId: enrollment.programmeId ?? null,
    subjects: await toSubjectDTOs(ctx, subjectRows.filter((r) => isOpenOn(r, date)), today),
  };
}

/** The same context for the UI, under the same rules as the student screens: admin, a teacher in scope, or a parent allowed to see academics. */
export async function getStudentContextForCaller(ctx: ServiceContext, input: StudentContextRequest): Promise<StudentContextDTO> {
  if (can(ctx, 'student:view')) return getStudentContext(ctx, input);
  if (ctx.role === 'FACULTY') {
    await assertFacultyCanSeeStudent(ctx, input.studentId);
    return getStudentContext(ctx, input);
  }
  if (ctx.role === 'PARENT') {
    await assertParentCanAccess(ctx, input.studentId, 'ACADEMICS');
    return getStudentContext(ctx, input);
  }
  throw new AppError('FORBIDDEN', undefined, { required: ['student:view'] });
}

export interface SectionRosterEntry {
  studentId: string;
  fullName: string;
  admissionNumber: string | null;
  rollNumber: string | null;
  status: StudentStatus;
}

/** Everyone placed in a section on a date (default today), by roll number. This is the roster later modules use. */
export async function listStudentsForSection(ctx: ServiceContext, sectionId: string, date?: string): Promise<SectionRosterEntry[]> {
  const day = date ?? (await todayFor(ctx));
  const placements = await StudentSectionAssignment.find({ tenantId: ctx.tenantId, sectionId, cancelledAt: null, effectiveFrom: { $lte: day }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: day } }] }).lean<StudentSectionAssignmentDoc[]>();
  if (placements.length === 0) return [];
  const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: placements.map((p) => p.studentId) } }).lean<StudentDoc[]>();
  const [people, admissions] = await Promise.all([
    Person.find({ tenantId: ctx.tenantId, _id: { $in: students.map((s) => s.personId) } }).lean<PersonDoc[]>(),
    StudentAdmission.find({ tenantId: ctx.tenantId, studentId: { $in: students.map((s) => s._id) }, isCurrent: true }).select('studentId admissionNumber').lean<Pick<StudentAdmissionDoc, 'studentId' | 'admissionNumber'>[]>(),
  ]);
  const personOf = new Map(people.map((p) => [p._id, p]));
  const numberOf = new Map(admissions.map((a) => [a.studentId, a.admissionNumber]));
  const rollOf = new Map(placements.map((p) => [p.studentId, p.rollNumber ?? null]));
  return students
    .map((s) => ({ studentId: s._id, fullName: fullNameOf(personOf.get(s.personId)!), admissionNumber: numberOf.get(s._id) ?? null, rollNumber: rollOf.get(s._id) ?? null, status: s.status }))
    .sort((a, b) => naturalCompare(a.rollNumber ?? '~', b.rollNumber ?? '~') || a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));
}

/**
 * Module 5 — "section strength": how many students sit in each section on a date (default today). Counted live from the open section
 * placements; never typed, never copied. A student who left has had their placement closed, so they are not counted. Sections with no
 * one in them are returned as 0.
 */
export async function countStudentsBySection(ctx: ServiceContext, sectionIds: string[], date?: string, db?: ClientSession): Promise<Map<string, number>> {
  const day = date ?? (await todayFor(ctx, db));
  const counts = new Map<string, number>(sectionIds.map((id) => [id, 0]));
  if (sectionIds.length === 0) return counts;
  const rows = await StudentSectionAssignment.aggregate<{ _id: string; n: number }>([
    { $match: { tenantId: ctx.tenantId, sectionId: { $in: sectionIds }, cancelledAt: null, effectiveFrom: { $lte: day }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: day } }] } },
    { $group: { _id: '$sectionId', n: { $sum: 1 } } },
  ]).session(db ?? null);
  for (const row of rows) counts.set(row._id, row.n);
  return counts;
}

export function listGuardiansForStudent(ctx: ServiceContext, studentId: string): Promise<GuardianLinkDTO[]> {
  return listGuardians(ctx, studentId);
}

/**
 * A later module calls this before it creates a new record about a student (a fee, a mark, an attendance entry). A student who has
 * left is history: new records are refused (`STUDENT_READ_ONLY`). `HISTORICAL_READ` always passes for a student that exists.
 */
export async function assertStudentUsable(ctx: ServiceContext, studentId: string, purpose: 'NEW_RECORD' | 'HISTORICAL_READ'): Promise<StudentStatus> {
  const student = await loadStudent(ctx, studentId);
  if (purpose === 'NEW_RECORD' && EXITED_STUDENT_STATUSES.includes(student.status)) throw new AppError('STUDENT_READ_ONLY');
  if (purpose === 'NEW_RECORD' && ['DRAFT', 'ADMISSION_PENDING'].includes(student.status)) throw new AppError('STUDENT_INCOMPLETE', 'This student has not joined yet.');
  return student.status;
}

export const studentService = { getStudentContext, listStudentsForSection, countStudentsBySection, listGuardiansForStudent, assertStudentUsable };
export { fullNameOf };
