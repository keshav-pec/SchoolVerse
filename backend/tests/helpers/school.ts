import type request from 'supertest';
import type { LocationDetailDTO, SchoolDTO } from '@shared';
import { expect } from 'vitest';
import { signupAdmin } from './factories';

export const API = '/api/v1';

type Agent = ReturnType<typeof request.agent>;

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

/** A tenant with a School Admin, a school and (optionally) the PRD §19 seed locations. */
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
