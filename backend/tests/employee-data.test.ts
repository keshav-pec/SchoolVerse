import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { pino } from 'pino';
import type { EmployeeDocumentDTO, ExportResultDTO, ProfileChangeRequestDTO, RestrictedEmployeeProfileDTO, RevealedValueDTO, SelfProfileDTO } from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { SKIP_TENANT_SCOPE } from '../src/db/plugins/tenant-scope';
import { REDACT_CENSOR, REDACT_PATHS, redactUrl } from '../src/core/logger';
import { Employee } from '../src/modules/staff/employee.model';
import { cleanupExpiredExports } from '../src/modules/staff/export.service';
import { EmployeeDocument, ProfileChangeRequest, StaffExport } from '../src/modules/staff/identity.models';
import { Person } from '../src/modules/staff/person.model';
import { signFileToken } from '../src/platform/identity/crypto';
import { DevOutbox } from '../src/platform/identity/notifier';
import { privateStorage } from '../src/platform/identity/private-storage';
import { readValue } from '../src/platform/identity/restricted-data';
import { RestrictedPersonData } from '../src/platform/identity/restricted-data.model';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { User } from '../src/platform/users/user.model';
import { DEMO_PASSWORD, seedDemo } from '../src/scripts/seed';
import {
  activatedLogin,
  addActiveEmployee,
  addEmployee,
  API,
  app,
  createUserAndLogin,
  download,
  expectError,
  linkUser,
  loginAs,
  PASSWORD,
  PDF,
  PNG,
  restrictedBody,
  SECRETS,
  staffSchool,
  stepUp,
  today,
  uploadDocument,
  useTestDatabase,
  type StaffSchool,
} from './helpers';

useTestDatabase();

const data = <T>(res: { body: { data: T } }) => res.body.data;

/** An active employee with restricted details on file and a date of birth, plus a login for them. */
async function withRestricted(t: StaffSchool, overrides: Record<string, unknown> = {}) {
  const employee = await addActiveEmployee(t, { dateOfBirth: '1988-03-14', ...overrides });
  await stepUp(t.agent);
  await t.agent.put(`${API}/employees/${employee.employeeId}/restricted`).send(restrictedBody).expect(200);
  return employee;
}

const everyStore = async (tenantId: string) =>
  JSON.stringify([
    await AuditEvent.find({ tenantId }).lean(),
    await SecurityEvent.find({ tenantId }).lean(),
    await DevOutbox.find({}).setOptions(SKIP_TENANT_SCOPE).lean(),
  ]);

