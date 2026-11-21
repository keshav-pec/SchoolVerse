import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import {
  AUTO_ROLL,
  type AssignSectionData,
  type BulkRollNumbersData,
  type BulkRollNumbersDTO,
  type CompleteEnrollmentData,
  type CreateEnrollmentData,
  type CreateEnrollmentResultDTO,
  type EnrollmentDTO,
  type ProgrammeChangePreviewDTO,
  type RecommendSectionData,
  type SectionAssignmentDTO,
  type SectionAssignmentResultDTO,
  type SectionRecommendationDTO,
  type SectionTransferData,
  type SectionTransferResultDTO,
  type SectionWarningDTO,
  type UpdateEnrollmentData,
  type UpdateSectionAssignmentData,
} from '@shared';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { academicService } from '../academic/academic.service';
import { ClassOffering, SectionOffering, type ClassOfferingDoc, type SectionOfferingDoc } from '../academic/offering.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { masterService } from '../master/master.service';
import { Person, type PersonDoc } from '../staff/person.model';
import { latest, todayFor } from '../staff/status';
import { diffFields } from '../audit/diff';
import { recordStudentAudit } from './audit';
import { toSectionAssignmentDTOs, toEnrollmentDTOs } from './enrollment.dto';
import { assertStudentWritable, assertVersion, assertWithin, loadEnrollment, loadStudent, requireSchool } from './guards';
import { toTransferEventDTO } from './mappers';
import { dayBefore, endPatch } from './rows';
import { naturalCompare, nextFreeRoll } from './rules';
import { getEffectiveSettings } from './settings.service';
import { applyProgrammeChange, assertProgrammeForClass, endAllSubjectRows, initializeMandatoryInTx, previewProgramme } from './subject.service';
import {
  Student,
  StudentAdmission,
  StudentEnrollment,
  StudentSectionAssignment,
  StudentTransferEvent,
  type StudentAdmissionDoc,
  type StudentDoc,
  type StudentEnrollmentDoc,
  type StudentSectionAssignmentDoc,
} from './student.models';
import { fullNameOf } from './directory';

/** SPM-14 to SPM-16, SPM-26 — enrollments, sections, roll numbers and mid-year section changes. */

const ENROLLMENT_AUDITED = ['academicSessionId', 'locationId', 'classOfferingId', 'programmeId', 'enrollmentType', 'effectiveFrom', 'effectiveTo', 'state', 'outcome'] as const;
const ASSIGNMENT_AUDITED = ['sectionId', 'rollNumber', 'effectiveFrom', 'effectiveTo'] as const;

// ───────────────────────────────────────────────────────────── resolving the class

/**
 * Finds the class offering for an enrollment. The caller may send the offering, or just the class (the system finds the
 * offering at that location in that session). It must be offered there (`CLASS_NOT_OFFERED_AT_LOCATION`) and usable for
 * new records (`ACADEMIC_NOT_USABLE`).
 */
export async function resolveClassOffering(
  ctx: ServiceContext,
  input: { academicSessionId: string; locationId: string; classOfferingId?: string | undefined; classId?: string | undefined },
  db: ClientSession,
): Promise<ClassOfferingDoc> {
  let offering: ClassOfferingDoc | null;
  if (input.classOfferingId) {
    offering = await ClassOffering.findOne({ _id: input.classOfferingId, tenantId: ctx.tenantId }).session(db).lean<ClassOfferingDoc>();
    if (!offering) throw AppError.notFound('Class not found.');
  } else {
    offering = await ClassOffering.findOne({ tenantId: ctx.tenantId, sessionId: input.academicSessionId, locationId: input.locationId, classId: input.classId! }).session(db).lean<ClassOfferingDoc>();
    if (!offering) throw new AppError('CLASS_NOT_OFFERED_AT_LOCATION');
  }
  if (offering.sessionId !== input.academicSessionId || offering.locationId !== input.locationId) throw new AppError('CLASS_NOT_OFFERED_AT_LOCATION');
  await masterService.assertOperationalLocation(ctx, input.locationId, db);
  await academicService.assertClassOfferingUsable(ctx, offering._id, { purpose: 'NEW_ASSIGNMENT' }, db);
  return offering;
}

