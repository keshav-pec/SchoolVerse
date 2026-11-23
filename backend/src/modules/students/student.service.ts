import { randomUUID } from 'node:crypto';
import type { ClientSession, PipelineStage } from 'mongoose';
import {
  CURRENT_STUDENT_STATUSES,
  EXITED_STUDENT_STATUSES,
  STUDENT_PERSON_FIELDS,
  STUDENT_RECORD_FIELDS,
  type ChangeStudentStatusData,
  type CompletenessEntryDTO,
  type CreateExternalIdData,
  type CreateStudentData,
  type CreateStudentResultDTO,
  type EndExternalIdData,
  type ExternalIdDTO,
  type FacultyStudentListDTO,
  type FacultyStudentSummaryDTO,
  type ListStudentsQuery,
  type RecordAdmissionData,
  type SectionWarningDTO,
  type StudentAcademicContextDTO,
  type StudentAdminProfileDTO,
  type StudentCompletenessDTO,
  type StudentContextQuery,
  type StudentListDTO,
  type UpdateStudentData,
} from '@shared';
import { AppError } from '../../core/errors';
import { escapeRegex, pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { ClassOffering, type ClassOfferingDoc } from '../academic/offering.model';
import { AcademicSession, type AcademicSessionDoc } from '../academic/session.model';
import { Employee } from '../staff/employee.model';
import { classifiedDiff } from '../staff/audit';
import { normalizePersonPatch } from '../staff/employee.service';
import { Person, type PersonDoc } from '../staff/person.model';
import { latest, todayFor } from '../staff/status';
import { User } from '../../platform/users/user.model';
import { assertFacultyCanSeeStudent, facultyScope, scopedPlacements, subjectsTaughtBy } from './access';
import { recordStudentAudit } from './audit';
import { findDuplicateCandidates } from './duplicates.service';
import { fullNameOf, hydrateStudents, type StudentHydration } from './directory';
import { assignSectionInTx, createEnrollmentInTx, resolveClassOffering } from './enrollment.service';
import { toEnrollmentDTOs, toSectionAssignmentDTOs } from './enrollment.dto';
import { assertStudentWritable, assertVersion, loadStudent, requireSchool } from './guards';
import { hasRegisteredStudentHistory } from './hooks';
import { linkGuardianInput } from './guardian.service';
import { ACTION_FOR_TARGET, assertStudentTransition, availableActions } from './lifecycle';
import { toAddressDTO, toAdmissionDTO, toDirectoryDTO, toExternalIdDTO, toFacultySummaryDTO } from './mappers';
import { isOpenOn } from './rules';
import { admissionNumberTaken, getEffectiveSettings, resolveAdmissionNumber } from './settings.service';
import { checkCurrentSelection, initializeMandatoryInTx, toSubjectDTOs } from './subject.service';
import {
  Student,
  StudentAdmission,
  StudentEnrollment,
  StudentExternalId,
  StudentGuardianLink,
  StudentSectionAssignment,
  StudentSubjectEnrollment,
  type StudentAdmissionDoc,
  type StudentDoc,
  type StudentEnrollmentDoc,
  type StudentExternalIdDoc,
  type StudentGuardianLinkDoc,
  type StudentSectionAssignmentDoc,
  type StudentSubjectEnrollmentDoc,
} from './student.models';

/** SPM-01 to SPM-03, SPM-10, SPM-33 — the student record: Quick Add, directory, profile, edit and status. */

const PERSON_FIELDS: readonly string[] = STUDENT_PERSON_FIELDS;
const RECORD_FIELDS: readonly string[] = STUDENT_RECORD_FIELDS;

function pick<T extends object>(source: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => keys.includes(key)));
}

async function activeSessionId(ctx: ServiceContext): Promise<string | null> {
  const doc = await AcademicSession.findOne({ tenantId: ctx.tenantId, status: 'ACTIVE' }).select('_id').lean<{ _id: string }>();
  return doc?._id ?? null;
}

// ───────────────────────────────────────────────────────────── what is still missing

/**
 * Plain-language list of what a student still needs (SPM-33; Needs Attention reads it). Exited students need nothing.
 * `ADMISSION`, `ENROLLMENT` and `GUARDIAN` are the minimum to confirm an admission.
 */
export async function completenessOf(ctx: ServiceContext, student: StudentDoc, h: StudentHydration, db?: ClientSession): Promise<CompletenessEntryDTO[]> {
  if (EXITED_STUDENT_STATUSES.includes(student.status)) return [];
  const missing: CompletenessEntryDTO[] = [];
  const placement = h.placements.get(student._id);
  const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, studentId: student._id, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: h.today } }] })
    .session(db ?? null)
    .lean<StudentGuardianLinkDoc[]>();

  if (!h.admissions.get(student._id)) missing.push({ item: 'ADMISSION', message: 'No admission is recorded yet.' });
  const enrollment = placement?.enrollment && placement.enrollment.state === 'OPEN' ? placement.enrollment : null;
  if (!enrollment) missing.push({ item: 'ENROLLMENT', message: 'Not placed in a class for this year yet.' });
  else {
    const assignment = placement?.assignment;
    if (!assignment || assignment.cancelledAt || (assignment.effectiveTo && assignment.effectiveTo < h.today)) missing.push({ item: 'SECTION', message: 'No section yet.' });
  }
  if (links.length === 0) missing.push({ item: 'GUARDIAN', message: 'No parent or guardian is linked.' });
  else if (!links.some((l) => l.isPrimary)) missing.push({ item: 'PRIMARY_GUARDIAN', message: 'No primary guardian is chosen.' });
  if (enrollment) {
    const selection = await checkCurrentSelection(ctx, enrollment, h.today, db);
    if (!selection.valid) missing.push({ item: 'SUBJECT_CHOICE', message: selection.problems[0]?.message ?? 'The subject choice is not complete.' });
  }
  return missing;
}

