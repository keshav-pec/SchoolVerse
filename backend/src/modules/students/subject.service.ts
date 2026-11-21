import type { ClientSession } from 'mongoose';
import {
  type EndSubjectEnrollmentData,
  type InitializeSubjectsResultDTO,
  type ProgrammeChangePreviewDTO,
  type StudentSubjectDTO,
  type StudentSubjectsDTO,
  type SubjectSelectionResultDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { academicService } from '../academic/academic.service';
import { ClassOffering, SubjectOffering, type ClassOfferingDoc, type SubjectOfferingDoc } from '../academic/offering.model';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup, type AcademicProgrammeDoc, type SubjectChoiceConstraintDoc, type SubjectChoiceGroupDoc } from '../academic/rules.model';
import { ClassMaster } from '../academic/reference.model';
import { Subject, type SubjectDoc } from '../academic/subject.model';
import { assignmentStatus, latest, todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { assertStudentWritable, loadEnrollment, loadStudent } from './guards';
import { dayBefore, endPatch } from './rows';
import { checkSubjectSelection, UNDECIDED_CODES, type CheckGroup, type CheckOffering, type CheckProgramme, type SubjectCheckInput } from './rules';
import { StudentSubjectEnrollment, type StudentEnrollmentDoc, type StudentSubjectEnrollmentDoc } from './student.models';

/** SPM-17 to SPM-19 — a student's subjects inside one enrollment, checked against the Module 2 rules. */

// ───────────────────────────────────────────────────────────── the class's rules

export interface ClassRules {
  classOffering: ClassOfferingDoc;
  offerings: SubjectOfferingDoc[];
  subjectName: Map<string, string>;
  check: Pick<SubjectCheckInput, 'offerings' | 'groups' | 'constraints'>;
}

export async function loadClassRules(ctx: ServiceContext, classOfferingId: string, db?: ClientSession): Promise<ClassRules> {
  const tenantId = ctx.tenantId;
  const classOffering = await ClassOffering.findOne({ _id: classOfferingId, tenantId }).session(db ?? null).lean<ClassOfferingDoc>();
  if (!classOffering) throw AppError.notFound('Class not found.');
  const [offerings, groups, constraints] = await Promise.all([
    SubjectOffering.find({ tenantId, classOfferingId }).session(db ?? null).lean<SubjectOfferingDoc[]>(),
    SubjectChoiceGroup.find({ tenantId, classOfferingId }).sort({ sequence: 1 }).session(db ?? null).lean<SubjectChoiceGroupDoc[]>(),
    SubjectChoiceConstraint.find({ tenantId, classOfferingId }).session(db ?? null).lean<SubjectChoiceConstraintDoc[]>(),
  ]);
  const subjects = await Subject.find({ tenantId, _id: { $in: [...new Set(offerings.map((o) => o.subjectId))] } }).session(db ?? null).lean<SubjectDoc[]>();
  const nameBySubject = new Map(subjects.map((s) => [s._id, s.name]));
  const subjectName = new Map(offerings.map((o) => [o._id, nameBySubject.get(o.subjectId) ?? 'Unknown subject']));
  const checkOfferings: CheckOffering[] = offerings.map((o) => ({ id: o._id, name: subjectName.get(o._id)!, type: o.offeringType, active: o.status === 'ACTIVE' }));
  const checkGroups: CheckGroup[] = groups.map((g) => ({ id: g._id, name: g.name, ruleType: g.ruleType, min: g.min, max: g.max, subjectOfferingIds: g.subjectOfferingIds, active: g.status === 'ACTIVE' }));
  return {
    classOffering,
    offerings,
    subjectName,
    check: { offerings: checkOfferings, groups: checkGroups, constraints: constraints.map((c) => ({ type: c.type, subjectOfferingId: c.subjectOfferingId, otherSubjectOfferingId: c.otherSubjectOfferingId })) },
  };
}

export async function loadCheckProgramme(ctx: ServiceContext, programmeId: string | null | undefined, db?: ClientSession): Promise<CheckProgramme | null> {
  if (!programmeId) return null;
  const doc = await AcademicProgramme.findOne({ _id: programmeId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicProgrammeDoc>();
  if (!doc) return null;
  return { name: doc.name, kind: doc.kind, subjectRules: doc.subjectRules.map((r) => ({ subjectOfferingId: r.subjectOfferingId, requirement: r.requirement })), choiceMin: doc.choiceMin ?? null, choiceMax: doc.choiceMax ?? null };
}

// ───────────────────────────────────────────────────────────── rows

/** The rows that count for a student from today on: not cancelled, and not ended before today. */
export async function liveSubjectRows(ctx: ServiceContext, enrollmentId: string, today: string, db?: ClientSession): Promise<StudentSubjectEnrollmentDoc[]> {
  return StudentSubjectEnrollment.find({ tenantId: ctx.tenantId, enrollmentId, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] })
    .session(db ?? null)
    .lean<StudentSubjectEnrollmentDoc[]>();
}

export async function toSubjectDTOs(ctx: ServiceContext, rows: StudentSubjectEnrollmentDoc[], today: string, db?: ClientSession): Promise<StudentSubjectDTO[]> {
  if (rows.length === 0) return [];
  const offerings = await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(rows.map((r) => r.subjectOfferingId))] } }).session(db ?? null).lean<SubjectOfferingDoc[]>();
  const subjects = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(offerings.map((o) => o.subjectId))] } }).session(db ?? null).lean<SubjectDoc[]>();
  const offeringOf = new Map(offerings.map((o) => [o._id, o]));
  const subjectOf = new Map(subjects.map((s) => [s._id, s]));
  return rows.map((r) => {
    const offering = offeringOf.get(r.subjectOfferingId);
    const subject = offering ? subjectOf.get(offering.subjectId) : undefined;
    return {
      subjectEnrollmentId: r._id,
      enrollmentId: r.enrollmentId,
      subjectOfferingId: r.subjectOfferingId,
      subjectId: offering?.subjectId ?? '',
      subjectCode: subject?.subjectCode ?? '',
      subjectName: subject?.name ?? 'Unknown subject',
      offeringType: offering?.offeringType ?? 'MANDATORY',
      source: r.source,
      isMandatory: r.isMandatory,
      effectiveFrom: r.effectiveFrom,
      effectiveTo: r.effectiveTo ?? null,
      status: assignmentStatus(r, today),
    };
  });
}

