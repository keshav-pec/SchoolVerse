import { randomUUID } from 'node:crypto';
import type { ClientSession, PipelineStage } from 'mongoose';
import {
  EMPLOYEE_EDITABLE_FIELDS,
  PERSON_EDITABLE_FIELDS,
  type CreateEmployeeData,
  type EmployeeDirectoryDTO,
  type EmployeeProfileDTO,
  type ListEmployeesQuery,
  type PaginatedDTO,
  type UpdateEmployeeData,
} from '@shared';
import { AppError } from '../../core/errors';
import { escapeRegex, pickDefined } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { can, type ServiceContext } from '../../platform/rbac/tenant-context';
import { diffFields } from '../audit/diff';
import { masterService } from '../master/master.service';
import { getCurrentSchool } from '../school/school.service';
import { colleagueScope, employeeIdsAt, isVisibleColleague, recordCrossLocationDenied } from './access';
import { AcademicAssignment, LocationAssignment, Responsibility } from './assignment.models';
import { auditScopeOf, classifiedDiff, recordStaffAudit } from './audit';
import { hydrate } from './directory';
import { Employee, LIVE_EMPLOYEE_STATUSES, type EmployeeDoc } from './employee.model';
import { assertEmploymentDates, assertValidManager, assertWritable, loadEmployee } from './guards';
import { hasRegisteredHistory } from './hooks';
import { DIRECTORY_STATUSES } from './lifecycle';
import { requireActiveMaster } from './master.service';
import { toDirectoryDTO, toProfileDTO } from './mappers';
import { Person, type PersonDoc } from './person.model';
import { todayFor } from './status';

/** FSM-01 — person + employee master: onboarding, directory, profile, edit and discard. */

const EMPLOYEE_AUDIT_FIELDS = [...EMPLOYEE_EDITABLE_FIELDS, 'status'] as const;

function pick<T extends object>(source: T, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => keys.includes(key)));
}

/** Zod leaves unset address parts out; the stored shape always has every part (null when empty). */
function normalizeAddress(address: Record<string, unknown> | null | undefined) {
  if (!address) return null;
  const text = (key: string) => (typeof address[key] === 'string' && address[key] !== '' ? (address[key] as string) : null);
  return { line1: text('line1'), line2: text('line2'), city: text('city'), state: text('state'), postalCode: text('postalCode'), country: text('country') };
}

function normalizePersonPatch(patch: Record<string, unknown>) {
  const out = { ...patch };
  if ('address' in out) out.address = normalizeAddress(out.address as Record<string, unknown> | null);
  return out;
}

// ───────────────────────────────────────────────────────────── mapping helpers

/** Hard delete is allowed only for an ONBOARDING employee with nothing recorded against them. */
async function isDeletable(ctx: ServiceContext, employee: EmployeeDoc, db?: ClientSession): Promise<boolean> {
  if (employee.status !== 'ONBOARDING') return false;
  const scope = { tenantId: ctx.tenantId, employeeId: employee._id };
  const [academic, responsibility, reports, registered] = await Promise.all([
    AcademicAssignment.exists(scope).session(db ?? null),
    Responsibility.exists(scope).session(db ?? null),
    Employee.exists({ tenantId: ctx.tenantId, reportingManagerId: employee._id }).session(db ?? null),
    hasRegisteredHistory({ tenantId: ctx.tenantId, employeeId: employee._id, personId: employee.personId, session: db }),
  ]);
  return !academic && !responsibility && !reports && !registered;
}

export async function profileOf(ctx: ServiceContext, employee: EmployeeDoc, db?: ClientSession): Promise<EmployeeProfileDTO> {
  const [h, deletable] = await Promise.all([hydrate(ctx, [employee], { db }), isDeletable(ctx, employee, db)]);
  return toProfileDTO(employee, h, { viewPersonal: can(ctx, 'employee:view_personal'), deletable });
}

// ───────────────────────────────────────────────────────────── reads

/**
 * Admins see every employee (EXITED hidden unless asked for). Faculty and Staff see only colleagues who share one of
 * their current locations, and only directory fields.
 */