export async function getCompleteness(ctx: ServiceContext, studentId: string): Promise<StudentCompletenessDTO> {
  const student = await loadStudent(ctx, studentId);
  const h = await hydrateStudents(ctx, [student]);
  const missing = await completenessOf(ctx, student, h);
  return { studentId, status: student.status, complete: missing.length === 0, missing };
}

// ───────────────────────────────────────────────────────────── profile

async function isDeletable(ctx: ServiceContext, student: StudentDoc, db?: ClientSession): Promise<boolean> {
  if (student.status !== 'DRAFT') return false;
  const scope = { tenantId: ctx.tenantId, studentId: student._id };
  const [enrollment, guardian, admission, registered] = await Promise.all([
    StudentEnrollment.exists(scope).session(db ?? null),
    StudentGuardianLink.exists(scope).session(db ?? null),
    StudentAdmission.exists(scope).session(db ?? null),
    hasRegisteredStudentHistory({ tenantId: ctx.tenantId, studentId: student._id, personId: student.personId, session: db }),
  ]);
  return !enrollment && !guardian && !admission && !registered;
}

export async function profileOf(ctx: ServiceContext, student: StudentDoc, db?: ClientSession): Promise<StudentAdminProfileDTO> {
  const h = await hydrateStudents(ctx, [student], { db });
  const person = h.people.get(student.personId)!;
  const viewPersonal = can(ctx, 'student:view_personal');
  const placement = h.placements.get(student._id);
  const admission = h.admissions.get(student._id) ?? null;

  const [externalIds, guardianCount, enrollments, admissionClass, missing, deletable] = await Promise.all([
    viewPersonal ? StudentExternalId.find({ tenantId: ctx.tenantId, studentId: student._id }).sort({ createdAt: 1 }).session(db ?? null).lean<StudentExternalIdDoc[]>() : Promise.resolve([] as StudentExternalIdDoc[]),
    StudentGuardianLink.countDocuments({ tenantId: ctx.tenantId, studentId: student._id, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: h.today } }] }).session(db ?? null),
    placement?.enrollment ? toEnrollmentDTOs(ctx, [placement.enrollment], { db, today: h.today }) : Promise.resolve([]),
    admission ? ClassOffering.findOne({ _id: admission.admissionClassOfferingId, tenantId: ctx.tenantId }).session(db ?? null).select('displayName').lean<{ displayName: string }>() : Promise.resolve(null),
    completenessOf(ctx, student, h, db),
    isDeletable(ctx, student, db),
  ]);

  return {
    ...toDirectoryDTO(student, h),
    personId: person._id,
    legalFirstName: person.legalFirstName,
    legalMiddleName: person.legalMiddleName ?? null,
    legalLastName: person.legalLastName,
    preferredName: person.preferredName ?? null,
    gender: person.gender ?? null,
    bloodGroup: student.bloodGroup ?? null,
    notes: student.notes ?? null,
    personalIncluded: viewPersonal,
    dateOfBirth: viewPersonal ? person.dateOfBirth ?? null : null,
    primaryPhone: viewPersonal ? person.primaryPhone ?? null : null,
    primaryEmail: viewPersonal ? person.primaryEmail ?? null : null,
    address: viewPersonal ? toAddressDTO(person.address) : null,
    admission: admission ? toAdmissionDTO(admission, admissionClass?.displayName ?? 'Unknown class', viewPersonal) : null,
    externalIds: externalIds.map(toExternalIdDTO),
    guardianCount,
    enrollment: enrollments[0] ?? null,
    missing,
    deletable,
    availableActions: availableActions(student.status),
    version: student.version,
    createdAt: (student.createdAt as Date).toISOString(),
    updatedAt: (student.updatedAt as Date).toISOString(),
  };
}

// ───────────────────────────────────────────────────────────── directory

function tokensOf(q: string | undefined) {
  return (q ?? '').split(/\s+/).filter(Boolean);
}

/** Students whose parent matches the search (by name, or by phone digits). */
async function studentIdsByGuardian(ctx: ServiceContext, tokens: string[]): Promise<string[]> {
  if (tokens.length === 0) return [];
  const people = await Person.find({
    tenantId: ctx.tenantId,
    $and: tokens.map((t) => {
      const rx = new RegExp(escapeRegex(t), 'i');
      return { $or: [{ legalFirstName: rx }, { legalMiddleName: rx }, { legalLastName: rx }, { preferredName: rx }, { primaryPhone: rx }] };
    }),
  })
    .limit(300)
    .select('_id')
    .lean<{ _id: string }[]>();
  if (people.length === 0) return [];
  return StudentGuardianLink.distinct('studentId', { tenantId: ctx.tenantId, guardianPersonId: { $in: people.map((p) => p._id) }, cancelledAt: null });
}

/**
 * The directory. Admins (`student:view`) see every student of the session (default: the current one) plus students who have no
 * enrollment yet (drafts), and exited students only when they ask. Faculty get only their own students, with fewer fields.
 */
export async function listStudents(ctx: ServiceContext, query: ListStudentsQuery): Promise<StudentListDTO | FacultyStudentListDTO> {
  if (!can(ctx, 'student:view')) return listForFaculty(ctx, query);
  return listStudentsAdmin(ctx, query);
}

