import type { ClientSession } from 'mongoose';
import type { EnrollmentDTO, SectionAssignmentDTO } from '@shared';
import { toIso } from '../../core/objects';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { AcademicProgramme } from '../academic/rules.model';
import { AcademicSession } from '../academic/session.model';
import { labelsFor } from '../staff/location-assignment.service';
import { todayFor } from '../staff/status';
import { toSectionAssignmentDTO } from './mappers';
import { pickAssignment } from './placement';
import { enrollmentStatus } from './rules';
import { StudentSectionAssignment, type StudentEnrollmentDoc, type StudentSectionAssignmentDoc } from './student.models';

/** Section assignments with their section names, in one batched lookup. */
export async function toSectionAssignmentDTOs(ctx: ServiceContext, docs: StudentSectionAssignmentDoc[], today?: string, db?: ClientSession): Promise<SectionAssignmentDTO[]> {
  if (docs.length === 0) return [];
  const now = today ?? (await todayFor(ctx, db));
  const sections = await SectionOffering.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(docs.map((d) => d.sectionId))] } })
    .session(db ?? null)
    .select('sectionCode displayName')
    .lean<Pick<SectionOfferingDoc, '_id' | 'sectionCode' | 'displayName'>[]>();
  const byId = new Map(sections.map((s) => [s._id, s]));
  return docs.map((d) => toSectionAssignmentDTO(d, byId.get(d.sectionId), now));
}

/**
 * Enrollments with their session, location, class, programme and current section, in a handful of batched lookups.
 * The status is worked out from the dates (school time zone), never stored.
 */
export async function toEnrollmentDTOs(ctx: ServiceContext, docs: StudentEnrollmentDoc[], options: { db?: ClientSession; today?: string } = {}): Promise<EnrollmentDTO[]> {
  if (docs.length === 0) return [];
  const db = options.db ?? null;
  const tenantId = ctx.tenantId;
  const today = options.today ?? (await todayFor(ctx, options.db));
  const ids = (pick: (d: StudentEnrollmentDoc) => string | null) => [...new Set(docs.map(pick).filter((id): id is string => Boolean(id)))];

  const [sessions, locations, classes, programmes, assignments] = await Promise.all([
    AcademicSession.find({ tenantId, _id: { $in: ids((d) => d.academicSessionId) } }).session(db).select('code name').lean<{ _id: string; code: string; name: string }[]>(),
    labelsFor(tenantId, ids((d) => d.locationId), options.db),
    ClassOffering.find({ tenantId, _id: { $in: ids((d) => d.classOfferingId) } }).session(db).select('displayName displayCode').lean<Pick<ClassOfferingDoc, '_id' | 'displayName' | 'displayCode'>[]>(),
    AcademicProgramme.find({ tenantId, _id: { $in: ids((d) => d.programmeId) } }).session(db).select('name').lean<{ _id: string; name: string }[]>(),
    StudentSectionAssignment.find({ tenantId, enrollmentId: { $in: docs.map((d) => d._id) } }).session(db).lean<StudentSectionAssignmentDoc[]>(),
  ]);
  const sessionOf = new Map(sessions.map((s) => [s._id, s]));
  const classOf = new Map(classes.map((c) => [c._id, c]));
  const programmeOf = new Map(programmes.map((p) => [p._id, p]));

  const current = new Map<string, StudentSectionAssignmentDoc | null>();
  for (const d of docs) current.set(d._id, pickAssignment(assignments.filter((a) => a.enrollmentId === d._id), today));
  const sectionDtos = await toSectionAssignmentDTOs(ctx, [...current.values()].filter((a): a is StudentSectionAssignmentDoc => Boolean(a)), today, options.db);
  const sectionDtoOf = new Map(sectionDtos.map((s) => [s.sectionAssignmentId, s]));

  return docs.map((d) => {
    const session = sessionOf.get(d.academicSessionId);
    const klass = classOf.get(d.classOfferingId);
    const section = current.get(d._id);
    return {
      enrollmentId: d._id,
      studentId: d.studentId,
      academicSessionId: d.academicSessionId,
      sessionCode: session?.code ?? '?',
      sessionName: session?.name ?? 'Unknown session',
      locationId: d.locationId,
      locationName: locations.get(d.locationId)?.displayName ?? 'Unknown location',
      classOfferingId: d.classOfferingId,
      className: klass?.displayName ?? 'Unknown class',
      classCode: klass?.displayCode ?? '?',
      programmeId: d.programmeId ?? null,
      programmeName: d.programmeId ? programmeOf.get(d.programmeId)?.name ?? null : null,
      enrollmentType: d.enrollmentType,
      effectiveFrom: d.effectiveFrom,
      effectiveTo: d.effectiveTo ?? null,
      state: d.state,
      status: enrollmentStatus(d, today),
      outcome: d.outcome ?? null,
      previousEnrollmentId: d.previousEnrollmentId ?? null,
      section: section ? sectionDtoOf.get(section._id) ?? null : null,
      version: d.version,
      createdAt: toIso(d.createdAt)!,
    };
  });
}
