import type { ClientSession } from 'mongoose';
import {
  type CreateLocationAssignmentData,
  type EndAssignmentData,
  type LocationAssignmentDTO,
  type TransferData,
  type TransferResultDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { masterService } from '../master/master.service';
import { LocationAssignment, type LocationAssignmentDoc } from './assignment.models';
import { auditScopeOf, recordStaffAudit } from './audit';
import { Location } from '../locations/location.model';
import { assertAssignable, assertWritable, loadEmployee } from './guards';
import { toLocationAssignmentDTO, type LocationLabel } from './mappers';
import { assertNoDependents, assertNoPrimaryOverlap } from './placement';
import { addDays } from '../../core/dates';
import { assignmentStatus, latest, overlapping, todayFor } from './status';
import type { EmployeeDoc } from './employee.model';

/** FSM-03 — where an employee works. Primary and secondary placements, transfers, all effective-dated. */

const AUDITED = ['locationId', 'isPrimary', 'effectiveFrom', 'effectiveTo', 'endReason'] as const;

export async function labelsFor(tenantId: string, locationIds: string[], db?: ClientSession): Promise<Map<string, LocationLabel>> {
  const rows = await Location.find({ tenantId, _id: { $in: [...new Set(locationIds)] } })
    .session(db ?? null)
    .select('locationCode displayName')
    .lean<{ _id: string; locationCode: string; displayName: string }[]>();
  return new Map(rows.map((r) => [r._id, { locationCode: r.locationCode, displayName: r.displayName }]));
}

async function dtosOf(ctx: ServiceContext, docs: LocationAssignmentDoc[], db?: ClientSession): Promise<LocationAssignmentDTO[]> {
  const [labels, today] = await Promise.all([labelsFor(ctx.tenantId, docs.map((d) => d.locationId), db), todayFor(ctx, db)]);
  return docs.map((d) => toLocationAssignmentDTO(d, labels.get(d.locationId) ?? { locationCode: '?', displayName: 'Unknown location' }, today));
}

async function getAssignmentOrThrow(ctx: ServiceContext, id: string, db: ClientSession) {
  const row = await LocationAssignment.findOne({ _id: id, tenantId: ctx.tenantId }).session(db).lean<LocationAssignmentDoc>();
  if (!row) throw AppError.notFound('Location assignment not found.');
  const employee = await loadEmployee(ctx, row.employeeId, db);
  return { row, employee };
}

export async function listLocationAssignments(ctx: ServiceContext, employeeId: string): Promise<LocationAssignmentDTO[]> {
  await loadEmployee(ctx, employeeId);
  const rows = await LocationAssignment.find({ tenantId: ctx.tenantId, employeeId }).sort({ effectiveFrom: -1, _id: 1 }).lean<LocationAssignmentDoc[]>();
  return dtosOf(ctx, rows);
}

/** A secondary placement. The primary one is created with the employee and moved only by a transfer. */
export async function addLocationAssignment(ctx: ServiceContext, employeeId: string, data: CreateLocationAssignmentData): Promise<LocationAssignmentDTO> {
  return withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    assertAssignable(employee);
    await masterService.assertOperationalLocation(ctx, data.locationId, db);

    const today = await todayFor(ctx, db);
    const from = data.effectiveFrom ?? latest(today, employee.joiningDate);
    const to = data.effectiveTo ?? null;
    if (from < employee.joiningDate) {
      throw AppError.validation({ effectiveFrom: 'A placement cannot start before the joining date.' });
    }
    const duplicate = await LocationAssignment.exists({
      tenantId: ctx.tenantId,
      employeeId,
      locationId: data.locationId,
      cancelledAt: null,
      ...overlapping(from, to),
    }).session(db);
    if (duplicate) throw new AppError('ASSIGNMENT_DUPLICATE', 'This employee is already placed at that location for those dates.');

    const [created] = await LocationAssignment.create(
      [{ tenantId: ctx.tenantId, employeeId, locationId: data.locationId, isPrimary: false, effectiveFrom: from, effectiveTo: to, createdBy: ctx.userId, updatedBy: ctx.userId }],
      { session: db },
    );
    const doc = created!.toObject() as LocationAssignmentDoc;
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'location_assignment',
      entityId: doc._id,
      action: 'location_assignment.created',
      changes: diffFields({}, doc, AUDITED),
      employeeId,
    });
    return (await dtosOf(ctx, [doc], db))[0]!;
  });
}

