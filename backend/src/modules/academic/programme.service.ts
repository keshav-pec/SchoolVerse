import type { ClientSession } from 'mongoose';
import {
  PROGRAMME_EDITABLE_FIELDS,
  type CreateProgrammeData,
  type ProgrammeDTO,
  type UpdateProgrammeData,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { onDuplicate } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields, changedValues } from '../audit/diff';
import { recordAcademicAudit } from './audit';
import { assertDeletable, assertEditable } from './guard';
import { GradeOffering, SubjectOffering, type GradeOfferingDoc, type SubjectOfferingDoc } from './offering.model';
import { GradeMaster, type GradeMasterDoc } from './reference.model';
import { getBoardOrThrow } from './reference.service';
import { AcademicProgramme, type AcademicProgrammeDoc, type ProgrammeSubjectRule } from './rules.model';
import type { AcademicSessionDoc } from './session.model';
import { getSessionOrThrow } from './session.service';
import { Subject, type SubjectDoc } from './subject.model';

/** AS-10 / AS-11 — programmes (streams) and flexible combinations. Student-level selection is out of scope. */

// ───────────────────────────────────────────────────────────── mapping

export async function toProgrammeDTOs(ctx: ServiceContext, docs: AcademicProgrammeDoc[], db?: ClientSession): Promise<ProgrammeDTO[]> {
  const offeringIds = [...new Set(docs.flatMap((d) => d.subjectRules.map((r) => r.subjectOfferingId)))];
  const offerings = offeringIds.length
    ? await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: offeringIds } }).session(db ?? null).lean<SubjectOfferingDoc[]>()
    : [];
  const subjects = offerings.length
    ? await Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(offerings.map((o) => o.subjectId))] } }).session(db ?? null).lean<SubjectDoc[]>()
    : [];
  const offeringById = new Map(offerings.map((o) => [o._id, o]));
  const subjectById = new Map(subjects.map((s) => [s._id, s]));

  return docs.map((d) => ({
    programmeId: d._id,
    academicSessionId: d.sessionId,
    locationId: d.locationId,
    name: d.name,
    code: d.code,
    kind: d.kind,
    gradeFromId: d.gradeFromId,
    gradeToId: d.gradeToId,
    boardId: d.boardId ?? null,
    subjectRules: d.subjectRules.map((r) => {
      const offering = offeringById.get(r.subjectOfferingId);
      const subject = offering ? subjectById.get(offering.subjectId) : undefined;
      return {
        subjectOfferingId: r.subjectOfferingId,
        subjectId: offering?.subjectId ?? '',
        subjectCode: subject?.subjectCode ?? '',
        subjectName: subject?.name ?? '',
        requirement: r.requirement,
        status: offering?.status ?? ('INACTIVE' as const),
      };
    }),
    choiceMin: d.choiceMin ?? null,
    choiceMax: d.choiceMax ?? null,
    status: d.status,
  }));
}

// ───────────────────────────────────────────────────────────── rules

interface ProgrammeShape {
  kind: AcademicProgrammeDoc['kind'];
  gradeFromId: string;
  gradeToId: string;
  boardId: string | null;
  subjectRules: ProgrammeSubjectRule[];
  choiceMin: number | null;
  choiceMax: number | null;
}

/**
 * Checks a programme against its session and returns the normalised choice bounds.
 * Subjects must be offerings at the programme's session + location and inside its grade range.
 */
