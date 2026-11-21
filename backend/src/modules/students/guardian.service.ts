import type { ClientSession, PipelineStage } from 'mongoose';
import {
  GUARDIAN_PERSON_FIELDS,
  GUARDIAN_LINK_EDITABLE_FIELDS,
  type EndGuardianLinkData,
  type FamilyListDTO,
  type ListFamiliesQuery,
  type GuardianChildDTO,
  type GuardianFamilyDTO,
  type GuardianInputData,
  type GuardianLinkDTO,
  type GuardianMatchDTO,
  type LinkExistingGuardianData,
  type MatchGuardianData,
  type NewGuardianData,
  type UpdateGuardianLinkData,
  type UpdateGuardianPersonData,
} from '@shared';
import { AppError } from '../../core/errors';
import { escapeRegex, pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { classifiedDiff } from '../staff/audit';
import { Person, type PersonDoc } from '../staff/person.model';
import { normalizePersonPatch } from '../staff/employee.service';
import { overlapping, todayFor } from '../staff/status';
import { recordStudentAudit } from './audit';
import { fullNameOf, hydrateStudents } from './directory';
import { dayBefore, endPatch } from './rows';
import { assertStudentWritable, assertVersion, loadGuardianLink, loadPerson, loadStudent } from './guards';
import { classSectionOf, toGuardianLinkDTO } from './mappers';
import { maskEmail, maskPhone } from './mask';
import { Student, StudentGuardianLink, type StudentDoc, type StudentGuardianLinkDoc } from './student.models';

/** SPM-04 to SPM-09 — parents and guardians. A guardian is a `people` row linked to a student; the link carries the rules. */

const LINK_AUDITED = ['guardianPersonId', 'relationshipType', 'isPrimary', 'isEmergencyContact', 'communicationPriority', 'canSeeAcademics', 'canSeeFees', 'pickupAllowed', 'portalEnabled', 'effectiveFrom', 'effectiveTo'] as const;

const liveToday = (today: string) => ({ cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: today } }] });

function mapLinkDuplicate(err: unknown): never {
  const fields = duplicateKeyFields(err);
  if (fields && fields.includes('studentId') && !fields.includes('guardianPersonId')) throw new AppError('GUARDIAN_PRIMARY_EXISTS');
  throw err;
}

// ───────────────────────────────────────────────────────────── link (inside a transaction)

export interface LinkInput {
  relationshipType: StudentGuardianLinkDoc['relationshipType'];
  effectiveFrom?: string | null | undefined;
  isPrimary?: boolean | undefined;
  isEmergencyContact?: boolean | undefined;
  communicationPriority?: number | undefined;
  canSeeAcademics?: boolean | undefined;
  canSeeFees?: boolean | undefined;
  pickupAllowed?: boolean | undefined;
}