/** The full directory search (name, admission number, parent). The caller has already checked who may ask: Finance does so by campus. */
export async function listStudentsAdmin(ctx: ServiceContext, query: ListStudentsQuery): Promise<StudentListDTO> {
  const tenantId = ctx.tenantId;
  const today = await todayFor(ctx);
  const sessionId = query.academicSessionId ?? (await activeSessionId(ctx));
  const tokens = tokensOf(query.q);
  const byGuardian = await studentIdsByGuardian(ctx, tokens);

  const enrollmentFilter: Record<string, unknown> = { tenantId, state: { $ne: 'CANCELLED' }, ...(sessionId ? { academicSessionId: sessionId } : {}) };
  if (query.locationId) enrollmentFilter.locationId = query.locationId;
  if (query.classOfferingId) enrollmentFilter.classOfferingId = query.classOfferingId;
  const needsEnrollment = Boolean(query.locationId || query.classOfferingId || query.sectionId || query.enrollmentStatus || query.missingSection);

  const pipeline: PipelineStage[] = [
    { $match: { tenantId, status: { $in: query.status ?? [...CURRENT_STUDENT_STATUSES] } } },
    { $lookup: { from: 'people', localField: 'personId', foreignField: '_id', as: 'person' } },
    { $unwind: '$person' },
    { $lookup: { from: 'student_admissions', let: { sid: '$_id' }, pipeline: [{ $match: { tenantId, isCurrent: true, $expr: { $eq: ['$studentId', '$$sid'] } } }, { $limit: 1 }], as: 'admission' } },
    {
      $lookup: {
        from: 'student_enrollments',
        let: { sid: '$_id' },
        pipeline: [
          { $match: { ...enrollmentFilter, $expr: { $eq: ['$studentId', '$$sid'] } } },
          { $addFields: { _open: { $cond: [{ $eq: ['$state', 'OPEN'] }, 1, 0] } } },
          { $sort: { _open: -1, effectiveFrom: -1 } },
          { $limit: 1 },
        ],
        as: 'enrollment',
      },
    },
    { $lookup: { from: 'student_enrollments', let: { sid: '$_id' }, pipeline: [{ $match: { tenantId, $expr: { $eq: ['$studentId', '$$sid'] } } }, { $limit: 1 }, { $project: { _id: 1 } }], as: 'anyEnrollment' } },
    {
      $lookup: {
        from: 'student_section_assignments',
        let: { eid: { $arrayElemAt: ['$enrollment._id', 0] } },
        pipeline: [
          { $match: { tenantId, cancelledAt: null, $expr: { $eq: ['$enrollmentId', '$$eid'] } } },
          {
            $addFields: {
              _rank: {
                $cond: [
                  { $and: [{ $lte: ['$effectiveFrom', today] }, { $or: [{ $eq: ['$effectiveTo', null] }, { $gte: ['$effectiveTo', today] }] }] },
                  0,
                  { $cond: [{ $gt: ['$effectiveFrom', today] }, 1, 2] },
                ],
              },
            },
          },
          { $sort: { _rank: 1, effectiveFrom: -1 } },
          { $limit: 1 },
        ],
        as: 'assignment',
      },
    },
    { $addFields: { enrollment: { $arrayElemAt: ['$enrollment', 0] }, assignment: { $arrayElemAt: ['$assignment', 0] }, admission: { $arrayElemAt: ['$admission', 0] } } },
    {
      $addFields: {
        enrollmentStatus: {
          $cond: [{ $eq: ['$enrollment.state', 'OPEN'] }, { $cond: [{ $gt: ['$enrollment.effectiveFrom', today] }, 'PLANNED', 'ACTIVE'] }, '$enrollment.state'],
        },
        hasSection: { $and: [{ $ne: [{ $type: '$assignment._id' }, 'missing'] }, { $or: [{ $eq: ['$assignment.effectiveTo', null] }, { $gte: ['$assignment.effectiveTo', today] }] }] },
      },
    },
  ];

  const and: Record<string, unknown>[] = [];
  // Students of the session, plus students who have never been enrolled (drafts), unless a filter needs an enrollment.
  if (sessionId && !needsEnrollment) and.push({ $or: [{ 'enrollment._id': { $exists: true } }, { anyEnrollment: { $size: 0 } }] });
  if (needsEnrollment) and.push({ 'enrollment._id': { $exists: true } });
  if (query.sectionId) and.push({ 'assignment.sectionId': query.sectionId });
  if (query.enrollmentStatus) and.push({ enrollmentStatus: query.enrollmentStatus });
  if (query.missingSection) and.push({ 'enrollment.state': 'OPEN', hasSection: false });
  if (tokens.length > 0) {
    const nameMatch = tokens.map((token) => {
      const rx = new RegExp(escapeRegex(token), 'i');
      return {
        $or: [
          { 'person.legalFirstName': rx },
          { 'person.legalMiddleName': rx },
          { 'person.legalLastName': rx },
          { 'person.preferredName': rx },
          { 'admission.admissionNumber': rx },
          { 'assignment.rollNumber': new RegExp(`^${escapeRegex(token)}$`, 'i') },
        ],
      };
    });
    // Every word matches the student, or the search matches a parent (name or phone): then the parent's children are listed.
    and.push(byGuardian.length > 0 ? { $or: [{ _id: { $in: byGuardian } }, { $and: nameMatch }] } : { $and: nameMatch });
  }

  if (query.missingGuardian) {
    pipeline.push({
      $lookup: {
        from: 'student_guardian_links',
        let: { sid: '$_id' },
        pipeline: [{ $match: { tenantId, cancelledAt: null, $expr: { $eq: ['$studentId', '$$sid'] }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] } }, { $limit: 1 }, { $project: { _id: 1 } }],
        as: 'liveGuardian',
      },
    });
    and.push({ liveGuardian: { $size: 0 } });
  }
  if (and.length > 0) pipeline.push({ $match: { $and: and } });
  pipeline.push(
    { $sort: { 'person.legalFirstName': 1, 'person.legalLastName': 1, _id: 1 } },
    { $facet: { items: [{ $skip: (query.page - 1) * query.pageSize }, { $limit: query.pageSize }], total: [{ $count: 'n' }] } },
  );

  const [result] = await Student.aggregate<{ items: (StudentDoc & { person: PersonDoc } & Record<string, unknown>)[]; total: { n: number }[] }>(pipeline).collation({ locale: 'en', strength: 2 });
  const rows = result?.items ?? [];
  const students = rows.map(({ person: _p, admission: _a, enrollment: _e, assignment: _s, anyEnrollment: _n, enrollmentStatus: _es, hasSection: _h, liveGuardian: _g, ...rest }) => rest as unknown as StudentDoc);
  const h = await hydrateStudents(ctx, students, { people: rows.map((r) => r.person), today, academicSessionId: sessionId });
  return { items: students.map((s) => toDirectoryDTO(s, h)), page: query.page, pageSize: query.pageSize, total: result?.total[0]?.n ?? 0 };
}