async function loadSession(ctx: ServiceContext, sessionId: string, db: ClientSession): Promise<AcademicSessionDoc> {
  const doc = await AcademicSession.findOne({ _id: sessionId, tenantId: ctx.tenantId }).session(db).lean<AcademicSessionDoc>();
  if (!doc) throw AppError.notFound('Academic session not found.');
  return doc;
}

// ───────────────────────────────────────────────────────────── capacity and roll numbers

/** Students who are in the section on `date` or will be later (not ended, not cancelled). */
async function occupancy(ctx: ServiceContext, sectionId: string, date: string, db: ClientSession, exceptEnrollmentId?: string): Promise<number> {
  return StudentSectionAssignment.countDocuments({
    tenantId: ctx.tenantId,
    sectionId,
    cancelledAt: null,
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }],
    ...(exceptEnrollmentId ? { enrollmentId: { $ne: exceptEnrollmentId } } : {}),
  }).session(db);
}

/** A full section is a warning (default) or a refusal, depending on the school's setting. Returns the warnings. */
async function checkCapacity(ctx: ServiceContext, section: SectionOfferingDoc, date: string, policy: 'WARN' | 'BLOCK', db: ClientSession, exceptEnrollmentId?: string): Promise<SectionWarningDTO[]> {
  if (section.capacity === null || section.capacity === undefined) return [];
  const count = await occupancy(ctx, section._id, date, db, exceptEnrollmentId);
  if (count < section.capacity) return [];
  const message = `${section.displayName} already has ${count} of ${section.capacity} students.`;
  if (policy === 'BLOCK') throw new AppError('SECTION_FULL', `${message} Choose another section.`, { sectionId: section._id, capacity: section.capacity, enrolled: count });
  return [{ code: 'SECTION_FULL', message: `${message} The section is over its limit.` }];
}

/** Roll numbers already used in a section on or after `from` (rows that have not ended or been cancelled). */
async function takenRolls(ctx: ServiceContext, sectionId: string, from: string, db: ClientSession, exceptAssignmentId?: string): Promise<string[]> {
  const rows = await StudentSectionAssignment.find({
    tenantId: ctx.tenantId,
    sectionId,
    cancelledAt: null,
    rollNumber: { $ne: null },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: from } }],
    ...(exceptAssignmentId ? { _id: { $ne: exceptAssignmentId } } : {}),
  })
    .session(db)
    .select('rollNumber')
    .lean<{ rollNumber: string }[]>();
  return rows.map((r) => r.rollNumber);
}

async function resolveRoll(ctx: ServiceContext, sectionId: string, roll: string | null | undefined, from: string, db: ClientSession, exceptAssignmentId?: string): Promise<string | null> {
  if (roll === undefined || roll === null) return null;
  const taken = await takenRolls(ctx, sectionId, from, db, exceptAssignmentId);
  if (roll === AUTO_ROLL) return nextFreeRoll(taken);
  if (taken.includes(roll)) throw new AppError('ROLL_NUMBER_TAKEN', undefined, { fields: { rollNumber: 'Another student in this section already has this roll number.' } });
  return roll;
}

function mapRollDuplicate(err: unknown): never {
  const fields = duplicateKeyFields(err);
  if (fields?.includes('rollNumber')) throw new AppError('ROLL_NUMBER_TAKEN', undefined, { fields: { rollNumber: 'Another student in this section already has this roll number.' } });
  if (fields?.includes('enrollmentId')) throw new AppError('SECTION_ALREADY_ASSIGNED');
  if (fields?.includes('academicSessionId')) throw new AppError('ENROLLMENT_ALREADY_OPEN');
  throw err;
}

// ───────────────────────────────────────────────────────────── sections: assign

