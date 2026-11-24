import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import { DEFAULT_TIMEZONE, permissionsFor, type AcademicSessionDTO, type AccountDTO, type AuditEventDTO, type BankAccountDTO, type BellGenerateResultDTO, type TimetableVersionDTO, type BillingCommitDTO, type BillingRunDTO, type BillingValidationDTO, type CollectionResultDTO, type CreateStudentResultDTO, type EmployeeProfileDTO, type FeeDocumentListDTO, type FeeHeadDTO, type FeePlanDTO, type FinancialYearDTO, type LocationDetailDTO, type PayrollRunDTO, type Role, type RunEmployeeDTO, type RunLineDTO, type SalaryComponentDTO, type SalaryStructureDTO, type SchoolDTO, type SessionStatus, type StatutoryRuleDTO, type SubjectOfferingDTO, type TaxCodeDTO, type TrialBalanceDTO } from '@shared';
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
import { StudentEnrollment } from '../src/modules/students/student.models';
import { StudentFeeAssignment } from '../src/modules/finance/fees/models';
import { fyCodeFor } from '../src/modules/finance/core/context';
import { RestrictedPersonData } from '../src/platform/identity/restricted-data.model';
import { sealBank } from '../src/platform/identity/restricted-data';

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

// ───────────────────────────────────────────────────────────── parent access and lifecycle (Module 4, Part 3)

/** A second EICAR-style antivirus test file: harmless, and every scanner must flag it. */
export const EICAR = Buffer.from('%PDF-1.4\nX5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*\n%%EOF\n');

/** The guardian links of a student, as the admin sees them. */
export async function guardianLinks(agent: Agent, studentId: string) {
  return (await agent.get(`${API}/students/${studentId}/guardians`).expect(200)).body.data as { guardianLinkId: string; guardianPersonId: string; relationshipType: string; isPrimary: boolean }[];
}

