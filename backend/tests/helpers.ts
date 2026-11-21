import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { DEFAULT_TIMEZONE, permissionsFor, type AcademicSessionDTO, type AuditEventDTO, type CreateStudentResultDTO, type EmployeeProfileDTO, type LocationDetailDTO, type Role, type SchoolDTO, type SessionStatus, type SubjectOfferingDTO } from '@shared';
import type { ServiceContext } from '../src/platform/rbac/tenant-context';
import { afterAll, beforeAll, beforeEach, expect, inject } from 'vitest';
import { createApp } from '../src/app';
import { BoardRuleVersion, EducationBoard, ClassMaster } from '../src/modules/academic/reference.model';
import { seedReferenceData } from '../src/modules/academic/reference.seed';
import { AcademicSession } from '../src/modules/academic/session.model';
import { todayIn } from '../src/core/dates';
import { hashPassword } from '../src/platform/auth/password';
import { User } from '../src/platform/users/user.model';
import { School } from '../src/modules/school/school.model';
import { SKIP_TENANT_SCOPE } from '../src/db/plugins/tenant-scope';

export const app = createApp();
export const API = '/api/v1';
export const PASSWORD = 'Password123';
export type Agent = ReturnType<typeof request.agent>;

// ───────────────────────────────────────────────────────────── database

/**
 * Connects this test file to its own database on the shared in-memory replica set (see global-setup.ts).
 * Collections are wiped between tests; indexes are kept so unique rules stay enforced.
 */
export function useTestDatabase() {
  beforeAll(async () => {
    await mongoose.connect(inject('mongoUri'), { dbName: `t_${randomUUID().slice(0, 8)}` });
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  });

  beforeEach(async () => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
}

// ───────────────────────────────────────────────────────────── responses

export const data = <T>(res: { body: { data: T } }) => res.body.data;

/** GET `${API}${path}` with the caller's agent; must return 200. Returns `data`. */
export const get = async <T>(t: { agent: Agent }, path: string) => (await t.agent.get(`${API}${path}`).expect(200)).body.data as T;

// ───────────────────────────────────────────────────────────── users

let counter = 0;
export function uniqueEmail(prefix = 'user') {
  counter += 1;
  return `${prefix}.${counter}.${Date.now()}@example.com`;
}

/** Signs up a new tenant + School Admin and returns a cookie-carrying agent. */
export async function signupAdmin(workspaceName = 'Test School') {
  const agent = request.agent(app);
  const email = uniqueEmail('admin');
  const res = await agent
    .post(`${API}/auth/signup`)
    .send({ workspaceName, fullName: 'Ada Admin', email, password: PASSWORD })
    .expect(201);
  return { agent, email, session: res.body.data as { user: { userId: string; tenantId: string }; tenant: { tenantId: string } } };
}

/** Inserts a user with the given role into an existing tenant and signs them in. */
export async function createUserAndLogin(tenantId: string, role: Role) {
  const email = uniqueEmail(role.toLowerCase());
  const user = await User.create({
    _id: randomUUID(),
    tenantId,
    email,
    fullName: `${role} Person`,
    role,
    passwordHash: await hashPassword(PASSWORD),
  });
  const agent = request.agent(app);
  await agent.post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200);
  return { agent, email, userId: user._id };
}

// ───────────────────────────────────────────────────────────── school & locations

export const validSchool = {
  schoolCode: 'GPS',
  legalName: 'Greenfield Public School Trust',
  displayName: 'Greenfield Public School',
  primaryEmail: 'office@greenfield.edu.in',
  primaryPhone: '+91 98765 43210',
};

let phoneSeq = 0;
/** Valid Indian mobile numbers, unique per call. */
export function nextPhone() {
  phoneSeq += 1;
  return `+91 98140 ${String(10000 + phoneSeq).slice(-5)}`;
}

export const pklAddress = { line1: 'Sector 5', city: 'Panchkula', state: 'Haryana', postalCode: '134109', country: 'IN' };