/** Puts the enrollment in a section (inside the caller's transaction). The student has no section yet. */
export async function assignSectionInTx(
  ctx: ServiceContext,
  db: ClientSession,
  enrollment: StudentEnrollmentDoc,
  input: { sectionId: string; rollNumber?: string | undefined; effectiveFrom?: string | undefined; reason?: string | null },
  settings: { sectionCapacityPolicy: 'WARN' | 'BLOCK' },
): Promise<{ assignment: StudentSectionAssignmentDoc; warnings: SectionWarningDTO[] }> {
  const today = await todayFor(ctx, db);
  const usable = await academicService.assertSectionUsable(ctx, input.sectionId, { purpose: 'NEW_ASSIGNMENT' }, db);
  if (usable.classOffering.classOfferingId !== enrollment.classOfferingId) throw new AppError('SECTION_CLASS_MISMATCH');
  const section = (await SectionOffering.findOne({ _id: input.sectionId, tenantId: ctx.tenantId }).session(db).lean<SectionOfferingDoc>())!;

  const existing = await StudentSectionAssignment.exists({ tenantId: ctx.tenantId, enrollmentId: enrollment._id, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: enrollment.effectiveFrom } }] }).session(db);
  if (existing) throw new AppError('SECTION_ALREADY_ASSIGNED');

  const from = input.effectiveFrom ?? latest(today, enrollment.effectiveFrom);
  assertWithin(from, enrollment.effectiveFrom, enrollment.effectiveTo, 'effectiveFrom', 'the enrollment');
  const warnings = await checkCapacity(ctx, section, from, settings.sectionCapacityPolicy, db);
  const rollNumber = await resolveRoll(ctx, section._id, input.rollNumber, from, db);

  const [created] = await StudentSectionAssignment.create(
    [
      {
        tenantId: ctx.tenantId,
        studentId: enrollment.studentId,
        enrollmentId: enrollment._id,
        classOfferingId: enrollment.classOfferingId,
        sectionId: section._id,
        rollNumber,
        effectiveFrom: from,
        reason: input.reason ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ],
    { session: db },
  );
  const assignment = created!.toObject() as StudentSectionAssignmentDoc;
  await recordStudentAudit(ctx, db, {
    entityType: 'section_assignment',
    entityId: assignment._id,
    action: 'section_assignment.created',
    changes: diffFields({}, assignment, ASSIGNMENT_AUDITED),
    studentId: enrollment.studentId,
    metadata: { enrollmentId: enrollment._id, sectionName: section.displayName },
  });
  return { assignment, warnings };
}

export async function assignSection(ctx: ServiceContext, enrollmentId: string, data: AssignSectionData): Promise<SectionAssignmentResultDTO> {
  const school = await requireSchool(ctx);
  try {
    const result = await withTransaction(async (db) => {
      const enrollment = await loadEnrollment(ctx, enrollmentId, db);
      assertStudentWritable(await loadStudent(ctx, enrollment.studentId, db));
      if (enrollment.state !== 'OPEN') throw new AppError('ENROLLMENT_CLOSED');
      const settings = await getEffectiveSettings(ctx, school, db);
      return assignSectionInTx(ctx, db, enrollment, data, settings);
    });
    return { assignment: (await toSectionAssignmentDTOs(ctx, [result.assignment]))[0]!, warnings: result.warnings };
  } catch (err) {
    mapRollDuplicate(err);
  }
}

/** Changes (or clears) the roll number of a placement in place. The change is audited. */
export async function updateSectionAssignment(ctx: ServiceContext, assignmentId: string, data: UpdateSectionAssignmentData): Promise<SectionAssignmentDTO> {
  try {
    const updated = await withTransaction(async (db) => {
      const before = await StudentSectionAssignment.findOne({ _id: assignmentId, tenantId: ctx.tenantId }).session(db).lean<StudentSectionAssignmentDoc>();
      if (!before) throw AppError.notFound('Section placement not found.');
      assertStudentWritable(await loadStudent(ctx, before.studentId, db));
      if (before.cancelledAt || before.effectiveTo) throw AppError.validation({ rollNumber: 'This placement has ended. Change the roll number on the current one.' });
      const rollNumber = await resolveRoll(ctx, before.sectionId, data.rollNumber, before.effectiveFrom, db, before._id);
      if (rollNumber !== (before.rollNumber ?? null)) {
        await StudentSectionAssignment.updateOne({ _id: before._id, tenantId: ctx.tenantId }, { $set: { rollNumber, updatedBy: ctx.userId } }, { session: db });
        await recordStudentAudit(ctx, db, {
          entityType: 'section_assignment',
          entityId: before._id,
          action: 'section_assignment.updated',
          changes: diffFields(before, { ...before, rollNumber }, ['rollNumber']),
          studentId: before.studentId,
          metadata: { enrollmentId: before.enrollmentId },
        });
      }
      return { ...before, rollNumber };
    });
    return (await toSectionAssignmentDTOs(ctx, [updated]))[0]!;
  } catch (err) {
    mapRollDuplicate(err);
  }
}

