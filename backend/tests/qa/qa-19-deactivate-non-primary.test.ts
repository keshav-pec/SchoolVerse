import { describe, expect, it } from 'vitest';
import { API, getLocation, listLocations, seededSchool, useTestDatabase } from './qa';

useTestDatabase();

describe('QA 19 — deactivate a non-primary location', () => {
  it('moves ACTIVE → INACTIVE and leaves Primary alone', async () => {
    const { agent, school, moh, chd } = await seededSchool();
    const res = await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    expect(res.body.data.status).toBe('INACTIVE');
    expect((await getLocation(agent, moh!.locationId)).isPrimary).toBe(true);
    expect((await listLocations(agent, school.schoolId, { status: 'INACTIVE' })).map((l) => l.locationCode)).toEqual(['CHD']);
  });

  it('can be reactivated', async () => {
    const { agent, chd } = await seededSchool();
    await agent.post(`${API}/locations/${chd!.locationId}/deactivate`).expect(200);
    const res = await agent.post(`${API}/locations/${chd!.locationId}/activate`).expect(200);
    expect(res.body.data.status).toBe('ACTIVE');
    expect(res.body.data.isPrimary).toBe(false);
  });
});