async function listForFaculty(ctx: ServiceContext, query: ListStudentsQuery): Promise<FacultyStudentListDTO> {
  const today = await todayFor(ctx);
  const scope = await facultyScope(ctx, today);
  const empty: FacultyStudentListDTO = { items: [], page: query.page, pageSize: query.pageSize, total: 0 };
  if (!scope) return empty;

  const placements = await scopedPlacements(ctx, scope, today, {
    ...(query.sectionId ? { sectionId: query.sectionId } : {}),
    ...(query.classOfferingId ? { classOfferingId: query.classOfferingId } : {}),
  });
  const placementOf = new Map(placements.map((p) => [p.studentId, p]));
  if (placementOf.size === 0) return empty;
  const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: [...placementOf.keys()] }, status: { $in: [...CURRENT_STUDENT_STATUSES] } }).lean<StudentDoc[]>();
  const h = await hydrateStudents(ctx, students, { today });
  const subjects = await facultySubjects(ctx, scope, students, placementOf, today);

  // A teacher searches by name, admission number or roll number only. Parent names and phones are never searched.
  const tokens = tokensOf(query.q).map((t) => t.toLowerCase());
  const matched = students.filter((s) => {
    if (tokens.length === 0) return true;
    const person = h.people.get(s.personId)!;
    const haystack = [person.legalFirstName, person.legalMiddleName, person.legalLastName, person.preferredName, h.admissions.get(s._id)?.admissionNumber, placementOf.get(s._id)?.rollNumber].filter(Boolean).join(' ').toLowerCase();
    return tokens.every((t) => haystack.includes(t));
  });
  matched.sort((a, b) => fullNameOf(h.people.get(a.personId)!).localeCompare(fullNameOf(h.people.get(b.personId)!), 'en', { sensitivity: 'base' }) || a._id.localeCompare(b._id));
  const page = matched.slice((query.page - 1) * query.pageSize, query.page * query.pageSize);
  return { items: page.map((s) => toFacultySummaryDTO(s, h, subjects.get(s._id) ?? [])), page: query.page, pageSize: query.pageSize, total: matched.length };
}

/** For each student, the subjects this teacher teaches them. */
async function facultySubjects(ctx: ServiceContext, scope: NonNullable<Awaited<ReturnType<typeof facultyScope>>>, students: StudentDoc[], placementOf: Map<string, StudentSectionAssignmentDoc>, today: string) {
  const rows = await StudentSubjectEnrollment.find({
    tenantId: ctx.tenantId,
    studentId: { $in: students.map((s) => s._id) },
    cancelledAt: null,
    effectiveFrom: { $lte: today },
    $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }],
  }).lean<StudentSubjectEnrollmentDoc[]>();
  const dtos = await toSubjectDTOs(ctx, rows, today);
  const result = new Map<string, { subjectOfferingId: string; subjectName: string }[]>();
  for (const s of students) {
    const placement = placementOf.get(s._id);
    if (!placement) continue;
    const mine = dtos.filter((d) => rows.find((r) => r._id === d.subjectEnrollmentId)?.studentId === s._id && d.enrollmentId === placement.enrollmentId);
    const taught = subjectsTaughtBy(scope, placement, mine.map((d) => d.subjectOfferingId));
    result.set(s._id, mine.filter((d) => taught.ids.has(d.subjectOfferingId)).map((d) => ({ subjectOfferingId: d.subjectOfferingId, subjectName: d.subjectName })));
  }
  return result;
}

/** Admins get the full profile. A teacher gets the short summary, and only for a student in their sections (404 + security event otherwise). */
export async function getStudent(ctx: ServiceContext, studentId: string): Promise<StudentAdminProfileDTO | FacultyStudentSummaryDTO> {
  if (can(ctx, 'student:view')) return profileOf(ctx, await loadStudent(ctx, studentId));
  const { placement, scope, today } = await assertFacultyCanSeeStudent(ctx, studentId);
  const student = await loadStudent(ctx, studentId);
  const h = await hydrateStudents(ctx, [student], { today });
  const subjects = await facultySubjects(ctx, scope, [student], new Map([[student._id, placement]]), today);
  return toFacultySummaryDTO(student, h, subjects.get(student._id) ?? []);
}

// ───────────────────────────────────────────────────────────── admission (shared by Quick Add and "record admission")

interface AdmitArgs {
  school: Awaited<ReturnType<typeof requireSchool>>;
  student: StudentDoc;
  today: string;
  mode: 'NEW_ADMISSION' | 'MIGRATION';
  admissionDate: string | undefined;
  admissionNumber: string | undefined;
  academicSessionId: string | undefined;
  locationId: string;
  classOfferingId: string | undefined;
  classId: string | undefined;
  programmeId: string | null | undefined;
  sectionId: string | undefined;
  rollNumber: string | undefined;
  category: string | null | undefined;
  previousSchool: CreateStudentData['previousSchool'];
  remarks: string | null | undefined;
}

/**
 * Records the admission and puts the student in a class: the admission row (with its number), the enrollment, the section and roll
 * number if given, and the class's mandatory subjects. All inside the caller's transaction.
 */