// ───────────────────────────────────────────────────────────── sections: recommend and bulk roll numbers

export async function recommendSections(ctx: ServiceContext, data: RecommendSectionData): Promise<SectionRecommendationDTO[]> {
  const offering = await ClassOffering.findOne({ _id: data.classOfferingId, tenantId: ctx.tenantId }).lean<ClassOfferingDoc>();
  if (!offering) throw AppError.notFound('Class not found.');
  const today = await todayFor(ctx);
  const sections = await SectionOffering.find({ tenantId: ctx.tenantId, classOfferingId: offering._id, status: 'ACTIVE' }).sort({ sequenceOrder: 1, sectionCode: 1 }).lean<SectionOfferingDoc[]>();
  const counts = await StudentSectionAssignment.aggregate<{ _id: string; n: number }>([
    { $match: { tenantId: ctx.tenantId, classOfferingId: offering._id, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] } },
    { $group: { _id: '$sectionId', n: { $sum: 1 } } },
  ]);
  const enrolledIn = new Map(counts.map((c) => [c._id, c.n]));
  const rows = sections.map((s) => {
    const enrolled = enrolledIn.get(s._id) ?? 0;
    const free = s.capacity === null || s.capacity === undefined ? null : Math.max(0, s.capacity - enrolled);
    return { s, enrolled, free, isFull: free !== null && free === 0 };
  });
  // Most free space first; a section with no limit ranks by who has the fewest students.
  const ranked = [...rows].sort((a, b) => {
    if (a.isFull !== b.isFull) return a.isFull ? 1 : -1;
    const fa = a.free ?? Number.MAX_SAFE_INTEGER - a.enrolled;
    const fb = b.free ?? Number.MAX_SAFE_INTEGER - b.enrolled;
    return fb - fa || a.s.sequenceOrder - b.s.sequenceOrder;
  });
  return ranked.map(({ s, enrolled, free, isFull }, index) => ({
    sectionId: s._id,
    sectionCode: s.sectionCode,
    sectionName: s.displayName,
    capacity: s.capacity ?? null,
    enrolled,
    free,
    isFull,
    recommended: index === 0 && !isFull,
    label: `${offering.displayCode}-${s.sectionCode} · ${enrolled}${s.capacity ? ` of ${s.capacity}` : ''}`,
  }));
}

