import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { SESSION_EDITABLE_FIELDS, type AcademicSessionDTO, type CloneSessionData } from '@shared';
import { addDays, daysBetween } from '../../core/dates';
import { AppError } from '../../core/errors';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { recordAcademicAudit } from './audit';
import { ClassOffering, SectionOffering, SubjectOffering, type ClassOfferingDoc, type SectionOfferingDoc, type SubjectOfferingDoc } from './offering.model';
import { AcademicProgramme, SubjectChoiceConstraint, SubjectChoiceGroup, type AcademicProgrammeDoc, type SubjectChoiceConstraintDoc, type SubjectChoiceGroupDoc } from './rules.model';
import { AcademicSession, AcademicTerm, type AcademicSessionDoc, type AcademicTermDoc } from './session.model';
import { assertDates, getSessionDTO, getSessionOrThrow } from './session.service';
import { Subject } from './subject.model';
import { normaliseRule } from './rules.service';

/**
 * AS-13 — clone / roll forward. Copies PLANNING data only: locations + board mapping, classes, sections, subject offerings,
 * choice groups, constraints, programmes and terms (dates shift with the new start date). Only ACTIVE rows are carried over.
 * Students, faculty, attendance, marks and fees are never touched: this code copies exactly the collections below.
 */
export async function cloneSession(ctx: ServiceContext, sourceId: string, data: CloneSessionData): Promise<AcademicSessionDTO> {
  assertDates(data.startDate, data.endDate);
  try {
    return await withTransaction(async (db) => {
      const source = await getSessionOrThrow(ctx, sourceId, db);
      const created = await copyInto(ctx, source, data, db);
      return getSessionDTO(ctx, created, db);
    });
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('code')) {
      throw new AppError('SESSION_CODE_TAKEN', undefined, { fields: { code: 'This session code is already in use.' } });
    }
    throw err;
  }
}

