import request from 'supertest';
import { describe, expect, it } from 'vitest';
import type {
  BulkInvitationResultDTO,
  DocumentCompletenessDTO,
  ParentAccessDTO,
  ParentChildrenDTO,
  ParentStudentSummaryDTO,
  SignedFileLinkDTO,
  StudentChangeRequestDTO,
  StudentChangeRequestListDTO,
  StudentDocumentDTO,
  StudentDocumentsDTO,
  StudentExportResultDTO,
} from '@shared';
import { AuditEvent } from '../src/modules/audit/audit.model';
import { Person } from '../src/modules/staff/person.model';
import { StudentChangeRequest, StudentDocument } from '../src/modules/students/records.models';
import { StudentGuardianLink } from '../src/modules/students/student.models';
import { SecurityEvent } from '../src/platform/identity/security-event.model';
import { User } from '../src/platform/users/user.model';
import { DEMO_PASSWORD, seedDemo } from '../src/scripts/seed';
import { Tenant } from '../src/platform/tenants/tenant.model';
import { Student } from '../src/modules/students/student.models';
import { StudentTransferCertificate } from '../src/modules/students/records.models';
import { AcademicSession } from '../src/modules/academic/session.model';
import {
  API,
  EICAR,
  PASSWORD,
  PDF,
  PNG,
  activatedParent,
  addEmployee,
  addStudent,
  app,
  createUserAndLogin,
  download,
  expectError,
  guardianLinks,
  inviteParent,
  loginAs,
  nextPhone,
  outboxLink,
  studentSchool,
  teacherWith,
  tokenFromLink,
  uploadDocument,
  useTestDatabase,
  type Agent,
} from './helpers';

useTestDatabase();

const get = async <T>(agent: Agent, path: string, status = 200) => (await agent.get(`${API}${path}`).expect(status)).body.data as T;
const post = async <T>(agent: Agent, path: string, body: unknown = {}, status = 200) => {
  const res = await agent.post(`${API}${path}`).send(body as object);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data as T;
};
const parentEmail = (n: number) => `parent${n}.p3@greenfield.demo`;

/** A school with one student whose mother has an activated parent login. */
async function familyWithLogin(n = 1) {
  const t = await studentSchool();
  const email = parentEmail(n);
  const kid = await addStudent(t, { guardian: { legalFirstName: 'Priya', legalLastName: 'Sharma', phone: nextPhone(), email, relationshipType: 'Mother' } });
  const parent = await activatedParent(t, kid.student.studentId, email);
  return { t, kid, parent, email };
}

// ───────────────────────────────────────────────────────────── parent login and access

