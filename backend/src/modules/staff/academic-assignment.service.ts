import type { ClientSession } from 'mongoose';
import {
  type AcademicUsabilityDTO,
  type CreateAcademicAssignmentsData,
  type EndAssignmentData,
  type FacultyAssignmentDTO,
  type SectionFacultyDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { academicService } from '../academic/academic.service';
import { ClassOffering, SectionOffering, SubjectOffering } from '../academic/offering.model';
import { AcademicSession } from '../academic/session.model';
import { getSessionOrThrow } from '../academic/session.service';
import { Subject } from '../academic/subject.model';
import { diffFields } from '../audit/diff';
import { AcademicAssignment, type AcademicAssignmentDoc } from './assignment.models';
import { auditScopeOf, recordStaffAudit } from './audit';
import { Employee } from './employee.model';
import { assertAssignable, assertWritable, loadEmployee } from './guards';
import { labelsFor } from './location-assignment.service';
import { toFacultyAssignmentDTO, displayNameOf } from './mappers';
import { Person, type PersonDoc } from './person.model';
import { assertLocationCoverage } from './placement';
import { assignmentStatus, latest, overlapping, todayFor } from './status';

/** FSM-04 — which classes, sections and subjects a faculty member covers, in which session. Offering IDs only (Module 2). */

const AUDITED = ['academicSessionId', 'locationId', 'classOfferingId', 'sectionId', 'subjectOfferingId', 'assignmentType', 'effectiveFrom', 'effectiveTo'] as const;

/** Names for a page of assignments, in a handful of batched lookups. */
async function dtosOf(ctx: ServiceContext, docs: AcademicAssignmentDoc[], db?: ClientSession): Promise<FacultyAssignmentDTO[]> {
  if (docs.length === 0) return [];
  const tenantId = ctx.tenantId;
  const ids = (pick: (d: AcademicAssignmentDoc) => string | null) => [...new Set(docs.map(pick).filter((id): id is string => Boolean(id)))];
  const [today, locations, sessions, classes, sections, subjectOfferings] = await Promise.all([
    todayFor(ctx, db),
    labelsFor(tenantId, ids((d) => d.locationId), db),
    AcademicSession.find({ tenantId, _id: { $in: ids((d) => d.academicSessionId) } }).session(db ?? null).select('code name').lean<{ _id: string; code: string; name: string }[]>(),
    ClassOffering.find({ tenantId, _id: { $in: ids((d) => d.classOfferingId) } }).session(db ?? null).select('displayName').lean<{ _id: string; displayName: string }[]>(),
    SectionOffering.find({ tenantId, _id: { $in: ids((d) => d.sectionId) } }).session(db ?? null).select('sectionCode displayName').lean<{ _id: string; sectionCode: string; displayName: string }[]>(),
    SubjectOffering.find({ tenantId, _id: { $in: ids((d) => d.subjectOfferingId) } }).session(db ?? null).select('subjectId').lean<{ _id: string; subjectId: string }[]>(),
  ]);
  const subjects = await Subject.find({ tenantId, _id: { $in: subjectOfferings.map((o) => o.subjectId) } }).session(db ?? null).select('name').lean<{ _id: string; name: string }[]>();

  const sessionOf = new Map(sessions.map((s) => [s._id, s]));
  const classOf = new Map(classes.map((g) => [g._id, g]));
  const sectionOf = new Map(sections.map((s) => [s._id, s]));
  const subjectNameOf = new Map(subjects.map((s) => [s._id, s.name]));
  const subjectOf = new Map(subjectOfferings.map((o) => [o._id, { subjectId: o.subjectId, name: subjectNameOf.get(o.subjectId) ?? 'Unknown subject' }]));

  return docs.map((d) =>
    toFacultyAssignmentDTO(
      d,
      {
        session: sessionOf.get(d.academicSessionId) ?? { code: '?', name: 'Unknown session' },
        location: locations.get(d.locationId) ?? { locationCode: '?', displayName: 'Unknown location' },
        schoolClassName: classOf.get(d.classOfferingId)?.displayName ?? 'Unknown class',
        section: d.sectionId ? sectionOf.get(d.sectionId) ?? null : null,
        subject: d.subjectOfferingId ? subjectOf.get(d.subjectOfferingId) ?? null : null,
      },
      today,
    ),
  );
}

export async function listAcademicAssignments(ctx: ServiceContext, employeeId: string, filter: { academicSessionId?: string } = {}): Promise<FacultyAssignmentDTO[]> {
  await loadEmployee(ctx, employeeId);
  const docs = await AcademicAssignment.find({ tenantId: ctx.tenantId, employeeId, ...(filter.academicSessionId ? { academicSessionId: filter.academicSessionId } : {}) })
    .sort({ effectiveFrom: -1, _id: 1 })
    .lean<AcademicAssignmentDoc[]>();
  return dtosOf(ctx, docs);
}

/** Finds the Location → Session → Class (→ Section → Subject) chain an item points at, and checks it all belongs together. */
async function resolveItem(
  ctx: ServiceContext,
  item: CreateAcademicAssignmentsData['items'][number],
  db: ClientSession,
): Promise<{ chain: AcademicUsabilityDTO; classOfferingId: string }> {
  const purpose = { purpose: 'NEW_ASSIGNMENT' } as const;
  let chain: AcademicUsabilityDTO;
  if (item.sectionId) chain = await academicService.assertSectionUsable(ctx, item.sectionId, purpose, db);
  else if (item.subjectOfferingId) chain = await academicService.assertSubjectOfferingUsable(ctx, item.subjectOfferingId, purpose, db);
  else chain = await academicService.assertClassOfferingUsable(ctx, item.classOfferingId!, purpose, db);
  const classOfferingId = chain.classOffering.classOfferingId;

  const mismatch = (field: string) => AppError.validation({ [field]: 'This does not belong to the selected class.' });
  if (item.classOfferingId && item.classOfferingId !== classOfferingId) throw mismatch('classOfferingId');
  if (item.sectionId && item.subjectOfferingId) {
    const subject = await academicService.assertSubjectOfferingUsable(ctx, item.subjectOfferingId, purpose, db);
    if (subject.classOffering.classOfferingId !== classOfferingId) throw mismatch('subjectOfferingId');
    chain = { ...chain, subjectOffering: subject.subjectOffering };
  }
  return { chain, classOfferingId };
}

/** Adds the item number to an error, so a bulk request says which row failed. */
function atItem(index: number, err: unknown): never {
  if (err instanceof AppError) throw new AppError(err.code, err.message, { ...err.details, itemIndex: index });
  throw err;
}

/**
 * Bulk create: one faculty member, many sections (Maths for VIII-A, B and C is three items). All or nothing.
 * Dates default to the session's own dates (or the joining date, if later) and must sit inside them.
 */
export async function createAcademicAssignments(ctx: ServiceContext, employeeId: string, data: CreateAcademicAssignmentsData): Promise<FacultyAssignmentDTO[]> {
  return withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    assertAssignable(employee);
    if (employee.employeeCategory !== 'FACULTY') {
      throw new AppError('EMPLOYEE_CATEGORY_MISMATCH', 'Only teaching staff can be given classes and subjects. For non-teaching staff, add a responsibility instead.');
    }

    const created: AcademicAssignmentDoc[] = [];
    for (const [index, item] of data.items.entries()) {
      try {
        const { chain, classOfferingId } = await resolveItem(ctx, item, db);
        const session = await getSessionOrThrow(ctx, chain.session.academicSessionId, db);
        const from = item.effectiveFrom ?? latest(session.startDate, employee.joiningDate);
        const to = item.effectiveTo ?? session.endDate;
        if (from > to) throw AppError.validation({ effectiveFrom: 'The start date cannot be after the end date.' });
        if (from < session.startDate || to > session.endDate) {
          throw new AppError('ASSIGNMENT_OUTSIDE_SESSION', `Assignment dates must fall between ${session.startDate} and ${session.endDate}.`, {
            sessionStartDate: session.startDate,
            sessionEndDate: session.endDate,
          });
        }
        await assertLocationCoverage(ctx, employeeId, chain.location.locationId, from, to, db);

        const sectionId = item.sectionId ?? null;
        const subjectOfferingId = item.subjectOfferingId ?? null;
        const same = { tenantId: ctx.tenantId, cancelledAt: null, ...overlapping(from, to) };
        const duplicate = await AcademicAssignment.exists({ ...same, employeeId, assignmentType: item.assignmentType, classOfferingId, sectionId, subjectOfferingId }).session(db);
        if (duplicate) throw new AppError('ASSIGNMENT_DUPLICATE');
        if (item.assignmentType === 'CLASS_TEACHER') {
          const other = await AcademicAssignment.exists({ ...same, assignmentType: 'CLASS_TEACHER', sectionId }).session(db);
          if (other) throw new AppError('CLASS_TEACHER_EXISTS', undefined, { sectionId });
        }

        const [row] = await AcademicAssignment.create(
          [
            {
              tenantId: ctx.tenantId,
              employeeId,
              academicSessionId: chain.session.academicSessionId,
              locationId: chain.location.locationId,
              classOfferingId,
              sectionId,
              subjectOfferingId,
              assignmentType: item.assignmentType,
              effectiveFrom: from,
              effectiveTo: to,
              createdBy: ctx.userId,
              updatedBy: ctx.userId,
            },
          ],
          { session: db },
        );
        const doc = row!.toObject() as AcademicAssignmentDoc;
        created.push(doc);
        await recordStaffAudit(auditScopeOf(ctx), db, {
          entityType: 'academic_assignment',
          entityId: doc._id,
          action: 'academic_assignment.created',
          changes: diffFields({}, doc, AUDITED),
          employeeId,
          metadata: { academicSessionId: doc.academicSessionId },
        });
      } catch (err) {
        atItem(index, err);
      }
    }
    return dtosOf(ctx, created, db);
  });
}