async function admitInTx(ctx: ServiceContext, db: ClientSession, a: AdmitArgs) {
  const sessionId = a.academicSessionId ?? (await activeSessionId(ctx));
  if (!sessionId) throw AppError.notFound('No academic session is active yet. Choose a session.');
  const session = await AcademicSession.findOne({ _id: sessionId, tenantId: ctx.tenantId }).session(db).lean<AcademicSessionDoc>();
  if (!session) throw AppError.notFound('Academic session not found.');
  const offering = await resolveClassOffering(ctx, { academicSessionId: sessionId, locationId: a.locationId, classOfferingId: a.classOfferingId, classId: a.classId }, db);

  // The date we add a student to the ERP is never their admission date: migration keeps the original one.
  const admissionDate = a.admissionDate ?? a.today;
  const effectiveFrom = latest(admissionDate, session.startDate);
  if (effectiveFrom > session.endDate) throw AppError.validation({ admissionDate: 'The admission date is after the end of this session.' });

  const admissionNumber = await resolveAdmissionNumber(ctx, a.school, { mode: a.mode, admissionNumber: a.admissionNumber, academicSessionId: sessionId, locationId: a.locationId, today: a.today }, db);
  // A migrated student was admitted in the session that holds the original date, when the ERP has one.
  const admittedIn = a.mode === 'MIGRATION' ? await AcademicSession.findOne({ tenantId: ctx.tenantId, startDate: { $lte: admissionDate }, endDate: { $gte: admissionDate } }).session(db).select('_id').lean<{ _id: string }>() : null;

  const [createdAdmission] = await StudentAdmission.create(
    [
      {
        tenantId: ctx.tenantId,
        schoolId: a.school._id,
        studentId: a.student._id,
        admissionNumber,
        admissionDate,
        mode: a.mode,
        admissionSessionId: admittedIn?._id ?? sessionId,
        admissionLocationId: a.locationId,
        admissionClassOfferingId: offering._id,
        isCurrent: true,
        category: a.category ?? null,
        previousSchool: a.previousSchool ? { name: a.previousSchool.name, board: a.previousSchool.board ?? null, className: a.previousSchool.className ?? null, tcNumber: a.previousSchool.tcNumber ?? null } : null,
        remarks: a.remarks ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ],
    { session: db },
  );
  const admission = createdAdmission!.toObject() as StudentAdmissionDoc;
  await recordStudentAudit(ctx, db, {
    entityType: 'admission',
    entityId: admission._id,
    action: 'admission.created',
    changes: classifiedAdmissionDiff(admission),
    studentId: a.student._id,
    metadata: { mode: a.mode },
  });

  const existing = await StudentEnrollment.findOne({ tenantId: ctx.tenantId, studentId: a.student._id, academicSessionId: sessionId, state: 'OPEN' }).session(db).lean<StudentEnrollmentDoc>();
  if (existing && existing.classOfferingId !== offering._id) throw new AppError('ENROLLMENT_ALREADY_OPEN');
  const enrollment =
    existing ??
    (await createEnrollmentInTx(ctx, db, {
      studentId: a.student._id,
      schoolId: a.school._id,
      session,
      offering,
      programmeId: a.programmeId,
      enrollmentType: a.mode === 'MIGRATION' ? 'CONTINUING' : 'NEW_ADMISSION',
      effectiveFrom,
    }));

  const settings = await getEffectiveSettings(ctx, a.school, db);
  let warnings: SectionWarningDTO[] = [];
  if (a.sectionId) warnings = (await assignSectionInTx(ctx, db, enrollment, { sectionId: a.sectionId, rollNumber: a.rollNumber, effectiveFrom }, settings)).warnings;
  const { added } = await initializeMandatoryInTx(ctx, enrollment, db);
  return { admission, enrollment, offering, mandatoryAdded: added.length, warnings };
}

function classifiedAdmissionDiff(admission: StudentAdmissionDoc) {
  return diffFields({}, admission, ['admissionNumber', 'admissionDate', 'mode', 'admissionSessionId', 'admissionLocationId', 'admissionClassOfferingId']);
}

// ───────────────────────────────────────────────────────────── create (Quick Add)

function mapStudentDuplicate(err: unknown): never {
  const fields = duplicateKeyFields(err);
  if (fields?.includes('admissionNumber')) throw admissionNumberTaken();
  if (fields?.includes('personId')) throw new AppError('STUDENT_ALREADY_EXISTS');
  if (fields?.includes('type') && fields.includes('value')) throw new AppError('EXTERNAL_ID_TAKEN', undefined, { fields: { externalIds: 'This outside ID already belongs to another student.' } });
  throw err;
}

async function createExternalIds(ctx: ServiceContext, db: ClientSession, studentId: string, ids: { type: string; value: string; effectiveFrom?: string | null | undefined }[]) {
  for (const id of ids) {
    const [row] = await StudentExternalId.create([{ tenantId: ctx.tenantId, studentId, type: id.type, value: id.value, effectiveFrom: id.effectiveFrom ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
    await recordStudentAudit(ctx, db, {
      entityType: 'student',
      entityId: studentId,
      action: 'student.external_id_added',
      changes: [{ field: 'type', from: null, to: row!.type }, { field: 'value', from: '[redacted]', to: '[redacted]' }],
      studentId,
    });
  }
}

/**
 * Quick Add. One transaction: the person (or the existing one), the student, the admission, the enrollment, the section and
 * roll number if given, the mandatory subjects and the guardian. A possible duplicate needs `confirmNotDuplicate`.
 */
export async function createStudent(ctx: ServiceContext, data: CreateStudentData): Promise<CreateStudentResultDTO> {
  const school = await requireSchool(ctx);
  const draft = data.draft === true;
  const wantsAdmission = !draft || Boolean(data.classOfferingId || data.classId);

  if (!data.confirmNotDuplicate && !data.personId) {
    let guardianPhone = data.guardian?.phone ?? null;
    let guardianEmail = data.guardian?.email ?? null;
    if (data.guardian?.guardianPersonId) {
      const parent = await Person.findOne({ _id: data.guardian.guardianPersonId, tenantId: ctx.tenantId }).select('primaryPhone primaryEmail').lean<Pick<PersonDoc, 'primaryPhone' | 'primaryEmail'>>();
      guardianPhone = parent?.primaryPhone ?? null;
      guardianEmail = parent?.primaryEmail ?? null;
    }
    const candidates = (
      await findDuplicateCandidates(ctx, {
        name: `${data.legalFirstName ?? ''} ${data.legalLastName ?? ''}`.trim(),
        dateOfBirth: data.dateOfBirth ?? undefined,
        externalIds: data.externalIds?.map((e) => ({ type: e.type, value: e.value })),
        guardianPhone,
        guardianEmail,
      })
    ).filter((c) => c.reasons.some((r) => r !== 'SAME_ADMISSION_NUMBER'));
    if (candidates.length > 0) throw new AppError('POSSIBLE_DUPLICATE_STUDENT', undefined, { candidates });
  }

  try {
    const done = await withTransaction(async (db) => {
      const today = await todayFor(ctx, db);
      let person: PersonDoc;
      if (data.personId) {
        const existing = await Person.findOne({ _id: data.personId, tenantId: ctx.tenantId }).session(db).lean<PersonDoc>();
        if (!existing) throw AppError.notFound('Person not found.');
        if (await Student.exists({ tenantId: ctx.tenantId, personId: existing._id }).session(db)) throw new AppError('STUDENT_ALREADY_EXISTS');
        person = existing;
      } else {
        const [created] = await Person.create(
          [
            {
              tenantId: ctx.tenantId,
              legalFirstName: data.legalFirstName,
              legalMiddleName: data.legalMiddleName ?? null,
              legalLastName: data.legalLastName ?? '',
              preferredName: data.preferredName ?? null,
              dateOfBirth: data.dateOfBirth ?? null,
              gender: data.gender ?? null,
              primaryPhone: data.primaryPhone ?? null,
              primaryEmail: data.primaryEmail ?? null,
              address: normalizePersonPatch({ address: data.address }).address ?? null,
              createdBy: ctx.userId,
              updatedBy: ctx.userId,
            },
          ],
          { session: db },
        );
        person = created!.toObject() as PersonDoc;
      }

      const studentId = randomUUID();
      const status = draft ? (wantsAdmission ? 'ADMISSION_PENDING' : 'DRAFT') : 'ACTIVE';
      const [createdStudent] = await Student.create(
        [{ _id: studentId, tenantId: ctx.tenantId, schoolId: school._id, personId: person._id, status, bloodGroup: data.bloodGroup ?? null, notes: data.notes ?? null, statusChangedAt: new Date(), statusChangedBy: ctx.userId, createdBy: ctx.userId, updatedBy: ctx.userId }],
        { session: db },
      );
      const student = createdStudent!.toObject() as StudentDoc;
      await recordStudentAudit(ctx, db, {
        entityType: 'student',
        entityId: studentId,
        action: draft ? 'student.draft_saved' : 'student.created',
        changes: [...classifiedDiff('person', {}, person, PERSON_FIELDS), ...classifiedDiff('student', {}, student, ['status', ...RECORD_FIELDS])],
        studentId,
        metadata: { personId: person._id, reusedPerson: Boolean(data.personId), mode: data.mode ?? 'NEW_ADMISSION' },
      });

      if (data.externalIds?.length) await createExternalIds(ctx, db, studentId, data.externalIds);

      let admitted: Awaited<ReturnType<typeof admitInTx>> | null = null;
      if (wantsAdmission) {
        admitted = await admitInTx(ctx, db, {
          school,
          student,
          today,
          mode: data.mode ?? 'NEW_ADMISSION',
          admissionDate: data.admissionDate,
          admissionNumber: data.admissionNumber,
          academicSessionId: data.academicSessionId,
          locationId: data.locationId!,
          classOfferingId: data.classOfferingId,
          classId: data.classId,
          programmeId: data.programmeId,
          sectionId: data.sectionId,
          rollNumber: data.rollNumber,
          category: data.category,
          previousSchool: data.previousSchool,
          remarks: data.remarks,
        });
      }

      let guardianReused = false;
      if (data.guardian) {
        const admissionDate = admitted?.admission.admissionDate ?? today;
        const linked = await linkGuardianInput(ctx, db, student, { ...data.guardian, effectiveFrom: data.guardian.effectiveFrom ?? (admissionDate < today ? admissionDate : today) }, today);
        guardianReused = linked.reused;
      }
      return { studentId, enrollmentId: admitted?.enrollment._id ?? null, added: admitted?.mandatoryAdded ?? 0, warnings: admitted?.warnings ?? [], guardianReused };
    });

    const student = await loadStudent(ctx, done.studentId);
    const [profile, enrollment] = await Promise.all([profileOf(ctx, student), done.enrollmentId ? toEnrollmentDTOs(ctx, [(await StudentEnrollment.findOne({ _id: done.enrollmentId, tenantId: ctx.tenantId }).lean<StudentEnrollmentDoc>())!]) : Promise.resolve([])]);
    return {
      student: profile,
      enrollment: enrollment[0] ?? null,
      mandatorySubjectsAdded: done.added,
      subjectsMessage: done.added > 0 ? `${done.added} mandatory subject${done.added === 1 ? '' : 's'} added` : null,
      guardianReused: done.guardianReused,
      warnings: done.warnings,
    };
  } catch (err) {
    mapStudentDuplicate(err);
  }
}

/** Records the admission of a draft student: their admission number, class and (optionally) section. */
export async function recordAdmission(ctx: ServiceContext, studentId: string, data: RecordAdmissionData & { sectionId?: string; rollNumber?: string; programmeId?: string | null }): Promise<StudentAdminProfileDTO> {
  const school = await requireSchool(ctx);
  try {
    await withTransaction(async (db) => {
      const student = await loadStudent(ctx, studentId, db);
      assertStudentWritable(student);
      if (await StudentAdmission.exists({ tenantId: ctx.tenantId, studentId, isCurrent: true }).session(db)) throw new AppError('ADMISSION_ALREADY_RECORDED');
      const today = await todayFor(ctx, db);
      await admitInTx(ctx, db, {
        school,
        student,
        today,
        mode: data.mode ?? 'NEW_ADMISSION',
        admissionDate: data.admissionDate,
        admissionNumber: data.admissionNumber,
        academicSessionId: data.academicSessionId,
        locationId: data.locationId,
        classOfferingId: data.classOfferingId,
        classId: data.classId,
        programmeId: data.programmeId,
        sectionId: data.sectionId,
        rollNumber: data.rollNumber,
        category: data.category,
        previousSchool: data.previousSchool,
        remarks: data.remarks,
      });
      if (student.status === 'DRAFT') {
        const to = assertStudentTransition(student.status, 'admit');
        await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId }, { $set: { status: to, statusChangedAt: new Date(), statusChangedBy: ctx.userId, updatedBy: ctx.userId } }, { session: db });
        await recordStudentAudit(ctx, db, { entityType: 'student', entityId: studentId, action: 'student.status_changed', changes: [{ field: 'status', from: student.status, to }], studentId });
      }
    });
  } catch (err) {
    mapStudentDuplicate(err);
  }
  return profileOf(ctx, await loadStudent(ctx, studentId));
}

// ───────────────────────────────────────────────────────────── update, status, delete

/** Edits an allowlist of fields. Status, class and admission number cannot come through here (the schema rejects them). */
export async function updateStudent(ctx: ServiceContext, studentId: string, patch: UpdateStudentData): Promise<StudentAdminProfileDTO> {
  await withTransaction(async (db) => {
    const before = await loadStudent(ctx, studentId, db);
    assertStudentWritable(before);
    assertVersion(before.version, patch.version);
    const person = await Person.findOne({ _id: before.personId, tenantId: ctx.tenantId }).session(db).lean<PersonDoc>();
    if (!person) throw AppError.notFound('Person not found.');

    const { version: _version, ...fields } = patch;
    const changes = pickDefined(fields);
    const personPatch = normalizePersonPatch(pick(changes, PERSON_FIELDS));
    const recordPatch = pick(changes, RECORD_FIELDS);
    const mergedPerson = { ...person, ...personPatch } as PersonDoc;
    const mergedStudent = { ...before, ...recordPatch } as StudentDoc;
    const personDiff = classifiedDiff('person', person, mergedPerson, PERSON_FIELDS);
    const studentDiff = classifiedDiff('student', before, mergedStudent, RECORD_FIELDS);
    if (personDiff.length === 0 && studentDiff.length === 0) return;

    if (personDiff.length > 0) {
      const $set: Record<string, unknown> = { updatedBy: ctx.userId };
      for (const c of personDiff) $set[c.field] = (mergedPerson as unknown as Record<string, unknown>)[c.field];
      await Person.updateOne({ _id: person._id, tenantId: ctx.tenantId }, { $set }, { session: db });
    }
    const $set: Record<string, unknown> = { updatedBy: ctx.userId };
    for (const c of studentDiff) $set[c.field] = (mergedStudent as unknown as Record<string, unknown>)[c.field];
    const done = await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId, version: patch.version }, { $set, $inc: { version: 1 } }, { session: db });
    if (done.matchedCount !== 1) throw new AppError('VERSION_CONFLICT');
    await recordStudentAudit(ctx, db, { entityType: 'student', entityId: studentId, action: 'student.updated', changes: [...personDiff, ...studentDiff], studentId });
  });
  return profileOf(ctx, await loadStudent(ctx, studentId));
}