/** Numbers a whole section in one go. `apply: false` (the default) only shows the plan. */
export async function bulkRollNumbers(ctx: ServiceContext, data: BulkRollNumbersData): Promise<BulkRollNumbersDTO> {
  const section = await SectionOffering.findOne({ _id: data.sectionId, tenantId: ctx.tenantId }).lean<SectionOfferingDoc>();
  if (!section) throw AppError.notFound('Section not found.');
  const today = await todayFor(ctx);

  const plan = async (db: ClientSession | null) => {
    const rows = await StudentSectionAssignment.find({ tenantId: ctx.tenantId, sectionId: section._id, cancelledAt: null, effectiveTo: null }).session(db).lean<StudentSectionAssignmentDoc[]>();
    const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: rows.map((r) => r.studentId) } }).session(db).lean<StudentDoc[]>();
    const [people, admissions] = await Promise.all([
      Person.find({ tenantId: ctx.tenantId, _id: { $in: students.map((s) => s.personId) } }).session(db).lean<PersonDoc[]>(),
      StudentAdmission.find({ tenantId: ctx.tenantId, studentId: { $in: students.map((s) => s._id) }, isCurrent: true }).session(db).lean<StudentAdmissionDoc[]>(),
    ]);
    const personOf = new Map(people.map((p) => [p._id, p]));
    const studentOf = new Map(students.map((s) => [s._id, s]));
    const admissionOf = new Map(admissions.map((a) => [a.studentId, a.admissionNumber]));
    const items = rows.map((r) => {
      const student = studentOf.get(r.studentId)!;
      const person = personOf.get(student.personId)!;
      return { row: r, fullName: fullNameOf(person), sortName: `${person.legalFirstName} ${person.legalLastName}`, admissionNumber: admissionOf.get(r.studentId) ?? null };
    });
    items.sort((a, b) => (data.order === 'ADMISSION_NUMBER' ? naturalCompare(a.admissionNumber ?? '~', b.admissionNumber ?? '~') : naturalCompare(a.sortName, b.sortName)) || a.row._id.localeCompare(b.row._id));
    return items.map((item, i) => ({ sectionAssignmentId: item.row._id, studentId: item.row.studentId, fullName: item.fullName, admissionNumber: item.admissionNumber, currentRoll: item.row.rollNumber ?? null, newRoll: String(i + 1) }));
  };

  if (!data.apply) return { sectionId: section._id, order: data.order, applied: false, rows: await plan(null) };

  const rows = await withTransaction(async (db) => {
    const planned = await plan(db);
    // Two steps, so swapping numbers never clashes: clear them all, then number them.
    await StudentSectionAssignment.updateMany({ tenantId: ctx.tenantId, _id: { $in: planned.map((p) => p.sectionAssignmentId) } }, { $set: { rollNumber: null, updatedBy: ctx.userId } }, { session: db });
    for (const p of planned) {
      await StudentSectionAssignment.updateOne({ _id: p.sectionAssignmentId, tenantId: ctx.tenantId }, { $set: { rollNumber: p.newRoll } }, { session: db });
      if (p.currentRoll !== p.newRoll) {
        await recordStudentAudit(ctx, db, {
          entityType: 'section_assignment',
          entityId: p.sectionAssignmentId,
          action: 'section_assignment.updated',
          changes: [{ field: 'rollNumber', from: p.currentRoll, to: p.newRoll }],
          studentId: p.studentId,
          metadata: { sectionName: section.displayName, bulk: true, order: data.order, date: today },
        });
      }
    }
    return planned;
  });
  return { sectionId: section._id, order: data.order, applied: true, rows };
}

// ───────────────────────────────────────────────────────────── section change in the middle of a year

/**
 * Moves a student to another section of the same class on a date. The old placement ends the day before, a new one starts, and a
 * movement row is written. The old row stays, so attendance and results can still see the old section.
 */