async function getAssignmentOrThrow(ctx: ServiceContext, id: string, db: ClientSession) {
  const row = await AcademicAssignment.findOne({ _id: id, tenantId: ctx.tenantId }).session(db).lean<AcademicAssignmentDoc>();
  if (!row) throw AppError.notFound('Assignment not found.');
  const employee = await loadEmployee(ctx, row.employeeId, db);
  assertWritable(employee);
  if (row.cancelledAt) throw new AppError('ASSIGNMENT_CLOSED');
  return { row, employee };
}

export async function endAcademicAssignment(ctx: ServiceContext, id: string, data: EndAssignmentData): Promise<FacultyAssignmentDTO> {
  return withTransaction(async (db) => {
    const { row, employee } = await getAssignmentOrThrow(ctx, id, db);
    if (data.effectiveTo < row.effectiveFrom) throw AppError.validation({ effectiveTo: 'The end date cannot be before the start date.' });
    if (row.effectiveTo && data.effectiveTo > row.effectiveTo) throw AppError.validation({ effectiveTo: 'An assignment can be ended earlier, not extended.' });

    const after = { ...row, effectiveTo: data.effectiveTo, endReason: 'ENDED' as const } as AcademicAssignmentDoc;
    await AcademicAssignment.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { effectiveTo: data.effectiveTo, endReason: 'ENDED', updatedBy: ctx.userId } }, { session: db });
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'academic_assignment',
      entityId: id,
      action: 'academic_assignment.ended',
      changes: diffFields(row, after, ['effectiveTo', 'endReason']),
      employeeId: employee._id,
      metadata: { academicSessionId: row.academicSessionId },
    });
    return (await dtosOf(ctx, [after], db))[0]!;
  });
}