describe('restricted data: mask, reveal, update (SEC-02)', () => {
  it('QA S3: lists and profiles carry no restricted keys at all, and the restricted profile is masked', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t);

    const surfaces = [
      (await t.agent.get(`${API}/employees`).expect(200)).body,
      (await t.agent.get(`${API}/employees/${employee.employeeId}`).expect(200)).body,
      (await t.agent.get(`${API}/employees/${employee.employeeId}/history`).expect(200)).body,
    ];
    for (const [i, body] of surfaces.entries()) {
      const text = JSON.stringify(body);
      // The history timeline names which restricted detail changed (that is the point of an audit trail); lists and profiles carry no such keys.
      if (i < 2) expect(text).not.toMatch(/dateOfBirth|governmentIds|accountNumber|"bank"|valueEnc|1988-03-14/);
      for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account, '1988-03-14']) expect(text).not.toContain(secret);
    }

    const masked = data<RestrictedEmployeeProfileDTO>(await t.agent.get(`${API}/employees/${employee.employeeId}/restricted`).expect(200));
    expect(masked.dateOfBirth).toEqual({ masked: '••/••/1988' });
    expect(masked.governmentIds).toEqual([
      { type: 'PAN', masked: 'XXXX XXXX 999X' },
      { type: 'AADHAAR', masked: 'XXXX XXXX 1234' },
    ]);
    expect(masked.bank).toEqual({ accountHolderName: 'Test Person', accountNumberMasked: '•••• 5678', ifsc: SECRETS.ifsc, bankName: 'Demo Bank' });
    const text = JSON.stringify(masked);
    for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account, '1988-03-14']) expect(text).not.toContain(secret);
  });

  it('values are encrypted at rest, per field, and an exited employee’s details stay readable', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t);
    const raw = JSON.stringify(await RestrictedPersonData.findOne({ tenantId: t.tenantId, personId: employee.personId }).lean());
    for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account]) expect(raw).not.toContain(secret);
    expect(raw).toMatch(/"valueEnc":"dev1:[\w-]+:[\w-]+:[\w-]+"/);
    // Only the last four characters are kept in the clear, to mask without decrypting.
    expect(raw).toContain('"last4":"5678"');

    await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'RESIGNATION' }).expect(200);
    await t.agent.get(`${API}/employees/${employee.employeeId}/restricted`).expect(200);
    await stepUp(t.agent);
    expectError(await t.agent.put(`${API}/employees/${employee.employeeId}/restricted`).send({ bank: null }), 409, 'EMPLOYEE_READ_ONLY');
  });

  it('QA S4: reveal needs the permission and a recent step-up; a reveal is audited without the value', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t, { dateOfBirth: '1990-05-17' });
    const url = `${API}/employees/${employee.employeeId}/restricted/reveal`;

    // No permission: Faculty, Staff and Parents are refused outright.
    for (const role of ['FACULTY', 'STAFF', 'PARENT'] as const) {
      const other = await createUserAndLogin(t.tenantId, role);
      await stepUp(other.agent);
      expectError(await other.agent.post(url).send({ field: 'BANK_ACCOUNT_NUMBER' }), 403, 'FORBIDDEN');
    }
    // The permission alone is not enough.
    const fresh = request.agent(app);
    await fresh.post(`${API}/auth/login`).send({ email: t.email, password: PASSWORD }).expect(200);
    expectError(await fresh.post(url).send({ field: 'BANK_ACCOUNT_NUMBER' }), 403, 'STEP_UP_REQUIRED');

    await stepUp(t.agent);
    const revealed = data<RevealedValueDTO>(await t.agent.post(url).send({ field: 'BANK_ACCOUNT_NUMBER' }).expect(200));
    expect(revealed).toEqual({ field: 'BANK_ACCOUNT_NUMBER', value: SECRETS.account, hideAfterSeconds: 30 });
    expect(data<RevealedValueDTO>(await t.agent.post(url).send({ field: 'PAN' }).expect(200)).value).toBe(SECRETS.pan);
    expect(data<RevealedValueDTO>(await t.agent.post(url).send({ field: 'DATE_OF_BIRTH' }).expect(200)).value).toBe('1990-05-17');
    // Nothing recorded for a detail → 404, not an empty value; an unknown field → 400.
    expectError(await t.agent.post(url).send({ field: 'PASSPORT' }), 404, 'NOT_FOUND');
    expectError(await t.agent.post(url).send({ field: 'PASSWORD' }), 400, 'VALIDATION_FAILED');

    const rows = await AuditEvent.find({ tenantId: t.tenantId, action: 'restricted.revealed' }).sort({ occurredAt: 1 }).lean();
    expect(rows.map((r) => r.metadata)).toEqual([
      { employeeId: employee.employeeId, field: 'BANK_ACCOUNT_NUMBER', outcome: 'SUCCESS' },
      { employeeId: employee.employeeId, field: 'PAN', outcome: 'SUCCESS' },
      { employeeId: employee.employeeId, field: 'DATE_OF_BIRTH', outcome: 'SUCCESS' },
    ]);
    expect(rows.every((r) => r.actorId === t.ctx.userId && r.entityId === employee.personId)).toBe(true);
    const stored = await everyStore(t.tenantId);
    for (const secret of [...Object.values(SECRETS), '1990-05-17']) expect(stored).not.toContain(secret);
  });

  it('PUT adds or replaces IDs by type, removes with null, and its audit rows say "[redacted]" for old and new values', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const url = `${API}/employees/${employee.employeeId}/restricted`;
    expectError(await t.agent.put(url).send(restrictedBody), 403, 'STEP_UP_REQUIRED');
    await stepUp(t.agent);

    await t.agent.put(url).send(restrictedBody).expect(200);
    // Only the bank changes: the IDs stay.
    const second = { bank: { ...restrictedBody.bank, accountNumber: '000000009999' } };
    const afterBank = data<RestrictedEmployeeProfileDTO>(await t.agent.put(url).send(second).expect(200));
    expect(afterBank.bank?.accountNumberMasked).toBe('•••• 9999');
    expect(afterBank.governmentIds).toHaveLength(2);
    // Replace one ID, remove another.
    const afterIds = data<RestrictedEmployeeProfileDTO>(await t.agent.put(url).send({ governmentIds: [{ type: 'PAN', value: 'TESTQ1111Z' }, { type: 'AADHAAR', value: null }] }).expect(200));
    expect(afterIds.governmentIds).toEqual([{ type: 'PAN', masked: 'XXXX XXXX 111Z' }]);
    expect(data<RestrictedEmployeeProfileDTO>(await t.agent.put(url).send({ bank: null }).expect(200)).bank).toBeNull();

    const rows = await AuditEvent.find({ tenantId: t.tenantId, action: 'restricted.updated' }).lean();
    expect(rows).toHaveLength(4);
    expect(rows.flatMap((r) => r.changes)).toEqual(expect.arrayContaining([{ field: 'bank', from: '[redacted]', to: '[redacted]' }, { field: 'governmentIds.PAN', from: '[redacted]', to: '[redacted]' }]));
    const stored = await everyStore(t.tenantId);
    for (const secret of [...Object.values(SECRETS), 'TESTQ1111Z', '000000009999']) expect(stored).not.toContain(secret);
  });

  it('PUT validates what it is given: formats, duplicates, unknown keys and an empty body', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const url = `${API}/employees/${employee.employeeId}/restricted`;
    await stepUp(t.agent);
    for (const body of [
      {},
      { governmentIds: [{ type: 'AADHAAR', value: '12345' }] },
      { governmentIds: [{ type: 'PAN', value: 'A' }] },
      { governmentIds: [{ type: 'PAN', value: 'TESTP1111X' }, { type: 'PAN', value: 'TESTP2222X' }] },
      { governmentIds: [{ type: 'LIBRARY_CARD', value: 'TESTP1111X' }] },
      { bank: { ...restrictedBody.bank, ifsc: 'NOPE' } },
      { bank: { ...restrictedBody.bank, accountNumber: '12' } },
      { bank: restrictedBody.bank, role: 'SCHOOL_ADMIN' },
    ]) {
      expectError(await t.agent.put(url).send(body), 400, 'VALIDATION_FAILED');
    }
    // Spaces and hyphens typed for readability are dropped.
    const ok = data<RestrictedEmployeeProfileDTO>(await t.agent.put(url).send({ governmentIds: [{ type: 'AADHAAR', value: '0000 0000 1234' }] }).expect(200));
    expect(ok.governmentIds).toEqual([{ type: 'AADHAAR', masked: 'XXXX XXXX 1234' }]);
    // Faculty cannot reach the route at all.
    const faculty = await loginAs(t, 'FACULTY', employee);
    await stepUp(faculty.agent);
    expectError(await faculty.agent.put(url).send(restrictedBody), 403, 'FORBIDDEN');
  });

  it('QA S1: Faculty cannot read another employee’s restricted profile by UUID, nor their own through the admin route', async () => {
    const t = await staffSchool();
    const victim = await withRestricted(t);
    const mine = await addActiveEmployee(t);
    const faculty = await loginAs(t, 'FACULTY', mine);
    for (const id of [victim.employeeId, mine.employeeId]) {
      expectError(await faculty.agent.get(`${API}/employees/${id}/restricted`), 403, 'FORBIDDEN');
      expectError(await faculty.agent.get(`${API}/employees/${id}/documents`), 403, 'FORBIDDEN');
      expectError(await faculty.agent.get(`${API}/employees/${id}/user-account`), 403, 'FORBIDDEN');
    }
  });

  it('QA S2: another school’s admin gets 404 for restricted data, documents, logins and requests by UUID', async () => {
    const a = await staffSchool('School A');
    const employee = await withRestricted(a);
    await uploadDocument(a.agent, `${API}/employees/${employee.employeeId}/documents`).expect(201);
    const doc = (await EmployeeDocument.findOne({ tenantId: a.tenantId }).lean())!;
    const person = await loginAs(a, 'FACULTY', employee);
    const request1 = data<ProfileChangeRequestDTO>(await person.agent.post(`${API}/me/profile-change-requests`).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '1991-01-01' } }).expect(201));

    const b = await staffSchool('School B');
    await stepUp(b.agent);
    const e = `${API}/employees/${employee.employeeId}`;
    for (const res of [
      await b.agent.get(`${e}/restricted`),
      await b.agent.post(`${e}/restricted/reveal`).send({ field: 'PAN' }),
      await b.agent.put(`${e}/restricted`).send(restrictedBody),
      await b.agent.get(`${e}/documents`),
      await uploadDocument(b.agent, `${e}/documents`),
      await b.agent.post(`${API}/employee-documents/${doc._id}/download`),
      await b.agent.delete(`${API}/employee-documents/${doc._id}`),
      await b.agent.get(`${e}/user-account`),
      await b.agent.post(`${e}/user-account`).send({ role: 'FACULTY', email: 'x@greenfield.demo' }),
      await b.agent.post(`${API}/profile-change-requests/${request1.changeRequestId}/approve`).send({}),
      await b.agent.post(`${API}/profile-change-requests/${request1.changeRequestId}/reject`).send({ note: 'no' }),
      await b.agent.post(`${API}/users/${person.userId}/suspend`).send({ reason: 'x' }),
    ]) {
      expectError(res, 404, 'NOT_FOUND');
    }
    expect((await b.agent.get(`${API}/profile-change-requests`).expect(200)).body.data).toEqual([]);
    // Nothing of school A changed.
    expect(await EmployeeDocument.countDocuments({ tenantId: a.tenantId, status: 'ACTIVE' })).toBe(1);
    expect((await User.findOne({ _id: person.userId, tenantId: a.tenantId }).lean())?.status).toBe('ACTIVE');
  });
});

