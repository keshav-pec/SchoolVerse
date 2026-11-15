import type { AuditEventDTO, LocationDetailDTO } from '@shared';
import { expect } from 'vitest';
import { setupSchool } from '../helpers/school';

export { API, activeLocationBody, createLocation, draftLocationBody, getLocation, nextPhone, setupSchool, validSchool } from '../helpers/school';
export { createUserAndLogin, signupAdmin } from '../helpers/factories';
export { useTestDatabase } from '../helpers/db';

export type SeededSchool = Awaited<ReturnType<typeof setupSchool>>;
type Agent = SeededSchool['agent'];

/** PRD §19 standard dataset: Mohali MOH (primary, active), Chandigarh CHD (active), Panchkula PKL (draft). */
export const seededSchool = () => setupSchool({ seedLocations: true });

export async function auditFor(agent: Agent, entityId: string): Promise<AuditEventDTO[]> {
  const res = await agent.get('/api/v1/audit').query({ entityType: 'school_location', entityId, limit: 100 }).expect(200);
  return res.body.data.items as AuditEventDTO[];
}

export async function listLocations(agent: Agent, schoolId: string, query: Record<string, string> = {}): Promise<LocationDetailDTO[]> {
  const res = await agent.get(`/api/v1/schools/${schoolId}/locations`).query({ pageSize: '100', ...query }).expect(200);
  return res.body.data.items as LocationDetailDTO[];
}

export function expectError(res: { status: number; body: { error?: { code: string; message: string; details?: unknown } } }, status: number, code: string) {
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  expect(res.body.error?.code).toBe(code);
  return res.body.error!;
}