export async function listEmployees(ctx: ServiceContext, query: ListEmployeesQuery): Promise<PaginatedDTO<EmployeeDirectoryDTO>> {
  const today = await todayFor(ctx);
  const full = can(ctx, 'employee:view');

  const match: Record<string, unknown> = { tenantId: ctx.tenantId };
  let allowedIds: string[] | null = null;

  if (full) {
    match.status = { $in: query.status ?? (['ONBOARDING', 'ACTIVE', 'ON_LEAVE', 'SUSPENDED', 'NOTICE_PERIOD'] as const) };
  } else {
    const scope = await colleagueScope(ctx, today);
    match.status = { $in: DIRECTORY_STATUSES };
    allowedIds = scope.employeeIds;
    if (query.locationId) {
      // Only locations the caller shares: anything else is simply empty.
      const shared = scope.locationIds.includes(query.locationId) ? await employeeIdsAt(ctx.tenantId, [query.locationId], today, false) : [];
      allowedIds = allowedIds.filter((id) => shared.includes(id));
    }
  }
  if (full && query.locationId) allowedIds = await employeeIdsAt(ctx.tenantId, [query.locationId], today, true);
  if (allowedIds) match._id = { $in: allowedIds };
  if (query.category) match.employeeCategory = query.category;
  if (query.departmentId) match.departmentId = query.departmentId;
  if (query.designationId) match.designationId = query.designationId;

  const nameFields = ['person.legalFirstName', 'person.legalMiddleName', 'person.legalLastName', 'person.preferredName'];
  const tokens = (query.q ?? '').split(/\s+/).filter(Boolean);
  const search: PipelineStage[] = tokens.length
    ? [
        {
          $match: {
            $and: tokens.map((token) => {
              const rx = new RegExp(escapeRegex(token), 'i');
              return { $or: [{ employeeCode: rx }, ...nameFields.map((f) => ({ [f]: rx }))] };
            }),
          },
        },
      ]
    : [];

  const pipeline: PipelineStage[] = [
    { $match: match },
    { $lookup: { from: 'people', localField: 'personId', foreignField: '_id', as: 'person' } },
    { $unwind: '$person' },
    ...search,
    { $sort: { 'person.legalFirstName': 1, 'person.legalLastName': 1, employeeCode: 1, _id: 1 } },
    { $facet: { items: [{ $skip: (query.page - 1) * query.pageSize }, { $limit: query.pageSize }], total: [{ $count: 'n' }] } },
  ];
  const [result] = await Employee.aggregate<{ items: (EmployeeDoc & { person: PersonDoc })[]; total: { n: number }[] }>(pipeline).collation({ locale: 'en', strength: 2 });

  const rows = result?.items ?? [];
  const employees = rows.map(({ person: _person, ...employee }) => employee as EmployeeDoc);
  const h = await hydrate(ctx, employees, { people: rows.map((r) => r.person), today });
  return {
    items: employees.map((e) => toDirectoryDTO(e, h)),
    page: query.page,
    pageSize: query.pageSize,
    total: result?.total[0]?.n ?? 0,
  };
}

/** Admins get the profile; Faculty and Staff get directory fields, and only for colleagues (404 + security event otherwise). */
export async function getEmployee(ctx: ServiceContext, employeeId: string): Promise<EmployeeProfileDTO | EmployeeDirectoryDTO> {
  const employee = await loadEmployee(ctx, employeeId);
  if (can(ctx, 'employee:view')) return profileOf(ctx, employee);

  const today = await todayFor(ctx);
  const scope = await colleagueScope(ctx, today);
  if (!isVisibleColleague(scope, employee)) {
    await recordCrossLocationDenied(ctx, employee._id);
    throw AppError.notFound('Employee not found.');
  }
  return toDirectoryDTO(employee, await hydrate(ctx, [employee], { today }));
}

// ───────────────────────────────────────────────────────────── create (FSM-01)

function mapDuplicate(err: unknown): never {
  const fields = duplicateKeyFields(err);
  if (fields?.includes('employeeCode')) {
    throw new AppError('EMPLOYEE_CODE_TAKEN', undefined, { fields: { employeeCode: 'This employee code is already in use.' } });
  }
  if (fields?.includes('personId')) throw new AppError('PERSON_HAS_ACTIVE_EMPLOYMENT');
  throw err;
}