describe('self-service profile (FSM-06)', () => {
  it('QA F6: the self profile returns the employee’s own record, personal contact and masked restricted values — nothing else', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t, { personalEmail: 'me.personal@greenfield.demo', legalFirstName: 'Priya' });
    const login = await loginAs(t, 'FACULTY', employee);

    const me = data<SelfProfileDTO>(await login.agent.get(`${API}/me/profile`).expect(200));
    expect(me.profile).toMatchObject({ employeeId: employee.employeeId, fullName: 'Priya Person' });
    // Faculty have no `employee:view_personal`, but their own personal contact is theirs.
    expect(me.profile.personal?.personalEmail).toBe('me.personal@greenfield.demo');
    expect(me.dateOfBirth).toBe('1988-03-14');
    expect(me.restricted.bank?.accountNumberMasked).toBe('•••• 5678');
    expect(me.account).toMatchObject({ role: 'FACULTY', status: 'ACTIVE', personId: employee.personId });
    expect(me.locationAssignments).toHaveLength(1);

    const text = JSON.stringify(me);
    for (const secret of [SECRETS.pan, SECRETS.aadhaar, SECRETS.account]) expect(text).not.toContain(secret);
    expect(text).not.toMatch(/passwordHash|tokenHash|valueEnc|objectKey|sha256/);
    // The same call by a login with no employee (the admin, a parent) has no profile.
    expectError(await t.agent.get(`${API}/me/profile`), 404, 'NO_EMPLOYEE_PROFILE');
    const parent = await createUserAndLogin(t.tenantId, 'PARENT');
    expectError(await parent.agent.get(`${API}/me/profile`), 404, 'NO_EMPLOYEE_PROFILE');
  });

  it('QA S11: a self PATCH changes only the low-risk details; role, status, names and restricted keys are rejected', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const login = await loginAs(t, 'FACULTY', employee);

    for (const body of [
      { role: 'SCHOOL_ADMIN' },
      { status: 'ACTIVE' },
      { legalFirstName: 'Hacker' },
      { dateOfBirth: '1990-01-01' },
      { governmentIds: [{ type: 'PAN', value: SECRETS.pan }] },
      { bank: restrictedBody.bank },
      { employeeCode: 'ADM-1' },
      { tenantId: t.tenantId },
      { personId: employee.personId },
      { officialEmail: 'boss@greenfield.demo' },
    ]) {
      expectError(await login.agent.patch(`${API}/me/profile`).send(body), 400, 'VALIDATION_FAILED');
    }
    expect((await User.findOne({ _id: login.userId, tenantId: t.tenantId }).lean())?.role).toBe('FACULTY');

    const patched = data<SelfProfileDTO>(
      await login.agent.patch(`${API}/me/profile`).send({ preferredName: 'Pri', personalPhone: '+91 98140 55555', address: { city: 'Mohali' }, emergencyContact: { name: 'Raj', relation: 'Spouse', phone: '+91 98140 66666' } }).expect(200),
    );
    expect(patched.profile.displayName).toBe('Pri');
    expect(patched.profile.personal).toMatchObject({ personalPhone: expect.any(String), address: { city: 'Mohali' }, emergencyContact: { name: 'Raj' } });

    // Personal values are written to the audit trail as "[redacted]"; the preferred name is ordinary working data.
    const row = (await AuditEvent.findOne({ tenantId: t.tenantId, action: 'profile.self_updated' }).lean())!;
    const byField = Object.fromEntries(row.changes.map((c) => [c.field, c]));
    expect(byField.preferredName).toMatchObject({ to: 'Pri' });
    expect(byField.personalPhone).toEqual({ field: 'personalPhone', from: '[redacted]', to: '[redacted]' });
    expect(row.actorId).toBe(login.userId);
  });

  it('an exited employee’s login is gone, and nobody edits an employee who has left', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const login = await activatedLogin(t, employee);
    await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'OTHER' }).expect(200);
    expectError(await login.agent.patch(`${API}/me/profile`).send({ preferredName: 'Ghost' }), 401, 'SESSION_EXPIRED');
  });
});