/** Creates a guardian person from the typed details (no uniqueness on name or contact: different people share them). */
async function createGuardianPerson(ctx: ServiceContext, db: ClientSession, input: { legalFirstName: string; legalLastName?: string | undefined; phone?: string | null | undefined; email?: string | null | undefined }, studentId: string): Promise<PersonDoc> {
  const [created] = await Person.create(
    [
      {
        tenantId: ctx.tenantId,
        legalFirstName: input.legalFirstName,
        legalLastName: input.legalLastName ?? '',
        primaryPhone: input.phone ?? null,
        primaryEmail: input.email ?? null,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ],
    { session: db },
  );
  const person = created!.toObject() as PersonDoc;
  await recordStudentAudit(ctx, db, {
    entityType: 'person',
    entityId: person._id,
    action: 'person.created',
    changes: classifiedDiff('person', {}, person, ['legalFirstName', 'legalLastName', 'primaryPhone', 'primaryEmail']),
    studentId,
    metadata: { role: 'GUARDIAN' },
  });
  return person;
}

/**
 * Links a guardian to a student inside the caller's transaction.
 *  - The first guardian of a student becomes the primary one, unless the caller says otherwise.
 *  - Setting a new primary moves the flag in the same transaction (one active primary per student).
 *  - The same guardian cannot be linked twice for overlapping dates.
 *  - Emergency contact, access flags and `portalEnabled` are independent: a grandmother can be emergency-only with no login.
 */
export async function linkGuardianInTx(
  ctx: ServiceContext,
  db: ClientSession,
  student: StudentDoc,
  guardian: { person: PersonDoc } | { personId: string },
  input: LinkInput,
  today: string,
): Promise<{ link: StudentGuardianLinkDoc; person: PersonDoc }> {
  const person = 'person' in guardian ? guardian.person : await loadPerson(ctx, guardian.personId, db);
  const from = input.effectiveFrom ?? today;

  const clash = await StudentGuardianLink.exists({ tenantId: ctx.tenantId, studentId: student._id, guardianPersonId: person._id, cancelledAt: null, ...overlapping(from, null) }).session(db);
  if (clash) throw new AppError('GUARDIAN_LINK_DUPLICATE');

  const live = await StudentGuardianLink.find({ tenantId: ctx.tenantId, studentId: student._id, ...liveToday(today) }).session(db).lean<StudentGuardianLinkDoc[]>();
  const makePrimary = input.isPrimary ?? !live.some((l) => l.isPrimary);
  if (makePrimary) await clearPrimary(ctx, db, student._id, today, null);

  const [created] = await StudentGuardianLink.create(
    [
      {
        tenantId: ctx.tenantId,
        studentId: student._id,
        guardianPersonId: person._id,
        relationshipType: input.relationshipType,
        isPrimary: makePrimary,
        isEmergencyContact: input.isEmergencyContact ?? false,
        communicationPriority: input.communicationPriority ?? live.length + 1,
        canSeeAcademics: input.canSeeAcademics ?? true,
        canSeeFees: input.canSeeFees ?? true,
        pickupAllowed: input.pickupAllowed ?? false,
        portalEnabled: false,
        effectiveFrom: from,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ],
    { session: db },
  );
  const link = created!.toObject() as StudentGuardianLinkDoc;
  await recordStudentAudit(ctx, db, {
    entityType: 'guardian_link',
    entityId: link._id,
    action: 'guardian_link.created',
    changes: diffFields({}, link, LINK_AUDITED),
    studentId: student._id,
    metadata: { guardianPersonId: person._id, relationshipType: link.relationshipType },
  });
  return { link, person };
}

/** Takes the primary flag off every live link of the student (except `exceptLinkId`). */
async function clearPrimary(ctx: ServiceContext, db: ClientSession, studentId: string, today: string, exceptLinkId: string | null) {
  const primaries = await StudentGuardianLink.find({ tenantId: ctx.tenantId, studentId, isPrimary: true, ...liveToday(today), ...(exceptLinkId ? { _id: { $ne: exceptLinkId } } : {}) })
    .session(db)
    .lean<StudentGuardianLinkDoc[]>();
  for (const old of primaries) {
    await StudentGuardianLink.updateOne({ _id: old._id, tenantId: ctx.tenantId }, { $set: { isPrimary: false, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
    await recordStudentAudit(ctx, db, {
      entityType: 'guardian_link',
      entityId: old._id,
      action: 'guardian_link.primary_changed',
      changes: [{ field: 'isPrimary', from: true, to: false }],
      studentId,
      metadata: { guardianPersonId: old.guardianPersonId },
    });
  }
}

/** Quick Add: an existing parent (by id) or a new one (by name and contact), linked to a new student. */
export async function linkGuardianInput(ctx: ServiceContext, db: ClientSession, student: StudentDoc, input: GuardianInputData, today: string) {
  const flags: LinkInput = {
    relationshipType: input.relationshipType,
    effectiveFrom: input.effectiveFrom,
    isPrimary: input.isPrimary,
    isEmergencyContact: input.isEmergencyContact,
    communicationPriority: input.communicationPriority,
    canSeeAcademics: input.canSeeAcademics,
    canSeeFees: input.canSeeFees,
    pickupAllowed: input.pickupAllowed,
  };
  if (input.guardianPersonId) {
    const result = await linkGuardianInTx(ctx, db, student, { personId: input.guardianPersonId }, flags, today);
    return { ...result, reused: true };
  }
  const person = await createGuardianPerson(ctx, db, { legalFirstName: input.legalFirstName!, legalLastName: input.legalLastName, phone: input.phone, email: input.email }, student._id);
  const result = await linkGuardianInTx(ctx, db, student, { person }, flags, today);
  return { ...result, reused: false };
}

// ───────────────────────────────────────────────────────────── reads

async function dtosOf(ctx: ServiceContext, links: StudentGuardianLinkDoc[], today: string, db?: ClientSession): Promise<GuardianLinkDTO[]> {
  if (links.length === 0) return [];
  const people = await Person.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(links.map((l) => l.guardianPersonId))] } }).session(db ?? null).lean<PersonDoc[]>();
  const byId = new Map(people.map((p) => [p._id, p]));
  const viewPersonal = can(ctx, 'student:view_personal');
  return links.map((l) => toGuardianLinkDTO(l, byId.get(l.guardianPersonId)!, today, viewPersonal));
}

/** Every link of a student, current ones first. Contact is only included for a caller with `student:view_personal`. */
export async function listGuardians(ctx: ServiceContext, studentId: string): Promise<GuardianLinkDTO[]> {
  await loadStudent(ctx, studentId);
  const today = await todayFor(ctx);
  const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, studentId }).sort({ isPrimary: -1, communicationPriority: 1, effectiveFrom: 1, _id: 1 }).lean<StudentGuardianLinkDoc[]>();
  const dtos = await dtosOf(ctx, links, today);
  const rank = (d: GuardianLinkDTO) => (d.status === 'ACTIVE' ? 0 : d.status === 'PLANNED' ? 1 : 2);
  return dtos.sort((a, b) => rank(a) - rank(b));
}

