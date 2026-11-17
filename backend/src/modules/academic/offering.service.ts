import type { ClientSession } from 'mongoose';
import {
  GRADE_OFFERING_EDITABLE_FIELDS,
  SECTION_EDITABLE_FIELDS,
  SUBJECT_OFFERING_EDITABLE_FIELDS,
  type CreateGradeOfferingsData,
  type CreateSectionsData,
  type CreateSubjectOfferingsData,
  type GradeOfferingDTO,
  type SectionOfferingDTO,
  type SubjectOfferingDTO,
  type UpdateGradeOfferingData,
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
import { removeRulesForGradeOffering, removeRulesForSubjectOfferings } from './cleanup';
import { assertDeletable, assertEditable } from './guard';
import {
  GradeOffering,
  SectionOffering,
  SubjectOffering,
  type GradeOfferingDoc,
  type SectionOfferingDoc,
  type SubjectOfferingDoc,
} from './offering.model';
import { GradeMaster, type GradeMasterDoc } from './reference.model';
import { getGradesByIds } from './reference.service';
import { getSessionOrThrow } from './session.service';
import type { AcademicSessionDoc } from './session.model';
import { BoardSubjectDefinition, Subject, type BoardSubjectDefinitionDoc, type SubjectDoc } from './subject.model';

/** AS-03 / AS-04 / AS-07 — grade offerings, sections and subject offerings. */

// ───────────────────────────────────────────────────────────── loading helpers (visibility + tenant isolation)

/** A grade offering plus its session. Offerings of a session the caller can't see are 404s. */
export async function getGradeOfferingOrThrow(ctx: ServiceContext, gradeOfferingId: string, db?: ClientSession) {
  const offering = await GradeOffering.findOne({ _id: gradeOfferingId, tenantId: ctx.tenantId }).session(db ?? null).lean<GradeOfferingDoc>();
  if (!offering) throw AppError.notFound('Grade not found.');
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

// ───────────────────────────────────────────────────────────── grade offerings

function toGradeOfferingDTO(doc: GradeOfferingDoc, grade: GradeMasterDoc | undefined, counts: { sections: number; subjects: number }): GradeOfferingDTO {
  return {
    gradeOfferingId: doc._id,
    academicSessionId: doc.sessionId,
    locationId: doc.locationId,
    gradeId: doc.gradeId,
    canonicalCode: grade?.canonicalCode ?? '',
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

async function countBy(model: typeof SectionOffering | typeof SubjectOffering, tenantId: string, gradeOfferingIds: string[], db?: ClientSession) {
  const rows = await model
    .aggregate<{ _id: string; n: number }>([{ $match: { tenantId, gradeOfferingId: { $in: gradeOfferingIds } } }, { $group: { _id: '$gradeOfferingId', n: { $sum: 1 } } }])
    .session(db ?? null);
  return new Map(rows.map((r) => [r._id, r.n]));
}

export async function toGradeOfferingDTOs(ctx: ServiceContext, docs: GradeOfferingDoc[], db?: ClientSession): Promise<GradeOfferingDTO[]> {
  if (docs.length === 0) return [];
  const ids = docs.map((d) => d._id);
  const [grades, sections, subjects] = await Promise.all([
    GradeMaster.find({ _id: { $in: [...new Set(docs.map((d) => d.gradeId))] } }).session(db ?? null).lean<GradeMasterDoc[]>(),
    countBy(SectionOffering, ctx.tenantId, ids, db),
    countBy(SubjectOffering, ctx.tenantId, ids, db),
  ]);
  const gradeById = new Map(grades.map((g) => [g._id, g]));
  return docs.map((d) => toGradeOfferingDTO(d, gradeById.get(d.gradeId), { sections: sections.get(d._id) ?? 0, subjects: subjects.get(d._id) ?? 0 }));
}

export async function getGradeOfferingDTO(ctx: ServiceContext, gradeOfferingId: string, db?: ClientSession) {
  const { offering } = await getGradeOfferingOrThrow(ctx, gradeOfferingId, db);
  return (await toGradeOfferingDTOs(ctx, [offering], db))[0]!;
}

export async function listGradeOfferings(ctx: ServiceContext, academicSessionId: string, locationId?: string): Promise<GradeOfferingDTO[]> {
  await getSessionOrThrow(ctx, academicSessionId);
  const docs = await GradeOffering.find({ tenantId: ctx.tenantId, sessionId: academicSessionId, ...(locationId ? { locationId } : {}) })
    .sort({ locationId: 1, sequenceOrder: 1, _id: 1 })
    .lean<GradeOfferingDoc[]>();
  return toGradeOfferingDTOs(ctx, docs);
}

function exists(): never {
  throw new AppError('GRADE_OFFERING_EXISTS');
}

export async function createGradeOfferings(ctx: ServiceContext, academicSessionId: string, data: CreateGradeOfferingsData): Promise<GradeOfferingDTO[]> {
  const gradeIds = [...new Set(data.gradeIds)];
  return withTransaction(async (db) => {
    const session = await getSessionOrThrow(ctx, academicSessionId, db);
    await assertEditable(session, {}, db);
    if (!pinnedRuleVersionId(session, data.locationId)) throw new AppError('LOCATION_NOT_IN_SESSION', undefined, { locationId: data.locationId });

    const grades = await getGradesByIds(gradeIds, db);
    if (grades.length !== gradeIds.length) throw AppError.notFound('One or more grades were not found.');

    const already = await GradeOffering.find({ tenantId: ctx.tenantId, sessionId: academicSessionId, locationId: data.locationId, gradeId: { $in: gradeIds } })
      .select('gradeId')
      .session(db)
      .lean<{ gradeId: string }[]>();
    if (already.length > 0) {
      const names = grades.filter((g) => already.some((a) => a.gradeId === g._id)).map((g) => g.canonicalName);
      throw new AppError('GRADE_OFFERING_EXISTS', `Already set up for this location: ${names.join(', ')}.`, {
        gradeIds: already.map((a) => a.gradeId),
        fields: { gradeIds: `Already set up: ${names.join(', ')}.` },
      });
    }

    const ordered = [...grades].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
    const created: GradeOfferingDoc[] = [];
    for (const grade of ordered) {
      const [doc] = await GradeOffering.create(
        [
          {
            tenantId: ctx.tenantId,
            sessionId: academicSessionId,
            locationId: data.locationId,
            gradeId: grade._id,
            displayName: grade.canonicalName,
            displayCode: grade.shortCode,
            medium: data.medium ?? null,
            sequenceOrder: grade.sequenceNumber,
            status: 'ACTIVE',
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      const offering = doc!.toObject() as GradeOfferingDoc;
      created.push(offering);
      await recordAcademicAudit(ctx, db, {
        entityType: 'grade_offering',
        entityId: offering._id,
        action: 'grade_offering.created',
        changes: diffFields({}, offering, GRADE_OFFERING_EDITABLE_FIELDS),
        academicSessionId,
        metadata: { locationId: data.locationId, gradeId: grade._id, canonicalCode: grade.canonicalCode },
      });
    }
    return toGradeOfferingDTOs(ctx, created, db);
  }).catch(onDuplicate('gradeId', exists));
}

export async function updateGradeOffering(ctx: ServiceContext, gradeOfferingId: string, patch: UpdateGradeOfferingData): Promise<GradeOfferingDTO> {
  return withTransaction(async (db) => {
    const { offering: before, session } = await getGradeOfferingOrThrow(ctx, gradeOfferingId, db);
    const deactivating = patch.status === 'INACTIVE' && before.status === 'ACTIVE';
    await assertEditable(session, deactivating ? { structural: { entityType: 'grade_offering', entityId: gradeOfferingId } } : {}, db);

    const merged = { ...before, ...pickDefined(patch) } as GradeOfferingDoc;
    const changes = diffFields(before, merged, GRADE_OFFERING_EDITABLE_FIELDS);
    if (changes.length > 0) {
      await GradeOffering.updateOne({ _id: gradeOfferingId, tenantId: ctx.tenantId }, { $set: changedValues(merged, changes, ctx.userId) }, { session: db });
      await recordAcademicAudit(ctx, db, {
        entityType: 'grade_offering',
        entityId: gradeOfferingId,
        action: 'grade_offering.updated',
        changes,
        academicSessionId: before.sessionId,
        metadata: { locationId: before.locationId, status: session.status },
      });
    }
    return getGradeOfferingDTO(ctx, gradeOfferingId, db);
  });
}

/** Deletes a grade offering and what hangs under it: sections, subject offerings, choice groups, constraints and programme rules. */
export async function deleteGradeOfferingContents(tenantId: string, gradeOfferingId: string, db: ClientSession) {
  const offeringIds = (await SubjectOffering.find({ tenantId, gradeOfferingId }).select('_id').session(db).lean<{ _id: string }[]>()).map((o) => o._id);
  const rules = await removeRulesForGradeOffering(tenantId, gradeOfferingId, db);
  await removeRulesForSubjectOfferings(tenantId, offeringIds, db);
  const [sections, subjectOfferings] = await Promise.all([
    SectionOffering.deleteMany({ tenantId, gradeOfferingId }, { session: db }),
    SubjectOffering.deleteMany({ tenantId, gradeOfferingId }, { session: db }),
  ]);
  return { sections: sections.deletedCount, subjectOfferings: subjectOfferings.deletedCount, ...rules };
}

export async function deleteGradeOffering(ctx: ServiceContext, gradeOfferingId: string): Promise<void> {
  await withTransaction(async (db) => {
    const { offering: before, session } = await getGradeOfferingOrThrow(ctx, gradeOfferingId, db);
    assertDeletable(session);
    const removed = await deleteGradeOfferingContents(ctx.tenantId, gradeOfferingId, db);
    await GradeOffering.deleteOne({ _id: gradeOfferingId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'grade_offering',
      entityId: gradeOfferingId,
      action: 'grade_offering.deleted',
      changes: diffFields(before, {}, ['displayName', 'displayCode', 'status']),
      academicSessionId: before.sessionId,
      metadata: { locationId: before.locationId, gradeId: before.gradeId, removed },
    });
  });
}

// ───────────────────────────────────────────────────────────── sections

function toSectionDTO(doc: SectionOfferingDoc): SectionOfferingDTO {
  return {
    sectionOfferingId: doc._id,
    gradeOfferingId: doc.gradeOfferingId,
    academicSessionId: doc.sessionId,
    locationId: doc.locationId,
    sectionCode: doc.sectionCode,
    displayName: doc.displayName,
    capacity: doc.capacity ?? null,
    sequenceOrder: doc.sequenceOrder,
    status: doc.status,
  };
}

export async function listSections(ctx: ServiceContext, gradeOfferingId: string): Promise<SectionOfferingDTO[]> {
  await getGradeOfferingOrThrow(ctx, gradeOfferingId);
  return listSectionsFor(ctx, gradeOfferingId);
}

/** Same as `listSections` for a grade offering the caller has already been allowed to see. */
export async function listSectionsFor(ctx: ServiceContext, gradeOfferingId: string): Promise<SectionOfferingDTO[]> {
  const docs = await SectionOffering.find({ tenantId: ctx.tenantId, gradeOfferingId }).sort({ sequenceOrder: 1, sectionCode: 1 }).lean<SectionOfferingDoc[]>();
  return docs.map(toSectionDTO);
}

function sectionCodeTaken(codes: string[]) {
  return new AppError('SECTION_CODE_TAKEN', `Section ${codes.join(', ')} already exists for this grade.`, {
    codes,
    fields: { codes: `Already exists: ${codes.join(', ')}.` },
  });
}

export async function createSections(ctx: ServiceContext, gradeOfferingId: string, data: CreateSectionsData): Promise<SectionOfferingDTO[]> {
  const repeated = data.codes.filter((c, i) => data.codes.indexOf(c) !== i);
  if (repeated.length > 0) throw sectionCodeTaken([...new Set(repeated)]);

  return withTransaction(async (db) => {
    const { offering, session } = await getGradeOfferingOrThrow(ctx, gradeOfferingId, db);
    await assertEditable(session, {}, db);

    const existing = await SectionOffering.find({ tenantId: ctx.tenantId, gradeOfferingId }).select('sectionCode sequenceOrder').session(db).lean<SectionOfferingDoc[]>();
    const taken = data.codes.filter((c) => existing.some((e) => e.sectionCode === c));
    if (taken.length > 0) throw sectionCodeTaken(taken);

    let order = existing.reduce((max, e) => Math.max(max, e.sequenceOrder), 0);
    const created: SectionOfferingDoc[] = [];
    for (const code of data.codes) {
      order += 1;
      const [doc] = await SectionOffering.create(
        [
          {
            tenantId: ctx.tenantId,
            gradeOfferingId,
            sessionId: offering.sessionId,
            locationId: offering.locationId,
            sectionCode: code,
            displayName: code,
            capacity: data.capacity ?? null,
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
        metadata: { gradeOfferingId, locationId: offering.locationId },
      });
    }
    return created.map(toSectionDTO);
  }).catch(onDuplicate('sectionCode', () => sectionCodeTaken(data.codes)));
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
        metadata: { gradeOfferingId: before.gradeOfferingId, sectionCode: before.sectionCode, status: session.status },
      });
    }
    return toSectionDTO({ ...merged, updatedBy: ctx.userId });
  });
}

export async function deleteSection(ctx: ServiceContext, sectionId: string): Promise<void> {
  await withTransaction(async (db) => {
    const { section: before, session } = await getSectionOrThrow(ctx, sectionId, db);
    assertDeletable(session);
    await SectionOffering.deleteOne({ _id: sectionId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'section_offering',
      entityId: sectionId,
      action: 'section.deleted',
      changes: diffFields(before, {}, ['sectionCode', 'displayName', 'status']),
      academicSessionId: before.sessionId,
      metadata: { gradeOfferingId: before.gradeOfferingId },
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
      gradeOfferingId: d.gradeOfferingId,
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

export async function listSubjectOfferings(ctx: ServiceContext, gradeOfferingId: string): Promise<SubjectOfferingDTO[]> {
  await getGradeOfferingOrThrow(ctx, gradeOfferingId);
  return listSubjectOfferingsFor(ctx, gradeOfferingId);
}

export async function listSubjectOfferingsFor(ctx: ServiceContext, gradeOfferingId: string): Promise<SubjectOfferingDTO[]> {
  const docs = await SubjectOffering.find({ tenantId: ctx.tenantId, gradeOfferingId }).lean<SubjectOfferingDoc[]>();
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
  target: GradeOfferingDoc,
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
          gradeOfferingId: target._id,
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
      metadata: { gradeOfferingId: target._id, locationId: target.locationId, ...auditMetadata },
    });
  }
  return created;
}

function alreadyOffered(names: string[]) {
  return new AppError('SUBJECT_ALREADY_OFFERED', `Already offered for this grade: ${names.join(', ')}.`, { fields: { subjectIds: `Already offered: ${names.join(', ')}.` } });
}

export async function createSubjectOfferings(ctx: ServiceContext, gradeOfferingId: string, data: CreateSubjectOfferingsData): Promise<SubjectOfferingDTO[]> {
  const subjectIds = [...new Set(data.subjectIds)];
  return withTransaction(async (db) => {
    const { offering, session } = await getGradeOfferingOrThrow(ctx, gradeOfferingId, db);
    await assertEditable(session, {}, db);

    const subjects = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: subjectIds } }).session(db).lean<SubjectDoc[]>();
    if (subjects.length !== subjectIds.length) throw AppError.notFound('One or more subjects were not found.');
    const inactive = subjects.filter((s) => s.status !== 'ACTIVE');
    if (inactive.length > 0) {
      throw new AppError('SUBJECT_INACTIVE', `Inactive subjects cannot be offered: ${inactive.map((s) => s.name).join(', ')}.`, {
        fields: { subjectIds: `Inactive: ${inactive.map((s) => s.name).join(', ')}.` },
      });
    }
    const existing = await SubjectOffering.find({ tenantId: ctx.tenantId, gradeOfferingId, subjectId: { $in: subjectIds } }).select('subjectId').session(db).lean<{ subjectId: string }[]>();
    if (existing.length > 0) throw alreadyOffered(subjects.filter((s) => existing.some((e) => e.subjectId === s._id)).map((s) => s.name));

    const created = await insertSubjectOfferings(ctx, db, offering, session, subjectIds.map((subjectId) => ({ subjectId, offeringType: data.offeringType })));
    return toSubjectOfferingDTOs(ctx, created, db);
  }).catch(onDuplicate('subjectId', () => alreadyOffered([])));
}

/** Copies a subject list from another grade of the SAME session, only when the admin asks for it. */
export async function copySubjectOfferings(
  ctx: ServiceContext,
  gradeOfferingId: string,
  sourceGradeOfferingId: string,
): Promise<{ created: SubjectOfferingDTO[]; skipped: number }> {
  if (gradeOfferingId === sourceGradeOfferingId) throw AppError.validation({ sourceGradeOfferingId: 'Choose a different grade to copy from.' });
  return withTransaction(async (db) => {
    const { offering: target, session } = await getGradeOfferingOrThrow(ctx, gradeOfferingId, db);
    const { offering: source } = await getGradeOfferingOrThrow(ctx, sourceGradeOfferingId, db);
    if (source.sessionId !== target.sessionId) throw AppError.validation({ sourceGradeOfferingId: 'Choose a grade from the same session.' });
    await assertEditable(session, {}, db);

    const [sourceOfferings, present] = await Promise.all([
      SubjectOffering.find({ tenantId: ctx.tenantId, gradeOfferingId: sourceGradeOfferingId, status: 'ACTIVE' }).session(db).lean<SubjectOfferingDoc[]>(),
      SubjectOffering.find({ tenantId: ctx.tenantId, gradeOfferingId }).select('subjectId').session(db).lean<{ subjectId: string }[]>(),
    ]);
    const activeSubjects = new Set(
      (await Subject.find({ tenantId: ctx.tenantId, _id: { $in: sourceOfferings.map((o) => o.subjectId) }, status: 'ACTIVE' }).select('_id').session(db).lean<{ _id: string }[]>()).map((s) => s._id),
    );
    const have = new Set(present.map((p) => p.subjectId));
    const items = sourceOfferings.filter((o) => activeSubjects.has(o.subjectId) && !have.has(o.subjectId)).map((o) => ({ subjectId: o.subjectId, offeringType: o.offeringType }));

    const created = await insertSubjectOfferings(ctx, db, target, session, items, { copiedFromGradeOfferingId: sourceGradeOfferingId });
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
        metadata: { gradeOfferingId: before.gradeOfferingId, subjectId: before.subjectId, status: session.status },
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
    await SubjectOffering.deleteOne({ _id: subjectOfferingId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'subject_offering',
      entityId: subjectOfferingId,
      action: 'subject_offering.deleted',
      changes: diffFields(before, {}, ['subjectId', 'offeringType', 'status']),
      academicSessionId: before.sessionId,
      metadata: { gradeOfferingId: before.gradeOfferingId },
    });
  });
}
