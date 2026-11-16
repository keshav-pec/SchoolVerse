import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import {
  CHANGE_FIELD_LABELS,
  GOVERNMENT_ID_LABELS,
  PERSON_EDITABLE_FIELDS,
  type ChangeRequestValue,
  type CreateChangeRequestData,
  type DecideChangeRequestData,
  type ListChangeRequestsQuery,
  type ProfileChangeRequestDTO,
} from '@shared';
import { AppError } from '../../core/errors';
import { toIso } from '../../core/objects';
import { duplicateKeyFields } from '../../db/errors';
import { withTransaction } from '../../db/transaction';
import { decryptField, encryptField, mask } from '../../platform/identity/crypto';
import { saveRestricted } from '../../platform/identity/restricted-data';
import { RestrictedPersonData, type RestrictedPersonDataDoc } from '../../platform/identity/restricted-data.model';
import type { ServiceContext } from '../../platform/rbac/tenant-context';
import { User } from '../../platform/users/user.model';
import { REDACTED } from '@shared';
import { auditScopeOf, classifiedDiff, recordStaffAudit } from './audit';
import { Employee, type EmployeeDoc } from './employee.model';
import { assertWritable, loadEmployee, loadPerson } from './guards';
import { requireCaller } from './self-access';
import { ProfileChangeRequest, type ProfileChangeRequestDoc } from './identity.models';
import { fullNameOf } from './mappers';
import { Person, type PersonDoc } from './person.model';

/**
 * FSM-07 — changes an employee cannot make directly (legal name, date of birth, government ID, bank details) are requested,
 * stored encrypted, shown to approvers masked, and applied in the same transaction as the approval.
 */

const context = (requestId: string) => `change-request:${requestId}`;

function open(doc: ProfileChangeRequestDoc): ChangeRequestValue {
  return JSON.parse(decryptField(doc.proposedValueEnc, context(doc._id))) as ChangeRequestValue;
}

// ───────────────────────────────────────────────────────────── display

function currentDisplay(doc: ProfileChangeRequestDoc, person: PersonDoc, restricted: RestrictedPersonDataDoc | null): string | null {
  switch (doc.fieldCategory) {
    case 'LEGAL_NAME':
      return fullNameOf(person);
    case 'DATE_OF_BIRTH':
      return person.dateOfBirth ? mask(person.dateOfBirth, 'DATE_OF_BIRTH') : null;
    case 'GOVERNMENT_ID': {
      const type = (open(doc) as { type: keyof typeof GOVERNMENT_ID_LABELS }).type;
      const held = restricted?.governmentIds.find((g) => g.type === type);
      return held ? `${GOVERNMENT_ID_LABELS[type]} ${mask(held.last4, 'GOVERNMENT_ID')}` : null;
    }
    case 'BANK_DETAILS':
      return restricted?.bank ? `${restricted.bank.bankName} ${mask(restricted.bank.last4, 'BANK_ACCOUNT')} · ${restricted.bank.ifsc}` : null;
  }
}

/** Legal names are shown in full (an approver has to see them); every other proposed value is masked. */
function proposedDisplay(doc: ProfileChangeRequestDoc): string {
  const value = open(doc) as Record<string, string | null | undefined>;
  switch (doc.fieldCategory) {
    case 'LEGAL_NAME':
      return [value.legalFirstName, value.legalMiddleName, value.legalLastName].filter(Boolean).join(' ');
    case 'DATE_OF_BIRTH':
      return mask(value.dateOfBirth as string, 'DATE_OF_BIRTH');
    case 'GOVERNMENT_ID':
      return `${GOVERNMENT_ID_LABELS[value.type as keyof typeof GOVERNMENT_ID_LABELS]} ${mask(value.value as string, 'GOVERNMENT_ID')}`;
    case 'BANK_DETAILS':
      return `${value.bankName} ${mask(value.accountNumber as string, 'BANK_ACCOUNT')} · ${value.ifsc}`;
  }
}

