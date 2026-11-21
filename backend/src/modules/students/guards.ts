import type { ClientSession } from 'mongoose';
import { EXITED_STUDENT_STATUSES } from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { getCurrentSchool } from '../school/school.service';
import type { SchoolDoc } from '../school/school.model';
import { Person, type PersonDoc } from '../staff/person.model';
import { Student, StudentEnrollment, StudentGuardianLink, type StudentDoc, type StudentEnrollmentDoc, type StudentGuardianLinkDoc } from './student.models';

/** Loads a student of this tenant, or 404. Other tenants' ids look exactly like missing ones. */
export async function loadStudent(ctx: ServiceContext, studentId: string, db?: ClientSession): Promise<StudentDoc> {
  const doc = await Student.findOne({ _id: studentId, tenantId: ctx.tenantId }).session(db ?? null).lean<StudentDoc>();
  if (!doc) throw AppError.notFound('Student not found.');
  return doc;
}

/** Students who have left are history: nothing about them can change (`STUDENT_READ_ONLY`). */
export function assertStudentWritable(student: Pick<StudentDoc, 'status'>) {
  if (EXITED_STUDENT_STATUSES.includes(student.status)) throw new AppError('STUDENT_READ_ONLY');
}

export async function loadPerson(ctx: ServiceContext, personId: string, db?: ClientSession): Promise<PersonDoc> {
  const doc = await Person.findOne({ _id: personId, tenantId: ctx.tenantId }).session(db ?? null).lean<PersonDoc>();
  if (!doc) throw AppError.notFound('Person not found.');
  return doc;
}

export async function loadEnrollment(ctx: ServiceContext, enrollmentId: string, db?: ClientSession): Promise<StudentEnrollmentDoc> {
  const doc = await StudentEnrollment.findOne({ _id: enrollmentId, tenantId: ctx.tenantId }).session(db ?? null).lean<StudentEnrollmentDoc>();
  if (!doc) throw AppError.notFound('Enrollment not found.');
  return doc;
}

export async function loadGuardianLink(ctx: ServiceContext, linkId: string, db?: ClientSession): Promise<StudentGuardianLinkDoc> {
  const doc = await StudentGuardianLink.findOne({ _id: linkId, tenantId: ctx.tenantId }).session(db ?? null).lean<StudentGuardianLinkDoc>();
  if (!doc) throw AppError.notFound('Guardian link not found.');
  return doc;
}

/** The School Master, or a plain 404 that says what to do first. */
export async function requireSchool(ctx: ServiceContext): Promise<SchoolDoc> {
  const school = await getCurrentSchool(ctx);
  if (!school) throw AppError.notFound('Set up the school profile before adding students.');
  return school;
}

/** Editable rows carry a `version`; a PATCH that was built from an older copy is refused. */
export function assertVersion(current: number, sent: number) {
  if (current !== sent) throw new AppError('VERSION_CONFLICT', undefined, { currentVersion: current });
}

/** The class offering and the section must belong to the date range of the enrollment. */
export function assertWithin(date: string, from: string, to: string | null, field: string, what: string) {
  if (date < from || (to && date > to)) {
    throw AppError.validation({ [field]: `This date must be inside ${what} (${from}${to ? ` to ${to}` : ' onwards'}).` });
  }
}
