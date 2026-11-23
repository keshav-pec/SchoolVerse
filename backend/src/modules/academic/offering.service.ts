import type { ClientSession } from 'mongoose';
import {
  CLASS_OFFERING_EDITABLE_FIELDS,
  SECTION_EDITABLE_FIELDS,
  SUBJECT_OFFERING_EDITABLE_FIELDS,
  type CreateClassOfferingsData,
  type ApplySectionsResult,
  type ApplySectionsToAllData,
  type CreateSectionsData,
  type CreateSubjectOfferingsData,
  type ClassOfferingDTO,
  type SectionOfferingDTO,
  type SubjectOfferingDTO,
  type UpdateClassOfferingData,
  type UpdateSectionData,
  type UpdateSubjectOfferingData,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { onDuplicate } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields, changedValues } from '../audit/diff';
import { recordAcademicAudit } from './audit';
import { removeRulesForClassOffering, removeRulesForSubjectOfferings, runOfferingCleanup } from './cleanup';
import { assertDeletable, assertEditable } from './guard';
import {
  ClassOffering,
  SectionOffering,
  SubjectOffering,
  type ClassOfferingDoc,
  type SectionOfferingDoc,
  type SubjectOfferingDoc,
} from './offering.model';
import { ClassMaster, type ClassMasterDoc } from './reference.model';
import { getClassesByIds } from './reference.service';
import { getSessionOrThrow } from './session.service';
import type { AcademicSessionDoc } from './session.model';
import { BoardSubjectDefinition, Subject, type BoardSubjectDefinitionDoc, type SubjectDoc } from './subject.model';

/** AS-03 / AS-04 / AS-07 — class offerings, sections and subject offerings. */

// ───────────────────────────────────────────────────────────── loading helpers (visibility + tenant isolation)