export function activeLocationBody(overrides: Record<string, unknown> = {}) {
  return {
    displayName: 'Mohali Campus',
    locationCode: 'MOH',
    locationType: 'MAIN_CAMPUS',
    intent: 'ACTIVE',
    phone: nextPhone(),
    email: 'mohali@greenfield.edu.in',
    address: { line1: 'Sector 70', city: 'Mohali', state: 'Punjab', postalCode: '160071', country: 'IN' },
    ...overrides,
  };
}

export function draftLocationBody(overrides: Record<string, unknown> = {}) {
  return { displayName: 'Panchkula Campus', locationCode: 'PKL', locationType: 'BRANCH_CAMPUS', intent: 'DRAFT', ...overrides };
}

export async function createSchool(agent: Agent, overrides: Record<string, unknown> = {}): Promise<SchoolDTO> {
  // School codes are unique platform-wide, so extra tenants in one test get GPS-2, GPS-3 …
  let schoolCode = validSchool.schoolCode;
  if (!('schoolCode' in overrides)) {
    const used = await School.countDocuments({ schoolCode: { $regex: '^GPS(-\\d+)?$' } }).setOptions(SKIP_TENANT_SCOPE);
    if (used > 0) schoolCode = `GPS-${used + 1}`;
  }
  const res = await agent.post(`${API}/schools`).send({ ...validSchool, schoolCode, ...overrides });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as SchoolDTO;
}

export async function createLocation(agent: Agent, schoolId: string, body: Record<string, unknown>): Promise<LocationDetailDTO> {
  const res = await agent.post(`${API}/schools/${schoolId}/locations`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as LocationDetailDTO;
}

export async function getLocation(agent: Agent, locationId: string): Promise<LocationDetailDTO> {
  const res = await agent.get(`${API}/locations/${locationId}`).expect(200);
  return res.body.data as LocationDetailDTO;
}

/**
 * A tenant with a School Admin and a school. With `seedLocations`, adds the PRD §19 dataset:
 * Mohali MOH (Primary, active), Chandigarh CHD (active), Panchkula PKL (incomplete draft).
 */
export async function setupSchool(options: { seedLocations?: boolean; workspace?: string } = {}) {
  const admin = await signupAdmin(options.workspace ?? 'Greenfield');
  const school = await createSchool(admin.agent);
  const ctx = { ...admin, school, tenantId: admin.session.tenant.tenantId };
  if (!options.seedLocations) return { ...ctx, moh: null, chd: null, pkl: null };

  const moh = await createLocation(admin.agent, school.schoolId, activeLocationBody());
  const chd = await createLocation(
    admin.agent,
    school.schoolId,
    activeLocationBody({
      displayName: 'Chandigarh Campus',
      locationCode: 'CHD',
      locationType: 'BRANCH_CAMPUS',
      email: 'chd@greenfield.edu.in',
      address: { line1: 'Sector 17', city: 'Chandigarh', state: 'Chandigarh', postalCode: '160017' },
    }),
  );
  const pkl = await createLocation(admin.agent, school.schoolId, draftLocationBody());
  return { ...ctx, moh, chd, pkl };
}

/** `setupSchool` with the PRD §19 locations, typed as present. */
export async function seededSchool(workspace?: string) {
  const s = await setupSchool({ seedLocations: true, workspace });
  return { ...s, moh: s.moh!, chd: s.chd!, pkl: s.pkl! };
}

// ───────────────────────────────────────────────────────────── assertions

type ErrorResponse = { status: number; body: { error?: { code: string } } };

export function expectError(res: ErrorResponse, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error?.code).toBe(code);
  return res.body.error as unknown as { code: string; message: string; details: { fields: Record<string, string> } & Record<string, unknown> };
}

export async function auditFor(agent: Agent, entityId: string): Promise<AuditEventDTO[]> {
  const res = await agent.get(`${API}/audit`).query({ entityType: 'school_location', entityId, limit: 100 }).expect(200);
  return res.body.data.items as AuditEventDTO[];
}

// ───────────────────────────────────────────────────────────── academic structure (Module 2)

/**
 * The seeded system data: boards, their `2026-27` rule versions and the class master. Collections are wiped between
 * tests, so call this in `beforeEach` (or at the start of a test). Idempotent.
 */