export async function cancelAcademicAssignment(ctx: ServiceContext, id: string): Promise<FacultyAssignmentDTO> {
  return withTransaction(async (db) => {
    const { row, employee } = await getAssignmentOrThrow(ctx, id, db);
    if (assignmentStatus(row, await todayFor(ctx, db)) !== 'PLANNED') throw new AppError('ASSIGNMENT_NOT_PLANNED');

    const cancelledAt = new Date();
    await AcademicAssignment.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { cancelledAt, updatedBy: ctx.userId } }, { session: db });
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'academic_assignment',
      entityId: id,
      action: 'academic_assignment.cancelled',
      changes: [{ field: 'cancelledAt', from: null, to: cancelledAt.toISOString() }],
      employeeId: employee._id,
      metadata: { academicSessionId: row.academicSessionId },
    });
    return (await dtosOf(ctx, [{ ...row, cancelledAt }], db))[0]!;
  });
}

/** Faculty teaching a section on a date (default today): the class teachers, co-class teachers and subject faculty. */
export async function listFacultyForSection(ctx: ServiceContext, sectionId: string, options: { onDate?: string } = {}): Promise<SectionFacultyDTO[]> {
  const date = options.onDate ?? (await todayFor(ctx));
  const rows = await AcademicAssignment.find({
    tenantId: ctx.tenantId,
    sectionId,
    cancelledAt: null,
    effectiveFrom: { $lte: date },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }],
  })
    .sort({ assignmentType: 1, effectiveFrom: 1, _id: 1 })
    .lean<AcademicAssignmentDoc[]>();
  if (rows.length === 0) return [];

  const employees = await Employee.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(rows.map((r) => r.employeeId))] } }).select('personId').lean<{ _id: string; personId: string }[]>();
  const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: employees.map((e) => e.personId) } }).lean<PersonDoc[]>();
  const personOf = new Map(people.map((p) => [p._id, p]));
  const nameOf = new Map(employees.map((e) => [e._id, personOf.get(e.personId)]));
  return rows.map((r) => ({
    employeeId: r.employeeId,
    fullName: nameOf.get(r.employeeId) ? displayNameOf(nameOf.get(r.employeeId)!) : 'Unknown',
    assignmentType: r.assignmentType,
    subjectOfferingId: r.subjectOfferingId ?? null,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo ?? null,
  }));
}