export async function transferSection(ctx: ServiceContext, studentId: string, data: SectionTransferData): Promise<SectionTransferResultDTO> {
  const school = await requireSchool(ctx);
  try {
    const result = await withTransaction(async (db) => {
      const student = await loadStudent(ctx, studentId, db);
      assertStudentWritable(student);
      const settings = await getEffectiveSettings(ctx, school, db);

      // The enrollment the move happens in: the OPEN one that covers the date.
      const enrollments = await StudentEnrollment.find({ tenantId: ctx.tenantId, studentId, state: 'OPEN' }).session(db).lean<StudentEnrollmentDoc[]>();
      const enrollment = enrollments.find((e) => e.effectiveFrom <= data.effectiveDate && (!e.effectiveTo || e.effectiveTo >= data.effectiveDate));
      if (!enrollment) throw AppError.validation({ effectiveDate: 'The student is not enrolled in a class on this date.' });

      const usable = await academicService.assertSectionUsable(ctx, data.toSectionId, { purpose: 'NEW_ASSIGNMENT' }, db);
      if (usable.classOffering.classOfferingId !== enrollment.classOfferingId) throw new AppError('SECTION_CLASS_MISMATCH');
      const target = (await SectionOffering.findOne({ _id: data.toSectionId, tenantId: ctx.tenantId }).session(db).lean<SectionOfferingDoc>())!;

      const old = await StudentSectionAssignment.findOne({ tenantId: ctx.tenantId, enrollmentId: enrollment._id, cancelledAt: null, effectiveFrom: { $lte: data.effectiveDate }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: data.effectiveDate } }] })
        .session(db)
        .lean<StudentSectionAssignmentDoc>();
      if (!old) throw AppError.validation({ effectiveDate: 'The student has no section on this date. Give them a section first.' });
      if (old.sectionId === target._id) throw AppError.validation({ toSectionId: 'The student is already in this section.' });
      if (data.effectiveDate < old.effectiveFrom) throw AppError.validation({ effectiveDate: `The move cannot start before the current section does (${old.effectiveFrom}).` });

      const warnings = await checkCapacity(ctx, target, data.effectiveDate, settings.sectionCapacityPolicy, db, enrollment._id);

      // End the old placement the day before. The roll number is released the moment it ends.
      const ended = endPatch(old, dayBefore(data.effectiveDate));
      await StudentSectionAssignment.updateOne({ _id: old._id, tenantId: ctx.tenantId }, { $set: { ...ended, updatedBy: ctx.userId } }, { session: db });
      await recordStudentAudit(ctx, db, {
        entityType: 'section_assignment',
        entityId: old._id,
        action: 'section_assignment.ended',
        changes: 'effectiveTo' in ended ? [{ field: 'effectiveTo', from: null, to: ended.effectiveTo }] : [{ field: 'cancelledAt', from: null, to: new Date().toISOString() }],
        studentId,
        metadata: { enrollmentId: enrollment._id, reason: data.reason },
      });

      // A student who had a roll number gets one in the new section too (the next free one, unless a number was typed).
      const wantedRoll = data.rollNumber ?? (old.rollNumber ? AUTO_ROLL : undefined);
      const rollNumber = await resolveRoll(ctx, target._id, wantedRoll, data.effectiveDate, db);
      const [created] = await StudentSectionAssignment.create(
        [
          {
            tenantId: ctx.tenantId,
            studentId,
            enrollmentId: enrollment._id,
            classOfferingId: enrollment.classOfferingId,
            sectionId: target._id,
            rollNumber,
            effectiveFrom: data.effectiveDate,
            reason: data.reason,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      const next = created!.toObject() as StudentSectionAssignmentDoc;
      await recordStudentAudit(ctx, db, {
        entityType: 'section_assignment',
        entityId: next._id,
        action: 'section_assignment.transferred',
        changes: diffFields({}, next, ASSIGNMENT_AUDITED),
        studentId,
        metadata: { enrollmentId: enrollment._id, fromSectionId: old.sectionId, toSectionId: target._id, reason: data.reason },
      });

      const [event] = await StudentTransferEvent.create(
        [
          {
            tenantId: ctx.tenantId,
            studentId,
            type: 'SECTION',
            fromEnrollmentId: enrollment._id,
            toEnrollmentId: enrollment._id,
            fromSectionId: old.sectionId,
            toSectionId: target._id,
            effectiveDate: data.effectiveDate,
            reason: data.reason,
            actorId: ctx.userId,
          },
        ],
        { session: db },
      );
      return { oldId: old._id, next, event: event!.toObject(), warnings };
    });

    const [from] = await toSectionAssignmentDTOs(ctx, [(await StudentSectionAssignment.findOne({ _id: result.oldId, tenantId: ctx.tenantId }).lean<StudentSectionAssignmentDoc>())!]);
    const [to] = await toSectionAssignmentDTOs(ctx, [result.next]);
    return { from: from!, to: to!, event: toTransferEventDTO(result.event), warnings: result.warnings };
  } catch (err) {
    mapRollDuplicate(err);
  }
}

// ───────────────────────────────────────────────────────────── enrollments