export async function loadReference() {
  await seedReferenceData();
  const [boards, versions, classes] = await Promise.all([
    EducationBoard.find({ tenantId: null }).lean(),
    BoardRuleVersion.find({ tenantId: null }).lean(),
    ClassMaster.find().lean(),
  ]);
  const classId = Object.fromEntries(classes.map((g) => [g.canonicalCode, g._id])) as Record<string, string>;
  const boardId = Object.fromEntries(boards.map((b) => [b.boardCode, b._id])) as Record<string, string>;
  const ruleVersionId = (code: string) => versions.find((v) => v.boardId === boardId[code])!._id;
  /** A session location entry: this location follows the given built-in board (latest published rule version). */
  const pin = (locationId: string, boardCode = 'CBSE', extra: Record<string, unknown> = {}) => ({
    locationId,
    boardId: boardId[boardCode]!,
    boardRuleVersionId: ruleVersionId(boardCode),
    ...extra,
  });
  return { boardId, ruleVersionId, classId, pin };
}
export type Reference = Awaited<ReturnType<typeof loadReference>>;

/** A seeded school (MOH, CHD active, PKL draft) plus the reference data. */
export async function academicSchool(workspace?: string) {
  const s = await seededSchool(workspace);
  return { ...s, ref: await loadReference() };
}