async function toDTOs(ctx: ServiceContext, docs: ProfileChangeRequestDoc[]): Promise<ProfileChangeRequestDTO[]> {
  if (docs.length === 0) return [];
  const tenantId = ctx.tenantId;
  const employeeIds = [...new Set(docs.map((d) => d.employeeId))];
  const personIds = [...new Set(docs.map((d) => d.personId))];
  const deciderIds = [...new Set(docs.map((d) => d.decidedBy).filter((id): id is string => Boolean(id)))];
  const [employees, people, restricted, deciders] = await Promise.all([
    Employee.find({ tenantId, _id: { $in: employeeIds } }).select('employeeCode').lean<Pick<EmployeeDoc, '_id' | 'employeeCode'>[]>(),
    Person.find({ tenantId, _id: { $in: personIds } }).lean<PersonDoc[]>(),
    RestrictedPersonData.find({ tenantId, personId: { $in: personIds } }).lean<RestrictedPersonDataDoc[]>(),
    deciderIds.length ? User.find({ tenantId, _id: { $in: deciderIds } }).select('fullName').lean<{ _id: string; fullName: string }[]>() : Promise.resolve([]),
  ]);
  const codeOf = new Map(employees.map((e) => [e._id, e.employeeCode]));
  const personOf = new Map(people.map((p) => [p._id, p]));
  const restrictedOf = new Map(restricted.map((r) => [r.personId, r]));
  const deciderName = new Map(deciders.map((u) => [u._id, u.fullName]));

  return docs.map((d) => {
    const person = personOf.get(d.personId)!;
    return {
      changeRequestId: d._id,
      employeeId: d.employeeId,
      employeeCode: codeOf.get(d.employeeId) ?? '',
      employeeName: fullNameOf(person),
      fieldCategory: d.fieldCategory,
      status: d.status,
      currentDisplay: currentDisplay(d, person, restrictedOf.get(d.personId) ?? null),
      proposedDisplay: proposedDisplay(d),
      reason: d.reason ?? null,
      requestedAt: toIso(d.createdAt)!,
      decidedAt: toIso(d.decidedAt),
      decidedByName: d.decidedBy ? deciderName.get(d.decidedBy) ?? null : null,
      decisionNote: d.decisionNote ?? null,
    };
  });
}

// ───────────────────────────────────────────────────────────── the employee's side

export async function createChangeRequest(ctx: ServiceContext, data: CreateChangeRequestData): Promise<ProfileChangeRequestDTO> {
  const id = randomUUID();
  try {
    await withTransaction(async (db) => {
      const { employee } = await requireCaller(ctx, db);
      assertWritable(employee);
      await ProfileChangeRequest.create(
        [
          {
            _id: id,
            tenantId: ctx.tenantId,
            employeeId: employee._id,
            personId: employee.personId,
            fieldCategory: data.fieldCategory,
            proposedValueEnc: encryptField(JSON.stringify(data.value), context(id)),
            reason: data.reason ?? null,
            createdBy: ctx.userId,
            updatedBy: ctx.userId,
          },
        ],
        { session: db },
      );
      await recordStaffAudit(auditScopeOf(ctx), db, {
        entityType: 'profile_change_request',
        entityId: id,
        action: 'change_request.created',
        employeeId: employee._id,
        // The category only: the value is the thing being protected.
        metadata: { fieldCategory: data.fieldCategory },
      });
    });
  } catch (err) {
    if (duplicateKeyFields(err)?.includes('fieldCategory')) throw new AppError('CHANGE_REQUEST_PENDING');
    throw err;
  }
  return (await toDTOs(ctx, [(await ProfileChangeRequest.findOne({ _id: id, tenantId: ctx.tenantId }).lean<ProfileChangeRequestDoc>())!]))[0]!;
}

export async function listOwnChangeRequests(ctx: ServiceContext): Promise<ProfileChangeRequestDTO[]> {
  const { employee } = await requireCaller(ctx);
  const docs = await ProfileChangeRequest.find({ tenantId: ctx.tenantId, employeeId: employee._id }).sort({ createdAt: -1 }).limit(50).lean<ProfileChangeRequestDoc[]>();
  return toDTOs(ctx, docs);
}

export async function listPendingForEmployee(ctx: ServiceContext, employeeId: string): Promise<ProfileChangeRequestDTO[]> {
  const docs = await ProfileChangeRequest.find({ tenantId: ctx.tenantId, employeeId, status: 'PENDING' }).sort({ createdAt: -1 }).lean<ProfileChangeRequestDoc[]>();
  return toDTOs(ctx, docs);
}

export async function cancelOwnChangeRequest(ctx: ServiceContext, requestId: string): Promise<ProfileChangeRequestDTO> {
  await withTransaction(async (db) => {
    const { employee } = await requireCaller(ctx, db);
    const doc = await ProfileChangeRequest.findOne({ _id: requestId, tenantId: ctx.tenantId, employeeId: employee._id }).session(db).lean<ProfileChangeRequestDoc>();
    if (!doc) throw AppError.notFound('Request not found.');
    if (doc.status !== 'PENDING') throw new AppError('CHANGE_REQUEST_CLOSED');
    await ProfileChangeRequest.updateOne({ _id: doc._id, tenantId: ctx.tenantId }, { $set: { status: 'CANCELLED', decidedAt: new Date(), updatedBy: ctx.userId } }, { session: db });
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'profile_change_request',
      entityId: doc._id,
      action: 'change_request.cancelled',
      employeeId: employee._id,
      metadata: { fieldCategory: doc.fieldCategory },
    });
  });
  return (await toDTOs(ctx, [(await ProfileChangeRequest.findOne({ _id: requestId, tenantId: ctx.tenantId }).lean<ProfileChangeRequestDoc>())!]))[0]!;
}

// ───────────────────────────────────────────────────────────── the approver's side