/** Confirms an admission. The minimum is an admission, an enrollment and one guardian (`STUDENT_INCOMPLETE` lists what is missing). */
export async function activateStudent(ctx: ServiceContext, studentId: string): Promise<StudentAdminProfileDTO> {
  await withTransaction(async (db) => {
    const student = await loadStudent(ctx, studentId, db);
    const to = assertStudentTransition(student.status, 'activate');
    const h = await hydrateStudents(ctx, [student], { db });
    const required = (await completenessOf(ctx, student, h, db)).filter((m) => ['ADMISSION', 'ENROLLMENT', 'GUARDIAN'].includes(m.item));
    if (required.length > 0) throw new AppError('STUDENT_INCOMPLETE', undefined, { missing: required });
    await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId }, { $set: { status: to, statusChangedAt: new Date(), statusChangedBy: ctx.userId, updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'student', entityId: studentId, action: 'student.activated', changes: [{ field: 'status', from: student.status, to }], studentId });
  });
  return profileOf(ctx, await loadStudent(ctx, studentId));
}

/** The simple moves: Active ↔ Inactive. Exits are set only by their own workflows. */
export async function changeStudentStatus(ctx: ServiceContext, studentId: string, data: ChangeStudentStatusData): Promise<StudentAdminProfileDTO> {
  await withTransaction(async (db) => {
    const student = await loadStudent(ctx, studentId, db);
    const to = assertStudentTransition(student.status, ACTION_FOR_TARGET[data.to]);
    await Student.updateOne({ _id: studentId, tenantId: ctx.tenantId }, { $set: { status: to, statusChangedAt: new Date(), statusChangedBy: ctx.userId, updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'student', entityId: studentId, action: 'student.status_changed', changes: diffFields(student, { ...student, status: to }, ['status']), studentId, metadata: { reason: data.reason ?? null } });
  });
  return profileOf(ctx, await loadStudent(ctx, studentId));
}

/** Only a draft with nothing recorded against it. Everyone else keeps their history. */
export async function deleteStudent(ctx: ServiceContext, studentId: string): Promise<void> {
  await withTransaction(async (db) => {
    const student = await loadStudent(ctx, studentId, db);
    if (!(await isDeletable(ctx, student, db))) throw new AppError('STUDENT_HAS_HISTORY');
    await StudentExternalId.deleteMany({ tenantId: ctx.tenantId, studentId }, { session: db });
    await Student.deleteOne({ _id: studentId, tenantId: ctx.tenantId }, { session: db });
    // The person goes too, unless they are someone else as well (an employee, a parent, a login).
    const [employee, guardian, user] = await Promise.all([
      Employee.exists({ tenantId: ctx.tenantId, personId: student.personId }).session(db),
      StudentGuardianLink.exists({ tenantId: ctx.tenantId, guardianPersonId: student.personId }).session(db),
      User.exists({ tenantId: ctx.tenantId, personId: student.personId }).session(db),
    ]);
    const personRemoved = !employee && !guardian && !user;
    if (personRemoved) await Person.deleteOne({ _id: student.personId, tenantId: ctx.tenantId }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'student', entityId: studentId, action: 'student.deleted', changes: [{ field: 'status', from: student.status, to: null }], studentId, metadata: { personRemoved } });
  });
}

