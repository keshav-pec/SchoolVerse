import type { ClientSession } from 'mongoose';
import {
  AUTO_ROLL,
  type LocationTransferData,
  type LocationTransferResultDTO,
  type LocationTransferValidateData,
  type LocationTransferValidationDTO,
  type StudentTransfersDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { academicService } from '../academic/academic.service';
import { ClassOffering, SectionOffering, SubjectOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { EducationBoard } from '../academic/reference.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { Subject } from '../academic/subject.model';
import { diffFields } from '../audit/diff';
import { Location } from '../locations/location.model';
import { masterService } from '../master/master.service';
import { todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { assignSectionInTx, createEnrollmentInTx } from './enrollment.service';
import { assertStudentWritable, loadStudent, requireSchool } from './guards';
import { toTransferEventDTO } from './mappers';
import { carrySubjectsInTx, closeEnrollmentInTx, mapProgramme } from './rollover';
import { dayBefore } from './rows';
import { checkSubjectSelection } from './rules';
import { getEffectiveSettings } from './settings.service';
import { Student, StudentEnrollment, StudentSectionAssignment, StudentSubjectEnrollment, StudentTransferEvent, type StudentEnrollmentDoc, type StudentSectionAssignmentDoc, type StudentSubjectEnrollmentDoc } from './student.models';
import { liveSubjectRows, loadCheckProgramme, loadClassRules } from './subject.service';

/**
 * SPM-27 — moving a student to another campus in the middle of a year. It is the same student with the same admission number and
 * the same parents: the old enrollment is closed (`TRANSFERRED`, last day = the day before), a new one starts (`MID_SESSION_TRANSFER`),
 * and a movement row says what happened. Two campuses on different boards do not share subjects, so the admin picks them again.
 */

interface Plan {
  student: Awaited<ReturnType<typeof loadStudent>>;
  enrollment: StudentEnrollmentDoc;
  placement: StudentSectionAssignmentDoc | null;
  session: AcademicSessionDoc;
  fromClass: ClassOfferingDoc;
  toClass: ClassOfferingDoc;
  toSection: SectionOfferingDoc | null;
  fromBoardId: string | null;
  toBoardId: string | null;
  problems: string[];
}

const boardOf = (session: AcademicSessionDoc, locationId: string) => session.locations.find((l) => l.locationId === locationId)?.boardId ?? null;

/** Everything a move depends on, with the reasons it cannot happen. Nothing is written. */
async function plan(ctx: ServiceContext, studentId: string, data: LocationTransferValidateData, db?: ClientSession): Promise<Plan> {
  const student = await loadStudent(ctx, studentId, db);
  assertStudentWritable(student);
  const problems: string[] = [];
  if (!['ACTIVE', 'INACTIVE'].includes(student.status)) problems.push('Only a student who has joined can be moved to another campus.');

  const enrollments = await StudentEnrollment.find({ tenantId: ctx.tenantId, studentId, state: 'OPEN' }).session(db ?? null).lean<StudentEnrollmentDoc[]>();
  const enrollment = enrollments.find((e) => e.effectiveFrom <= data.effectiveDate && (!e.effectiveTo || e.effectiveTo >= data.effectiveDate));
  if (!enrollment) throw AppError.validation({ effectiveDate: 'The student is not enrolled in a class on this date.' });

  const session = (await AcademicSession.findOne({ _id: enrollment.academicSessionId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicSessionDoc>())!;
  const fromClass = (await ClassOffering.findOne({ _id: enrollment.classOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<ClassOfferingDoc>())!;
  const toClass = await ClassOffering.findOne({ _id: data.classOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<ClassOfferingDoc>();
  if (!toClass) throw AppError.notFound('Class not found.');

  if (data.toLocationId === enrollment.locationId) problems.push('The student is already at this campus. Use Change Section to move between sections.');
  if (toClass.locationId !== data.toLocationId) problems.push('This class is not offered at the new campus.');
  if (toClass.sessionId !== enrollment.academicSessionId) problems.push('The new class must be in the same session as the student’s current class.');
  if (data.effectiveDate <= enrollment.effectiveFrom) problems.push(`The move must start after the student’s current enrollment began (${enrollment.effectiveFrom}).`);
  if (data.effectiveDate > session.endDate) problems.push(`The move date is after the session ends (${session.endDate}).`);

  const placement = await StudentSectionAssignment.findOne({ tenantId: ctx.tenantId, enrollmentId: enrollment._id, cancelledAt: null, effectiveFrom: { $lte: data.effectiveDate }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: data.effectiveDate } }] })
    .session(db ?? null)
    .lean<StudentSectionAssignmentDoc>();

  let toSection: SectionOfferingDoc | null = null;
  if (data.sectionId) {
    toSection = await SectionOffering.findOne({ _id: data.sectionId, tenantId: ctx.tenantId }).session(db ?? null).lean<SectionOfferingDoc>();
    if (!toSection) throw AppError.notFound('Section not found.');
    if (toSection.classOfferingId !== toClass._id) problems.push('This section does not belong to the new class.');
  }
  return { student, enrollment, placement, session, fromClass, toClass, toSection, fromBoardId: boardOf(session, enrollment.locationId), toBoardId: boardOf(session, data.toLocationId), problems };
}

async function labelOf(ctx: ServiceContext, locationId: string, boardId: string | null, klass: ClassOfferingDoc, section: { sectionCode: string } | null) {
  const [location, board] = await Promise.all([Location.findOne({ _id: locationId, tenantId: ctx.tenantId }).select('displayName').lean<{ displayName: string }>(), boardId ? EducationBoard.findOne({ _id: boardId }).select('boardName name').lean<{ boardName?: string; name?: string }>() : null]);
  return { locationId, locationName: location?.displayName ?? 'Unknown campus', className: klass.displayName, sectionLabel: section ? `${klass.displayCode}-${section.sectionCode}` : null, boardName: board?.boardName ?? board?.name ?? null };
}

export async function validateLocationTransfer(ctx: ServiceContext, studentId: string, data: LocationTransferValidateData): Promise<LocationTransferValidationDTO> {
  const p = await plan(ctx, studentId, data);
  const problems = [...p.problems];
  const warnings: string[] = [];

  // The destination must be usable for new records (a live location, a live class and section).
  try {
    await withTransaction(async (db) => {
      await masterService.assertOperationalLocation(ctx, data.toLocationId, db);
      await academicService.assertClassOfferingUsable(ctx, p.toClass._id, { purpose: 'NEW_ASSIGNMENT' }, db);
      if (p.toSection) await academicService.assertSectionUsable(ctx, p.toSection._id, { purpose: 'NEW_ASSIGNMENT' }, db);
    });
  } catch (err) {
    if (err instanceof AppError) problems.push(err.message);
    else throw err;
  }

  if (p.toSection && p.toSection.capacity !== null && p.toSection.capacity !== undefined) {
    const count = await StudentSectionAssignment.countDocuments({ tenantId: ctx.tenantId, sectionId: p.toSection._id, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: data.effectiveDate } }] });
    if (count >= p.toSection.capacity) warnings.push(`${p.toSection.displayName} already has ${count} of ${p.toSection.capacity} students.`);
  }

  const boardChanged = (p.fromBoardId ?? '') !== (p.toBoardId ?? '');
  const [rules, programme, today] = await Promise.all([loadClassRules(ctx, p.toClass._id), loadCheckProgramme(ctx, null), todayFor(ctx)]);
  const previous = await liveSubjectRows(ctx, p.enrollment._id, today);
  const subjectIdOf = new Map((await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: previous.map((r) => r.subjectOfferingId) } }).lean<{ _id: string; subjectId: string }[]>()).map((o) => [o._id, o.subjectId]));
  const carryIds = boardChanged ? new Set<string>() : new Set(previous.map((r) => subjectIdOf.get(r.subjectOfferingId)).filter((id): id is string => Boolean(id)));
  const selection = checkSubjectSelection({ ...rules.check, programme, selected: rules.offerings.filter((o) => o.status === 'ACTIVE' && carryIds.has(o.subjectId)).map((o) => o._id), addMandatory: true });
  const mandatory = new Set(selection.mandatoryOfferingIds);
  const subjects = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: rules.offerings.map((o) => o.subjectId) } }).select('name').lean<{ _id: string; name: string }[]>();
  const nameOf = new Map(subjects.map((s) => [s._id, s.name]));
  if (boardChanged) warnings.push('The new campus follows a different board. Subjects are not copied: choose them for the new class.');

  return {
    canTransfer: problems.length === 0,
    problems,
    warnings,
    from: await labelOf(ctx, p.enrollment.locationId, p.fromBoardId, p.fromClass, p.placement ? await SectionOffering.findOne({ _id: p.placement.sectionId, tenantId: ctx.tenantId }).lean<SectionOfferingDoc>() : null),
    to: await labelOf(ctx, data.toLocationId, p.toBoardId, p.toClass, p.toSection),
    boardChanged,
    subjectMappingRequired: boardChanged,
    destinationSubjects: rules.offerings
      .filter((o) => o.status === 'ACTIVE')
      .map((o) => ({ subjectOfferingId: o._id, subjectName: nameOf.get(o.subjectId) ?? 'Unknown subject', offeringType: o.offeringType, isMandatory: mandatory.has(o._id), carriedOver: carryIds.has(o.subjectId) || mandatory.has(o._id) })),
    selection,
  };
}