async function copyInto(ctx: ServiceContext, source: AcademicSessionDoc, data: CloneSessionData, db: ClientSession): Promise<string> {
  const tenantId = ctx.tenantId;
  const scope = { tenantId, sessionId: source._id, status: 'ACTIVE' as const };
  const s = { session: db };
  const base = { tenantId, createdBy: ctx.userId, updatedBy: ctx.userId };

  const newId = randomUUID();
  const [doc] = await AcademicSession.create(
    [
      {
        _id: newId,
        tenantId,
        schoolId: source.schoolId,
        name: data.name,
        code: data.code,
        startDate: data.startDate,
        endDate: data.endDate,
        status: 'DRAFT',
        locations: source.locations.map((l) => ({ ...l })),
        previousSessionId: source._id,
        statusChangedAt: new Date(),
        statusChangedBy: ctx.userId,
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      },
    ],
    s,
  );

  // Classes → sections → subject offerings, remapping every id.
  const classes = await ClassOffering.find(scope).session(db).lean<ClassOfferingDoc[]>();
  const classMap = new Map(classes.map((g) => [g._id, randomUUID()]));
  await ClassOffering.insertMany(
    classes.map((g) => ({
      ...base,
      _id: classMap.get(g._id),
      sessionId: newId,
      locationId: g.locationId,
      classId: g.classId,
      displayName: g.displayName,
      displayCode: g.displayCode,
      medium: g.medium,
      capacity: g.capacity,
      sequenceOrder: g.sequenceOrder,
      status: 'ACTIVE',
    })),
    s,
  );

  const sections = (await SectionOffering.find(scope).session(db).lean<SectionOfferingDoc[]>()).filter((x) => classMap.has(x.classOfferingId));
  await SectionOffering.insertMany(
    sections.map((x) => ({
      ...base,
      _id: randomUUID(),
      classOfferingId: classMap.get(x.classOfferingId),
      sessionId: newId,
      locationId: x.locationId,
      sectionCode: x.sectionCode,
      displayName: x.displayName,
      capacity: x.capacity,
      sequenceOrder: x.sequenceOrder,
      status: 'ACTIVE',
    })),
    s,
  );

  const activeSubjects = new Set(
    (await Subject.find({ tenantId, status: 'ACTIVE' }).select('_id').session(db).lean<{ _id: string }[]>()).map((x) => x._id),
  );
  const offerings = (await SubjectOffering.find(scope).session(db).lean<SubjectOfferingDoc[]>()).filter((o) => classMap.has(o.classOfferingId) && activeSubjects.has(o.subjectId));
  const offeringMap = new Map(offerings.map((o) => [o._id, randomUUID()]));
  await SubjectOffering.insertMany(
    offerings.map((o) => ({
      ...base,
      _id: offeringMap.get(o._id),
      classOfferingId: classMap.get(o.classOfferingId),
      sessionId: newId,
      locationId: o.locationId,
      subjectId: o.subjectId,
      boardSubjectDefinitionId: o.boardSubjectDefinitionId,
      offeringType: o.offeringType,
      status: 'ACTIVE',
    })),
    s,
  );

  // Rules.
  const mapIds = (ids: string[]) => ids.flatMap((id) => offeringMap.get(id) ?? []);
  const groups = (await SubjectChoiceGroup.find(scope).session(db).lean<SubjectChoiceGroupDoc[]>())
    .filter((g) => classMap.has(g.classOfferingId))
    .map((g) => ({ g, items: mapIds(g.subjectOfferingIds) }))
    .filter(({ items }) => items.length > 0);
  await SubjectChoiceGroup.insertMany(
    groups.map(({ g, items }) => ({
      ...base,
      _id: randomUUID(),
      classOfferingId: classMap.get(g.classOfferingId),
      sessionId: newId,
      locationId: g.locationId,
      name: g.name,
      ruleType: g.ruleType,
      // "Take all" follows its (possibly shorter) item list; the other types keep their numbers.
      ...normaliseRule(g.ruleType, { min: g.min, max: g.max }, items.length),
      sequence: g.sequence,
      subjectOfferingIds: items,
      status: 'ACTIVE',
    })),
    s,
  );

  const constraints = (await SubjectChoiceConstraint.find({ tenantId, sessionId: source._id }).session(db).lean<SubjectChoiceConstraintDoc[]>()).filter(
    (c) => offeringMap.has(c.subjectOfferingId) && offeringMap.has(c.otherSubjectOfferingId),
  );
  await SubjectChoiceConstraint.insertMany(
    constraints.map((c) => ({
      ...base,
      _id: randomUUID(),
      classOfferingId: classMap.get(c.classOfferingId),
      sessionId: newId,
      locationId: c.locationId,
      type: c.type,
      subjectOfferingId: offeringMap.get(c.subjectOfferingId),
      otherSubjectOfferingId: offeringMap.get(c.otherSubjectOfferingId),
    })),
    s,
  );

  const programmes = await AcademicProgramme.find(scope).session(db).lean<AcademicProgrammeDoc[]>();
  await AcademicProgramme.insertMany(
    programmes.map((p) => ({
      ...base,
      _id: randomUUID(),
      sessionId: newId,
      locationId: p.locationId,
      name: p.name,
      code: p.code,
      kind: p.kind,
      classFromId: p.classFromId,
      classToId: p.classToId,
      boardId: p.boardId,
      subjectRules: p.subjectRules.filter((r) => offeringMap.has(r.subjectOfferingId)).map((r) => ({ requirement: r.requirement, subjectOfferingId: offeringMap.get(r.subjectOfferingId) })),
      choiceMin: p.choiceMin,
      choiceMax: p.choiceMax,
      status: 'ACTIVE',
    })),
    s,
  );

  // Terms move with the new start date (a session that starts a year later gets terms a year later).
  const shift = daysBetween(source.startDate, data.startDate);
  const terms = await AcademicTerm.find({ tenantId, sessionId: source._id }).session(db).lean<AcademicTermDoc[]>();
  await AcademicTerm.insertMany(
    terms.map((t) => ({
      ...base,
      _id: randomUUID(),
      sessionId: newId,
      locationId: t.locationId,
      name: t.name,
      code: t.code,
      type: t.type,
      sequence: t.sequence,
      startDate: addDays(t.startDate, shift),
      endDate: addDays(t.endDate, shift),
    })),
    s,
  );

  const created = doc!.toObject() as AcademicSessionDoc;
  await recordAcademicAudit(ctx, db, {
    entityType: 'academic_session',
    entityId: newId,
    action: 'academic_session.cloned',
    changes: diffFields({}, created, [...SESSION_EDITABLE_FIELDS, 'code', 'status']),
    academicSessionId: newId,
    metadata: {
      schoolId: source.schoolId,
      clonedFromSessionId: source._id,
      copied: {
        classOfferings: classes.length,
        sections: sections.length,
        subjectOfferings: offerings.length,
        choiceGroups: groups.length,
        constraints: constraints.length,
        programmes: programmes.length,
        terms: terms.length,
      },
      termShiftDays: shift,
    },
  });
  return newId;
}