describe('profile change approval (FSM-07)', () => {
  it('QA F7: legal name, date of birth and bank details go through approval and apply only when approved', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t, { legalFirstName: 'Priya', legalLastName: 'Sharma' });
    const login = await loginAs(t, 'FACULTY', employee);
    const mine = `${API}/me/profile-change-requests`;

    // Legal name.
    const nameReq = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Priya', legalLastName: 'Verma' }, reason: 'Marriage' }).expect(201));
    expect(nameReq).toMatchObject({ status: 'PENDING', currentDisplay: 'Priya Sharma', proposedDisplay: 'Priya Verma', reason: 'Marriage', employeeCode: employee.employeeCode });
    // Nothing has changed yet, and a second request for the same detail is refused.
    expect((await t.agent.get(`${API}/employees/${employee.employeeId}`).expect(200)).body.data.fullName).toBe('Priya Sharma');
    expectError(await login.agent.post(mine).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Priya', legalLastName: 'Other' } }), 409, 'CHANGE_REQUEST_PENDING');

    // The approver’s inbox shows it; the employee cannot decide their own request.
    const inbox = data<ProfileChangeRequestDTO[]>(await t.agent.get(`${API}/profile-change-requests`).query({ status: 'PENDING' }).expect(200));
    expect(inbox.map((r) => r.changeRequestId)).toEqual([nameReq.changeRequestId]);
    expectError(await login.agent.post(`${API}/profile-change-requests/${nameReq.changeRequestId}/approve`).send({}), 403, 'FORBIDDEN');
    expectError(await login.agent.get(`${API}/profile-change-requests`), 403, 'FORBIDDEN');

    const approved = data<ProfileChangeRequestDTO>(await t.agent.post(`${API}/profile-change-requests/${nameReq.changeRequestId}/approve`).send({ note: 'Seen the certificate' }).expect(200));
    expect(approved).toMatchObject({ status: 'APPROVED', decisionNote: 'Seen the certificate', decidedByName: 'Ada Admin' });
    expect((await t.agent.get(`${API}/employees/${employee.employeeId}`).expect(200)).body.data.fullName).toBe('Priya Verma');
    expectError(await t.agent.post(`${API}/profile-change-requests/${nameReq.changeRequestId}/approve`).send({}), 409, 'CHANGE_REQUEST_CLOSED');

    // Date of birth: masked for the approver, applied on approval, visible only through restricted APIs.
    const dobReq = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '1989-04-02' } }).expect(201));
    expect(dobReq).toMatchObject({ currentDisplay: '••/••/1988', proposedDisplay: '••/••/1989' });
    await t.agent.post(`${API}/profile-change-requests/${dobReq.changeRequestId}/approve`).send({}).expect(200);
    expect((await Person.findOne({ _id: employee.personId, tenantId: t.tenantId }).lean())?.dateOfBirth).toBe('1989-04-02');

    // Bank details: the password is asked for again, the approver sees them masked, approval re-encrypts them.
    const bank = { accountHolderName: 'Priya Verma', accountNumber: '000000007777', ifsc: 'TEST0000002', bankName: 'Other Demo Bank' };
    expectError(await login.agent.post(mine).send({ fieldCategory: 'BANK_DETAILS', value: bank }), 403, 'STEP_UP_REQUIRED');
    await stepUp(login.agent);
    const bankReq = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'BANK_DETAILS', value: bank }).expect(201));
    expect(bankReq).toMatchObject({ currentDisplay: 'Demo Bank •••• 5678 · TEST0000001', proposedDisplay: 'Other Demo Bank •••• 7777 · TEST0000002' });
    expect(JSON.stringify(bankReq)).not.toContain('000000007777');
    expect(JSON.stringify(await ProfileChangeRequest.find({ tenantId: t.tenantId }).lean())).not.toContain('000000007777');
    // Still pending: the old account is unchanged.
    expect(data<RestrictedEmployeeProfileDTO>(await t.agent.get(`${API}/employees/${employee.employeeId}/restricted`).expect(200)).bank?.accountNumberMasked).toBe('•••• 5678');
    await t.agent.post(`${API}/profile-change-requests/${bankReq.changeRequestId}/approve`).send({}).expect(200);
    await stepUp(t.agent);
    expect(data<RevealedValueDTO>(await t.agent.post(`${API}/employees/${employee.employeeId}/restricted/reveal`).send({ field: 'BANK_ACCOUNT_NUMBER' }).expect(200)).value).toBe('000000007777');

    // Government ID.
    const idReq = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'GOVERNMENT_ID', value: { type: 'PASSPORT', value: 'TEST1234567' } }).expect(201));
    expect(idReq).toMatchObject({ currentDisplay: null, proposedDisplay: 'Passport XXXX XXXX 4567' });
    await t.agent.post(`${API}/profile-change-requests/${idReq.changeRequestId}/approve`).send({}).expect(200);
    expect(data<RestrictedEmployeeProfileDTO>(await t.agent.get(`${API}/employees/${employee.employeeId}/restricted`).expect(200)).governmentIds.map((g) => g.type)).toEqual(['PAN', 'AADHAAR', 'PASSPORT']);

    // Applied changes are audited without the sensitive values; the request ids tie them together.
    const stored = await everyStore(t.tenantId);
    for (const secret of ['000000007777', 'TEST1234567', '1989-04-02', ...Object.values(SECRETS)]) expect(stored).not.toContain(secret);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'change_request.approved' })).toBe(4);
  });

  it('a rejection needs a note and changes nothing; the employee can cancel their own pending request', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t, { legalFirstName: 'Priya' });
    const login = await loginAs(t, 'FACULTY', employee);
    const mine = `${API}/me/profile-change-requests`;

    const req = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Pria', legalLastName: 'Person' } }).expect(201));
    expectError(await t.agent.post(`${API}/profile-change-requests/${req.changeRequestId}/reject`).send({}), 400, 'VALIDATION_FAILED');
    const rejected = data<ProfileChangeRequestDTO>(await t.agent.post(`${API}/profile-change-requests/${req.changeRequestId}/reject`).send({ note: 'Please send the certificate' }).expect(200));
    expect(rejected).toMatchObject({ status: 'REJECTED', decisionNote: 'Please send the certificate' });
    expect((await t.agent.get(`${API}/employees/${employee.employeeId}`).expect(200)).body.data.fullName).toBe('Priya Person');

    // A rejected request frees the slot; cancelling works once.
    const again = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Priya', legalLastName: 'Better' } }).expect(201));
    expect(data<ProfileChangeRequestDTO>(await login.agent.post(`${mine}/${again.changeRequestId}/cancel`).expect(200)).status).toBe('CANCELLED');
    expectError(await login.agent.post(`${mine}/${again.changeRequestId}/cancel`), 409, 'CHANGE_REQUEST_CLOSED');
    expectError(await t.agent.post(`${API}/profile-change-requests/${again.changeRequestId}/approve`).send({}), 409, 'CHANGE_REQUEST_CLOSED');
    expect(data<ProfileChangeRequestDTO[]>(await login.agent.get(mine).expect(200)).map((r) => r.status)).toEqual(['CANCELLED', 'REJECTED']);

    // Someone else’s request is invisible to a colleague: cancel looks like a missing id.
    const colleague = await loginAs(t, 'FACULTY', await addActiveEmployee(t));
    const open = data<ProfileChangeRequestDTO>(await login.agent.post(mine).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '1990-01-01' } }).expect(201));
    expectError(await colleague.agent.post(`${mine}/${open.changeRequestId}/cancel`), 404, 'NOT_FOUND');
    expectError(await login.agent.post(mine).send({ fieldCategory: 'DATE_OF_BIRTH', value: { dateOfBirth: '2999-01-01' } }), 400, 'VALIDATION_FAILED');
  });

  it('an admin linked to an employee cannot approve a change to their own details', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    await linkUser(t.tenantId, t.ctx.userId, employee.personId);
    const own = data<ProfileChangeRequestDTO>(await t.agent.post(`${API}/me/profile-change-requests`).send({ fieldCategory: 'LEGAL_NAME', value: { legalFirstName: 'Ada', legalLastName: 'Self' } }).expect(201));
    expectError(await t.agent.post(`${API}/profile-change-requests/${own.changeRequestId}/approve`).send({}), 409, 'CANNOT_DECIDE_OWN_REQUEST');
    expect((await ProfileChangeRequest.findOne({ _id: own.changeRequestId, tenantId: t.tenantId }).lean())?.status).toBe('PENDING');
  });
});

