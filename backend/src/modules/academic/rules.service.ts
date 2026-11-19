import type { ClientSession } from 'mongoose';
import {
  CHOICE_GROUP_EDITABLE_FIELDS,
  type ChoiceGroupDTO,
  type ChoiceRuleType,
  type ConstraintDTO,
  type CreateChoiceGroupData,
  type CreateConstraintData,
  type UpdateChoiceGroupData,
} from '@shared';
import { AppError } from '../../core/errors';
import { pickDefined } from '../../core/objects';
import { onDuplicate } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields, changedValues } from '../audit/diff';
import { recordAcademicAudit } from './audit';
import { assertDeletable, assertEditable } from './guard';
import { SubjectOffering, type SubjectOfferingDoc } from './offering.model';
import { getClassOfferingOrThrow } from './offering.service';
import { SubjectChoiceConstraint, SubjectChoiceGroup, type SubjectChoiceConstraintDoc, type SubjectChoiceGroupDoc } from './rules.model';
import { getSessionOrThrow } from './session.service';
import { Subject, type SubjectDoc } from './subject.model';

/** AS-08 / AS-09 — subject choice groups and REQUIRES / EXCLUDES constraints, per class offering. */

// ───────────────────────────────────────────────────────────── helpers

interface SubjectLabel {
  subjectCode: string;
  subjectName: string;
  status: SubjectOfferingDoc['status'];
}

/** subjectOfferingId → what the UI needs to show. */
async function labelsFor(ctx: ServiceContext, offeringIds: string[], db?: ClientSession): Promise<Map<string, SubjectLabel>> {
  if (offeringIds.length === 0) return new Map();
  const offerings = await SubjectOffering.find({ tenantId: ctx.tenantId, _id: { $in: offeringIds } }).session(db ?? null).lean<SubjectOfferingDoc[]>();
  const subjects = await Subject.find({ tenantId: ctx.tenantId, _id: { $in: [...new Set(offerings.map((o) => o.subjectId))] } }).session(db ?? null).lean<SubjectDoc[]>();
  const byId = new Map(subjects.map((s) => [s._id, s]));
  return new Map(offerings.map((o) => [o._id, { subjectCode: byId.get(o.subjectId)?.subjectCode ?? '', subjectName: byId.get(o.subjectId)?.name ?? '', status: o.status }]));
}

/** "Choose 1 of Punjabi, Hindi, Urdu" — the plain-language rule shown under each group. */
export function describeGroup(ruleType: ChoiceRuleType, min: number, max: number, names: string[]): string {
  const list = names.join(', ');
  switch (ruleType) {
    case 'REQUIRED_ALL':
      return `Take all of ${list}`;
    case 'CHOOSE_ONE':
      return `Choose 1 of ${list}`;
    case 'CHOOSE_N':
      return min === max ? `Choose ${min} of ${list}` : `Choose ${min} to ${max} of ${list}`;
    case 'OPTIONAL':
      return `Optionally choose up to ${max} of ${list}`;
  }
}

/** The stored min/max follow the rule type; only CHOOSE_N and OPTIONAL take them from the caller. */
export function normaliseRule(ruleType: ChoiceRuleType, input: { min?: number | null; max?: number | null }, itemCount: number): { min: number; max: number } {
  switch (ruleType) {
    case 'REQUIRED_ALL':
      return { min: itemCount, max: itemCount };
    case 'CHOOSE_ONE':
      return { min: 1, max: 1 };
    case 'OPTIONAL':
      return { min: 0, max: input.max ?? itemCount };
    case 'CHOOSE_N': {
      const fields: Record<string, string> = {};
      if (input.min === undefined || input.min === null) fields.min = 'Enter the minimum number of subjects.';
      if (input.max === undefined || input.max === null) fields.max = 'Enter the maximum number of subjects.';
      if (Object.keys(fields).length > 0) throw AppError.validation(fields);
      if (input.min! > input.max!) throw AppError.validation({ max: 'The maximum cannot be lower than the minimum.' });
      return { min: input.min!, max: input.max! };
    }
  }
}