// ───────────────────────────────────────────────────────────── outside IDs

export async function listExternalIds(ctx: ServiceContext, studentId: string): Promise<ExternalIdDTO[]> {
  await loadStudent(ctx, studentId);
  const rows = await StudentExternalId.find({ tenantId: ctx.tenantId, studentId }).sort({ createdAt: 1, _id: 1 }).lean<StudentExternalIdDoc[]>();
  return rows.map(toExternalIdDTO);
}

export async function addExternalId(ctx: ServiceContext, studentId: string, data: CreateExternalIdData): Promise<ExternalIdDTO> {
  try {
    const id = await withTransaction(async (db) => {
      assertStudentWritable(await loadStudent(ctx, studentId, db));
      const [row] = await StudentExternalId.create([{ tenantId: ctx.tenantId, studentId, type: data.type, value: data.value, effectiveFrom: data.effectiveFrom ?? null, createdBy: ctx.userId, updatedBy: ctx.userId }], { session: db });
      await recordStudentAudit(ctx, db, {
        entityType: 'student',
        entityId: studentId,
        action: 'student.external_id_added',
        changes: [{ field: 'type', from: null, to: data.type }, { field: 'value', from: '[redacted]', to: '[redacted]' }],
        studentId,
      });
      return row!._id;
    });
    return toExternalIdDTO((await StudentExternalId.findOne({ _id: id, tenantId: ctx.tenantId }).lean<StudentExternalIdDoc>())!);
  } catch (err) {
    mapStudentDuplicate(err);
  }
}