/** Last day of a placement. A primary placement is never ended on its own: use a transfer (or an exit). */
export async function endLocationAssignment(ctx: ServiceContext, id: string, data: EndAssignmentData): Promise<LocationAssignmentDTO> {
  return withTransaction(async (db) => {
    const { row, employee } = await getAssignmentOrThrow(ctx, id, db);
    assertWritable(employee);
    if (row.cancelledAt) throw new AppError('ASSIGNMENT_CLOSED');
    if (row.isPrimary) throw new AppError('EMPLOYEE_PRIMARY_REQUIRED');
    if (data.effectiveTo < row.effectiveFrom) throw AppError.validation({ effectiveTo: 'The end date cannot be before the start date.' });
    if (row.effectiveTo && data.effectiveTo > row.effectiveTo) {
      throw AppError.validation({ effectiveTo: 'An assignment can be ended earlier, not extended.' });
    }
    await assertNoDependents(ctx, employee._id, row.locationId, data.effectiveTo, db);

    const after = { ...row, effectiveTo: data.effectiveTo, endReason: 'ENDED' as const };
    await LocationAssignment.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { effectiveTo: data.effectiveTo, endReason: 'ENDED', updatedBy: ctx.userId } }, { session: db });
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'location_assignment',
      entityId: id,
      action: 'location_assignment.ended',
      changes: diffFields(row, after, ['effectiveTo', 'endReason']),
      employeeId: employee._id,
    });
    return (await dtosOf(ctx, [after as LocationAssignmentDoc], db))[0]!;
  });
}

/** Only a placement that has not started. Cancelling a planned transfer puts the old primary placement back. */
export async function cancelLocationAssignment(ctx: ServiceContext, id: string): Promise<LocationAssignmentDTO> {
  return withTransaction(async (db) => {
    const { row, employee } = await getAssignmentOrThrow(ctx, id, db);
    assertWritable(employee);
    if (row.cancelledAt) throw new AppError('ASSIGNMENT_CLOSED');
    const today = await todayFor(ctx, db);
    if (assignmentStatus(row, today) !== 'PLANNED') throw new AppError('ASSIGNMENT_NOT_PLANNED');

    // The placement it replaced, if it was a transfer: it ended the day before this one starts.
    let previous: LocationAssignmentDoc | null = null;
    if (row.isPrimary) {
      previous = await LocationAssignment.findOne({
        tenantId: ctx.tenantId,
        employeeId: employee._id,
        isPrimary: true,
        cancelledAt: null,
        endReason: 'TRANSFER',
        effectiveTo: addDays(row.effectiveFrom, -1),
      })
        .session(db)
        .lean<LocationAssignmentDoc>();
      if (!previous) throw new AppError('EMPLOYEE_PRIMARY_REQUIRED');
    }
    await assertNoDependents(ctx, employee._id, row.locationId, null, db);

    const cancelledAt = new Date();
    await LocationAssignment.updateOne({ _id: id, tenantId: ctx.tenantId }, { $set: { cancelledAt, updatedBy: ctx.userId } }, { session: db });
    const scope = auditScopeOf(ctx);
    await recordStaffAudit(scope, db, {
      entityType: 'location_assignment',
      entityId: id,
      action: 'location_assignment.cancelled',
      changes: [{ field: 'cancelledAt', from: null, to: cancelledAt.toISOString() }],
      employeeId: employee._id,
    });
    if (previous) {
      await LocationAssignment.updateOne({ _id: previous._id, tenantId: ctx.tenantId }, { $set: { effectiveTo: null, endReason: null, updatedBy: ctx.userId } }, { session: db });
      await recordStaffAudit(scope, db, {
        entityType: 'location_assignment',
        entityId: previous._id,
        action: 'location_assignment.updated',
        changes: [{ field: 'effectiveTo', from: previous.effectiveTo, to: null }],
        employeeId: employee._id,
        metadata: { reason: 'TRANSFER_CANCELLED' },
      });
    }
    return (await dtosOf(ctx, [{ ...row, cancelledAt }], db))[0]!;
  });
}