async function toGroupDTOs(ctx: ServiceContext, docs: SubjectChoiceGroupDoc[], db?: ClientSession): Promise<ChoiceGroupDTO[]> {
  const labels = await labelsFor(ctx, [...new Set(docs.flatMap((d) => d.subjectOfferingIds))], db);
  return docs.map((d) => {
    const subjects = d.subjectOfferingIds.map((id) => ({
      subjectOfferingId: id,
      subjectCode: labels.get(id)?.subjectCode ?? '',
      subjectName: labels.get(id)?.subjectName ?? '',
      status: labels.get(id)?.status ?? ('INACTIVE' as const),
    }));
    return {
      choiceGroupId: d._id,
      classOfferingId: d.classOfferingId,
      academicSessionId: d.sessionId,
      name: d.name,
      ruleType: d.ruleType,
      min: d.min,
      max: d.max,
      sequence: d.sequence,
      status: d.status,
      subjects,
      summary: describeGroup(d.ruleType, d.min, d.max, subjects.map((s) => s.subjectName)),
    };
  });
}

/** Items must be offerings of this class offering and in no other group of it. */
async function assertGroupItems(ctx: ServiceContext, classOfferingId: string, ids: string[], exceptGroupId: string | null, db: ClientSession) {
  const found = await SubjectOffering.find({ tenantId: ctx.tenantId, classOfferingId, _id: { $in: ids } }).select('_id').session(db).lean<{ _id: string }[]>();
  if (found.length !== ids.length) {
    throw AppError.validation({ subjectOfferingIds: 'Choose subjects that are offered for this class.' });
  }
  const others = await SubjectChoiceGroup.find({ tenantId: ctx.tenantId, classOfferingId, ...(exceptGroupId ? { _id: { $ne: exceptGroupId } } : {}), subjectOfferingIds: { $in: ids } })
    .session(db)
    .lean<SubjectChoiceGroupDoc[]>();
  if (others.length > 0) {
    const labels = await labelsFor(ctx, ids, db);
    const clashes = ids.filter((id) => others.some((g) => g.subjectOfferingIds.includes(id)));
    const names = clashes.map((id) => labels.get(id)?.subjectName ?? id);
    throw new AppError('SUBJECT_IN_ANOTHER_GROUP', `${names.join(', ')} already belong${names.length === 1 ? 's' : ''} to another choice group in this class.`, {
      fields: { subjectOfferingIds: `Already in another group: ${names.join(', ')}.` },
      subjectOfferingIds: clashes,
    });
  }
}

// ───────────────────────────────────────────────────────────── groups

async function getGroupOrThrow(ctx: ServiceContext, choiceGroupId: string, db?: ClientSession) {
  const group = await SubjectChoiceGroup.findOne({ _id: choiceGroupId, tenantId: ctx.tenantId }).session(db ?? null).lean<SubjectChoiceGroupDoc>();
  if (!group) throw AppError.notFound('Choice group not found.');
  const session = await getSessionOrThrow(ctx, group.sessionId, db);
  return { group, session };
}

export async function listChoiceGroups(ctx: ServiceContext, classOfferingId: string): Promise<ChoiceGroupDTO[]> {
  await getClassOfferingOrThrow(ctx, classOfferingId);
  return listChoiceGroupsFor(ctx, classOfferingId);
}

export async function listChoiceGroupsFor(ctx: ServiceContext, classOfferingId: string): Promise<ChoiceGroupDTO[]> {
  const docs = await SubjectChoiceGroup.find({ tenantId: ctx.tenantId, classOfferingId }).sort({ sequence: 1, _id: 1 }).lean<SubjectChoiceGroupDoc[]>();
  return toGroupDTOs(ctx, docs);
}