describe('Parent login and parent-only access (Module 4, Part 3 · A)', () => {
  it('QA P1: enabling access reuses an existing Parent login instead of making a second one', async () => {
    const t = await studentSchool();
    const email = parentEmail(11);
    const kid = await addStudent(t, { guardian: { legalFirstName: 'Gita', legalLastName: 'Rao', phone: nextPhone(), email, relationshipType: 'Mother' } });
    // The login already exists (the demo Parent account): it has no person yet.
    await User.create({ tenantId: t.tenantId, email, fullName: 'Gita Rao', role: 'PARENT', status: 'ACTIVE', passwordHash: null });
    const { access } = await inviteParent(t, kid.student.studentId, email);
    expect(access).toMatchObject({ portalState: 'ACTIVE', reusedAccount: true, invitationSent: false, hasLogin: true });
    const users = await User.find({ tenantId: t.tenantId, email }).lean();
    expect(users).toHaveLength(1);
    expect(users[0]!.personId).toBeTruthy();
  });

  it('QA P2: a sibling under the same parent does not create a second account', async () => {
    const t = await studentSchool();
    const email = parentEmail(12);
    const first = await addStudent(t, { guardian: { legalFirstName: 'Anita', legalLastName: 'Kohli', phone: nextPhone(), email, relationshipType: 'Mother' } });
    const parentPerson = (await guardianLinks(t.agent, first.student.studentId))[0]!.guardianPersonId;
    const second = await addStudent(t, { guardian: { guardianPersonId: parentPerson, relationshipType: 'Mother' } });
    const a = await inviteParent(t, first.student.studentId, email);
    const b = await inviteParent(t, second.student.studentId, email);
    expect(a.access).toMatchObject({ invitationSent: true, reusedAccount: false });
    expect(b.access).toMatchObject({ invitationSent: false, reusedAccount: true });
    expect(await User.countDocuments({ tenantId: t.tenantId, role: 'PARENT', email })).toBe(1);
  });

  it('QA P3: a parent who has not activated cannot sign in, and the activation link works once', async () => {
    const t = await studentSchool();
    const email = parentEmail(13);
    const kid = await addStudent(t, { guardian: { legalFirstName: 'Rani', legalLastName: 'Sethi', phone: nextPhone(), email, relationshipType: 'Mother' } });
    const { access } = await inviteParent(t, kid.student.studentId, email);
    expect(access.portalState).toBe('INVITED');
    await request(app).post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(401);
    const token = tokenFromLink(await outboxLink(email, 'ACTIVATION'));
    await request(app).post(`${API}/auth/activate`).send({ token, password: PASSWORD }).expect(200);
    expectError(await request(app).post(`${API}/auth/activate`).send({ token, password: PASSWORD }), 400, 'TOKEN_INVALID');
    await request.agent(app).post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200);
    const access2 = (await get<ParentAccessDTO[]>(t.agent, `/students/${kid.student.studentId}/parent-access`))[0]!;
    expect(access2).toMatchObject({ portalState: 'ACTIVE', accountStatus: 'ACTIVE' });
  });

  it('a guardian without an email, without access flags, or whose email belongs to a staff login cannot be invited', async () => {
    const t = await studentSchool();
    const noEmail = await addStudent(t, { guardian: { legalFirstName: 'Sita', legalLastName: 'Das', phone: nextPhone(), relationshipType: 'Mother' } });
    const link = (await guardianLinks(t.agent, noEmail.student.studentId))[0]!;
    expectError(await t.agent.post(`${API}/guardian-links/${link.guardianLinkId}/enable-portal`), 422, 'GUARDIAN_EMAIL_REQUIRED');

    const email = parentEmail(14);
    const emergency = await addStudent(t, { guardian: { legalFirstName: 'Kamla', legalLastName: 'Das', phone: nextPhone(), email, relationshipType: 'Grandmother', canSeeAcademics: false, canSeeFees: false } });
    const link2 = (await guardianLinks(t.agent, emergency.student.studentId))[0]!;
    expectError(await t.agent.post(`${API}/guardian-links/${link2.guardianLinkId}/enable-portal`), 400, 'VALIDATION_FAILED');

    const staffEmail = parentEmail(15);
    await createUserAndLogin(t.tenantId, 'STAFF').then(({ userId }) => User.updateOne({ _id: userId, tenantId: t.tenantId }, { $set: { email: staffEmail } }));
    const clash = await addStudent(t, { guardian: { legalFirstName: 'Lata', legalLastName: 'Das', phone: nextPhone(), email: staffEmail, relationshipType: 'Mother' } });
    const link3 = (await guardianLinks(t.agent, clash.student.studentId))[0]!;
    expectError(await t.agent.post(`${API}/guardian-links/${link3.guardianLinkId}/enable-portal`), 409, 'PARENT_EMAIL_IN_USE');
  });

  it('QA P4: removing access for one child leaves the parent’s login and the other child', async () => {
    const t = await studentSchool();
    const email = parentEmail(16);
    const first = await addStudent(t, { guardian: { legalFirstName: 'Nisha', legalLastName: 'Bajwa', phone: nextPhone(), email, relationshipType: 'Mother' } });
    const person = (await guardianLinks(t.agent, first.student.studentId))[0]!.guardianPersonId;
    const second = await addStudent(t, { guardian: { guardianPersonId: person, relationshipType: 'Mother' } });
    const parent = await activatedParent(t, first.student.studentId, email);
    const link2 = await inviteParent(t, second.student.studentId, email);
    expect((await get<ParentChildrenDTO>(parent.agent, '/parent/children')).children).toHaveLength(2);

    const revoked = await post<ParentAccessDTO>(t.agent, `/guardian-links/${parent.linkId}/revoke-portal`);
    expect(revoked.portalState).toBe('REVOKED');
    const children = (await get<ParentChildrenDTO>(parent.agent, '/parent/children')).children;
    expect(children.map((c) => c.studentId)).toEqual([second.student.studentId]);
    expect(link2.access.portalState).toBe('ACTIVE');
    await parent.agent.get(`${API}/parent/children/${first.student.studentId}`).expect(404);
    await parent.agent.get(`${API}/parent/children/${second.student.studentId}`).expect(200);
  });

  it('QA P5: removing access takes effect on the very next request', async () => {
    const { t, kid, parent } = await familyWithLogin(21);
    await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`).expect(200);
    await post(t.agent, `/guardian-links/${parent.linkId}/revoke-portal`);
    expectError(await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`), 404, 'NOT_FOUND');
    // Access can be given again: the login is still there.
    const again = await post<ParentAccessDTO>(t.agent, `/guardian-links/${parent.linkId}/enable-portal`);
    expect(again).toMatchObject({ portalState: 'ACTIVE', reusedAccount: true });
    await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`).expect(200);
  });

  it('QA P6: a suspended parent account loses every session', async () => {
    const { t, parent } = await familyWithLogin(22);
    const user = await User.findOne({ tenantId: t.tenantId, email: parent.email }).lean();
    await parent.agent.get(`${API}/parent/children`).expect(200);
    await post(t.agent, `/users/${user!._id}/suspend`, { reason: 'Requested by the family' });
    const res = await parent.agent.get(`${API}/parent/children`);
    expect([401, 403]).toContain(res.status);
  });

  it('QA P7: a parent who asks for another student’s id gets 404, and a security event is written', async () => {
    const { t, kid, parent } = await familyWithLogin(23);
    const other = await addStudent(t);
    expectError(await parent.agent.get(`${API}/parent/children/${other.student.studentId}`), 404, 'NOT_FOUND');
    expectError(await parent.agent.get(`${API}/parent/children/${other.student.studentId}/documents`), 404, 'NOT_FOUND');
    expectError(await parent.agent.get(`${API}/student-context`).query({ studentId: other.student.studentId }), 404, 'NOT_FOUND');
    expectError(await parent.agent.post(`${API}/parent/children/${other.student.studentId}/change-requests`).send({ field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2014-01-01' } }), 404, 'NOT_FOUND');
    expect(await get<ParentStudentSummaryDTO>(parent.agent, `/parent/children/${kid.student.studentId}`)).toMatchObject({ studentId: kid.student.studentId });
    const events = await SecurityEvent.find({ tenantId: t.tenantId, type: 'PARENT_ACCESS_DENIED', targetId: other.student.studentId }).lean();
    expect(events.length).toBeGreaterThanOrEqual(3);
    // Ids and categories only.
    expect(JSON.stringify(events)).not.toContain(parent.email);
  });

  it('QA P8: a parent cannot use admin or faculty routes, and nobody else can use the parent routes', async () => {
    const { t, kid, parent } = await familyWithLogin(24);
    for (const path of ['/students', `/students/${kid.student.studentId}`, '/guardians', '/employees', '/promotions/readiness', '/students/imports', '/student-change-requests', `/students/${kid.student.studentId}/documents`]) {
      const res = await parent.agent.get(`${API}${path}`);
      expect(res.status, path).toBe(403);
    }
    await parent.agent.post(`${API}/students/exports`).send({ purpose: 'DIRECTORY' }).expect(403);
    await parent.agent.post(`${API}/students/${kid.student.studentId}/withdrawal`).send({ leavingDate: '2026-12-01', reasonCategory: 'OTHER', needsTC: false }).expect(403);
    await t.agent.get(`${API}/parent/children`).expect(403);
    const teacher = await teacherWith(t, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]);
    await teacher.agent.get(`${API}/parent/children`).expect(403);
  });

  it('QA P9: ending a guardian link ends access, and the history stays', async () => {
    const { t, kid, parent } = await familyWithLogin(25);
    await post(t.agent, `/guardian-links/${parent.linkId}/end`, {});
    expectError(await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`), 404, 'NOT_FOUND');
    expect((await get<ParentChildrenDTO>(parent.agent, '/parent/children')).children).toHaveLength(0);
    const history = await get<{ entries: { kind: string; title: string }[] }>(t.agent, `/students/${kid.student.studentId}/history`);
    expect(history.entries.some((e) => e.kind === 'GUARDIAN' && /linked as Mother/.test(e.title))).toBe(true);
    expect(history.entries.some((e) => e.kind === 'GUARDIAN' && /link ended/.test(e.title))).toBe(true);
    expect(await StudentGuardianLink.countDocuments({ tenantId: t.tenantId, _id: parent.linkId })).toBe(1);
  });

  it('bulk invitations: invites, reuses a login for the second child, and skips (with a reason) a parent without an email', async () => {
    const t = await studentSchool();
    const email = parentEmail(31);
    const a = await addStudent(t, { guardian: { legalFirstName: 'Poonam', legalLastName: 'Bhatia', phone: nextPhone(), email, relationshipType: 'Mother' } });
    const person = (await guardianLinks(t.agent, a.student.studentId))[0]!.guardianPersonId;
    const b = await addStudent(t, { guardian: { guardianPersonId: person, relationshipType: 'Mother' } });
    const c = await addStudent(t, { guardian: { legalFirstName: 'Raj', legalLastName: 'Nair', phone: nextPhone(), relationshipType: 'Father' } });
    const ids = [a, b, c].map(async (k) => (await guardianLinks(t.agent, k.student.studentId))[0]!.guardianLinkId);
    const summary = await post<BulkInvitationResultDTO>(t.agent, '/parents/invitations/bulk', { guardianLinkIds: await Promise.all(ids) });
    expect(summary).toMatchObject({ invited: 1, reusedAccount: 1 });
    expect(summary.skipped).toHaveLength(1);
    expect(summary.skipped[0]!.reason).toMatch(/email/i);
    // By filter: nobody is left to invite except the parent without an email, who is skipped again.
    const again = await post<BulkInvitationResultDTO>(t.agent, '/parents/invitations/bulk', { filter: { classOfferingId: t.classOfferingId } });
    expect(again.invited + again.reusedAccount).toBe(0);
    await t.agent.post(`${API}/parents/invitations/bulk`).send({ guardianLinkIds: ['not-an-id'] }).expect(400);
    await t.agent.post(`${API}/parents/invitations/bulk`).send({}).expect(400);
  });

  it('QA S3 (parent): the parent summary carries only internal fields: no contact, notes, birth date or outside IDs', async () => {
    const { t, kid, parent } = await familyWithLogin(26);
    await t.agent.patch(`${API}/students/${kid.student.studentId}`).send({ version: kid.student.version, dateOfBirth: '2014-05-10', notes: 'SECRET-NOTE-123', bloodGroup: 'A+' }).expect(200);
    await t.agent.post(`${API}/students/${kid.student.studentId}/external-ids`).send({ type: 'Board Reg No', value: 'BRN-998877' }).expect(201);
    const summary = await parent.agent.get(`${API}/parent/children/${kid.student.studentId}`).expect(200);
    const text = JSON.stringify(summary.body);
    for (const secret of ['SECRET-NOTE-123', 'BRN-998877', '2014-05-10', 'dateOfBirth', 'phone', 'email', 'address', 'bloodGroup', 'notes', 'externalIds']) expect(text, secret).not.toContain(secret);
    expect(Object.keys(summary.body.data).sort()).toEqual(['admissionNumber', 'campusName', 'classSection', 'displayName', 'fullName', 'hasPhoto', 'primaryGuardianName', 'rollNumber', 'studentId', 'subjects']);
  });

  it('QA S8: a staff login with no student permission is refused everywhere in this module', async () => {
    const t = await studentSchool();
    const kid = await addStudent(t);
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    for (const path of ['/students', `/students/${kid.student.studentId}/documents`, `/students/${kid.student.studentId}/parent-access`, '/student-change-requests', '/students/imports', '/promotions/readiness?fromSessionId=x']) {
      expect((await staff.agent.get(`${API}${path}`)).status, path).toBe(403);
    }
    expect((await staff.agent.get(`${API}/student-context`).query({ studentId: kid.student.studentId })).status).toBe(403);
  });
});

