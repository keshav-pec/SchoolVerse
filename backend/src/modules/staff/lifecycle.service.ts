import type { ClientSession, Model } from 'mongoose';
import type { ChangeEmployeeStatusData, EmployeeProfileDTO, ExitEmployeeData } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { AcademicAssignment, LocationAssignment, Responsibility } from './assignment.models';
import { auditScopeOf, recordStaffAudit } from './audit';
import { Employee, type EmployeeDoc } from './employee.model';
import { profileOf } from './employee.service';
import { assertWritable, loadEmployee } from './guards';
import { emitEmployeeExited } from './hooks';
import { ACTION_FOR_TARGET, assertEmployeeTransition, exitTarget } from './lifecycle';
import { todayFor } from './status';

/** Lifecycle and offboarding: activate, leave, suspend, exit with notice, cancel exit. */

interface Closable {
  _id: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  cancelledAt: Date | null;
  endReason: string | null;
  priorEffectiveTo: string | null;
}

/** The three effective-dated collections an exit has to close. */
function assignmentModels(): Model<Closable>[] {
  return [LocationAssignment, AcademicAssignment, Responsibility] as unknown as Model<Closable>[];
}

/**
 * Every open assignment ends on the exit date and anything starting after it is cancelled. What each row looked like before
 * is kept in `priorEffectiveTo`, so cancelling the exit can put them back exactly as they were.
 */
async function closeAssignmentsForExit(tenantId: string, employeeId: string, exitDate: string, actorId: string | null, db: ClientSession) {
  let closed = 0;
  let cancelled = 0;
  for (const model of assignmentModels()) {
    const rows = await model.find({ tenantId, employeeId, cancelledAt: null, $or: [{ effectiveTo: null }, { effectiveTo: { $gt: exitDate } }] } as never)
      .session(db)
      .lean<Closable[]>();
    for (const row of rows) {
      if (row.effectiveFrom > exitDate) {
        await model.updateOne({ _id: row._id, tenantId } as never, { $set: { cancelledAt: new Date(), endReason: 'EXIT', priorEffectiveTo: row.effectiveTo, updatedBy: actorId } }, { session: db });
        cancelled += 1;
      } else {
        await model.updateOne({ _id: row._id, tenantId } as never, { $set: { effectiveTo: exitDate, endReason: 'EXIT', priorEffectiveTo: row.effectiveTo, updatedBy: actorId } }, { session: db });
        closed += 1;
      }
    }
  }
  return { closed, cancelled };
}

async function reopenAssignmentsAfterExit(tenantId: string, employeeId: string, actorId: string | null, db: ClientSession) {
  for (const model of assignmentModels()) {
    const rows = await model.find({ tenantId, employeeId, endReason: 'EXIT' } as never).session(db).lean<Closable[]>();
    for (const row of rows) {
      const $set = row.cancelledAt ? { cancelledAt: null } : { effectiveTo: row.priorEffectiveTo };
      await model.updateOne({ _id: row._id, tenantId } as never, { $set: { ...$set, endReason: null, priorEffectiveTo: null, updatedBy: actorId } }, { session: db });
    }
  }
}

async function setStatus(employee: EmployeeDoc, to: EmployeeDoc['status'], extra: Record<string, unknown>, db: ClientSession, actorId: string | null) {
  await Employee.updateOne(
    { _id: employee._id, tenantId: employee.tenantId },
    { $set: { status: to, statusChangedAt: new Date(), statusChangedBy: actorId, updatedBy: actorId, ...extra } },
    { session: db },
  );
}

/** Activate, put on leave, suspend or return. */
export async function changeEmployeeStatus(ctx: ServiceContext, employeeId: string, data: ChangeEmployeeStatusData): Promise<EmployeeProfileDTO> {
  await withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    assertWritable(employee);
    const to = assertEmployeeTransition(employee.status, ACTION_FOR_TARGET[data.to]);
    await setStatus(employee, to, {}, db, ctx.userId);
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'employee',
      entityId: employeeId,
      action: 'employee.status_changed',
      changes: [{ field: 'status', from: employee.status, to }],
      employeeId,
      metadata: data.reason ? { reason: data.reason } : {},
    });
  });
  return profileOf(ctx, await loadEmployee(ctx, employeeId));
}

/** Writes the EXITED change itself. Shared by an exit dated today or earlier and by the hourly job. */
export async function completeExit(employee: EmployeeDoc, db: ClientSession, actorId: string | null, extra: Record<string, unknown> = {}) {
  await setStatus(employee, 'EXITED', extra, db, actorId);
  await emitEmployeeExited({ tenantId: employee.tenantId, employeeId: employee._id, personId: employee.personId }, db);
}

/**
 * Exit on or before today: EXITED now. A later date: NOTICE_PERIOD, and the hourly job finishes it. Either way the
 * assignments close on the exit date straight away.
 */
export async function exitEmployee(ctx: ServiceContext, employeeId: string, data: ExitEmployeeData): Promise<EmployeeProfileDTO> {
  await withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    assertWritable(employee);
    assertEmployeeTransition(employee.status, 'exit');
    if (data.exitDate < employee.joiningDate) {
      throw AppError.validation({ exitDate: 'The exit date cannot be before the joining date.' });
    }

    const today = await todayFor(ctx, db);
    const target = exitTarget(data.exitDate, today);
    const scope = auditScopeOf(ctx);
    const exitFields = { exitDate: data.exitDate, exitReasonCategory: data.exitReasonCategory, exitNote: data.note ?? null };
    const closed = await closeAssignmentsForExit(ctx.tenantId, employeeId, data.exitDate, ctx.userId, db);

    if (target === 'EXITED') await completeExit(employee, db, ctx.userId, exitFields);
    else await setStatus(employee, 'NOTICE_PERIOD', exitFields, db, ctx.userId);

    await recordStaffAudit(scope, db, {
      entityType: 'employee',
      entityId: employeeId,
      action: target === 'EXITED' ? 'employee.exited' : 'employee.exit_initiated',
      changes: [
        { field: 'status', from: employee.status, to: target },
        { field: 'exitDate', from: null, to: data.exitDate },
        { field: 'exitReasonCategory', from: null, to: data.exitReasonCategory },
      ],
      employeeId,
      metadata: { assignmentsClosed: closed.closed, assignmentsCancelled: closed.cancelled },
    });
  });
  return profileOf(ctx, await loadEmployee(ctx, employeeId));
}

/** Back from the notice period: the employee is ACTIVE again and every assignment the exit closed is put back. */
export async function cancelExit(ctx: ServiceContext, employeeId: string): Promise<EmployeeProfileDTO> {
  await withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    assertWritable(employee);
    assertEmployeeTransition(employee.status, 'cancel_exit');

    await reopenAssignmentsAfterExit(ctx.tenantId, employeeId, ctx.userId, db);
    await setStatus(employee, 'ACTIVE', { exitDate: null, exitReasonCategory: null, exitNote: null }, db, ctx.userId);
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'employee',
      entityId: employeeId,
      action: 'employee.exit_cancelled',
      changes: [
        { field: 'status', from: employee.status, to: 'ACTIVE' },
        { field: 'exitDate', from: employee.exitDate, to: null },
      ],
      employeeId,
    });
  });
  return profileOf(ctx, await loadEmployee(ctx, employeeId));
}