describe('secure documents (FSM-08)', () => {
  const docsUrl = (employeeId: string) => `${API}/employees/${employeeId}/documents`;

  it('QA S10: wrong type, oversize, EICAR and empty uploads are rejected, and nothing is stored', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const url = docsUrl(employee.employeeId);

    // The client’s MIME type and file name claim a PDF; the bytes are HTML, SVG and an executable.
    for (const bytes of [Buffer.from('<html><script>alert(1)</script></html>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>'), Buffer.from('MZ\x90\x00 not a document')]) {
      expectError(await uploadDocument(t.agent, url, bytes, {}, 'proof.pdf'), 415, 'UNSUPPORTED_DOCUMENT_TYPE');
    }
    expectError(await uploadDocument(t.agent, url, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024)])), 413, 'DOCUMENT_TOO_LARGE');
    // A real PDF header with the antivirus test string inside.
    const eicar = Buffer.concat([PDF, Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*')]);
    expectError(await uploadDocument(t.agent, url, eicar), 422, 'FILE_REJECTED');
    expectError(await t.agent.post(url).field('documentType', 'ID_PROOF'), 400, 'FILE_REQUIRED');
    expectError(await uploadDocument(t.agent, url, PDF, { documentType: 'SELFIE' }), 400, 'VALIDATION_FAILED');

    expect(await EmployeeDocument.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'FILE_REJECTED' })).toBe(4);
    // Faculty are refused before any file is read.
    const faculty = await loginAs(t, 'FACULTY', await addActiveEmployee(t));
    expectError(await uploadDocument(faculty.agent, url), 403, 'FORBIDDEN');
  });

  it('the type comes from the bytes, files get random keys, and the document is listed without any storage detail', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const sent = data<EmployeeDocumentDTO>(await uploadDocument(t.agent, docsUrl(employee.employeeId), PNG, { documentType: 'ADDRESS_PROOF', displayName: 'Electricity bill' }, 'scan.pdf').expect(201));
    expect(sent).toMatchObject({ documentType: 'ADDRESS_PROOF', displayName: 'Electricity bill', mime: 'image/png', sizeBytes: PNG.length });

    const row = (await EmployeeDocument.findOne({ tenantId: t.tenantId }).lean())!;
    expect(row.objectKey).toMatch(/^documents\/[0-9a-f-]{36}$/);
    expect(row.objectKey).not.toContain('scan');
    expect(row.sha256).toHaveLength(64);
    expect(await privateStorage.read(row.objectKey)).toEqual(PNG);

    const listed = JSON.stringify((await t.agent.get(docsUrl(employee.employeeId)).expect(200)).body);
    expect(listed).not.toMatch(/objectKey|sha256|documents\//);
    // The private folder is not served: no static route finds the key.
    expect((await request(app).get(`/uploads/${row.objectKey}`)).status).toBe(404);
  });

  it('QA S5: no signed URL without authorization; the owner and admins get a 60-second link; a stranger gets 404 and a trail', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const owner = await loginAs(t, 'FACULTY', employee);
    const stranger = await loginAs(t, 'FACULTY', await addActiveEmployee(t));
    const sent = data<EmployeeDocumentDTO>(await uploadDocument(t.agent, docsUrl(employee.employeeId), PDF, { documentType: 'QUALIFICATION' }).expect(201));
    const dl = `${API}/employee-documents/${sent.documentId}/download`;

    expectError(await request(app).post(dl), 401, 'UNAUTHENTICATED');
    expectError(await stranger.agent.post(dl), 404, 'NOT_FOUND');
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'document.download_denied', actorId: stranger.userId })).toBe(1);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'DOCUMENT_ACCESS_DENIED', actorUserId: stranger.userId })).toBe(1);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'document.downloaded' })).toBe(0);

    for (const agent of [owner.agent, t.agent]) {
      const link = data<{ url: string; expiresAt: string }>(await agent.post(dl).expect(200));
      expect(new Date(link.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(60_000);
      const file = await download(link.url);
      expect(file.status).toBe(200);
      expect(file.body).toEqual(PDF);
      expect(file.headers).toMatchObject({ 'content-type': 'application/pdf', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      expect(file.headers['content-disposition']).toMatch(/^attachment; filename="[\w .-]+"$/);
    }
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'document.downloaded' })).toBe(2);

    // A tampered or expired link fails the same way, and so does a link to a file that has been deleted.
    const link = data<{ url: string }>(await t.agent.post(dl).expect(200)).url;
    expect((await download(`${link.slice(0, -2)}xx`)).error?.code).toBe('TOKEN_INVALID');
    const [body] = link.split('/').pop()!.split('.');
    expect((await download(`${API}/files/${body}.AAAA`)).error?.code).toBe('TOKEN_INVALID');
    expect((await download(`${API}/files/not-a-token-at-all`)).error?.code).toBe('TOKEN_INVALID');
    const expired = signFileToken({ k: (await EmployeeDocument.findOne({ tenantId: t.tenantId }).lean())!.objectKey, m: 'application/pdf', n: 'x.pdf', t: t.tenantId }, -5);
    expect((await download(`${API}/files/${expired.token}`)).error?.code).toBe('TOKEN_INVALID');

    // Foreign tenants never see it; the document is removed with its file.
    await t.agent.delete(`${API}/employee-documents/${sent.documentId}`).expect(204);
    expect((await download(link)).status).toBe(404);
    expectError(await t.agent.post(dl), 404, 'NOT_FOUND');
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'document.deleted' })).toBe(1);
    expect((await EmployeeDocument.findOne({ tenantId: t.tenantId }).lean())?.status).toBe('DELETED');
    expect(await privateStorage.read((await EmployeeDocument.findOne({ tenantId: t.tenantId }).lean())!.objectKey)).toBeNull();
  });

  it('employees upload and list their own documents; they can delete nothing, and cannot touch anyone else’s', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const other = await addActiveEmployee(t);
    const login = await loginAs(t, 'FACULTY', employee);

    const sent = data<EmployeeDocumentDTO>(await uploadDocument(login.agent, `${API}/me/documents`, PDF, { documentType: 'EXPERIENCE' }).expect(201));
    expect(sent.employeeId).toBe(employee.employeeId);
    expect(data<EmployeeDocumentDTO[]>(await login.agent.get(`${API}/me/documents`).expect(200)).map((d) => d.documentId)).toEqual([sent.documentId]);
    expect(data<EmployeeDocumentDTO[]>(await t.agent.get(docsUrl(employee.employeeId)).expect(200))).toHaveLength(1);
    expectError(await login.agent.delete(`${API}/employee-documents/${sent.documentId}`), 403, 'FORBIDDEN');
    expectError(await uploadDocument(login.agent, docsUrl(other.employeeId)), 403, 'FORBIDDEN');
    // The audit row records the upload by the employee, with the type and size, not the name or the bytes.
    expect(await AuditEvent.findOne({ tenantId: t.tenantId, action: 'document.uploaded' }).lean()).toMatchObject({ actorId: login.userId, metadata: { documentType: 'EXPERIENCE', employeeId: employee.employeeId } });
    // An administrator-only login has no employee, so there is nothing to upload for.
    expectError(await uploadDocument(t.agent, `${API}/me/documents`), 404, 'NO_EMPLOYEE_PROFILE');
  });

  it('an exited employee’s documents can be read but not added to or deleted', async () => {
    const t = await staffSchool();
    const employee = await addActiveEmployee(t);
    const sent = data<EmployeeDocumentDTO>(await uploadDocument(t.agent, docsUrl(employee.employeeId)).expect(201));
    await t.agent.post(`${API}/employees/${employee.employeeId}/exit`).send({ exitDate: today(), exitReasonCategory: 'OTHER' }).expect(200);
    expectError(await uploadDocument(t.agent, docsUrl(employee.employeeId)), 409, 'EMPLOYEE_READ_ONLY');
    expectError(await t.agent.delete(`${API}/employee-documents/${sent.documentId}`), 409, 'EMPLOYEE_READ_ONLY');
    await t.agent.post(`${API}/employee-documents/${sent.documentId}/download`).expect(200);
  });

  it('an onboarding employee with a document, a login or restricted data is exited, not deleted', async () => {
    const t = await staffSchool();
    const withDoc = await addEmployee(t);
    const withLogin = await addEmployee(t, { officialEmail: 'login@greenfield.demo' });
    const withData = await addEmployee(t);
    const clean = await addEmployee(t);

    await uploadDocument(t.agent, docsUrl(withDoc.employeeId)).expect(201);
    await t.agent.post(`${API}/employees/${withLogin.employeeId}/user-account`).send({ role: 'STAFF' }).expect(201);
    await stepUp(t.agent);
    await t.agent.put(`${API}/employees/${withData.employeeId}/restricted`).send(restrictedBody).expect(200);

    for (const e of [withDoc, withLogin, withData]) expectError(await t.agent.delete(`${API}/employees/${e.employeeId}`), 409, 'EMPLOYEE_HAS_HISTORY');
    expect((await t.agent.get(`${API}/employees/${withDoc.employeeId}`).expect(200)).body.data.deletable).toBe(false);
    await t.agent.delete(`${API}/employees/${clean.employeeId}`).expect(204);
    expect(await Employee.countDocuments({ tenantId: t.tenantId, _id: clean.employeeId })).toBe(0);
  });
});