export async function transferLocation(ctx: ServiceContext, studentId: string, data: LocationTransferData): Promise<LocationTransferResultDTO> {
  const school = await requireSchool(ctx);
  try {
    const done = await withTransaction(async (db) => {
      const p = await plan(ctx, studentId, data, db);
      if (p.problems.length > 0) throw new AppError('TRANSFER_NOT_POSSIBLE', p.problems.join(' '), { problems: p.problems });
      await masterService.assertOperationalLocation(ctx, data.toLocationId, db);
      const boardChanged = (p.fromBoardId ?? '') !== (p.toBoardId ?? '');
      if (boardChanged && data.subjectOfferingIds === undefined) {
        const rules = await loadClassRules(ctx, p.toClass._id, db);
        throw new AppError('SUBJECT_MAPPING_REQUIRED', undefined, { destinationSubjects: rules.offerings.filter((o) => o.status === 'ACTIVE').map((o) => ({ subjectOfferingId: o._id, subjectName: rules.subjectName.get(o._id), offeringType: o.offeringType })) });
      }
      const settings = await getEffectiveSettings(ctx, school, db);
      const programmeId = boardChanged ? null : await mapProgramme(ctx, db, p.enrollment.programmeId, p.toClass);
      const previous = await liveSubjectRows(ctx, p.enrollment._id, await todayFor(ctx, db), db);
      const previousOfferingIds = previous.filter((r) => !r.isMandatory).map((r) => r.subjectOfferingId);

      // The old enrollment closes first (one open enrollment per session), the day before the move.
      const lastDay = dayBefore(data.effectiveDate);
      await closeEnrollmentInTx(ctx, db, p.enrollment, { lastDay, state: 'TRANSFERRED', reason: 'LOCATION_TRANSFER' });

      const next = await createEnrollmentInTx(ctx, db, {
        studentId,
        schoolId: school._id,
        session: p.session,
        offering: p.toClass,
        programmeId,
        enrollmentType: 'MID_SESSION_TRANSFER',
        effectiveFrom: data.effectiveDate,
        previousEnrollmentId: p.enrollment._id,
      });

      let warnings: string[] = [];
      if (data.sectionId) {
        const placed = await assignSectionInTx(ctx, db, next, { sectionId: data.sectionId, rollNumber: data.rollNumber ?? AUTO_ROLL, effectiveFrom: data.effectiveDate, reason: data.reason }, settings);
        warnings = placed.warnings.map((w) => w.message);
      }

      let mandatoryAdded: number;
      let carried: number;
      let choicePending: boolean;
      if (data.subjectOfferingIds !== undefined) {
        // The admin chose the subjects: they must follow the new class's rules.
        const rules = await loadClassRules(ctx, p.toClass._id, db);
        const programme = await loadCheckProgramme(ctx, programmeId, db);
        const result = checkSubjectSelection({ ...rules.check, programme, selected: [...new Set(data.subjectOfferingIds)], addMandatory: true });
        if (!result.valid) throw new AppError('SUBJECT_CHOICE_INVALID', result.problems.map((x) => x.message).join(' '), { problems: result.problems });
        for (const id of result.selectedOfferingIds) {
          const usable = await academicService.assertSubjectOfferingUsable(ctx, id, { purpose: 'NEW_ASSIGNMENT' }, db);
          if (usable.classOffering.classOfferingId !== p.toClass._id) throw AppError.validation({ subjectOfferingIds: 'Choose subjects that are offered for the new class.' });
          const mandatoryRow = result.mandatoryOfferingIds.includes(id);
          const [row] = await StudentSubjectEnrollment.create(
            [{ tenantId: ctx.tenantId, studentId, enrollmentId: next._id, subjectOfferingId: id, source: mandatoryRow ? 'AUTO_MANDATORY' : 'ADMIN_SELECTED', isMandatory: mandatoryRow, effectiveFrom: next.effectiveFrom, createdBy: ctx.userId, updatedBy: ctx.userId }],
            { session: db },
          );
          await recordStudentAudit(ctx, db, { entityType: 'subject_enrollment', entityId: row!._id, action: 'subject_enrollment.created', changes: [{ field: 'subjectOfferingId', from: null, to: id }], studentId, metadata: { enrollmentId: next._id, subjectName: rules.subjectName.get(id) } });
        }
        mandatoryAdded = result.mandatoryOfferingIds.length;
        carried = result.selectedOfferingIds.length - result.mandatoryOfferingIds.length;
        choicePending = false;
      } else {
        ({ mandatoryAdded, carried, choicePending } = await carrySubjectsInTx(ctx, db, { toEnrollment: next, previousOfferingIds, copy: true }));
      }

      const [event] = await StudentTransferEvent.create(
        [
          {
            tenantId: ctx.tenantId,
            studentId,
            type: 'LOCATION',
            fromEnrollmentId: p.enrollment._id,
            toEnrollmentId: next._id,
            fromSectionId: p.placement?.sectionId ?? null,
            toSectionId: data.sectionId ?? null,
            fromLocationId: p.enrollment.locationId,
            toLocationId: data.toLocationId,
            effectiveDate: data.effectiveDate,
            reason: data.reason,
            actorId: ctx.userId,
          },
        ],
        { session: db },
      );
      await recordStudentAudit(ctx, db, {
        entityType: 'student',
        entityId: studentId,
        action: 'student.location_transferred',
        changes: diffFields({ locationId: p.enrollment.locationId }, { locationId: data.toLocationId }, ['locationId']),
        studentId,
        metadata: { fromEnrollmentId: p.enrollment._id, toEnrollmentId: next._id, effectiveDate: data.effectiveDate, boardChanged },
      });
      await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId }, { $set: { updatedBy: ctx.userId } }, { session: db });
      return { event: event!.toObject(), fromEnrollmentId: p.enrollment._id, toEnrollmentId: next._id, mandatoryAdded, carried, choicePending, warnings };
    });
    return {
      event: toTransferEventDTO(done.event),
      fromEnrollmentId: done.fromEnrollmentId,
      toEnrollmentId: done.toEnrollmentId,
      mandatorySubjectsAdded: done.mandatoryAdded,
      carriedSubjects: done.carried,
      choicePending: done.choicePending,
      warnings: done.warnings,
    };
  } catch (err) {
    const fields = duplicateKeyFields(err);
    if (fields?.includes('rollNumber')) throw new AppError('ROLL_NUMBER_TAKEN');
    if (fields?.includes('academicSessionId')) throw new AppError('ENROLLMENT_ALREADY_OPEN');
    throw err;
  }
}

/** Every move the student has made, newest first (between sections and between campuses). */
export async function listTransfers(ctx: ServiceContext, studentId: string): Promise<StudentTransfersDTO> {
  await loadStudent(ctx, studentId);
  const rows = await StudentTransferEvent.find({ tenantId: ctx.tenantId, studentId }).sort({ effectiveDate: -1, createdAt: -1 }).lean();
  return { items: rows.map((r) => toTransferEventDTO(r as never)) };
}

export type { StudentSubjectEnrollmentDoc };
