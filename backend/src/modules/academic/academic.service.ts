import type { ClientSession } from 'mongoose';
import type { AcademicPurpose, AcademicUsabilityDTO, SessionStatus } from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { getMasterLocation } from '../master/master.service';
import { getAcademicContext } from './context.service';
import { registerAcademicDependency } from './dependencies';
import { GradeOffering, SectionOffering, SubjectOffering, type GradeOfferingDoc, type SectionOfferingDoc, type SubjectOfferingDoc } from './offering.model';
import { getSessionOrThrow } from './session.service';
import { Subject, type SubjectDoc } from './subject.model';

/**
 * AS-18 — the in-process contract of Academic Structure (PRD §20). Later modules (Faculty, Students, Timetable…)
 * consume the academic model through these functions, or over HTTP through `/academic-context`, and store the
 * OFFERING UUIDs (`gradeOfferingId`, `sectionOfferingId`, `subjectOfferingId`) — never a label such as "VIII-A".
 *
 *   purpose NEW_ASSIGNMENT   a new record is being created: the session must be PUBLISHED or ACTIVE and every row ACTIVE.
 *   purpose HISTORICAL_READ  an old record is being read: anything the caller may see, whatever its status.
 */
const OPEN_FOR_NEW_RECORDS: SessionStatus[] = ['PUBLISHED', 'ACTIVE'];

function notUsable(reason: string, message: string, details: Record<string, unknown> = {}): never {
  throw new AppError('ACADEMIC_NOT_USABLE', message, { reason, ...details });
}

async function resolveChain(ctx: ServiceContext, gradeOffering: GradeOfferingDoc, purpose: AcademicPurpose, db?: ClientSession) {
  const session = await getSessionOrThrow(ctx, gradeOffering.sessionId, db);
  const location = await getMasterLocation(ctx, gradeOffering.locationId, db);
  if (purpose === 'NEW_ASSIGNMENT') {
    if (!OPEN_FOR_NEW_RECORDS.includes(session.status)) {
      notUsable('SESSION_NOT_OPEN', `The session "${session.name}" is ${session.status.toLowerCase()}, so it cannot take new assignments.`, { status: session.status });
    }
    if (location.status !== 'ACTIVE') notUsable('LOCATION_NOT_ACTIVE', `${location.displayName} is not active.`, { status: location.status });
    if (gradeOffering.status !== 'ACTIVE') notUsable('GRADE_INACTIVE', `${gradeOffering.displayName} is inactive in this session.`);
  }
  return {
    location: { locationId: location.locationId, locationCode: location.locationCode, displayName: location.displayName },
    session: { academicSessionId: session._id, code: session.code, name: session.name, status: session.status },
    gradeOffering: { gradeOfferingId: gradeOffering._id, gradeId: gradeOffering.gradeId, displayName: gradeOffering.displayName },
  };
}

/** Resolves Location → Session → Grade, or throws `NOT_FOUND` / `ACADEMIC_NOT_USABLE`. */
export async function assertGradeOfferingUsable(
  ctx: ServiceContext,
  gradeOfferingId: string,
  options: { purpose: AcademicPurpose },
  db?: ClientSession,
): Promise<AcademicUsabilityDTO> {
  const gradeOffering = await GradeOffering.findOne({ _id: gradeOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<GradeOfferingDoc>();
  if (!gradeOffering) throw AppError.notFound('Grade not found.');
  return { purpose: options.purpose, ...(await resolveChain(ctx, gradeOffering, options.purpose, db)) };
}

/** Resolves Location → Session → Grade → Section, or throws `NOT_FOUND` / `ACADEMIC_NOT_USABLE`. */
export async function assertSectionUsable(
  ctx: ServiceContext,
  sectionOfferingId: string,
  options: { purpose: AcademicPurpose },
  db?: ClientSession,
): Promise<AcademicUsabilityDTO> {
  const section = await SectionOffering.findOne({ _id: sectionOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<SectionOfferingDoc>();
  if (!section) throw AppError.notFound('Section not found.');
  const gradeOffering = await GradeOffering.findOne({ _id: section.gradeOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<GradeOfferingDoc>();
  if (!gradeOffering) throw AppError.notFound('Grade not found.');
  const chain = await resolveChain(ctx, gradeOffering, options.purpose, db);
  if (options.purpose === 'NEW_ASSIGNMENT' && section.status !== 'ACTIVE') notUsable('SECTION_INACTIVE', `Section ${section.sectionCode} is inactive in this session.`);
  return {
    purpose: options.purpose,
    ...chain,
    section: { sectionOfferingId: section._id, sectionCode: section.sectionCode, displayName: section.displayName },
  };
}

/** Resolves Location → Session → Grade → Subject offering. */
export async function assertSubjectOfferingUsable(
  ctx: ServiceContext,
  subjectOfferingId: string,
  options: { purpose: AcademicPurpose },
  db?: ClientSession,
): Promise<AcademicUsabilityDTO> {
  const offering = await SubjectOffering.findOne({ _id: subjectOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<SubjectOfferingDoc>();
  if (!offering) throw AppError.notFound('Subject offering not found.');
  const [gradeOffering, subject] = await Promise.all([
    GradeOffering.findOne({ _id: offering.gradeOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<GradeOfferingDoc>(),
    Subject.findOne({ _id: offering.subjectId, tenantId: ctx.tenantId }).session(db ?? null).lean<SubjectDoc>(),
  ]);
  if (!gradeOffering || !subject) throw AppError.notFound('Subject offering not found.');
  const chain = await resolveChain(ctx, gradeOffering, options.purpose, db);
  if (options.purpose === 'NEW_ASSIGNMENT' && (offering.status !== 'ACTIVE' || subject.status !== 'ACTIVE')) {
    notUsable('SUBJECT_INACTIVE', `${subject.name} is inactive in this grade.`);
  }
  return {
    purpose: options.purpose,
    ...chain,
    subjectOffering: { subjectOfferingId: offering._id, subjectId: subject._id, subjectName: subject.name, offeringType: offering.offeringType },
  };
}

export const academicService = {
  getContext: getAcademicContext,
  assertGradeOfferingUsable,
  assertSectionUsable,
  assertSubjectOfferingUsable,
  registerAcademicDependency,
};