export function sessionBody(locations: Record<string, unknown>[], overrides: Record<string, unknown> = {}) {
  return { name: 'Academic Year 2026-27', code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', locations, ...overrides };
}

export async function createSession(agent: Agent, locations: Record<string, unknown>[], overrides: Record<string, unknown> = {}): Promise<AcademicSessionDTO> {
  const res = await agent.post(`${API}/academic-sessions`).send(sessionBody(locations, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as AcademicSessionDTO;
}

/** There are no lifecycle endpoints until Part 2, so tests move a session to another status directly. */
export async function forceStatus(tenantId: string, academicSessionId: string, status: SessionStatus) {
  await AcademicSession.updateOne({ _id: academicSessionId, tenantId }, { $set: { status } });
}

const STARTER = [
  { subjectCode: 'ENG', name: 'English', category: 'LANGUAGE', languageCode: 'en' },
  { subjectCode: 'HIN', name: 'Hindi', category: 'LANGUAGE', languageCode: 'hi' },
  { subjectCode: 'MATH', name: 'Mathematics', category: 'MATHEMATICS' },
  { subjectCode: 'SCI', name: 'Science', category: 'SCIENCE', hasPractical: true },
] as const;

/** Creates English, Hindi, Mathematics and Science through the API; returns `{ ENG: subjectId, … }`. */
export async function createStarterSubjects(agent: Agent): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const subject of STARTER) {
    const res = await agent.post(`${API}/subjects`).send(subject).expect(201);
    ids[subject.subjectCode] = res.body.data.subjectId;
  }
  return ids;
}

export async function addClasses(agent: Agent, academicSessionId: string, locationId: string, classIds: string[], extra: Record<string, unknown> = {}) {
  const res = await agent.post(`${API}/academic-sessions/${academicSessionId}/class-offerings`).send({ locationId, classIds, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as { classOfferingId: string; classId: string; displayName: string }[];
}

export async function auditForSession(agent: Agent, academicSessionId: string) {
  const res = await agent.get(`${API}/audit`).query({ academicSessionId, limit: 100 }).expect(200);
  return res.body.data.items as AuditEventDTO[];
}

/** Six more subjects for tests that need language choices or senior-secondary streams. */
export async function createMoreSubjects(agent: Agent): Promise<Record<string, string>> {
  const defs = [
    { subjectCode: 'PUN', name: 'Punjabi', category: 'LANGUAGE', languageCode: 'pa' },
    { subjectCode: 'URD', name: 'Urdu', category: 'LANGUAGE', languageCode: 'ur' },
    { subjectCode: 'PHY', name: 'Physics', category: 'SCIENCE', hasPractical: true },
    { subjectCode: 'CHEM', name: 'Chemistry', category: 'SCIENCE', hasPractical: true },
    { subjectCode: 'BIO', name: 'Biology', category: 'SCIENCE', hasPractical: true },
    { subjectCode: 'CS', name: 'Computer Science', category: 'TECHNOLOGY', hasPractical: true },
  ];
  const ids: Record<string, string> = {};
  for (const def of defs) ids[def.subjectCode] = (await agent.post(`${API}/subjects`).send(def).expect(201)).body.data.subjectId;
  return ids;
}

/** Offers subjects for a class offering and returns `{ subjectCode: subjectOfferingId }`. */
export async function offer(agent: Agent, classOfferingId: string, subjectIds: string[], offeringType = 'MANDATORY'): Promise<Record<string, string>> {
  const res = await agent.post(`${API}/class-offerings/${classOfferingId}/subjects`).send({ subjectIds, offeringType });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return Object.fromEntries((res.body.data as SubjectOfferingDTO[]).map((o) => [o.subjectCode, o.subjectOfferingId]));
}

/** A service context for calling domain services in-process (like a later module would). */
export function serviceContextFor(tenantId: string, userId: string, role: Role = 'SCHOOL_ADMIN'): ServiceContext {
  return { tenantId, userId, role, permissions: permissionsFor(role), requestId: null };
}

/** A school with MOH (CBSE) and CHD (PSEB) in a DRAFT session, plus English, Hindi, Mathematics and Science. */
export async function draftSession() {
  const s = await academicSchool();
  const session = await createSession(s.agent, [s.ref.pin(s.moh.locationId, 'CBSE'), s.ref.pin(s.chd.locationId, 'PSEB')]);
  const subjects = await createStarterSubjects(s.agent);
  const sessionUrl = `${API}/academic-sessions/${session.academicSessionId}`;
  const userId = s.session.user.userId;
  return { ...s, session, subjects, sessionUrl, id: session.academicSessionId, ctx: serviceContextFor(s.tenantId, userId) };
}
export type DraftSession = Awaited<ReturnType<typeof draftSession>>;

/** Adds the smallest plan that passes validation: Class 6 at Mohali with a section, a subject and a session-wide term. */
export async function makePublishable(t: DraftSession) {
  const [schoolClass] = await addClasses(t.agent, t.id, t.moh.locationId, [t.ref.classId.G06!]);
  const section = (await t.agent.post(`${API}/class-offerings/${schoolClass!.classOfferingId}/sections`).send({ codes: ['A'] }).expect(201)).body.data[0];
  const offerings = await offer(t.agent, schoolClass!.classOfferingId, [t.subjects.MATH!, t.subjects.SCI!]);
  const term = (await t.agent.post(`${t.sessionUrl}/terms`).send({ name: 'Term 1', code: 'T1', startDate: '2026-04-01', endDate: '2026-09-30' }).expect(201)).body.data;
  return { classOfferingId: schoolClass!.classOfferingId, sectionId: section.sectionOfferingId as string, offerings, termId: term.termId as string };
}

// ───────────────────────────────────────────────────────────── faculty & staff (Module 3)

/** Today in the default school time zone, the way the services compute it. */
export function today() {
  return todayIn(DEFAULT_TIMEZONE);
}

/**
 * A school (MOH, CHD active, PKL draft) with an ACTIVE session 2026-27: Class VIII at Mohali with sections A, B, C and
 * Mathematics + Science, a department and a designation. Everything the staff tests need to assign classes.
 */
export async function staffSchool(workspace?: string) {
  const s = await academicSchool(workspace);
  const session = await createSession(s.agent, [s.ref.pin(s.moh.locationId), s.ref.pin(s.chd.locationId, 'PSEB')]);
  const subjects = await createStarterSubjects(s.agent);
  const [class8] = await addClasses(s.agent, session.academicSessionId, s.moh.locationId, [s.ref.classId.G08!]);
  const classOfferingId = class8!.classOfferingId;
  const sectionRows = (await s.agent.post(`${API}/class-offerings/${classOfferingId}/sections`).send({ codes: ['A', 'B', 'C'] }).expect(201)).body.data as { sectionCode: string; sectionOfferingId: string }[];
  const sections = Object.fromEntries(sectionRows.map((r) => [r.sectionCode, r.sectionOfferingId])) as Record<'A' | 'B' | 'C', string>;
  const offerings = await offer(s.agent, classOfferingId, [subjects.MATH!, subjects.SCI!]);
  await forceStatus(s.tenantId, session.academicSessionId, 'ACTIVE');

  const dept = (await s.agent.post(`${API}/departments`).send({ code: 'ACAD', name: 'Academics' }).expect(201)).body.data.departmentId as string;
  const desig = (await s.agent.post(`${API}/designations`).send({ code: 'PGT', name: 'PGT' }).expect(201)).body.data.designationId as string;
  return {
    ...s,
    session,
    sessionId: session.academicSessionId,
    classOfferingId,
    sections,
    offerings: offerings as Record<'MATH' | 'SCI', string>,
    dept,
    desig,
    ctx: serviceContextFor(s.tenantId, s.session.user.userId),
  };
}
export type StaffSchool = Awaited<ReturnType<typeof staffSchool>>;

let employeeSeq = 0;
/** A valid create body: a faculty member at Mohali, with a fresh name and code each call. */
export function employeeBody(t: StaffSchool, overrides: Record<string, unknown> = {}) {
  employeeSeq += 1;
  return {
    legalFirstName: `Test${employeeSeq}`,
    legalLastName: 'Person',
    employeeCategory: 'FACULTY',
    employeeCode: `EMP-${String(employeeSeq).padStart(3, '0')}`,
    joiningDate: '2020-04-01',
    primaryLocationId: t.moh.locationId,
    departmentId: t.dept,
    designationId: t.desig,
    ...overrides,
  };
}

export async function addEmployee(t: StaffSchool, overrides: Record<string, unknown> = {}): Promise<EmployeeProfileDTO> {
  const res = await t.agent.post(`${API}/employees`).send(employeeBody(t, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as EmployeeProfileDTO;
}

/** Onboards and activates, so assignments and lifecycle moves can be tested from ACTIVE. */
export async function addActiveEmployee(t: StaffSchool, overrides: Record<string, unknown> = {}): Promise<EmployeeProfileDTO> {
  const employee = await addEmployee(t, overrides);
  await t.agent.post(`${API}/employees/${employee.employeeId}/status`).send({ to: 'ACTIVE' }).expect(200);
  return employee;
}

/** Links a login to a person, the way account provisioning will in Part 2. */
export async function linkUser(tenantId: string, userId: string, personId: string) {
  await User.updateOne({ _id: userId, tenantId }, { $set: { personId } });
}

/** A Faculty or Staff login linked to the given employee. */
export async function loginAs(t: StaffSchool, role: 'FACULTY' | 'STAFF', employee: EmployeeProfileDTO) {
  const login = await createUserAndLogin(t.tenantId, role);
  await linkUser(t.tenantId, login.userId, employee.personId);
  return login;
}

// ───────────────────────────────────────────────────────────── identity, restricted data and documents (Module 3, Part 2)

/** Enough of a PDF for the upload check, which reads the magic bytes. */
export const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

/** The `token` query parameter of a link in the dev outbox. */
export function tokenFromLink(link: string): string {
  return new URL(link).searchParams.get('token')!;
}

/** The newest message for an address, read from the dev outbox the way a person would open it. */
export async function outboxLink(to: string, template: 'ACTIVATION' | 'PASSWORD_RESET'): Promise<string> {
  const res = await request(app).get(`${API}/dev/outbox`).query({ to }).expect(200);
  const message = (res.body.data.items as { template: string; link: string }[]).find((m) => m.template === template);
  expect(message, `no ${template} message for ${to}`).toBeDefined();
  return message!.link;
}

/** Admin creates a login for the employee; returns the PENDING user and the activation token from the outbox. */
export async function provisionLogin(t: StaffSchool, employee: EmployeeProfileDTO, overrides: { email?: string; role?: string } = {}) {
  const email = overrides.email ?? uniqueEmail('person');
  const res = await t.agent.post(`${API}/employees/${employee.employeeId}/user-account`).send({ email, role: overrides.role ?? 'FACULTY' });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return { email, user: res.body.data as { userId: string; status: string }, token: tokenFromLink(await outboxLink(email, 'ACTIVATION')) };
}

/** The whole path a new person takes: admin creates the login, they follow the link, choose a password, sign in. */
export async function activatedLogin(t: StaffSchool, employee: EmployeeProfileDTO, overrides: { email?: string; role?: string } = {}) {
  const { email, user, token } = await provisionLogin(t, employee, overrides);
  await request(app).post(`${API}/auth/activate`).send({ token, password: PASSWORD }).expect(200);
  const agent = request.agent(app);
  await agent.post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200);
  return { agent, email, userId: user.userId };
}

/** Re-enters the password, the way the step-up dialog does. */
export async function stepUp(agent: Agent) {
  const res = await agent.post(`${API}/auth/step-up`).send({ password: PASSWORD });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

export function uploadDocument(agent: Agent, url: string, file: Buffer = PDF, fields: Record<string, string> = {}, filename = 'proof.pdf') {
  const req = agent.post(url).field('documentType', fields.documentType ?? 'ID_PROOF');
  if (fields.displayName) req.field('displayName', fields.displayName);
  return req.attach('file', file, { filename, contentType: 'application/pdf' });
}

/** Synthetic restricted values used across the tests, easy to search for in logs and audit rows. */
export const SECRETS = {
  pan: 'TESTP9999X',
  aadhaar: '000000001234',
  account: '000000005678',
  ifsc: 'TEST0000001',
};

export const restrictedBody = {
  governmentIds: [
    { type: 'PAN', value: SECRETS.pan },
    { type: 'AADHAAR', value: SECRETS.aadhaar },
  ],
  bank: { accountHolderName: 'Test Person', accountNumber: SECRETS.account, ifsc: SECRETS.ifsc, bankName: 'Demo Bank' },
};

/** GET a signed link the way a browser would (no cookies) and return the raw bytes. */
export async function download(url: string) {
  const res = await request(app)
    .get(url)
    .buffer(true)
    .parse((r, cb) => {
      const chunks: Buffer[] = [];
      r.on('data', (c: Buffer) => chunks.push(c));
      r.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  return { status: res.status, headers: res.headers, body: res.body as Buffer, error: res.status >= 400 ? (JSON.parse((res.body as Buffer).toString()) as { error: { code: string } }).error : null };
}

// ───────────────────────────────────────────────────────────── students and parents (Module 4)

/** The staff school (Class VIII at Mohali with sections A, B, C and Mathematics + Science as required subjects, ACTIVE session). */
export const studentSchool = staffSchool;
export type StudentSchool = StaffSchool;

let studentSeq = 0;
/** A valid Quick Add body: a new student in VIII-A with a new mother, fresh names and phone each call. */
export function studentBody(t: StudentSchool, overrides: Record<string, unknown> = {}) {
  studentSeq += 1;
  return {
    legalFirstName: `Kid${studentSeq}`,
    legalLastName: 'Learner',
    locationId: t.moh.locationId,
    classOfferingId: t.classOfferingId,
    sectionId: t.sections.A,
    guardian: { legalFirstName: `Parent${studentSeq}`, legalLastName: 'Learner', phone: nextPhone(), email: `parent${studentSeq}.${Date.now()}@greenfield.demo`, relationshipType: 'Mother' },
    ...overrides,
  };
}

export async function addStudent(t: { agent: Agent } & StudentSchool, overrides: Record<string, unknown> = {}): Promise<CreateStudentResultDTO> {
  const res = await t.agent.post(`${API}/students`).send(studentBody(t, overrides));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data as CreateStudentResultDTO;
}

/** A faculty login linked to a new teacher who has the given academic assignments (items of `POST /employees/:id/academic-assignments`). */
export async function teacherWith(t: StaffSchool, items: Record<string, unknown>[]) {
  const employee = await addActiveEmployee(t);
  await t.agent.post(`${API}/employees/${employee.employeeId}/academic-assignments`).send({ items }).expect(201);
  const login = await loginAs(t, 'FACULTY', employee);
  return { ...login, employee };
}