/** Admin enables portal access for a student's first guardian and returns the link, the parent's email and the activation token (when a new login was made). */
export async function inviteParent(t: { agent: Agent }, studentId: string, email: string) {
  const links = await guardianLinks(t.agent, studentId);
  const linkId = links[0]!.guardianLinkId;
  const res = await t.agent.post(`${API}/guardian-links/${linkId}/enable-portal`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return { linkId, access: res.body.data as { portalState: string; reusedAccount: boolean; invitationSent: boolean }, email };
}

/** The whole path a parent takes: invited, follows the link in the dev outbox, chooses a password, signs in. */
export async function activatedParent(t: { agent: Agent }, studentId: string, email: string) {
  const { linkId, access } = await inviteParent(t, studentId, email);
  const token = tokenFromLink(await outboxLink(email, 'ACTIVATION'));
  await request(app).post(`${API}/auth/activate`).send({ token, password: PASSWORD }).expect(200);
  const agent = request.agent(app);
  await agent.post(`${API}/auth/login`).send({ email, password: PASSWORD }).expect(200);
  return { agent, linkId, access, email, token };
}

/**
 * The staff school plus Class IX (sections A and B, Maths and Science) in the active session, then 2027-28 cloned from it and
 * published. Class X is added to 2026-27 after the clone, so it is not offered next year: Class VIII students have a next class,
 * Class IX students have none, and Class X is the last class.
 */
export async function promotionSchool() {
  const t = await staffSchool();
  const subjects = Object.fromEntries((await t.agent.get(`${API}/subjects?pageSize=100`).expect(200)).body.data.items.map((s: { subjectCode: string; subjectId: string }) => [s.subjectCode, s.subjectId])) as Record<string, string>;
  const classWithSections = async (classId: string) => {
    const [offering] = await addClasses(t.agent, t.sessionId, t.moh.locationId, [classId]);
    const rows = (await t.agent.post(`${API}/class-offerings/${offering!.classOfferingId}/sections`).send({ codes: ['A', 'B'] }).expect(201)).body.data as { sectionCode: string; sectionOfferingId: string }[];
    await offer(t.agent, offering!.classOfferingId, [subjects.MATH!, subjects.SCI!]);
    return { classOfferingId: offering!.classOfferingId, sections: Object.fromEntries(rows.map((r) => [r.sectionCode, r.sectionOfferingId])) as Record<'A' | 'B', string> };
  };
  const nine = await classWithSections(t.ref.classId.G09!);
  const next = (await t.agent.post(`${API}/academic-sessions/${t.sessionId}/clone`).send({ name: 'Academic Year 2027-28', code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31' }).expect(201)).body.data as AcademicSessionDTO;
  await forceStatus(t.tenantId, next.academicSessionId, 'PUBLISHED');
  const ten = await classWithSections(t.ref.classId.G10!);
  return { ...t, nextSessionId: next.academicSessionId, nine, ten };
}
export type PromotionSchool = Awaited<ReturnType<typeof promotionSchool>>;

// ───────────────────────────────────────────────────────────── finance (Module 7): calls under /finance, and a school ready for money

export const post = (t: { agent: Agent }, path: string, body: unknown = {}) => t.agent.post(`${API}/finance${path}`).send(body as object);
export const patch = (t: { agent: Agent }, path: string, body: unknown = {}) => t.agent.patch(`${API}/finance${path}`).send(body as object);
export const put = (t: { agent: Agent }, path: string, body: unknown = {}) => t.agent.put(`${API}/finance${path}`).send(body as object);
export const getOk = async <T>(t: { agent: Agent }, path: string) => {
  const res = await t.agent.get(`${API}/finance${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as T;
};
export const created = async <T>(res: { status: number; body: { data: T } }) => {
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.data;
};
export const ok = async <T>(res: { status: number; body: { data: T } }) => {
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
export const money = (rupees: number) => rupees * 100;
export const withKey = (agent: Agent, path: string, key: string, body: unknown) => agent.post(`${API}/finance${path}`).set('Idempotency-Key', key).send(body as object);

/** A seeded school with finance set up: standard chart and tax codes, FY 2026-27 (and the year of today), a fees bank account and a cash account. */
export async function financeBase() {
  const t = await staffSchool();
  await post(t, '/setup/standard').expect(200);
  const fy = await created<FinancialYearDTO>(await post(t, '/financial-years', { code: '2026-27' }));
  const nowCode = fyCodeFor(today(), 4);
  if (nowCode !== '2026-27') await post(t, '/financial-years', { code: nowCode }).expect(201);
  const accounts = Object.fromEntries((await getOk<AccountDTO[]>(t, '/chart-of-accounts')).map((a) => [a.code, a]));
  const taxCodes = Object.fromEntries((await getOk<TaxCodeDTO[]>(t, '/tax-codes')).map((c) => [c.code, c]));
  return { ...t, fy, accounts, taxCodes };
}

/** A Staff login (a real employee at Mohali) holding the given finance bundles. */
export async function staffWith(t: Awaited<ReturnType<typeof staffSchool>>, bundles: string[], employeeOver: Record<string, unknown> = {}) {
  const login = await loginAs(t, 'STAFF', await addActiveEmployee(t, employeeOver));
  if (bundles.length) await put(t, `/access/users/${login.userId}`, { bundles }).expect(200);
  return login;
}

const heads = async (t: Awaited<ReturnType<typeof financeBase>>) => {
  const { accounts: a, taxCodes: x } = t;
  const head = async (body: Record<string, unknown>) => created<FeeHeadDTO>(await post(t, '/fee-heads', body));
  return {
    tuition: await head({ code: 'TUITION', name: 'Tuition Fee', category: 'TUITION', incomeAccountId: a['4100']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId, isRecurring: true }),
    annual: await head({ code: 'ANNUAL', name: 'Annual Charges', category: 'ANNUAL', incomeAccountId: a['4300']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId }),
    deposit: await head({ code: 'DEPOSIT', name: 'Security Deposit', category: 'DEPOSIT', incomeAccountId: a['2200']!.accountId, isRefundableDeposit: true }),
    uniform: await head({ code: 'UNIFORM', name: 'Uniform', incomeAccountId: a['4600']!.accountId, taxCodeId: x.GST_12!.taxCodeId, isOptional: true }),
    lateFee: await head({ code: 'LATEFEE', name: 'Late Fee', category: 'LATE_FEE', incomeAccountId: a['4700']!.accountId, taxCodeId: x.EXEMPT_EDU!.taxCodeId }),
  };
};

/**
 * Finance ready for money to move: a published Class VIII plan (Tuition ₹4,000 monthly, Annual ₹8,000 yearly, a ₹5,000 refundable deposit),
 * a fees bank account, a cash account, and staff logins: a cashier, a second cashier, an accountant and an approver.
 */
export async function moneySchool() {
  const t = await financeBase();
  const h = await heads(t);
  const item = (head: FeeHeadDTO, rupees: number, frequency: string, extra: Record<string, unknown> = {}) => ({ feeHeadId: head.feeHeadId, amountPaise: money(rupees), frequency, dueDay: 10, ...extra });
  const planBody = {
    name: 'Class VIII 2026-27', sessionId: t.sessionId, appliesTo: { locationIds: [t.moh.locationId], classIds: [t.ref.classId.G08!], studentType: 'ALL' }, autoAssign: true,
    items: [item(h.tuition, 4000, 'MONTHLY', { prorationMethod: 'CALENDAR_DAYS' }), item(h.annual, 8000, 'YEARLY'), item(h.deposit, 5000, 'ONE_TIME')],
  };
  const plan = await created<FeePlanDTO>(await post(t, '/fee-plans', planBody));
  const published = (await ok(await post(t, `/fee-plan-versions/${plan.latestVersion!.versionId}/publish`))) as FeePlanDTO;
  const bank = await created<BankAccountDTO>(await post(t, '/bank-accounts', { label: 'Fees account', bankName: 'State Bank', holderName: 'Greenfield Trust', accountNumber: '123456781234', ifsc: 'SBIN0001234', purpose: 'FEES' }));
  const cash = await created<{ cashAccountId: string }>(await post(t, '/cash-accounts', { label: 'Front office cash' }));
  const cashier = await staffWith(t, ['COLLECTOR']);
  const cashier2 = await staffWith(t, ['COLLECTOR']);
  const accountant = await staffWith(t, ['ACCOUNTANT']);
  const approver = await staffWith(t, ['APPROVER']);
  return { ...t, heads: h, plan: published, planVersionId: published.publishedVersion!.versionId, bank, cash, cashier, cashier2, accountant, approver };
}
export type MoneySchool = Awaited<ReturnType<typeof moneySchool>>;

/** A new Class VIII student whose enrollment and fee plan start on `from`. */
export async function enrolled(t: MoneySchool, from = '2026-04-01', over: Record<string, unknown> = {}) {
  const made = await addStudent(t, over);
  const studentId = made.student.studentId;
  await StudentEnrollment.updateOne({ tenantId: t.tenantId, studentId }, { $set: { effectiveFrom: from } });
  await StudentFeeAssignment.updateOne({ tenantId: t.tenantId, studentId }, { $set: { effectiveFrom: from } });
  return { ...made, studentId };
}

/** Check then issue a billing run, the way the screen does. */
export async function issueMonth(t: MoneySchool, periodKey = '2026-11', issueDate = '2026-11-05') {
  const run = await created<BillingRunDTO>(await post(t, '/billing-runs', { sessionId: t.sessionId, locationId: t.moh.locationId, periodKey, issueDate }));
  const checked = (await ok(await post(t, `/billing-runs/${run.runId}/validate`))) as BillingValidationDTO;
  const res = await t.agent.post(`${API}/finance/billing-runs/${run.runId}/commit`).set('Idempotency-Key', `key-${periodKey}`).send({ confirmedReadyCount: checked.run.counts.ready, confirmedTotalPaise: checked.run.totalPaise });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data as BillingCommitDTO;
}

export const billsOf = async (t: MoneySchool, studentId: string) => (await getOk<FeeDocumentListDTO>(t, `/fee-documents?studentId=${studentId}&kind=BILL&pageSize=50`)).items;
export const billOf = async (t: MoneySchool, studentId: string, periodKey = '2026-11') => (await billsOf(t, studentId)).find((b) => b.periodKey === periodKey)!;

let keyCounter = 0;
/** A fresh idempotency key. */
export const key = (prefix = 'k') => `${prefix}-${Date.now()}-${(keyCounter += 1)}`;

/** Take a payment at the counter (by `agent`, the first cashier by default) with a fresh idempotency key. */
export const collect = async (t: MoneySchool, body: Record<string, unknown>, agent = t.cashier) => ok<CollectionResultDTO>(await withKey(agent.agent, '/collections', key(), body).then((r) => ({ status: r.status === 201 ? 200 : r.status, body: r.body })));

export const openShift = async (login: { agent: Agent }, openingFloatPaise = 0) => created<{ shiftId: string }>(await login.agent.post(`${API}/finance/cashier-shifts/open`).send({ openingFloatPaise }));

// ───────────────────────────────────────────────────────────── payroll (Module 7): calls under /payroll, and a school ready to pay salaries

export const pay = (t: { agent: { post: (u: string) => { send: (b: object) => Promise<{ status: number; body: { data: never; error?: { code: string; details?: Record<string, unknown> } } }> } } }, path: string, body: unknown = {}) => t.agent.post(`${API}/payroll${path}`).send(body as object);
export const payGet = async <T>(t: { agent: { get: (u: string) => Promise<{ status: number; body: { data: T } }> } }, path: string) => {
  const res = await t.agent.get(`${API}/payroll${path}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.data;
};
export const payPut = (t: { agent: { put: (u: string) => { send: (b: object) => Promise<{ status: number; body: { data: never } }> } } }, path: string, body: unknown = {}) => t.agent.put(`${API}/payroll${path}`).send(body as object);
export const payOk = async <T>(res: { status: number; body: { data: T } }, status = 200) => {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.data;
};
/** The trial balance, optionally as of a date. */
export const trial = (t: MoneySchool, asOf?: string) => getOk<TrialBalanceDTO>(t, `/trial-balance${asOf ? `?asOf=${asOf}` : ''}`);

export const MONTH = '2026-11';

/** Payroll ready: three approved statutory rules, a structure (Basic + 40% HRA), a payroll officer, a second officer, two approvers. */
export async function payrollSchool(options: { approveRules?: boolean } = {}) {
  const t = await moneySchool();
  const officer = await staffWith(t, ['PAYROLL_OFFICER']);
  const officer2 = await staffWith(t, ['PAYROLL_OFFICER']);
  const approver2 = await staffWith(t, ['APPROVER']);
  const components = await payGet<SalaryComponentDTO[]>(t, '/components');
  const basic = components.find((c) => c.code === 'BASIC')!;
  const hra = components.find((c) => c.code === 'HRA')!;
  const structure = await payOk<SalaryStructureDTO>(await pay(officer, '/salary-structures', { name: 'Senior Faculty A', effectiveFrom: '2026-04-01', items: [{ componentId: basic.componentId }, { componentId: hra.componentId, rateBps: 4000 }] }), 201);
  await payOk(await pay(t.approver, `/salary-structure-versions/${structure.latestVersion!.versionId}/approve`));
  if (options.approveRules !== false) for (const r of await payGet<StatutoryRuleDTO[]>(t, '/statutory-rules')) await payOk(await pay(t.approver, `/statutory-rules/${r.ruleId}/approve`));
  return { ...t, officer, officer2, approver2, basic, hra, structureVersionId: structure.latestVersion!.versionId };
}
export type PaySchool = Awaited<ReturnType<typeof payrollSchool>>;

/** An active employee with a salary (basic in rupees), bank details and, optionally, a tax declaration and November days. */
export async function worker(t: PaySchool, basicRupees: number, over: { days?: { lop?: number; working?: number | null }; tdsYearlyRupees?: number; noBank?: boolean; joining?: string; mode?: string } = {}) {
  const employee = await addActiveEmployee(t, { joiningDate: over.joining ?? '2020-04-01' });
  if (!over.noBank) await RestrictedPersonData.create({ tenantId: t.tenantId, personId: employee.personId, governmentIds: [], bank: sealBank(employee.personId, { accountHolderName: employee.fullName, accountNumber: `9900${employee.employeeCode.replace(/\D/g, '').padStart(8, '0')}`, ifsc: 'SBIN0001234', bankName: 'State Bank' }) });
  await payOk(await pay(t.officer, '/employee-assignments', { employeeId: employee.employeeId, structureVersionId: t.structureVersionId, mode: over.mode ?? 'MONTHLY', basicPaise: money(basicRupees), effectiveFrom: '2026-04-01' }), 201);
  if (over.tdsYearlyRupees) await payOk(await payPut(t.officer, `/employees/${employee.employeeId}/tax-declaration`, { regime: 'NEW', estimatedYearlyTaxPaise: money(over.tdsYearlyRupees), alreadyDeductedPaise: 0 }));
  if (over.days) await payOk(await payPut(t.officer, '/inputs', { employeeId: employee.employeeId, month: MONTH, workingDays: over.days.working ?? null, paidLeaveDays: 0, lopDays: over.days.lop ?? 0, unitsWorked: null, extras: [] }));
  return employee;
}

export const newRun = async (t: PaySchool, employeeIds: string[], month = MONTH) => payOk<PayrollRunDTO>(await pay(t.officer, '/runs', { month, employeeIds }), 201);
export const calc = async (t: PaySchool, runId: string) => payOk<PayrollRunDTO>(await pay(t.officer, `/runs/${runId}/calculate`));
export const rows = async (t: PaySchool, runId: string) => (await payGet<{ items: RunEmployeeDTO[] }>(t, `/runs/${runId}/employees?pageSize=100`)).items;
export const linesOf = (t: PaySchool, runId: string, employeeId: string) => payGet<RunLineDTO[]>(t, `/runs/${runId}/employees/${employeeId}/lines`);
/** Calculate, approve (a different person) and finalise. */
export async function finalise(t: PaySchool, runId: string) {
  await calc(t, runId);
  const a = await payOk<PayrollRunDTO>(await pay(t.approver, `/runs/${runId}/approve`));
  expect(a.state).toBe('APPROVED');
  return payOk<PayrollRunDTO>(await pay(t.approver2, `/runs/${runId}/finalize`, { version: a.version }));
}
export const lineAmount = (lines: RunLineDTO[], key: string) => lines.find((l) => l.componentKey === key)?.amountPaise;

// ───────────────────────────────────────────────────────────── timetable (Module 6)

/**
 * The staff school (Class VIII at Mohali, sections A B C, Maths + Science, ACTIVE session) with a timetable plan for Mohali.
 * `post`, `put` and `patch` send as the School Admin and return the raw response; `ok` unwraps a 2xx body.
 */
export async function timetableSchool(options: { operatingDays?: string[] } = {}) {
  const t = await staffSchool();
  const send = (method: 'post' | 'put' | 'patch' | 'delete') => (path: string, body: unknown = {}, agent: Agent = t.agent) => agent[method](`${API}${path}`).send(body as object);
  const tt = { post: send('post'), put: send('put'), patch: send('patch'), del: send('delete') };
  const unwrap = <T>(res: { status: number; body: { data: T } }, status = 200): T => {
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    return res.body.data;
  };
  const planRes = await tt.post('/timetable-plans', { locationId: t.moh.locationId, academicSessionId: t.sessionId, ...(options.operatingDays ? { operatingDays: options.operatingDays } : {}) });
  const plan = unwrap<import('@shared').TimetablePlanDTO>(planRes, 201);
  const planId = plan.planId;
  /** 08:00-14:05 with 45-minute periods, a break and lunch: seven lessons a day and 5 minutes over. */
  const regular = { name: 'Regular', kind: 'REGULAR', start: '08:00', end: '14:05', periodMinutes: 45, breaks: [{ name: 'Short Break', start: '10:15', end: '10:30', type: 'BREAK' }, { name: 'Lunch', start: '12:00', end: '12:30', type: 'LUNCH' }] };
  const getData = async <T>(path: string, status = 200): Promise<T> => unwrap<T>(await t.agent.get(`${API}${path}`), status);
  return { ...t, tt, unwrap, plan, planId, regular, getData };
}
export type TimetableSchool = Awaited<ReturnType<typeof timetableSchool>>;

// ───────────────────────────────────────────────────────────── timetable lessons and the clash checker (Module 6, Part 3)

/**
 * `timetableSchool()` made ready to schedule: Regular Daily Periods (seven lessons a day, Monday to Saturday), Maths 6 and Science 5 a
 * week for Class VIII, one Maths teacher and one Science teacher for sections A, B and C, a Home Classroom for each section (Room 101 to
 * 103, 40 seats), a Chemistry Lab (30 seats) and a small Counselling Room (10 seats) when asked, and an open Draft. `lesson` and `put`
 * build and send a lesson as the School Admin.
 */
export async function scheduleSchool(options: { lab?: boolean; needsLab?: boolean; draft?: boolean; operatingDays?: string[] } = {}) {
  const t = await timetableSchool({ operatingDays: options.operatingDays });
  const bell = t.unwrap<BellGenerateResultDTO>(await t.tt.post(`/timetable-plans/${t.planId}/bell-schedules/generate`, t.regular), 201).schedule;
  const needs = [
    { subjectOfferingId: t.offerings.MATH, periodsPerWeek: 6 },
    { subjectOfferingId: t.offerings.SCI, periodsPerWeek: 5, ...(options.needsLab ? { neededSuitability: ['CHEMISTRY_PRACTICAL'] } : {}) },
  ];
  t.unwrap(await t.tt.post('/subject-schedule-requirements/apply-grade', { planId: t.planId, classOfferingId: t.classOfferingId, items: needs }));

  const maths = await addActiveEmployee(t);
  const sci = await addActiveEmployee(t);
  for (const [teacher, subject] of [[maths, t.offerings.MATH], [sci, t.offerings.SCI]] as const) {
    await t.agent.post(`${API}/employees/${teacher.employeeId}/academic-assignments`).send({ items: (['A', 'B', 'C'] as const).map((c) => ({ assignmentType: 'SUBJECT_FACULTY', sectionId: t.sections[c], subjectOfferingId: subject })) }).expect(201);
  }

  const post = async <T>(path: string, body: unknown) => t.unwrap<T>(await t.tt.post(path, body), 201);
  const building = await post<{ buildingId: string }>(`/locations/${t.moh.locationId}/buildings`, { buildingName: 'Main Block', buildingCode: 'MAB' });
  const floors = await post<{ floors: { floorId: string }[] }>(`/buildings/${building.buildingId}/floors/bulk`, { floors: [{ name: 'Ground' }] });
  const types = Object.fromEntries((await t.getData<{ code: string; spaceTypeId: string }[]>('/space-types')).map((x) => [x.code, x.spaceTypeId]));
  const room = (name: string, type: string, capacity: number) =>
    post<{ spaceId: string }>('/physical-spaces', { locationId: t.moh.locationId, buildingId: building.buildingId, floorId: floors.floors[0]!.floorId, spaceTypeId: types[type], spaceName: name, roomNumber: name.replace(/\D/g, '') || undefined, academicCapacity: capacity, physicalCapacity: capacity + 2 });
  const home = {} as Record<'A' | 'B' | 'C', string>;
  for (const code of ['A', 'B', 'C'] as const) {
    const r = await room(`Room 10${code.charCodeAt(0) - 64}`, 'STANDARD_CLASSROOM', 40);
    home[code] = r.spaceId;
    t.unwrap(await t.tt.post('/section-space-assignments', { sectionOfferingId: t.sections[code], physicalSpaceId: r.spaceId }), 201);
  }
  const spare = (await room('Room 104', 'STANDARD_CLASSROOM', 40)).spaceId;
  const small = (await room('Counselling Room 1', 'STANDARD_CLASSROOM', 10)).spaceId;
  const lab = options.lab || options.needsLab ? (await room('Chemistry Lab 1', 'CHEMISTRY_LAB', 30)).spaceId : null;

  const draft = options.draft === false ? null : t.unwrap<TimetableVersionDTO>(await t.tt.post(`/timetable-plans/${t.planId}/versions`, {}), 201);
  /** The seven lesson periods of a day, in order: `p[1]` is the first. */
  const p = ['', ...bell.periods.filter((x) => x.schedulable).map((x) => x.periodId)];
  const breakId = bell.periods.find((x) => !x.schedulable)!.periodId;
  const versionId = draft?.versionId ?? '';
  const lesson = (section: 'A' | 'B' | 'C', subject: 'MATH' | 'SCI', weekday: string, period: number, extra: Record<string, unknown> = {}) => ({ weekday, periodId: p[period]!, sectionOfferingIds: [t.sections[section]], subjectOfferingId: t.offerings[subject], ...extra });
  const put = (body: Record<string, unknown>, agent: Agent = t.agent, id = versionId) => agent.post(`${API}/timetable-versions/${id}/entries`).send(body);
  const send = (method: 'post' | 'patch' | 'delete' | 'get', path: string, body: unknown = {}, agent: Agent = t.agent) => (method === 'get' ? agent.get(`${API}${path}`) : agent[method](`${API}${path}`).send(body as object));
  return { ...t, bell, maths, sci, rooms: { ...home, spare, small, lab }, versionId, draft, p, breakId, lesson, put, send };
}
export type ScheduleSchool = Awaited<ReturnType<typeof scheduleSchool>>;