/**
 * Moves the primary placement. The current one ends the day before `effectiveFrom`, the new one starts on it, in one transaction.
 * A transfer dated in the future shows as PLANNED until then, and the old row keeps its history.
 */
export async function transferEmployee(ctx: ServiceContext, employeeId: string, data: TransferData): Promise<TransferResultDTO> {
  return withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    assertAssignable(employee);
    await masterService.assertOperationalLocation(ctx, data.toLocationId, db);

    const current = await LocationAssignment.findOne({ tenantId: ctx.tenantId, employeeId, isPrimary: true, cancelledAt: null, effectiveTo: null })
      .session(db)
      .lean<LocationAssignmentDoc>();
    if (!current) throw new AppError('LOCATION_NOT_ASSIGNED', 'This employee has no open primary location to transfer from.');
    if (current.locationId === data.toLocationId) {
      throw AppError.validation({ toLocationId: 'Choose a different location from the current primary one.' });
    }
    if (data.effectiveFrom <= current.effectiveFrom) {
      throw AppError.validation({ effectiveFrom: `Choose a date after ${current.effectiveFrom}, when the current placement started.` });
    }
    const lastDay = addDays(data.effectiveFrom, -1);
    await assertNoDependents(ctx, employeeId, current.locationId, lastDay, db);

    await LocationAssignment.updateOne({ _id: current._id, tenantId: ctx.tenantId }, { $set: { effectiveTo: lastDay, endReason: 'TRANSFER', updatedBy: ctx.userId } }, { session: db });
    await assertNoPrimaryOverlap(ctx, employeeId, data.effectiveFrom, null, null, db);

    const base = { tenantId: ctx.tenantId, employeeId, effectiveFrom: data.effectiveFrom, createdBy: ctx.userId, updatedBy: ctx.userId };
    const [started] = await LocationAssignment.create([{ ...base, locationId: data.toLocationId, isPrimary: true }], { session: db });
    let secondary: LocationAssignmentDoc | null = null;
    if (data.keepOldAsSecondary) {
      const [kept] = await LocationAssignment.create([{ ...base, locationId: current.locationId, isPrimary: false }], { session: db });
      secondary = kept!.toObject() as LocationAssignmentDoc;
    }

    const ended = { ...current, effectiveTo: lastDay, endReason: 'TRANSFER' as const } as LocationAssignmentDoc;
    const scope = auditScopeOf(ctx);
    await recordStaffAudit(scope, db, {
      entityType: 'location_assignment',
      entityId: current._id,
      action: 'location_assignment.transferred',
      changes: diffFields(current, ended, ['effectiveTo', 'endReason']),
      employeeId,
      metadata: { toLocationId: data.toLocationId, effectiveFrom: data.effectiveFrom },
    });
    const startedDoc = started!.toObject() as LocationAssignmentDoc;
    await recordStaffAudit(scope, db, {
      entityType: 'location_assignment',
      entityId: startedDoc._id,
      action: 'location_assignment.created',
      changes: diffFields({}, startedDoc, AUDITED),
      employeeId,
      metadata: { transferFrom: current.locationId },
    });
    if (secondary) {
      await recordStaffAudit(scope, db, {
        entityType: 'location_assignment',
        entityId: secondary._id,
        action: 'location_assignment.created',
        changes: diffFields({}, secondary, AUDITED),
        employeeId,
        metadata: { keptAfterTransfer: true },
      });
    }

    const dtos = await dtosOf(ctx, [ended, startedDoc, ...(secondary ? [secondary] : [])], db);
    return { ended: dtos[0]!, started: dtos[1]!, secondary: secondary ? dtos[2]! : null };
  });
}

export type { EmployeeDoc };