/** Creates the OPEN enrollment row and its audit event, inside the caller's transaction. */
export async function createEnrollmentInTx(
  ctx: ServiceContext,
  db: ClientSession,
  input: {
    studentId: string;
    schoolId: string;
    session: AcademicSessionDoc;
    offering: ClassOfferingDoc;
    programmeId?: string | null | undefined;
    enrollmentType: StudentEnrollmentDoc['enrollmentType'];
    effectiveFrom: string;
    previousEnrollmentId?: string | null | undefined;
  },
): Promise<StudentEnrollmentDoc> {
  if (input.programmeId) await assertProgrammeForClass(ctx, input.programmeId, input.offering, db);
  assertWithin(input.effectiveFrom, input.session.startDate, input.session.endDate, 'effectiveFrom', 'the academic session');
  const open = await StudentEnrollment.exists({ tenantId: ctx.tenantId, studentId: input.studentId, academicSessionId: input.session._id, state: 'OPEN' }).session(db);
  if (open) throw new AppError('ENROLLMENT_ALREADY_OPEN');
  const [created] = await StudentEnrollment.create(
    [
      {
        _id: randomUUID(),
        tenantId: ctx.tenantId,
        schoolId: input.schoolId,
        studentId: input.studentId,
        academicSessionId: input.session._id,
        locationId: input.offering.locationId,
        classOfferingId: input.offering._id,
        programmeId: input.programmeId ?? null,
        enrollmentType: input.enrollmentType,
        effectiveFrom: input.effectiveFrom,
        state: 'OPEN',
        previousEnrollmentId: input.previousEnrollmentId ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ],
    { session: db },
  );
  const enrollment = created!.toObject() as StudentEnrollmentDoc;
  await recordStudentAudit(ctx, db, {
    entityType: 'enrollment',
    entityId: enrollment._id,
    action: 'enrollment.created',
    changes: diffFields({}, enrollment, ENROLLMENT_AUDITED),
    studentId: input.studentId,
    metadata: { className: input.offering.displayName, sessionCode: input.session.code },
  });
  return enrollment;
}

export async function listEnrollments(ctx: ServiceContext, studentId: string): Promise<EnrollmentDTO[]> {
  await loadStudent(ctx, studentId);
  const docs = await StudentEnrollment.find({ tenantId: ctx.tenantId, studentId }).sort({ effectiveFrom: -1, _id: 1 }).lean<StudentEnrollmentDoc[]>();
  return toEnrollmentDTOs(ctx, docs);
}

export async function getEnrollment(ctx: ServiceContext, enrollmentId: string): Promise<EnrollmentDTO> {
  const doc = await loadEnrollment(ctx, enrollmentId);
  return (await toEnrollmentDTOs(ctx, [doc]))[0]!;
}

export async function createEnrollment(ctx: ServiceContext, studentId: string, data: CreateEnrollmentData): Promise<CreateEnrollmentResultDTO> {
  const school = await requireSchool(ctx);
  try {
    const result = await withTransaction(async (db) => {
      const student = await loadStudent(ctx, studentId, db);
      assertStudentWritable(student);
      const session = await loadSession(ctx, data.academicSessionId, db);
      const offering = await resolveClassOffering(ctx, data, db);
      const today = await todayFor(ctx, db);
      const settings = await getEffectiveSettings(ctx, school, db);

      const effectiveFrom = data.effectiveFrom ?? (today < session.startDate ? session.startDate : today > session.endDate ? session.endDate : today);
      const enrollment = await createEnrollmentInTx(ctx, db, {
        studentId,
        schoolId: school._id,
        session,
        offering,
        programmeId: data.programmeId,
        enrollmentType: data.enrollmentType ?? 'CONTINUING',
        effectiveFrom,
        previousEnrollmentId: data.previousEnrollmentId,
      });
      const { added } = await initializeMandatoryInTx(ctx, enrollment, db);
      let warnings: SectionWarningDTO[] = [];
      if (data.sectionId) warnings = (await assignSectionInTx(ctx, db, enrollment, { sectionId: data.sectionId, rollNumber: data.rollNumber, effectiveFrom }, settings)).warnings;
      return { enrollmentId: enrollment._id, added: added.length, warnings };
    });
    return {
      enrollment: await getEnrollment(ctx, result.enrollmentId),
      mandatorySubjectsAdded: result.added,
      subjectsMessage: result.added > 0 ? `${result.added} mandatory subject${result.added === 1 ? '' : 's'} added` : null,
      warnings: result.warnings,
    };
  } catch (err) {
    mapRollDuplicate(err);
  }
}

/**
 * A programme change. Without `confirm: true` it only returns what would happen (kept, added, no longer valid, still undecided).
 * With it, the change is saved in one transaction, together with the subjects it affects.
 */
export async function updateEnrollment(ctx: ServiceContext, enrollmentId: string, data: UpdateEnrollmentData): Promise<ProgrammeChangePreviewDTO> {
  const preview = await withTransaction(async (db) => {
    const before = await loadEnrollment(ctx, enrollmentId, db);
    assertStudentWritable(await loadStudent(ctx, before.studentId, db));
    if (before.state !== 'OPEN') throw new AppError('ENROLLMENT_CLOSED');
    assertVersion(before.version, data.version);
    const offering = await ClassOffering.findOne({ _id: before.classOfferingId, tenantId: ctx.tenantId }).session(db).lean<ClassOfferingDoc>();
    if (data.programmeId) await assertProgrammeForClass(ctx, data.programmeId, offering!, db);

    const planned = await previewProgramme(ctx, before, data.programmeId, db);
    if (!data.confirm || data.programmeId === (before.programmeId ?? null)) return planned.preview;

    const moved = await StudentEnrollment.updateOne(
      { _id: enrollmentId, tenantId: ctx.tenantId, version: data.version },
      { $set: { programmeId: data.programmeId, updatedBy: ctx.userId }, $inc: { version: 1 } },
      { session: db },
    );
    if (moved.matchedCount !== 1) throw new AppError('VERSION_CONFLICT');
    await applyProgrammeChange(ctx, db, before, planned);
    await recordStudentAudit(ctx, db, {
      entityType: 'enrollment',
      entityId: enrollmentId,
      action: 'enrollment.programme_changed',
      changes: [{ field: 'programmeId', from: before.programmeId ?? null, to: data.programmeId }],
      studentId: before.studentId,
      metadata: { kept: planned.preview.kept.length, added: planned.preview.added.length, ended: planned.preview.noLongerValid.length },
    });
    return { ...planned.preview, saved: true };
  });
  return { ...preview, enrollment: preview.saved ? await getEnrollment(ctx, enrollmentId) : null };
}

/** Closes an enrollment: last day, outcome, and the section and subject rows inside it. Nothing is deleted. */
export async function completeEnrollment(ctx: ServiceContext, enrollmentId: string, data: CompleteEnrollmentData): Promise<EnrollmentDTO> {
  await withTransaction(async (db) => {
    const before = await loadEnrollment(ctx, enrollmentId, db);
    assertStudentWritable(await loadStudent(ctx, before.studentId, db));
    if (before.state !== 'OPEN') throw new AppError('ENROLLMENT_CLOSED');
    const today = await todayFor(ctx, db);
    const lastDay = data.effectiveTo ?? latest(today, before.effectiveFrom);
    if (lastDay < before.effectiveFrom) throw AppError.validation({ effectiveTo: `The last day cannot be before the enrollment starts (${before.effectiveFrom}).` });

    await StudentEnrollment.updateOne(
      { _id: enrollmentId, tenantId: ctx.tenantId },
      { $set: { state: 'COMPLETED', effectiveTo: lastDay, outcome: data.outcome ?? null, updatedBy: ctx.userId }, $inc: { version: 1 } },
      { session: db },
    );
    const open = await StudentSectionAssignment.find({ tenantId: ctx.tenantId, enrollmentId, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: lastDay } }] }).session(db).lean<StudentSectionAssignmentDoc[]>();
    for (const row of open) {
      const patch = endPatch(row, lastDay);
      await StudentSectionAssignment.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
      await recordStudentAudit(ctx, db, {
        entityType: 'section_assignment',
        entityId: row._id,
        action: 'section_assignment.ended',
        changes: 'effectiveTo' in patch ? [{ field: 'effectiveTo', from: row.effectiveTo ?? null, to: patch.effectiveTo }] : [{ field: 'cancelledAt', from: null, to: new Date().toISOString() }],
        studentId: before.studentId,
        metadata: { enrollmentId, reason: 'ENROLLMENT_COMPLETED' },
      });
    }
    await endAllSubjectRows(ctx, db, before, lastDay);
    await recordStudentAudit(ctx, db, {
      entityType: 'enrollment',
      entityId: enrollmentId,
      action: 'enrollment.completed',
      changes: diffFields(before, { ...before, state: 'COMPLETED', effectiveTo: lastDay, outcome: data.outcome ?? null }, ['state', 'effectiveTo', 'outcome']),
      studentId: before.studentId,
    });
  });
  return getEnrollment(ctx, enrollmentId);
}
