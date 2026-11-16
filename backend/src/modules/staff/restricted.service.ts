import type { RestrictedEmployeeProfileDTO, RevealedValueDTO, RevealRestrictedData, UpdateRestrictedData } from '@shared';
import { REDACTED } from '@shared';
import { AppError } from '../../core/errors';
import { withTransaction } from '../../db/transaction';
import { findRestricted, readValue, saveRestricted, toRestrictedDTO } from '../../platform/identity/restricted-data';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { auditScopeOf, recordStaffAudit } from './audit';
import { assertWritable, loadEmployee, loadPerson } from './guards';

/**
 * SEC-02 — government IDs, bank details and the date of birth. The profile is always masked; a real value comes out of
 * `revealRestricted` only (permission + step-up, both checked on the route) and each reveal is audited WITHOUT the value.
 */

export const REVEAL_HIDE_AFTER_SECONDS = 30;

export async function getRestrictedProfile(ctx: ServiceContext, employeeId: string): Promise<RestrictedEmployeeProfileDTO> {
  const employee = await loadEmployee(ctx, employeeId);
  const [person, doc] = await Promise.all([loadPerson(ctx.tenantId, employee.personId), findRestricted(ctx.tenantId, employee.personId)]);
  return toRestrictedDTO({ employeeId, personId: employee.personId }, doc, person.dateOfBirth);
}

export async function revealRestricted(ctx: ServiceContext, employeeId: string, data: RevealRestrictedData): Promise<RevealedValueDTO> {
  return withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    const [person, doc] = await Promise.all([loadPerson(ctx.tenantId, employee.personId, db), findRestricted(ctx.tenantId, employee.personId, db)]);
    const value = readValue(employee.personId, doc, person.dateOfBirth, data.field);
    if (value === null) throw AppError.notFound('Nothing is recorded for that detail.');
    // Who looked at what, never the value itself.
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'restricted_data',
      entityId: employee.personId,
      action: 'restricted.revealed',
      employeeId,
      metadata: { field: data.field, outcome: 'SUCCESS' },
    });
    return { field: data.field, value, hideAfterSeconds: REVEAL_HIDE_AFTER_SECONDS };
  });
}

/** Adds or replaces IDs by type and the bank details. The audit trail records which details changed, as `[redacted]`. */
export async function updateRestricted(ctx: ServiceContext, employeeId: string, data: UpdateRestrictedData): Promise<RestrictedEmployeeProfileDTO> {
  await withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    assertWritable(employee);
    await saveRestricted(ctx.tenantId, employee.personId, { governmentIds: data.governmentIds, bank: data.bank }, ctx.userId, db);
    const changes = [
      ...(data.governmentIds ?? []).map((g) => ({ field: `governmentIds.${g.type}`, from: REDACTED, to: REDACTED })),
      ...(data.bank !== undefined ? [{ field: 'bank', from: REDACTED, to: REDACTED }] : []),
    ];
    await recordStaffAudit(auditScopeOf(ctx), db, { entityType: 'restricted_data', entityId: employee.personId, action: 'restricted.updated', changes, employeeId });
  });
  return getRestrictedProfile(ctx, employeeId);
}