// ───────────────────────────────────────────────────────────── documents and change requests

describe('Student documents and parent change requests (Module 4, Part 3 · B)', () => {
  it('uploads a document, shows the checklist, and a parent sees only the types meant for them', async () => {
    const { t, kid, parent } = await familyWithLogin(41);
    const url = `/students/${kid.student.studentId}/documents`;
    let docs = await get<StudentDocumentsDTO>(t.agent, url);
    expect(docs.completeness).toMatchObject({ total: 4, done: 0 });
    const birth = (await uploadDocument(t.agent, `${API}${url}`, PDF, { documentType: 'BIRTH_CERTIFICATE', displayName: 'Birth certificate' }).expect(201)).body.data as StudentDocumentDTO;
    const medical = (await uploadDocument(t.agent, `${API}${url}`, PNG, { documentType: 'MEDICAL' }, 'check.png').expect(201)).body.data as StudentDocumentDTO;
    expect(birth).toMatchObject({ documentType: 'BIRTH_CERTIFICATE', mime: 'application/pdf', issuedBySchool: false });
    docs = await get<StudentDocumentsDTO>(t.agent, url);
    expect(docs.items).toHaveLength(2);
    const completeness: DocumentCompletenessDTO = docs.completeness;
    expect(completeness.message).toBe('1 of 4 done. Missing: Previous school record, ID proof, Photo');

    const seen = await get<StudentDocumentDTO[]>(parent.agent, `/parent/children/${kid.student.studentId}/documents`);
    expect(seen.map((d) => d.documentId)).toEqual([birth.documentId]);
    // A parent downloads a document meant for them, and cannot download a medical one.
    const link = await post<SignedFileLinkDTO>(parent.agent, `/student-documents/${birth.documentId}/download`);
    expect((await download(link.url)).body.subarray(0, 5).toString()).toBe('%PDF-');
    expectError(await parent.agent.post(`${API}/student-documents/${medical.documentId}/download`), 404, 'NOT_FOUND');
  });

  it('QA S4: a download needs authorization; a tampered or expired link fails; another family cannot download', async () => {
    const { t, kid } = await familyWithLogin(42);
    const other = await familyWithLogin(43);
    const doc = (await uploadDocument(t.agent, `${API}/students/${kid.student.studentId}/documents`, PDF, { documentType: 'ID_PROOF' }).expect(201)).body.data as StudentDocumentDTO;
    // No login at all.
    expect((await request(app).post(`${API}/student-documents/${doc.documentId}/download`)).status).toBe(401);
    // A parent of another school: 404, and our rows are never even looked at.
    expectError(await other.parent.agent.post(`${API}/student-documents/${doc.documentId}/download`), 404, 'NOT_FOUND');
    const staff = await createUserAndLogin(t.tenantId, 'STAFF');
    expectError(await staff.agent.post(`${API}/student-documents/${doc.documentId}/download`), 404, 'NOT_FOUND');
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'DOCUMENT_ACCESS_DENIED' })).toBeGreaterThanOrEqual(1);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'student_document.download_denied' })).toBe(1); // the other school's parent never reaches this school's rows, so there is nothing of ours to audit

    const link = await post<SignedFileLinkDTO>(t.agent, `/student-documents/${doc.documentId}/download`);
    expect((await download(link.url)).status).toBe(200);
    const tampered = link.url.slice(0, -4) + 'AAAA';
    expect((await download(tampered)).error?.code).toBe('TOKEN_INVALID');
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, action: 'student_document.downloaded' })).toBeGreaterThanOrEqual(1);
  });

  it('QA S5: a wrong file type, an oversized file and an antivirus test file are all refused', async () => {
    const { t, kid } = await familyWithLogin(44);
    const url = `${API}/students/${kid.student.studentId}/documents`;
    expectError(await uploadDocument(t.agent, url, Buffer.from('<html><script>alert(1)</script></html>'), { documentType: 'OTHER' }, 'page.pdf'), 415, 'UNSUPPORTED_DOCUMENT_TYPE');
    expectError(await uploadDocument(t.agent, url, Buffer.concat([PDF, Buffer.alloc(5 * 1024 * 1024 + 10)]), { documentType: 'OTHER' }), 413, 'DOCUMENT_TOO_LARGE');
    expectError(await uploadDocument(t.agent, url, EICAR, { documentType: 'OTHER' }), 422, 'FILE_REJECTED');
    expect(await StudentDocument.countDocuments({ tenantId: t.tenantId })).toBe(0);
    expect(await SecurityEvent.countDocuments({ tenantId: t.tenantId, type: 'FILE_REJECTED' })).toBe(2);
    // A parent cannot upload at all.
    const parent = await activatedParent(t, (await addStudent(t, { guardian: { legalFirstName: 'Uma', legalLastName: 'K', phone: nextPhone(), email: parentEmail(45), relationshipType: 'Mother' } })).student.studentId, parentEmail(45));
    expect((await uploadDocument(parent.agent, url, PDF, { documentType: 'OTHER' })).status).toBe(403);
  });

  it('a document can be deleted: the file goes, the row stays for the audit trail', async () => {
    const { t, kid } = await familyWithLogin(46);
    const url = `${API}/students/${kid.student.studentId}/documents`;
    const doc = (await uploadDocument(t.agent, url, PDF, { documentType: 'PHOTO' }, 'photo.pdf').expect(201)).body.data as StudentDocumentDTO;
    await t.agent.delete(`${API}/student-documents/${doc.documentId}`).expect(204);
    expect((await get<StudentDocumentsDTO>(t.agent, `/students/${kid.student.studentId}/documents`)).items).toHaveLength(0);
    expect(await StudentDocument.findOne({ tenantId: t.tenantId, _id: doc.documentId }).lean()).toMatchObject({ status: 'DELETED' });
    expectError(await t.agent.post(`${API}/student-documents/${doc.documentId}/download`), 404, 'NOT_FOUND');
    // A draft that has a document cannot be discarded: the document counts as history.
    const draft = (await t.agent.post(`${API}/students`).send({ draft: true, legalFirstName: 'Draft', legalLastName: 'Kid' }).expect(201)).body.data.student;
    await uploadDocument(t.agent, `${API}/students/${draft.studentId}/documents`, PDF, { documentType: 'PHOTO' }, 'p.pdf').expect(201);
    expectError(await t.agent.delete(`${API}/students/${draft.studentId}`), 409, 'STUDENT_HAS_HISTORY');
  });

  it('a parent asks for a change; one request per detail; the admin approves it and it is applied once, with no value in the audit trail', async () => {
    const { t, kid, parent } = await familyWithLogin(51);
    const path = `/parent/children/${kid.student.studentId}/change-requests`;
    const asked = await post<StudentChangeRequestDTO>(parent.agent, path, { field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2013-12-25' }, reason: 'Wrong year on the form' }, 201);
    expect(asked).toMatchObject({ status: 'PENDING', field: 'DATE_OF_BIRTH', newValue: 'Born in 2013', oldValue: 'Not set' });
    expectError(await parent.agent.post(`${API}${path}`).send({ field: 'DATE_OF_BIRTH', value: { dateOfBirth: '2012-01-01' } }), 409, 'CHANGE_REQUEST_PENDING');
    await post(parent.agent, path, { field: 'LEGAL_NAME', value: { legalFirstName: 'Kiddo', legalLastName: 'Learner' } }, 201);

    const list = await get<StudentChangeRequestListDTO>(t.agent, '/student-change-requests?status=PENDING');
    expect(list).toMatchObject({ total: 2, pendingCount: 2 });
    // The admin sees masked values: a birth date shows only the year.
    expect(JSON.stringify(list)).not.toContain('2013-12-25');
    const approved = await post<StudentChangeRequestDTO>(t.agent, `/student-change-requests/${asked.changeRequestId}/approve`, { note: 'Checked the birth certificate' });
    expect(approved).toMatchObject({ status: 'APPROVED', decisionNote: 'Checked the birth certificate' });
    expect((await get<{ dateOfBirth: string; version: number }>(t.agent, `/students/${kid.student.studentId}`)).dateOfBirth).toBe('2013-12-25');
    expectError(await t.agent.post(`${API}/student-change-requests/${asked.changeRequestId}/approve`).send({}), 409, 'CHANGE_REQUEST_CLOSED');
    expect(JSON.stringify(await AuditEvent.find({ tenantId: t.tenantId, action: { $in: ['change_request.created', 'change_request.approved', 'student.updated'] } }).lean())).not.toContain('2013-12-25');

    // Rejecting needs a note, and nothing changes.
    const name = list.items.find((r) => r.field === 'LEGAL_NAME')!;
    await t.agent.post(`${API}/student-change-requests/${name.changeRequestId}/reject`).send({}).expect(400);
    const rejected = await post<StudentChangeRequestDTO>(t.agent, `/student-change-requests/${name.changeRequestId}/reject`, { note: 'Please bring the document to the office.' });
    expect(rejected.status).toBe('REJECTED');
    expect((await get<{ legalFirstName: string }>(t.agent, `/students/${kid.student.studentId}`)).legalFirstName).toBe(kid.student.legalFirstName);

    // The parent sees the states, with the school's note, and nobody else's requests.
    const mine = await get<StudentChangeRequestDTO[]>(parent.agent, '/parent/change-requests');
    expect(mine.map((r) => r.status).sort()).toEqual(['APPROVED', 'REJECTED']);
    expect(mine.find((r) => r.status === 'REJECTED')!.decisionNote).toBe('Please bring the document to the office.');
  });

  it('a contact change applies to the parent once, for every child; a parent can cancel a waiting request but not another parent’s', async () => {
    const { t, kid, parent, email } = await familyWithLogin(52);
    const other = await familyWithLogin(53);
    const path = `/parent/children/${kid.student.studentId}/change-requests`;
    const phone = '+91 98765 11111';
    const asked = await post<StudentChangeRequestDTO>(parent.agent, path, { field: 'GUARDIAN_CONTACT', value: { phone } }, 201);
    expect(asked.newValue).toMatch(/1111/);
    expect(asked.newValue).not.toContain('98765');
    expectError(await other.parent.agent.post(`${API}/parent/change-requests/${asked.changeRequestId}/cancel`), 404, 'NOT_FOUND');
    await post(t.agent, `/student-change-requests/${asked.changeRequestId}/approve`, {});
    const person = await Person.findOne({ tenantId: t.tenantId, primaryEmail: email }).lean();
    expect(person!.primaryPhone).toBe('+919876511111');
    const second = await post<StudentChangeRequestDTO>(parent.agent, path, { field: 'GUARDIAN_CONTACT', value: { phone: '+91 98765 22222' } }, 201);
    const cancelled = await post<StudentChangeRequestDTO>(parent.agent, `/parent/change-requests/${second.changeRequestId}/cancel`);
    expect(cancelled.status).toBe('CANCELLED');
    expect(await StudentChangeRequest.countDocuments({ tenantId: t.tenantId, status: 'PENDING' })).toBe(0);
  });
});