/** A class offering plus its session. Offerings of a session the caller can't see are 404s. */
export async function getClassOfferingOrThrow(ctx: ServiceContext, classOfferingId: string, db?: ClientSession) {
  const offering = await ClassOffering.findOne({ _id: classOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<ClassOfferingDoc>();
  if (!offering) throw AppError.notFound('Class not found.');
  const session = await getSessionOrThrow(ctx, offering.sessionId, db);
  return { offering, session };
}

async function getSectionOrThrow(ctx: ServiceContext, sectionId: string, db?: ClientSession) {
  const section = await SectionOffering.findOne({ _id: sectionId, tenantId: ctx.tenantId }).session(db ?? null).lean<SectionOfferingDoc>();
  if (!section) throw AppError.notFound('Section not found.');
  const session = await getSessionOrThrow(ctx, section.sessionId, db);
  return { section, session };
}

async function getSubjectOfferingOrThrow(ctx: ServiceContext, subjectOfferingId: string, db?: ClientSession) {
  const offering = await SubjectOffering.findOne({ _id: subjectOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<SubjectOfferingDoc>();
  if (!offering) throw AppError.notFound('Subject offering not found.');
  const session = await getSessionOrThrow(ctx, offering.sessionId, db);
  return { offering, session };
}

function pinnedRuleVersionId(session: AcademicSessionDoc, locationId: string): string | null {
  return session.locations.find((l) => l.locationId === locationId)?.boardRuleVersionId ?? null;
}

// ───────────────────────────────────────────────────────────── class offerings

function toClassOfferingDTO(doc: ClassOfferingDoc, schoolClass: ClassMasterDoc | undefined, counts: { sections: number; subjects: number }): ClassOfferingDTO {
  return {
    classOfferingId: doc._id,
    academicSessionId: doc.sessionId,
    locationId: doc.locationId,
    classId: doc.classId,
    canonicalCode: schoolClass?.canonicalCode ?? '',
    displayName: doc.displayName,
    displayCode: doc.displayCode,
    medium: doc.medium ?? null,
    capacity: doc.capacity ?? null,
    sequenceOrder: doc.sequenceOrder,
    status: doc.status,
    sectionCount: counts.sections,
    subjectCount: counts.subjects,
  };
}

async function countBy(model: typeof SectionOffering | typeof SubjectOffering, tenantId: string, classOfferingIds: string[], db?: ClientSession) {
  const rows = await model
    .aggregate<{ _id: string; n: number }>([{ $match: { tenantId, classOfferingId: { $in: classOfferingIds } } }, { $group: { _id: '$classOfferingId', n: { $sum: 1 } } }])
    .session(db ?? null);
  return new Map(rows.map((r) => [r._id, r.n]));
}

export async function toClassOfferingDTOs(ctx: ServiceContext, docs: ClassOfferingDoc[], db?: ClientSession): Promise<ClassOfferingDTO[]> {
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d._id);
  const [classes, sections, subjects] = await Promise.all([
    ClassMaster.find({ _id: { $in: [...new Set(docs.map((d) => d.classId))] } }).session(db ?? null).lean<ClassMasterDoc[]>(),
    countBy(SectionOffering, ctx.tenantId, ids, db),
    countBy(SubjectOffering, ctx.tenantId, ids, db),
  ]);
  const classById = new Map(classes.map((g) => [g._id, g]));
  return docs.map((d) => toClassOfferingDTO(d, classById.get(d.classId), { sections: sections.get(d._id) ?? 0, subjects: subjects.get(d._id) ?? 0 }));
}

export async function getClassOfferingDTO(ctx: ServiceContext, classOfferingId: string, db?: ClientSession) {
  const { offering } = await getClassOfferingOrThrow(ctx, classOfferingId, db);
  return (await toClassOfferingDTOs(ctx, [offering], db))[0]!;
}

export async function listClassOfferings(ctx: ServiceContext, academicSessionId: string, locationId?: string): Promise<ClassOfferingDTO[]> {
  await getSessionOrThrow(ctx, academicSessionId);
  const docs = await ClassOffering.find({ tenantId: ctx.tenantId, sessionId: academicSessionId, ...(locationId ? { locationId } : {}) })
    .sort({ locationId: 1, sequenceOrder: 1, _id: 1 })
    .lean<ClassOfferingDoc[]>();
  return toClassOfferingDTOs(ctx, docs);
}

function exists(): never {
  throw new AppError('CLASS_OFFERING_EXISTS');
}

export async function createClassOfferings(ctx: ServiceContext, academicSessionId: string, data: CreateClassOfferingsData): Promise<ClassOfferingDTO[]> {
  const classIds = [...new Set(data.classIds)];
  return withTransaction(async (db) => {
    const session = await getSessionOrThrow(ctx, academicSessionId, db);
    await assertEditable(session, {}, db);
    if (!pinnedRuleVersionId(session, data.locationId)) throw new AppError('LOCATION_NOT_IN_SESSION', undefined, { locationId: data.locationId });

    const classes = await getClassesByIds(classIds, db);
    if (classes.length !== classIds.length) throw AppError.notFound('One or more classes were not found.');

    const already = await ClassOffering.find({ tenantId: ctx.tenantId, sessionId: academicSessionId, locationId: data.locationId, classId: { $in: classIds } })
      .select('classId')
      .session(db)
      .lean<{ classId: string }[]>();
    if (already.length > 0) {
      const names = classes.filter((g) => already.some((a) => a.classId === g._id)).map((g) => g.canonicalName);
      throw new AppError('CLASS_OFFERING_EXISTS', `Already set up for this location: ${names.join(', ')}.`, {
        classIds: already.map((a) => a.classId),
        fields: { classIds: `Already set up: ${names.join(', ')}.` },
      });
    }

    const ordered = [...classes].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const created: ClassOfferingDoc[] = [];
    for (const schoolClass of ordered) {
      const [doc] = await ClassOffering.create(
        [
          {
            tenantId: ctx.tenantId,
            sessionId: academicSessionId,
            locationId: data.locationId,
            classId: schoolClass._id,
            displayName: data.labels?.[schoolClass._id]?.displayName ?? schoolClass.canonicalName,
            displayCode: data.labels?.[schoolClass._id]?.displayCode ?? schoolClass.shortCode,
            medium: data.medium ?? null,
            sequenceOrder: schoolClass.sequenceNumber,
            status: 'ACTIVE',
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      const offering = doc!.toObject() as ClassOfferingDoc;
      created.push(offering);
      await recordAcademicAudit(ctx, db, {
        entityType: 'class_offering',
        entityId: offering._id,
        action: 'class_offering.created',
        changes: diffFields({}, offering, CLASS_OFFERING_EDITABLE_FIELDS),
        academicSessionId,
        metadata: { locationId: data.locationId, classId: schoolClass._id, canonicalCode: schoolClass.canonicalCode },
      });
    }
    return toClassOfferingDTOs(ctx, created, db);
  }).catch(onDuplicate('classId', exists));
}

export async function updateClassOffering(ctx: ServiceContext, classOfferingId: string, patch: UpdateClassOfferingData): Promise<ClassOfferingDTO> {
  return withTransaction(async (db) => {
    const { offering: before, session } = await getClassOfferingOrThrow(ctx, classOfferingId, db);
    const deactivating = patch.status === 'INACTIVE' && before.status === 'ACTIVE';
    await assertEditable(session, deactivating ? { structural: { entityType: 'class_offering', entityId: classOfferingId } } : {}, db);

    const merged = { ...before, ...pickDefined(patch) } as ClassOfferingDoc;
    const changes = diffFields(before, merged, CLASS_OFFERING_EDITABLE_FIELDS);
    if (changes.length > 0) {
      await ClassOffering.updateOne({ _id: classOfferingId, tenantId: ctx.tenantId }, { $set: changedValues(merged, changes, ctx.userId) }, { session: db });
      await recordAcademicAudit(ctx, db, {
        entityType: 'class_offering',
        entityId: classOfferingId,
        action: 'class_offering.updated',
        changes,
        academicSessionId: before.sessionId,
        metadata: { locationId: before.locationId, status: session.status },
      });
    }
    return getClassOfferingDTO(ctx, classOfferingId, db);
  });
}

/** Deletes a class offering and what hangs under it: sections, subject offerings, choice groups, constraints and programme rules. */
export async function deleteClassOfferingContents(tenantId: string, classOfferingId: string, db: ClientSession) {
  const offeringIds = (await SubjectOffering.find({ tenantId, classOfferingId }).select('_id').session(db).lean<{ _id: string }[]>()).map((o) => o._id);
  const rules = await removeRulesForClassOffering(tenantId, classOfferingId, db);
  await removeRulesForSubjectOfferings(tenantId, offeringIds, db);
  await runOfferingCleanup(tenantId, { sectionOfferingIds: (await SectionOffering.find({ tenantId, classOfferingId }).select('_id').session(db).lean<{ _id: string }[]>()).map((x) => x._id), subjectOfferingIds: offeringIds, classOfferingIds: [classOfferingId] }, db);
  const [sections, subjectOfferings] = await Promise.all([
    SectionOffering.deleteMany({ tenantId, classOfferingId }, { session: db }),
    SubjectOffering.deleteMany({ tenantId, classOfferingId }, { session: db }),
  ]);
  return { sections: sections.deletedCount, subjectOfferings: subjectOfferings.deletedCount, ...rules };
}

export async function deleteClassOffering(ctx: ServiceContext, classOfferingId: string): Promise<void> {
  await withTransaction(async (db) => {
    const { offering: before, session } = await getClassOfferingOrThrow(ctx, classOfferingId, db);
    assertDeletable(session);
    const removed = await deleteClassOfferingContents(ctx.tenantId, classOfferingId, db);
    await ClassOffering.deleteOne({ _id: classOfferingId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'class_offering',
      entityId: classOfferingId,
      action: 'class_offering.deleted',
      changes: diffFields(before, {}, ['displayName', 'displayCode', 'status']),
      academicSessionId: before.sessionId,
      metadata: { locationId: before.locationId, classId: before.classId, removed },
    });
  });
}

// ───────────────────────────────────────────────────────────── sections

function toSectionDTO(doc: SectionOfferingDoc): SectionOfferingDTO {
  return {
    sectionOfferingId: doc._id,
    classOfferingId: doc.classOfferingId,
    academicSessionId: doc.sessionId,
    locationId: doc.locationId,
    sectionCode: doc.sectionCode,
    displayName: doc.displayName,
    capacity: doc.capacity ?? null,
    sequenceOrder: doc.sequenceOrder,
    status: doc.status,
  };
}

export async function listSections(ctx: ServiceContext, classOfferingId: string): Promise<SectionOfferingDTO[]> {
  await getClassOfferingOrThrow(ctx, classOfferingId);
  return listSectionsFor(ctx, classOfferingId);
}

/** Same as `listSections` for a class offering the caller has already been allowed to see. */
export async function listSectionsFor(ctx: ServiceContext, classOfferingId: string): Promise<SectionOfferingDTO[]> {
  const docs = await SectionOffering.find({ tenantId: ctx.tenantId, classOfferingId }).sort({ sequenceOrder: 1, sectionCode: 1 }).lean<SectionOfferingDoc[]>();
  return docs.map(toSectionDTO);
}

function sectionCodeTaken(codes: string[]) {
  return new AppError('SECTION_CODE_TAKEN', `Section ${codes.join(', ')} already exists for this class.`, {
    codes,
    fields: { codes: `Already exists: ${codes.join(', ')}.` },
  });
}

/** Adds `codes` (already checked as free) to one class, inside the caller's transaction. */
async function insertSections(ctx: ServiceContext, db: ClientSession, offering: ClassOfferingDoc, codes: string[], capacity: number | null, startAfter: number): Promise<SectionOfferingDoc[]> {
  let order = startAfter;
  const created: SectionOfferingDoc[] = [];
  for (const code of codes) {
    order += 1;
    const [doc] = await SectionOffering.create(
      [
        {
          tenantId: ctx.tenantId,
          classOfferingId: offering._id,
          sessionId: offering.sessionId,
          locationId: offering.locationId,
          sectionCode: code,
          displayName: code,
          capacity,
          sequenceOrder: order,
          status: 'ACTIVE',
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    const section = doc!.toObject() as SectionOfferingDoc;
    created.push(section);
    await recordAcademicAudit(ctx, db, {
      entityType: 'section_offering',
      entityId: section._id,
      action: 'section.created',
      changes: [{ field: 'sectionCode', from: null, to: section.sectionCode }, ...diffFields({}, section, ['capacity'])],
      academicSessionId: offering.sessionId,
      metadata: { classOfferingId: offering._id, locationId: offering.locationId },
    });
  }
  return created;
}

export async function createSections(ctx: ServiceContext, classOfferingId: string, data: CreateSectionsData): Promise<SectionOfferingDTO[]> {
  const repeated = data.codes.filter((c, i) => data.codes.indexOf(c) !== i);
  if (repeated.length > 0) throw sectionCodeTaken([...new Set(repeated)]);

  return withTransaction(async (db) => {
    const { offering, session } = await getClassOfferingOrThrow(ctx, classOfferingId, db);
    await assertEditable(session, {}, db);

    const existing = await SectionOffering.find({ tenantId: ctx.tenantId, classOfferingId }).select('sectionCode sequenceOrder').session(db).lean<SectionOfferingDoc[]>();
    const taken = data.codes.filter((c) => existing.some((e) => e.sectionCode === c));
    if (taken.length > 0) throw sectionCodeTaken(taken);

    const created = await insertSections(ctx, db, offering, data.codes, data.capacity ?? null, existing.reduce((max, e) => Math.max(max, e.sequenceOrder), 0));
    return created.map(toSectionDTO);
  }).catch(onDuplicate('sectionCode', () => sectionCodeTaken(data.codes)));
}

/** Sets up the same sections for every class at a location in one step. Existing sections are never changed or duplicated. */
export async function applySectionsToAllClasses(ctx: ServiceContext, academicSessionId: string, data: ApplySectionsToAllData): Promise<ApplySectionsResult> {
  const repeated = data.codes.filter((c, i) => data.codes.indexOf(c) !== i);
  if (repeated.length > 0) throw sectionCodeTaken([...new Set(repeated)]);

  return withTransaction(async (db) => {
    const session = await getSessionOrThrow(ctx, academicSessionId, db);
    await assertEditable(session, {}, db);
    if (!pinnedRuleVersionId(session, data.locationId)) throw new AppError('LOCATION_NOT_IN_SESSION', undefined, { locationId: data.locationId });

    const classes = await ClassOffering.find({ tenantId: ctx.tenantId, sessionId: academicSessionId, locationId: data.locationId }).sort({ sequenceOrder: 1, _id: 1 }).session(db).lean<ClassOfferingDoc[]>();
    if (classes.length === 0) throw new AppError('VALIDATION_FAILED', 'Add classes to this location first.', { fields: { codes: 'Add classes to this location first.' } });

    const existing = await SectionOffering.find({ tenantId: ctx.tenantId, classOfferingId: { $in: classes.map((g) => g._id) } }).select('classOfferingId sectionCode sequenceOrder').session(db).lean<SectionOfferingDoc[]>();
    const result: ApplySectionsResult = { classes: classes.length, classesChanged: 0, sectionsAdded: 0, sectionsSkipped: 0 };
    for (const schoolClass of classes) {
      const have = existing.filter((e) => e.classOfferingId === schoolClass._id);
      const missing = data.codes.filter((c) => !have.some((e) => e.sectionCode === c));
      result.sectionsSkipped += data.codes.length - missing.length;
      if (missing.length === 0) continue;
      const created = await insertSections(ctx, db, schoolClass, missing, data.capacity ?? null, have.reduce((max, e) => Math.max(max, e.sequenceOrder), 0));
      result.classesChanged += 1;
      result.sectionsAdded += created.length;
    }
    return result;
  });
}

export async function updateSection(ctx: ServiceContext, sectionId: string, patch: UpdateSectionData): Promise<SectionOfferingDTO> {
  return withTransaction(async (db) => {
    const { section: before, session } = await getSectionOrThrow(ctx, sectionId, db);
    const deactivating = patch.status === 'INACTIVE' && before.status === 'ACTIVE';
    await assertEditable(session, deactivating ? { structural: { entityType: 'section_offering', entityId: sectionId } } : {}, db);

    const merged = { ...before, ...pickDefined(patch) } as SectionOfferingDoc;
    const changes = diffFields(before, merged, SECTION_EDITABLE_FIELDS);
    if (changes.length > 0) {
      await SectionOffering.updateOne({ _id: sectionId, tenantId: ctx.tenantId }, { $set: changedValues(merged, changes, ctx.userId) }, { session: db });
      await recordAcademicAudit(ctx, db, {
        entityType: 'section_offering',
        entityId: sectionId,
        action: 'section.updated',
        changes,
        academicSessionId: before.sessionId,
        metadata: { classOfferingId: before.classOfferingId, sectionCode: before.sectionCode, status: session.status },
      });
    }
    return toSectionDTO({ ...merged, updatedBy: ctx.userId });
  });
}

export async function deleteSection(ctx: ServiceContext, sectionId: string): Promise<void> {
  await withTransaction(async (db) => {
    const { section: before, session } = await getSectionOrThrow(ctx, sectionId, db);
    assertDeletable(session);
    await runOfferingCleanup(ctx.tenantId, { sectionOfferingIds: [sectionId] }, db);
    await SectionOffering.deleteOne({ _id: sectionId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'section_offering',
      entityId: sectionId,
      action: 'section.deleted',
      changes: diffFields(before, {}, ['sectionCode', 'displayName', 'status']),
      academicSessionId: before.sessionId,
      metadata: { classOfferingId: before.classOfferingId },
    });
  });
}

// ───────────────────────────────────────────────────────────── subject offerings

async function toSubjectOfferingDTOs(ctx: ServiceContext, docs: SubjectOfferingDoc[], db?: ClientSession): Promise<SubjectOfferingDTO[]> {
  if (docs.length === 0) return [];
  const [subjects, definitions] = await Promise.all([
    Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(docs.map((d) => d.subjectId))] } }).session(db ?? null).lean<SubjectDoc[]>(),
    BoardSubjectDefinition.find({ tenantId: ctx.tenantId, _id: { $in: docs.map((d) => d.boardSubjectDefinitionId).filter((id): id is string => Boolean(id)) } })
      .session(db ?? null)
      .lean<BoardSubjectDefinitionDoc[]>(),
  ]);
  const subjectById = new Map(subjects.map((s) => [s._id, s]));
  const definitionById = new Map(definitions.map((d) => [d._id, d]));
  return docs.map((d) => {
    const subject = subjectById.get(d.subjectId);
    const definition = d.boardSubjectDefinitionId ? definitionById.get(d.boardSubjectDefinitionId) : undefined;
    return {
      subjectOfferingId: d._id,
      classOfferingId: d.classOfferingId,
      academicSessionId: d.sessionId,
      locationId: d.locationId,
      subjectId: d.subjectId,
      subjectCode: subject?.subjectCode ?? '',
      subjectName: subject?.name ?? '',
      category: subject?.category ?? 'OTHER',
      offeringType: d.offeringType,
      boardSubjectDefinitionId: d.boardSubjectDefinitionId ?? null,
      boardSubjectCode: definition?.boardSubjectCode ?? null,
      boardSubjectName: definition?.boardSubjectName ?? null,
      status: d.status,
    };
  });
}

export async function listSubjectOfferings(ctx: ServiceContext, classOfferingId: string): Promise<SubjectOfferingDTO[]> {
  await getClassOfferingOrThrow(ctx, classOfferingId);
  return listSubjectOfferingsFor(ctx, classOfferingId);
}

export async function listSubjectOfferingsFor(ctx: ServiceContext, classOfferingId: string): Promise<SubjectOfferingDTO[]> {
  const docs = await SubjectOffering.find({ tenantId: ctx.tenantId, classOfferingId }).lean<SubjectOfferingDoc[]>();
  const dtos = await toSubjectOfferingDTOs(ctx, docs);
  return dtos.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
}

/** subjectId → the definition on the rule version this location pinned (so offerings pick up board codes by themselves). */
async function boardDefinitionsFor(ctx: ServiceContext, session: AcademicSessionDoc, locationId: string, subjectIds: string[], db: ClientSession) {
  const ruleVersionId = pinnedRuleVersionId(session, locationId);
  if (!ruleVersionId || subjectIds.length === 0) return new Map<string, string>();
  const rows = await BoardSubjectDefinition.find({ tenantId: ctx.tenantId, boardRuleVersionId: ruleVersionId, subjectId: { $in: subjectIds } })
    .session(db)
    .lean<BoardSubjectDefinitionDoc[]>();
  return new Map(rows.map((r) => [r.subjectId, r._id]));
}

async function insertSubjectOfferings(
  ctx: ServiceContext,
  db: ClientSession,
  target: ClassOfferingDoc,
  session: AcademicSessionDoc,
  items: { subjectId: string; offeringType: SubjectOfferingDoc['offeringType'] }[],
  auditMetadata: Record<string, unknown> = {},
): Promise<SubjectOfferingDoc[]> {
  const definitions = await boardDefinitionsFor(ctx, session, target.locationId, items.map((i) => i.subjectId), db);
  const created: SubjectOfferingDoc[] = [];
  for (const item of items) {
    const [doc] = await SubjectOffering.create(
      [
        {
          tenantId: ctx.tenantId,
          classOfferingId: target._id,
          sessionId: target.sessionId,
          locationId: target.locationId,
          subjectId: item.subjectId,
          offeringType: item.offeringType,
          boardSubjectDefinitionId: definitions.get(item.subjectId) ?? null,
          status: 'ACTIVE',
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    const offering = doc!.toObject() as SubjectOfferingDoc;
    created.push(offering);
    await recordAcademicAudit(ctx, db, {
      entityType: 'subject_offering',
      entityId: offering._id,
      action: 'subject_offering.created',
      changes: [{ field: 'subjectId', from: null, to: offering.subjectId }, ...diffFields({}, offering, SUBJECT_OFFERING_EDITABLE_FIELDS)],
      academicSessionId: target.sessionId,
      metadata: { classOfferingId: target._id, locationId: target.locationId, ...auditMetadata },
    });
  }
  return created;
}

function alreadyOffered(names: string[]) {
  return new AppError('SUBJECT_ALREADY_OFFERED', `Already offered for this class: ${names.join(', ')}.`, { fields: { subjectIds: `Already offered: ${names.join(', ')}.` } });
}

export async function createSubjectOfferings(ctx: ServiceContext, classOfferingId: string, data: CreateSubjectOfferingsData): Promise<SubjectOfferingDTO[]> {
  const subjectIds = [...new Set(data.subjectIds)];
  return withTransaction(async (db) => {
    const { offering, session } = await getClassOfferingOrThrow(ctx, classOfferingId, db);
    await assertEditable(session, {}, db);

    const subjects = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: subjectIds } }).session(db).lean<SubjectDoc[]>();
    if (subjects.length !== subjectIds.length) throw AppError.notFound('One or more subjects were not found.');
    const inactive = subjects.filter((s) => s.status !== 'ACTIVE');
    if (inactive.length > 0) {
      throw new AppError('SUBJECT_INACTIVE', `Inactive subjects cannot be offered: ${inactive.map((s) => s.name).join(', ')}.`, {
        fields: { subjectIds: `Inactive: ${inactive.map((s) => s.name).join(', ')}.` },
      });
    }
    const existing = await SubjectOffering.find({ tenantId: ctx.tenantId, classOfferingId, subjectId: { $in: subjectIds } }).select('subjectId').session(db).lean<{ subjectId: string }[]>();
    if (existing.length > 0) throw alreadyOffered(subjects.filter((s) => existing.some((e) => e.subjectId === s._id)).map((s) => s.name));

    const created = await insertSubjectOfferings(ctx, db, offering, session, subjectIds.map((subjectId) => ({ subjectId, offeringType: data.offeringType })));
    return toSubjectOfferingDTOs(ctx, created, db);
  }).catch(onDuplicate('subjectId', () => alreadyOffered([])));
}

/** Copies a subject list from another class of the SAME session, only when the admin asks for it. */
export async function copySubjectOfferings(
  ctx: ServiceContext,
  classOfferingId: string,
  sourceClassOfferingId: string,
): Promise<{ created: SubjectOfferingDTO[]; skipped: number }> {
  if (classOfferingId === sourceClassOfferingId) throw AppError.validation({ sourceClassOfferingId: 'Choose a different class to copy from.' });
  return withTransaction(async (db) => {
    const { offering: target, session } = await getClassOfferingOrThrow(ctx, classOfferingId, db);
    const { offering: source } = await getClassOfferingOrThrow(ctx, sourceClassOfferingId, db);
    if (source.sessionId !== target.sessionId) throw AppError.validation({ sourceClassOfferingId: 'Choose a class from the same session.' });
    await assertEditable(session, {}, db);

    const [sourceOfferings, present] = await Promise.all([
      SubjectOffering.find({ tenantId: ctx.tenantId, classOfferingId: sourceClassOfferingId, status: 'ACTIVE' }).session(db).lean<SubjectOfferingDoc[]>(),
      SubjectOffering.find({ tenantId: ctx.tenantId, classOfferingId }).select('subjectId').session(db).lean<{ subjectId: string }[]>(),
    ]);
    const activeSubjects = new Set(
      (await Subject.find({ tenantId: ctx.tenantId, _id: { $in: sourceOfferings.map((o) => o.subjectId) }, status: 'ACTIVE' }).select('_id').session(db).lean<{ _id: string }[]>()).map((s) => s._id),
    );
    const have = new Set(present.map((p) => p.subjectId));
    const items = sourceOfferings.filter((o) => activeSubjects.has(o.subjectId) && !have.has(o.subjectId)).map((o) => ({ subjectId: o.subjectId, offeringType: o.offeringType }));

    const created = await insertSubjectOfferings(ctx, db, target, session, items, { copiedFromClassOfferingId: sourceClassOfferingId });
    return { created: await toSubjectOfferingDTOs(ctx, created, db), skipped: sourceOfferings.length - items.length };
  });
}

export async function updateSubjectOffering(ctx: ServiceContext, subjectOfferingId: string, patch: UpdateSubjectOfferingData): Promise<SubjectOfferingDTO> {
  return withTransaction(async (db) => {
    const { offering: before, session } = await getSubjectOfferingOrThrow(ctx, subjectOfferingId, db);
    const deactivating = patch.status === 'INACTIVE' && before.status === 'ACTIVE';
    await assertEditable(session, deactivating ? { structural: { entityType: 'subject_offering', entityId: subjectOfferingId } } : {}, db);

    if (patch.boardSubjectDefinitionId) {
      // The mapping must be this subject's code on the rule version the session pinned for this location.
      const definition = await BoardSubjectDefinition.findOne({ _id: patch.boardSubjectDefinitionId, tenantId: ctx.tenantId }).session(db).lean<BoardSubjectDefinitionDoc>();
      if (!definition || definition.subjectId !== before.subjectId || definition.boardRuleVersionId !== pinnedRuleVersionId(session, before.locationId)) {
        throw new AppError('BOARD_MAPPING_INVALID', undefined, { fields: { boardSubjectDefinitionId: "Choose a code from this location's board rule version." } });
      }
    }

    const merged = { ...before, ...pickDefined(patch) } as SubjectOfferingDoc;
    const changes = diffFields(before, merged, SUBJECT_OFFERING_EDITABLE_FIELDS);
    if (changes.length > 0) {
      await SubjectOffering.updateOne({ _id: subjectOfferingId, tenantId: ctx.tenantId }, { $set: changedValues(merged, changes, ctx.userId) }, { session: db });
      await recordAcademicAudit(ctx, db, {
        entityType: 'subject_offering',
        entityId: subjectOfferingId,
        action: 'subject_offering.updated',
        changes,
        academicSessionId: before.sessionId,
        metadata: { classOfferingId: before.classOfferingId, subjectId: before.subjectId, status: session.status },
      });
    }
    return (await toSubjectOfferingDTOs(ctx, [merged], db))[0]!;
  });
}

export async function deleteSubjectOffering(ctx: ServiceContext, subjectOfferingId: string): Promise<void> {
  await withTransaction(async (db) => {
    const { offering: before, session } = await getSubjectOfferingOrThrow(ctx, subjectOfferingId, db);
    assertDeletable(session);
    await removeRulesForSubjectOfferings(ctx.tenantId, [subjectOfferingId], db);
    await runOfferingCleanup(ctx.tenantId, { subjectOfferingIds: [subjectOfferingId] }, db);
    await SubjectOffering.deleteOne({ _id: subjectOfferingId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'subject_offering',
      entityId: subjectOfferingId,
      action: 'subject_offering.deleted',
      changes: diffFields(before, {}, ['subjectId', 'offeringType', 'status']),
      academicSessionId: before.sessionId,
      metadata: { classOfferingId: before.classOfferingId },
    });
  });
}