async function linkDTO(ctx: ServiceContext, linkId: string, db?: ClientSession): Promise<GuardianLinkDTO> {
  const link = await loadGuardianLink(ctx, linkId, db);
  return (await dtosOf(ctx, [link], await todayFor(ctx, db), db))[0]!;
}

// ───────────────────────────────────────────────────────────── add / link

export async function addGuardian(ctx: ServiceContext, studentId: string, data: NewGuardianData): Promise<GuardianLinkDTO> {
  try {
    const linkId = await withTransaction(async (db) => {
      const student = await loadStudent(ctx, studentId, db);
      assertStudentWritable(student);
      const today = await todayFor(ctx, db);
      const { link } = await linkGuardianInput(ctx, db, student, { ...data, guardianPersonId: undefined }, today);
      return link._id;
    });
    return await linkDTO(ctx, linkId);
  } catch (err) {
    mapLinkDuplicate(err);
  }
}

/** Sibling case: the same parent person is linked to another child, with no retyping. */
export async function linkExistingGuardian(ctx: ServiceContext, studentId: string, data: LinkExistingGuardianData): Promise<GuardianLinkDTO> {
  try {
    const linkId = await withTransaction(async (db) => {
      const student = await loadStudent(ctx, studentId, db);
      assertStudentWritable(student);
      const today = await todayFor(ctx, db);
      const { link } = await linkGuardianInTx(ctx, db, student, { personId: data.guardianPersonId }, data, today);
      return link._id;
    });
    return await linkDTO(ctx, linkId);
  } catch (err) {
    mapLinkDuplicate(err);
  }
}

// ───────────────────────────────────────────────────────────── change / end