// ───────────────────────────────────────────────────────────── security and the demo seed

describe('Child-data security and the Part 3 demo seed', () => {
  it('QA S1 (faculty): a teacher cannot read an unassigned student, by id, in lists or through the context route', async () => {
    const t = await studentSchool();
    const mine = await addStudent(t, { sectionId: t.sections.A });
    const theirs = await addStudent(t, { sectionId: t.sections.B });
    const teacher = await teacherWith(t, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]);
    expect((await get<{ items: { studentId: string }[] }>(teacher.agent, '/students')).items.map((s) => s.studentId)).toEqual([mine.student.studentId]);
    expectError(await teacher.agent.get(`${API}/students/${theirs.student.studentId}`), 404, 'NOT_FOUND');
    expectError(await teacher.agent.get(`${API}/student-context`).query({ studentId: theirs.student.studentId }), 404, 'NOT_FOUND');
    expect((await teacher.agent.get(`${API}/student-context`).query({ studentId: mine.student.studentId })).status).toBe(200);
    for (const path of [`/students/${mine.student.studentId}/documents`, `/students/${mine.student.studentId}/parent-access`, `/students/${mine.student.studentId}/withdrawal`]) expect((await teacher.agent.get(`${API}${path}`)).status, path).toBe(403);
  });

  it('QA S2: another school’s ids are 404 on every Part 3 route, and another school’s parent has no access', async () => {
    const a = await studentSchool('School A');
    const b = await studentSchool('School B');
    const kid = await addStudent(a);
    const link = (await guardianLinks(a.agent, kid.student.studentId))[0]!;
    const doc = (await uploadDocument(a.agent, `${API}/students/${kid.student.studentId}/documents`, PDF, { documentType: 'ID_PROOF' }).expect(201)).body.data as StudentDocumentDTO;
    const tc = (await a.agent.post(`${API}/students/${kid.student.studentId}/transfer-certificates`).send({}).expect(201)).body.data as { certificateId: string };
    const calls: [string, string, object?][] = [
      ['get', `/students/${kid.student.studentId}/documents`],
      ['get', `/students/${kid.student.studentId}/parent-access`],
      ['get', `/students/${kid.student.studentId}/withdrawal`],
      ['get', `/students/${kid.student.studentId}/transfers`],
      ['get', `/students/${kid.student.studentId}/transfer-certificates`],
      ['post', `/guardian-links/${link.guardianLinkId}/enable-portal`],
      ['post', `/guardian-links/${link.guardianLinkId}/revoke-portal`],
      ['post', `/student-documents/${doc.documentId}/download`],
      ['post', `/transfer-certificates/${tc.certificateId}/approve`],
      ['post', `/students/${kid.student.studentId}/withdrawal`, { leavingDate: '2026-12-01', reasonCategory: 'OTHER', needsTC: false }],
      ['post', `/students/${kid.student.studentId}/readmit`, { academicSessionId: a.sessionId, locationId: a.moh.locationId, classOfferingId: a.classOfferingId }],
    ];
    for (const [method, path, body] of calls) {
      const res = await (b.agent as unknown as Record<string, (u: string) => request.Test>)[method]!(`${API}${path}`).send(body ?? {});
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    await b.agent.delete(`${API}/student-documents/${doc.documentId}`).expect(404);
  });

  it('QA S6: an export needs its own permission, escapes formulas, and has no restricted columns', async () => {
    const t = await studentSchool();
    await addStudent(t, { legalFirstName: '=HYPERLINK("http://evil")', legalLastName: 'Learner', dateOfBirth: '2014-05-10', guardian: { legalFirstName: 'Pria', legalLastName: 'L', phone: '+91 98140 12345', email: parentEmail(61), relationshipType: 'Mother' } });
    const teacher = await teacherWith(t, [{ assignmentType: 'CLASS_TEACHER', sectionId: t.sections.A }]);
    expect((await teacher.agent.post(`${API}/students/exports`).send({ purpose: 'DIRECTORY' })).status).toBe(403);

    for (const purpose of ['DIRECTORY', 'ACADEMIC', 'GUARDIAN_CONTACTS'] as const) {
      const result = await post<StudentExportResultDTO>(t.agent, '/students/exports', { purpose, filters: {} }, 201);
      expect(result).toMatchObject({ purpose, rowCount: 1 });
      const csv = (await download(result.url)).body.toString('utf8');
      expect(csv, purpose).toContain("'=HYPERLINK");
      expect(csv, purpose).not.toMatch(/(^|,)=HYPERLINK/m);
      for (const secret of ['2014-05-10', 'dateOfBirth', 'Date of birth', 'Address', 'Notes', parentEmail(61)]) expect(csv, `${purpose} must not contain ${secret}`).not.toContain(secret);
      if (purpose === 'GUARDIAN_CONTACTS') expect(csv).toContain('+919814012345');
      else expect(csv).not.toContain('9814012345');
    }
    await t.agent.post(`${API}/students/exports`).send({ purpose: 'EVERYTHING' }).expect(400);
    expect(await AuditEvent.countDocuments({ tenantId: t.tenantId, entityType: 'student_export', action: 'student_export.created' })).toBe(3);
  });

  it('QA S7: logs, audit rows and security events hold no raw parent phone, email or birth date used in the tests', async () => {
    const { t, kid, parent, email } = await familyWithLogin(62);
    await t.agent.patch(`${API}/students/${kid.student.studentId}`).send({ version: kid.student.version, dateOfBirth: '2011-03-09' }).expect(200);
    await post(parent.agent, `/parent/children/${kid.student.studentId}/change-requests`, { field: 'GUARDIAN_CONTACT', value: { phone: '+91 98765 33333', email: 'new.contact.p3@greenfield.demo' } }, 201);
    await parent.agent.get(`${API}/parent/children/${(await addStudent(t)).student.studentId}`).expect(404);
    const everything = JSON.stringify([...(await AuditEvent.find({ tenantId: t.tenantId }).lean()), ...(await SecurityEvent.find({ tenantId: t.tenantId }).lean())]);
    for (const secret of [email, '2011-03-09', '9876533333', 'new.contact.p3@greenfield.demo']) expect(everything, secret).not.toContain(secret);
  });

  it('QA S9: the demo seed has only .demo emails and zero-style numbers, and sets up the parent portal cases', async () => {
    await seedDemo({ quiet: true });
    const tenant = await Tenant.findOne({ slug: 'greenfield-public-school' }).lean();
    const tenantId = tenant!._id;
    const studentPeople = await Student.find({ tenantId }).select('personId').lean();
    const guardians = await StudentGuardianLink.find({ tenantId }).select('guardianPersonId').lean();
    const people = await Person.find({ tenantId, _id: { $in: [...studentPeople.map((s) => s.personId), ...guardians.map((g) => g.guardianPersonId)] } }).lean();
    expect(people.length).toBeGreaterThan(40);
    for (const p of people) {
      if (p.primaryEmail) expect(p.primaryEmail, 'email').toMatch(/\.demo$/);
      if (p.primaryPhone) expect(p.primaryPhone, 'phone').toMatch(/^\+9190000\d{5}$/);
    }
    const parentUsers = await User.find({ tenantId, role: 'PARENT' }).lean();
    expect(parentUsers.every((u) => u.email.endsWith('.demo'))).toBe(true);

    // Simran has an activated login and two children.
    const simran = parentUsers.find((u) => u.email === 'parent@greenfield.demo')!;
    expect(simran).toMatchObject({ status: 'ACTIVE' });
    expect(simran.personId).toBeTruthy();
    const login = request.agent(app);
    await login.post(`${API}/auth/login`).send({ email: 'parent@greenfield.demo', password: DEMO_PASSWORD }).expect(200);
    expect((await get<ParentChildrenDTO>(login, '/parent/children')).children.map((c) => c.fullName).sort()).toEqual(['Arjun Kaur', 'Riya Kaur']);
    // One pending invitation, one removed access.
    expect(parentUsers.filter((u) => u.status === 'PENDING_ACTIVATION')).toHaveLength(2);
    expect(await StudentGuardianLink.countDocuments({ tenantId, portalRevokedAt: { $ne: null } })).toBe(1);
    // One student is leaving, one certificate waits for dues, and 2027-28 can take promotions.
    expect(await Student.countDocuments({ tenantId, status: 'WITHDRAWAL_INITIATED' })).toBe(1);
    expect(await StudentTransferCertificate.countDocuments({ tenantId, status: 'PENDING_CLEARANCE' })).toBe(1);
    expect(await AcademicSession.countDocuments({ tenantId, code: '2027-28', status: 'PUBLISHED' })).toBe(1);
  }, 60_000);

  it('QA S6 (employees): a teacher with a parent login on the same person is two logins, never one', async () => {
    // One user account has one role: a teacher who is also a parent needs a separate login with another email.
    const t = await studentSchool();
    const employee = await addEmployee(t);
    const login = await loginAs(t, 'FACULTY', employee);
    const kid = await addStudent(t, { guardian: { legalFirstName: 'Teach', legalLastName: 'Parent', phone: nextPhone(), email: parentEmail(63), relationshipType: 'Mother' } });
    const link = (await guardianLinks(t.agent, kid.student.studentId))[0]!;
    await Person.updateOne({ _id: link.guardianPersonId, tenantId: t.tenantId }, { $set: { primaryEmail: await User.findOne({ _id: login.userId, tenantId: t.tenantId }).then((u) => u!.email) } });
    expectError(await t.agent.post(`${API}/guardian-links/${link.guardianLinkId}/enable-portal`), 409, 'PARENT_EMAIL_IN_USE');
  });
});
