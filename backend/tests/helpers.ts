import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import type { AuditEventDTO, LocationDetailDTO, Role, SchoolDTO } from '@shared';
import { afterAll, beforeAll, beforeEach, expect, inject } from 'vitest';
import { createApp } from '../src/app';
import { hashPassword } from '../src/platform/auth/password';
import { User } from '../src/platform/users/user.model';

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
  const res = await agent.post(`${API}/schools`).send({ ...validSchool, ...overrides });
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