export async function listChangeRequests(ctx: ServiceContext, query: ListChangeRequestsQuery): Promise<ProfileChangeRequestDTO[]> {
  const docs = await ProfileChangeRequest.find({ tenantId: ctx.tenantId, ...(query.status ? { status: query.status } : {}) })
    .sort({ createdAt: -1 })
    .limit(200)
    .lean<ProfileChangeRequestDoc[]>();
  return toDTOs(ctx, docs);
}

/** Applies the approved value to the person or the restricted record, with an audit row that never holds the value. */
async function applyChange(ctx: ServiceContext, doc: ProfileChangeRequestDoc, db: ClientSession) {
  const scope = auditScopeOf(ctx);
  const value = open(doc) as Record<string, string | null | undefined> & ChangeRequestValue;
  const base = { employeeId: doc.employeeId };

  if (doc.fieldCategory === 'LEGAL_NAME' || doc.fieldCategory === 'DATE_OF_BIRTH') {
    const person = await loadPerson(ctx.tenantId, doc.personId, db);
    const patch =
      doc.fieldCategory === 'LEGAL_NAME'
        ? { legalFirstName: value.legalFirstName, legalMiddleName: value.legalMiddleName ?? null, legalLastName: value.legalLastName }
        : { dateOfBirth: value.dateOfBirth };
    const after = { ...person, ...patch };
    await Person.updateOne({ _id: person._id, tenantId: ctx.tenantId }, { $set: { ...patch, updatedBy: ctx.userId } }, { session: db });
    await recordStaffAudit(scope, db, {
      entityType: 'person',
      entityId: person._id,
      action: 'person.updated',
      changes: classifiedDiff('person', person, after, PERSON_EDITABLE_FIELDS),
      metadata: { viaChangeRequest: doc._id },
      ...base,
    });
    return;
  }

  if (doc.fieldCategory === 'GOVERNMENT_ID') {
    const id = value as unknown as { type: 'AADHAAR'; value: string };
    await saveRestricted(ctx.tenantId, doc.personId, { governmentIds: [{ type: id.type, value: id.value }] }, ctx.userId, db);
    await recordStaffAudit(scope, db, {
      entityType: 'restricted_data',
      entityId: doc.personId,
      action: 'restricted.updated',
      changes: [{ field: `governmentIds.${id.type}`, from: REDACTED, to: REDACTED }],
      metadata: { viaChangeRequest: doc._id },
      ...base,
    });
    return;
  }

  await saveRestricted(ctx.tenantId, doc.personId, { bank: value as never }, ctx.userId, db);
  await recordStaffAudit(scope, db, {
    entityType: 'restricted_data',
    entityId: doc.personId,
    action: 'restricted.updated',
    changes: [{ field: 'bank', from: REDACTED, to: REDACTED }],
    metadata: { viaChangeRequest: doc._id },
    ...base,
  });
}

async function decide(ctx: ServiceContext, requestId: string, outcome: 'APPROVED' | 'REJECTED', data: DecideChangeRequestData): Promise<ProfileChangeRequestDTO> {
  await withTransaction(async (db) => {
    const doc = await ProfileChangeRequest.findOne({ _id: requestId, tenantId: ctx.tenantId }).session(db).lean<ProfileChangeRequestDoc>();
    if (!doc) throw AppError.notFound('Request not found.');
    if (doc.status !== 'PENDING') throw new AppError('CHANGE_REQUEST_CLOSED');

    // Nobody approves a change to their own bank account.
    const approver = await User.findOne({ _id: ctx.userId, tenantId: ctx.tenantId }).select('personId').session(db).lean<{ personId?: string | null }>();
    if (approver?.personId && approver.personId === doc.personId) throw new AppError('CANNOT_DECIDE_OWN_REQUEST');

    if (outcome === 'APPROVED') {
      assertWritable(await loadEmployee(ctx, doc.employeeId, db));
      await applyChange(ctx, doc, db);
    }
    await ProfileChangeRequest.updateOne(
      { _id: doc._id, tenantId: ctx.tenantId, status: 'PENDING' },
      { $set: { status: outcome, decidedBy: ctx.userId, decidedAt: new Date(), decisionNote: data.note ?? null, updatedBy: ctx.userId } },
      { session: db },
    );
    await recordStaffAudit(auditScopeOf(ctx), db, {
      entityType: 'profile_change_request',
      entityId: doc._id,
      action: outcome === 'APPROVED' ? 'change_request.approved' : 'change_request.rejected',
      employeeId: doc.employeeId,
      metadata: { fieldCategory: doc.fieldCategory, categoryLabel: CHANGE_FIELD_LABELS[doc.fieldCategory] },
    });
  });
  return (await toDTOs(ctx, [(await ProfileChangeRequest.findOne({ _id: requestId, tenantId: ctx.tenantId }).lean<ProfileChangeRequestDoc>())!]))[0]!;
}

export const approveChangeRequest = (ctx: ServiceContext, requestId: string, data: DecideChangeRequestData) => decide(ctx, requestId, 'APPROVED', data);
export const rejectChangeRequest = (ctx: ServiceContext, requestId: string, data: DecideChangeRequestData) => decide(ctx, requestId, 'REJECTED', data);