export async function updateGuardianLink(ctx: ServiceContext, linkId: string, patch: UpdateGuardianLinkData): Promise<GuardianLinkDTO> {
  try {
    await withTransaction(async (db) => {
      const before = await loadGuardianLink(ctx, linkId, db);
      assertStudentWritable(await loadStudent(ctx, before.studentId, db));
      const today = await todayFor(ctx, db);
      if (before.cancelledAt || (before.effectiveTo && before.effectiveTo < today)) throw new AppError('GUARDIAN_LINK_CLOSED');
      assertVersion(before.version, patch.version);

      const { version: _version, ...fields } = patch;
      const changes = pickDefined(fields);
      const merged = { ...before, ...changes };
      const diff = diffFields(before, merged, GUARDIAN_LINK_EDITABLE_FIELDS);
      if (diff.length === 0) return;

      const becomesPrimary = changes.isPrimary === true && !before.isPrimary;
      if (becomesPrimary) await clearPrimary(ctx, db, before.studentId, today, before._id);

      const $set: Record<string, unknown> = { updatedBy: ctx.userId };
      for (const c of diff) $set[c.field] = (merged as Record<string, unknown>)[c.field];
      const done = await StudentGuardianLink.updateOne({ _id: linkId, tenantId: ctx.tenantId, version: patch.version }, { $set, $inc: { version: 1 } }, { session: db });
      if (done.matchedCount !== 1) throw new AppError('VERSION_CONFLICT');
      await recordStudentAudit(ctx, db, {
        entityType: 'guardian_link',
        entityId: linkId,
        action: becomesPrimary ? 'guardian_link.primary_changed' : 'guardian_link.updated',
        changes: diff,
        studentId: before.studentId,
        metadata: { guardianPersonId: before.guardianPersonId },
      });
    });
  } catch (err) {
    mapLinkDuplicate(err);
  }
  return linkDTO(ctx, linkId);
}

/**
 * Ends a link. Without a date it ends now: the last day is yesterday, so access stops at once (a link that began today is
 * cancelled instead, because it never took effect). With a date, that is the last day it still counts. The row stays for history
 * and the guardian person is never deleted.
 */
export async function endGuardianLink(ctx: ServiceContext, linkId: string, data: EndGuardianLinkData): Promise<GuardianLinkDTO> {
  await withTransaction(async (db) => {
    const before = await loadGuardianLink(ctx, linkId, db);
    assertStudentWritable(await loadStudent(ctx, before.studentId, db));
    const today = await todayFor(ctx, db);
    if (before.cancelledAt || (before.effectiveTo && before.effectiveTo < today)) throw new AppError('GUARDIAN_LINK_CLOSED');
    if (data.effectiveTo && data.effectiveTo < before.effectiveFrom) throw AppError.validation({ effectiveTo: `The end date cannot be before the link starts (${before.effectiveFrom}).` });
    const patch = endPatch(before, data.effectiveTo ?? dayBefore(today));
    await StudentGuardianLink.updateOne({ _id: linkId, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId }, $inc: { version: 1 } }, { session: db });
    await recordStudentAudit(ctx, db, {
      entityType: 'guardian_link',
      entityId: linkId,
      action: 'guardian_link.ended',
      changes: 'effectiveTo' in patch ? [{ field: 'effectiveTo', from: before.effectiveTo ?? null, to: patch.effectiveTo }] : [{ field: 'cancelledAt', from: null, to: new Date().toISOString() }],
      studentId: before.studentId,
      metadata: { guardianPersonId: before.guardianPersonId, relationshipType: before.relationshipType },
    });
  });
  return linkDTO(ctx, linkId);
}

// ───────────────────────────────────────────────────────────── matching and the family view

/**
 * Quick Add calls this as soon as a phone or email is typed: it finds people who already are parents here, with the children
 * already linked, so a sibling reuses the same parent. Contact is masked: it only has to be enough to recognise them.
 */
