import type { ClientSession } from 'mongoose';
import type { AcademicPurpose, AcademicUsabilityDTO, SessionStatus } from '@shared';
import { AppError } from '../../core/errors';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { getMasterLocation } from '../master/master.service';
import { getAcademicContext } from './context.service';
import { registerAcademicDependency } from './dependencies';
import { ClassOffering, SectionOffering, SubjectOffering, type ClassOfferingDoc, type SectionOfferingDoc, type SubjectOfferingDoc } from './offering.model';
import { getSessionOrThrow } from './session.service';
import { Subject, type SubjectDoc } from './subject.model';

/**
 * AS-18 — the in-process contract of Academic Structure (PRD §20). Later modules (Faculty, Students, Timetable…)
 * consume the academic model through these functions, or over HTTP through `/academic-context`, and store the
 * OFFERING UUIDs (`classOfferingId`, `sectionOfferingId`, `subjectOfferingId`) — never a label such as "VIII-A".
 *
 *   purpose NEW_ASSIGNMENT   a new record is being created: the session must be PUBLISHED or ACTIVE and every row ACTIVE.
 *   purpose HISTORICAL_READ  an old record is being read: anything the caller may see, whatever its status.
 */
const OPEN_FOR_NEW_RECORDS: SessionStatus[] = ['PUBLISHED', 'ACTIVE'];

function notUsable(reason: string, message: string, details: Record<string, unknown> = {}): never {
  throw new AppError('ACADEMIC_NOT_USABLE', message, { reason, ...details });
}

async function resolveChain(ctx: ServiceContext, classOffering: ClassOfferingDoc, purpose: AcademicPurpose, db?: ClientSession) {
  const session = await getSessionOrThrow(ctx, classOffering.sessionId, db);
  const location = await getMasterLocation(ctx, classOffering.locationId, db);
  if (purpose === 'NEW_ASSIGNMENT') {
    if (!OPEN_FOR_NEW_RECORDS.includes(session.status)) {
      notUsable('SESSION_NOT_OPEN', `The session "${session.name}" is ${session.status.toLowerCase()}, so it cannot take new assignments.`, { status: session.status });
    }
    if (location.status !== 'ACTIVE') notUsable('LOCATION_NOT_ACTIVE', `${location.displayName} is not active.`, { status: location.status });
    if (classOffering.status !== 'ACTIVE') notUsable('CLASS_INACTIVE', `${classOffering.displayName} is inactive in this session.`);
  }
  return {
    location: { locationId: location.locationId, locationCode: location.locationCode, displayName: location.displayName },
    session: { academicSessionId: session._id, code: session.code, name: session.name, status: session.status },
    classOffering: { classOfferingId: classOffering._id, classId: classOffering.classId, displayName: classOffering.displayName },
  };
}

/** Resolves Location → Session → Class, or throws `NOT_FOUND` / `ACADEMIC_NOT_USABLE`. */
export async function assertClassOfferingUsable(
  ctx: ServiceContext,
  classOfferingId: string,
  options: { purpose: AcademicPurpose },
  db?: ClientSession,
): Promise<AcademicUsabilityDTO> {
  const classOffering = await ClassOffering.findOne({ _id: classOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<ClassOfferingDoc>();
  if (!classOffering) throw AppError.notFound('Class not found.');
  return { purpose: options.purpose, ...(await resolveChain(ctx, classOffering, options.purpose, db)) };
}

/** Resolves Location → Session → Class → Section, or throws `NOT_FOUND` / `ACADEMIC_NOT_USABLE`. */
export async function assertSectionUsable(
  ctx: ServiceContext,
  sectionOfferingId: string,
  options: { purpose: AcademicPurpose },
  db?: ClientSession,
): Promise<AcademicUsabilityDTO> {
  const section = await SectionOffering.findOne({ _id: sectionOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<SectionOfferingDoc>();
  if (!section) throw AppError.notFound('Section not found.');
  const classOffering = await ClassOffering.findOne({ _id: section.classOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<ClassOfferingDoc>();
  if (!classOffering) throw AppError.notFound('Class not found.');
  const chain = await resolveChain(ctx, classOffering, options.purpose, db);
  if (options.purpose === 'NEW_ASSIGNMENT' && section.status !== 'ACTIVE') notUsable('SECTION_INACTIVE', `Section ${section.sectionCode} is inactive in this session.`);
  return {
    purpose: options.purpose,
    ...chain,
    section: { sectionOfferingId: section._id, sectionCode: section.sectionCode, displayName: section.displayName },
  };
}

/** Resolves Location → Session → Class → Subject offering. */
export async function assertSubjectOfferingUsable(
  ctx: ServiceContext,
  subjectOfferingId: string,
  options: { purpose: AcademicPurpose },
  db?: ClientSession,
): Promise<AcademicUsabilityDTO> {
  const offering = await SubjectOffering.findOne({ _id: subjectOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<SubjectOfferingDoc>();
  if (!offering) throw AppError.notFound('Subject offering not found.');
  const [classOffering, subject] = await Promise.all([
    ClassOffering.findOne({ _id: offering.classOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<ClassOfferingDoc>(),
    Subject.findOne({ _id: offering.subjectId, tenantId: ctx.tenantId }).session(db ?? null).lean<SubjectDoc>(),
  ]);
  if (!classOffering || !subject) throw AppError.notFound('Subject offering not found.');
  const chain = await resolveChain(ctx, classOffering, options.purpose, db);
  if (options.purpose === 'NEW_ASSIGNMENT' && (offering.status !== 'ACTIVE' || subject.status !== 'ACTIVE')) {
    notUsable('SUBJECT_INACTIVE', `${subject.name} is inactive in this class.`);
  }
  return {
    purpose: options.purpose,
    ...chain,
    subjectOffering: { subjectOfferingId: offering._id, subjectId: subject._id, subjectName: subject.name, offeringType: offering.offeringType },
  };
}

export const academicService = {
  getContext: getAcademicContext,
  assertClassOfferingUsable,
  assertSectionUsable,
  assertSubjectOfferingUsable,
  registerAcademicDependency,
};