function assertOpen(enrollment: StudentEnrollmentDoc) {
  if (enrollment.state !== 'OPEN') throw new AppError('ENROLLMENT_CLOSED');
}

const plural = (n: number) => `${n} mandatory subject${n === 1 ? '' : 's'}`;

// ───────────────────────────────────────────────────────────── initialize

/**
 * Adds every mandatory subject offering of the class (`AUTO_MANDATORY`). Safe to run again: a subject the student already has
 * is skipped. Runs inside the caller's transaction (Quick Add, enrollment, promotion).
 */
export async function initializeMandatoryInTx(ctx: ServiceContext, enrollment: StudentEnrollmentDoc, db: ClientSession): Promise<{ added: StudentSubjectEnrollmentDoc[] }> {
  const today = await todayFor(ctx, db);
  const rules = await loadClassRules(ctx, enrollment.classOfferingId, db);
  const mandatory = checkSubjectSelection({ ...rules.check, programme: null, selected: [], addMandatory: true }).mandatoryOfferingIds;
  const have = new Set((await liveSubjectRows(ctx, enrollment._id, today, db)).map((r) => r.subjectOfferingId));
  const added: StudentSubjectEnrollmentDoc[] = [];
  for (const subjectOfferingId of mandatory) {
    if (have.has(subjectOfferingId)) continue;
    const [row] = await StudentSubjectEnrollment.create(
      [
        {
          tenantId: ctx.tenantId,
          studentId: enrollment.studentId,
          enrollmentId: enrollment._id,
          subjectOfferingId,
          source: 'AUTO_MANDATORY',
          isMandatory: true,
          effectiveFrom: enrollment.effectiveFrom,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    const doc = row!.toObject() as StudentSubjectEnrollmentDoc;
    added.push(doc);
    await recordStudentAudit(ctx, db, {
      entityType: 'subject_enrollment',
      entityId: doc._id,
      action: 'subject_enrollment.created',
      changes: [{ field: 'subjectOfferingId', from: null, to: subjectOfferingId }, { field: 'source', from: null, to: 'AUTO_MANDATORY' }],
      studentId: enrollment.studentId,
      metadata: { enrollmentId: enrollment._id, subjectName: rules.subjectName.get(subjectOfferingId) },
    });
  }
  return { added };
}

export async function initializeSubjects(ctx: ServiceContext, enrollmentId: string): Promise<InitializeSubjectsResultDTO> {
  const { added, today } = await withTransaction(async (db) => {
    const enrollment = await loadEnrollment(ctx, enrollmentId, db);
    assertStudentWritable(await loadStudent(ctx, enrollment.studentId, db));
    assertOpen(enrollment);
    return { ...(await initializeMandatoryInTx(ctx, enrollment, db)), today: await todayFor(ctx, db) };
  });
  return {
    added: added.length,
    message: added.length > 0 ? `${plural(added.length)} added` : 'All mandatory subjects were already added.',
    subjects: await toSubjectDTOs(ctx, added, today),
  };
}

// ───────────────────────────────────────────────────────────── checks

/** The check of what the student takes now: `valid: false` means a choice is missing or wrong. */
export async function checkCurrentSelection(ctx: ServiceContext, enrollment: StudentEnrollmentDoc, today: string, db?: ClientSession): Promise<SubjectSelectionResultDTO> {
  const [rules, rows, programme] = await Promise.all([
    loadClassRules(ctx, enrollment.classOfferingId, db),
    liveSubjectRows(ctx, enrollment._id, today, db),
    loadCheckProgramme(ctx, enrollment.programmeId, db),
  ]);
  return checkSubjectSelection({ ...rules.check, programme, selected: rows.map((r) => r.subjectOfferingId), addMandatory: false });
}

export async function validateSelection(ctx: ServiceContext, enrollmentId: string, subjectOfferingIds: string[]): Promise<SubjectSelectionResultDTO> {
  const enrollment = await loadEnrollment(ctx, enrollmentId);
  const [rules, programme] = await Promise.all([loadClassRules(ctx, enrollment.classOfferingId), loadCheckProgramme(ctx, enrollment.programmeId)]);
  return checkSubjectSelection({ ...rules.check, programme, selected: [...new Set(subjectOfferingIds)], addMandatory: true });
}

export async function listSubjects(ctx: ServiceContext, enrollmentId: string, options: { includeEnded?: boolean } = {}): Promise<StudentSubjectsDTO> {
  const enrollment = await loadEnrollment(ctx, enrollmentId);
  const today = await todayFor(ctx);
  const rows = await StudentSubjectEnrollment.find({
    tenantId: ctx.tenantId,
    enrollmentId,
    ...(options.includeEnded ? {} : { cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] }),
  })
    .sort({ isMandatory: -1, effectiveFrom: 1, _id: 1 })
    .lean<StudentSubjectEnrollmentDoc[]>();
  const [subjects, selection] = await Promise.all([toSubjectDTOs(ctx, rows, today), checkCurrentSelection(ctx, enrollment, today)]);
  return { enrollmentId, subjects, selection, choicePending: !selection.valid };
}

// ───────────────────────────────────────────────────────────── save a choice

function failWith(result: SubjectSelectionResultDTO): never {
  throw new AppError('SUBJECT_CHOICE_INVALID', result.problems.map((p) => p.message).join(' '), { problems: result.problems });
}

/**
 * Saves a valid choice: the listed subjects plus the mandatory ones. Subjects the student already has stay as they are,
 * new ones start today (or when the enrollment starts), and ones left out end the day before. History is kept.
 */
export async function saveSelection(ctx: ServiceContext, enrollmentId: string, subjectOfferingIds: string[]): Promise<StudentSubjectsDTO> {
  await withTransaction(async (db) => {
    const enrollment = await loadEnrollment(ctx, enrollmentId, db);
    assertStudentWritable(await loadStudent(ctx, enrollment.studentId, db));
    assertOpen(enrollment);
    const today = await todayFor(ctx, db);
    const [rules, programme, live] = await Promise.all([
      loadClassRules(ctx, enrollment.classOfferingId, db),
      loadCheckProgramme(ctx, enrollment.programmeId, db),
      liveSubjectRows(ctx, enrollmentId, today, db),
    ]);
    const result = checkSubjectSelection({ ...rules.check, programme, selected: [...new Set(subjectOfferingIds)], addMandatory: true });
    if (!result.valid) failWith(result);

    const wanted = new Set(result.selectedOfferingIds);
    const have = new Map(live.map((r) => [r.subjectOfferingId, r]));
    const start = latest(today, enrollment.effectiveFrom);

    for (const id of wanted) {
      if (have.has(id)) continue;
      // The offering must belong to this class, session and location, and still be usable.
      const usable = await academicService.assertSubjectOfferingUsable(ctx, id, { purpose: 'NEW_ASSIGNMENT' }, db);
      if (usable.classOffering.classOfferingId !== enrollment.classOfferingId) throw AppError.validation({ subjectOfferingIds: 'Choose subjects that are offered for the student’s class.' });
      const [row] = await StudentSubjectEnrollment.create(
        [
          {
            tenantId: ctx.tenantId,
            studentId: enrollment.studentId,
            enrollmentId,
            subjectOfferingId: id,
            source: 'ADMIN_SELECTED',
            isMandatory: result.mandatoryOfferingIds.includes(id),
            effectiveFrom: start,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      await recordStudentAudit(ctx, db, {
        entityType: 'subject_enrollment',
        entityId: row!._id,
        action: 'subject_enrollment.created',
        changes: [{ field: 'subjectOfferingId', from: null, to: id }, { field: 'source', from: null, to: 'ADMIN_SELECTED' }],
        studentId: enrollment.studentId,
        metadata: { enrollmentId, subjectName: rules.subjectName.get(id) },
      });
    }
    for (const [id, row] of have) {
      if (wanted.has(id)) continue;
      await endRow(ctx, db, enrollment, row, dayBefore(today), rules.subjectName.get(id));
    }
  });
  return listSubjects(ctx, enrollmentId);
}

async function endRow(ctx: ServiceContext, db: ClientSession, enrollment: Pick<StudentEnrollmentDoc, 'studentId' | '_id'>, row: StudentSubjectEnrollmentDoc, lastDay: string, subjectName?: string) {
  const patch = endPatch(row, lastDay);
  await StudentSubjectEnrollment.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
  await recordStudentAudit(ctx, db, {
    entityType: 'subject_enrollment',
    entityId: row._id,
    action: 'subject_enrollment.ended',
    changes: 'effectiveTo' in patch ? [{ field: 'effectiveTo', from: null, to: patch.effectiveTo }] : [{ field: 'cancelledAt', from: null, to: new Date().toISOString() }],
    studentId: enrollment.studentId,
    metadata: { enrollmentId: enrollment._id, subjectName, subjectOfferingId: row.subjectOfferingId },
  });
}

/** Ends every subject row of an enrollment from `lastDay` (used when an enrollment is completed). */
export async function endAllSubjectRows(ctx: ServiceContext, db: ClientSession, enrollment: StudentEnrollmentDoc, lastDay: string) {
  const rows = await StudentSubjectEnrollment.find({ tenantId: ctx.tenantId, enrollmentId: enrollment._id, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: lastDay } }] })
    .session(db)
    .lean<StudentSubjectEnrollmentDoc[]>();
  for (const row of rows) await endRow(ctx, db, enrollment, row, lastDay);
}

export async function endSubjectEnrollment(ctx: ServiceContext, subjectEnrollmentId: string, data: EndSubjectEnrollmentData): Promise<StudentSubjectDTO> {
  return withTransaction(async (db) => {
    const row = await StudentSubjectEnrollment.findOne({ _id: subjectEnrollmentId, tenantId: ctx.tenantId }).session(db).lean<StudentSubjectEnrollmentDoc>();
    if (!row) throw AppError.notFound('Subject not found.');
    const enrollment = await loadEnrollment(ctx, row.enrollmentId, db);
    assertStudentWritable(await loadStudent(ctx, row.studentId, db));
    assertOpen(enrollment);
    const today = await todayFor(ctx, db);
    if (row.cancelledAt || (row.effectiveTo && row.effectiveTo < today)) throw AppError.validation({ subjectEnrollmentId: 'This subject has already ended.' });
    if (row.isMandatory) throw new AppError('SUBJECT_CHOICE_INVALID', 'Required subjects cannot be ended.', { problems: [{ code: 'MISSING_MANDATORY', message: 'Required subjects cannot be ended.', subjectOfferingIds: [row.subjectOfferingId] }] });
    await endRow(ctx, db, enrollment, row, dayBefore(data.effectiveDate ?? today));
    const updated = await StudentSubjectEnrollment.findOne({ _id: row._id, tenantId: ctx.tenantId }).session(db).lean<StudentSubjectEnrollmentDoc>();
    return (await toSubjectDTOs(ctx, [updated!], today, db))[0]!;
  });
}

// ───────────────────────────────────────────────────────────── programme change

const names = (rules: ClassRules, ids: string[]) => ids.map((subjectOfferingId) => ({ subjectOfferingId, subjectName: rules.subjectName.get(subjectOfferingId) ?? 'Unknown subject' }));

/** A programme must exist at the class's session and location, be active, and cover the class (`PROGRAMME_NOT_FOR_CLASS`). */
export async function assertProgrammeForClass(ctx: ServiceContext, programmeId: string, classOffering: Pick<ClassOfferingDoc, 'sessionId' | 'locationId' | 'classId'>, db?: ClientSession): Promise<AcademicProgrammeDoc> {
  const programme = await AcademicProgramme.findOne({ _id: programmeId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicProgrammeDoc>();
  if (!programme) throw AppError.notFound('Programme not found.');
  const classes = await ClassMaster.find({ _id: { $in: [classOffering.classId, programme.classFromId, programme.classToId] } }).session(db ?? null).lean<{ _id: string; sequenceNumber: number }[]>();
  const seq = (id: string) => classes.find((c) => c._id === id)?.sequenceNumber ?? -1;
  const fits = programme.sessionId === classOffering.sessionId && programme.locationId === classOffering.locationId && programme.status === 'ACTIVE' && seq(programme.classFromId) <= seq(classOffering.classId) && seq(classOffering.classId) <= seq(programme.classToId);
  if (!fits) throw new AppError('PROGRAMME_NOT_FOR_CLASS');
  return programme;
}

/** What changing to `programmeId` would do to the student's current subjects. Nothing is written here. */
export async function previewProgramme(ctx: ServiceContext, enrollment: StudentEnrollmentDoc, programmeId: string | null, db?: ClientSession) {
  const today = await todayFor(ctx, db);
  const [rules, live, programme] = await Promise.all([loadClassRules(ctx, enrollment.classOfferingId, db), liveSubjectRows(ctx, enrollment._id, today, db), loadCheckProgramme(ctx, programmeId, db)]);
  const current = live.map((r) => r.subjectOfferingId);
  const mandatory = checkSubjectSelection({ ...rules.check, programme: null, selected: [], addMandatory: true }).mandatoryOfferingIds;

  let noLongerValid: string[] = [];
  let added: string[] = [];
  if (programme && programme.kind === 'STREAM') {
    const inRules = new Set(programme.subjectRules.map((r) => r.subjectOfferingId));
    noLongerValid = current.filter((id) => !mandatory.includes(id) && !inRules.has(id));
    added = programme.subjectRules.filter((r) => r.requirement === 'REQUIRED' && !current.includes(r.subjectOfferingId)).map((r) => r.subjectOfferingId);
  }
  const kept = current.filter((id) => !noLongerValid.includes(id));
  const after = checkSubjectSelection({ ...rules.check, programme, selected: [...kept, ...added], addMandatory: true });
  const undecided = after.problems.filter((p) => (UNDECIDED_CODES as readonly string[]).includes(p.code));
  const preview: ProgrammeChangePreviewDTO = {
    programmeId,
    programmeName: programme?.name ?? null,
    kept: names(rules, kept),
    added: names(rules, added),
    noLongerValid: names(rules, noLongerValid),
    undecided,
    saved: false,
    enrollment: null,
  };
  return { preview, rules, live, added, noLongerValid };
}

/** Applies a previewed programme change inside the caller's transaction (ends what is no longer valid, adds what the programme requires). */
export async function applyProgrammeChange(
  ctx: ServiceContext,
  db: ClientSession,
  enrollment: StudentEnrollmentDoc,
  planned: Awaited<ReturnType<typeof previewProgramme>>,
) {
  const today = await todayFor(ctx, db);
  for (const row of planned.live.filter((r) => planned.noLongerValid.includes(r.subjectOfferingId))) {
    await endRow(ctx, db, enrollment, row, dayBefore(today), planned.rules.subjectName.get(row.subjectOfferingId));
  }
  for (const subjectOfferingId of planned.added) {
    const [row] = await StudentSubjectEnrollment.create(
      [
        {
          tenantId: ctx.tenantId,
          studentId: enrollment.studentId,
          enrollmentId: enrollment._id,
          subjectOfferingId,
          source: 'PROGRAMME_DERIVED',
          isMandatory: false,
          effectiveFrom: latest(today, enrollment.effectiveFrom),
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    await recordStudentAudit(ctx, db, {
      entityType: 'subject_enrollment',
      entityId: row!._id,
      action: 'subject_enrollment.created',
      changes: [{ field: 'subjectOfferingId', from: null, to: subjectOfferingId }, { field: 'source', from: null, to: 'PROGRAMME_DERIVED' }],
      studentId: enrollment.studentId,
      metadata: { enrollmentId: enrollment._id, subjectName: planned.rules.subjectName.get(subjectOfferingId) },
    });
  }
}