async function checkProgramme(
  ctx: ServiceContext,
  session: AcademicSessionDoc,
  locationId: string,
  shape: ProgrammeShape,
  db: ClientSession,
): Promise<{ choiceMin: number | null; choiceMax: number | null }> {
  if (!session.locations.some((l) => l.locationId === locationId)) throw new AppError('LOCATION_NOT_IN_SESSION', undefined, { locationId });

  const grades = await GradeMaster.find({ _id: { $in: [shape.gradeFromId, shape.gradeToId] } }).session(db).lean<GradeMasterDoc[]>();
  const from = grades.find((g) => g._id === shape.gradeFromId);
  const to = grades.find((g) => g._id === shape.gradeToId);
  if (!from || !to) throw AppError.notFound('Grade not found.');
  if (from.sequenceNumber > to.sequenceNumber) throw AppError.validation({ gradeToId: 'The last grade cannot come before the first grade.' });
  if (shape.boardId) await getBoardOrThrow(ctx.tenantId, shape.boardId, db);

  if (shape.kind === 'FLEXIBLE') {
    if (shape.subjectRules.length > 0) {
      throw AppError.validation({ subjectRules: 'A flexible combination has no fixed subject list. Use the grade’s choice groups and rules.' });
    }
    return { choiceMin: null, choiceMax: null };
  }

  const ids = shape.subjectRules.map((r) => r.subjectOfferingId);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated) throw AppError.validation({ subjectRules: 'Each subject can be listed only once.' });

  if (ids.length > 0) {
    const offerings = await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: ids }, sessionId: session._id, locationId }).session(db).lean<SubjectOfferingDoc[]>();
    const gradeOfferings = await GradeOffering.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(offerings.map((o) => o.gradeOfferingId))] } })
      .session(db)
      .lean<GradeOfferingDoc[]>();
    const masterGrades = await GradeMaster.find({ _id: { $in: [...new Set(gradeOfferings.map((g) => g.gradeId))] } }).session(db).lean<GradeMasterDoc[]>();
    const sequenceOf = (offering: SubjectOfferingDoc) => {
      const go = gradeOfferings.find((g) => g._id === offering.gradeOfferingId);
      return masterGrades.find((m) => m._id === go?.gradeId)?.sequenceNumber;
    };
    for (const [i, id] of ids.entries()) {
      const offering = offerings.find((o) => o._id === id);
      if (!offering) throw AppError.validation({ [`subjectRules.${i}.subjectOfferingId`]: 'Choose a subject offered at this location in this session.' });
      const sequence = sequenceOf(offering);
      if (sequence === undefined || sequence < from.sequenceNumber || sequence > to.sequenceNumber) {
        throw AppError.validation({ [`subjectRules.${i}.subjectOfferingId`]: 'This subject belongs to a grade outside the programme’s grade range.' });
      }
    }
  }

  const choiceCount = shape.subjectRules.filter((r) => r.requirement === 'CHOICE').length;
  if (choiceCount === 0) return { choiceMin: null, choiceMax: null };
  const choiceMin = shape.choiceMin ?? 1;
  const choiceMax = shape.choiceMax ?? choiceMin;
  if (choiceMin > choiceMax) throw AppError.validation({ choiceMax: 'The maximum cannot be lower than the minimum.' });
  if (choiceMax > choiceCount) throw AppError.validation({ choiceMax: `Only ${choiceCount} subject${choiceCount === 1 ? ' is' : 's are'} marked as a choice.` });
  return { choiceMin, choiceMax };
}

function codeTaken() {
  return new AppError('PROGRAMME_CODE_TAKEN', undefined, { fields: { code: 'This programme code is already used at this location in this session.' } });
}

// ───────────────────────────────────────────────────────────── CRUD

export async function listProgrammes(ctx: ServiceContext, academicSessionId: string, locationId?: string): Promise<ProgrammeDTO[]> {
  await getSessionOrThrow(ctx, academicSessionId);
  const docs = await AcademicProgramme.find({ tenantId: ctx.tenantId, sessionId: academicSessionId, ...(locationId ? { locationId } : {}) })
    .sort({ locationId: 1, code: 1 })
    .lean<AcademicProgrammeDoc[]>();
  return toProgrammeDTOs(ctx, docs);
}

async function getProgrammeOrThrow(ctx: ServiceContext, programmeId: string, db?: ClientSession) {
  const programme = await AcademicProgramme.findOne({ _id: programmeId, tenantId: ctx.tenantId }).session(db ?? null).lean<AcademicProgrammeDoc>();
  if (!programme) throw AppError.notFound('Programme not found.');
  const session = await getSessionOrThrow(ctx, programme.sessionId, db);
  return { programme, session };
}

export async function getProgrammeDTO(ctx: ServiceContext, programmeId: string): Promise<ProgrammeDTO> {
  const { programme } = await getProgrammeOrThrow(ctx, programmeId);
  return (await toProgrammeDTOs(ctx, [programme]))[0]!;
}