export async function matchGuardians(ctx: ServiceContext, data: MatchGuardianData): Promise<GuardianMatchDTO[]> {
  const contact: Record<string, unknown>[] = [];
  if (data.phone) contact.push({ primaryPhone: data.phone }, { personalPhone: data.phone });
  if (data.email) contact.push({ primaryEmail: data.email }, { personalEmail: data.email });

  const nameTokens = (data.name ?? '').split(/\s+/).filter(Boolean);
  const nameMatch = nameTokens.map((t) => {
    const rx = new RegExp(escapeRegex(t), 'i');
    return { $or: [{ legalFirstName: rx }, { legalMiddleName: rx }, { legalLastName: rx }, { preferredName: rx }] };
  });

  const byContact = contact.length ? await Person.find({ tenantId: ctx.tenantId, $or: contact }).limit(20).lean<PersonDoc[]>() : [];
  // A name alone only matches people who are already parents, so the staff list is never searched by it.
  const byName = !contact.length && nameMatch.length ? await Person.find({ tenantId: ctx.tenantId, $and: nameMatch }).limit(50).lean<PersonDoc[]>() : [];
  const people = [...new Map([...byContact, ...byName].map((p) => [p._id, p])).values()];
  if (people.length === 0) return [];

  const today = await todayFor(ctx);
  const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, guardianPersonId: { $in: people.map((p) => p._id) }, cancelledAt: null }).lean<StudentGuardianLinkDoc[]>();
  const kids = await childrenOf(ctx, links, today);

  return people
    .map((p) => ({ person: p, mine: links.filter((l) => l.guardianPersonId === p._id) }))
    .filter(({ mine }) => contact.length > 0 || mine.length > 0)
    .slice(0, 10)
    .map(({ person, mine }) => {
      const children: GuardianMatchDTO['children'] = [];
      for (const studentId of new Set(mine.map((l) => l.studentId))) {
        const kid = kids.get(studentId);
        if (kid) children.push({ studentId, fullName: kid.fullName, admissionNumber: kid.admissionNumber, classSection: kid.classSection });
      }
      return {
        personId: person._id,
        fullName: fullNameOf(person),
        maskedPhone: maskPhone(person.primaryPhone ?? person.personalPhone),
        maskedEmail: maskEmail(person.primaryEmail ?? person.personalEmail),
        isGuardian: mine.length > 0,
        children,
      };
    });
}

/** Student name, admission number and class-section for the students behind some links. */
async function childrenOf(ctx: ServiceContext, links: StudentGuardianLinkDoc[], today: string) {
  const students = await Student.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(links.map((l) => l.studentId))] } }).lean<StudentDoc[]>();
  const h = await hydrateStudents(ctx, students, { today });
  return new Map(
    students.map((s) => [
      s._id,
      {
        studentId: s._id,
        fullName: fullNameOf(h.people.get(s.personId)!),
        admissionNumber: h.admissions.get(s._id)?.admissionNumber ?? null,
        classSection: classSectionOf(h.classes, h.sections, h.placements.get(s._id)?.enrollment ?? null, h.placements.get(s._id)?.assignment ?? null),
        status: s.status,
      },
    ]),
  );
}

/** The Family view: one parent and all their children. */
export async function getGuardianFamily(ctx: ServiceContext, personId: string): Promise<GuardianFamilyDTO> {
  const person = await loadPerson(ctx, personId);
  const links = await StudentGuardianLink.find({ tenantId: ctx.tenantId, guardianPersonId: personId }).sort({ effectiveFrom: 1, _id: 1 }).lean<StudentGuardianLinkDoc[]>();
  if (links.length === 0) throw AppError.notFound('Parent not found.');
  const today = await todayFor(ctx);
  const kids = await childrenOf(ctx, links, today);
  const viewPersonal = can(ctx, 'student:view_personal');
  const dtos = await dtosOf(ctx, links, today);
  const children: GuardianChildDTO[] = dtos
    .filter((l) => kids.has(l.studentId))
    .map((link) => {
      const kid = kids.get(link.studentId)!;
      return { studentId: kid.studentId, fullName: kid.fullName, admissionNumber: kid.admissionNumber, studentStatus: kid.status, classSection: kid.classSection, link };
    });
  return {
    personId: person._id,
    fullName: fullNameOf(person),
    legalFirstName: person.legalFirstName,
    legalMiddleName: person.legalMiddleName ?? null,
    legalLastName: person.legalLastName,
    phone: viewPersonal ? person.primaryPhone ?? null : null,
    email: viewPersonal ? person.primaryEmail ?? null : null,
    address: viewPersonal && person.address ? { ...person.address } : null,
    children,
  };
}

