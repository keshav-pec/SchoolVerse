import { describe, expect, it } from 'vitest';
import { API, activeLocationBody, createLocation, expectError, listLocations, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 17 — change Primary and verify the atomic switch', () => {
  it('moves Primary from MOH to CHD in one step', async () => {
    const { agent, school, moh, chd } = await seededSchool();
    const res = await agent.post(`${API}/locations/${chd!.locationId}/set-primary`).expect(200);
    expect(res.body.data.isPrimary).toBe(true);
    const all = await listLocations(agent, school.schoolId);
    expect(all.filter((l) => l.isPrimary).map((l) => l.locationCode)).toEqual(['CHD']);
    expect(all.find((l) => l.locationId === moh!.locationId)!.isPrimary).toBe(false);
  });

  it('never ends with two Primaries (or none) when set-primary calls race', async () => {
    const { agent, school, chd } = await seededSchool();
    const third = await createLocation(
      agent,
      school.schoolId,
      activeLocationBody({ displayName: 'Delhi Campus', locationCode: 'DEL', address: { line1: 'Sector 9', city: 'Delhi', state: 'Delhi', postalCode: '110001', country: 'IN' } }),
    );
    const results = await Promise.all([
      agent.post(`${API}/locations/${chd!.locationId}/set-primary`),
      agent.post(`${API}/locations/${third.locationId}/set-primary`),
      agent.post(`${API}/locations/${chd!.locationId}/set-primary`),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    expect((await listLocations(agent, school.schoolId)).filter((l) => l.isPrimary)).toHaveLength(1);
  });

  it('refuses a draft as the new Primary', async () => {
    const { agent, pkl } = await seededSchool();
    expectError(await agent.post(`${API}/locations/${pkl!.locationId}/set-primary`), 409, 'PRIMARY_REQUIRES_ACTIVE');
  });
});