export async function createProgramme(ctx: ServiceContext, data: CreateProgrammeData): Promise<ProgrammeDTO> {
  return withTransaction(async (db) => {
    const session = await getSessionOrThrow(ctx, data.academicSessionId, db);
    await assertEditable(session, {}, db);
    const shape: ProgrammeShape = {
      kind: data.kind,
      gradeFromId: data.gradeFromId,
      gradeToId: data.gradeToId,
      boardId: data.boardId ?? null,
      subjectRules: data.subjectRules,
      choiceMin: data.choiceMin ?? null,
      choiceMax: data.choiceMax ?? null,
    };
    const bounds = await checkProgramme(ctx, session, data.locationId, shape, db);

    const [created] = await AcademicProgramme.create(
      [
        {
          ...shape,
          ...bounds,
          tenantId: ctx.tenantId,
          sessionId: session._id,
          locationId: data.locationId,
          name: data.name,
          code: data.code,
          status: 'ACTIVE',
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    const programme = created!.toObject() as AcademicProgrammeDoc;
    await recordAcademicAudit(ctx, db, {
      entityType: 'academic_programme',
      entityId: programme._id,
      action: 'programme.created',
      changes: [{ field: 'code', from: null, to: programme.code }, ...diffFields({}, programme, PROGRAMME_EDITABLE_FIELDS)],
      academicSessionId: session._id,
      metadata: { locationId: data.locationId },
    });
    return (await toProgrammeDTOs(ctx, [programme], db))[0]!;
  }).catch(onDuplicate('code', codeTaken));
}

export async function updateProgramme(ctx: ServiceContext, programmeId: string, patch: UpdateProgrammeData): Promise<ProgrammeDTO> {
  return withTransaction(async (db) => {
    const { programme: before, session } = await getProgrammeOrThrow(ctx, programmeId, db);
    const updates = pickDefined(patch);
    const merged = { ...before, ...updates } as AcademicProgrammeDoc;

    const removesRules = before.subjectRules.some((r) => !merged.subjectRules.some((m) => m.subjectOfferingId === r.subjectOfferingId));
    const deactivating = updates.status === 'INACTIVE' && before.status === 'ACTIVE';
    await assertEditable(session, removesRules || deactivating ? { structural: { entityType: 'programme', entityId: programmeId } } : {}, db);

    const bounds = await checkProgramme(
      ctx,
      session,
      before.locationId,
      { kind: merged.kind, gradeFromId: merged.gradeFromId, gradeToId: merged.gradeToId, boardId: merged.boardId ?? null, subjectRules: merged.subjectRules, choiceMin: merged.choiceMin, choiceMax: merged.choiceMax },
      db,
    );
    merged.choiceMin = bounds.choiceMin;
    merged.choiceMax = bounds.choiceMax;

    const changes = diffFields(before, merged, PROGRAMME_EDITABLE_FIELDS);
    if (changes.length > 0) {
      await AcademicProgramme.updateOne({ _id: programmeId, tenantId: ctx.tenantId }, { $set: changedValues(merged, changes, ctx.userId) }, { session: db });
      await recordAcademicAudit(ctx, db, {
        entityType: 'academic_programme',
        entityId: programmeId,
        action: 'programme.updated',
        changes,
        academicSessionId: before.sessionId,
        metadata: { locationId: before.locationId, code: before.code, status: session.status },
      });
    }
    return (await toProgrammeDTOs(ctx, [merged], db))[0]!;
  });
}

export async function deleteProgramme(ctx: ServiceContext, programmeId: string): Promise<void> {
  await withTransaction(async (db) => {
    const { programme: before, session } = await getProgrammeOrThrow(ctx, programmeId, db);
    assertDeletable(session);
    await AcademicProgramme.deleteOne({ _id: programmeId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'academic_programme',
      entityId: programmeId,
      action: 'programme.deleted',
      changes: diffFields(before, {}, ['name', 'code', 'kind', 'status']),
      academicSessionId: before.sessionId,
      metadata: { locationId: before.locationId },
    });
  });
}