/** One transaction: the person (or the existing one, on a rehire), the employee and the primary location placement. */
export async function createEmployee(ctx: ServiceContext, data: CreateEmployeeData): Promise<EmployeeProfileDTO> {
  const school = await getCurrentSchool(ctx);
  if (!school) throw AppError.notFound('Set up the school profile before adding staff.');

  try {
    const employeeId = await withTransaction(async (db) => {
      assertEmploymentDates(data.joiningDate, data.confirmationDate);
      await requireActiveMaster(ctx, 'department', data.departmentId, 'departmentId', db);
      await requireActiveMaster(ctx, 'designation', data.designationId, 'designationId', db);
      await masterService.assertOperationalLocation(ctx, data.primaryLocationId, db);
      if (data.reportingManagerId) await assertValidManager(ctx, data.reportingManagerId, null, db);

      const scope = auditScopeOf(ctx);
      const newEmployeeId = randomUUID();
      let person: PersonDoc;
      if (data.personId) {
        const existing = await Person.findOne({ _id: data.personId, tenantId: ctx.tenantId }).session(db).lean<PersonDoc>();
        if (!existing) throw AppError.notFound('Person not found.');
        const live = await Employee.exists({ tenantId: ctx.tenantId, personId: existing._id, status: { $in: LIVE_EMPLOYEE_STATUSES } }).session(db);
        if (live) throw new AppError('PERSON_HAS_ACTIVE_EMPLOYMENT');
        person = existing;
      } else {
        const [created] = await Person.create(
          [
            {
              tenantId: ctx.tenantId,
              legalFirstName: data.legalFirstName,
              legalMiddleName: data.legalMiddleName ?? null,
              legalLastName: data.legalLastName,
              preferredName: data.preferredName ?? null,
              dateOfBirth: data.dateOfBirth ?? null,
              primaryEmail: data.primaryEmail ?? null,
              primaryPhone: data.primaryPhone ?? null,
              personalEmail: data.personalEmail ?? null,
              personalPhone: data.personalPhone ?? null,
              address: normalizeAddress(data.address),
              emergencyContact: data.emergencyContact ?? null,
              createdBy: ctx.userId,
              updatedBy: ctx.userId,
            },
          ],
          { session: db },
        );
        person = created!.toObject() as PersonDoc;
        await recordStaffAudit(scope, db, {
          entityType: 'person',
          entityId: person._id,
          action: 'person.created',
          changes: classifiedDiff('person', {}, person, PERSON_EDITABLE_FIELDS),
          employeeId: newEmployeeId,
        });
      }

      const [createdEmployee] = await Employee.create(
        [
          {
            _id: newEmployeeId,
            tenantId: ctx.tenantId,
            personId: person._id,
            schoolId: school._id,
            employeeCode: data.employeeCode,
            employeeCategory: data.employeeCategory,
            employmentType: data.employmentType ?? null,
            joiningDate: data.joiningDate,
            confirmationDate: data.confirmationDate ?? null,
            departmentId: data.departmentId,
            designationId: data.designationId,
            reportingManagerId: data.reportingManagerId ?? null,
            officialEmail: data.officialEmail ?? null,
            officialPhone: data.officialPhone ?? null,
            status: 'ONBOARDING',
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      const employee = createdEmployee!.toObject() as EmployeeDoc;
      await recordStaffAudit(scope, db, {
        entityType: 'employee',
        entityId: employee._id,
        action: 'employee.created',
        changes: classifiedDiff('employee', {}, employee, EMPLOYEE_AUDIT_FIELDS),
        employeeId: employee._id,
        metadata: { personId: person._id, rehire: Boolean(data.personId) },
      });

      const [placement] = await LocationAssignment.create(
        [
          {
            tenantId: ctx.tenantId,
            employeeId: employee._id,
            locationId: data.primaryLocationId,
            isPrimary: true,
            effectiveFrom: data.joiningDate,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      await recordStaffAudit(scope, db, {
        entityType: 'location_assignment',
        entityId: placement!._id,
        action: 'location_assignment.created',
        changes: diffFields({}, placement!.toObject(), ['locationId', 'isPrimary', 'effectiveFrom']),
        employeeId: employee._id,
      });
      return employee._id;
    });
    return await profileOf(ctx, await loadEmployee(ctx, employeeId));
  } catch (err) {
    mapDuplicate(err);
  }
}

// ───────────────────────────────────────────────────────────── update

export async function updateEmployee(ctx: ServiceContext, employeeId: string, patch: UpdateEmployeeData): Promise<EmployeeProfileDTO> {
  try {
    await withTransaction(async (db) => {
      const before = await loadEmployee(ctx, employeeId, db);
      assertWritable(before);
      const person = await Person.findOne({ _id: before.personId, tenantId: ctx.tenantId }).session(db).lean<PersonDoc>();
      if (!person) throw AppError.notFound('Person not found.');

      const changes = pickDefined(patch);
      const personPatch = normalizePersonPatch(pick(changes, PERSON_EDITABLE_FIELDS));
      const employeePatch = pick(changes, EMPLOYEE_EDITABLE_FIELDS);
      const mergedPerson = { ...person, ...personPatch } as PersonDoc;
      const mergedEmployee = { ...before, ...employeePatch } as EmployeeDoc;

      const employeeDiff = diffFields(before, mergedEmployee, EMPLOYEE_EDITABLE_FIELDS);
      const personDiff = classifiedDiff('person', person, mergedPerson, PERSON_EDITABLE_FIELDS);
      const changed = new Set(employeeDiff.map((c) => c.field));

      if (changed.has('employeeCategory')) {
        const scope = { tenantId: ctx.tenantId, employeeId };
        const [academic, responsibility] = await Promise.all([AcademicAssignment.exists(scope).session(db), Responsibility.exists(scope).session(db)]);
        if (academic || responsibility) {
          throw new AppError('EMPLOYEE_CATEGORY_MISMATCH', 'The category cannot change once classes or responsibilities have been assigned.', {
            fields: { employeeCategory: 'Locked because assignments exist.' },
          });
        }
      }
      if (changed.has('departmentId')) await requireActiveMaster(ctx, 'department', mergedEmployee.departmentId, 'departmentId', db);
      if (changed.has('designationId')) await requireActiveMaster(ctx, 'designation', mergedEmployee.designationId, 'designationId', db);
      if (changed.has('reportingManagerId') && mergedEmployee.reportingManagerId) {
        await assertValidManager(ctx, mergedEmployee.reportingManagerId, employeeId, db);
      }
      if (changed.has('joiningDate') || changed.has('confirmationDate')) assertEmploymentDates(mergedEmployee.joiningDate, mergedEmployee.confirmationDate);
      if (changed.has('joiningDate')) await moveFirstPlacement(ctx, employeeId, before.joiningDate, mergedEmployee.joiningDate, db);

      const scope = auditScopeOf(ctx);
      if (personDiff.length > 0) {
        const $set: Record<string, unknown> = { updatedBy: ctx.userId };
        for (const c of personDiff) $set[c.field] = (mergedPerson as unknown as Record<string, unknown>)[c.field];
        await Person.updateOne({ _id: person._id, tenantId: ctx.tenantId }, { $set }, { session: db });
        await recordStaffAudit(scope, db, { entityType: 'person', entityId: person._id, action: 'person.updated', changes: personDiff, employeeId });
      }
      if (employeeDiff.length > 0) {
        const $set: Record<string, unknown> = { updatedBy: ctx.userId };
        for (const c of employeeDiff) $set[c.field] = (mergedEmployee as unknown as Record<string, unknown>)[c.field];
        await Employee.updateOne({ _id: employeeId, tenantId: ctx.tenantId }, { $set }, { session: db });
        await recordStaffAudit(scope, db, { entityType: 'employee', entityId: employeeId, action: 'employee.updated', changes: employeeDiff, employeeId });
      }
    });
  } catch (err) {
    mapDuplicate(err);
  }
  return profileOf(ctx, await loadEmployee(ctx, employeeId));
}

/** Correcting the joining date moves the first placement with it, so the two never disagree. */
async function moveFirstPlacement(ctx: ServiceContext, employeeId: string, from: string, to: string, db: ClientSession) {
  const first = await LocationAssignment.findOne({ tenantId: ctx.tenantId, employeeId, isPrimary: true, cancelledAt: null, effectiveFrom: from })
    .session(db)
    .lean<{ _id: string; effectiveTo: string | null }>();
  if (!first) return;
  if (first.effectiveTo && to > first.effectiveTo) {
    throw AppError.validation({ joiningDate: 'The joining date cannot be after the end of the first placement.' });
  }
  await LocationAssignment.updateOne({ _id: first._id, tenantId: ctx.tenantId }, { $set: { effectiveFrom: to, updatedBy: ctx.userId } }, { session: db });
  await recordStaffAudit(auditScopeOf(ctx), db, {
    entityType: 'location_assignment',
    entityId: first._id,
    action: 'location_assignment.updated',
    changes: [{ field: 'effectiveFrom', from, to }],
    employeeId,
    metadata: { reason: 'JOINING_DATE_CORRECTED' },
  });
}

// ───────────────────────────────────────────────────────────── delete

/** Only an ONBOARDING employee with nothing recorded against them. Everyone else exits, and keeps their history. */
export async function deleteEmployee(ctx: ServiceContext, employeeId: string): Promise<void> {
  await withTransaction(async (db) => {
    const employee = await loadEmployee(ctx, employeeId, db);
    if (!(await isDeletable(ctx, employee, db))) throw new AppError('EMPLOYEE_HAS_HISTORY');

    await LocationAssignment.deleteMany({ tenantId: ctx.tenantId, employeeId }, { session: db });
    await Employee.deleteOne({ _id: employeeId, tenantId: ctx.tenantId }, { session: db });
    // The person goes too unless they have other employments (an earlier stint at the school).
    const others = await Employee.exists({ tenantId: ctx.tenantId, personId: employee.personId }).session(db);
    if (!others) await Person.deleteOne({ _id: employee.personId, tenantId: ctx.tenantId }, { session: db });

    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'employee',
      entityId: employeeId,
      action: 'employee.deleted',
      changes: diffFields(employee, {}, ['employeeCode', 'employeeCategory']),
      employeeId,
      metadata: { personRemoved: !others },
    });
  });
}

