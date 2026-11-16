import type { SelfProfileDTO, UpdateSelfProfileData } from '@shared';
import { SELF_EDITABLE_FIELDS } from '@shared';
import { pickDefined } from '../../core/objects';
import { withTransaction } from '../../db/transaction';
import { findRestricted, toRestrictedDTO } from '../../platform/identity/restricted-data';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { toUserDTO } from '../../platform/users/user.mapper';
import { listAcademicAssignments } from './academic-assignment.service';
import { auditScopeOf, classifiedDiff, recordStaffAudit } from './audit';
import { listPendingForEmployee } from './change-request.service';
import { hydrate } from './directory';
import { normalizePersonPatch } from './employee.service';
import { assertWritable, loadPerson } from './guards';
import { listLocationAssignments } from './location-assignment.service';
import { toProfileDTO } from './mappers';
import { Person } from './person.model';
import { listResponsibilities } from './responsibility.service';
import { requireCaller } from './self-access';

/** FSM-06 — the employee's own view and the low-risk edits they may make directly. */

export async function getSelfProfile(ctx: ServiceContext): Promise<SelfProfileDTO> {
  const { user, employee } = await requireCaller(ctx);
  const h = await hydrate(ctx, [employee]);
  const person = h.people.get(employee.personId)!;
  const [restricted, locationAssignments, academicAssignments, responsibilities, pendingRequests] = await Promise.all([
    findRestricted(ctx.tenantId, employee.personId),
    listLocationAssignments(ctx, employee._id),
    listAcademicAssignments(ctx, employee._id),
    listResponsibilities(ctx, employee._id),
    listPendingForEmployee(ctx, employee._id),
  ]);
  return {
    // The employee's own personal contact is theirs to see, whatever their role's permissions say.
    profile: toProfileDTO(employee, h, { viewPersonal: true, deletable: false }),
    dateOfBirth: person.dateOfBirth ?? null,
    restricted: toRestrictedDTO({ employeeId: employee._id, personId: employee.personId }, restricted, person.dateOfBirth),
    locationAssignments,
    academicAssignments,
    responsibilities,
    account: toUserDTO(user),
    pendingRequests,
  };
}

/** Preferred name, personal contact, address and emergency contact. Everything else goes through `changeRequests`. */
export async function updateSelfProfile(ctx: ServiceContext, patch: UpdateSelfProfileData): Promise<SelfProfileDTO> {
  await withTransaction(async (db) => {
    const { employee } = await requireCaller(ctx, db);
    assertWritable(employee);
    const person = await loadPerson(ctx.tenantId, employee.personId, db);
    const changes = normalizePersonPatch(pickDefined(patch) as Record<string, unknown>);
    const after = { ...person, ...changes };
    const diff = classifiedDiff('person', person, after, SELF_EDITABLE_FIELDS);
    if (diff.length === 0) return;
    const $set: Record<string, unknown> = { updatedBy: ctx.userId };
    for (const c of diff) $set[c.field] = (after as Record<string, unknown>)[c.field];
    await Person.updateOne({ _id: person._id, tenantId: ctx.tenantId }, { $set }, { session: db });
    await recordStaffAudit(auditScopeOf(ctx), db, { entityType: 'person', entityId: person._id, action: 'profile.self_updated', changes: diff, employeeId: employee._id });
  });
  return getSelfProfile(ctx);
}