export async function createChoiceGroup(ctx: ServiceContext, classOfferingId: string, data: CreateChoiceGroupData): Promise<ChoiceGroupDTO> {
  const ids = [...new Set(data.subjectOfferingIds)];
  return withTransaction(async (db) => {
    const { offering, session } = await getClassOfferingOrThrow(ctx, classOfferingId, db);
    await assertEditable(session, {}, db);
    await assertGroupItems(ctx, classOfferingId, ids, null, db);
    const { min, max } = normaliseRule(data.ruleType, data, ids.length);

    let sequence = data.sequence;
    if (sequence === undefined || sequence === null) {
      const last = await SubjectChoiceGroup.findOne({ tenantId: ctx.tenantId, classOfferingId }).sort({ sequence: -1 }).select('sequence').session(db).lean<{ sequence: number }>();
      sequence = (last?.sequence ?? 0) + 1;
    }
    const [created] = await SubjectChoiceGroup.create(
      [
        {
          tenantId: ctx.tenantId,
          classOfferingId,
          sessionId: offering.sessionId,
          locationId: offering.locationId,
          name: data.name,
          ruleType: data.ruleType,
          min,
          max,
          sequence,
          subjectOfferingIds: ids,
          status: 'ACTIVE',
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    const group = created!.toObject() as SubjectChoiceGroupDoc;
    await recordAcademicAudit(ctx, db, {
      entityType: 'subject_choice_group',
      entityId: group._id,
      action: 'choice_group.created',
      changes: diffFields({}, group, CHOICE_GROUP_EDITABLE_FIELDS),
      academicSessionId: offering.sessionId,
      metadata: { classOfferingId, locationId: offering.locationId },
    });
    return (await toGroupDTOs(ctx, [group], db))[0]!;
  });
}

export async function updateChoiceGroup(ctx: ServiceContext, choiceGroupId: string, patch: UpdateChoiceGroupData): Promise<ChoiceGroupDTO> {
  return withTransaction(async (db) => {
    const { group: before, session } = await getGroupOrThrow(ctx, choiceGroupId, db);
    const updates = pickDefined(patch);
    const ids = updates.subjectOfferingIds ? [...new Set(updates.subjectOfferingIds)] : before.subjectOfferingIds;

    const removesItems = before.subjectOfferingIds.some((id) => !ids.includes(id));
    const deactivating = updates.status === 'INACTIVE' && before.status === 'ACTIVE';
    await assertEditable(session, removesItems || deactivating ? { structural: { entityType: 'choice_group', entityId: choiceGroupId } } : {}, db);
    if (updates.subjectOfferingIds) await assertGroupItems(ctx, before.classOfferingId, ids, choiceGroupId, db);

    const ruleType = updates.ruleType ?? before.ruleType;
    // Omitted min/max keep their stored values, so changing only the type of a CHOOSE_N group stays valid.
    const { min, max } = normaliseRule(ruleType, { min: updates.min ?? before.min, max: updates.max ?? before.max }, ids.length);
    const merged: SubjectChoiceGroupDoc = { ...before, ...updates, subjectOfferingIds: ids, ruleType, min, max } as SubjectChoiceGroupDoc;

    const changes = diffFields(before, merged, CHOICE_GROUP_EDITABLE_FIELDS);
    if (changes.length > 0) {
      await SubjectChoiceGroup.updateOne({ _id: choiceGroupId, tenantId: ctx.tenantId }, { $set: changedValues(merged, changes, ctx.userId) }, { session: db });
      await recordAcademicAudit(ctx, db, {
        entityType: 'subject_choice_group',
        entityId: choiceGroupId,
        action: 'choice_group.updated',
        changes,
        academicSessionId: before.sessionId,
        metadata: { classOfferingId: before.classOfferingId, name: before.name, status: session.status },
      });
    }
    return (await toGroupDTOs(ctx, [merged], db))[0]!;
  });
}

export async function deleteChoiceGroup(ctx: ServiceContext, choiceGroupId: string): Promise<void> {
  await withTransaction(async (db) => {
    const { group: before, session } = await getGroupOrThrow(ctx, choiceGroupId, db);
    assertDeletable(session);
    await SubjectChoiceGroup.deleteOne({ _id: choiceGroupId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'subject_choice_group',
      entityId: choiceGroupId,
      action: 'choice_group.deleted',
      changes: diffFields(before, {}, ['name', 'ruleType', 'min', 'max', 'status']),
      academicSessionId: before.sessionId,
      metadata: { classOfferingId: before.classOfferingId },
    });
  });
}

// ───────────────────────────────────────────────────────────── constraints

async function toConstraintDTOs(ctx: ServiceContext, docs: SubjectChoiceConstraintDoc[], db?: ClientSession): Promise<ConstraintDTO[]> {
  const labels = await labelsFor(ctx, [...new Set(docs.flatMap((d) => [d.subjectOfferingId, d.otherSubjectOfferingId]))], db);
  return docs.map((d) => {
    const a = labels.get(d.subjectOfferingId)?.subjectName ?? '';
    const b = labels.get(d.otherSubjectOfferingId)?.subjectName ?? '';
    return {
      constraintId: d._id,
      classOfferingId: d.classOfferingId,
      academicSessionId: d.sessionId,
      type: d.type,
      subjectOfferingId: d.subjectOfferingId,
      subjectName: a,
      otherSubjectOfferingId: d.otherSubjectOfferingId,
      otherSubjectName: b,
      summary: d.type === 'REQUIRES' ? `${a} requires ${b}` : `${a} excludes ${b}`,
    };
  });
}

export async function listConstraints(ctx: ServiceContext, classOfferingId: string): Promise<ConstraintDTO[]> {
  await getClassOfferingOrThrow(ctx, classOfferingId);
  return listConstraintsFor(ctx, classOfferingId);
}

export async function listConstraintsFor(ctx: ServiceContext, classOfferingId: string): Promise<ConstraintDTO[]> {
  const docs = await SubjectChoiceConstraint.find({ tenantId: ctx.tenantId, classOfferingId }).sort({ createdAt: 1, _id: 1 }).lean<SubjectChoiceConstraintDoc[]>();
  return toConstraintDTOs(ctx, docs);
}

export async function createConstraint(ctx: ServiceContext, classOfferingId: string, data: CreateConstraintData): Promise<ConstraintDTO> {
  if (data.subjectOfferingId === data.otherSubjectOfferingId) {
    throw AppError.validation({ otherSubjectOfferingId: 'Choose two different subjects.' });
  }
  return withTransaction(async (db) => {
    const { offering, session } = await getClassOfferingOrThrow(ctx, classOfferingId, db);
    await assertEditable(session, {}, db);

    const found = await SubjectOffering.countDocuments({
      tenantId: ctx.tenantId,
      classOfferingId,
      _id: { $in: [data.subjectOfferingId, data.otherSubjectOfferingId] },
    }).session(db);
    if (found !== 2) throw AppError.validation({ subjectOfferingId: 'Both subjects must be offered for this class.' });

    // "A excludes B" and "B excludes A" are the same rule.
    const same = await SubjectChoiceConstraint.exists({
      tenantId: ctx.tenantId,
      classOfferingId,
      type: data.type,
      $or: [
        { subjectOfferingId: data.subjectOfferingId, otherSubjectOfferingId: data.otherSubjectOfferingId },
        ...(data.type === 'EXCLUDES' ? [{ subjectOfferingId: data.otherSubjectOfferingId, otherSubjectOfferingId: data.subjectOfferingId }] : []),
      ],
    }).session(db);
    if (same) throw new AppError('CONSTRAINT_EXISTS');

    const [created] = await SubjectChoiceConstraint.create(
      [{ ...data, tenantId: ctx.tenantId, classOfferingId, sessionId: offering.sessionId, locationId: offering.locationId, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    const constraint = created!.toObject() as SubjectChoiceConstraintDoc;
    const dto = (await toConstraintDTOs(ctx, [constraint], db))[0]!;
    await recordAcademicAudit(ctx, db, {
      entityType: 'subject_choice_constraint',
      entityId: constraint._id,
      action: 'constraint.created',
      changes: [
        { field: 'type', from: null, to: constraint.type },
        { field: 'rule', from: null, to: dto.summary },
      ],
      academicSessionId: offering.sessionId,
      metadata: { classOfferingId },
    });
    return dto;
  }).catch(onDuplicate('type', () => new AppError('CONSTRAINT_EXISTS')));
}

export async function deleteConstraint(ctx: ServiceContext, constraintId: string): Promise<void> {
  await withTransaction(async (db) => {
    const before = await SubjectChoiceConstraint.findOne({ _id: constraintId, tenantId: ctx.tenantId }).session(db).lean<SubjectChoiceConstraintDoc>();
    if (!before) throw AppError.notFound('Constraint not found.');
    const session = await getSessionOrThrow(ctx, before.sessionId, db);
    await assertEditable(session, { structural: { entityType: 'constraint', entityId: constraintId } }, db);
    const dto = (await toConstraintDTOs(ctx, [before], db))[0]!;
    await SubjectChoiceConstraint.deleteOne({ _id: constraintId, tenantId: ctx.tenantId }, { session: db });
    await recordAcademicAudit(ctx, db, {
      entityType: 'subject_choice_constraint',
      entityId: constraintId,
      action: 'constraint.deleted',
      changes: [{ field: 'rule', from: dto.summary, to: null }],
      academicSessionId: before.sessionId,
      metadata: { classOfferingId: before.classOfferingId, status: session.status },
    });
  });
}