describe('export (SEC-05)', () => {
  const exportUrl = `${API}/employees/exports`;

  it('QA S6: the default exports have no restricted columns, formulas are escaped, and the file link works for 15 minutes', async () => {
    const t = await staffSchool();
    const lead = await withRestricted(t, { legalFirstName: '=HYPERLINK("http://evil.example","x")', legalLastName: 'Lead', officialEmail: 'lead@greenfield.demo' });
    await addActiveEmployee(t, { employeeCategory: 'NON_TEACHING_STAFF', legalFirstName: '+Staff', reportingManagerId: lead.employeeId });

    for (const purpose of ['DIRECTORY', 'EMPLOYMENT'] as const) {
      const result = data<ExportResultDTO>(await t.agent.post(exportUrl).send({ purpose }).expect(201));
      expect(result).toMatchObject({ purpose, rowCount: 2, fileName: expect.stringMatching(new RegExp(`^staff-${purpose.toLowerCase()}-\\d{4}-\\d{2}-\\d{2}\\.csv$`)) });
      expect(new Date(result.expiresAt).getTime() - Date.now()).toBeGreaterThan(14 * 60_000);

      const file = await download(result.url);
      expect(file.status).toBe(200);
      expect(file.headers['content-type']).toBe('text/csv; charset=utf-8');
      const csv = file.body.toString('utf8');
      const header = csv.split('\r\n')[0]!;
      expect(header).not.toMatch(/birth|aadhaar|pan|bank|account|ifsc|personal/i);
      for (const secret of [...Object.values(SECRETS), '1988-03-14']) expect(csv).not.toContain(secret);
      // A cell that would run as a formula is neutralised with a leading apostrophe.
      expect(csv).toContain(`"'=HYPERLINK(""http://evil.example"",""x"") Lead"`);
      expect(csv).toContain("'+Staff Person");
      expect(csv).not.toMatch(/(^|,)[=+\-@]/m);
    }
    const employment = (await download(data<ExportResultDTO>(await t.agent.post(exportUrl).send({ purpose: 'EMPLOYMENT' }).expect(201)).url)).body.toString('utf8');
    expect(employment.split('\r\n')[0]).toContain('Joining date');
    expect(employment).toContain('2020-04-01');
    expect(employment).toContain(lead.employeeCode); // the reporting manager column

    // Filters apply, and the audit row records who, why, which filters and how many rows.
    const filtered = data<ExportResultDTO>(await t.agent.post(exportUrl).send({ purpose: 'DIRECTORY', filters: { category: 'NON_TEACHING_STAFF' } }).expect(201));
    expect(filtered.rowCount).toBe(1);
    expect(await AuditEvent.findOne({ tenantId: t.tenantId, action: 'export.created', 'metadata.rowCount': 1 }).lean()).toMatchObject({
      actorId: t.ctx.userId,
      metadata: { purpose: 'DIRECTORY', filters: { category: 'NON_TEACHING_STAFF' }, rowCount: 1 },
    });
  });

  it('needs its own permission, validates its body, and cleanup removes expired files and records', async () => {
    const t = await staffSchool();
    await addActiveEmployee(t);
    const faculty = await loginAs(t, 'FACULTY', await addActiveEmployee(t));
    expectError(await faculty.agent.post(exportUrl).send({ purpose: 'DIRECTORY' }), 403, 'FORBIDDEN');
    expectError(await t.agent.post(exportUrl).send({ purpose: 'EVERYTHING' }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(exportUrl).send({ purpose: 'DIRECTORY', columns: ['dateOfBirth'] }), 400, 'VALIDATION_FAILED');
    expectError(await t.agent.post(exportUrl).send({ purpose: 'DIRECTORY', filters: { status: 'NOPE' } }), 400, 'VALIDATION_FAILED');

    const result = data<ExportResultDTO>(await t.agent.post(exportUrl).send({ purpose: 'DIRECTORY' }).expect(201));
    const stored = (await StaffExport.findOne({ tenantId: t.tenantId }).lean())!;
    expect(stored.objectKey).toMatch(/^exports\/[0-9a-f-]{36}$/);
    expect(await cleanupExpiredExports()).toBe(0);
    expect((await download(result.url)).status).toBe(200);

    await StaffExport.updateOne({ _id: stored._id, tenantId: t.tenantId }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await cleanupExpiredExports()).toBe(1);
    expect(await privateStorage.read(stored.objectKey)).toBeNull();
    expect(await StaffExport.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect((await download(result.url)).status).toBe(404);
  });
});

describe('PII-safe logs, audit and events (SEC-04)', () => {
  it('QA S7: a logger built with REDACT_PATHS drops passwords, tokens, IDs, bank numbers and request bodies, and so do URLs', () => {
    const lines: string[] = [];
    const log = pino({ redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR } }, { write: (line: string) => void lines.push(line) });
    const sample = {
      req: { url: '/x', headers: { cookie: 'sv_access=AAA', authorization: 'Bearer BBB' }, body: { password: 'Hunter2Hunter2', accountNumber: SECRETS.account } },
      body: { governmentIds: [{ type: 'PAN', value: SECRETS.pan }], bank: { accountNumber: SECRETS.account } },
      user: { password: 'Hunter2Hunter2', passwordHash: '$2a$12$abcdef' },
      payload: { token: 'activation-token-123', data: { code: '482913', value: SECRETS.aadhaar } },
      accountNumber: SECRETS.account,
      password: 'Hunter2Hunter2',
      token: 'activation-token-123',
    };
    log.info(sample, 'incoming');
    log.error({ err: new Error('boom'), ...sample }, 'failed');

    const out = lines.join('');
    for (const raw of ['Hunter2Hunter2', 'activation-token-123', '482913', '$2a$12$abcdef', 'sv_access=AAA', 'Bearer BBB', ...Object.values(SECRETS)]) expect(out, raw).not.toContain(raw);
    expect(out).toContain('[redacted]');
    // The non-sensitive parts are still logged.
    expect(out).toContain('"url":"/x"');

    expect(redactUrl('/api/v1/files/abc.def?x=1')).toBe('/api/v1/files/[redacted]?x=1');
    expect(redactUrl('/api/v1/auth/activation/secretvalue')).toBe('/api/v1/auth/activation/[redacted]');
    expect(redactUrl('/activate?token=secretvalue&a=1')).toBe('/activate?token=[redacted]&a=1');
    expect(redactUrl('/api/v1/employees')).toBe('/api/v1/employees');
  });

  it('QA S7: after every sensitive flow, the audit and security collections hold none of the raw values', async () => {
    const t = await staffSchool();
    const employee = await withRestricted(t, { dateOfBirth: '1977-07-07', personalEmail: 'private.person@greenfield.demo' });
    const login = await activatedLogin(t, employee, { email: 'flow@greenfield.demo' });
    await stepUp(t.agent);
    await t.agent.post(`${API}/employees/${employee.employeeId}/restricted/reveal`).send({ field: 'PAN' }).expect(200);
    await login.agent.patch(`${API}/me/profile`).send({ personalEmail: 'new.private@greenfield.demo', personalPhone: '+91 98140 77777' }).expect(200);
    await stepUp(login.agent);
    await login.agent.post(`${API}/me/profile-change-requests`).send({ fieldCategory: 'GOVERNMENT_ID', value: { type: 'VOTER_ID', value: 'TESTVOTER42' } }).expect(201);
    await t.agent.post(`${API}/auth/login`).send({ email: 'flow@greenfield.demo', password: 'bad-password-1' });
    await request(app).post(`${API}/auth/login`).send({ email: 'flow@greenfield.demo', password: 'bad-password-1' });
    await t.agent.patch(`${API}/employees/${employee.employeeId}`).send({ dateOfBirth: '1978-08-08', personalEmail: 'admin.set@greenfield.demo' }).expect(200);

    const stored = await everyStore(t.tenantId);
    const raws = [...Object.values(SECRETS), '1977-07-07', '1978-08-08', 'private.person@', 'new.private@', 'admin.set@', '98140 77777', 'TESTVOTER42', 'bad-password-1', PASSWORD];
    for (const raw of raws) expect(stored, raw).not.toContain(raw);
  });
});

describe('the Greenfield demo (QA S12)', () => {
  it('contains only .demo emails and TEST or zero-pattern identifiers; demo logins work with no MFA step', async () => {
    await seedDemo({ quiet: true });

    const users = await User.find({}).setOptions(SKIP_TENANT_SCOPE).lean();
    expect(users.length).toBeGreaterThan(5);
    expect(users.every((u) => u.email.endsWith('.demo'))).toBe(true);

    const people = await Person.find({}).setOptions(SKIP_TENANT_SCOPE).lean();
    for (const p of people) for (const email of [p.primaryEmail, p.personalEmail]) if (email) expect(email).toMatch(/\.demo$/);
    for (const e of await Employee.find({}).setOptions(SKIP_TENANT_SCOPE).lean()) if (e.officialEmail) expect(e.officialEmail).toMatch(/\.demo$/);

    const restricted = await RestrictedPersonData.find({}).setOptions(SKIP_TENANT_SCOPE).lean();
    expect(restricted.length).toBeGreaterThanOrEqual(6);
    for (const r of restricted) {
      const personDob = people.find((p) => p._id === r.personId)?.dateOfBirth ?? null;
      for (const g of r.governmentIds) expect(readValue(r.personId, r, personDob, g.type)).toMatch(/^(TEST[A-Z0-9]*|0+)$/);
      expect(readValue(r.personId, r, personDob, 'BANK_ACCOUNT_NUMBER')).toMatch(/^0{8}\d{4}$/);
      expect(r.bank?.ifsc).toMatch(/^TEST/);
    }
    for (const mail of await DevOutbox.find({}).setOptions(SKIP_TENANT_SCOPE).lean()) expect(mail.to).toMatch(/\.demo$/);

    // The demo staff: Neha's login is waiting for activation, the lab assistant has none, Priya has a pending request,
    // and every faculty member has a PDF.
    const neha = users.find((u) => u.email === 'neha.bansal@greenfield.demo')!;
    expect(neha.status).toBe('PENDING_ACTIVATION');
    expect(await DevOutbox.countDocuments({ to: 'neha.bansal@greenfield.demo', template: 'ACTIVATION' }).setOptions(SKIP_TENANT_SCOPE)).toBe(1);
    const tenantId = neha.tenantId;
    expect(await ProfileChangeRequest.countDocuments({ tenantId, status: 'PENDING', fieldCategory: 'LEGAL_NAME' })).toBe(1);
    const docs = await EmployeeDocument.find({ tenantId }).lean();
    expect(docs).toHaveLength(4);
    for (const d of docs) expect((await privateStorage.read(d.objectKey))?.toString('latin1', 0, 5)).toBe('%PDF-');

    // Demo logins keep working with a plain password, and the admin sees all of this masked.
    const login = async (email: string) => {
      const agent = request.agent(app);
      const res = await agent.post(`${API}/auth/login`).send({ email, password: DEMO_PASSWORD });
      expect(res.status, email).toBe(200);
      expect(res.body.data.user.status).toBe('ACTIVE');
      return agent;
    };
    const admin = await login('admin@greenfield.demo');
    await login('faculty@greenfield.demo');
    await login('staff@greenfield.demo');
    expectError(await request(app).post(`${API}/auth/login`).send({ email: 'neha.bansal@greenfield.demo', password: DEMO_PASSWORD }), 401, 'INVALID_CREDENTIALS');
    expect(((await admin.get(`${API}/profile-change-requests`).query({ status: 'PENDING' }).expect(200)).body.data as unknown[]).length).toBe(1);
  });
});