export async function endExternalId(ctx: ServiceContext, externalIdId: string, data: EndExternalIdData): Promise<ExternalIdDTO> {
  await withTransaction(async (db) => {
    const row = await StudentExternalId.findOne({ _id: externalIdId, tenantId: ctx.tenantId }).session(db).lean<StudentExternalIdDoc>();
    if (!row) throw AppError.notFound('ID not found.');
    assertStudentWritable(await loadStudent(ctx, row.studentId, db));
    if (row.effectiveTo) throw AppError.validation({ externalIdId: 'This ID has already ended.' });
    const effectiveTo = data.effectiveTo ?? (await todayFor(ctx, db));
    await StudentExternalId.updateOne({ _id: row._id, tenantId: ctx.tenantId }, { $set: { effectiveTo, updatedBy: ctx.userId } }, { session: db });
    await recordStudentAudit(ctx, db, { entityType: 'student', entityId: row.studentId, action: 'student.external_id_ended', changes: [{ field: 'effectiveTo', from: null, to: effectiveTo }], studentId: row.studentId, metadata: { type: row.type } });
  });
  return toExternalIdDTO((await StudentExternalId.findOne({ _id: externalIdId, tenantId: ctx.tenantId }).lean<StudentExternalIdDoc>())!);
}

// ───────────────────────────────────────────────────────────── academic context

/**
 * Enrollment, section, roll and subjects of one student on one date (default today). This is the data later modules read:
 * what a student is in on a given day comes from effective-dated rows, never from a stored field.
 */
export async function getStudentAcademicContext(ctx: ServiceContext, studentId: string, query: StudentContextQuery): Promise<StudentAcademicContextDTO> {
  const student = await loadStudent(ctx, studentId);
  const today = await todayFor(ctx);
  const date = query.date ?? today;
  const admission = await StudentAdmission.findOne({ tenantId: ctx.tenantId, studentId, isCurrent: true }).select('admissionNumber').lean<Pick<StudentAdmissionDoc, 'admissionNumber'>>();

  const enrollments = await StudentEnrollment.find({ tenantId: ctx.tenantId, studentId, state: { $ne: 'CANCELLED' }, effectiveFrom: { $lte: date }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: date } }] })
    .sort({ effectiveFrom: -1 })
    .lean<StudentEnrollmentDoc[]>();
  const enrollment = enrollments.find((e) => e.state === 'OPEN') ?? enrollments[0] ?? null;
  if (!enrollment) return { studentId, date, status: student.status, admissionNumber: admission?.admissionNumber ?? null, enrollment: null, section: null, classSection: null, rollNumber: null, subjects: [] };

  const [assignments, subjectRows] = await Promise.all([
    StudentSectionAssignment.find({ tenantId: ctx.tenantId, enrollmentId: enrollment._id }).lean<StudentSectionAssignmentDoc[]>(),
    StudentSubjectEnrollment.find({ tenantId: ctx.tenantId, enrollmentId: enrollment._id }).sort({ isMandatory: -1, _id: 1 }).lean<StudentSubjectEnrollmentDoc[]>(),
  ]);
  const placement = assignments.find((a) => isOpenOn(a, date)) ?? null;
  const [enrollmentDto] = await toEnrollmentDTOs(ctx, [enrollment], { today });
  const subjects = await toSubjectDTOs(ctx, subjectRows.filter((r) => isOpenOn(r, date)), today);
  const h = await hydrateStudents(ctx, [student], { today });
  const klass = h.classes.get(enrollment.classOfferingId) ?? (await ClassOffering.findOne({ _id: enrollment.classOfferingId, tenantId: ctx.tenantId }).lean<ClassOfferingDoc>());
  const [sectionDto = null] = placement ? await toSectionAssignmentDTOs(ctx, [placement], today) : [];
  return {
    studentId,
    date,
    status: student.status,
    admissionNumber: admission?.admissionNumber ?? null,
    enrollment: enrollmentDto!,
    section: sectionDto,
    classSection: klass ? { classOfferingId: klass._id, className: klass.displayName, classCode: klass.displayCode, sectionId: sectionDto?.sectionId ?? null, sectionCode: sectionDto?.sectionCode ?? null, label: sectionDto ? `${klass.displayCode}-${sectionDto.sectionCode}` : klass.displayCode } : null,
    rollNumber: sectionDto?.rollNumber ?? null,
    subjects,
  };
}