/** Edits the parent once; every child sees the change. Contact values are `[redacted]` in the audit trail. */
export async function updateGuardianPerson(ctx: ServiceContext, personId: string, patch: UpdateGuardianPersonData): Promise<GuardianFamilyDTO> {
  await withTransaction(async (db) => {
    const isGuardian = await StudentGuardianLink.exists({ tenantId: ctx.tenantId, guardianPersonId: personId }).session(db);
    if (!isGuardian) throw AppError.notFound('Parent not found.');
    const before = await loadPerson(ctx, personId, db);
    const changes = normalizePersonPatch(pickDefined(patch) as Record<string, unknown>);
    const merged = { ...before, ...changes } as PersonDoc;
    const diff = classifiedDiff('person', before, merged, GUARDIAN_PERSON_FIELDS);
    if (diff.length === 0) return;
    const $set: Record<string, unknown> = { updatedBy: ctx.userId };
    for (const c of diff) $set[c.field] = (merged as unknown as Record<string, unknown>)[c.field];
    await Person.updateOne({ _id: personId, tenantId: ctx.tenantId }, { $set }, { session: db });
    const kids = await StudentGuardianLink.distinct('studentId', { tenantId: ctx.tenantId, guardianPersonId: personId }).session(db);
    await recordStudentAudit(ctx, db, {
      entityType: 'person',
      entityId: personId,
      action: 'guardian.updated',
      changes: diff,
      // The student history of every linked child shows that the parent's details changed (never the values).
      studentId: null,
      metadata: { studentIds: kids, role: 'GUARDIAN' },
    });
  });
  return getGuardianFamily(ctx, personId);
}

/** The Families list: every parent with a live link, with their children's names. Search by parent name, phone or a child's name. */
export async function listFamilies(ctx: ServiceContext, query: ListFamiliesQuery): Promise<FamilyListDTO> {
  const tenantId = ctx.tenantId;
  const today = await todayFor(ctx);
  const tokens = (query.q ?? '').split(/\s+/).filter(Boolean);
  const viewPersonal = can(ctx, 'student:view_personal');

  const pipeline: PipelineStage[] = [
    { $match: { tenantId, ...liveToday(today) } },
    { $group: { _id: '$guardianPersonId', studentIds: { $addToSet: '$studentId' } } },
    { $lookup: { from: 'people', localField: '_id', foreignField: '_id', as: 'person' } },
    { $unwind: '$person' },
    { $lookup: { from: 'students', localField: 'studentIds', foreignField: '_id', as: 'kids' } },
    { $lookup: { from: 'people', localField: 'kids.personId', foreignField: '_id', as: 'kidPeople' } },
  ];
  if (tokens.length > 0) {
    pipeline.push({
      $match: {
        $and: tokens.map((t) => {
          const rx = new RegExp(escapeRegex(t), 'i');
          return { $or: [{ 'person.legalFirstName': rx }, { 'person.legalMiddleName': rx }, { 'person.legalLastName': rx }, { 'person.primaryPhone': rx }, { 'kidPeople.legalFirstName': rx }, { 'kidPeople.legalLastName': rx }] };
        }),
      },
    });
  }
  pipeline.push(
    { $sort: { 'person.legalFirstName': 1, 'person.legalLastName': 1, _id: 1 } },
    { $facet: { items: [{ $skip: (query.page - 1) * query.pageSize }, { $limit: query.pageSize }], total: [{ $count: 'n' }] } },
  );
  const [result] = await StudentGuardianLink.aggregate<{ items: { _id: string; person: PersonDoc; kids: { _id: string; personId: string }[]; kidPeople: PersonDoc[] }[]; total: { n: number }[] }>(pipeline).collation({ locale: 'en', strength: 2 });
  const items = (result?.items ?? []).map((row) => {
    const peopleById = new Map(row.kidPeople.map((p) => [p._id, p]));
    const children = row.kids
      .map((k) => ({ studentId: k._id, fullName: fullNameOf(peopleById.get(k.personId) ?? { legalFirstName: 'Student', legalLastName: '' }) }))
      .sort((a, b) => a.fullName.localeCompare(b.fullName, 'en', { sensitivity: 'base' }));
    return {
      personId: row._id,
      fullName: fullNameOf(row.person),
      phone: viewPersonal ? row.person.primaryPhone ?? null : null,
      email: viewPersonal ? row.person.primaryEmail ?? null : null,
      childCount: children.length,
      children,
    };
  });
  return { items, page: query.page, pageSize: query.pageSize, total: result?.total[0]?.n ?? 0 };
}
