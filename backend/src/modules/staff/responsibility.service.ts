import type { ClientSession } from 'mongoose';
import type { CreateResponsibilityData, EndAssignmentData, ResponsibilityDTO } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { masterService } from '../master/master.service';
import { Responsibility, type ResponsibilityDoc } from './assignment.models';
import { auditScopeOf, recordStaffAudit } from './audit';
import { assertAssignable, assertWritable, loadEmployee } from './guards';
import { labelsFor } from './location-assignment.service';
import { toResponsibilityDTO } from './mappers';
import { assertLocationCoverage } from './placement';
import { assignmentStatus, latest, overlapping, todayFor } from './status';

/** FSM-05 — what non-teaching staff look after (transport, library, lab…), at one of their locations. */

const AUDITED = ['locationId', 'responsibilityType', 'description', 'effectiveFrom', 'effectiveTo'] as const;

async function dtosOf(ctx: ServiceContext, docs: ResponsibilityDoc[], db?: ClientSession): Promise<ResponsibilityDTO[]> {
  const [labels, today] = await Promise.all([labelsFor(ctx.tenantId, docs.map((d) => d.locationId), db), todayFor(ctx, db)]);
  return docs.map((d) => toResponsibilityDTO(d, labels.get(d.locationId) ?? { locationCode: '?', displayName: 'Unknown location' }, today));
}

export async function listResponsibilities(ctx: ServiceContext, employeeId: string): Promise<ResponsibilityDTO[]> {
  await loadEmployee(ctx, employeeId);
  const docs = await Responsibility.find({ tenantId: ctx.tenantId, employeeId }).sort({ effectiveFrom: -1, _id: 1 }).lean<ResponsibilityDoc[]>();
  return dtosOf(ctx, docs);
}

export async function createResponsibility(ctx: ServiceContext, employeeId: string, data: CreateResponsibilityData): Promise<ResponsibilityDTO> {
  return withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    assertAssignable(employee);
    if (employee.employeeCategory !== 'NON_TEACHING_STAFF') {
      throw new AppError('EMPLOYEE_CATEGORY_MISMATCH', 'Responsibilities are for non-teaching staff. Use class assignments for faculty.');
    }
    await masterService.assertOperationalLocation(ctx, data.locationId, db);

    const today = await todayFor(ctx, db);
    const from = data.effectiveFrom ?? latest(today, employee.joiningDate);
    const to = data.effectiveTo ?? null;
    await assertLocationCoverage(ctx, employeeId, data.locationId, from, to, db);

    const duplicate = await Responsibility.exists({
      tenantId: ctx.tenantId,
      employeeId,
      locationId: data.locationId,
      responsibilityType: data.responsibilityType,
      cancelledAt: null,
      ...overlapping(from, to),
    })
      .collation({ locale: 'en', strength: 2 })
      .session(db);
    if (duplicate) throw new AppError('ASSIGNMENT_DUPLICATE');

    const [created] = await Responsibility.create(
      [
        {
          tenantId: ctx.tenantId,
          employeeId,
          locationId: data.locationId,
          responsibilityType: data.responsibilityType,
          description: data.description ?? null,
          effectiveFrom: from,
          effectiveTo: to,
          createdBy: ctx.userId,
          updatedBy: ctx.userId,
        },
      ],
      { session: db },
    );
    const doc = created!.toObject() as ResponsibilityDoc;
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'responsibility',
      entityId: doc._id,
      action: 'responsibility.created',
      changes: diffFields({}, doc, AUDITED),
      employeeId,
    });
    return (await dtosOf(ctx, [doc], db))[0]!;
  });
}

async function getOpenOrThrow(ctx: ServiceContext, id: string, db: ClientSession) {
  const row = await Responsibility.findOne({ _id: id, tenantId: ctx.tenantId }).session(db).lean<ResponsibilityDoc>();
  if (!row) throw AppError.notFound('Responsibility not found.');
  const employee = await loadEmployee(ctx, row.employeeId, db);
  assertWritable(employee);
  if (row.cancelledAt) throw new AppError('ASSIGNMENT_CLOSED');
  return { row, employee };
}

export async function endResponsibility(ctx: ServiceContext, id: string, data: EndAssignmentData): Promise<ResponsibilityDTO> {
  return withTransaction(async (db) => {
    const { row, employee } = await getOpenOrThrow(ctx, id, db);
    if (data.effectiveTo < row.effectiveFrom) throw AppError.validation({ effectiveTo: 'The end date cannot be before the start date.' });
    if (row.effectiveTo && data.effectiveTo > row.effectiveTo) throw AppError.validation({ effectiveTo: 'An assignment can be ended earlier, not extended.' });

    const after = { ...row, effectiveTo: data.effectiveTo, endReason: 'ENDED' as const } as ResponsibilityDoc;
    await Responsibility.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { effectiveTo: data.effectiveTo, endReason: 'ENDED', updatedBy: ctx.userId } }, { session: db });
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'responsibility',
      entityId: id,
      action: 'responsibility.ended',
      changes: diffFields(row, after, ['effectiveTo', 'endReason']),
      employeeId: employee._id,
    });
    return (await dtosOf(ctx, [after], db))[0]!;
  });
}

export async function cancelResponsibility(ctx: ServiceContext, id: string): Promise<ResponsibilityDTO> {
  return withTransaction(async (db) => {
    const { row, employee } = await getOpenOrThrow(ctx, id, db);
    if (assignmentStatus(row, await todayFor(ctx, db)) !== 'PLANNED') throw new AppError('ASSIGNMENT_NOT_PLANNED');

    const cancelledAt = new Date();
    await Responsibility.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { cancelledAt, updatedBy: ctx.userId } }, { session: db });
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'responsibility',
      entityId: id,
      action: 'responsibility.cancelled',
      changes: [{ field: 'cancelledAt', from: null, to: cancelledAt.toISOString() }],
      employeeId: employee._id,
    });
    return (await dtosOf(ctx, [{ ...row, cancelledAt }], db))[0]!;
  });
}
